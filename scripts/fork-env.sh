# Sourced by the release scripts: reads fork.json (see guides/forking.md) into FORK_* variables.
# Missing file or keys fall back to the upstream defaults.
_fork_root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
eval "$(node -e '
const fs = require("fs");
let f = {};
try { f = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { if (e.code !== "ENOENT") { console.error("fork.json: " + e.message); process.exit(1); } }
const pick = (k, d, re) => { const v = f[k] ?? d; if (typeof v !== typeof d || (re && !re.test(String(v)))) { console.error(`fork.json: bad ${k}`); process.exit(1); } return v; };
const out = {
  FORK_REPO: pick("updateRepo", "", /^(?:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})?$/),
  FORK_BUCKET: pick("updateBucket", "void-portal-updates", /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  FORK_REMOTE: pick("gitRemote", "origin", /^[A-Za-z0-9._-]+$/),
  FORK_R2: pick("publishToR2", true) ? "true" : "false",
};
for (const [k, v] of Object.entries(out)) console.log(`${k}=${JSON.stringify(String(v))}`);
' "$_fork_root/fork.json")"
# gh release flags: publish to the fork's repository when one is set, else gh's default for this checkout.
FORK_GH=()
if [ -n "$FORK_REPO" ]; then FORK_GH=(--repo "$FORK_REPO"); fi
