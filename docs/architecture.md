# Clamshell architecture

Clamshell turns the MacBook into a streaming device: a fullscreen Chrome window on the
HDMI display shows a TV home screen and the streaming sites, and a phone web app acts
as the remote. Everything runs locally, one Node process, no cloud.

## Processes

```
 phone (Safari)                    MacBook
 ┌──────────────┐  WebSocket /ws   ┌────────────────────────────┐
 │ /remote/     │ ───────────────▶ │ Node server (port 8787)    │
 │ remote app   │ ◀─────────────── │  http + ws + tv-controller │
 └──────────────┘   state pushes   └─────────────┬──────────────┘
                                                 │ Chrome DevTools Protocol
                                                 │ (127.0.0.1:9222, built-in WebSocket)
                                   ┌─────────────▼──────────────┐
                                   │ Chrome, kiosk, own profile │
                                   │  page = /tv/ launcher or   │
                                   │  netflix.com, youtube/tv.. │
                                   │  + injected tv-overlay.js  │
                                   └────────────────────────────┘
```

- `caffeinate -dimsu -w <server pid>` keeps the Mac awake while the server runs.
- Chrome runs with its own profile at `~/Library/Application Support/Clamshell/chrome-profile`
  (logins persist, separate from the user's daily browser).
- Chrome opens fullscreen on the external (HDMI) display when one is connected, otherwise on
  the built-in display. When an external display is plugged in later, the window moves there.
- Outside dev mode the Mac's own mouse pointer is hidden on every TV page (an injected
  `cursor: none !important` sheet in every frame); the remote's cursor is drawn by the overlay.
- Dev mode (`TV_STREAM_WINDOWED=1`): no kiosk, normal 1280x720 window. Use it for all testing so
  the user's screen is never taken over.

## Folder layout (`app/`)

| Path | Owner | Purpose |
|------|-------|---------|
| `package.json` | lead | `npm start` runs `src/server/main.js`. ESM (`"type": "module"`), Node >= 22. |
| `src/server/main.js` | server | Entry: config, start http/ws, launch Chrome, caffeinate, shutdown. |
| `src/server/http-server.js` | server | Static files from `public/`, REST endpoints below. |
| `src/server/remote-socket.js` | server | `ws` server on `/ws`, validates messages, calls tv-controller, broadcasts state. |
| `src/server/chrome-launcher.js` | server | Finds Chrome, picks display, spawns Chrome, moves window on hot-plug. |
| `src/server/display-detector.js` | server | Lists screens via JXA (`osascript -l JavaScript`, NSScreen). |
| `src/server/cdp-client.js` | server | Minimal CDP client on Node's global `WebSocket`. |
| `src/server/tv-controller.js` | server | Maps remote commands to CDP calls and overlay calls. Owns cursor position and mode. |
| `src/server/audio-outputs.js` | lead | Lists / switches the Mac's sound outputs through `build/tv-audio`. |
| `src/server/app-catalog.js` | server | Tile list (id, name, url, colors, navigation, userAgent). |
| `src/inject/tv-overlay.js` | overlay | Injected into every page. Highlight navigation, player mode, cursor, quick menu. |
| `public/tv/` | frontend | TV home screen (`index.html`, css, js). |
| `public/remote/` | frontend | Phone remote (`index.html`, css, js, web app manifest). |
| `macos/Sources/` | lead | Mac app (Swift, AppKit): starts and supervises the server, Dock + menu bar menu, QR window. |
| `macos/AudioTool/main.swift` | lead | Sound helper CLI (`build/tv-audio`): `list` / `select <uid> [<source>]` (CoreAudio), `wireless` / `select-cc <name>` (Control Center), JSON on stdout. |
| `macos/AudioTool/ControlCenterSound.swift` | lead | Reads and selects outputs in Control Center's Sound panel through the Accessibility API (AirPlay receivers). |
| `macos/build-app.sh` | lead | `npm run app`: compiles the app, builds the icon from `macos/app-icon.svg`, installs to /Applications. |

