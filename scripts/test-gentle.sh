#!/usr/bin/env bash
# Runs every automated test suite one file at a time, niced, memory-capped and time-limited,
# so the machine stays responsive. Live SDK checks are opt-in: VOID_LIVE_SDK=1 ./scripts/test-gentle.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export NODE_OPTIONS="--max-old-space-size=2048"
fail=0
run() { echo "── $*"; nice -n 19 timeout 600 "$@" || fail=1; }

for f in sidecar/test/*.test.ts; do
  [ "$(basename "$f")" = "live.test.ts" ] && [ "${VOID_LIVE_SDK:-0}" != "1" ] && continue
  (cd sidecar && run npx vitest run "test/$(basename "$f")")
done
for f in src/*.test.ts src/**/*.test.tsx; do
  [ -f "$f" ] && run npx vitest run "$f"
done
(cd src-tauri && run cargo test --quiet)
[ $fail -eq 0 ] && echo "All test suites passed." || { echo "Some tests failed." >&2; exit 1; }
