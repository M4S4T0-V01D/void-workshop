import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Server } from '../src/server.js';
import { deriveKeys, open, parsePairingLink, seal, type PairKeys } from '../src/remoteCrypto.js';
import type { SocketFactory, WebSocketLike } from '../src/remote.js';
import { fakeQueryFn, type FakeScript } from './fakeSdk.js';
import { tempRepo, testPaths, writeKeyFile } from './helpers.js';

const vectors = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../remote/test-vectors.json'), 'utf8'));

describe('remote crypto', () => {
  it('matches the shared test vector (the phone app checks the same one)', () => {
    const keys = deriveKeys(Buffer.from(vectors.secret, 'base64url'));
    expect(keys.channelId).toBe(vectors.channelId);
    expect(keys.token).toBe(vectors.token);
    expect(keys.hostToPhone.toString('hex')).toBe(vectors.hostToPhone);
    expect(keys.phoneToHost.toString('hex')).toBe(vectors.phoneToHost);
    expect(open(keys, 'h2p', vectors.sample.frame)).toEqual(JSON.parse(vectors.sample.plaintext));
  });

  it('encodes the short pairing link like the phone app (shared vector)', async () => {
    const { base32, pairingLink, DEFAULT_RELAY } = await import('../src/remoteCrypto.js');
    expect(DEFAULT_RELAY).toBe('');
    const secret = Buffer.from(vectors.secret, 'base64url');
    expect(base32(secret)).toBe(vectors.secretBase32);
    expect(pairingLink('wss://void-relay.someone.workers.dev', secret, 'x')).toBe(`VOIDPORTAL://P/${vectors.secretBase32}/VOID-RELAY.SOMEONE.WORKERS.DEV`);
    const short = parsePairingLink(`voidportal://p/${vectors.secretBase32.toLowerCase()}/void-relay.someone.workers.dev:8443`);
    expect(short.secret.equals(secret)).toBe(true);
    expect(short.relayUrl).toBe('wss://void-relay.someone.workers.dev:8443');
    expect(() => parsePairingLink(`VOIDPORTAL://P/${vectors.secretBase32}`)).toThrow();
    expect(pairingLink('wss://other_host.example', secret, 'desk')).toMatch(/^voidportal:\/\/pair\?v=1&r=wss%3A%2F%2Fother_host\.example/);
  });

  it('round-trips and rejects the wrong direction, channel or a tampered frame', () => {
    const keys = deriveKeys(Buffer.alloc(32, 1));
    const other = deriveKeys(Buffer.alloc(32, 2));
    const frame = seal(keys, 'p2h', { hello: 'world' });
    expect(open(keys, 'p2h', frame)).toEqual({ hello: 'world' });
    expect(() => open(keys, 'h2p', frame)).toThrow();
    expect(() => open(other, 'p2h', frame)).toThrow();
    const raw = Buffer.from(frame, 'base64url');
    raw[15] = raw[15]! ^ 1;
    expect(() => open(keys, 'p2h', raw.toString('base64url'))).toThrow();
  });
});

