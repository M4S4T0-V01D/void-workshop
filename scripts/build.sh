#!/usr/bin/env bash
# Reproducible production build: locked dependencies, type checks, sidecar + frontend + release binary.
# Output: src-tauri/target/release/void-workshop and sidecar/dist (installed by scripts/install.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" -ne 0 ] || { echo "Do not build as root." >&2; exit 1; }
echo "==> Installing locked dependencies"
npm ci --no-audit --no-fund
npm --prefix sidecar ci --no-audit --no-fund
echo "==> Type-checking"
npm run typecheck
echo "==> Building sidecar"
rm -rf sidecar/dist
npm --prefix sidecar run build
echo "==> Building desktop app (release)"
nice -n 10 npx tauri build --no-bundle
echo
echo "Built: src-tauri/target/release/void-workshop"
echo "Install for your user with: ./scripts/install.sh"
