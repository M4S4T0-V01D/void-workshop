#!/usr/bin/env bash
# Publishes a VOID Portal release:
#   1. builds and tests the release APK,
#   2. uploads it to the relay's private R2 bucket (the app's in-app updater downloads it from there),
#   3. creates a GitHub Release on GitHub with the APK attached (a record of every version).
#
# Bump versionCode and versionName in app/build.gradle.kts and commit first, then:
#   remote/android/release.sh "What changed in this version"
set -euo pipefail
cd "$(dirname "$0")"
NOTES="${1:?Usage: release.sh \"release notes\"}"
code=$(grep -oP '^\s*versionCode = \K\d+' app/build.gradle.kts)
name=$(grep -oP '^\s*versionName = "\K[^"]+' app/build.gradle.kts)
tag="portal-v$name"

git diff --quiet HEAD -- . || { echo "Commit your changes first (the release is tagged at HEAD)." >&2; exit 1; }
if gh release view "$tag" >/dev/null 2>&1; then echo "$tag already exists: bump the version first." >&2; exit 1; fi

echo "==> Building VOID Portal $name ($code)"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk}"
nice -n 19 ./gradlew --no-daemon -q :app:testDebugUnitTest :app:assembleRelease
apk=app/build/outputs/apk/release/app-release.apk
sha=$(sha256sum "$apk" | cut -d' ' -f1)
size=$(stat -c %s "$apk")

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$apk" "$tmp/VOID-Portal-$name.apk"
node -e 'const [c, n, s, z, notes] = process.argv.slice(1); process.stdout.write(JSON.stringify({ versionCode: +c, versionName: n, sha256: s, size: +z, notes, publishedAt: new Date().toISOString() }, null, 2) + "\n")' \
  "$code" "$name" "$sha" "$size" "$NOTES" > "$tmp/latest.json"

echo "==> Uploading to R2 (APK first, so the manifest never points at a missing file)"
( cd ../relay
  npx wrangler r2 object put "void-portal-updates/apk/$code.apk" --file "$tmp/VOID-Portal-$name.apk" --content-type application/vnd.android.package-archive --remote
  npx wrangler r2 object put void-portal-updates/latest.json --file "$tmp/latest.json" --content-type application/json --remote )

echo "==> GitHub release $tag"
git push -q origin HEAD
gh release create "$tag" "$tmp/VOID-Portal-$name.apk" --title "VOID Portal $name" --notes "$NOTES" --target "$(git rev-parse HEAD)"
echo "Published VOID Portal $name: phones will offer the update."
