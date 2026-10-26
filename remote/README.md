# VOID Portal

Remote control for VOID Workshop from an Android phone, anywhere: start tasks, queue messages, approve changes and commands (also straight from a notification), switch between your Claude plan, API key and Ollama, change model, mode and effort, and hear when a task is done, needs you, or when the PC goes offline or comes back.

```
 phone (VOID Portal) ──wss──►  relay (Cloudflare Worker)  ◄──wss── PC (VOID Workshop)
          └──────────── end-to-end encrypted (AES-256-GCM) ────────────┘
```

Both ends connect *out* to the relay, so nothing on the home network is exposed. The relay only forwards sealed frames; it never sees the pairing secret or the keys. See [PROTOCOL.md](PROTOCOL.md).

| Folder | What |
|---|---|
| `relay/` | Cloudflare Worker + Durable Object (`void-relay`) that you deploy to your own Cloudflare account (see [Your own relay](#your-own-relay)); can also serve app updates from R2 |
| `android/` | The VOID Portal app (Kotlin, Jetpack Compose, OkHttp, CameraX + bundled ML Kit for scanning) |
| `sounds/` | `make_sounds.py`: synthesises the notification sounds and the ambient drone |
| `test-vectors.json` | Crypto test vector checked by both the PC (`sidecar/test/remote.test.ts`) and the app (`PortalCryptoTest`) |

The PC side lives in `sidecar/src/remote.ts` (bridge, allow-list, notifications) and `sidecar/src/remoteCrypto.ts`.

## Your own relay

VOID Workshop has no built-in relay: everyone runs their own, on their own free Cloudflare account. It takes a few minutes, and the relay only ever sees encrypted frames.

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) and pick a `workers.dev` subdomain (Workers & Pages → the subdomain shown on the overview page).
2. Deploy the Worker:

   ```bash
   cd remote/relay
   npm install
   npx wrangler login     # opens the browser once to authorise wrangler
   npx wrangler deploy
   ```

   Wrangler prints the address, e.g. `https://void-relay.<your-subdomain>.workers.dev`. Durable Objects on the free plan need the SQLite storage backend; `wrangler.toml` already declares it.
3. Optional, only if you want to publish app updates through your relay: `npx wrangler r2 bucket create void-portal-updates`. Without it, remove the `[[r2_buckets]]` block from `wrangler.toml` before deploying; the relay then simply reports that no update is available.
4. Check it: `node test/smoke.mjs wss://void-relay.<your-subdomain>.workers.dev`.
5. In VOID Workshop → **Settings → VOID Portal (phone)** → **Relay**, enter the address with `wss://` instead of `https://` and save. **Pair a phone** becomes available.

To use another name, change `name` in `wrangler.toml`; the address follows it. If a pairing code ever leaks, unpair the phone in Settings: the secret is per pairing, and the relay cannot read your traffic either way.

## Use

1. VOID Workshop → **Settings → VOID Portal (phone)** → **Pair a phone**. Turn on *Keep running in the background* and *Start at login* so the phone can reach it while the window is closed.
2. Install the APK on the phone, open **VOID Portal**, tap **Scan pairing code**. The code disappears from the PC once the phone connects. For a relay on a plain `wss://host` address the code is `VOIDPORTAL://P/<secret>/<HOST>`: short and upper case, so QR stores it in its coarse alphanumeric mode (33×33 instead of 45×45 modules), which phones read easily off a monitor. If a scan still fails, copy the link shown under the code and paste it into the app.
3. In VOID Portal → Settings, tap **Let it run in the background** so Android doesn't delay notifications.

What the phone may do is an allow-list: tasks, queue, approvals, plan approval, compact, model/mode/effort/fast mode, and the Claude plan / API key / Ollama switch. Keys, sign-in, spending limits, safety settings, project access, the terminal and commits stay on the PC. New tasks can only start in projects already opened on the PC.

## Language

VOID Portal comes in the same 13 languages as VOID Workshop and the website (Arabic right-to-left). It asks on first start, defaulting to the phone's language, and *Settings → Language* changes it any time. The catalogs are `app/src/main/assets/i18n/<code>.json`, keyed by the English text; `I18nTest` keeps them complete.

## Themes

VOID Portal has the desktop's themes (generated from `src/themes.ts`, so the two apps stay in step) and **Match my PC** (the default), which follows the PC's current theme, custom ones included. The interface, the drifting background, the logo and, optionally, the launcher icon all take the theme's colours: each built-in theme has its own icon (an `<activity-alias>` per theme; the app enables the matching one).

```bash
node --experimental-strip-types remote/android/art/gen_themes.mjs   # after changing the desktop's themes
cd remote/android && python3 art/gen_icon.py                         # icons + manifest aliases for every theme
```

## Updates

Releases live in the relay's private R2 bucket (`void-portal-updates`); only a paired phone can fetch them, with its channel token. The app checks when it opens (at most every 3 hours) and twice a day in the background, shows a banner and a notification, and on **Update** downloads the APK, checks its SHA-256 and hands it to Android's installer (which asks you to confirm, as Android always does for apps outside a store; the first time it also asks you to allow installs from VOID Portal). Every release can also be published as a GitHub Release.

To publish: bump `versionCode`/`versionName` in `app/build.gradle.kts`, commit, then

```bash
remote/android/release.sh "What changed"
```

Releases must be signed with the same key as the installed app: your `keystore.properties` key, or the debug key (`~/.android/debug.keystore`) if you have none. Back that key up; without it, phones need a reinstall.

## Build and deploy

```bash
# Relay (once, and after changes)
cd remote/relay && npm install && npx wrangler deploy
node test/smoke.mjs wss://void-relay.<your-subdomain>.workers.dev   # 18 checks against your deployed relay

# App (JDK 17)
cd remote/android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew :app:testDebugUnitTest :app:assembleRelease
# → app/build/outputs/apk/release/app-release.apk  (signed with keystore.properties if present, else the debug key)

# Logo and sounds
python3 art/gen_icon.py                       # in remote/android: icon layers from one geometry
python3 remote/sounds/make_sounds.py remote/sounds/out && cp remote/sounds/out/*.ogg remote/android/app/src/main/res/raw/

# Scanner check on a device/emulator: ML Kit on simulated phone photos of the code (blur, tilt, glare, moiré)
python3 art/gen_qr_photos.py                  # in remote/android: regenerates those photos (placeholder relay)
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew :app:connectedDebugAndroidTest

# End to end through the real relay with a phone/emulator (simulated model, no API use)
cd sidecar && VOID_PORTAL_E2E=1 VOID_PORTAL_LINK_FILE=/tmp/link npx vitest run test/portal-e2e.test.ts

# Screenshots (docs/screenshots/portal-*.png): a demo PC on a local relay, no real relay or API.
# Debug builds allow ws:// to 127.0.0.1 only (src/debug/res/xml/network_security_config.xml).
cd remote/relay && npx wrangler dev --ip 127.0.0.1 --port 8787 &
adb reverse tcp:8787 tcp:8787                 # with the emulator or phone attached, debug APK + test APK installed
cd sidecar && VOID_PORTAL_SHOTS=1 VOID_RELAY=ws://127.0.0.1:8787 VOID_PORTAL_LINK_FILE=/tmp/shots npx vitest run test/portal-shots.test.ts &
read R S < /tmp/shots && adb shell am instrument -w -e class dev.m4s4t0.voidportal.PortalShotsPair \
  -e portalShotsRelay $R -e portalShotsSecret $S dev.m4s4t0.voidportal.test/androidx.test.runner.AndroidJUnitRunner
adb shell am start -n dev.m4s4t0.voidportal/.MainActivity   # then capture with adb exec-out screencap -p; touch /tmp/shots.done to stop
```

## Sounds

| Sound | When |
|---|---|
| `spell_done` | a task finished |
| `spell_approval` | an approval or a plan is waiting; problems |
| `portal_open` | the PC came online |
| `portal_close` | the PC went offline (also detected without a goodbye, from a missing 30 s heartbeat) |
| `ambient_drone` | 40 s seamless loop while the app is open (mute it on the home screen) |
| `send_zap` | in the app: you sent a message |
| `queue_plink` | in the app: you queued a message while the agent works |
| `task_launch` | in the app: a new task started |

Notification sounds can be replaced on the phone (Settings → Sounds); the interface sounds have an on/off switch there and stay quiet when the phone is on silent or vibrate.
