# Admin dev sessions: working on VOID Workshop and VOID Portal from inside them

An admin dev session (Settings → Admin on the PC, or Settings → Admin in VOID Portal) lets the agent change
VOID Workshop and VOID Portal themselves. The user starts it with their admin password and ends it from
either device; ending it stops tasks still working in it and everything goes back to normal.

While it runs, every task has full access with Auto publishing, this source tree as a writable folder,
Workshop's logs and database readable, and the `restart_workshop` tool. Workshop's credentials, its config
folder (API key, phone pairings, the admin password) and the agent-runtime folder (Claude sign-in) stay off
limits, and so do the usual secrets.

## Layout

| Path | What it is |
| --- | --- |
| `sidecar/src/` | Node backend (the agent, policies, RPC server). `agent.ts` sessions and the approval gate, `commandPolicy.ts` shell command policy, `paths.ts` path policy, `server.ts` RPC methods, `remote.ts` the phone bridge and its allow-lists, `admin.ts` admin sessions, `settings.ts` the settings schema. |
| `src/` | React window (`App.tsx`, `components/`). |
| `src-tauri/src/` | Rust shell: `policy.rs` allow-lists the window's RPC methods (add new ones there too), `sidecar.rs` runs the backend, `restart.rs` installs and restarts. |
| `remote/android/` | VOID Portal (Kotlin, Compose). `Portal.kt` connection and state, `ui/` screens. |
| `remote/relay/` | Cloudflare Worker relay (`wrangler`); rarely needs changes. |
| `remote/PROTOCOL.md` | Phone ↔ PC protocol. |

A new RPC method needs the handler in `server.ts`, the name in `src-tauri/src/policy.rs` (window) and, for the
phone, in `REMOTE_METHODS` in `remote.ts`. A new setting goes in `settings.ts` (schema + default), the window's
Settings and, if the phone may change it, `REMOTE_SETTINGS`.

## Checks

Keep the machine responsive: one test file at a time, niced.

```sh
npm run typecheck                                    # window + sidecar
cd sidecar && nice -n 19 npx vitest run test/agent.test.ts   # one file
npm test                                             # everything, one file at a time (slow)
cd src-tauri && nice cargo test --quiet              # Rust
```

UI text is translated into 13 languages, with the English text as the key. In the window, wrap new text in
`t()` / `tn()` from `src/i18n`, then add it to every `src/i18n/locales/<code>.json` (`npm run i18n` lists what
is missing or stale; `src/i18n/i18n.test.ts` fails until it is complete). In Portal, use `tr()` / `trn()` from
`I18n.kt` and add the text to `app/src/main/assets/i18n/<code>.json`; `I18nTest` checks the keys, placeholders and
plural forms. Keep `{placeholders}` as they are and leave brand names (VOID Portal, Claude, Ollama...) untranslated.

`sidecar/test/live.test.ts` and `portal-e2e.test.ts` are opt-in (`VOID_LIVE_SDK=1`, `VOID_PORTAL_E2E=1`).
`tools/ui-harness/run.mjs e2e` spends real credit: only with the user's OK.

## Desktop: build, install, restart

1. `./scripts/build.sh` (locked installs, type checks, sidecar, release binary; several minutes, give it a long timeout).
2. Call `restart_workshop` with `install: true` as the last thing in your turn, then end the turn with a short summary.
3. Workshop waits until no task is working, quits, runs `scripts/install.sh`, starts again and continues your
   task with a message saying whether the install worked. The install output is in
   `~/.local/share/void-workshop/logs/admin-restart.log`.

Never run `scripts/install.sh` yourself while Workshop runs, and don't kill its processes.

Debugging: `~/.local/share/void-workshop/logs/sidecar.log`, and the database
(`sqlite3 -readonly ~/.local/share/void-workshop/workshop.db`; tables `tasks`, `task_events`, `settings`).

## Desktop: signed releases

Installed copies update themselves from signed releases (Settings → Updates; they also check once shortly
after start). The update goes through the relay to the R2 bucket `void-portal-updates/desktop/`, so only
copies paired with VOID Portal see it.

- Signing key: Ed25519, made once with `./scripts/update-key.sh`. The private key is stored encrypted
  (scrypt + AES-256) in `~/.void-signing/`; the public key is pinned in `sidecar/src/updateKey.ts`.
  Builds only install a manifest signed by that key, only for a newer version, and only when the package's
  sha256 and size match. Never read, print or move the private key or its passphrase; only the user handles them.
- To ship: bump the version (both package.json files and lockfiles, `src-tauri/Cargo.toml` and `Cargo.lock`,
  `tauri.conf.json`, `APP_VERSION` in `sidecar/src/config.ts`), add a `CHANGELOG.md` section and commit, then
  the user runs `./scripts/release.sh` (it asks for the passphrase; `--dry-run` packages and signs only).
- Changes to the relay's update routes need `cd remote/relay && npx wrangler deploy` (also a user step).

## VOID Portal: build and release

```sh
cd remote/android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk nice ./gradlew :app:testDebugUnitTest :app:assembleRelease
```

The default Java breaks the Gradle build; use Java 17 as above. APKs are signed with this machine's debug key,
which must not change (phones only update from the same key).

To ship: bump `versionCode` and `versionName` in `remote/android/app/build.gradle.kts`, commit, then
`remote/android/release.sh "what changed"`. It uploads to the R2 bucket the in-app updater reads and creates the
GitHub release `portal-v<version>`. Phones offer the update on their next start.

## Ground rules

- Keep the normal (non-admin) safeguards working unless the user asks to change them; add tests for policy changes.
- Commit with a clear message when a piece of work is done and tested; push and release only when the task includes it.
