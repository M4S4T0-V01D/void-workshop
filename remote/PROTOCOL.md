# VOID Portal protocol (v1)

Three parts: **VOID Workshop** on the PC (the *host*, in `sidecar/src/remote.ts`), the **VOID Portal** phone app (the *phone*, in `remote/android`), and a **relay** on Cloudflare Workers (`remote/relay`) that forwards frames between them. Both ends connect outward to the relay, so nothing on the home network is exposed.

## Pairing

The PC creates a random 32-byte **secret** per phone and shows it as a QR code:

    voidportal://pair?v=1&r=<relay wss url>&s=<secret, base64url>&n=<PC name>

Both ends derive, with HKDF-SHA256 (salt `void-remote-v1`):

| info | bytes | use |
|---|---|---|
| `channel` | 16 | channel id, hex: `/v1/channel/<id>` |
| `token` | 32 | relay bearer token, base64url (43 chars) |
| `host->phone` | 32 | AES-256-GCM key, PC → phone |
| `phone->host` | 32 | AES-256-GCM key, phone → PC |

The relay stores only `SHA-256(token)` (claimed by the PC's first connection), so it can authenticate both ends but never sees the secret or the keys. Removing a phone on the PC deletes the channel on the relay.

## Relay frames (plain JSON over the WebSocket)

    GET wss://<relay>/v1/channel/<id>?role=host|phone      Authorization: Bearer <token>

| frame | direction | meaning |
|---|---|---|
| `{"t":"msg","d":"<sealed>"}` | both | forwarded to the other role |
| `{"t":"msg","d":"…","keep":true}` | host → relay | also kept (max 50, 24 h) while no phone is connected; delivered with `"kept":true` when it connects |
| `{"t":"peer","role":"host","online":true}` | relay → phone | the PC connected or disconnected (also sent on connect) |
| `{"t":"ping"}` → `{"t":"pong"}` | both | keep-alive, answered by the relay without waking it |

## Sealed messages

`d` = base64url(nonce[12] ‖ AES-256-GCM ciphertext ‖ tag[16]), AAD = `<channel id>:h2p` or `<channel id>:p2h`. The plaintext is JSON:

Phone → PC

    {"type":"call","id":"<uuid>","ts":<ms>,"method":"task.send","params":{…}}

The PC rejects calls older than 5 minutes, repeated ids, and methods outside its remote allow-list.
Admin calls (`admin.status`, `admin.start {password}`, `admin.end`, `admin.setPassword {password, current}`) are always
marked as coming from the phone, which can change the admin password but never set the first one. `settings.update`
accepts the keys in `REMOTE_SETTINGS` (sidecar/src/remote.ts); a patch that touches a safety setting (`fullAccess`,
`autoPublish`, `sandboxCommands`, `allowPublishCommands`, `gradleBuilds`) must carry `adminPassword` unless an admin
session is running.

Pictures shared to the phone go up one per call with `image.upload {data: base64}` (PNG/JPEG/GIF/WebP, at most
512 KiB so the sealed frame stays under the relay's 1 MiB), which answers `{imageId, mediaType, bytes}`. They go with
the next message through `imageIds` on `task.start` / `task.send` (at most 4); unused uploads are deleted after a day.
`review.commit {taskId, paths, message}` commits files that task changed, in its own project; nothing is pushed.

PC → phone

    {"type":"reply","id":"<call id>","ok":true,"result":…}  |  {"type":"reply","id":…,"ok":false,"error":{"code","message"}}
    {"type":"event","event":"task.updated","payload":…}      (only while a phone is connected; also settings.changed, admin.changed, admin.restartPending, admin.restarting)
    {"type":"notify","kind":"done|approval|alert","title":…,"body":…,"taskId":…,"ts":…}   (sent with keep)
    {"type":"hb","ts":<ms>}                                    every 30 s; the phone treats ~75 s of silence as "PC offline"
