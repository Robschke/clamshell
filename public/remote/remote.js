/*
  Purpose: Phone remote behavior: WebSocket connection, buttons with auto-repeat, mode switch,
           touchpad gestures, live typing, the open-link sheet and the settings sheet (sound output).
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
    - Flicks are classified at liftoff (short, fast swipe) the way phones detect a fling; the
      cursor moves during the swipe and the server puts it back, so slow moves stay precise.
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
  var FLICK_MAX_MS = 300;
  var FLICK_MIN_TRAVEL_PX = 15;
  var FLICK_MIN_SPEED = 0.4; // px/ms at liftoff
  var FLICK_SAMPLE_MS = 80;
  var FLICK_REST_MS = 60;
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
  var layoutBtn = $("layoutBtn");
  var headerRow = $("headerRow");
  var buttonsSection = $("buttons");
  var navRow = $("navRow");
  var bottomBar = $("bottomBar");
  var settingsBtn = $("settingsBtn");
  var settingsSheet = $("settingsSheet");
  var settingsDone = $("settingsDone");
  var outputList = $("outputList");
  var outputNote = $("outputNote");
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
      else if (msg.type === "audioOutputs") renderOutputs(Array.isArray(msg.outputs) ? msg.outputs : [], msg.error, msg.scanned === true);
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

  // One surface, one finger (further fingers are ignored). The cursor follows the finger; a short
  // swipe that is still fast when the finger lifts is a flick: the server puts the cursor back to
  // where the swipe started and glides the page, like scrolling on a phone.
  var activePointer = null; // { id, x, y, t, startT, travel, samples }
  var pendingMove = { dx: 0, dy: 0 };
  var frameRequested = false;

  // Acceleration: speed in px/ms. Slow moves get less than the base gain (precise), fast moves
  // up to ~3x more (far). At ~0.5 px/ms the gain equals POINTER_BASE_GAIN.
  function pointerGain(speed) {
    var factor = Math.min(3.2, Math.max(0.55, 0.55 + 0.9 * speed));
    return POINTER_BASE_GAIN * factor;
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
  }

  // Finger velocity (px/ms) over roughly the last FLICK_SAMPLE_MS before liftoff, measured from
  // the newest sample older than that window (so sparse move events still give two points); zero
  // when the finger had already come to rest.
  function releaseVelocity(p, upTime) {
    if (upTime - p.t > FLICK_REST_MS || p.samples.length < 2) return { vx: 0, vy: 0 };
    var last = p.samples[p.samples.length - 1];
    var first = p.samples[0];
    for (var i = p.samples.length - 2; i >= 0; i--) {
      first = p.samples[i];
      if (upTime - first.t > FLICK_SAMPLE_MS) break;
    }
    var dt = Math.max(1, last.t - first.t);
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  }

  function resetTouchpad() {
    activePointer = null;
    pendingMove.dx = pendingMove.dy = 0;
    touchpad.classList.remove("is-touching");
  }

  touchpad.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    if (activePointer) return;
    try { touchpad.setPointerCapture(event.pointerId); } catch (err) { /* not capturable */ }
    activePointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      t: event.timeStamp,
      startT: event.timeStamp,
      travel: 0,
      samples: [{ t: event.timeStamp, x: event.clientX, y: event.clientY }]
    };
    // Marks the cursor position a flick returns to, and stops a running glide.
    send({ type: "pointer", action: "start" });
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
    p.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    if (p.samples.length > 12) p.samples.shift();

    var gain = pointerGain(Math.hypot(dx, dy) / dt);
    pendingMove.dx += dx * gain;
    pendingMove.dy += dy * gain;
    requestFlush();
  });

  function endTouchpadPointer(event) {
    var p = activePointer;
    if (!p || event.pointerId !== p.id) return;
    activePointer = null;
    touchpad.classList.remove("is-touching");
    flushPointer(); // pending moves go first so a click lands where the cursor is
    if (event.type !== "pointerup") return;

    var duration = event.timeStamp - p.startT;
    if (p.travel < TAP_MAX_TRAVEL_PX && duration < TAP_MAX_MS) {
      haptic();
      send({ type: "pointer", action: "click" });
      return;
    }
    var v = releaseVelocity(p, event.timeStamp);
    if (duration <= FLICK_MAX_MS && p.travel >= FLICK_MIN_TRAVEL_PX && Math.hypot(v.vx, v.vy) >= FLICK_MIN_SPEED) {
      send({ type: "pointer", action: "flick", vx: round2(v.vx), vy: round2(v.vy) });
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

  // ================= Settings sheet (sound output) =================

  // The list comes from the server (Mac sound outputs). A tap switches right away and marks the
  // row optimistically; the server's reply (also sent to other open remotes) is the truth.
  // AirPlay receivers are only found through Control Center, which briefly appears on the TV, so
  // that scan runs only from the "Show AirPlay devices" row.
  var KIND_LABELS = {
    builtin: "Built-in",
    hdmi: "HDMI",
    displayport: "DisplayPort",
    airplay: "AirPlay",
    bluetooth: "Bluetooth",
    usb: "USB",
    virtual: "Virtual device",
    other: ""
  };
  var scanning = false;
  var SVG_NS = "http://www.w3.org/2000/svg";

  function checkIcon() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon output-check");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
    svg.appendChild(path);
    return svg;
  }

  function renderOutputs(outputs, error, scanned) {
    scanning = false;
    outputList.textContent = "";
    outputs.forEach(function (output) {
      var li = document.createElement("li");
      var row = document.createElement("button");
      row.type = "button";
      row.className = "output-row";
      row.setAttribute("role", "radio");
      row.setAttribute("aria-checked", output.active ? "true" : "false");
      var text = document.createElement("span");
      text.className = "output-text";
      var name = document.createElement("span");
      name.className = "output-name";
      name.textContent = String(output.name || "Unknown output");
      text.appendChild(name);
      var kindLabel = KIND_LABELS[output.kind] || "";
      if (kindLabel) {
        var kind = document.createElement("span");
        kind.className = "output-kind";
        kind.textContent = kindLabel;
        text.appendChild(kind);
      }
      row.appendChild(text);
      row.appendChild(checkIcon());
      row.addEventListener("click", function () { selectOutput(output, row); });
      bindPressFeedback(row);
      li.appendChild(row);
      outputList.appendChild(li);
    });
    if (!outputs.length) {
      var empty = document.createElement("li");
      empty.className = "output-empty";
      empty.textContent = "No sound outputs found";
      outputList.appendChild(empty);
    }
    outputList.appendChild(scanRow(scanned));
    outputNote.textContent = error ? String(error) : "";
  }

  function scanRow(scanned) {
    var li = document.createElement("li");
    var row = document.createElement("button");
    row.type = "button";
    row.className = "output-row output-scan";
    row.textContent = scanned ? "Search AirPlay devices again" : "Show AirPlay devices";
    row.addEventListener("click", function () {
      if (scanning) return;
      if (!send({ type: "audio", action: "scan" })) {
        showToast("Not connected to the TV", true);
        return;
      }
      scanning = true;
      row.textContent = "Searching…";
      row.disabled = true;
    });
    bindPressFeedback(row);
    li.appendChild(row);
    return li;
  }

  function selectOutput(output, row) {
    if (row.getAttribute("aria-checked") === "true") return;
    var message = { type: "audio", action: "select", uid: output.uid };
    if (typeof output.source === "number") message.source = output.source;
    if (!send(message)) {
      showToast("Not connected to the TV", true);
      return;
    }
    Array.prototype.forEach.call(outputList.querySelectorAll(".output-row"), function (other) {
      other.setAttribute("aria-checked", other === row ? "true" : "false");
    });
  }

  function openSettings() {
    settingsSheet.classList.add("is-open");
    settingsSheet.setAttribute("aria-hidden", "false");
    sheetBackdrop.classList.add("is-open");
    outputList.textContent = "";
    outputNote.textContent = "";
    var loading = document.createElement("li");
    loading.className = "output-empty";
    loading.textContent = "Loading…";
    outputList.appendChild(loading);
    if (!send({ type: "audio", action: "list" })) renderOutputs([], "Not connected to the TV");
  }

  function closeSettings() {
    settingsSheet.classList.remove("is-open");
    settingsSheet.setAttribute("aria-hidden", "true");
    if (!sheet.classList.contains("is-open")) sheetBackdrop.classList.remove("is-open");
  }

  settingsBtn.addEventListener("click", openSettings);
  bindPressFeedback(settingsBtn);
  settingsDone.addEventListener("click", closeSettings);
  bindPressFeedback(settingsDone);

  // ================= Layout swap =================

  // One setting for both modes, remembered on this phone. Storage can be unavailable (private
  // mode), so the remote falls back to the default layout. In the bottom layout the nav row and
  // the mode switch move into the bar under the D-pad/pad, so the most used controls sit
  // together within thumb reach; moving the elements keeps their event handlers.
  var LAYOUT_KEY = "tvStream.controlsBottom";

  function applyControlsBottom(bottom) {
    $("app").classList.toggle("controls-bottom", bottom);
    if (bottom) {
      bottomBar.appendChild(navRow);
      bottomBar.appendChild(modeSwitch);
    } else {
      buttonsSection.insertBefore(navRow, buttonsSection.firstChild);
      headerRow.insertBefore(modeSwitch, settingsBtn);
    }
    bottomBar.hidden = !bottom;
    layoutBtn.setAttribute("aria-pressed", bottom ? "true" : "false");
    layoutBtn.setAttribute("aria-label", bottom ? "Move controls to the top" : "Move controls to the bottom");
  }

  function readControlsBottom() {
    try { return localStorage.getItem(LAYOUT_KEY) === "1"; } catch (err) { return false; }
  }

  layoutBtn.addEventListener("click", function () {
    var bottom = !$("app").classList.contains("controls-bottom");
    applyControlsBottom(bottom);
    try { localStorage.setItem(LAYOUT_KEY, bottom ? "1" : "0"); } catch (err) { /* not persisted */ }
  });
  bindPressFeedback(layoutBtn);
  applyControlsBottom(readControlsBottom());
  linkCancel.addEventListener("click", closeSheet);
  sheetBackdrop.addEventListener("click", function () {
    closeSheet();
    closeSettings();
  });
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
