#!/usr/bin/env bash
# Development mode: compiles the sidecar, then runs the Tauri app with the Vite dev server.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" -ne 0 ] || { echo "Do not run VOID Workshop as root." >&2; exit 1; }
[ -d node_modules ] || npm ci
[ -d sidecar/node_modules ] || npm --prefix sidecar ci
npm --prefix sidecar run build
exec npx tauri dev
