// Purpose: Lists the Mac's screens via JXA (NSScreen) and watches for external display hot-plug.
// Depends on: /usr/bin/osascript (JavaScript for Automation, AppKit + CoreGraphics bridges).
// Used by: src/server/main.js (watcher), src/server/chrome-launcher.js (display type)
// Notes:
// - Cocoa frames use a bottom-left origin with y growing upwards; Chrome window bounds use the
//   top-left of the primary screen (screens[0], the one with the menu bar) with y growing
//   downwards. top = primaryHeight - (origin.y + height) converts between them.
// - Built-in detection uses CGDisplayIsBuiltin on the NSScreenNumber. The localized name is only
//   a fallback because it depends on the system language ("Integriertes Retina-Display").
// - Frames are in points, which is what Chrome window bounds use too.

import { execFile } from 'node:child_process';

const JXA_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
const screens = $.NSScreen.screens;
const primaryHeight = screens.objectAtIndex(0).frame.size.height;
const out = [];
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const f = s.frame;
  const id = s.deviceDescription.objectForKey('NSScreenNumber').unsignedIntValue;
  const name = s.localizedName.js;
  let builtin;
  try { builtin = !!$.CGDisplayIsBuiltin(id); }
  catch (e) { builtin = /built-in|integriert|intégré|integrad|retina/i.test(name); }
  out.push({
    id, name, builtin, primary: i === 0,
    x: f.origin.x, y: primaryHeight - (f.origin.y + f.size.height),
    width: f.size.width, height: f.size.height,
  });
}
JSON.stringify(out);
`;

// Resolves to [{ id, name, builtin, primary, x, y, width, height }] in top-left global points.
export function listDisplays({ timeoutMs = 4_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(new Error(`display detection failed: ${err.message.split('\n')[0]}`));
      try {
        const displays = JSON.parse(stdout.trim());
        if (!Array.isArray(displays) || displays.length === 0) throw new Error('no screens');
        resolve(displays);
      } catch (parseErr) {
        reject(new Error(`display detection returned bad output: ${parseErr.message}`));
      }
    });
  });
}

// The display the TV window belongs on: the largest external display, else the built-in one.
export function pickTargetDisplay(displays) {
  const external = displays.filter((d) => !d.builtin).sort((a, b) => b.width * b.height - a.width * a.height);
  if (external.length) return external[0];
  return displays.find((d) => d.builtin) ?? displays[0];
}

export function displayKind(display) {
  return display && !display.builtin ? 'external' : 'builtin';
}

// Polls the screen list and calls onChange(target, displays) whenever the target display
// (identity or frame) changes, plus once on the first successful poll. `onPoll` runs after
// every successful poll so the caller can re-check window placement.
export function watchDisplays({ intervalMs = 5_000, onChange, onPoll, log = console.log } = {}) {
  let lastKey = null;
  let timer = null;
  let stopped = false;
  let failing = false;
  let current = null;

  async function poll() {
    try {
      const displays = await listDisplays();
      if (stopped) return;
      failing = false;
      const target = pickTargetDisplay(displays);
      current = target;
      const key = `${target.id}:${target.x},${target.y},${target.width}x${target.height}`;
      if (key !== lastKey) {
        lastKey = key;
        onChange?.(target, displays);
      }
      onPoll?.(target, displays);
    } catch (err) {
      if (!failing) log(`[tv-stream] ${err.message}`);
      failing = true;
    } finally {
      if (!stopped) timer = setTimeout(poll, intervalMs);
    }
  }

  poll();
  return {
    get current() {
      return current;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