## App catalog

| id | name | url | navigation |
|----|------|-----|------------|
| netflix | Netflix | https://www.netflix.com/browse | spatial |
| youtube | YouTube | https://www.youtube.com/tv | native (needs TV user agent) |
| prime | Prime Video | https://www.primevideo.com | spatial |
| disney | Disney+ | https://www.disneyplus.com | spatial |
| hbomax | HBO Max | https://play.hbomax.com | spatial |

- `navigation: "native"`: the site handles arrow keys itself; the controller sends real key events.
- `navigation: "spatial"`: the overlay moves a highlight between focusable elements.
- The launcher page (`http://localhost:8787/tv/`) handles arrow keys itself (native).
- YouTube TV refuses desktop user agents. The controller sets a TV user agent
  (`Network.setUserAgentOverride`) before navigating to youtube.com/tv and restores the default
  when navigating anywhere else (home, other tile, opened link).

## REST endpoints

| Method | Path | Body / response |
|--------|------|-----------------|
| GET | `/api/info` | `{ remoteUrl, remoteUrlIp, qrSvg }` (QR encodes `remoteUrl`) |
| GET | `/api/apps` | `[{ id, name, url, color, textColor }]` |
| POST | `/api/open` | `{ appId }` or `{ url }` → `{ ok: true }`; used by launcher tiles |
| GET | `/` | redirects to `/remote/` |

`remoteUrl` = `http://<os.hostname()>:8787/remote/` (hostname ends with `.local` on macOS),
`remoteUrlIp` = same with the first non-internal IPv4 address.

## WebSocket protocol (`/ws`, JSON text frames)

### Remote → server

```jsonc
{ "type": "key", "key": "up" | "down" | "left" | "right" | "ok" | "back" | "home" | "menu" }
{ "type": "media", "action": "playpause" | "rewind" | "forward" | "volumeDown" | "volumeUp" | "mute" }
{ "type": "mode", "mode": "dpad" | "touchpad" }
{ "type": "pointer", "action": "move", "dx": 12.5, "dy": -3 }     // CSS px deltas, already scaled by the remote
{ "type": "pointer", "action": "click" }
{ "type": "pointer", "action": "scroll", "dx": 0, "dy": 40 }       // wheel deltas
{ "type": "pointer", "action": "start" }                           // finger down on the touchpad
{ "type": "pointer", "action": "flick", "vx": 1.2, "vy": -0.3 }    // finger liftoff velocity, phone px/ms
{ "type": "text", "action": "insert", "text": "a" }                // live typing, one or more chars
{ "type": "text", "action": "backspace" }
{ "type": "text", "action": "enter" }
{ "type": "open", "url": "https://youtu.be/dQw4w9WgXcQ" }
{ "type": "audio", "action": "list" }                              // sound outputs of the Mac
{ "type": "audio", "action": "scan" }                              // also read AirPlay/Bluetooth from Control Center
{ "type": "audio", "action": "select", "uid": "BuiltInSpeakerDevice", "source": 1752064048 } // source: AirPlay receiver, optional
```

### Server → remote

```jsonc
{ "type": "state", "mode": "dpad" | "touchpad", "appId": "netflix" | null, "title": "...", "url": "...",
  "tvConnected": true, "display": "external" | "builtin" }
{ "type": "error", "message": "..." }
{ "type": "audioOutputs", "outputs": [{ "uid": "...", "source": 123, "name": "LG TV", "kind": "hdmi", "active": true }],
  "error": "...", "scanned": true }   // reply to list/scan (asking remote only) and select (all remotes; on error only the asker)
```

`kind` is one of `builtin`, `hdmi`, `displayport`, `airplay`, `bluetooth`, `usb`, `virtual`,
`other`. Selecting a CoreAudio output sets the macOS default output and system output.
macOS does not hand AirPlay receivers to other apps (the routing API is private), so `scan`
drives Control Center's Sound panel through the Accessibility API: it briefly appears on screen,
needs the Accessibility permission for Clamshell, and its entries have uid `cc:<name>`; selecting
one clicks it there. The last scan is remembered and merged into later lists (not marked active).

