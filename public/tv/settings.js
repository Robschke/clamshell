/*
  Purpose: TV settings page behavior: section sidebar, focus navigation for the remote, and the
           "Services" section (list, hide/show built-in services, remove and add own services).
  Depends on: /tv/settings.html (element ids, data-section panels, data-focusable),
              /tv/settings.css (is-focused, is-active, is-hidden), GET /api/settings,
              POST /api/settings/services, PATCH and DELETE /api/settings/services/<id>
              (contract in docs/architecture.md).
  Used by: /tv/settings.html.
  Notes:
    - Arrow keys move focus to the nearest [data-focusable] element in that direction within the
      sidebar or within the content; crossing over goes to the active section (left) or back to
      the last focused content element (right). New controls only need data-focusable.
    - A section is an entry in SECTIONS plus its panel in the HTML. Back (Escape) first asks the
      section (onBack, for example to close a form), then moves to the sidebar, then leaves the
      page for the home screen.
    - Arrow keys never move the caret in the text fields: on the TV they only navigate. Text
      arrives from the phone's Keyboard button as inserted text and Backspace presses.
    - Enter in a text field moves to the next control; on buttons it clicks them.
*/
(function () {
  "use strict";

  var HOME_URL = "/tv/";
  var REQUEST_TIMEOUT_MS = 6000;

  var navSections = document.getElementById("navSections");
  var backBtn = document.getElementById("backBtn");
  var content = document.getElementById("content");

  var lastContentFocus = null;
  var activeSectionId = null;
  var navButtons = {};

  // ---- requests ----

  function request(method, url, body) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    var options = { method: method, cache: "no-store", signal: controller.signal };
    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    return fetch(url, options)
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || data.ok === false) throw new Error(data.error || "The server did not accept that");
          return data;
        });
      }, function () {
        throw new Error("The server is not reachable");
      })
      .finally(function () { clearTimeout(timer); });
  }

  function showError(el, message) {
    el.textContent = message || "";
    el.hidden = !message;
  }

  // ---- focus ----

  function isFocusable(el) {
    return !!el && el.hasAttribute("data-focusable") && !el.disabled && el.getClientRects().length > 0;
  }

  function focusables(region) {
    return Array.prototype.filter.call(region.querySelectorAll("[data-focusable]"), isFocusable);
  }

  function regionOf(el) {
    return el && el.closest(".settings-nav") ? "nav" : "content";
  }

  function focusEl(el) {
    if (!isFocusable(el)) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }

  // Nearest candidate in the direction: distance along the direction plus twice the gap across it
  // (0 when the two overlap), so a control straight ahead wins over a closer one off to the side.
  // Ties keep document order, so moving down from a wide field lands on the first control below.
  function nearest(from, key, candidates) {
    var a = from.getBoundingClientRect();
    var best = null;
    var bestScore = Infinity;
    candidates.forEach(function (el) {
      if (el === from) return;
      var b = el.getBoundingClientRect();
      var along;
      var across;
      if (key === "ArrowDown" || key === "ArrowUp") {
        along = key === "ArrowDown" ? b.top - a.bottom : a.top - b.bottom;
        across = Math.max(0, b.left - a.right, a.left - b.right);
      } else {
        along = key === "ArrowRight" ? b.left - a.right : a.left - b.right;
        across = Math.max(0, b.top - a.bottom, a.top - b.bottom);
      }
      if (along < -1) return;
      var score = Math.max(0, along) + across * 2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  function firstContentFocus() {
    var panel = activePanel();
    return panel ? focusables(panel)[0] : null;
  }

  function moveFocus(key) {
    var current = document.activeElement;
    if (!isFocusable(current)) {
      focusEl(navButtons[activeSectionId] || backBtn);
      return;
    }
    var region = regionOf(current);
    var target = nearest(current, key, focusables(region === "nav" ? document.querySelector(".settings-nav") : content));
    if (target) return focusEl(target);
    if (key === "ArrowLeft" && region === "content") return focusEl(navButtons[activeSectionId]);
    if (key === "ArrowRight" && region === "nav") {
      focusEl(isFocusable(lastContentFocus) ? lastContentFocus : firstContentFocus());
    }
  }

  document.addEventListener("focusin", function (event) {
    var el = event.target;
    Array.prototype.forEach.call(document.querySelectorAll(".is-focused"), function (other) {
      if (other !== el) other.classList.remove("is-focused");
    });
    if (!el.hasAttribute || !el.hasAttribute("data-focusable")) return;
    el.classList.add("is-focused");
    if (regionOf(el) === "content") lastContentFocus = el;
    var section = el.getAttribute("data-section-nav");
    if (section) showSection(section);
  });

  // Touchpad cursor: moving over a control focuses it, like the tiles on the home screen. Chrome
  // can report a mousemove without movement after layout changes, which must not steal focus.
  var lastMouse = null;
  document.addEventListener("mousemove", function (event) {
    var moved = lastMouse !== null && (lastMouse.x !== event.clientX || lastMouse.y !== event.clientY);
    lastMouse = { x: event.clientX, y: event.clientY };
    if (!moved) return;
    var el = event.target.closest && event.target.closest("[data-focusable]");
    if (el && el !== document.activeElement && isFocusable(el)) el.focus({ preventScroll: true });
  });

  // ---- sections ----

  function activePanel() {
    return document.querySelector('.panel[data-section="' + activeSectionId + '"]');
  }

  function showSection(id) {
    if (id === activeSectionId) return;
    activeSectionId = id;
    lastContentFocus = null;
    Array.prototype.forEach.call(document.querySelectorAll(".panel"), function (panel) {
      panel.hidden = panel.getAttribute("data-section") !== id;
    });
    Object.keys(navButtons).forEach(function (key) {
      navButtons[key].classList.toggle("is-active", key === id);
    });
    var section = SECTIONS.filter(function (s) { return s.id === id; })[0];
    if (section && section.onShow) section.onShow();
  }

  function goHome() {
    window.location.href = HOME_URL;
  }

  function goBack() {
    var current = document.activeElement;
    if (isFocusable(current) && regionOf(current) === "content") {
      var section = SECTIONS.filter(function (s) { return s.id === activeSectionId; })[0];
      if (section && section.onBack && section.onBack()) return;
      focusEl(navButtons[activeSectionId]);
      return;
    }
    goHome();
  }

  // ---- section: Services ----

  var services = (function () {
    var listView = document.getElementById("serviceListView");
    var list = document.getElementById("serviceList");
    var listError = document.getElementById("listError");
    var form = document.getElementById("addForm");
    var nameInput = document.getElementById("nameInput");
    var urlInput = document.getElementById("urlInput");
    var swatches = document.getElementById("swatches");
    var formError = document.getElementById("formError");
    var cancelBtn = document.getElementById("cancelAdd");
    var preview = document.getElementById("tilePreview");
    var previewName = document.getElementById("tilePreviewName");

    var ADD_ROW_ID = "add";
    var items = [];
    var colors = [];
    var selectedColor = null;
    var busy = false;
    var loaded = false;

    function hostOf(url) {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch (err) {
        return "";
      }
    }

    function actionLabel(item) {
      if (!item.builtIn) return "Remove";
      return item.hidden ? "Show" : "Hide";
    }

    function rowFor(id) {
      return list.querySelector('[data-id="' + id + '"]');
    }

    function renderList(focusId) {
      list.textContent = "";
      items.forEach(function (item) {
        var li = document.createElement("li");
        var row = document.createElement("button");
        row.type = "button";
        row.className = "service-row" + (item.hidden ? " is-hidden" : "");
        row.setAttribute("data-focusable", "");
        row.dataset.id = item.id;
        row.setAttribute("aria-label", item.name + ", " + actionLabel(item));

        var swatch = document.createElement("span");
        swatch.className = "service-swatch";
        swatch.style.setProperty("--swatch", item.color || "#333");

        var text = document.createElement("span");
        text.className = "service-text";
        var name = document.createElement("span");
        name.className = "service-name";
        name.textContent = item.name;
        var host = document.createElement("span");
        host.className = "service-host";
        host.textContent = item.hidden ? "Hidden" : hostOf(item.url);
        text.appendChild(name);
        text.appendChild(host);

        var action = document.createElement("span");
        action.className = "service-action";
        action.textContent = actionLabel(item);

        row.appendChild(swatch);
        row.appendChild(text);
        row.appendChild(action);
        row.addEventListener("click", function () { act(item); });
        li.appendChild(row);
        list.appendChild(li);
      });

      var addLi = document.createElement("li");
      var addRow = document.createElement("button");
      addRow.type = "button";
      addRow.className = "service-row add-row";
      addRow.setAttribute("data-focusable", "");
      addRow.dataset.id = ADD_ROW_ID;
      addRow.innerHTML = '<span class="add-plus" aria-hidden="true">+</span><span class="service-text">Add service</span>';
      addRow.addEventListener("click", openForm);
      addLi.appendChild(addRow);
      list.appendChild(addLi);

      if (focusId) focusEl(rowFor(focusId) || rowFor(ADD_ROW_ID));
    }

    function load() {
      return request("GET", "/api/settings").then(function (data) {
        items = data.services || [];
        colors = data.colors || [];
        loaded = true;
        showError(listError, "");
        renderList();
      }, function (err) {
        showError(listError, err.message);
      });
    }

    // The row to focus after this one disappears: the next row, else the previous, else Add.
    function neighborId(id) {
      var index = items.findIndex(function (item) { return item.id === id; });
      var next = items[index + 1] || items[index - 1];
      return next ? next.id : ADD_ROW_ID;
    }

    function act(item) {
      if (busy) return;
      busy = true;
      var path = "/api/settings/services/" + encodeURIComponent(item.id);
      var focusAfter = item.builtIn ? item.id : neighborId(item.id);
      var call = item.builtIn ? request("PATCH", path, { hidden: !item.hidden }) : request("DELETE", path);
      call
        .then(function (data) {
          items = data.services || [];
          showError(listError, "");
          renderList(focusAfter);
        }, function (err) {
          showError(listError, err.message);
        })
        .finally(function () { busy = false; });
    }

    // ---- add form ----

    function renderSwatches() {
      swatches.textContent = "";
      colors.forEach(function (color, index) {
        var swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "swatch";
        swatch.setAttribute("data-focusable", "");
        swatch.setAttribute("role", "radio");
        swatch.setAttribute("aria-label", "Color " + (index + 1));
        swatch.setAttribute("aria-checked", color === selectedColor ? "true" : "false");
        swatch.style.setProperty("--swatch", color);
        swatch.addEventListener("click", function () { selectColor(color); });
        swatches.appendChild(swatch);
      });
    }

    function selectColor(color) {
      selectedColor = color;
      Array.prototype.forEach.call(swatches.children, function (swatch, index) {
        swatch.setAttribute("aria-checked", colors[index] === color ? "true" : "false");
      });
      updatePreview();
    }

    function updatePreview() {
      preview.style.setProperty("--tile-color", selectedColor || "#222");
      previewName.textContent = nameInput.value.trim() || "Name";
    }

    function openForm() {
      if (!loaded) return;
      var ownCount = items.filter(function (item) { return !item.builtIn; }).length;
      selectedColor = colors.length ? colors[ownCount % colors.length] : null;
      nameInput.value = "";
      urlInput.value = "";
      showError(formError, "");
      renderSwatches();
      updatePreview();
      listView.hidden = true;
      form.hidden = false;
      focusEl(nameInput);
    }

    function closeForm(focusId) {
      form.hidden = true;
      listView.hidden = false;
      focusEl(rowFor(focusId || ADD_ROW_ID));
    }

    function submit() {
      if (busy) return;
      busy = true;
      showError(formError, "");
      request("POST", "/api/settings/services", { name: nameInput.value, url: urlInput.value, color: selectedColor })
        .then(function (data) {
          items = data.services || [];
          renderList();
          closeForm(data.id);
        }, function (err) {
          showError(formError, err.message);
        })
        .finally(function () { busy = false; });
    }

    nameInput.addEventListener("input", updatePreview);
    cancelBtn.addEventListener("click", function () { closeForm(); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      submit();
    });

    return {
      onShow: function () {
        if (!loaded) load();
      },
      onBack: function () {
        if (form.hidden) return false;
        closeForm();
        return true;
      }
    };
  })();

  var SECTIONS = [
    { id: "services", label: "Services", onShow: services.onShow, onBack: services.onBack }
  ];

  // ---- keys ----

  document.addEventListener("keydown", function (event) {
    var el = document.activeElement;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        event.preventDefault();
        moveFocus(event.key);
        break;
      case "Enter":
        event.preventDefault();
        if (event.repeat) break;
        if (el && el.tagName === "INPUT") moveFocus("ArrowDown");
        else if (isFocusable(el)) el.click();
        break;
      case "Escape":
        event.preventDefault();
        goBack();
        break;
      default:
        break;
    }
  });

  // ---- start ----

  SECTIONS.forEach(function (section) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "nav-item";
    button.setAttribute("data-focusable", "");
    button.setAttribute("data-section-nav", section.id);
    button.textContent = section.label;
    button.addEventListener("click", function () { focusEl(firstContentFocus()); });
    navSections.appendChild(button);
    navButtons[section.id] = button;
  });
  backBtn.addEventListener("click", goHome);

  showSection(SECTIONS[0].id);
  focusEl(navButtons[SECTIONS[0].id]);
})();
