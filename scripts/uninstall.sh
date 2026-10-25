#!/usr/bin/env bash
# Removes the installed app. Your data (task history, settings) and API key are kept unless --purge is given.
set -euo pipefail
PREFIX="${PREFIX:-$HOME/.local}"
rm -rf "$PREFIX/lib/void-workshop" "$PREFIX/bin/void-workshop" "$PREFIX/bin/void-workshop-key" "$PREFIX/share/applications/void-workshop.desktop"
for size in 32 128 256; do rm -f "$PREFIX/share/icons/hicolor/${size}x${size}/apps/void-workshop.png"; done
echo "Removed the application files."
if [ "${1:-}" = "--purge" ]; then
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/void-workshop" "${XDG_CONFIG_HOME:-$HOME/.config}/void-workshop"
  command -v secret-tool >/dev/null && secret-tool clear service void-workshop account anthropic-api-key 2>/dev/null || true
  echo "Purged local data, settings and the stored API key. Also revoke the key in the Anthropic Console if you no longer need it."
else
  echo "Kept data in ~/.local/share/void-workshop and settings/key. Run with --purge to delete them too."
fi