The server sends `state` on connect and whenever it changes (navigation, title, mode, Chrome up/down).
Mode is global (one TV); switching it on one phone switches it for all.

## Command semantics (tv-controller)

1. `key` up/down/left/right/ok:
   call `window.__tvStream.handleKey(key)` in the page (Runtime.evaluate, returnByValue).
   If it returns `false` (native site, or overlay chose not to handle), dispatch a real key event
   (`Input.dispatchKeyEvent` keyDown + keyUp, ArrowUp/.../Enter with correct `code`,
   `windowsVirtualKeyCode`).
2. `back`: `handleKey('back')` first (closes quick menu, exits fullscreen video). If `false`:
   native sites get an `Escape` key event; spatial sites get `history.back()` via
   `Page.navigateToHistoryEntry`. If there is no history entry, go home.
3. `home`: navigate to the launcher, restore the default user agent.
4. `menu`: `window.__tvStream.toggleMenu()`.
5. `media`: `window.__tvStream.media(action)`. If it returns `false` (no video element found),
   fall back to key events: playpause = `k` on YouTube TV, Space elsewhere; rewind/forward =
   ArrowLeft/ArrowRight.
6. `mode`: store it, call `window.__tvStream.setMode(mode)`, broadcast state. Re-apply after every
   navigation.
7. `pointer move`: update the cursor position (clamped to the viewport from
   `Page.getLayoutMetrics`), `Input.dispatchMouseEvent mouseMoved`, `window.__tvStream.setCursor(x, y)`.
   Coalesce: at most one CDP mouse move in flight; keep only the latest position.
8. `pointer click`: mousePressed + mouseReleased (left, clickCount 1) at the cursor.
9. `pointer scroll`: `mouseWheel` at the cursor.
9a. `pointer start`: remember the cursor position, stop a running glide (the tap that stopped it
    does not click).
9b. `pointer flick`: put the cursor back to the gesture start, then glide: wheel events at the
    cursor, locked to the dominant axis, phone direction (flick up scrolls down), speed = finger
    velocity x 3 (max 10 px/ms), decaying by 0.997 per ms until below 0.05 px/ms. On native pages
    (YouTube TV, launcher) the flick becomes 1 to 5 arrow presses instead (one per 0.6 px/ms of
    finger speed, same direction); a new touch cancels the remaining presses.
10. `text insert`: `Input.insertText`. `backspace` / `enter`: key events. On YouTube TV (no text
    field) insert and backspace edit the search term through the `#/search?q=` hash
    (`location.replace`); clearing the last character uses Backspace key presses.
11. `open url`: YouTube watch links (`youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`)
    become `https://www.youtube.com/tv#/watch?v=<id>` with the TV user agent. Other http(s)
    URLs open as they are. Anything else → `error`.

After every page load the controller (re)applies the mode, and the overlay must work on pages it
was injected into via `Page.addScriptToEvaluateOnNewDocument` (runs before page scripts, in every
frame; the overlay only activates in the top frame).

The overlay reports back through a CDP binding: `Runtime.addBinding({ name: "__tvStreamSend" })`.
The overlay calls `window.__tvStreamSend(JSON.stringify({ action: "home" | "reload" }))`
from the quick menu; the server handles it in `Runtime.bindingCalled`.

## Overlay interface (`window.__tvStream`, defined by `src/inject/tv-overlay.js`)

```js
window.__tvStream = {
  version: 1,
  // Returns true if handled. Decides spatial vs native from the hostname
  // (youtube.com/tv and localhost:8787/tv are native → return false for arrows/ok).
  handleKey(key),        // "up" | "down" | "left" | "right" | "ok" | "back"
  media(action),         // same actions as the media message; returns true if a <video> was controlled
  setMode(mode),         // "dpad" shows the highlight, "touchpad" hides it and shows the cursor
  setCursor(x, y),       // CSS px in the top-level viewport; draws the fake cursor
  toggleMenu(),          // quick menu: "Reload page", "Fullscreen video on/off", "Back to home"
};
```

