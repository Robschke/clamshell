// Purpose: The "Services" settings area: adding and removing the user's own services and hiding
//   built-in ones. Validates every change, saves it and keeps the app catalog in sync.
// Depends on: src/server/settings-store.js (persistence, key "services"),
//   src/server/app-catalog.js (setUserServices, serviceList, SERVICE_COLORS, URL helpers),
//   src/server/tv-controller.js (UserError for invalid input).
// Used by: src/server/main.js (creates it), src/server/http-server.js (/api/settings endpoints).
// Notes:
// - Stored shape: { custom: [{ id, name, url, color }], hidden: [id] }. Values from the file are
//   validated like requests, so a hand-edited file cannot put bad data on the TV.
// - Only built-in services can be hidden; user services are removed instead.

import { randomBytes } from 'node:crypto';
import {
  SERVICE_COLORS, isBuiltInApp, normalizeHttpUrl, serviceList, setUserServices, siteHost,
} from './app-catalog.js';
import { UserError } from './tv-controller.js';

const STORE_KEY = 'services';
const MAX_NAME_LENGTH = 40;
const MAX_CUSTOM_SERVICES = 40;
const CUSTOM_ID = /^custom-[a-z0-9]{8}$/;

function cleanName(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function validService(entry) {
  return entry && typeof entry === 'object'
    && typeof entry.id === 'string' && CUSTOM_ID.test(entry.id)
    && cleanName(entry.name) && cleanName(entry.name).length <= MAX_NAME_LENGTH
    && normalizeHttpUrl(entry.url) && SERVICE_COLORS.includes(entry.color);
}

export function createServiceSettings({ store, log = console.log }) {
  let state = { custom: [], hidden: [] };

  function apply(next) {
    state = next;
    setUserServices(state);
  }

  function load() {
    const saved = store.get(STORE_KEY) ?? {};
    const custom = (Array.isArray(saved.custom) ? saved.custom : []).filter(validService)
      .map(({ id, name, url, color }) => ({ id, name: cleanName(name), url: normalizeHttpUrl(url), color }));
    const hidden = (Array.isArray(saved.hidden) ? saved.hidden : [])
      .filter((id) => typeof id === 'string' && isBuiltInApp(id));
    const dropped = (saved.custom?.length ?? 0) - custom.length;
    if (dropped > 0) log(`[tv-stream] ignored ${dropped} invalid service(s) in the settings file`);
    apply({ custom, hidden: [...new Set(hidden)] });
  }

  async function save(next) {
    await store.set(STORE_KEY, next);
    apply(next);
  }

  function snapshot() {
    return { services: serviceList(), colors: SERVICE_COLORS };
  }

  async function addService(body) {
    const name = cleanName(body?.name);
    const url = normalizeHttpUrl(body?.url);
    const color = body?.color;
    if (!name) throw new UserError('Enter a name');
    if (name.length > MAX_NAME_LENGTH) throw new UserError(`Keep the name under ${MAX_NAME_LENGTH} characters`);
    if (!url) throw new UserError('Enter a web address, for example ardmediathek.de');
    if (!SERVICE_COLORS.includes(color)) throw new UserError('Choose a color');
    if (state.custom.length >= MAX_CUSTOM_SERVICES) throw new UserError('Remove a service before adding more');
    const host = siteHost(url);
    if (serviceList().some((service) => siteHost(service.url) === host)) {
      throw new UserError(`${host} is already in the list`);
    }
    const service = { id: `custom-${randomBytes(4).toString('hex')}`, name, url, color };
    await save({ ...state, custom: [...state.custom, service] });
    log(`[tv-stream] added service ${name} (${host})`);
    return service;
  }

  async function removeService(id) {
    if (!state.custom.some((service) => service.id === id)) {
      throw new UserError(isBuiltInApp(id) ? 'Built-in services can only be hidden' : 'Unknown service');
    }
    await save({ ...state, custom: state.custom.filter((service) => service.id !== id) });
  }

  async function setHidden(id, hidden) {
    if (!isBuiltInApp(id)) throw new UserError('Only built-in services can be hidden');
    if (typeof hidden !== 'boolean') throw new UserError('hidden must be true or false');
    const rest = state.hidden.filter((entry) => entry !== id);
    await save({ ...state, hidden: hidden ? [...rest, id] : rest });
  }

  return { load, snapshot, addService, removeService, setHidden };
}
