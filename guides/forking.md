# Running your own fork

A fork can ship its own VOID Workshop and VOID Portal updates under its own names. The fork-specific values live in one file, `fork.json`, and `scripts/fork-setup.sh` writes them into place.

| Key | What it does | Default |
| --- | --- | --- |
| `updateRepo` | `owner/name` of the GitHub repository whose releases carry your desktop updates. `scripts/release.sh` publishes there, and builds use it as their default update source. | empty: this checkout's repo for publishing, the relay for updates |
| `relayUrl` | The default VOID Portal relay address (`wss://…`) built into your builds. | empty: users enter their own |
| `relayWorker` | Name of the Cloudflare Worker in `remote/relay/wrangler.toml`. | `void-relay` |
| `updateBucket` | The R2 bucket holding Portal APKs (and desktop releases, if enabled). Used by `wrangler.toml` and both release scripts. | `void-portal-updates` |
| `gitRemote` | The git remote the release scripts push to. | `origin` |
| `publishToR2` | Whether `scripts/release.sh` also uploads desktop releases to R2 for relay-paired installs. | `true` |

## Steps

1. **Names.** For example:
   `./scripts/fork-setup.sh --repo you/void-workshop --relay wss://my-relay.you.workers.dev --worker my-relay --bucket you-void-updates`
   This updates `fork.json`, `sidecar/src/fork.ts` (the built-in defaults) and `remote/relay/wrangler.toml`. Running it with no options applies `fork.json` again.
2. **Signing key.** Run `./scripts/update-key.sh` once. Installs accept only updates signed with the key pinned in `sidecar/src/updateKey.ts`, so a fork needs its own key. Upstream's key can't sign your releases, and yours can't sign theirs. Back up the key file and its passphrase offline.
3. **Relay** (needed only for VOID Portal or relay updates):
   `cd remote/relay && npx wrangler r2 bucket create <bucket> && npx wrangler deploy`
4. **Commit, build, install:** `./scripts/build.sh && ./scripts/install.sh`.
5. **Release.** Bump the version, add a `CHANGELOG.md` section and commit. Then run `./scripts/release.sh`. It signs the package and attaches it, along with `latest.json`, to a GitHub release `workshop-v<version>` in `updateRepo`. With `publishToR2` on, it also uploads both to your bucket.

## How installs find updates

Under **Settings → Updates**, each user can change the update repository and the relay address. The values in `fork.json` are only the starting point.

- **Update repository set:** Workshop reads that repository's newest `workshop-v*` release that is neither a draft nor a prerelease. Private repositories work while the user is signed in to GitHub (Settings → Accounts). The token is sent only to `api.github.com`.
- **No repository set:** updates come through the relay. This needs a paired phone.

Either way, the signed manifest is checked against the pinned key before anything is downloaded. The package's size and SHA-256 are then checked against it, so pointing an install at another repository cannot get it to install something unsigned.

## VOID Portal (Android)

- Change `applicationId` (and `namespace`) in `remote/android/app/build.gradle.kts` so your app installs alongside upstream's instead of replacing it.
- Sign releases with your own keystore (`remote/android/keystore.properties`, which is git-ignored).
- `remote/android/release.sh` uploads to your `updateBucket` and creates `portal-v*` releases in `updateRepo`.
- Phones get Portal updates through your relay.
