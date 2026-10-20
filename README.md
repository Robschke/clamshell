# TV Stream

Turns the MacBook into a streaming device. Chrome runs fullscreen on the HDMI display with a TV
home screen (Netflix, YouTube TV, Prime Video, Disney+, HBO Max), and the phone is the remote.
Design and protocol: [docs/architecture.md](docs/architecture.md).

## Requirements

- macOS, Node 22 or newer, Google Chrome in /Applications
- Phone and Mac on the same Wi-Fi

## Run

```sh
cd app
npm install
npm start        # kiosk fullscreen on the HDMI display (built-in display if none)
npm run dev      # normal 1280x720 window, for trying things out
```

Then scan the QR code on the TV with the phone, or open `http://<mac-name>.local:8787/remote/`.
In Safari, "Share → Add to Home Screen" makes the remote a full-screen app.

On first start macOS asks whether node may accept incoming network connections: allow it, or the
phone cannot reach the remote.

## Mac app

```sh
npm run app      # builds "TV Stream.app" and installs it to /Applications
```

Then open TV Stream from Spotlight (Cmd+Space), Launchpad or the Applications folder. It starts
the server and the TV, shows a Dock icon and a TV icon in the menu bar:

- Menu bar / Dock menu: status, "Show Remote QR Code…", "Restart TV", "Quit TV Stream".
- Clicking the Dock icon brings the TV window to the front.
- Quit (Cmd+Q or the menu) stops the server and closes the TV window.
- Server output goes to `~/Library/Logs/TV Stream/server.log`; a crashed server is restarted.

The app runs the code in this folder, so server and web changes need only "Restart TV". Changes
in `macos/` need `npm run app` again. If a server is already running in a terminal, the app says
so and quits; stop the terminal one first.

## Stop

Mac app: quit it (Cmd+Q, Dock or menu bar). Terminal: `Ctrl+C` stops the server and closes the
TV window. Quitting only Chrome is not enough: the server relaunches it. In kiosk mode, `Cmd+Tab`
switches back to the terminal.

## Lid closed

macOS keeps running with the lid closed when the Mac is on power and an external display is
connected (clamshell mode). The server keeps the Mac awake (`caffeinate`) while it runs.

## First use

The TV uses its own Chrome profile (`~/Library/Application Support/TV Stream/chrome-profile`), so
sign in to each service once on the TV. Switch the remote to Pad mode and use the Keyboard button
for login forms. YouTube TV offers sign-in with a code on the phone.

## Settings (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `TV_STREAM_PORT` | 8787 | HTTP and WebSocket port |
| `TV_STREAM_CDP_PORT` | 9222 | Chrome DevTools port (localhost only) |
| `TV_STREAM_PROFILE_DIR` | see above | Chrome profile directory |
| `TV_STREAM_WINDOWED` | off | `1` = normal window instead of kiosk |
| `TV_STREAM_HEADLESS` | off | `1` = no window, for automated tests |
| `TV_STREAM_CHROME_PATH` | Chrome in /Applications | Chrome binary |
| `TV_STREAM_OVERLAY_PATH` | `src/inject/tv-overlay.js` | Injected overlay script |

Anyone on the same network who opens the remote URL can control the TV.
