// Purpose: Maps remote commands to CDP input and overlay calls on the TV page; owns mode, cursor and TV state.
// Depends on: src/server/cdp-client.js (CdpClient), src/server/app-catalog.js (app lookup, user agent,
//   navigation style, link conversion), src/inject/tv-overlay.js (read from disk, injected).
// Used by: src/server/main.js, src/server/remote-socket.js, src/server/http-server.js
// Notes:
// - One browser-level CDP connection; the TV page is a flat session (Target.attachToTarget with
//   flatten), so window moves (Browser.*) and page commands share one socket.
// - Every overlay call goes through `#overlay`, which reports "missing" when window.__tvStream is
//   absent or throws; each command then falls back to real key events so the remote keeps
//   working without the overlay.
// - Commands run through a short serial queue so key, text and media events reach the page in
//   the order they were sent. Pointer moves bypass it and are coalesced: at most one mouse move
//   is in flight, and only the latest cursor position is sent next.
// - The user agent override lives in the CDP session, so it is set again on every attach and
//   before every navigation the controller starts. A page that reaches youtube.com/tv by itself
//   (without the TV user agent) gets the override plus one reload.
// - The overlay source is re-read on every attach so edits apply after a Chrome reconnect.
// - Edge auto-scroll: while a finger moves the cursor on the remote touchpad and the cursor sits
//   exactly on a viewport border, mouse wheel events in that direction are sent at a steady
//   rate. Chrome routes them to the scrollable element under the cursor, so horizontal rows
//   scroll when they can and the page scrolls otherwise. Lifting the finger stops it.

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { CdpClient } from './cdp-client.js';
import {
  findAppById,
  findAppByUrl,
  navigationForUrl,
  resolveOpenUrl,
  userAgentForUrl,
} from './app-catalog.js';

// An error whose message is meant for the remote user.
export class UserError extends Error {}

const BINDING_NAME = '__tvStreamSend';
const OVERLAY_TIMEOUT_MS = 3_000;
const INPUT_TIMEOUT_MS = 5_000;
const MAX_QUEUE = 40;
const STATE_DEBOUNCE_MS = 60;
const APPLY_DEBOUNCE_MS = 120;
const VIEWPORT_REFRESH_MS = 3_000;
const EDGE_SCROLL_INTERVAL_MS = 50;
const EDGE_SCROLL_STEP_PX = 30;

const KEYS = {
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ok: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  k: { key: 'k', code: 'KeyK', keyCode: 75, text: 'k' },
};

// Volume control used only when the overlay is missing.
const VOLUME_FALLBACK = (action) => `(() => {
  const videos = [...document.querySelectorAll('video')];
  const v = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!v) return false;
  const action = ${JSON.stringify(action)};
  if (action === 'mute') { v.muted = !v.muted; return true; }
  v.muted = false;
  const step = action === 'volumeUp' ? 0.1 : -0.1;
  v.volume = Math.min(1, Math.max(0, Math.round((v.volume + step) * 10) / 10));
  return true;
})()`;

// YouTube TV has no text field, only its own on-screen keyboard. Key events cover letters and
// digits but lose or misread characters such as umlauts, "-" or "&" (it turns key codes back into
// characters, and some codes are arrows or Delete). Replacing the #/search?q= hash sets any text,
// opens search from every YouTube screen and adds no history entry.
// The query is tracked on window next to the hash it produced; with any other hash it starts from
// that hash's q. The search box itself is never parsed for text: when empty it shows a localized
// placeholder ("Search", "Suche") that is indistinguishable from typed text without relying on
// YouTube's obfuscated class names.
const YOUTUBE_TV_EDIT = (edit) => `(() => {
  const last = window.__tvStreamYtQuery;
  const onSearch = location.hash.startsWith('#/search');
  const hashQuery = () => new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
  const current = last && last.hash === location.hash ? last.query : (onSearch ? hashQuery() : '');
  const edit = ${JSON.stringify(edit)};
  const query = edit.insert !== undefined ? current + edit.insert : [...current].slice(0, -1).join('');
  if (!query) {
    // YouTube ignores an empty or blank q and keeps the old text, so the server clears the box
    // with real Backspace presses once it shows exactly the text being deleted.
    window.__tvStreamYtQuery = { query: '', hash: location.hash };
    return { clear: current };
  }
  let hash = '#/search?q=' + encodeURIComponent(query);
  // An unchanged hash fires no hashchange, so the box would keep showing stale text.
  if (hash === location.hash) hash += '&tvs=' + Date.now();
  location.replace(location.origin + location.pathname + location.search + hash);
  window.__tvStreamYtQuery = { query, hash: location.hash };
  return {};
})()`;
const YOUTUBE_TV_BOX_TEXT = `(document.querySelector('ytlr-search-text-box') || {}).textContent || ''`;
const YOUTUBE_TV_CLEAR_WAIT_MS = 1_500;