Behavior rules for the overlay:
- Spatial navigation: candidates are visible, enabled elements that are interactive
  (`a[href]`, `button`, `[role=button]`, `[role=link]`, `[tabindex]:not([tabindex="-1"])`, inputs,
  elements with click handlers are not detectable, so stick to the semantic set). Pick the
  nearest candidate in the pressed direction (direction-weighted distance between rects).
  Scroll the chosen element into view (`block: "center"`, smooth). `ok` clicks it (and focuses
  inputs). The highlight is a fixed-position ring drawn above everything (max z-index,
  `pointer-events: none`), re-positioned on scroll/resize.
- Player mode: when a `<video>` covering more than 50% of the viewport is present, left/right
  seek -10/+10 s, ok = play/pause, up/down show the site's controls (dispatch a mousemove on
  the video). `back` exits fullscreen first.
- Volume: `video.volume` in steps of 0.1, `mute` toggles `video.muted`. Show a small on-screen
  volume indicator for 1.5 s.
- Quick menu: centered panel, three items, navigable with up/down/ok while open (handleKey must
  route to the menu while it is open), `back` closes it.
- Cursor (iPad style): a small translucent grey circle (1.8% of the viewport height, min 14 px)
  centered on (x, y), the same shape everywhere. Auto-hides after 4 s idle in touchpad mode.
- All overlay DOM lives in one closed shadow root on a host element, so site CSS cannot break it.
- The overlay must survive SPA navigations (sites replacing the DOM) and must never throw into
  the page.

## UI

- Language: English. Dark theme (TV-like), large type.
- TV home: one row of big tiles (Netflix, YouTube, Prime Video, Disney+, HBO Max), clock top
  right, QR code with "Scan to use your phone as remote" bottom right, title "Clamshell" top left.
  The focused tile is scaled up with a bright ring. Arrow keys move focus, Enter opens
  (POST `/api/open`).
- Remote (Fire TV style): header "Clamshell" + segmented switch `Remote | Pad`. D-pad mode: round
  D-pad with OK in the center; rows Back / Home / ☰; ⏪ / ⏯ / ⏩; 🔉 / 🔇 / 🔊; bottom row
  Keyboard / Link. Pad mode replaces the D-pad with a touchpad surface; the button rows stay.
  The server starts in Pad mode.
  One finger moves the cursor (extra fingers are ignored), tap = click. A short swipe (at most
  300 ms, at least 15 px) that is still faster than 0.4 px/ms at liftoff is a flick and scrolls
  with momentum. A swap button at the end of the Keyboard / Link row switches to the reverse
  layout: volume and Keyboard / Link rows on top, then the D-pad/pad, then a row with Back / Home /
  ☰ as icons and the Remote | Pad switch (it leaves the header), then ⏪ / ⏯ / ⏩ at the very
  bottom. One setting for both modes, kept in localStorage; the reverse layout is the default. Keyboard = live typing (each change is sent immediately). Link = sheet with a
  URL field and "Open on TV". A gear in the header opens the settings sheet: "Sound output" list
  (name, kind, checkmark on the active one); a tap switches the Mac's output. The last row, "Show
  AirPlay devices", runs the Control Center scan only on demand because it flashes on the TV.

## Code conventions

- Plain JavaScript (ESM on the server, classic scripts in the browser), no build step, no TypeScript.
- Every new file starts with a header comment: Purpose, Depends on, Used by, Notes (the why
  behind non-obvious choices). Comments describe the code as it is, no history.
- Never use em dashes or en dashes as punctuation anywhere (code, comments, UI strings).
- Only dependencies: `ws`, `qrcode`. No others.
