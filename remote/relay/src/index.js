import { DurableObject } from "cloudflare:workers";

// Blind relay for VOID Portal. The PC ("host") and phone ("phone") each open a WebSocket to
// /v1/channel/<id>; the Channel object forwards {t:"msg", d} frames between the two roles.
// `d` is AES-GCM ciphertext made with keys only the two ends hold (see ../PROTOCOL.md), so the
// relay can neither read nor forge messages. It stores only a SHA-256 of the channel token and,
// while the phone is away, a short buffer of sealed notification frames.

const MAX_FRAME = 1024 * 1024;
const KEEP_MAX = 50;
const KEEP_MS = 24 * 60 * 60 * 1000;
const IDLE_DELETE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PHONES = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("VOID relay\n", { headers: { "content-type": "text/plain" } });
    }
    const m = url.pathname.match(/^\/v1\/channel\/([0-9a-f]{32})$/);
    if (m) return env.CHANNEL.get(env.CHANNEL.idFromName(m[1])).fetch(request);
    if (url.pathname.startsWith("/v1/update/")) return update(request, env, url);
    return new Response("Not found", { status: 404 });
  },
};

// App updates for paired devices only: the phone (or the paired PC, for desktop releases) proves it holds a
// channel token (the same check as the relay itself), then gets a release manifest or package from the
// private R2 bucket. Desktop manifests are Ed25519-signed; the app checks them, so the bucket is not trusted.
async function update(request, env, url) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const channel = request.headers.get("x-void-channel") ?? "";
  if (!/^[0-9a-f]{32}$/.test(channel)) return new Response("Unauthorized", { status: 401 });
  const verify = await env.CHANNEL.get(env.CHANNEL.idFromName(channel)).fetch(`https://relay/v1/channel/${channel}?verify=1`, {
    headers: { authorization: request.headers.get("authorization") ?? "" },
  });
  if (verify.status !== 204) return new Response("Forbidden", { status: 403 });

  if (url.pathname === "/v1/update/latest.json") {
    const obj = await env.UPDATES.get("latest.json");
    if (!obj) return new Response("No release yet", { status: 404 });
    return new Response(obj.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  if (url.pathname === "/v1/update/desktop/latest.json") {
    const obj = await env.UPDATES.get("desktop/latest.json");
    if (!obj) return new Response("No release yet", { status: 404 });
    return new Response(obj.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  const desktop = url.pathname.match(/^\/v1\/update\/desktop\/(\d{1,4}\.\d{1,4}\.\d{1,4})\.tar\.gz$/);
  if (desktop) {
    const obj = await env.UPDATES.get(`desktop/${desktop[1]}.tar.gz`);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: { "content-type": "application/gzip", "content-length": String(obj.size), etag: obj.httpEtag, "cache-control": "no-store" },
    });
  }
  const apk = url.pathname.match(/^\/v1\/update\/apk\/(\d{1,9})\.apk$/);
  if (apk) {
    const obj = await env.UPDATES.get(`apk/${apk[1]}.apk`);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: { "content-type": "application/vnd.android.package-archive", "content-length": String(obj.size), etag: obj.httpEtag, "cache-control": "no-store" },
    });
  }
  return new Response("Not found", { status: 404 });
}

export class Channel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return new Response("Unauthorized", { status: 401 });
    const hash = await sha256(token);
    const stored = await this.ctx.storage.get("auth");

    // Used by the update endpoints: does this token belong to this channel?
    if (url.searchParams.has("verify")) return new Response(null, { status: stored && equal(stored, hash) ? 204 : 403 });

    if (request.method === "DELETE") {
      if (!stored || !equal(stored, hash)) return new Response("Forbidden", { status: 403 });
      for (const ws of this.ctx.getWebSockets()) ws.close(4001, "unpaired");
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });

    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "phone") return new Response("Bad role", { status: 400 });
    if (!stored) {
      // The PC claims a new channel; the channel id is derived from the pairing secret, so only it knows the id.
      if (role !== "host") return new Response("Channel not set up yet: open VOID Workshop on the PC", { status: 404 });
      await this.ctx.storage.put("auth", hash);
    } else if (!equal(stored, hash)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (role === "host") for (const old of this.ctx.getWebSockets("host")) old.close(4000, "replaced");
    else {
      const phones = this.open("phone");
      for (const old of phones.slice(0, Math.max(0, phones.length - MAX_PHONES + 1))) old.close(4000, "replaced");
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    const other = role === "host" ? "phone" : "host";
    server.send(JSON.stringify({ t: "peer", role: other, online: this.open(other).length > 0 }));
    for (const ws of this.open(other)) safeSend(ws, JSON.stringify({ t: "peer", role, online: true }));

    if (role === "phone") {
      const kept = ((await this.ctx.storage.get("kept")) ?? []).filter((k) => Date.now() - k.at < KEEP_MS);
      for (const k of kept) server.send(JSON.stringify({ t: "msg", d: k.d, kept: true }));
      if (kept.length) await this.ctx.storage.delete("kept");
    }
    await this.ctx.storage.setAlarm(Date.now() + IDLE_DELETE_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  open(role) {
    return this.ctx.getWebSockets(role).filter((w) => w.readyState === 1);
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_FRAME) return ws.close(1009, "frame too large");
    let frame;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (frame?.t !== "msg" || typeof frame.d !== "string") return;
    const [role] = this.ctx.getTags(ws);
    const targets = this.open(role === "host" ? "phone" : "host");
    const out = JSON.stringify({ t: "msg", d: frame.d });
    for (const t of targets) safeSend(t, out);
    if (!targets.length && role === "host" && frame.keep === true) {
      // The phone is away: keep sealed notifications for it.
      const kept = ((await this.ctx.storage.get("kept")) ?? []).filter((k) => Date.now() - k.at < KEEP_MS);
      kept.push({ at: Date.now(), d: frame.d });
      await this.ctx.storage.put("kept", kept.slice(-KEEP_MAX));
    }
  }

  async webSocketClose(ws) {
    const [role] = this.ctx.getTags(ws);
    if (this.open(role).some((w) => w !== ws)) return;
    const msg = JSON.stringify({ t: "peer", role, online: false });
    for (const t of this.open(role === "host" ? "phone" : "host")) safeSend(t, msg);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    // Unused for a month: forget the channel.
    if (this.ctx.getWebSockets().length) return this.ctx.storage.setAlarm(Date.now() + IDLE_DELETE_MS);
    await this.ctx.storage.deleteAll();
  }
}

function safeSend(ws, data) {
  try {
    ws.send(data);
  } catch {
    // Closing; its close handler reports it.
  }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
