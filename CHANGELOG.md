# VOID Workshop changelog

Desktop app versions (VOID Portal, the phone app, has its own `portal-v*` releases).

## 0.3.0 (2026-10-24)

### Updates
- Signed desktop updates (Settings → Updates): releases are signed with an Ed25519 key and checked against the
  key built into the app, along with the package's checksum and size; older versions are never offered.
- A quiet check shortly after start mentions a new release once; the result of the last install shows after the restart.
- `scripts/update-key.sh` creates the signing key (stored encrypted); `scripts/release.sh` signs and publishes a release.

### VOID Portal 1.9.0
- Token saver switch and the "implement approved plans with" model in PC settings.
- Search all tasks on the PC from the home screen.
- Save a task as Markdown or share it as text (long tasks are cut on the phone; export them on the PC for all of it).

### Code
- `App.tsx` split into hooks (`useToasts`, `useAppearance`, `useRuns`, `useUpdateNotice`).

## 0.2.0 (2026-10-24)

### Pictures
- Screenshots show in the desktop chat (the shell blocked the call that loads them).
- Full-size view: click a picture to open it, switch between fit and actual size, copy it or save it to Downloads.
- Paste, drop or attach pictures in the prompt box; large ones are scaled down before sending.
- Pictures load lazily as they scroll into view and are cached; long conversations render faster.
- The image store is capped at 1 GB; the oldest tasks' pictures go first.

### Token efficiency
- Token saver (Settings → Speed, on by default): compacts the context at 120k tokens, trims command output and adds rules that keep the context small.
- Optional cheaper model for implementing an approved plan (e.g. plan with Opus, implement with Sonnet).
- Token usage dashboard (status bar → Tokens): the last 30 days, the last 7 days per model, and where the weight goes.

### Tasks
- Search sessions by title, prompt or message text.
- Export a task as Markdown (copy, or save to Downloads).

### Reliability
- Calls the shell rejects show an error instead of failing silently; the window's calls are type-checked against the shell's allow-list and tested.
- The sidecar log rotates while running, not only at start.
- Window UI tests (session search, usage dashboard, picture view).

### Code
- Agent prompts moved to `sidecar/src/prompts.ts`; settings sections split into `src/components/settings/`.

## 0.1.0

First release.
