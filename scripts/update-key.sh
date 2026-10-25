#!/usr/bin/env bash
# Creates the Ed25519 key that signs desktop releases, once, on the machine you release from.
#   - The private key is generated in a pipe and only ever written encrypted: AES-256 with a scrypt-derived
#     key from your passphrase. It lives outside the repository (default ~/.void-signing/), mode 600.
#   - The public key is written to sidecar/src/updateKey.ts; builds made after that only install updates
#     signed by this key.
# Keep a backup of the key file and the passphrase somewhere offline. Losing either means installed copies
# can no longer be updated automatically (they would need one manual install of a build with a new key).
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="${VOID_SIGNING_KEY:-$HOME/.void-signing/workshop-update.pem}"
PIN=sidecar/src/updateKey.ts
[ ! -e "$KEY" ] || { echo "$KEY already exists; refusing to replace a signing key." >&2; exit 1; }
[ -t 0 ] || { echo "Run this in a terminal: it asks for a passphrase." >&2; exit 1; }

umask 077
mkdir -p "$(dirname "$KEY")"
chmod 700 "$(dirname "$KEY")"
echo "==> Generating the signing key. Choose a long passphrase (it is asked twice)."
openssl genpkey -algorithm ED25519 | openssl pkcs8 -topk8 -v2 aes-256-cbc -scrypt -out "$KEY"
chmod 600 "$KEY"

echo "==> Reading the public key (enter the passphrase once more)"
pub=$(openssl pkey -in "$KEY" -pubout)
case "$pub" in "-----BEGIN PUBLIC KEY-----"*) ;; *) echo "Could not read the public key." >&2; exit 1 ;; esac
node -e '
const fs = require("fs");
const [file, pem] = process.argv.slice(1);
const src = fs.readFileSync(file, "utf8").replace(/export const UPDATE_PUBLIC_KEY: string \| null = [^;]*;/, "export const UPDATE_PUBLIC_KEY: string | null = " + JSON.stringify(pem.trim() + "\n") + ";");
fs.writeFileSync(file, src);' "$PIN" "$pub"
grep -q "BEGIN PUBLIC KEY" "$PIN" || { echo "Could not write $PIN." >&2; exit 1; }

echo
echo "Private key (encrypted): $KEY"
echo "Public key pinned in:    $PIN"
echo "Back up the key file and the passphrase offline, commit $PIN, then build and install once"
echo "(./scripts/build.sh && ./scripts/install.sh). Publish releases with ./scripts/release.sh."
