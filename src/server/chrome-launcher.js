// Purpose: Finds, spawns, reuses and supervises the TV Chrome, and moves its window between displays.
// Depends on: node:child_process, node:fs, global fetch (for /json/version),
//   src/server/cdp-client.js (window moves use the controller's client; shutdown opens its own).
// Used by: src/server/main.js
// Notes:
// - Emits "ready" with the browser WebSocket URL whenever a Chrome with the debugging port is up
//   (spawned or reused). Exit of the spawned Chrome, or a lost CDP connection reported through
//   `chromeLost()`, schedules a relaunch with a growing delay so a Chrome that cannot start (for
//   example a locked profile) does not spin.
// - A Chrome already answering on the debugging port is reused, so restarting the server does not
//   restart playback. On shutdown the launcher closes the Chrome it spawned, and also a reused
//   one that runs with the Clamshell profile (left over from a crashed server run). A Chrome on
//   the port with any other profile is never closed.
// - Chrome is spawned detached (its own process group) so a Ctrl+C in the terminal does not kill
//   it before the shutdown sequence decides what to do.
// - Window moves go normal, then bounds, then fullscreen: macOS ignores bounds changes on a
//   fullscreen window.

import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { CdpClient } from './cdp-client.js';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
];

const WINDOWED_SIZE = { width: 1280, height: 720 };
const WINDOWED_OFFSET = { x: 80, y: 60 };
const HEADLESS_SIZE = '1920,1080';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome() {
  const override = process.env.TV_STREAM_CHROME_PATH;
  if (override) return existsSync(override) ? override : null;
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

// GET /json/version; resolves to the parsed body or null when nothing answers.
export async function fetchVersion(cdpPort, timeoutMs = 1_000) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.webSocketDebuggerUrl ? body : null;
  } catch {
    return null;
  }
}

// True when a running process carries both our profile and our debugging port.
function isOurChromeRunning(profileDir, cdpPort) {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-Ao', 'command'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.split('\n').some((line) =>
        line.includes(`--user-data-dir=${profileDir}`) && line.includes(`--remote-debugging-port=${cdpPort}`)));
    });
  });
}

export function windowBoundsFor(display, { windowed }) {
  if (windowed) {
    return {
      left: Math.round(display.x + WINDOWED_OFFSET.x),
      top: Math.round(display.y + WINDOWED_OFFSET.y),
      width: Math.min(WINDOWED_SIZE.width, Math.round(display.width)),
      height: Math.min(WINDOWED_SIZE.height, Math.round(display.height)),
    };
  }
  return {
    left: Math.round(display.x),
    top: Math.round(display.y),
    width: Math.round(display.width),
    height: Math.round(display.height),
  };
}

function isOnDisplay(bounds, display) {
  const cx = bounds.left + bounds.width / 2;
  const cy = bounds.top + bounds.height / 2;
  return cx >= display.x && cx < display.x + display.width && cy >= display.y && cy < display.y + display.height;
}

// Moves the window of `targetId` onto `display`. Kiosk windows end up fullscreen there; windowed
// ones get the 1280x720 dev window. Resolves to true when the window was moved.
export async function placeWindow(cdp, targetId, display, { windowed, force = false }) {
  const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId });
  const placed = isOnDisplay(bounds, display) && (windowed || bounds.windowState === 'fullscreen');
  if (placed && !force) return false;
  if (bounds.windowState && bounds.windowState !== 'normal') {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await sleep(700);
  }
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: windowBoundsFor(display, { windowed }) });
  if (!windowed) {
    await sleep(300);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  }
  return true;
}

export class ChromeLauncher extends EventEmitter {
  #opts;
  #child = null;
  #stopping = false;
  #busy = false;
  #retryTimer = null;
  #failures = 0;
  #adopted = false;

  // opts: { chromePath, cdpPort, profileDir, startUrl, windowed, headless, getDisplay, log }
  constructor(opts) {
    super();
    this.#opts = opts;
  }

  get spawnedPid() {
    return this.#child?.pid ?? null;
  }

  start() {
    this.#ensure();
  }

