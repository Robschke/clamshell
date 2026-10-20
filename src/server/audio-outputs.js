// Purpose: Lists and switches the Mac's sound outputs (HDMI, speakers, AirPlay, ...) for the remote's settings.
// Depends on: build/tv-audio (macos/AudioTool/tv-audio.swift, built by "npm run app"), which prints JSON.
// Used by: src/server/main.js, src/server/remote-socket.js
// Notes:
// - CoreAudio is not reachable from Node, so a small native helper does the work. Every call
//   resolves (never rejects) with { outputs, error? } so the remote can always render something.
// - A failed select still returns the current list, so the remote's checkmark stays truthful.

import { execFile } from 'node:child_process';

const TOOL_TIMEOUT_MS = 5_000;

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

  return {
    list: () => run(['list']),
    async select(uid, source) {
      const result = await run(['select', uid, ...(source == null ? [] : [String(source)])]);
      if (!result.error) return result;
      const current = await run(['list']);
      return { outputs: current.outputs, error: result.error };
    },
  };
}
