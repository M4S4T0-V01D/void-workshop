#!/usr/bin/env bash
# Makes this checkout your own fork's build: records your names in fork.json and writes them where they are
# used. Run with any of the options to change them, or with none to apply fork.json again.
#   --repo owner/name    GitHub repository whose releases carry your desktop updates (also where
#                        release.sh publishes); built in as the default update source
#   --relay wss://…      your VOID Portal relay, built in as the default relay address
#   --worker name        Cloudflare Worker name for the relay (remote/relay/wrangler.toml)
#   --bucket name        R2 bucket for Portal and desktop update files (wrangler.toml, release scripts)
#   --remote name        git remote the release scripts push to
#   --no-r2 / --r2       whether release.sh also uploads desktop releases to R2 (off: GitHub releases only)
# Then make your own signing key once (./scripts/update-key.sh), commit, build and install.
set -euo pipefail
cd "$(dirname "$0")/.."
node - "$@" <<'JS'
const fs = require('fs');
const args = process.argv.slice(2);
const file = 'fork.json';
const f = Object.assign(
  { updateRepo: '', relayUrl: '', relayWorker: 'void-relay', updateBucket: 'void-portal-updates', gitRemote: 'origin', publishToR2: true },
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {},
);
const flags = { '--repo': 'updateRepo', '--relay': 'relayUrl', '--worker': 'relayWorker', '--bucket': 'updateBucket', '--remote': 'gitRemote' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--no-r2') f.publishToR2 = false;
  else if (a === '--r2') f.publishToR2 = true;
  else if (flags[a] && i + 1 < args.length) f[flags[a]] = args[++i].trim();
  else {
    console.error(`Unknown option ${a}. See the comment at the top of scripts/fork-setup.sh.`);
    process.exit(2);
  }
}
const check = (ok, msg) => {
  if (!ok) {
    console.error(msg);
    process.exit(1);
  }
};
check(/^(?:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})?$/.test(f.updateRepo), '--repo must be owner/name.');
check(f.relayUrl === '' || /^wss:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[\w./-]*)?$/.test(f.relayUrl), '--relay must be a wss:// address.');
check(/^[a-z0-9][a-z0-9-]{0,62}$/.test(f.relayWorker), '--worker: lowercase letters, digits and dashes.');
check(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(f.updateBucket), '--bucket: 3-63 lowercase letters, digits and dashes.');
check(/^[A-Za-z0-9._-]+$/.test(f.gitRemote), '--remote is not a git remote name.');
fs.writeFileSync(file, JSON.stringify(f, null, 2) + '\n');

const forkTs = 'sidecar/src/fork.ts';
const ts = fs.readFileSync(forkTs, 'utf8');
const next = ts.replace(/(updateRepo: )[^,\n]*,/, `$1${JSON.stringify(f.updateRepo).replace(/"/g, "'")},`).replace(/(relayUrl: )[^,\n]*,/, `$1${JSON.stringify(f.relayUrl).replace(/"/g, "'")},`);
check(next.includes(`updateRepo: '${f.updateRepo}'`) && next.includes(`relayUrl: '${f.relayUrl}'`), `Could not update ${forkTs}.`);
fs.writeFileSync(forkTs, next);

const toml = 'remote/relay/wrangler.toml';
const w = fs.readFileSync(toml, 'utf8');
const w2 = w.replace(/^name = "[^"]*"/m, `name = "${f.relayWorker}"`).replace(/^bucket_name = "[^"]*"/m, `bucket_name = "${f.updateBucket}"`);
check(w2.includes(`name = "${f.relayWorker}"`) && w2.includes(`bucket_name = "${f.updateBucket}"`), `Could not update ${toml}.`);
fs.writeFileSync(toml, w2);

console.log(`fork.json:          ${JSON.stringify(f)}`);
console.log(`Built-in defaults:  ${forkTs}`);
console.log(`Relay Worker:       ${toml} (deploy: cd remote/relay && npx wrangler r2 bucket create ${f.updateBucket} && npx wrangler deploy)`);
console.log('Next: ./scripts/update-key.sh once if you have no signing key, commit, then ./scripts/build.sh && ./scripts/install.sh.');
JS
