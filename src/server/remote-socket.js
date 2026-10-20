// Purpose: WebSocket endpoint /ws for phone remotes: validates messages, forwards them to the tv-controller, broadcasts state.
// Depends on: ws (WebSocketServer), src/server/tv-controller.js (TvController, UserError).
// Used by: src/server/main.js
// Notes:
// - Validation is strict on type and required fields (unknown types or bad values get
//   { type: "error" }); extra fields are ignored so remotes can add their own metadata.
// - Messages over 16 KB are dropped silently. ws's own maxPayload is set far higher on purpose:
//   hitting it closes the connection, and one oversized paste must not disconnect the remote.
// - A ping every 30 s drops phones that went to sleep without closing the socket.

import { WebSocketServer } from 'ws';
import { UserError } from './tv-controller.js';

const MAX_MESSAGE_BYTES = 16 * 1024;
const HARD_PAYLOAD_LIMIT = 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const MAX_POINTER_DELTA = 10_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_URL_LENGTH = 4_096;

const KEYS = new Set(['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu']);
const MEDIA = new Set(['playpause', 'rewind', 'forward', 'volumeDown', 'volumeUp', 'mute']);
const MODES = new Set(['dpad', 'touchpad']);
const TEXT_ACTIONS = new Set(['insert', 'backspace', 'enter']);

const isDelta = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_POINTER_DELTA;

// Returns a normalized command, or a string describing why the message is invalid.
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'Message must be a JSON object';
  switch (msg.type) {
    case 'key':
      return KEYS.has(msg.key) ? { type: 'key', key: msg.key } : 'Unknown key';
    case 'media':
      return MEDIA.has(msg.action) ? { type: 'media', action: msg.action } : 'Unknown media action';
    case 'mode':
      return MODES.has(msg.mode) ? { type: 'mode', mode: msg.mode } : 'Unknown mode';
    case 'pointer':
      if (msg.action === 'click') return { type: 'pointer', action: 'click' };
      if (msg.action === 'start') return { type: 'pointer', action: 'start' };
      if (msg.action === 'flick') {
        if (!isDelta(msg.vx) || !isDelta(msg.vy)) return 'Pointer vx and vy must be finite numbers';
        return { type: 'pointer', action: 'flick', vx: msg.vx, vy: msg.vy };
      }
      if (msg.action === 'move' || msg.action === 'scroll') {
        if (!isDelta(msg.dx) || !isDelta(msg.dy)) return 'Pointer dx and dy must be finite numbers';
        return { type: 'pointer', action: msg.action, dx: msg.dx, dy: msg.dy };
      }
      return 'Unknown pointer action';
    case 'text':
      if (!TEXT_ACTIONS.has(msg.action)) return 'Unknown text action';
      if (msg.action !== 'insert') return { type: 'text', action: msg.action };
      if (typeof msg.text !== 'string' || msg.text.length === 0 || msg.text.length > MAX_TEXT_LENGTH) {
        return 'Text must be a non-empty string';
      }
      return { type: 'text', action: 'insert', text: msg.text };
    case 'open':
      if (typeof msg.url !== 'string' || !msg.url.trim() || msg.url.length > MAX_URL_LENGTH) return 'URL must be a non-empty string';
      return { type: 'open', url: msg.url };
    default:
      return `Unknown message type ${JSON.stringify(String(msg.type)).slice(0, 40)}`;
  }
}

export function attachRemoteSocket({ server, controller, log = console.log }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: HARD_PAYLOAD_LIMIT });

  const sendJson = (socket, payload) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };
  const sendError = (socket, message) => sendJson(socket, { type: 'error', message });

  wss.on('connection', (socket, req) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('error', () => {});
    sendJson(socket, controller.state);

    socket.on('message', (data, isBinary) => {
      if (data.length > MAX_MESSAGE_BYTES) return;
      if (isBinary) return sendError(socket, 'Binary frames are not supported');
      let parsed;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        return sendError(socket, 'Invalid JSON');
      }
      const command = validateMessage(parsed);
      if (typeof command === 'string') return sendError(socket, command);
      controller.handle(command).catch((err) => {
        if (err instanceof UserError) sendError(socket, err.message);
        else log(`[tv-stream] ${command.type} failed: ${err.message}`);
      });
    });

    log(`[tv-stream] remote connected (${req.socket.remoteAddress}, ${wss.clients.size} total)`);
    socket.on('close', () => log(`[tv-stream] remote disconnected (${wss.clients.size} left)`));
  });

  const onState = (state) => {
    const json = JSON.stringify(state);
    for (const socket of wss.clients) {
      if (socket.readyState === socket.OPEN) socket.send(json);
    }
  };
  controller.on('state', onState);

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  return {
    close() {
      clearInterval(heartbeat);
      controller.off('state', onState);
      for (const socket of wss.clients) socket.close(1001, 'server shutting down');
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
