#!/bin/sh
# VOID Workshop API key helper, used as the Agent SDK's `apiKeyHelper`.
# Prints the stored Anthropic Console API key to stdout and nothing else. It never logs the key.
# Lookup order: Secret Service (KWallet / GNOME Keyring), then the 0600 key file.
set -u
umask 077

backend="${VOID_WORKSHOP_KEY_BACKEND:-auto}"
key=""

if [ "$backend" != "file" ] && command -v secret-tool >/dev/null 2>&1; then
  key=$(secret-tool lookup service void-workshop account anthropic-api-key 2>/dev/null) || key=""
fi

if [ -z "$key" ] && [ "$backend" != "secret-service" ]; then
  file="${VOID_WORKSHOP_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/void-workshop/credentials/anthropic-api-key}"
  if [ -f "$file" ]; then
    perms=$(stat -c %a "$file" 2>/dev/null || echo unknown)
    case "$perms" in
      600|400) key=$(cat "$file") ;;
      *) echo "void-workshop: refusing key file with permissions $perms (must be 600)" >&2; exit 2 ;;
    esac
  fi
fi

if [ -z "$key" ]; then
  echo "void-workshop: no API key configured" >&2
  exit 1
fi

printf '%s' "$key"