/** A stand-in for the relay: records what the PC sends and lets the test play the phone. */
class FakeRelay {
  sockets: Array<WebSocketLike & { sent: string[]; url: string; headers: Record<string, string> }> = [];
  factory: SocketFactory = (url, headers) => {
    const ws = {
      readyState: 0,
      sent: [] as string[],
      url,
      headers,
      send(d: string) {
        this.sent.push(d);
      },
      close() {
        this.readyState = 3;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    } as WebSocketLike & { sent: string[]; url: string; headers: Record<string, string> };
    this.sockets.push(ws);
    queueMicrotask(() => {
      ws.readyState = 1;
      ws.onopen?.({});
    });
    return ws;
  };
  get last() {
    return this.sockets.at(-1)!;
  }
  phoneOnline(online = true) {
    this.last.onmessage?.({ data: JSON.stringify({ t: 'peer', role: 'phone', online }) });
  }
  fromPhone(keys: PairKeys, msg: unknown) {
    this.last.onmessage?.({ data: JSON.stringify({ t: 'msg', d: seal(keys, 'p2h', msg) }) });
  }
  /** Decrypted messages the PC sent, with the relay's keep flag. */
  received(keys: PairKeys): Array<{ keep: boolean; msg: any }> {
    return this.last.sent
      .map((s) => JSON.parse(s))
      .filter((f) => f.t === 'msg')
      .map((f) => ({ keep: !!f.keep, msg: open(keys, 'h2p', f.d) }));
  }
}

async function setup(script: FakeScript = { onUser: async (_t, ctx) => ctx.result({ result: 'All done.\nTests pass.' }) }) {
  const paths = testPaths();
  writeKeyFile(paths);
  const relay = new FakeRelay();
  const { fn } = fakeQueryFn(script);
  const server = new Server(paths, () => {}, {
    dbFile: ':memory:',
    queryFn: fn,
    remoteSocket: relay.factory,
    initTimeoutMs: 2000,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  server.store.setFlag('models', { models: [{ id: 'claude-test-model', displayName: 'Test' }], checkedAt: Date.now() });
  server.store.updateSettings({ model: 'claude-test-model', sandboxCommands: false, checkpointBeforeTasks: false });
  const root = tempRepo();
  server.store.touchProject(root, 'repo');
  await expect(server.handle('remote.pair', { name: 'Pixel' })).rejects.toThrow(/relay address first/);
  await server.handle('remote.setRelay', { url: 'wss://relay.example.dev' });
  const paired = (await server.handle('remote.pair', { name: 'Pixel' })) as { link: string; qrSvg: string; device: { id: string } };
  const keys = deriveKeys(parsePairingLink(paired.link).secret);
  await new Promise((r) => setTimeout(r, 10));
  const call = async (method: string, params: unknown = {}, extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    relay.fromPhone(keys, { type: 'call', id, ts: Date.now(), method, params, ...extra });
    for (let i = 0; i < 100; i++) {
      const r = relay.received(keys).find((m) => m.msg.type === 'reply' && m.msg.id === id);
      if (r) return r.msg;
      await new Promise((res) => setTimeout(res, 20));
    }
    return null;
  };
  return { server, relay, keys, root, paired, paths, call };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('remote bridge', () => {
  it('pairs with a QR code, stores the secret privately and connects as host with the derived token', async () => {
    const { relay, keys, paired, paths, server } = await setup();
    expect(paired.qrSvg).toContain('<svg');
    // A plain host name gets the short, upper-case link (a coarse alphanumeric QR code).
    expect(paired.link).toMatch(/^VOIDPORTAL:\/\/P\/[A-Z2-7]{52}\/RELAY\.EXAMPLE\.DEV$/);
    expect(relay.last.url).toBe(`wss://relay.example.dev/v1/channel/${keys.channelId}?role=host`);
    expect(relay.last.headers.authorization).toBe(`Bearer ${keys.token}`);
    const file = path.join(paths.configDir, 'credentials', 'remote.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await server.handle('remote.status', {})) as object).toMatchObject({ devices: [{ name: 'Pixel', connected: true, phoneOnline: false }] });
    await server.shutdown();
  });

  it('answers allowed calls, and refuses other methods, stale or replayed calls and forged frames', async () => {
    const { call, relay, keys, root, server } = await setup();
    relay.phoneOnline();
    const state = await call('remote.state');
    expect(state.ok).toBe(true);
    expect(state.result.projects[0].path).toBe(root);
    expect(state.result.settings.model).toBe('claude-test-model');
    expect(JSON.stringify(state.result)).not.toContain('sk-ant');
    for (const m of ['auth.setKey', 'runner.run', 'git.commit', 'git.push', 'project.setPermissions', 'remote.pair'])
      expect((await call(m, {})).error.code, m).toBe('not-allowed');
    // The phone may commit a task's own changes and upload pictures (both check their params, not the allow-list).
    for (const m of ['review.commit', 'image.upload']) expect((await call(m, {})).error.code, m).not.toBe('not-allowed');
    expect((await call('remote.state', {}, { ts: Date.now() - 10 * 60_000 })).error.code).toBe('stale');
    // A replayed call id is ignored.
    const id = crypto.randomUUID();
    relay.fromPhone(keys, { type: 'call', id, ts: Date.now(), method: 'remote.state', params: {} });
    relay.fromPhone(keys, { type: 'call', id, ts: Date.now(), method: 'remote.state', params: {} });
    await new Promise((r) => setTimeout(r, 200));
    expect(relay.received(keys).filter((m) => m.msg.id === id)).toHaveLength(1);
    // A frame sealed with another channel's key is dropped.
    const before = relay.last.sent.length;
    relay.fromPhone(deriveKeys(Buffer.alloc(32, 9)), { type: 'call', id: crypto.randomUUID(), ts: Date.now(), method: 'remote.state', params: {} });
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.last.sent.length).toBe(before);
    await server.shutdown();
  });

  it('lets the phone change most settings, the safety ones only with the admin password', async () => {
    const { call, server } = await setup();
    const r = await call('settings.update', { anthropicAuth: 'subscription', effort: 'low', dailyBudgetUsd: 40, maxRunningTasks: 2, customThemes: [] });
    expect(r.ok).toBe(true);
    expect(server.store.getSettings()).toMatchObject({ anthropicAuth: 'subscription', effort: 'low', dailyBudgetUsd: 40, maxRunningTasks: 2 });
    expect((await call('settings.update', { fullAccess: true })).error.code).toBe('admin-no-password');
    await server.handle('admin.setPassword', { password: 'hunter22' });
    expect((await call('settings.update', { fullAccess: true, adminPassword: 'nope' })).error.code).toBe('admin-password');
    expect(server.store.getSettings().fullAccess).toBe(false);
    expect((await call('settings.update', { fullAccess: true, adminPassword: 'hunter22' })).ok).toBe(true);
    expect(server.store.getSettings().fullAccess).toBe(true);
    // While an admin session runs, the phone needs no password for them.
    await server.handle('admin.start', { password: 'hunter22' });
    expect((await call('settings.update', { gradleBuilds: true })).ok).toBe(true);
    expect(server.store.getSettings().gradleBuilds).toBe(true);
    expect((await call('task.start', { root: '/tmp', prompt: 'x' })).error.code).toBe('project');
    await server.shutdown();
  });

  it('admin calls from the phone count as the phone: no first password, and the session names the phone', async () => {
    const { call, server, relay } = await setup();
    relay.phoneOnline();
    expect((await call('admin.setPassword', { password: 'hunter22', origin: 'desktop' })).error.code).toBe('admin-no-password');
    await server.handle('admin.setPassword', { password: 'hunter22' });
    expect((await call('admin.start', { password: 'hunter22', origin: 'desktop' })).result).toMatchObject({ active: true, by: 'phone', device: 'Pixel' });
    expect((await call('remote.state')).result.admin).toMatchObject({ active: true, by: 'phone' });
    expect((await call('admin.clearPassword', { current: 'hunter22' })).error.code).toBe('not-allowed');
    expect((await call('admin.end')).result).toMatchObject({ active: false });
    await server.shutdown();
  });

  it('runs a task from the phone, mirrors events while it is connected and notifies when it finishes', async () => {
    const { call, relay, keys, root, server } = await setup();
    relay.phoneOnline();
    const started = await call('task.start', { root, prompt: 'Add a test', mode: 'ask' });
    expect(started.ok).toBe(true);
    await until(() => server.store.getTask(started.result.id)!.state === 'idle');
    await until(() => relay.received(keys).some((m) => m.msg.type === 'notify'));
    const msgs = relay.received(keys);
    expect(msgs.some((m) => m.msg.type === 'event' && m.msg.event === 'task.updated')).toBe(true);
    const done = msgs.find((m) => m.msg.type === 'notify')!;
    expect(done.keep).toBe(true);
    expect(done.msg).toMatchObject({ kind: 'done', taskId: started.result.id });
    expect(done.msg.title).toMatch(/^Done · /);
    expect(done.msg.body).toContain('All done.');
    // Search and export work from the phone; an export never writes to the PC.
    expect((await call('task.search', { query: 'Add a test' })).result[0].task.id).toBe(started.result.id);
    const exported = await call('task.export', { taskId: started.result.id, save: true });
    expect(exported.result.markdown).toContain('Add a test');
    expect(exported.result.path).toBeUndefined();
    await server.shutdown();
  });

  it('only sends notifications (kept by the relay) while the phone is away', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { call, relay, keys, root, server } = await setup({
      onUser: async (_t, ctx) => {
        await gate;
        ctx.text('streamed while away');
        ctx.result({ result: 'done' });
      },
    });
    relay.phoneOnline();
    const started = await call('task.start', { root, prompt: 'x', mode: 'ask' });
    relay.phoneOnline(false);
    const mark = relay.received(keys).length;
    release();
    await until(() => server.store.getTask(started.result.id)!.state === 'idle');
    await until(() => relay.received(keys).length > mark);
    const later = relay.received(keys).slice(mark);
    expect(later.every((m) => m.msg.type === 'notify' && m.keep)).toBe(true);
    await server.shutdown();
  });

  it('unpairs: stops the link and forgets the phone', async () => {
    const { server, paired, relay } = await setup();
    const realFetch = globalThis.fetch;
    let deleted = '';
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      deleted = `${init.method} ${url}`;
      return new Response(null, { status: 204 });
    }) as never;
    try {
      const st = (await server.handle('remote.unpair', { id: paired.device.id })) as { devices: unknown[] };
      expect(st.devices).toEqual([]);
      expect(deleted).toMatch(/^DELETE https:\/\/relay\.example\.dev\/v1\/channel\/[0-9a-f]{32}$/);
      expect(relay.last.readyState).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
      await server.shutdown();
    }
  });
});

describe('start at login', () => {
  it('writes and removes the autostart entry under XDG_CONFIG_HOME', async () => {
    const { syncAutostart } = await import('../src/autostart.js');
    const cfg = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'vw-xdg-'));
    const env = { HOME: '/nonexistent-home', XDG_CONFIG_HOME: cfg };
    syncAutostart(true, env);
    const file = path.join(cfg, 'autostart', 'void-workshop.desktop');
    expect(fs.readFileSync(file, 'utf8')).toContain('Exec=void-workshop --hidden');
    syncAutostart(false, env);
    expect(fs.existsSync(file)).toBe(false);
  });
});
