// Purpose: Lists and switches the Mac's sound outputs (HDMI, speakers, AirPlay, ...) for the remote's settings.
// Depends on: build/tv-audio (macos/AudioTool, built by "npm run app"), which prints JSON.
// Used by: src/server/main.js, src/server/remote-socket.js
// Notes:
// - CoreAudio is not reachable from Node, so a small native helper does the work. Every call
//   resolves (never rejects) with { outputs, error? } so the remote can always render something.
// - A failed select still returns the current list, so the remote's checkmark stays truthful.
// - Two sources are merged: CoreAudio ("list", instant) and Control Center ("wireless", briefly
//   opens Control Center on screen, only on the remote's explicit scan). The last scan is kept
//   and merged into later lists with active cleared, since only a new scan knows its state;
//   names CoreAudio already lists are not repeated. Control Center entries have uid "cc:<name>".

import { execFile } from 'node:child_process';

const TOOL_TIMEOUT_MS = 8_000;
const CONTROL_CENTER_PREFIX = 'cc:';

export function createAudioOutputs({ toolPath, log = console.log }) {
  const run = (args) =>
    new Promise((resolve) => {
      execFile(toolPath, args, { timeout: TOOL_TIMEOUT_MS }, (err, stdout) => {
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = null;
        }
        if (Array.isArray(parsed?.outputs)) return resolve({ outputs: parsed.outputs });
        if (typeof parsed?.error === 'string') return resolve({ outputs: [], error: parsed.error });
        if (err?.code === 'ENOENT') {
          return resolve({ outputs: [], error: 'Sound settings need the Mac helper: run npm run app once.' });
        }
        log(`[tv-stream] tv-audio ${args[0]} failed: ${err?.message ?? 'no output'}`);
        resolve({ outputs: [], error: 'Could not read the sound outputs' });
      });
    });

  let lastWireless = null; // outputs from the last Control Center scan, or null before any scan

  const merge = (core, wireless) => {
    const names = new Set(core.map((o) => o.name));
    return [...core, ...wireless.filter((o) => !names.has(o.name))];
  };

  // CoreAudio list plus the remembered scan (state unknown, so not marked active).
  const withRemembered = async (extra = {}) => {
    const core = await run(['list']);
    if (!lastWireless) return { ...core, ...extra, scanned: false };
    const remembered = lastWireless.map((o) => ({ ...o, active: false }));
    return { outputs: merge(core.outputs, remembered), error: core.error, ...extra, scanned: true };
  };

  return {
    list: () => withRemembered(),

    async scan() {
      // Sequential on purpose: a CoreAudio query while the Sound panel opens leaves it empty.
      const wireless = await run(['wireless']);
      const core = await run(['list']);
      if (wireless.error) return { ...(await withRemembered()), error: wireless.error };
      lastWireless = wireless.outputs;
      return { outputs: merge(core.outputs, wireless.outputs), error: core.error, scanned: true };
    },

    async select(uid, source) {
      if (uid.startsWith(CONTROL_CENTER_PREFIX)) {
        const result = await run(['select-cc', uid.slice(CONTROL_CENTER_PREFIX.length)]);
        if (result.error) return { ...(await withRemembered()), error: result.error };
        lastWireless = result.outputs;
        const core = await run(['list']);
        return { outputs: merge(core.outputs, result.outputs), scanned: true };
      }
      const result = await run(['select', uid, ...(source == null ? [] : [String(source)])]);
      return withRemembered(result.error ? { error: result.error } : {});
    },
  };
}