export class TvController extends EventEmitter {
  #launcherUrl;
  #launcherOrigin;
  #overlayPath;
  #log;

  #cdp = null;
  #sessionId = null;
  #targetId = null;
  #mainFrameId = null;
  #attaching = false;
  #stopped = false;
  #attachFailures = 0;
  #reattachTimer = null;

  #mode = 'dpad';
  #url = '';
  #title = '';
  #display = 'builtin';
  #userAgent = null;
  #uaReloadAt = 0;
  #overlayMissingLogged = false;

  #viewport = { width: 1280, height: 720 };
  #viewportKnown = false;
  #viewportAt = 0;
  #cursor = { x: 640, y: 360 };
  #moveDirty = false;
  #moveInFlight = false;
  #touching = false;
  #edgeScrollTimer = null;
  #edgeScrollInFlight = false;

  #queue = Promise.resolve();
  #queued = 0;
  #stateTimer = null;
  #lastStateJson = '';
  #applyTimer = null;
  #titleTimer = null;

  constructor({ launcherUrl, overlayPath, log = console.log }) {
    super();
    this.#launcherUrl = launcherUrl;
    this.#launcherOrigin = new URL(launcherUrl).origin;
    this.#overlayPath = overlayPath;
    this.#log = log;
  }

  get connected() {
    return Boolean(this.#cdp && !this.#cdp.closed && this.#sessionId);
  }

  // Browser-level client and page target id, for window placement.
  get cdp() {
    return this.connected ? this.#cdp : null;
  }

  get targetId() {
    return this.#targetId;
  }

  get state() {
    return {
      type: 'state',
      mode: this.#mode,
      appId: this.#appIdFor(this.#url),
      title: this.#title,
      url: this.#url,
      tvConnected: this.connected,
      display: this.#display,
    };
  }

  setDisplay(kind) {
    if (this.#display === kind) return;
    this.#display = kind;
    this.#emitState();
  }

  // ---------------------------------------------------------------- connection

  // Connects to a Chrome browser endpoint and attaches to its TV page.
  async attach(browserWsUrl) {
    if (this.#stopped || this.#attaching) return;
    if (this.#cdp && !this.#cdp.closed && this.#sessionId) return;
    this.#attaching = true;
    try {
      if (!this.#cdp || this.#cdp.closed) {
        const cdp = await CdpClient.connect(browserWsUrl);
        this.#cdp = cdp;
        cdp.on('event', (method, params, sessionId) => this.#onEvent(method, params, sessionId));
        cdp.on('close', () => this.#onBrowserClosed(cdp));
        await cdp.send('Target.setDiscoverTargets', { discover: true });
      }
      await this.#attachPage();
      this.#attachFailures = 0;
    } catch (err) {
      this.#attachFailures++;
      this.#log(`[tv-stream] CDP attach failed: ${err.message}`);
      this.#sessionId = null;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.#attachFailures, 5));
      clearTimeout(this.#reattachTimer);
      this.#reattachTimer = setTimeout(() => this.emit('disconnected'), delay);
    } finally {
      this.#attaching = false;
      this.#emitState();
    }
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#reattachTimer);
    clearTimeout(this.#applyTimer);
    clearTimeout(this.#titleTimer);
    clearTimeout(this.#stateTimer);
    this.#setTouching(false);
    this.#cdp?.close();
  }

  async #attachPage() {
    const cdp = this.#cdp;
    const { targetInfos } = await cdp.send('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page' && /^(https?|about|data|file):/.test(t.url));
    let page = pages.find((t) => t.url.startsWith(this.#launcherOrigin)) ?? pages[0];
    if (!page) {
      const { targetId } = await cdp.send('Target.createTarget', { url: this.#launcherUrl });
      page = { targetId, url: this.#launcherUrl, title: '' };
    }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.#sessionId = sessionId;
    this.#targetId = page.targetId;
    this.#url = page.url;
    this.#title = page.title ?? '';
    this.#userAgent = null;

    const send = (method, params) => cdp.send(method, params, sessionId);
    await Promise.all([send('Page.enable'), send('Runtime.enable')]);
    await send('Runtime.addBinding', { name: BINDING_NAME });

    const source = await this.#readOverlay();
    if (source) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source });
      // The current document predates the injection; give it the overlay once.
      const check = await send('Runtime.evaluate', { expression: 'typeof window.__tvStream', returnByValue: true });
      if (check.result?.value === 'undefined') {
        await send('Runtime.evaluate', { expression: source }).catch(() => {});
      }
    }

    const { frameTree } = await send('Page.getFrameTree');
    this.#mainFrameId = frameTree.frame.id;
    this.#url = frameTree.frame.url + (frameTree.frame.urlFragment ?? '');
    await this.#setUserAgent(userAgentForUrl(this.#url));

    this.#log(`[tv-stream] attached to TV page ${this.#shortUrl(this.#url)}`);
    this.#viewportAt = 0;
    await this.#refreshViewport().catch((err) => this.#logCdp('viewport', err));
    this.#scheduleApply();
  }

  async #readOverlay() {
    try {
      const source = await readFile(this.#overlayPath, 'utf8');
      this.#overlayMissingLogged = false;
      return source;
    } catch {
      if (!this.#overlayMissingLogged) {
        this.#log('[tv-stream] overlay script not found; remote works through key events only');
        this.#overlayMissingLogged = true;
      }
      return null;
    }
  }

  #onBrowserClosed(cdp) {
    if (this.#cdp !== cdp) return;
    this.#cdp = null;
    this.#sessionId = null;
    this.#emitState();
    if (this.#stopped) return;
    this.#log('[tv-stream] CDP connection to Chrome closed');
    this.emit('disconnected');
  }

  #pageLost(reason) {
    if (!this.#sessionId) return;
    this.#log(`[tv-stream] TV page lost (${reason}); reattaching`);
    this.#sessionId = null;
    this.#emitState();
    clearTimeout(this.#reattachTimer);
    this.#reattachTimer = setTimeout(() => {
      if (this.#stopped || !this.#cdp || this.#cdp.closed) return;
      this.attach(null);
    }, 500);
  }

  // ---------------------------------------------------------------- events

  #onEvent(method, params, sessionId) {
    if (!sessionId) {
      this.#onBrowserEvent(method, params);
      return;
    }
    if (sessionId !== this.#sessionId) return;
    switch (method) {
      case 'Page.frameNavigated':
        if (!params.frame.parentId) {
          this.#mainFrameId = params.frame.id;
          this.#onNavigated(params.frame.url + (params.frame.urlFragment ?? ''));
        }
        break;
      case 'Page.navigatedWithinDocument':
        if (params.frameId === this.#mainFrameId) this.#onNavigated(params.url);
        break;
      case 'Page.domContentEventFired':
      case 'Page.loadEventFired':
        this.#viewportAt = 0;
        this.#scheduleApply();
        break;
      case 'Runtime.bindingCalled':
        if (params.name === BINDING_NAME) this.#onBinding(params.payload);
        break;
      case 'Page.javascriptDialogOpening':
        // Nobody can answer a dialog on the TV; accept it so the page does not freeze.
        this.#cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
        break;
      case 'Inspector.targetCrashed':
        this.#log('[tv-stream] TV page crashed; reloading');
        this.#cdp.send('Page.reload', {}, sessionId).catch(() => {});
        break;
      default:
        break;
    }
  }

  #onBrowserEvent(method, params) {
    switch (method) {
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo;
        if (info.targetId !== this.#targetId) return;
        if (info.title !== this.#title) {
          this.#title = info.title;
          this.#emitState();
        }
        break;
      }
      case 'Target.targetDestroyed':
        if (params.targetId === this.#targetId) this.#pageLost('closed');
        break;
      case 'Target.detachedFromTarget':
        if (params.sessionId && params.sessionId === this.#sessionId) this.#pageLost('detached');
        break;
      default:
        break;
    }
  }

  #onNavigated(url) {
    this.#url = url;
    this.#emitState();
    this.#scheduleApply();
    // SPAs often set the title a moment after the URL changes.
    clearTimeout(this.#titleTimer);
    this.#titleTimer = setTimeout(() => this.#refreshTitle().catch(() => {}), 1_500);
    this.#syncUserAgentAfterNavigation(url).catch((err) => this.#logCdp('user agent sync', err));
  }

  async #syncUserAgentAfterNavigation(url) {
    const wanted = userAgentForUrl(url);
    if (wanted === this.#userAgent) return;
    if (!wanted) {
      // Left the TV site by itself: later requests go out with the default user agent.
      await this.#setUserAgent('');
      return;
    }
    await this.#setUserAgent(wanted);
    if (Date.now() - this.#uaReloadAt > 10_000) {
      this.#uaReloadAt = Date.now();
      this.#log('[tv-stream] TV site reached without TV user agent; reloading');
      await this.#page('Page.reload', {});
    }
  }

  #onBinding(payload) {
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    const action = message?.action;
    if (action === 'home') this.#enqueue(() => this.home());
    else if (action === 'reload') this.#enqueue(() => this.#page('Page.reload', {}));
    else this.#log(`[tv-stream] overlay sent unknown action ${JSON.stringify(action)}`);
  }

  // Re-applies mode and cursor after loads and navigations (debounced).
  #scheduleApply() {
    clearTimeout(this.#applyTimer);
    this.#applyTimer = setTimeout(() => {
      this.#applyMode().catch((err) => this.#logCdp('apply mode', err));
    }, APPLY_DEBOUNCE_MS);
  }

  async #applyMode() {
    if (!this.connected) return;
    await this.#refreshTitle();
    await this.#refreshViewport();
    await this.#overlay('setMode', this.#mode);
    if (this.#mode === 'touchpad') await this.#overlay('setCursor', this.#cursor.x, this.#cursor.y);
  }

  // ---------------------------------------------------------------- commands

  // Entry point for validated remote messages. Throws UserError for problems the remote should see.
  async handle(message) {
    if (message.type === 'mode') return this.setMode(message.mode);
    if (message.type === 'pointer' && message.action === 'move') return this.#pointerMove(message.dx, message.dy);
    if (message.type === 'pointer' && message.action === 'touch') return this.#setTouching(message.active);
    this.#requireConnected();
    return this.#enqueue(() => this.#run(message));
  }

  async #run(message) {
    switch (message.type) {
      case 'key':
        return this.#key(message.key);
      case 'media':
        return this.#media(message.action);
      case 'pointer':
        if (message.action === 'click') return this.#pointerClick();
        return this.#pointerScroll(message.dx, message.dy);
      case 'text':
        if (message.action === 'insert' && this.#isYouTubeTv()) return this.#youtubeTvEdit({ insert: message.text });
        if (message.action === 'backspace' && this.#isYouTubeTv()) return this.#youtubeTvEdit({ backspace: true });
        if (message.action === 'insert') return this.#page('Input.insertText', { text: message.text }, INPUT_TIMEOUT_MS);
        return this.#pressKey(message.action === 'enter' ? KEYS.enter : KEYS.backspace);
      case 'open':
        return this.openUrl(message.url);
      default:
        throw new UserError(`Unsupported command ${message.type}`);
    }
  }

  #enqueue(task) {
    if (this.#queued >= MAX_QUEUE) return Promise.reject(new UserError('TV is busy, command dropped'));
    this.#queued++;
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => {}).finally(() => {
      this.#queued--;
    });
    return run;
  }

  #requireConnected() {
    if (!this.connected) throw new UserError('TV is not connected');
  }

  async setMode(mode) {
    this.#mode = mode;
    this.#emitState();
    if (!this.connected) return;
    await this.#overlay('setMode', mode);
    if (mode === 'touchpad') await this.#overlay('setCursor', this.#cursor.x, this.#cursor.y);
  }

  async home() {
    this.#requireConnected();
    await this.#navigate(this.#launcherUrl);
  }

  async openApp(appId) {
    const app = findAppById(appId);
    if (!app) throw new UserError(`Unknown app ${appId}`);
    this.#requireConnected();
    await this.#enqueue(() => this.#navigate(app.url));
  }

  async openUrl(raw) {
    const url = resolveOpenUrl(raw);
    if (!url) throw new UserError('Only http(s) links can be opened');
    this.#requireConnected();
    await this.#navigate(url);
  }

  async #navigate(url) {
    await this.#setUserAgent(userAgentForUrl(url));
    const result = await this.#page('Page.navigate', { url });
    if (result?.errorText) this.#log(`[tv-stream] navigation to ${this.#shortUrl(url)} failed: ${result.errorText}`);
  }

  async #key(key) {
    if (key === 'home') return this.home();
    if (key === 'menu') {
      const result = await this.#overlay('toggleMenu');
      if (!result.available) this.#log('[tv-stream] menu needs the overlay, which is not loaded');
      return;
    }
    const result = await this.#overlay('handleKey', key);
    if (result.handled) return;
    if (key === 'back') return this.#back();
    return this.#pressKey(KEYS[key]);
  }

  async #back() {
    if (navigationForUrl(this.#url, this.#launcherOrigin) === 'native') return this.#pressKey(KEYS.escape);
    const { currentIndex, entries } = await this.#page('Page.getNavigationHistory', {});
    if (currentIndex > 0) {
      const entry = entries[currentIndex - 1];
      await this.#setUserAgent(userAgentForUrl(entry.url));
      await this.#page('Page.navigateToHistoryEntry', { entryId: entry.id });
      return;
    }
    return this.home();
  }

  async #media(action) {
    const result = await this.#overlay('media', action);
    if (result.handled) return;
    switch (action) {
      case 'playpause':
        return this.#pressKey(this.#isYouTubeTv() ? KEYS.k : KEYS.space);
      case 'rewind':
        return this.#pressKey(KEYS.left);
      case 'forward':
        return this.#pressKey(KEYS.right);
      default:
        if (!result.available) {
          await this.#page('Runtime.evaluate', { expression: VOLUME_FALLBACK(action), returnByValue: true }, OVERLAY_TIMEOUT_MS);
        }
        return undefined;
    }
  }

  // Edits the YouTube TV search term by replacing the #/search?q= hash in place.
  async #youtubeTvEdit(edit) {
    const evaluate = async (expression) =>
      (await this.#page('Runtime.evaluate', { expression, returnByValue: true }, OVERLAY_TIMEOUT_MS)).result?.value;
    const result = await evaluate(YOUTUBE_TV_EDIT(edit));
    if (!result?.clear) return;
    // Wait until the box shows exactly the text being deleted, then remove it key by key. A box
    // that never matches is left alone: one Backspace too many is Back in YouTube TV.
    const deadline = Date.now() + YOUTUBE_TV_CLEAR_WAIT_MS;
    let text = await evaluate(YOUTUBE_TV_BOX_TEXT);
    while (text !== result.clear && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      text = await evaluate(YOUTUBE_TV_BOX_TEXT);
    }
    if (text !== result.clear) return;
    for (let i = [...text].length; i > 0; i--) await this.#pressKey(KEYS.backspace);
  }

  #isYouTubeTv() {
    return findAppByUrl(this.#url)?.id === 'youtube' && navigationForUrl(this.#url, this.#launcherOrigin) === 'native';
  }

  // ---------------------------------------------------------------- pointer

  #pointerMove(dx, dy) {
    if (!this.connected) return;
    if (Date.now() - this.#viewportAt > VIEWPORT_REFRESH_MS) {
      this.#refreshViewport().catch(() => {});
    }
    this.#cursor = this.#clampToViewport(this.#cursor.x + dx, this.#cursor.y + dy);
    this.#moveDirty = true;
    this.#flushMove();
  }

  async #flushMove() {
    if (this.#moveInFlight) return;
    this.#moveInFlight = true;
    try {
      while (this.#moveDirty && this.connected) {
        this.#moveDirty = false;
        const { x, y } = this.#cursor;
        await Promise.all([
          this.#page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, INPUT_TIMEOUT_MS),
          this.#overlay('setCursor', x, y),
        ]).catch((err) => this.#logCdp('pointer move', err));
      }
    } finally {
      this.#moveInFlight = false;
    }
  }

  async #pointerClick() {
    const { x, y } = this.#cursor;
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.#page('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }, INPUT_TIMEOUT_MS);
    await this.#page('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, INPUT_TIMEOUT_MS);
  }

  async #pointerScroll(dx, dy) {
    const { x, y } = this.#cursor;
    await this.#page('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy }, INPUT_TIMEOUT_MS);
  }

  #setTouching(active) {
    this.#touching = active;
    if (active && !this.#edgeScrollTimer) {
      this.#edgeScrollTimer = setInterval(() => this.#edgeScrollTick(), EDGE_SCROLL_INTERVAL_MS);
    } else if (!active && this.#edgeScrollTimer) {
      clearInterval(this.#edgeScrollTimer);
      this.#edgeScrollTimer = null;
    }
  }

  // Direction of the viewport border the cursor sits on, as wheel deltas (0 when not on a border).
  #edgeScrollDelta() {
    const { width, height } = this.#viewport;
    const { x, y } = this.#cursor;
    const axis = (pos, max) => (pos <= 0 ? -EDGE_SCROLL_STEP_PX : pos >= max - 1 ? EDGE_SCROLL_STEP_PX : 0);
    return { dx: axis(x, width), dy: axis(y, height) };
  }

  async #edgeScrollTick() {
    if (!this.#touching || this.#edgeScrollInFlight || !this.connected) return;
    const { dx, dy } = this.#edgeScrollDelta();
    if (!dx && !dy) return;
    this.#edgeScrollInFlight = true;
    try {
      await this.#pointerScroll(dx, dy);
    } catch (err) {
      this.#logCdp('edge scroll', err);
    } finally {
      this.#edgeScrollInFlight = false;
    }
  }

  #clampToViewport(x, y) {
    const { width, height } = this.#viewport;
    return {
      x: Math.round(Math.min(Math.max(x, 0), width - 1) * 10) / 10,
      y: Math.round(Math.min(Math.max(y, 0), height - 1) * 10) / 10,
    };
  }

  async #refreshViewport() {
    if (!this.connected) return;
    this.#viewportAt = Date.now();
    const metrics = await this.#page('Page.getLayoutMetrics', {}, OVERLAY_TIMEOUT_MS);
    const vp = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport;
    if (!vp?.clientWidth || !vp?.clientHeight) return;
    this.#viewport = { width: vp.clientWidth, height: vp.clientHeight };
    if (!this.#viewportKnown) {
      this.#viewportKnown = true;
      this.#cursor = { x: Math.round(vp.clientWidth / 2), y: Math.round(vp.clientHeight / 2) };
    } else {
      this.#cursor = this.#clampToViewport(this.#cursor.x, this.#cursor.y);
    }
  }

  // Reads document.title directly: Chrome delays title updates in Target.targetInfoChanged.
  async #refreshTitle() {
    if (!this.connected) return;
    const { result } = await this.#page('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, OVERLAY_TIMEOUT_MS);
    const title = typeof result?.value === 'string' ? result.value : '';
    if (title && title !== this.#title) {
      this.#title = title;
      this.#emitState();
    }
  }

  // Forces a viewport refresh, for example after the window moved to another display.
  refreshViewport() {
    this.#viewportAt = 0;
    return this.#refreshViewport().catch((err) => this.#logCdp('viewport', err));
  }

  // ---------------------------------------------------------------- CDP helpers

  #page(method, params, timeoutMs) {
    if (!this.connected) return Promise.reject(new UserError('TV is not connected'));
    return this.#cdp.send(method, params, this.#sessionId, timeoutMs ? { timeoutMs } : undefined);
  }

  async #setUserAgent(userAgent) {
    if (this.#userAgent === userAgent) return;
    await this.#page('Network.setUserAgentOverride', { userAgent });
    this.#userAgent = userAgent;
  }

  // nativeVirtualKeyCode is left out on purpose: on macOS it means a Carbon key code, and
  // Windows codes there (38 is "J") leave Chrome with a key it considers held, which stalls
  // YouTube TV playback on later pages.
  async #pressKey(def) {
    const common = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
    };
    const down = def.text
      ? { ...common, type: 'keyDown', text: def.text, unmodifiedText: def.text }
      : { ...common, type: 'rawKeyDown' };
    await this.#page('Input.dispatchKeyEvent', down, INPUT_TIMEOUT_MS);
    await this.#page('Input.dispatchKeyEvent', { ...common, type: 'keyUp' }, INPUT_TIMEOUT_MS);
  }

  // Calls window.__tvStream[method](...args) in the TV page. Resolves to
  // { available, handled, value }; `available` is false when the overlay is absent or broken.
  async #overlay(method, ...args) {
    const name = JSON.stringify(method);
    const argList = args.map((arg) => JSON.stringify(arg)).join(', ');
    const expression = `(() => {
      try {
        const tv = window.__tvStream;
        if (!tv || typeof tv[${name}] !== 'function') return { missing: true };
        return { value: tv[${name}](${argList}) };
      } catch (err) {
        return { error: String(err && err.message || err) };
      }
    })()`;
    try {
      const { result, exceptionDetails } = await this.#page('Runtime.evaluate', { expression, returnByValue: true }, OVERLAY_TIMEOUT_MS);
      const value = result?.value;
      if (exceptionDetails || !value || value.missing) return { available: false, handled: false };
      if (value.error) {
        this.#log(`[tv-stream] overlay ${method} threw: ${value.error}`);
        return { available: false, handled: false };
      }
      return { available: true, handled: value.value === true, value: value.value };
    } catch (err) {
      if (err instanceof UserError) throw err;
      this.#logCdp(`overlay ${method}`, err);
      return { available: false, handled: false };
    }
  }

  #logCdp(context, err) {
    if (err instanceof UserError) return;
    this.#log(`[tv-stream] ${context}: ${err.message}`);
  }

  // ---------------------------------------------------------------- state

  #appIdFor(url) {
    return findAppByUrl(url)?.id ?? null;
  }

  #shortUrl(url) {
    return url.length > 80 ? `${url.slice(0, 77)}...` : url;
  }

  #emitState() {
    clearTimeout(this.#stateTimer);
    this.#stateTimer = setTimeout(() => {
      const state = this.state;
      const json = JSON.stringify(state);
      if (json === this.#lastStateJson) return;
      this.#lastStateJson = json;
      this.emit('state', state);
    }, STATE_DEBOUNCE_MS);
  }
}
