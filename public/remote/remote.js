/*
  Purpose: Phone remote behavior: WebSocket connection, buttons with auto-repeat, mode switch,
           touchpad gestures, live typing and the open-link sheet.
  Depends on: /remote/index.html (element ids, data-key / data-media / data-repeat attributes),
              /remote/remote.css (state classes), server WebSocket /ws and GET /api/apps
              (message formats in docs/architecture.md).
  Used by: /remote/index.html.
  Notes:
    - Messages are dropped while disconnected instead of queued: replaying stale key presses after
      a reconnect would move the TV unexpectedly.
    - Buttons fire on pointerdown for low latency. Keyboard and Link act on click instead, because
      iOS only opens the on-screen keyboard when focus() runs inside a click/touchend handler.
    - Touchpad deltas are accumulated per pointer event (with acceleration) and flushed at most
      once per animation frame, so the server never receives more than ~60 moves per second.
    - The touchpad scroll strips (right and bottom) are deliberately not drawn on the pad.
    - Typing is diffed against the previous input value (common prefix), which turns iOS
      autocorrect and predictive replacements into backspaces plus an insert.
*/
(function () {
  "use strict";

  // ---- tuning ----
  var RECONNECT_BASE_MS = 300;
  var RECONNECT_MAX_MS = 3000;
  var STALE_AFTER_HIDDEN_MS = 20000;
  var REPEAT_DELAY_MS = 400;
  var REPEAT_INTERVAL_MS = 120;
  var POINTER_BASE_GAIN = 2;
  var SCROLL_GAIN = 2.2;
  var SCROLL_STRIP_FRACTION = 0.15;
  var TAP_MAX_MS = 280;
  var TAP_MAX_TRAVEL_PX = 10;
  var TYPING_RESET_LENGTH = 200;
  var TOAST_MS = 2600;

  var FALLBACK_APP_NAMES = {
    netflix: "Netflix",
    youtube: "YouTube",
    prime: "Prime Video",
    disney: "Disney+",
    hbomax: "HBO Max"
  };

  // ---- elements ----
  var $ = function (id) { return document.getElementById(id); };
  var modeSwitch = $("modeSwitch");
  var connDot = $("connDot");
  var nowPlaying = $("nowPlaying");
  var dpad = $("dpad");
  var touchpad = $("touchpad");
  var keyboardBtn = $("keyboardBtn");
  var linkBtn = $("linkBtn");
  var typingBar = $("typingBar");
  var typingInput = $("typingInput");
  var typingDone = $("typingDone");
  var sheet = $("linkSheet");
  var sheetBackdrop = $("sheetBackdrop");
  var linkInput = $("linkInput");
  var linkCancel = $("linkCancel");
  var toastEl = $("toast");

  // ---- shared state ----
  var socket = null;
  var connected = false;
  var everConnected = false;
  var reconnectAttempt = 0;
  var reconnectTimer = null;
  var hiddenAt = 0;
  var tvState = null;
  var mode = "dpad";
  var appNames = Object.assign({}, FALLBACK_APP_NAMES);

  function haptic() {
    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch (err) { /* not supported */ }
    }
  }

  // ================= Connection =================

  function socketUrl() {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    var ws;
    try {
      ws = new WebSocket(socketUrl());
    } catch (err) {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = function () {
      if (socket !== ws) return;
      connected = true;
      everConnected = true;
      reconnectAttempt = 0;
      renderConnection();
    };
    ws.onmessage = function (event) {
      if (socket !== ws) return;
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "state") onState(msg);
      else if (msg.type === "error") showToast(String(msg.message || "Something went wrong"), true);
    };
    ws.onclose = function () {
      if (socket !== ws) return;
      socket = null;
      connected = false;
      renderConnection();
      scheduleReconnect();
    };
    ws.onerror = function () {
      // onclose follows and handles the reconnect.
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // Drop the current socket (it may be dead after the phone slept) and connect again right away.
  function recycleConnection() {
    var old = socket;
    socket = null;
    connected = false;
    if (old) {
      try { old.close(); } catch (err) { /* already closed */ }
    }
    reconnectAttempt = 0;
    renderConnection();
    connect();
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      return false;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      stopAllRepeats();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > STALE_AFTER_HIDDEN_MS) recycleConnection();
    else connect();
    hiddenAt = 0;
  });
  window.addEventListener("online", connect);
  window.addEventListener("pageshow", connect);

  // ================= State rendering =================

  function onState(state) {
    tvState = state;
    if (state.mode === "dpad" || state.mode === "touchpad") applyMode(state.mode);
    renderNowPlaying();
  }

  function renderConnection() {
    connDot.classList.toggle("is-connected", connected);
    connDot.setAttribute("aria-label", connected ? "Connected" : "Disconnected");
    renderNowPlaying();
  }

  function renderNowPlaying() {
    var text;
    if (!connected) {
      text = everConnected ? "Not connected, retrying…" : "Connecting…";
    } else if (!tvState) {
      text = "Connected";
    } else if (tvState.tvConnected === false) {
      text = "TV is not available";
    } else if (!tvState.appId) {
      text = tvState.title && tvState.title !== "TV Stream" ? tvState.title : "Home";
    } else {
      var name = appNames[tvState.appId] || tvState.appId;
      var title = typeof tvState.title === "string" ? tvState.title.trim() : "";
      text = title && title.toLowerCase().indexOf(name.toLowerCase()) === -1 ? name + " · " + title : title || name;
    }
    if (nowPlaying.textContent !== text) nowPlaying.textContent = text;
  }

  function loadAppNames() {
    fetch("/api/apps", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (list) {
        if (!Array.isArray(list)) return;
        list.forEach(function (app) {
          if (app && typeof app.id === "string" && typeof app.name === "string") appNames[app.id] = app.name;
        });
        renderNowPlaying();
      })
      .catch(function () { /* fallback names stay */ });
  }

  // ================= Mode switch =================

  function applyMode(next) {
    if (next === mode) return;
    mode = next;
    modeSwitch.dataset.mode = mode;
    Array.prototype.forEach.call(modeSwitch.querySelectorAll(".segment"), function (seg) {
      seg.setAttribute("aria-checked", seg.dataset.mode === mode ? "true" : "false");
    });
    dpad.hidden = mode !== "dpad";
    touchpad.hidden = mode !== "touchpad";
    stopAllRepeats();
    resetTouchpad();
  }

  Array.prototype.forEach.call(modeSwitch.querySelectorAll(".segment"), function (seg) {
    seg.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      var target = seg.dataset.mode;
      if (target === mode) return;
      haptic();
      applyMode(target);
      send({ type: "mode", mode: target });
    });
    seg.addEventListener("click", function (event) {
      // Keyboard and assistive technology activation (no pointerdown).
      if (event.detail === 0 && seg.dataset.mode !== mode) {
        applyMode(seg.dataset.mode);
        send({ type: "mode", mode: mode });
      }
    });
  });

  // ================= Buttons (keys and media) =================

  var activeRepeats = [];

  function stopAllRepeats() {
    activeRepeats.slice().forEach(function (stop) { stop(); });
  }

  // Wires press feedback and an action onto one element. With repeat, the action fires again
  // after REPEAT_DELAY_MS and then every REPEAT_INTERVAL_MS while the finger stays down.
  function bindPress(el, action, repeat) {
    var pointerId = null;
    var delayTimer = null;
    var intervalTimer = null;

    function stop() {
      clearTimeout(delayTimer);
      clearInterval(intervalTimer);
      delayTimer = intervalTimer = null;
      pointerId = null;
      el.classList.remove("is-pressed");
      var i = activeRepeats.indexOf(stop);
      if (i >= 0) activeRepeats.splice(i, 1);
    }

    el.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      if (pointerId !== null) stop();
      pointerId = event.pointerId;
      try { el.setPointerCapture(event.pointerId); } catch (err) { /* not capturable */ }
      el.classList.add("is-pressed");
      activeRepeats.push(stop);
      haptic();
      action();
      if (repeat) {
        delayTimer = setTimeout(function () {
          intervalTimer = setInterval(action, REPEAT_INTERVAL_MS);
        }, REPEAT_DELAY_MS);
      }
    });

    ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (type) {
      el.addEventListener(type, function (event) {
        if (event.pointerId === pointerId) stop();
      });
    });

    el.addEventListener("click", function (event) {
      if (event.detail === 0) action(); // keyboard / VoiceOver activation
    });
  }

  // Press feedback only, for buttons whose action runs on click (keyboard, link, sheet buttons).
  function bindPressFeedback(el) {
    el.addEventListener("pointerdown", function () {
      el.classList.add("is-pressed");
      haptic();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (type) {
      el.addEventListener(type, function () { el.classList.remove("is-pressed"); });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-key]"), function (el) {
    var key = el.dataset.key;
    bindPress(el, function () { send({ type: "key", key: key }); }, el.hasAttribute("data-repeat"));
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-media]"), function (el) {
    var action = el.dataset.media;
    bindPress(el, function () { send({ type: "media", action: action }); }, el.hasAttribute("data-repeat"));
  });

  // ================= Touchpad =================

  // The zone is chosen where the finger lands and kept until it lifts: the right strip (full
  // height) scrolls vertically, the bottom strip scrolls horizontally, the rest moves the cursor.
  // Further fingers are ignored. A cursor gesture reports touch start and end so the server can
  // auto-scroll while the cursor rests at an edge of the TV page.
  var activePointer = null; // { id, zone, x, y, t, startT, travel }
  var pendingMove = { dx: 0, dy: 0 };
  var pendingScroll = { dx: 0, dy: 0 };
  var frameRequested = false;

  // Acceleration: speed in px/ms. Slow moves get less than the base gain (precise), fast moves
  // up to ~3x more (far). At ~0.5 px/ms the gain equals POINTER_BASE_GAIN.
  function pointerGain(speed) {
    var factor = Math.min(3.2, Math.max(0.55, 0.55 + 0.9 * speed));
    return POINTER_BASE_GAIN * factor;
  }

  function touchpadZone(event) {
    var rect = touchpad.getBoundingClientRect();
    if (event.clientX >= rect.right - rect.width * SCROLL_STRIP_FRACTION) return "scrollY";
    if (event.clientY >= rect.bottom - rect.height * SCROLL_STRIP_FRACTION) return "scrollX";
    return "cursor";
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function requestFlush() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(flushPointer);
  }

  function flushPointer() {
    frameRequested = false;
    if (pendingMove.dx || pendingMove.dy) {
      send({ type: "pointer", action: "move", dx: round2(pendingMove.dx), dy: round2(pendingMove.dy) });
      pendingMove.dx = pendingMove.dy = 0;
    }
    if (pendingScroll.dx || pendingScroll.dy) {
      send({ type: "pointer", action: "scroll", dx: round2(pendingScroll.dx), dy: round2(pendingScroll.dy) });
      pendingScroll.dx = pendingScroll.dy = 0;
    }
  }

  function resetTouchpad() {
    if (activePointer && activePointer.zone === "cursor") send({ type: "pointer", action: "touch", active: false });
    activePointer = null;
    pendingMove.dx = pendingMove.dy = 0;
    pendingScroll.dx = pendingScroll.dy = 0;
    touchpad.classList.remove("is-touching");
  }

  touchpad.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    if (activePointer) return;
    try { touchpad.setPointerCapture(event.pointerId); } catch (err) { /* not capturable */ }
    activePointer = {
      id: event.pointerId,
      zone: touchpadZone(event),
      x: event.clientX,
      y: event.clientY,
      t: event.timeStamp,
      startT: event.timeStamp,
      travel: 0
    };
    if (activePointer.zone === "cursor") send({ type: "pointer", action: "touch", active: true });
    touchpad.classList.add("is-touching");
  });

  touchpad.addEventListener("pointermove", function (event) {
    var p = activePointer;
    if (!p || event.pointerId !== p.id) return;
    var dx = event.clientX - p.x;
    var dy = event.clientY - p.y;
    var dt = Math.max(1, event.timeStamp - p.t);
    p.x = event.clientX;
    p.y = event.clientY;
    p.t = event.timeStamp;
    if (!dx && !dy) return;
    p.travel += Math.hypot(dx, dy);

    if (p.zone === "cursor") {
      var gain = pointerGain(Math.hypot(dx, dy) / dt);
      pendingMove.dx += dx * gain;
      pendingMove.dy += dy * gain;
    } else if (p.zone === "scrollY") {
      // Scrollbar direction: finger down shows content further down.
      pendingScroll.dy += dy * SCROLL_GAIN;
    } else {
      pendingScroll.dx += dx * SCROLL_GAIN;
    }
    requestFlush();
  });

  function endTouchpadPointer(event) {
    var p = activePointer;
    if (!p || event.pointerId !== p.id) return;
    activePointer = null;
    touchpad.classList.remove("is-touching");
    flushPointer(); // pending moves go first so a click or touch end lands where the cursor is
    if (p.zone === "cursor") send({ type: "pointer", action: "touch", active: false });
    if (
      event.type === "pointerup" &&
      p.travel < TAP_MAX_TRAVEL_PX &&
      event.timeStamp - p.startT < TAP_MAX_MS
    ) {
      haptic();
      send({ type: "pointer", action: "click" });
    }
  }

  touchpad.addEventListener("pointerup", endTouchpadPointer);
  touchpad.addEventListener("pointercancel", endTouchpadPointer);
  touchpad.addEventListener("contextmenu", function (event) { event.preventDefault(); });

  // ================= Live typing =================

  var typedValue = "";
  var segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

  // Splits into user-perceived characters, so one backspace removes one emoji on the TV too.
  function toChars(text) {
    if (segmenter) {
      var out = [];
      var it = segmenter.segment(text)[Symbol.iterator]();
      for (var s = it.next(); !s.done; s = it.next()) out.push(s.value.segment);
      return out;
    }
    return Array.from(text);
  }

  // Common-prefix diff: everything after the shared prefix is deleted and retyped.
  function diffTyping(previous, current) {
    var a = toChars(previous);
    var b = toChars(current);
    var p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    return { backspaces: a.length - p, insert: b.slice(p).join("") };
  }

  function resetTypingValue() {
    typingInput.value = "";
    typedValue = "";
  }

  function openTyping() {
    typingBar.hidden = false;
    resetTypingValue();
    // Must stay synchronous inside the click handler, otherwise iOS does not show the keyboard.
    typingInput.focus({ preventScroll: true });
    updateFloatingPosition();
  }

  function closeTyping() {
    typingBar.hidden = true;
    resetTypingValue();
  }

  typingInput.addEventListener("input", function () {
    var current = typingInput.value;
    var diff = diffTyping(typedValue, current);
    for (var i = 0; i < diff.backspaces; i++) send({ type: "text", action: "backspace" });
    if (diff.insert) send({ type: "text", action: "insert", text: diff.insert });
    typedValue = current;
    if (current.length > TYPING_RESET_LENGTH) resetTypingValue();
  });

  typingInput.addEventListener("compositionend", function () {
    if (typingInput.value.length > TYPING_RESET_LENGTH) resetTypingValue();
  });

  typingInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      send({ type: "text", action: "enter" });
      resetTypingValue();
    } else if (event.key === "Backspace" && typingInput.value === "") {
      // An empty field produces no input event, but the TV field may still hold text.
      send({ type: "text", action: "backspace" });
    }
  });

  typingInput.addEventListener("blur", closeTyping);

  keyboardBtn.addEventListener("click", openTyping);
  bindPressFeedback(keyboardBtn);

  // pointerdown preventDefault keeps focus in the input until the click closes it.
  typingDone.addEventListener("pointerdown", function (event) { event.preventDefault(); });
  typingDone.addEventListener("click", function () { typingInput.blur(); });

  // ================= Link sheet =================

  // Adds https:// when no scheme was typed. "host:port" is not mistaken for a scheme.
  function normalizeUrl(raw) {
    var text = String(raw || "").trim().replace(/\s+/g, "");
    if (!text) return "";
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return text;
    if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(text)) return text; // mailto:, javascript: ... server rejects
    return "https://" + text;
  }

  function openSheet() {
    sheet.classList.add("is-open");
    sheet.setAttribute("aria-hidden", "false");
    sheetBackdrop.classList.add("is-open");
    linkInput.classList.remove("is-invalid");
    linkInput.value = "";
    // Synchronous focus inside the click handler opens the iOS keyboard.
    linkInput.focus({ preventScroll: true });
    updateFloatingPosition();
  }

  function closeSheet() {
    linkInput.blur();
    sheet.classList.remove("is-open");
    sheet.setAttribute("aria-hidden", "true");
    sheetBackdrop.classList.remove("is-open");
  }

  linkBtn.addEventListener("click", openSheet);
  bindPressFeedback(linkBtn);
  linkCancel.addEventListener("click", closeSheet);
  sheetBackdrop.addEventListener("click", closeSheet);
  Array.prototype.forEach.call(sheet.querySelectorAll(".sheet-btn"), bindPressFeedback);

  sheet.addEventListener("submit", function (event) {
    event.preventDefault();
    var url = normalizeUrl(linkInput.value);
    if (!url) {
      linkInput.classList.add("is-invalid");
      linkInput.focus({ preventScroll: true });
      return;
    }
    if (!send({ type: "open", url: url })) {
      showToast("Not connected to the TV", true);
      return;
    }
    closeSheet();
    showToast("Opening on TV…", false);
  });

  linkInput.addEventListener("input", function () { linkInput.classList.remove("is-invalid"); });

  // ================= Toast =================

  var toastTimer = null;

  function showToast(message, isError) {
    toastEl.textContent = message;
    toastEl.classList.toggle("is-error", !!isError);
    toastEl.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("is-visible"); }, TOAST_MS);
  }

  // ================= Visual viewport (keep floating layers above the keyboard) =================

  // iOS overlays the keyboard without shrinking the layout viewport; the visual viewport shrinks
  // instead. Floating layers are shifted up by the difference.
  function updateFloatingPosition() {
    var vv = window.visualViewport;
    var shift = 0;
    if (vv) shift = Math.min(0, vv.offsetTop + vv.height - window.innerHeight);
    document.documentElement.style.setProperty("--vv-shift", shift + "px");
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateFloatingPosition);
    window.visualViewport.addEventListener("scroll", updateFloatingPosition);
  }

  // ================= Page guards (no zoom, no rubber band, no callouts) =================

  document.addEventListener("gesturestart", function (event) { event.preventDefault(); });
  document.addEventListener(
    "touchmove",
    function (event) {
      var t = event.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      event.preventDefault();
    },
    { passive: false }
  );
  document.addEventListener("contextmenu", function (event) {
    var t = event.target;
    if (t && t.tagName === "INPUT") return;
    event.preventDefault();
  });
  window.addEventListener("blur", stopAllRepeats);

  // ================= Start =================

  renderConnection();
  loadAppNames();
  connect();
})();
