/*
 * Purpose: TV overlay injected into every page: highlight navigation, player mode, media keys,
 *          fake cursor and the quick menu, exposed as window.__tvStream.
 *
 * Depends on: nothing at runtime (classic script, no imports, no network). The interface and
 *             behavior follow docs/architecture.md ("Overlay interface", "Behavior rules for the
 *             overlay", "Command semantics").
 *
 * Used by: src/server/tv-controller.js, which injects this file with
 *          Page.addScriptToEvaluateOnNewDocument and calls window.__tvStream.* through
 *          Runtime.evaluate (userGesture: true). The quick menu reports back through the CDP
 *          binding window.__tvStreamSend.
 *
 * Notes:
 *  - The script runs before page scripts in every frame. Only the top frame activates, and a
 *    second evaluation is a no-op (guard on window.__tvStream.version).
 *  - YouTube and Netflix enforce Trusted Types and strict CSP, so all DOM is built with
 *    createElement, createElementNS and textContent, and styles come from a constructed
 *    stylesheet (with a <style> fallback). No innerHTML anywhere.
 *  - The host element hangs off <html>, not <body>, so sites that replace body keep it. A
 *    MutationObserver plus a 1 s health check re-attach it when it is removed anyway.
 *  - The host is a manual popover so it lives in the top layer, above element fullscreen and
 *    modal dialogs. Its inline display:block keeps it rendered even where popovers are hidden.
 *  - Netflix answers direct currentTime writes with a playback error, so seeking there goes
 *    through the Netflix player API, or returns false so the server sends real arrow keys.
 *  - Spatial navigation only runs in dpad mode on non-native pages. Player mode, media keys and
 *    the quick menu work in every mode and on every page.
 *  - Every public method is wrapped in try/catch and returns a boolean. Internal callbacks are
 *    wrapped too, so nothing ever throws into the page or its error reporting.
 */
