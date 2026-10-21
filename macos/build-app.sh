#!/bin/sh
# Purpose: Builds "Clamshell.app" from macos/Sources and installs it to /Applications, and builds
#   the sound output helper build/tv-audio (macos/AudioTool) that the server uses.
# Depends on: swiftc (Xcode Command Line Tools), qlmanage + sips + iconutil (icon), codesign,
#   node on the PATH (its absolute path is baked into Info.plist), macos/app-icon.svg.
# Used by: package.json ("npm run app")
# Notes:
# - The app runs the server from this checkout (TVStreamAppRoot), so server and web changes
#   apply after "Restart TV" without rebuilding; only changes in macos/ need a rebuild.
# - TV_STREAM_INSTALL_DIR overrides the target folder; TV_STREAM_SKIP_INSTALL=1 only builds.
# - An existing "Clamshell.app" is only replaced when its bundle identifier is ours.

set -eu

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MACOS_DIR="$APP_ROOT/macos"
BUILD_DIR="$APP_ROOT/build"
BUNDLE="$BUILD_DIR/Clamshell.app"
BUNDLE_ID="local.tvstream.mac"
INSTALL_DIR="${TV_STREAM_INSTALL_DIR:-/Applications}"
VERSION="$(node -p "require('$APP_ROOT/package.json').version")"
NODE_PATH="$(command -v node)"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

echo "Building Clamshell.app $VERSION"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

swiftc -O -swift-version 5 \
  -target "$(uname -m)-apple-macos13.0" \
  -o "$BUNDLE/Contents/MacOS/Clamshell" \
  "$MACOS_DIR"/Sources/*.swift

# Sound output helper for the remote's settings; the server runs it from build/.
swiftc -O -swift-version 5 \
  -target "$(uname -m)-apple-macos13.0" \
  -o "$BUILD_DIR/tv-audio" \
  "$MACOS_DIR"/AudioTool/*.swift

# Icon: render the SVG once at 1024 px, derive the iconset sizes, pack to .icns.
ICON_TMP="$(mktemp -d)"
trap 'rm -rf "$ICON_TMP"' EXIT
qlmanage -t -s 1024 -o "$ICON_TMP" "$MACOS_DIR/app-icon.svg" >/dev/null 2>&1
SRC_PNG="$ICON_TMP/app-icon.svg.png"
[ -f "$SRC_PNG" ] || { echo "Icon rendering failed" >&2; exit 1; }
ICONSET="$ICON_TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/AppIcon.icns"

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Clamshell</string>
  <key>CFBundleDisplayName</key><string>Clamshell</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>Clamshell</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.entertainment</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>TVStreamAppRoot</key><string>$(xml_escape "$APP_ROOT")</string>
  <key>TVStreamNodePath</key><string>$(xml_escape "$NODE_PATH")</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$BUNDLE" >/dev/null
echo "Built $BUNDLE"

[ "${TV_STREAM_SKIP_INSTALL:-}" = "1" ] && exit 0

TARGET="$INSTALL_DIR/Clamshell.app"
if [ -e "$TARGET" ]; then
  EXISTING_ID="$(defaults read "$TARGET/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  if [ "$EXISTING_ID" != "$BUNDLE_ID" ]; then
    echo "$TARGET exists and is not Clamshell ($EXISTING_ID); not replacing it." >&2
    exit 1
  fi
  rm -rf "$TARGET"
fi
ditto "$BUNDLE" "$TARGET"
echo "Installed $TARGET"
