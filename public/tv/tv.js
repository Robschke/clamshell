/*
  Purpose: TV home screen behavior: renders app tiles, keyboard focus, opening apps, clock, pairing QR.
  Depends on: /tv/index.html (element ids), /tv/tv.css (classes), GET /api/apps, GET /api/info,
              POST /api/open (contract in docs/architecture.md).
  Used by: /tv/index.html.
  Notes: The launcher is a "native" page for the remote: the server sends real ArrowLeft/ArrowRight/
         Enter key events, so this file only listens to the keyboard. Focus is a CSS class plus real
         DOM focus; Enter is handled in keydown (with preventDefault) so the button's own click
         activation cannot open the app twice. If the server cannot open the app (unreachable or an
         error), the page navigates itself, which keeps the launcher usable without the server.
*/
(function () {
  "use strict";

  // Built-in catalog used when GET /api/apps fails. Mirrors the app catalog in the contract.
  var FALLBACK_APPS = [
    { id: "netflix", name: "Netflix", url: "https://www.netflix.com/browse", color: "#141414", textColor: "#E50914" },
    { id: "youtube", name: "YouTube", url: "https://www.youtube.com/tv", color: "#FF0000", textColor: "#FFFFFF" },
    { id: "prime", name: "Prime Video", url: "https://www.primevideo.com", color: "#00A8E1", textColor: "#FFFFFF" },
    { id: "disney", name: "Disney+", url: "https://www.disneyplus.com", color: "#113CCF", textColor: "#FFFFFF" },
    { id: "hbomax", name: "HBO Max", url: "https://play.hbomax.com", color: "#002BE7", textColor: "#FFFFFF" }
  ];

  var FOCUS_STORAGE_KEY = "tvStream.focusedAppId";
  var OPEN_TIMEOUT_MS = 3000;
  var OPEN_LOCK_MS = 1500;
  var INFO_RETRY_MS = 5000;
  var INFO_REFRESH_MS = 60000;

  var tileRow = document.getElementById("tiles");
  var clockEl = document.getElementById("clock");
  var pairingEl = document.getElementById("pairing");
  var qrEl = document.getElementById("qr");
  var remoteUrlEl = document.getElementById("remoteUrl");
  var remoteUrlIpEl = document.getElementById("remoteUrlIp");

  var apps = [];
  var tiles = [];
  var focusIndex = 0;
  var lastOpenAt = 0;

  // ---- sessionStorage (may throw in locked-down profiles) ----

  function readStoredFocus() {
    try {
      return window.sessionStorage.getItem(FOCUS_STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function storeFocus(appId) {
    try {
      window.sessionStorage.setItem(FOCUS_STORAGE_KEY, appId);
    } catch (err) {
      // Focus memory is a convenience only.
    }
  }

  // ---- fetch helpers ----

  function fetchJson(url, options, timeoutMs) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 5000) : null;
    var opts = Object.assign({ cache: "no-store" }, options || {});
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });
  }

  function isValidApp(app) {
    return app && typeof app.id === "string" && typeof app.name === "string";
  }

  function fallbackFor(id) {
    for (var i = 0; i < FALLBACK_APPS.length; i++) {
      if (FALLBACK_APPS[i].id === id) return FALLBACK_APPS[i];
    }
    return null;
  }

  function loadApps() {
    return fetchJson("/api/apps", null, 4000)
      .then(function (data) {
        var list = Array.isArray(data) ? data.filter(isValidApp) : [];
        if (!list.length) throw new Error("empty app list");
        return list;
      })
      .catch(function () {
        return FALLBACK_APPS;
      });
  }

  // ---- tiles and focus ----

  function renderTiles(list) {
    apps = list;
    tileRow.textContent = "";
    tiles = list.map(function (app, index) {
      var fallback = fallbackFor(app.id) || {};
      var tile = document.createElement("button");
      tile.type = "button";
      tile.className = "tile";
      tile.setAttribute("role", "listitem");
      tile.setAttribute("aria-label", app.name);
      tile.dataset.app = app.id;
      tile.style.setProperty("--tile-color", app.color || fallback.color || "#222");
      tile.style.setProperty("--tile-text", app.textColor || fallback.textColor || "#fff");
      tile.style.animationDelay = index * 60 + "ms";

      var name = document.createElement("span");
      name.className = "tile-name";
      name.textContent = app.name;
      tile.appendChild(name);

      // Mouse and touchpad-cursor support: moving over a tile focuses it, clicking opens.
      tile.addEventListener("mousemove", function (event) {
        if (index !== focusIndex && pointerReallyMoved(event)) setFocus(index);
      });
      tile.addEventListener("click", function () {
        setFocus(index);
        openApp(index);
      });

      tileRow.appendChild(tile);
      return tile;
    });

    var stored = readStoredFocus();
    var storedIndex = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === stored) storedIndex = i;
    }
    setFocus(storedIndex >= 0 ? storedIndex : 0);
  }

  // Chrome may emit a mousemove at an unchanged position after layout changes (for example when
  // tiles render under a parked cursor). Only a change of position counts, so the restored focus
  // is not overridden on load.
  var lastMouse = null;
  function pointerReallyMoved(event) {
    var moved = lastMouse !== null && (lastMouse.x !== event.clientX || lastMouse.y !== event.clientY);
    lastMouse = { x: event.clientX, y: event.clientY };
    return moved;
  }

  function setFocus(index) {
    if (!tiles.length) return;
    focusIndex = Math.max(0, Math.min(tiles.length - 1, index));
    tiles.forEach(function (tile, i) {
      tile.classList.toggle("is-focused", i === focusIndex);
    });
    var tile = tiles[focusIndex];
    if (document.activeElement !== tile) tile.focus({ preventScroll: true });
    storeFocus(apps[focusIndex].id);
  }

  function openApp(index) {
    var now = Date.now();
    if (now - lastOpenAt < OPEN_LOCK_MS) return;
    lastOpenAt = now;

    var app = apps[index];
    var tile = tiles[index];
    var url = app.url || (fallbackFor(app.id) || {}).url;
    tile.classList.add("is-opening");
    setTimeout(function () { tile.classList.remove("is-opening"); }, 180);

    fetchJson(
      "/api/open",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.id })
      },
      OPEN_TIMEOUT_MS
    )
      .then(function (body) {
        if (body && body.ok === false) throw new Error("open refused");
      })
      .catch(function () {
        if (url) window.location.href = url;
      });
  }

  function onKeyDown(event) {
    if (!tiles.length) return;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        setFocus(focusIndex - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        setFocus(focusIndex + 1);
        break;
      case "Enter":
        event.preventDefault();
        if (!event.repeat) openApp(focusIndex);
        break;
      default:
        break;
    }
  }

  // ---- clock ----

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function updateClock() {
    var now = new Date();
    var text = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
    if (clockEl.textContent !== text) {
      clockEl.textContent = text;
      clockEl.setAttribute("datetime", text);
    }
  }

  // ---- pairing info ----

  function loadInfo() {
    fetchJson("/api/info", null, 4000)
      .then(function (info) {
        if (!info || typeof info.remoteUrl !== "string") throw new Error("bad info");
        remoteUrlEl.textContent = info.remoteUrl;
        remoteUrlIpEl.textContent = info.remoteUrlIp && info.remoteUrlIp !== info.remoteUrl ? info.remoteUrlIp : "";
        // qrSvg comes from our own server; only accept something that is an SVG document.
        if (typeof info.qrSvg === "string" && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(info.qrSvg)) {
          qrEl.innerHTML = info.qrSvg;
          qrEl.hidden = false;
        } else {
          qrEl.hidden = true;
        }
        pairingEl.hidden = false;
        setTimeout(loadInfo, INFO_REFRESH_MS);
      })
      .catch(function () {
        setTimeout(loadInfo, INFO_RETRY_MS);
      });
  }

  // ---- start ----

  document.addEventListener("keydown", onKeyDown);
  // Returning to the launcher from history may restore the page from the back/forward cache.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted && tiles.length) renderTiles(apps);
  });

  updateClock();
  setInterval(updateClock, 1000);
  loadInfo();
  loadApps().then(renderTiles);
})();
