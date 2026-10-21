#!/bin/sh
# Purpose: One-step setup on a new Mac: checks the prerequisites (offering to install the missing
#   ones), installs the npm packages, builds Clamshell.app into /Applications and opens it.
# Depends on: macos/build-app.sh ("npm run app"), package-lock.json; Homebrew is used only when
#   present and only after asking.
# Used by: the user, from the app folder: "sh setup.sh" (see README "Quick start on another Mac").
# Notes:
# - The installed app runs the code from this folder, so the folder must stay where it is; after
#   moving it, run this script again.
# - Xcode Command Line Tools cannot be installed silently: the script starts Apple's installer
#   and asks to run it again afterwards.
# - Flags: --yes answers all install questions with yes, --no-open skips opening the app.
#   TV_STREAM_INSTALL_DIR overrides the target folder (default /Applications, or ~/Applications
#   when /Applications is not writable).

set -eu

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSUME_YES=0
OPEN_APP=1
MIN_NODE_MAJOR=22

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-open) OPEN_APP=0 ;;
    *) echo "Unknown option: $arg (use --yes, --no-open)" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nSetup stopped: %s\n' "$1" >&2; exit 1; }

# Asks a yes/no question on the terminal (also when the script is piped); default is no.
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [y/N] ' "$1"
  answer=""
  read -r answer < /dev/tty || answer=""
  case "$answer" in y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac
}

has_brew() { command -v brew >/dev/null 2>&1; }

[ "$(uname -s)" = "Darwin" ] || fail "Clamshell runs on macOS only."

step "Checking Xcode Command Line Tools (Swift compiler for the Mac app)"
if xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null 2>&1; then
  echo "ok: $(swiftc --version 2>/dev/null | head -1)"
else
  echo "Missing. Starting Apple's installer..."
  xcode-select --install >/dev/null 2>&1 || true
  fail "finish the Command Line Tools installation in the window that opened, then run this script again."
fi

step "Checking Node.js ($MIN_NODE_MAJOR or newer)"
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
  if has_brew && confirm "Node.js $MIN_NODE_MAJOR+ is missing. Install it with Homebrew (brew install node)?"; then
    brew install node
  else
    fail "install Node.js $MIN_NODE_MAJOR or newer (https://nodejs.org or 'brew install node'), then run this script again."
  fi
fi
echo "ok: node $(node -v) at $(command -v node)"

step "Checking Google Chrome"
if [ -d "/Applications/Google Chrome.app" ] || [ -n "${TV_STREAM_CHROME_PATH:-}" ]; then
  echo "ok"
elif has_brew && confirm "Google Chrome is missing. Install it with Homebrew (brew install --cask google-chrome)?"; then
  brew install --cask google-chrome
else
  fail "install Google Chrome into /Applications (https://www.google.com/chrome), then run this script again."
fi

step "Installing npm packages"
cd "$APP_DIR"
npm ci --no-audit --no-fund

step "Building and installing Clamshell.app"
if [ -z "${TV_STREAM_INSTALL_DIR:-}" ]; then
  if [ -w /Applications ]; then
    TV_STREAM_INSTALL_DIR=/Applications
  else
    TV_STREAM_INSTALL_DIR="$HOME/Applications"
    echo "/Applications is not writable for this user, installing to $TV_STREAM_INSTALL_DIR"
  fi
fi
mkdir -p "$TV_STREAM_INSTALL_DIR"
export TV_STREAM_INSTALL_DIR
npm run --silent app

APP_PATH="$TV_STREAM_INSTALL_DIR/Clamshell.app"
cat <<EOF

Clamshell is installed: $APP_PATH
It runs the code in $APP_DIR, so keep this folder where it is.

First start, macOS will ask:
  - whether node may accept incoming network connections: allow, or the phone cannot connect
  - for your password, to keep the Mac awake with the lid closed (also on battery)
  - later, for Accessibility, when you search AirPlay devices from the remote
Then scan the QR code on the TV with your phone.
EOF

if [ "$OPEN_APP" = 1 ]; then
  open "$APP_PATH"
fi
