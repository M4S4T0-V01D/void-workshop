#!/usr/bin/env bash
# Publishes a signed VOID Workshop desktop release:
#   1. builds (./scripts/build.sh) and packages the install tree with a RELEASE marker,
#   2. signs a manifest {product, version, sha256, size, notes, date} with the Ed25519 key from
#      ./scripts/update-key.sh (asks for its passphrase) and checks the signature against the pinned key,
#   3. uploads the package, then the manifest, to the relay's private R2 bucket (desktop/), where installed
#      copies paired with VOID Portal find it (Settings → Updates),
#   4. creates a GitHub Release workshop-v<version> on GitHub as a record.
#
# Bump the version (package.json files, Cargo, tauri.conf.json, sidecar/src/config.ts), add a CHANGELOG.md
# section and commit first, then:   ./scripts/release.sh            (or --dry-run: package and sign only)
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=false
[ "${1:-}" = "--dry-run" ] && DRY=true
KEY="${VOID_SIGNING_KEY:-$HOME/.void-signing/workshop-update.pem}"
PIN=sidecar/src/updateKey.ts

version=$(grep -oP "^export const APP_VERSION = '\K[0-9]+\.[0-9]+\.[0-9]+" sidecar/src/config.ts)
for f in package.json sidecar/package.json src-tauri/tauri.conf.json; do
  grep -q "\"version\": \"$version\"" "$f" || { echo "$f is not at version $version." >&2; exit 1; }
done
grep -q "^version = \"$version\"" src-tauri/Cargo.toml || { echo "src-tauri/Cargo.toml is not at version $version." >&2; exit 1; }
tag="workshop-v$version"
[ -f "$KEY" ] || { echo "No signing key at $KEY: run ./scripts/update-key.sh first." >&2; exit 1; }
grep -q "BEGIN PUBLIC KEY" "$PIN" || { echo "$PIN has no public key: run ./scripts/update-key.sh first." >&2; exit 1; }
notes=$(awk -v v="$version" '$0 ~ "^## " v "( |$)" {on=1; next} on && /^## / {exit} on' CHANGELOG.md | sed '/./,$!d')
[ -n "$notes" ] || { echo "CHANGELOG.md has no section for $version." >&2; exit 1; }
if ! $DRY; then
  git diff --quiet HEAD || { echo "Commit your changes first (the release is tagged at HEAD)." >&2; exit 1; }
  if gh release view "$tag" >/dev/null 2>&1; then echo "$tag already exists: bump the version first." >&2; exit 1; fi
fi

./scripts/build.sh

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tree="$tmp/tree"
mkdir -p "$tree/scripts" "$tree/src-tauri/target/release" "$tree/src-tauri/icons" "$tree/sidecar"
cp scripts/install.sh scripts/void-workshop.in scripts/void-workshop-key "$tree/scripts/"
cp src-tauri/target/release/void-workshop "$tree/src-tauri/target/release/"
cp src-tauri/icons/32x32.png src-tauri/icons/128x128.png src-tauri/icons/128x128@2x.png "$tree/src-tauri/icons/"
cp -r sidecar/dist sidecar/bin sidecar/package.json sidecar/package-lock.json "$tree/sidecar/"
printf '%s\n' "$version" > "$tree/RELEASE"
pkg="$tmp/void-workshop-$version.tar.gz"
tar -C "$tree" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$(git log -1 --format=%ct)" -czf "$pkg" .
sha=$(sha256sum "$pkg" | cut -d' ' -f1)
size=$(stat -c %s "$pkg")

node -e 'const [v, s, z, n] = process.argv.slice(1); process.stdout.write(JSON.stringify({ product: "void-workshop-desktop", version: v, sha256: s, size: +z, notes: n, date: new Date().toISOString() }))' \
  "$version" "$sha" "$size" "$notes" > "$tmp/manifest.json"
echo "==> Signing $version (enter the signing key's passphrase)"
openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$tmp/manifest.json" -out "$tmp/manifest.sig"
# The pinned key must accept it, or installed copies would refuse the release.
node -e 'const fs = require("fs"); const m = fs.readFileSync(process.argv[1], "utf8").match(/"(-----BEGIN PUBLIC KEY-----[^"]+)"/); process.stdout.write(JSON.parse(`"${m[1]}"`))' "$PIN" > "$tmp/pinned.pem"
openssl pkeyutl -verify -rawin -pubin -inkey "$tmp/pinned.pem" -in "$tmp/manifest.json" -sigfile "$tmp/manifest.sig" >/dev/null ||
  { echo "The signature does not verify against $PIN: wrong key?" >&2; exit 1; }
node -e 'const fs = require("fs"); const [m, s] = process.argv.slice(1); process.stdout.write(JSON.stringify({ manifest: fs.readFileSync(m).toString("base64"), signature: fs.readFileSync(s).toString("base64") }) + "\n")' \
  "$tmp/manifest.json" "$tmp/manifest.sig" > "$tmp/latest.json"

if $DRY; then
  out=release-out/$version
  rm -rf "$out"; mkdir -p "$out"
  cp "$pkg" "$tmp/latest.json" "$out/"
  echo "Dry run: signed package and manifest in $out (nothing uploaded)."
  exit 0
fi

echo "==> Uploading to R2 (package first, so the manifest never points at a missing file)"
( cd remote/relay
  npx wrangler r2 object put "void-portal-updates/desktop/$version.tar.gz" --file "$pkg" --content-type application/gzip --remote
  npx wrangler r2 object put void-portal-updates/desktop/latest.json --file "$tmp/latest.json" --content-type application/json --remote )

echo "==> GitHub release $tag"
git push -q origin HEAD
gh release create "$tag" "$pkg" "$tmp/latest.json" --title "VOID Workshop $version" --notes "$notes" --target "$(git rev-parse HEAD)"
echo "Published VOID Workshop $version: paired installs will offer the update."
