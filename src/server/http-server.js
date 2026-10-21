// Purpose: HTTP server: static files from public/ and the REST endpoints /api/info, /api/apps, /api/open
//   and /api/settings (services).
// Depends on: node:http, qrcode (QR SVG), src/server/app-catalog.js (publicApps),
//   src/server/tv-controller.js (openApp, openUrl, UserError),
//   src/server/service-settings.js (the `services` object passed in by main.js).
// Used by: src/server/main.js (remote-socket.js shares the returned server for /ws)
// Notes:
// - Every response carries Cache-Control: no-cache so edits to public/ show up on the TV and
//   the phone without cache busting.
// - Static paths are resolved against public/ and rejected when they escape it.
// - The QR SVG is built once per remote URL and cached; the URL only changes with the hostname.
// - /api/open answers within OPEN_ANSWER_MS even when the navigation is still running.
// - Like the remote, the settings endpoints are open to anyone on the network.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import QRCode from 'qrcode';
import { publicApps } from './app-catalog.js';
import { UserError } from './tv-controller.js';

const MAX_BODY_BYTES = 16 * 1024;
// The launcher falls back to opening the tile itself after 3 s without an answer.
const OPEN_ANSWER_MS = 2_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function firstLanIPv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

function localHostname() {
  const name = os.hostname();
  return name.includes('.') ? name : `${name}.local`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new UserError('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new UserError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const SERVICE_PATH = /^\/api\/settings\/services\/([A-Za-z0-9_-]{1,64})$/;

export function createHttpServer({ publicDir, port, controller, services, log = console.log }) {
  const root = path.resolve(publicDir);
  const qrCache = new Map();

  async function info() {
    const lanIp = firstLanIPv4();
    const remoteUrl = `http://${localHostname()}:${port}/remote/`;
    const remoteUrlIp = lanIp ? `http://${lanIp}:${port}/remote/` : remoteUrl;
    if (!qrCache.has(remoteUrl)) {
      qrCache.set(remoteUrl, await QRCode.toString(remoteUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
    }
    return { remoteUrl, remoteUrlIp, qrSvg: qrCache.get(remoteUrl) };
  }

  async function openFromBody(req, res) {
    try {
      const body = await readJsonBody(req);
      if (!controller.connected) return sendJson(res, 503, { ok: false, error: 'TV is not connected' });
      let opening;
      if (body && typeof body.appId === 'string') opening = controller.openApp(body.appId);
      else if (body && typeof body.url === 'string') opening = controller.openUrl(body.url);
      else throw new UserError('Body needs appId or url');
      // A slow site must not hold the launcher: once the navigation has been running for a
      // while, answer ok and let it finish in the background.
      const slow = new Promise((resolve) => setTimeout(resolve, OPEN_ANSWER_MS, 'slow'));
      if ((await Promise.race([opening, slow])) === 'slow') {
        opening.catch((err) => log(`[tv-stream] /api/open finished with error: ${err.message}`));
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof UserError) return sendJson(res, 400, { ok: false, error: err.message });
      log(`[tv-stream] /api/open failed: ${err.message}`);
      sendJson(res, 502, { ok: false, error: 'TV did not respond' });
    }
  }

  // GET /api/settings, POST /api/settings/services, PATCH and DELETE /api/settings/services/<id>.
  async function settingsRequest(pathname, req, res) {
    try {
      if (pathname === '/api/settings') {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET' });
        return sendJson(res, 200, services.snapshot());
      }
      if (pathname === '/api/settings/services') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST' });
        const service = await services.addService(await readJsonBody(req));
        return sendJson(res, 201, { ok: true, id: service.id, ...services.snapshot() });
      }
      const match = SERVICE_PATH.exec(pathname);
      if (!match) return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
      if (req.method === 'DELETE') await services.removeService(match[1]);
      else if (req.method === 'PATCH') await services.setHidden(match[1], (await readJsonBody(req)).hidden);
      else return sendJson(res, 405, { ok: false, error: 'Use PATCH or DELETE' });
      return sendJson(res, 200, { ok: true, ...services.snapshot() });
    } catch (err) {
      if (err instanceof UserError) return sendJson(res, 400, { ok: false, error: err.message });
      log(`[tv-stream] ${req.method} ${pathname} failed: ${err.message}`);
      return sendJson(res, 500, { ok: false, error: 'Saving the settings failed' });
    }
  }

  async function serveStatic(pathname, req, res) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (decoded.includes('\0')) return send(res, 400, 'Bad request');
    let filePath = path.resolve(root, `.${decoded}`);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
    try {
      let info = await stat(filePath);
      if (info.isDirectory()) {
        // "/tv" and friends redirect to the slash form so relative asset URLs resolve.
        if (!pathname.endsWith('/')) return send(res, 301, '', { Location: `${pathname}/` });
        filePath = path.join(filePath, 'index.html');
        info = await stat(filePath);
      }
      if (!info.isFile()) return send(res, 404, 'Not found');
      const body = await readFile(filePath);
      const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': type, 'Content-Length': body.length });
    } catch {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(res, 400, 'Bad request');
    }
    try {
      if (pathname === '/') return send(res, 302, '', { Location: '/remote/' });
      if (pathname === '/api/info' && req.method === 'GET') return sendJson(res, 200, await info());
      if (pathname === '/api/apps' && req.method === 'GET') return sendJson(res, 200, publicApps());
      if (pathname === '/api/open') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST' });
        return await openFromBody(req, res);
      }
      if (pathname === '/api/settings' || pathname.startsWith('/api/settings/')) return await settingsRequest(pathname, req, res);
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return await serveStatic(pathname, req, res);
    } catch (err) {
      log(`[tv-stream] http ${pathname} failed: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'Internal error');
    }
  });

  return server;
}