  // Called when the CDP connection dropped; checks the port and relaunches if Chrome is gone.
  chromeLost() {
    this.#schedule(1_500);
  }

  #schedule(delayMs) {
    if (this.#stopping || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#ensure();
    }, delayMs);
  }

  #retryDelay() {
    return Math.min(30_000, 2_000 * 2 ** Math.min(this.#failures, 4));
  }

  async #ensure() {
    if (this.#stopping || this.#busy) return;
    this.#busy = true;
    const { cdpPort, profileDir, log } = this.#opts;
    try {
      let version = await fetchVersion(cdpPort);
      if (version) {
        if (!this.#child) {
          const ours = await isOurChromeRunning(profileDir, cdpPort);
          this.#adopted = ours;
          log(ours
            ? `[tv-stream] reusing running Chrome on port ${cdpPort}`
            : `[tv-stream] port ${cdpPort} answers but not with the Clamshell profile; using it anyway`);
        }
      } else {
        this.#spawn();
        version = await this.#waitForVersion(20_000);
      }
      if (this.#stopping) return;
      if (version) {
        this.#failures = 0;
        this.emit('ready', version.webSocketDebuggerUrl);
      } else {
        this.#failures++;
        log(`[tv-stream] Chrome did not open the debugging port; retrying in ${this.#retryDelay() / 1000} s`);
        this.#schedule(this.#retryDelay());
      }
    } catch (err) {
      this.#failures++;
      log(`[tv-stream] Chrome launch failed: ${err.message}`);
      this.#schedule(this.#retryDelay());
    } finally {
      this.#busy = false;
    }
  }

  async #waitForVersion(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.#stopping) {
      const version = await fetchVersion(this.#opts.cdpPort, 500);
      if (version) return version;
      if (!this.#child) return null;
      await sleep(250);
    }
    return null;
  }

  async #closeAdopted() {
    const version = await fetchVersion(this.#opts.cdpPort);
    if (!version) return;
    let cdp;
    try {
      cdp = await CdpClient.connect(version.webSocketDebuggerUrl);
      await cdp.send('Browser.close', {}, undefined, { timeoutMs: 3_000 });
    } catch {
      // Chrome closes the socket while handling Browser.close.
    } finally {
      cdp?.close();
    }
  }

  #buildArgs() {
    const { cdpPort, profileDir, startUrl, windowed, headless, getDisplay } = this.#opts;
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--hide-crash-restore-bubble',
      '--noerrdialogs',
      // No "Translate this page?" bubble when a site's language differs from Chrome's UI language.
      '--disable-features=Translate',
    ];
    if (headless) {
      args.push('--headless=new', `--window-size=${HEADLESS_SIZE}`, '--mute-audio');
    } else {
      const display = getDisplay?.();
      if (display) {
        const bounds = windowBoundsFor(display, { windowed });
        args.push(`--window-position=${bounds.left},${bounds.top}`, `--window-size=${bounds.width},${bounds.height}`);
      } else if (windowed) {
        args.push(`--window-size=${WINDOWED_SIZE.width},${WINDOWED_SIZE.height}`);
      }
      if (!windowed) args.push('--kiosk');
    }
    args.push(startUrl);
    return args;
  }

  #spawn() {
    const { chromePath, profileDir, log } = this.#opts;
    mkdirSync(profileDir, { recursive: true });
    const child = spawn(chromePath, this.#buildArgs(), { detached: true, stdio: 'ignore' });
    this.#child = child;
    log(`[tv-stream] Chrome started (pid ${child.pid})`);
    child.on('error', (err) => log(`[tv-stream] Chrome spawn error: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.#child === child) this.#child = null;
      this.#adopted = false;
      if (this.#stopping) return;
      log(`[tv-stream] Chrome exited (${signal ?? `code ${code}`}); relaunching`);
      this.emit('exit');
      this.#schedule(this.#retryDelay());
    });
  }

  // Stops supervision and closes the TV Chrome (spawned or adopted).
  async stop() {
    this.#stopping = true;
    clearTimeout(this.#retryTimer);
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      if (this.#adopted) await this.#closeAdopted();
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = sleep(4_000).then(() => 'timeout');
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(1_000)]);
    }
  }
}
