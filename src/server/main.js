// Purpose: Entry point: reads config, starts http + ws, launches and supervises Chrome, keeps the Mac awake, shuts down cleanly.
// Depends on: src/server/http-server.js, src/server/remote-socket.js, src/server/tv-controller.js,
//   src/server/chrome-launcher.js, src/server/display-detector.js, /usr/bin/caffeinate.
// Used by: package.json ("npm start", "npm run dev")
// Notes:
// - Environment: TV_STREAM_PORT (8787), TV_STREAM_CDP_PORT (9222), TV_STREAM_PROFILE_DIR
//   (Chrome profile), TV_STREAM_WINDOWED=1 (1280x720 window, no kiosk), TV_STREAM_HEADLESS=1
//   (no window at all, for automated tests), TV_STREAM_CHROME_PATH (Chrome binary),
//   TV_STREAM_OVERLAY_PATH (overlay script, for testing the key-event fallbacks),
//   TV_STREAM_AUDIO_TOOL (sound output helper, default build/tv-audio).
// - Window placement runs on the 5 s display poll: always in kiosk mode (the window must sit
//   fullscreen on the target display), in windowed mode only after a display change or a Chrome
//   (re)attach so a dev window the user moved stays where it is. Headless mode never places.
// - caffeinate -w <pid> also exits on its own if this process dies without cleanup.
// - The Mac's own mouse pointer is hidden on every TV page except in windowed mode, where the
//   dev window is used with the real mouse.
// - A data folder left under the app's former name "TV Stream" is moved to "Clamshell" before
//   Chrome starts, so the TV keeps its streaming logins. Skipped when TV_STREAM_PROFILE_DIR is set.

import { spawn } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from './http-server.js';
import { attachRemoteSocket } from './remote-socket.js';
import { createAudioOutputs } from './audio-outputs.js';
import { TvController } from './tv-controller.js';
import { ChromeLauncher, findChrome, placeWindow } from './chrome-launcher.js';
import { listDisplays, pickTargetDisplay, displayKind, watchDisplays } from './display-detector.js';

const log = (line) => console.log(line);

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const flag = (name) => ['1', 'true', 'yes'].includes(String(process.env[name] ?? '').toLowerCase());

const dataDir = path.join(os.homedir(), 'Library/Application Support/Clamshell');
const formerDataDir = path.join(os.homedir(), 'Library/Application Support/TV Stream');
if (!process.env.TV_STREAM_PROFILE_DIR && !existsSync(dataDir) && existsSync(formerDataDir)) {
  try {
    renameSync(formerDataDir, dataDir);
    log(`[tv-stream] moved ${formerDataDir} to ${dataDir}`);
  } catch (err) {
    log(`[tv-stream] moving ${formerDataDir} failed: ${err.message}`);
  }
}

const config = {
  port: Number(process.env.TV_STREAM_PORT) || 8787,
  cdpPort: Number(process.env.TV_STREAM_CDP_PORT) || 9222,
  profileDir: path.resolve(process.env.TV_STREAM_PROFILE_DIR
    || path.join(dataDir, 'chrome-profile')),
  windowed: flag('TV_STREAM_WINDOWED'),
  headless: flag('TV_STREAM_HEADLESS'),
  publicDir: path.join(appRoot, 'public'),
  overlayPath: path.resolve(process.env.TV_STREAM_OVERLAY_PATH || path.join(appRoot, 'src/inject/tv-overlay.js')),
  audioToolPath: path.resolve(process.env.TV_STREAM_AUDIO_TOOL || path.join(appRoot, 'build/tv-audio')),
};
config.launcherUrl = `http://localhost:${config.port}/tv/`;

