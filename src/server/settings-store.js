// Purpose: Persists the user's settings as one JSON object in settings.json, one top-level key per
//   settings area (for example "services"), so later areas add a key instead of a new file.
// Depends on: node:fs.
// Used by: src/server/main.js (creates it), src/server/service-settings.js (the "services" key).
// Notes:
// - Loaded synchronously once at start, before the HTTP server answers.
// - A file that cannot be parsed is renamed to settings.json.broken and the server starts with
//   defaults, so a bad edit never stops the TV from starting and is not overwritten silently.
// - Writes go to a temporary file that is then renamed over settings.json, so a crash mid-write
//   leaves the previous file intact. Updates are serialized so two quick changes cannot interleave.

import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class SettingsStore {
  #file;
  #log;
  #data = {};
  #writing = Promise.resolve();

  constructor({ file, log = console.log }) {
    this.#file = file;
    this.#log = log;
  }

  load() {
    let text;
    try {
      text = readFileSync(this.#file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.#log(`[tv-stream] reading ${this.#file} failed: ${err.message}`);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      this.#data = parsed;
    } catch (err) {
      this.#log(`[tv-stream] ${this.#file} is invalid (${err.message}); starting with default settings`);
      try {
        mkdirSync(path.dirname(this.#file), { recursive: true });
        renameSync(this.#file, `${this.#file}.broken`);
      } catch (renameErr) {
        this.#log(`[tv-stream] keeping the invalid settings file failed: ${renameErr.message}`);
      }
    }
  }

  // A deep copy of one area, or undefined when it was never saved.
  get(key) {
    const value = this.#data[key];
    return value === undefined ? undefined : structuredClone(value);
  }

  // Replaces one area and writes the file. Resolves once the file is on disk.
  set(key, value) {
    this.#data = { ...this.#data, [key]: structuredClone(value) };
    const snapshot = JSON.stringify(this.#data, null, 2) + '\n';
    this.#writing = this.#writing.catch(() => {}).then(() => this.#write(snapshot));
    return this.#writing;
  }

  async #write(text) {
    const tmp = `${this.#file}.tmp`;
    await mkdir(path.dirname(this.#file), { recursive: true });
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.#file);
  }
}