(function tvStreamOverlay() {
  'use strict';

  // ---------------------------------------------------------------------------------------
  // Activation guards
  // ---------------------------------------------------------------------------------------

  try {
    if (window.top !== window) return;
    if (window.__tvStream && window.__tvStream.version) return;
  } catch (error) {
    return;
  }

  // ---------------------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------------------

  const VERSION = 1;
  const LAUNCHER_URL = 'http://localhost:8787/tv/';
  const MAX_Z_INDEX = '2147483647';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const SEEK_STEP_SECONDS = 10;
  const VOLUME_STEP = 0.1;
  const VOLUME_VISIBLE_MS = 1500;
  const TOAST_VISIBLE_MS = 1100;
  const CURSOR_IDLE_MS = 4000;
  const RING_MOVE_MS = 220;
  const TRACK_IDLE_FRAMES = 40;
  const HEALTH_CHECK_MS = 1000;
  const ROOTS_CACHE_MS = 400;
  const PLAYER_MIN_COVERAGE = 0.5;
  const MAX_REATTACH_PER_SECOND = 20;

  const KEYS = ['up', 'down', 'left', 'right', 'ok', 'back'];
  const ARROWS = ['up', 'down', 'left', 'right'];
  const MEDIA_ACTIONS = ['playpause', 'rewind', 'forward', 'volumeDown', 'volumeUp', 'mute'];
  const MODES = ['dpad', 'touchpad'];

  const CANDIDATE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="tab"]',
    '[role="option"]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable]:not([contenteditable="false"])',
  ].join(',');

  const TEXT_INPUT_TYPES = [
    'text', 'search', 'email', 'url', 'tel', 'password', 'number',
    'date', 'datetime-local', 'month', 'time', 'week',
  ];

  // Captured before page scripts run, so later monkey patches by the page do not affect us.
  const timers = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
  const NativeMutationObserver = window.MutationObserver;
  const stringify = JSON.stringify.bind(JSON);

  // ---------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------

  const state = {
    mode: 'dpad',
    highlighted: null,
    ringWanted: false,
    ringKey: '',
    ringMoveTimer: 0,
    trackFrame: 0,
    trackIdleFrames: 0,
    menuOpen: false,
    menuIndex: 0,
    menuEnabled: [true, false, true],
    cursor: { x: 0, y: 0, known: false },
    cursorTimer: 0,
    volumeTimer: 0,
    toastTimer: 0,
    pseudoFullscreen: null,
    lastActive: null,
    rootsCache: null,
    reattachCount: 0,
    reattachWindowStart: 0,
  };

  const ui = {
    host: null,
    shadow: null,
    ring: null,
    scrim: null,
    menu: null,
    menuItems: [],
    volume: null,
    volumeFill: null,
    volumeValue: null,
    toast: null,
    toastMain: null,
    toastSub: null,
    cursor: null,
  };

  // ---------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------

  function noop() {}

  /** Wraps a callback so an exception never reaches the page. */
  function safe(fn) {
    return function safeCallback() {
      try {
        return fn.apply(this, arguments);
      } catch (error) {
        return undefined;
      }
    };
  }

  /** Wraps a public method: always returns a boolean, never throws. */
  function publicMethod(fn) {
    return function tvStreamMethod() {
      try {
        return fn.apply(null, arguments) === true;
      } catch (error) {
        return false;
      }
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function createSvg(tag, attributes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const name of Object.keys(attributes || {})) node.setAttribute(name, attributes[name]);
    return node;
  }

  function setImportantStyles(node, styles) {
    for (const name of Object.keys(styles)) node.style.setProperty(name, styles[name], 'important');
  }

  function viewportSize() {
    return { width: window.innerWidth || 1, height: window.innerHeight || 1 };
  }

  function rectCenter(rect) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function formatTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '';
    const seconds = Math.floor(totalSeconds % 60);
    const minutes = Math.floor((totalSeconds / 60) % 60);
    const hours = Math.floor(totalSeconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(seconds) : minutes + ':' + pad(seconds);
  }

  /** Parent across shadow boundaries (element, then shadow host). */
  function composedParent(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  }

  function composedClosest(node, selector) {
    for (let current = node; current; current = composedParent(current)) {
      if (current.nodeType === 1 && current.matches(selector)) return current;
    }
    return null;
  }

  function composedContains(ancestor, node) {
    for (let current = node; current; current = composedParent(current)) {
      if (current === ancestor) return true;
    }
    return false;
  }

  function deepActiveElement() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function deepElementFromPoint(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  // ---------------------------------------------------------------------------------------
  // Page classification
  // ---------------------------------------------------------------------------------------

  function isTvPath(pathname) {
    return pathname === '/tv' || pathname.indexOf('/tv/') === 0;
  }

  /** Native pages handle arrows and OK themselves: YouTube TV and the launcher. */
  function isNativePage() {
    const host = location.hostname;
    const path = location.pathname;
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) return isTvPath(path);
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return isTvPath(path);
    return false;
  }

  function isNetflix() {
    const host = location.hostname;
    return host === 'netflix.com' || host.endsWith('.netflix.com');
  }

  // ---------------------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------------------

  const OVERLAY_CSS = `
    * { box-sizing: border-box; }
    .layer {
      position: fixed; inset: 0; pointer-events: none; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: #fff; line-height: 1.2; -webkit-font-smoothing: antialiased;
      font-size: max(16px, 2.4vh);
    }
    .panel {
      background: rgba(14, 16, 22, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: max(14px, 1.8vh);
      box-shadow: 0 2vh 6vh rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
    }

    .ring {
      position: fixed; left: 0; top: 0; width: 0; height: 0;
      border: max(3px, 0.42vh) solid #ffffff;
      border-radius: max(8px, 1vh);
      box-shadow:
        0 0 0 max(2px, 0.25vh) rgba(0, 0, 0, 0.7),
        0 0 max(18px, 2.4vh) max(4px, 0.5vh) rgba(72, 160, 255, 0.85),
        inset 0 0 0 max(2px, 0.2vh) rgba(0, 0, 0, 0.45);
      opacity: 0;
      transition: opacity 160ms ease;
      will-change: transform, width, height;
    }
    .ring.visible { opacity: 1; }
    .ring.moving {
      transition:
        opacity 160ms ease,
        transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1),
        width 140ms cubic-bezier(0.2, 0.8, 0.2, 1),
        height 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    .scrim {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
      opacity: 0; transition: opacity 180ms ease;
    }
    .scrim.visible { opacity: 1; }

    .menu {
      position: fixed; left: 50%; top: 50%;
      width: min(92vw, max(380px, 56vh));
      padding: max(18px, 2.8vh);
      opacity: 0; transform: translate(-50%, -50%) scale(0.96);
      transition: opacity 180ms ease, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .menu.open { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    .menu-title {
      font-size: max(13px, 1.9vh); font-weight: 600; letter-spacing: 0.12em;
      text-transform: uppercase; color: rgba(255, 255, 255, 0.6);
      margin: 0 0 max(10px, 1.4vh) max(4px, 0.6vh);
    }
    .menu-item {
      display: flex; align-items: center; justify-content: space-between; gap: 2vh;
      padding: max(12px, 1.8vh) max(16px, 2.4vh);
      margin-top: max(4px, 0.7vh);
      border-radius: max(10px, 1.3vh);
      font-size: max(20px, 3.2vh); font-weight: 600;
      color: rgba(255, 255, 255, 0.92);
      background: rgba(255, 255, 255, 0.06);
      transition: background 140ms ease, color 140ms ease, transform 140ms ease;
    }
    .menu-item.selected {
      background: #ffffff; color: #0b0d12; transform: scale(1.02);
      box-shadow: 0 0 max(14px, 2vh) rgba(72, 160, 255, 0.6);
    }
    .menu-item.disabled { color: rgba(255, 255, 255, 0.32); background: rgba(255, 255, 255, 0.03); }
    .menu-detail { font-size: max(13px, 1.9vh); font-weight: 500; opacity: 0.8; }
    .menu-hint {
      margin-top: max(12px, 1.8vh); text-align: center;
      font-size: max(12px, 1.7vh); color: rgba(255, 255, 255, 0.5);
    }

    .volume {
      position: fixed; top: 5vh; right: 4vw;
      display: flex; align-items: center; gap: max(12px, 1.6vh);
      padding: max(12px, 1.6vh) max(18px, 2.4vh);
      opacity: 0; transform: translateY(-1vh);
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .volume.visible { opacity: 1; transform: translateY(0); }
    .volume-icon { width: max(26px, 3.6vh); height: max(26px, 3.6vh); flex: none; }
    .volume-icon .waves, .volume-icon .slash { fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; }
    .volume-icon .slash { display: none; }
    .volume.muted .volume-icon .waves { display: none; }
    .volume.muted .volume-icon .slash { display: inline; }
    .volume-track {
      width: max(160px, 26vh); height: max(8px, 1vh); border-radius: 999px;
      background: rgba(255, 255, 255, 0.22); overflow: hidden;
    }
    .volume-fill { height: 100%; width: 0; background: #fff; border-radius: 999px; transition: width 120ms ease; }
    .volume.muted .volume-fill { background: rgba(255, 255, 255, 0.35); }
    .volume-value {
      min-width: 3.4em; text-align: right; font-size: max(18px, 2.6vh); font-weight: 700;
      font-variant-numeric: tabular-nums;
    }

    .toast {
      position: fixed; top: 6vh; left: 50%;
      display: flex; flex-direction: column; align-items: center;
      padding: max(10px, 1.4vh) max(22px, 3vh);
      opacity: 0; transform: translate(-50%, -1vh);
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toast.visible { opacity: 1; transform: translate(-50%, 0); }
    .toast-main { font-size: max(24px, 3.6vh); font-weight: 800; font-variant-numeric: tabular-nums; }
    .toast-sub { font-size: max(14px, 1.9vh); color: rgba(255, 255, 255, 0.7); font-variant-numeric: tabular-nums; }
    .toast-sub:empty { display: none; }

    .cursor {
      position: fixed; left: 0; top: 0;
      width: max(36px, 4.6vh); height: max(36px, 4.6vh);
      margin: -1px 0 0 -1px;
      opacity: 0; transition: opacity 250ms ease;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
    }
    .cursor.visible { opacity: 1; transition: opacity 80ms ease; }
    .cursor path { fill: #fff; stroke: #0b0d12; stroke-width: 1.6; stroke-linejoin: round; }
  `;

  function applyStyles(shadow) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      shadow.adoptedStyleSheets = [sheet];
      return;
    } catch (error) {
      // Constructed stylesheets unavailable: fall back to a style element.
    }
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);
  }

  // ---------------------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------------------

  function buildRing() {
    return createEl('div', 'ring');
  }

  function buildMenu() {
    const panel = createEl('div', 'panel menu');
    panel.appendChild(createEl('div', 'menu-title', 'Quick menu'));
    ui.menuItems = MENU_ITEMS.map(() => {
      const row = createEl('div', 'menu-item');
      const label = createEl('span', 'menu-label');
      const detail = createEl('span', 'menu-detail');
      row.appendChild(label);
      row.appendChild(detail);
      panel.appendChild(row);
      return { row, label, detail };
    });
    panel.appendChild(createEl('div', 'menu-hint', 'Up and down to choose, OK to select, Back to close'));
    return panel;
  }

  function buildVolume() {
    const panel = createEl('div', 'panel volume');
    const icon = createSvg('svg', { viewBox: '0 0 24 24', class: 'volume-icon', 'aria-hidden': 'true' });
    icon.appendChild(createSvg('path', { d: 'M3 9.5v5h4l5 4v-13l-5 4H3z', fill: '#fff' }));
    const waves = createSvg('g', { class: 'waves' });
    waves.appendChild(createSvg('path', { d: 'M15.5 9a4 4 0 0 1 0 6' }));
    waves.appendChild(createSvg('path', { d: 'M18 6.5a7.5 7.5 0 0 1 0 11' }));
    icon.appendChild(waves);
    const slash = createSvg('g', { class: 'slash' });
    slash.appendChild(createSvg('path', { d: 'M16 9.5l5 5M21 9.5l-5 5' }));
    icon.appendChild(slash);

    const track = createEl('div', 'volume-track');
    ui.volumeFill = createEl('div', 'volume-fill');
    track.appendChild(ui.volumeFill);
    ui.volumeValue = createEl('div', 'volume-value');

    panel.appendChild(icon);
    panel.appendChild(track);
    panel.appendChild(ui.volumeValue);
    return panel;
  }

  function buildToast() {
    const panel = createEl('div', 'panel toast');
    ui.toastMain = createEl('div', 'toast-main');
    ui.toastSub = createEl('div', 'toast-sub');
    panel.appendChild(ui.toastMain);
    panel.appendChild(ui.toastSub);
    return panel;
  }

  function buildCursor() {
    const svg = createSvg('svg', { viewBox: '0 0 24 24', class: 'cursor', 'aria-hidden': 'true' });
    svg.appendChild(createSvg('path', {
      d: 'M2 1.5 L2 19.6 L6.7 15.4 L9.7 22.3 L13 20.9 L10.1 14.2 L16.4 14.2 Z',
    }));
    return svg;
  }

  function buildHost() {
    const host = document.createElement('tv-stream-overlay');
    host.setAttribute('aria-hidden', 'true');
    setImportantStyles(host, {
      all: 'initial',
      display: 'block',
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      overflow: 'visible',
      'pointer-events': 'none',
      'z-index': MAX_Z_INDEX,
      'color-scheme': 'dark',
    });
    if (supportsPopover()) host.setAttribute('popover', 'manual');

    const shadow = host.attachShadow({ mode: 'closed' });
    applyStyles(shadow);
    const layer = createEl('div', 'layer');
    ui.ring = buildRing();
    ui.scrim = createEl('div', 'scrim');
    ui.menu = buildMenu();
    ui.volume = buildVolume();
    ui.toast = buildToast();
    ui.cursor = buildCursor();
    layer.appendChild(ui.ring);
    layer.appendChild(ui.toast);
    layer.appendChild(ui.volume);
    layer.appendChild(ui.scrim);
    layer.appendChild(ui.menu);
    layer.appendChild(ui.cursor);
    shadow.appendChild(layer);

    ui.host = host;
    ui.shadow = shadow;
  }

  // ---------------------------------------------------------------------------------------
  // Host attachment, top layer and survival
  // ---------------------------------------------------------------------------------------

  function supportsPopover() {
    return typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';
  }

  function isHostInTopLayer() {
    try {
      return ui.host.matches(':popover-open');
    } catch (error) {
      return false;
    }
  }

  /** Another top-layer element (fullscreen, modal dialog, page popover) may sit above us. */
  function topLayerMayCoverHost() {
    try {
      if (document.fullscreenElement) return true;
      if (document.querySelector(':modal')) return true;
      const open = document.querySelectorAll(':popover-open');
      for (const node of open) if (node !== ui.host) return true;
    } catch (error) {
      return false;
    }
    return false;
  }

  /** Puts the host on top of the top layer. Re-showing moves it above newer entries. */
  function raiseHost(force) {
    if (!ui.host || !ui.host.isConnected || !supportsPopover()) return;
    try {
      if (isHostInTopLayer()) {
        if (!force) return;
        ui.host.hidePopover();
      }
      ui.host.showPopover();
    } catch (error) {
      // Popover refused (e.g. document not fully active): the fixed host still renders.
    }
  }

  function raiseIfCovered() {
    raiseHost(topLayerMayCoverHost());
  }

  /** Builds the UI on first use and (re)attaches the host to <html>. */
  function ensureAttached() {
    const root = document.documentElement;
    if (!root || root.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
    if (!ui.host) buildHost();
    if (ui.host.parentNode !== root) {
      root.appendChild(ui.host);
      observeRoot(root);
      raiseHost(true);
    }
    return true;
  }

  let observedRoot = null;
  let rootObserver = null;

  function observeRoot(root) {
    if (!NativeMutationObserver || observedRoot === root) return;
    if (rootObserver) rootObserver.disconnect();
    rootObserver = new NativeMutationObserver(safe(onRootMutation));
    rootObserver.observe(root, { childList: true });
    rootObserver.observe(document, { childList: true });
    observedRoot = root;
  }

  /** Re-attaches the host when a site wipes <html> children, with a cap against fights. */
  function onRootMutation() {
    if (ui.host && ui.host.parentNode === document.documentElement) return;
    const now = Date.now();
    if (now - state.reattachWindowStart > 1000) {
      state.reattachWindowStart = now;
      state.reattachCount = 0;
    }
    state.reattachCount += 1;
    if (state.reattachCount > MAX_REATTACH_PER_SECOND) return;
    ensureAttached();
  }

  function healthCheck() {
    if (!document.documentElement) return;
    ensureAttached();
    if (!isHostInTopLayer()) raiseHost(false);
    if (state.ringWanted) {
      const target = state.highlighted;
      if (!target || !target.isConnected) {
        hideRing();
      } else if (findPlayerVideo()) {
        hideRing();
      } else if (updateRing()) {
        startTracking();
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Highlight ring
  // ---------------------------------------------------------------------------------------

  function ringPadding() {
    return Math.max(4, Math.round(viewportSize().height * 0.005));
  }

  function setRingVisible(visible) {
    if (ui.ring) ui.ring.classList.toggle('visible', visible);
    if (!visible) state.ringKey = '';
  }

  function ringShouldShow() {
    const target = state.highlighted;
    return state.ringWanted && state.mode === 'dpad' && !!target && target.isConnected && !isNativePage();
  }

  /** Positions the ring on the highlighted element. Returns true when the geometry changed. */
  function updateRing() {
    if (!ui.ring) return false;
    if (!ringShouldShow()) {
      setRingVisible(false);
      return false;
    }
    const rect = state.highlighted.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) {
      setRingVisible(false);
      return false;
    }
    const pad = ringPadding();
    const x = Math.round((rect.left - pad) * 2) / 2;
    const y = Math.round((rect.top - pad) * 2) / 2;
    const width = Math.round((rect.width + pad * 2) * 2) / 2;
    const height = Math.round((rect.height + pad * 2) * 2) / 2;
    const key = x + ',' + y + ',' + width + ',' + height;
    if (key === state.ringKey) return false;
    state.ringKey = key;
    ui.ring.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    ui.ring.style.width = width + 'px';
    ui.ring.style.height = height + 'px';
    setRingVisible(true);
    return true;
  }

  function matchRingRadius(target) {
    let radius = 0;
    try {
      radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
    } catch (error) {
      radius = 0;
    }
    ui.ring.style.borderRadius = Math.max(8, radius + ringPadding()) + 'px';
  }

  /** Follows the element with requestAnimationFrame until it stops moving. */
  function startTracking() {
    state.trackIdleFrames = 0;
    if (!state.trackFrame) state.trackFrame = timers.requestAnimationFrame(trackStep);
  }

  const trackStep = safe(function trackStep() {
    state.trackFrame = 0;
    if (!ringShouldShow()) {
      setRingVisible(false);
      return;
    }
    state.trackIdleFrames = updateRing() ? 0 : state.trackIdleFrames + 1;
    if (state.trackIdleFrames < TRACK_IDLE_FRAMES) {
      state.trackFrame = timers.requestAnimationFrame(trackStep);
    }
  });

  function animateRingMove() {
    ui.ring.classList.add('moving');
    timers.clearTimeout(state.ringMoveTimer);
    state.ringMoveTimer = timers.setTimeout(safe(() => ui.ring.classList.remove('moving')), RING_MOVE_MS);
  }

  function hideRing() {
    state.ringWanted = false;
    setRingVisible(false);
  }

  function showRingFor(target, animate) {
    state.ringWanted = true;
    matchRingRadius(target);
    if (animate && ui.ring.classList.contains('visible')) animateRingMove();
    raiseIfCovered();
    updateRing();
    startTracking();
  }

  const onViewportChange = safe(function onViewportChange() {
    if (state.ringWanted) startTracking();
  });

  /** Follows focus the site moves itself (e.g. a dialog focusing its first button). */
  const onFocusIn = safe(function onFocusIn(event) {
    if (!state.ringWanted || state.mode !== 'dpad' || isNativePage()) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path[0] || event.target;
    if (!target || target.nodeType !== 1 || target === state.highlighted) return;
    if (!target.matches(CANDIDATE_SELECTOR)) return;
    state.highlighted = target;
    state.lastActive = target;
    showRingFor(target, true);
  });

  // ---------------------------------------------------------------------------------------
  // Candidate discovery
  // ---------------------------------------------------------------------------------------

  /** Document plus every open shadow root, cached briefly because a key press queries twice. */
  function getSearchRoots() {
    const now = Date.now();
    if (state.rootsCache && now - state.rootsCache.time < ROOTS_CACHE_MS) return state.rootsCache.roots;
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      const all = roots[i].querySelectorAll('*');
      for (let j = 0; j < all.length; j++) {
        const shadowRoot = all[j].shadowRoot;
        if (shadowRoot) roots.push(shadowRoot);
      }
    }
    state.rootsCache = { time: now, roots };
    return roots;
  }

  function queryAllDeep(selector) {
    const result = [];
    for (const root of getSearchRoots()) {
      const found = root.querySelectorAll(selector);
      for (let i = 0; i < found.length; i++) result.push(found[i]);
    }
    return result;
  }

  function isDisabled(node) {
    if (node.getAttribute('aria-disabled') === 'true') return true;
    try {
      return node.matches(':disabled');
    } catch (error) {
      return false;
    }
  }

  function isRenderedVisible(node) {
    if (typeof node.checkVisibility === 'function') {
      return node.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        opacityProperty: true,
        visibilityProperty: true,
      });
    }
    const style = getComputedStyle(node);
    return style.visibility === 'visible' && parseFloat(style.opacity) > 0;
  }

  /** True when an ancestor (not html/body) can scroll on the axis, e.g. a carousel row. */
  function hasScrollableAncestor(node, axis) {
    for (let current = composedParent(node); current; current = composedParent(current)) {
      if (current === document.body || current === document.documentElement) return false;
      const style = getComputedStyle(current);
      const overflow = axis === 'x' ? style.overflowX : style.overflowY;
      if (overflow === 'visible' || overflow === 'clip') continue;
      const scrollable = axis === 'x'
        ? current.scrollWidth > current.clientWidth + 1
        : current.scrollHeight > current.clientHeight + 1;
      if (scrollable) return true;
    }
    return false;
  }

  /**
   * The rect must intersect the document. Elements outside it (skip links, off-canvas drawers)
   * only count when a scroll container can bring them in, which keeps carousel items reachable.
   */
  function isInsideDocument(node, rect) {
    const root = document.documentElement;
    const viewport = viewportSize();
    const docWidth = Math.max(root.scrollWidth, viewport.width);
    const docHeight = Math.max(root.scrollHeight, viewport.height);
    const left = rect.left + window.scrollX;
    const top = rect.top + window.scrollY;
    const outsideX = left + rect.width <= 0 || left >= docWidth;
    const outsideY = top + rect.height <= 0 || top >= docHeight;
    if (outsideX && !hasScrollableAncestor(node, 'x')) return false;
    if (outsideY && !hasScrollableAncestor(node, 'y')) return false;
    return true;
  }

  function measureCandidate(node, scope) {
    if (node === ui.host) return null;
    if (scope && !composedContains(scope, node)) return null;
    if (isDisabled(node)) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    if (!isInsideDocument(node, rect)) return null;
    if (!isRenderedVisible(node)) return null;
    if (composedClosest(node, '[aria-hidden="true"],[inert]')) return null;
    return { el: node, rect };
  }

  /** The topmost open modal restricts navigation to its contents. */
  function findModalScope() {
    let modals;
    try {
      modals = document.querySelectorAll('dialog:modal, [aria-modal="true"]');
    } catch (error) {
      modals = document.querySelectorAll('dialog[open], [aria-modal="true"]');
    }
    for (let i = modals.length - 1; i >= 0; i--) {
      const modal = modals[i];
      const rect = modal.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && isRenderedVisible(modal)) return modal;
    }
    return null;
  }

  function collectCandidates() {
    const nodes = queryAllDeep(CANDIDATE_SELECTOR);
    const scope = findModalScope();
    const measure = (useScope) => {
      const list = [];
      for (const node of nodes) {
        const candidate = measureCandidate(node, useScope);
        if (candidate) list.push(candidate);
      }
      return list;
    };
    const scoped = measure(scope);
    return scoped.length > 0 || !scope ? scoped : measure(null);
  }

  // ---------------------------------------------------------------------------------------
  // Spatial navigation
  // ---------------------------------------------------------------------------------------

  /**
   * Direction-weighted distance. Only candidates whose center lies in the half-plane of the
   * direction count. Score = edge gap on the primary axis + 2 * edge gap on the orthogonal axis
   * (zero when the rects overlap there, which is how overlapping candidates win), plus small
   * center terms that break ties between aligned candidates. Returns { score, inCone } or null.
   */
  function directionalScore(from, to, direction) {
    const fromCenter = rectCenter(from);
    const toCenter = rectCenter(to);
    const horizontal = direction === 'left' || direction === 'right';
    const sign = direction === 'right' || direction === 'down' ? 1 : -1;
    const primaryCenter = (horizontal ? toCenter.x - fromCenter.x : toCenter.y - fromCenter.y) * sign;
    if (primaryCenter <= 1) return null;

    let primaryGap;
    if (direction === 'right') primaryGap = to.left - from.right;
    else if (direction === 'left') primaryGap = from.left - to.right;
    else if (direction === 'down') primaryGap = to.top - from.bottom;
    else primaryGap = from.top - to.bottom;
    primaryGap = Math.max(0, primaryGap);

    const orthoGap = horizontal
      ? Math.max(0, Math.max(from.top, to.top) - Math.min(from.bottom, to.bottom))
      : Math.max(0, Math.max(from.left, to.left) - Math.min(from.right, to.right));
    const orthoCenter = Math.abs(horizontal ? toCenter.y - fromCenter.y : toCenter.x - fromCenter.x);

    // Diagonal candidates outside a 45 degree cone only count as a fallback (see
    // findBestInDirection). Left and right also stay within one element height of the
    // current row, so "right" never jumps to a far away row.
    const rowLimit = horizontal ? Math.max(from.height, to.height) : Infinity;
    const inCone = orthoGap <= primaryCenter && orthoGap <= rowLimit;

    // A diagonal candidate must lie mostly beyond the leading edge, otherwise a scrolled row
    // below would count as "left" of an item above it.
    if (orthoGap > 0 && primaryGap === 0) {
      const tolerance = 0.3 * Math.min(horizontal ? from.width : from.height, horizontal ? to.width : to.height);
      let edgeOverlap;
      if (direction === 'right') edgeOverlap = from.right - to.left;
      else if (direction === 'left') edgeOverlap = to.right - from.left;
      else if (direction === 'down') edgeOverlap = from.bottom - to.top;
      else edgeOverlap = to.bottom - from.top;
      if (edgeOverlap > tolerance) return null;
    }

    return { score: primaryGap + 2 * orthoGap + 0.25 * orthoCenter + 0.05 * primaryCenter, inCone };
  }

  function pickLowestScore(scored) {
    let best = null;
    for (const entry of scored) {
      const clearlyBetter = !best || entry.score < best.score - 0.5;
      // Equal score and nested: prefer the inner element (usually the real link).
      const nestedTie = best && Math.abs(entry.score - best.score) <= 0.5 && composedContains(best.candidate.el, entry.candidate.el);
      if (clearlyBetter || nestedTie) best = entry;
    }
    return best ? best.candidate : null;
  }

  /**
   * Candidates inside the cone win. Up and down fall back to anything in the half-plane (a nav
   * bar far to the left of a row is still "up"); left and right never leave the cone.
   */
  function findBestInDirection(fromEl, fromRect, direction, candidates) {
    const inCone = [];
    const outOfCone = [];
    for (const candidate of candidates) {
      if (candidate.el === fromEl) continue;
      const result = directionalScore(fromRect, candidate.rect, direction);
      if (!result) continue;
      (result.inCone ? inCone : outOfCone).push({ candidate, score: result.score });
    }
    if (inCone.length > 0) return pickLowestScore(inCone);
    const vertical = direction === 'up' || direction === 'down';
    return vertical ? pickLowestScore(outOfCone) : null;
  }

  function intersectsViewport(rect) {
    const viewport = viewportSize();
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewport.width && rect.top < viewport.height;
  }

  /** First highlight: the focused element if it is a visible candidate, else nearest the center. */
  function findInitialCandidate(candidates) {
    const active = deepActiveElement();
    if (active && active !== document.body) {
      const match = candidates.find((candidate) => candidate.el === active);
      if (match && intersectsViewport(match.rect)) return match;
    }
    const viewport = viewportSize();
    const centerX = viewport.width / 2;
    const centerY = viewport.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const center = rectCenter(candidate.rect);
      const offscreenPenalty = intersectsViewport(candidate.rect) ? 0 : 1e6;
      const distance = Math.hypot(center.x - centerX, center.y - centerY) + offscreenPenalty;
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  function hasUsableHighlight() {
    const target = state.highlighted;
    if (!target || !target.isConnected) return false;
    const rect = target.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }

  function highlight(target) {
    const animate = state.highlighted !== null && state.highlighted !== target;
    state.highlighted = target;
    try {
      target.focus({ preventScroll: true });
    } catch (error) {
      // Not focusable: the ring still marks it.
    }
    state.lastActive = deepActiveElement();
    try {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    } catch (error) {
      target.scrollIntoView();
    }
    showRingFor(target, animate);
  }

  /**
   * Adopts focus the site moved since our last highlight. Focus events are not delivered while
   * the window lacks system focus, so this key-time check backs up the focusin listener.
   */
  function adoptSiteFocus() {
    const active = deepActiveElement();
    if (!state.highlighted || !active || active === state.lastActive || active === state.highlighted) return;
    state.lastActive = active;
    if (active.matches(CANDIDATE_SELECTOR) && measureCandidate(active, null)) state.highlighted = active;
  }

  function moveHighlight(direction) {
    const candidates = collectCandidates();
    if (candidates.length === 0) return false;
    adoptSiteFocus();
    if (!hasUsableHighlight()) {
      const initial = findInitialCandidate(candidates);
      if (!initial) return false;
      highlight(initial.el);
      return true;
    }
    const fromRect = state.highlighted.getBoundingClientRect();
    const best = findBestInDirection(state.highlighted, fromRect, direction, candidates);
    if (!best) {
      // Nothing in that direction: let the real key through (page scroll, site carousels).
      showRingFor(state.highlighted, false);
      return false;
    }
    highlight(best.el);
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // Activation (OK on a highlighted element)
  // ---------------------------------------------------------------------------------------

  function isTextEntry(node) {
    const tag = node.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return TEXT_INPUT_TYPES.indexOf((node.type || 'text').toLowerCase()) !== -1;
    return node.isContentEditable === true;
  }

  function dispatchPointerSequence(target, x, y) {
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0,
    };
    const pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 }, base);
    const HasPointerEvent = typeof PointerEvent === 'function';
    if (HasPointerEvent) target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ buttons: 1 }, pointer)));
    target.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1, detail: 1 }, base)));
    if (HasPointerEvent) target.dispatchEvent(new PointerEvent('pointerup', Object.assign({ buttons: 0 }, pointer)));
    target.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0, detail: 1 }, base)));
    target.dispatchEvent(new MouseEvent('click', Object.assign({ buttons: 0, detail: 1 }, base)));
  }

  /** Clicks at the element center. The hit-tested child receives it so site handlers bubble normally. */
  function clickElement(node) {
    const rect = node.getBoundingClientRect();
    const viewport = viewportSize();
    const x = clamp(rect.left + rect.width / 2, 0, viewport.width - 1);
    const y = clamp(rect.top + rect.height / 2, 0, viewport.height - 1);
    const hit = deepElementFromPoint(x, y);
    const target = hit && composedContains(node, hit) ? hit : node;
    dispatchPointerSequence(target, x, y);
  }

  function activate(node) {
    try {
      node.focus({ preventScroll: true });
    } catch (error) {
      // Ignore: clicking still works.
    }
    if (isTextEntry(node)) return true;
    if (node.tagName === 'SELECT') {
      try {
        node.showPicker();
      } catch (error) {
        // Picker unavailable: focus is enough for keyboard selection.
      }
      return true;
    }
    clickElement(node);
    return true;
  }

  function handleSpatialKey(key) {
    if (key === 'ok') {
      adoptSiteFocus();
      if (!hasUsableHighlight()) return moveHighlight('down');
      showRingFor(state.highlighted, false);
      return activate(state.highlighted);
    }
    return moveHighlight(key);
  }

  // ---------------------------------------------------------------------------------------
  // Video discovery
  // ---------------------------------------------------------------------------------------

  function hasMedia(video) {
    return video.readyState >= 1 || !!video.currentSrc || !!video.srcObject;
  }

  function visibleArea(rect) {
    const viewport = viewportSize();
    const width = Math.min(rect.right, viewport.width) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0);
    return width > 0 && height > 0 ? width * height : 0;
  }

  /** Videos with media, largest visible area first. */
  function rankedVideos() {
    const ranked = [];
    for (const video of queryAllDeep('video')) {
      if (!hasMedia(video)) continue;
      const area = visibleArea(video.getBoundingClientRect());
      if (area > 0) ranked.push({ video, area });
    }
    ranked.sort((a, b) => b.area - a.area);
    return ranked;
  }

  /** Player mode video: the largest one covering more than half of the viewport. */
  function findPlayerVideo() {
    const ranked = rankedVideos();
    if (ranked.length === 0) return null;
    const viewport = viewportSize();
    const coverage = ranked[0].area / (viewport.width * viewport.height);
    return coverage > PLAYER_MIN_COVERAGE ? ranked[0].video : null;
  }

  /** Media keys use the player video, else the largest visible video on the page. */
  function findControllableVideo() {
    const ranked = rankedVideos();
    return ranked.length > 0 ? ranked[0].video : null;
  }

  // ---------------------------------------------------------------------------------------
  // Transient indicators (volume bar, toast)
  // ---------------------------------------------------------------------------------------

  function showTransient(node, timerName, durationMs) {
    raiseIfCovered();
    node.classList.add('visible');
    timers.clearTimeout(state[timerName]);
    state[timerName] = timers.setTimeout(safe(() => node.classList.remove('visible')), durationMs);
  }

  function showToast(main, sub) {
    if (!ensureAttached()) return;
    ui.toastMain.textContent = main;
    ui.toastSub.textContent = sub || '';
    showTransient(ui.toast, 'toastTimer', TOAST_VISIBLE_MS);
  }

  function showVolume(video) {
    if (!ensureAttached()) return;
    const percent = Math.round(video.volume * 100);
    ui.volume.classList.toggle('muted', video.muted);
    ui.volumeFill.style.width = percent + '%';
    ui.volumeValue.textContent = video.muted ? 'Muted' : String(percent);
    showTransient(ui.volume, 'volumeTimer', VOLUME_VISIBLE_MS);
  }

  function timeLabel(position, duration) {
    const now = formatTime(position);
    const total = formatTime(duration);
    if (!now) return '';
    return total ? now + ' / ' + total : now;
  }

  // ---------------------------------------------------------------------------------------
  // Playback control
  // ---------------------------------------------------------------------------------------

  function togglePlay(video) {
    if (video.paused || video.ended) {
      const promise = video.play();
      if (promise && typeof promise.catch === 'function') promise.catch(noop);
      showToast('Play', timeLabel(video.currentTime, video.duration));
    } else {
      video.pause();
      showToast('Paused', timeLabel(video.currentTime, video.duration));
    }
    return true;
  }

  /** Netflix seeks through its own player API; direct currentTime writes break playback there. */
  function netflixSeek(deltaSeconds) {
    const netflix = window.netflix;
    const appState = netflix && netflix.appContext && netflix.appContext.state;
    const api = appState && appState.playerApp && appState.playerApp.getAPI && appState.playerApp.getAPI();
    const videoPlayer = api && api.videoPlayer;
    if (!videoPlayer) return null;
    const sessionIds = videoPlayer.getAllPlayerSessionIds() || [];
    const sessionId = sessionIds.find((id) => String(id).indexOf('watch') === 0) || sessionIds[sessionIds.length - 1];
    const player = sessionId && videoPlayer.getVideoPlayerBySessionId(sessionId);
    if (!player) return null;
    const durationMs = player.getDuration();
    const targetMs = clamp(player.getCurrentTime() + deltaSeconds * 1000, 0, durationMs || Infinity);
    player.seek(targetMs);
    return { position: targetMs / 1000, duration: durationMs / 1000 };
  }

  function seekVideo(video, deltaSeconds) {
    let result;
    if (isNetflix()) {
      try {
        result = netflixSeek(deltaSeconds);
      } catch (error) {
        result = null;
      }
      if (!result) return false;
    } else {
      const duration = video.duration;
      const max = Number.isFinite(duration) ? duration : Infinity;
      const target = clamp(video.currentTime + deltaSeconds, 0, max);
      video.currentTime = target;
      result = { position: target, duration };
    }
    const label = (deltaSeconds > 0 ? '+' : '-') + Math.abs(deltaSeconds) + ' s';
    showToast(label, timeLabel(result.position, result.duration));
    return true;
  }

  function changeVolume(video, delta) {
    const next = clamp(Math.round((video.volume + delta) * 10) / 10, 0, 1);
    video.volume = next;
    if (delta > 0 && video.muted) video.muted = false;
    showVolume(video);
    return true;
  }

  function toggleMute(video) {
    video.muted = !video.muted;
    showVolume(video);
    return true;
  }

  /** Wakes the site's player controls: mousemove on whatever sits on top of the video. */
  function nudgeControls(video) {
    const rect = video.getBoundingClientRect();
    const viewport = viewportSize();
    const x = clamp(rect.left + rect.width / 2, 0, viewport.width - 1);
    const y = clamp(rect.top + rect.height * 0.6, 0, viewport.height - 1);
    const target = deepElementFromPoint(x, y) || video;
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointermove', Object.assign({ pointerType: 'mouse', isPrimary: true }, init)));
    }
    target.dispatchEvent(new MouseEvent('mousemove', init));
    if (target !== video) video.dispatchEvent(new MouseEvent('mousemove', init));
    return true;
  }

  function handlePlayerKey(key, video) {
    hideRing();
    if (key === 'left') return seekVideo(video, -SEEK_STEP_SECONDS);
    if (key === 'right') return seekVideo(video, SEEK_STEP_SECONDS);
    if (key === 'ok') return togglePlay(video);
    return nudgeControls(video);
  }

  function runMediaAction(action) {
    const video = findPlayerVideo() || findControllableVideo();
    if (!video) return false;
    switch (action) {
      case 'playpause': return togglePlay(video);
      case 'rewind': return seekVideo(video, -SEEK_STEP_SECONDS);
      case 'forward': return seekVideo(video, SEEK_STEP_SECONDS);
      case 'volumeUp': return changeVolume(video, VOLUME_STEP);
      case 'volumeDown': return changeVolume(video, -VOLUME_STEP);
      case 'mute': return toggleMute(video);
      default: return false;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Fullscreen
  // ---------------------------------------------------------------------------------------

  function isFullscreenActive() {
    return !!document.fullscreenElement || !!state.pseudoFullscreen;
  }

  /** The outermost ancestor that is still about the video's size: keeps site controls visible. */
  function fullscreenTargetFor(video) {
    const videoRect = video.getBoundingClientRect();
    const videoArea = Math.max(1, videoRect.width * videoRect.height);
    let target = video;
    for (let node = composedParent(video); node; node = composedParent(node)) {
      if (node === document.body || node === document.documentElement) break;
      const rect = node.getBoundingClientRect();
      if (rect.width * rect.height > videoArea * 1.5) break;
      target = node;
    }
    return target;
  }

  /** CSS fallback when requestFullscreen is refused: fixed to the viewport, promoted to the top layer. */
  function enterPseudoFullscreen(target) {
    if (state.pseudoFullscreen) return;
    const saved = { target, cssText: target.style.cssText, addedPopover: false };
    setImportantStyles(target, {
      position: 'fixed', inset: '0', top: '0', left: '0', right: '0', bottom: '0',
      width: '100vw', height: '100vh', 'max-width': 'none', 'max-height': 'none',
      margin: '0', padding: '0', border: '0', overflow: 'hidden',
      transform: 'none', background: '#000', 'z-index': '2147483646',
    });
    if (target.tagName === 'VIDEO') target.style.setProperty('object-fit', 'contain', 'important');
    if (supportsPopover() && !target.hasAttribute('popover')) {
      try {
        target.setAttribute('popover', 'manual');
        target.showPopover();
        saved.addedPopover = true;
      } catch (error) {
        target.removeAttribute('popover');
      }
    }
    state.pseudoFullscreen = saved;
    raiseHost(true);
  }

  function exitPseudoFullscreen() {
    const saved = state.pseudoFullscreen;
    if (!saved) return;
    state.pseudoFullscreen = null;
    if (saved.addedPopover) {
      try {
        saved.target.hidePopover();
      } catch (error) {
        // Already hidden.
      }
      saved.target.removeAttribute('popover');
    }
    saved.target.style.cssText = saved.cssText;
  }

  function exitFullscreen() {
    if (document.fullscreenElement) {
      try {
        const promise = document.exitFullscreen();
        if (promise && typeof promise.catch === 'function') promise.catch(noop);
      } catch (error) {
        // Ignore: nothing more we can do.
      }
      return true;
    }
    if (state.pseudoFullscreen) {
      exitPseudoFullscreen();
      return true;
    }
    return false;
  }

  function enterFullscreen(video) {
    const target = fullscreenTargetFor(video);
    if (typeof target.requestFullscreen !== 'function') {
      enterPseudoFullscreen(target);
      return true;
    }
    try {
      const promise = target.requestFullscreen({ navigationUI: 'hide' });
      if (promise && typeof promise.catch === 'function') {
        promise.catch(safe(() => enterPseudoFullscreen(target)));
      }
    } catch (error) {
      enterPseudoFullscreen(target);
    }
    return true;
  }

  function toggleFullscreen() {
    if (isFullscreenActive()) return exitFullscreen();
    const video = findPlayerVideo() || findControllableVideo();
    if (!video) return false;
    return enterFullscreen(video);
  }

  const onFullscreenChange = safe(function onFullscreenChange() {
    if (document.fullscreenElement && state.pseudoFullscreen) exitPseudoFullscreen();
    raiseHost(true);
    if (state.ringWanted) startTracking();
  });

  // ---------------------------------------------------------------------------------------
  // Quick menu
  // ---------------------------------------------------------------------------------------

  const MENU_ITEMS = [
    { id: 'reload', label: () => 'Reload page', detail: () => '' },
    {
      id: 'fullscreen',
      label: () => (isFullscreenActive() ? 'Fullscreen video off' : 'Fullscreen video on'),
      detail: (enabled) => (enabled ? '' : 'No video'),
    },
    { id: 'home', label: () => 'Back to home', detail: () => '' },
  ];

  function renderMenu() {
    MENU_ITEMS.forEach((item, index) => {
      const view = ui.menuItems[index];
      const enabled = state.menuEnabled[index];
      view.label.textContent = item.label();
      view.detail.textContent = item.detail(enabled);
      view.row.classList.toggle('disabled', !enabled);
      view.row.classList.toggle('selected', index === state.menuIndex);
    });
  }

  function openMenu() {
    if (!ensureAttached()) return false;
    const hasVideo = isFullscreenActive() || !!findControllableVideo();
    state.menuEnabled = [true, hasVideo, true];
    state.menuIndex = 0;
    state.menuOpen = true;
    renderMenu();
    raiseIfCovered();
    ui.scrim.classList.add('visible');
    ui.menu.classList.add('open');
    return true;
  }

  function closeMenu() {
    state.menuOpen = false;
    if (ui.menu) ui.menu.classList.remove('open');
    if (ui.scrim) ui.scrim.classList.remove('visible');
    return true;
  }

  function moveMenuSelection(step) {
    const count = MENU_ITEMS.length;
    let index = state.menuIndex;
    for (let i = 0; i < count; i++) {
      index = (index + step + count) % count;
      if (state.menuEnabled[index]) break;
    }
    state.menuIndex = index;
    renderMenu();
    return true;
  }

  /** Sends an action to the server binding, or falls back to doing it in the page. */
  function sendToServer(action) {
    const send = window.__tvStreamSend;
    if (typeof send === 'function') {
      send(stringify({ action }));
      return true;
    }
    if (action === 'reload') location.reload();
    else if (action === 'home') location.href = LAUNCHER_URL;
    return true;
  }

  function runMenuItem() {
    const index = state.menuIndex;
    if (!state.menuEnabled[index]) return true;
    const id = MENU_ITEMS[index].id;
    closeMenu();
    if (id === 'reload') return sendToServer('reload');
    if (id === 'home') return sendToServer('home');
    toggleFullscreen();
    return true;
  }

  function handleMenuKey(key) {
    if (key === 'back') return closeMenu();
    if (key === 'up') return moveMenuSelection(-1);
    if (key === 'down') return moveMenuSelection(1);
    if (key === 'ok') return runMenuItem();
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // Cursor
  // ---------------------------------------------------------------------------------------

  function hideCursor() {
    timers.clearTimeout(state.cursorTimer);
    if (ui.cursor) ui.cursor.classList.remove('visible');
  }

  function showCursor() {
    if (!state.cursor.known || !ensureAttached()) return;
    ui.cursor.style.transform = 'translate3d(' + state.cursor.x + 'px,' + state.cursor.y + 'px,0)';
    if (!ui.cursor.classList.contains('visible')) raiseIfCovered();
    ui.cursor.classList.add('visible');
    timers.clearTimeout(state.cursorTimer);
    state.cursorTimer = timers.setTimeout(safe(hideCursor), CURSOR_IDLE_MS);
  }

  // ---------------------------------------------------------------------------------------
  // Public API implementations
  // ---------------------------------------------------------------------------------------

  function handleKey(key) {
    if (KEYS.indexOf(key) === -1) return false;
    ensureAttached();
    if (state.menuOpen) return handleMenuKey(key);
    if (key === 'back') return exitFullscreen();
    if (isNativePage()) return false;
    const video = findPlayerVideo();
    if (video) return handlePlayerKey(key, video);
    if (state.mode !== 'dpad') return false;
    return handleSpatialKey(key);
  }

  function media(action) {
    if (MEDIA_ACTIONS.indexOf(action) === -1) return false;
    return runMediaAction(action);
  }

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) return false;
    state.mode = mode;
    ensureAttached();
    if (mode === 'touchpad') {
      setRingVisible(false);
      showCursor();
      return true;
    }
    hideCursor();
    if (hasUsableHighlight() && !isNativePage() && !findPlayerVideo()) {
      showRingFor(state.highlighted, false);
    }
    return true;
  }

  function setCursor(x, y) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
    state.cursor = { x: nx, y: ny, known: true };
    if (state.mode === 'touchpad') showCursor();
    return true;
  }

  function toggleMenu() {
    return state.menuOpen ? closeMenu() : openMenu();
  }

  // ---------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------

  const api = Object.freeze({
    version: VERSION,
    handleKey: publicMethod(handleKey),
    media: publicMethod(media),
    setMode: publicMethod(setMode),
    setCursor: publicMethod(setCursor),
    toggleMenu: publicMethod(toggleMenu),
  });

  try {
    Object.defineProperty(window, '__tvStream', {
      value: api, configurable: false, enumerable: false, writable: false,
    });
  } catch (error) {
    return;
  }

  try {
    const attachSoon = safe(ensureAttached);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachSoon, { once: true });
    } else {
      attachSoon();
    }
    window.addEventListener('load', attachSoon, { once: true });
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('focusin', onFocusIn, true);
    timers.setInterval(safe(healthCheck), HEALTH_CHECK_MS);
  } catch (error) {
    // Boot failures leave the API in place; every method re-attaches lazily.
  }
})();