process.on('unhandledRejection', (reason) => {
  log(`[tv-stream] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// ---------------------------------------------------------------- keep awake

const caffeinate = spawn('/usr/bin/caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore' });
caffeinate.on('error', (err) => log(`[tv-stream] caffeinate failed: ${err.message}`));

// ---------------------------------------------------------------- http + ws

const controller = new TvController({
  launcherUrl: config.launcherUrl,
  overlayPath: config.overlayPath,
  hideSystemCursor: !config.windowed,
  log,
});
const server = createHttpServer({ publicDir: config.publicDir, port: config.port, controller, log });
const audio = createAudioOutputs({ toolPath: config.audioToolPath, log });
const remoteSocket = attachRemoteSocket({ server, controller, audio, log });

server.on('error', (err) => {
  log(`[tv-stream] http server error: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    caffeinate.kill();
    process.exit(1);
  }
});

await new Promise((resolve) => server.listen(config.port, '0.0.0.0', resolve));
log(`[tv-stream] listening on http://0.0.0.0:${config.port} (remote: http://localhost:${config.port}/remote/)`);

// ---------------------------------------------------------------- displays

let targetDisplay = null;
try {
  targetDisplay = pickTargetDisplay(await listDisplays());
  controller.setDisplay(displayKind(targetDisplay));
} catch (err) {
  log(`[tv-stream] ${err.message}`);
}

let placementPending = true;
let placing = false;

async function placeIfNeeded() {
  if (config.headless || placing || !targetDisplay || !controller.cdp) return;
  if (config.windowed && !placementPending) return;
  placing = true;
  try {
    const moved = await placeWindow(controller.cdp, controller.targetId, targetDisplay, { windowed: config.windowed });
    placementPending = false;
    if (moved) {
      log(`[tv-stream] window moved to ${displayKind(targetDisplay)} display (${targetDisplay.name})`);
      setTimeout(() => controller.refreshViewport(), 1_000);
    }
  } catch (err) {
    log(`[tv-stream] window placement failed: ${err.message}`);
  } finally {
    placing = false;
  }
}

const displayWatcher = watchDisplays({
  intervalMs: 5_000,
  log,
  onChange(target) {
    const changed = targetDisplay && targetDisplay.id !== target.id;
    targetDisplay = target;
    controller.setDisplay(displayKind(target));
    if (changed) log(`[tv-stream] target display is now ${displayKind(target)} (${target.name})`);
    placementPending = true;
  },
  onPoll() {
    placeIfNeeded();
  },
});

// ---------------------------------------------------------------- Chrome

let wasConnected = false;
controller.on('state', (state) => {
  if (state.tvConnected && !wasConnected) {
    placementPending = true;
    placeIfNeeded();
  }
  wasConnected = state.tvConnected;
});

const chromePath = findChrome();
let launcher = null;
if (!chromePath) {
  log('[tv-stream] Google Chrome not found; set TV_STREAM_CHROME_PATH. Serving the remote without a TV.');
} else {
  launcher = new ChromeLauncher({
    chromePath,
    cdpPort: config.cdpPort,
    profileDir: config.profileDir,
    startUrl: config.launcherUrl,
    windowed: config.windowed,
    headless: config.headless,
    getDisplay: () => targetDisplay,
    log,
  });
  launcher.on('ready', (wsUrl) => controller.attach(wsUrl));
  controller.on('disconnected', () => launcher.chromeLost());
  const modeName = config.headless ? 'headless' : config.windowed ? 'windowed' : 'kiosk';
  log(`[tv-stream] Chrome ${modeName}, CDP port ${config.cdpPort}, profile ${config.profileDir}`);
  launcher.start();
}

// ---------------------------------------------------------------- shutdown

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[tv-stream] ${signal}: shutting down`);
  const hardExit = setTimeout(() => process.exit(1), 8_000);
  hardExit.unref();
  displayWatcher.stop();
  controller.stop();
  await remoteSocket.close().catch(() => {});
  const closed = new Promise((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  await launcher?.stop().catch((err) => log(`[tv-stream] closing Chrome failed: ${err.message}`));
  caffeinate.kill();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
