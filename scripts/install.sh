#!/usr/bin/env bash
# Installs the built app for the current user (no root, no system files):
#   ~/.local/lib/void-workshop/{void-workshop,sidecar/}   ~/.local/bin/void-workshop
#   ~/.local/share/applications/void-workshop.desktop    ~/.local/share/icons/hicolor/*/apps/void-workshop.png
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" -ne 0 ] || { echo "Install as your normal user, not root." >&2; exit 1; }
BIN=src-tauri/target/release/void-workshop
[ -x "$BIN" ] || { echo "Build first: ./scripts/build.sh" >&2; exit 1; }
[ -f sidecar/dist/main.js ] || { echo "Sidecar not built: ./scripts/build.sh" >&2; exit 1; }

PREFIX="${PREFIX:-$HOME/.local}"
LIB="$PREFIX/lib/void-workshop"
NODE_BIN="$(command -v node)" || { echo "Node.js not found" >&2; exit 1; }

echo "==> Installing to $LIB"
rm -rf "$LIB.new"
mkdir -p "$LIB.new/sidecar"
install -m 755 "$BIN" "$LIB.new/void-workshop"
cp -r sidecar/dist sidecar/bin sidecar/package.json sidecar/package-lock.json "$LIB.new/sidecar/"
chmod 755 "$LIB.new/sidecar/bin/key-helper.sh"
# Where this build came from: admin dev sessions work on (and reinstall from) this source tree. A signed
# release package (it has a RELEASE file and no sources) keeps the source tree recorded by the last install.
if [ -f RELEASE ]; then
  if [ -f "$LIB/source-dir" ]; then cp "$LIB/source-dir" "$LIB.new/source-dir"; fi
else
  printf '%s\n' "$PWD" > "$LIB.new/source-dir"
fi
(cd "$LIB.new/sidecar" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
rm -rf "$LIB.old"; [ -d "$LIB" ] && mv "$LIB" "$LIB.old"
mv "$LIB.new" "$LIB"; rm -rf "$LIB.old"

mkdir -p "$PREFIX/bin"
sed -e "s|@LIB@|$LIB|g" -e "s|@NODE@|$NODE_BIN|g" scripts/void-workshop.in > "$PREFIX/bin/void-workshop"
chmod 755 "$PREFIX/bin/void-workshop"
install -m 755 scripts/void-workshop-key "$PREFIX/bin/void-workshop-key"

for size in 32 128 256; do
  dir="$PREFIX/share/icons/hicolor/${size}x${size}/apps"; mkdir -p "$dir"
  case $size in 32) src=src-tauri/icons/32x32.png ;; 128) src=src-tauri/icons/128x128.png ;; 256) src=src-tauri/icons/128x128@2x.png ;; esac
  install -m 644 "$src" "$dir/void-workshop.png"
done
mkdir -p "$PREFIX/share/applications"
cat > "$PREFIX/share/applications/void-workshop.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=VOID Workshop
Comment=Local approval-first AI coding workspace
Exec=$PREFIX/bin/void-workshop
Icon=void-workshop
Terminal=false
Categories=Development;IDE;
StartupWMClass=void-workshop
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$PREFIX/share/applications" 2>/dev/null || true
echo "Installed. Start it from your app menu or run: void-workshop"
