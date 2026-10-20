// Purpose: Minimal Chrome DevTools Protocol client over Node's global WebSocket.
// Depends on: Node >= 22 global WebSocket, node:events.
// Used by: src/server/tv-controller.js
// Notes:
// - One client talks to the browser endpoint; page targets are reached through flat
//   sessions (Target.attachToTarget with flatten: true), so `send` takes an optional sessionId.
// - Every pending call rejects when the socket closes or when its timeout passes, so callers
//   never hang on a dead or frozen Chrome.

import { EventEmitter } from 'node:events';

const DEFAULT_TIMEOUT_MS = 10_000;

export class CdpError extends Error {
  constructor(method, message, code) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

export class CdpClient extends EventEmitter {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => this.#onClose());
    socket.addEventListener('error', () => {
      // A close event always follows; the error itself carries no useful detail.
    });
  }

  // Opens the socket and resolves once it is connected.
  static connect(wsUrl, { timeoutMs = 5_000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`CDP connect timeout (${wsUrl})`));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed (${wsUrl})`));
      }, { once: true });
    });
  }

  get closed() {
    return this.#closed;
  }

  send(method, params = {}, sessionId = undefined, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.#closed) return Promise.reject(new CdpError(method, 'connection closed'));
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(method, `timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError(method, err.message));
      }
    });
  }

  close() {
    if (this.#closed) return;
    try {
      this.#socket.close();
    } catch {
      // Already closing.
    }
    this.#onClose();
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const call = this.#pending.get(message.id);
      if (!call) return;
      this.#pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new CdpError(call.method, message.error.message, message.error.code));
      else call.resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      // Emitted twice: once by method name, once on a catch-all channel.
      this.emit(message.method, message.params ?? {}, message.sessionId);
      this.emit('event', message.method, message.params ?? {}, message.sessionId);
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer);
      call.reject(new CdpError(call.method, 'connection closed'));
    }
    this.#pending.clear();
    this.emit('close');
  }
}
