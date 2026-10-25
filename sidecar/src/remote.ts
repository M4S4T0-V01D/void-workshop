import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { relaySource, type UpdateSource } from './updater.js';
import { DEFAULT_RELAY, deriveKeys, open, pairingLink, seal, type PairKeys } from './remoteCrypto.js';
import { clip, redactValue } from './redact.js';
import { log } from './log.js';

/**
 * VOID Portal: drive VOID Workshop from the phone app through the relay (see remote/PROTOCOL.md).
 * One outgoing WebSocket per paired phone. Calls from the phone go through a narrow allow-list on
 * top of the same handlers the window uses, so every policy, approval and budget still applies.
 */

export { DEFAULT_RELAY };

/**
 * What the phone may call. Keys, sign-in, project access, the terminal, git beyond committing a task's own changes
 * (review.commit), and removing the admin password stay desktop-only.
 */
export const REMOTE_METHODS = new Set([
  'remote.state',
  'task.list',
  'task.get',
  'task.image',
  'plan.usage',
  'task.active',
  'task.search',
  'task.export',
  'task.start',
  'task.send',
  'task.cancel',
  'task.finish',
  'task.approvePlan',
  'task.setMode',
  'task.setModel',
  'task.compact',
  'task.queue.edit',
  'task.queue.remove',
  'task.queue.sendNow',
  'task.queue.flush',
  'approval.respond',
  'approval.pending',
  'review.list',
  'review.commit',
  'image.upload',
  'models.refresh',
  'settings.update',
  'auth.clearPlanLimit',
  'usage.summary',
  'admin.status',
  'admin.start',
  'admin.end',
  'admin.setPassword',
]);

/** Settings that loosen what the agent may do: from the phone they need the admin password (or a running admin session). */
export const SAFETY_SETTINGS = ['fullAccess', 'autoPublish', 'sandboxCommands', 'allowPublishCommands', 'gradleBuilds'];

/** Settings the phone may change: everything in the desktop's Settings except custom theme editing. */
export const REMOTE_SETTINGS = [
  'provider',
  'anthropicAuth',
  'authFallback',
  'ollamaUrl',
  'model',
  'agentMode',
  'effort',
  'fastMode',
  'sendQueuedTogether',
  'contextCapTokens',
  'tokenSaver',
  'implementModel',
  'promptCacheTtl',
  'perTaskBudgetUsd',
  'dailyBudgetUsd',
  'confirmTaskBudgetAboveUsd',
  'maxTurns',
  'maxRunningTasks',
  'maxOutputTokens',
  'commandTimeoutSec',
  'commandOutputLimitKb',
  'checkpointBeforeTasks',
  'themeId',
  'runInBackground',
  'startAtLogin',
  ...SAFETY_SETTINGS,
];

/** Events mirrored to a connected phone. */
const FORWARD = new Set([
  'task.updated',
  'approval.request',
  'approval.resolved',
  'queue.updated',
  'usage.updated',
  'billing.blocked',
  'plan.limited',
  'plan.usage',
  'auth.switched',
  'settings.changed',
  'admin.changed',
  'admin.restartPending',
  'admin.restarting',
]);

const MAX_CALL_AGE_MS = 5 * 60_000;
/** An export sent to the phone fits one encrypted relay frame (1 MiB). */
export const REMOTE_EXPORT_CHARS = 300_000;

/** A refusal by the remote allow-list itself (shown to the phone as is). */
class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const HEARTBEAT_MS = 30_000;
const REMOTE_DELTA_MS = 250;

export interface RemoteHost {
  handle(method: string, params: unknown): Promise<unknown>;
  remoteState(): Promise<unknown>;
  isRecentProject(root: string): boolean;
  /** Throws unless the admin password is right or an admin session is running. */
  confirmAdmin(password: string): Promise<void>;
  errorPayload(err: unknown): { code: string; message: string };
  emit(event: string, payload: unknown): void;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

const defaultSocket: SocketFactory = (url, headers) => new WebSocket(url, { headers } as never) as unknown as WebSocketLike;

interface DeviceRecord {
  id: string;
  name: string;
  /** base64url pairing secret. */
  secret: string;
  createdAt: number;
  lastSeenAt: number | null;
}

interface RemoteConfig {
  relayUrl: string;
  devices: DeviceRecord[];
}

export interface DeviceStatus {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  connected: boolean;
  phoneOnline: boolean;
}

/** One paired phone: its relay connection, keys and presence. */
class DeviceLink {
  ws: WebSocketLike | null = null;
  connected = false;
  phoneOnline = false;
  private retry = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;
  readonly keys: PairKeys;

  constructor(
    readonly device: DeviceRecord,
    private readonly bridge: RemoteBridge,
  ) {
    this.keys = deriveKeys(Buffer.from(device.secret, 'base64url'));
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.heartbeat = setInterval(() => {
      if (!this.connected) return;
      this.raw('{"t":"ping"}');
      if (this.phoneOnline) this.send({ type: 'hb', ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reconnectTimer = this.heartbeat = null;
    try {
      this.ws?.close(1000, 'stopped');
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.connected = this.phoneOnline = false;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.bridge.relayUrl}/v1/channel/${this.keys.channelId}?role=host`;
    let ws: WebSocketLike;
    try {
      ws = this.bridge.socket(url, { authorization: `Bearer ${this.keys.token}` });
    } catch (err) {
      log.warn(`remote: cannot connect: ${(err as Error).message}`);
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.bridge.statusChanged();
    };
    ws.onmessage = (ev) => this.onFrame(String(ev.data));
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      const wasOnline = this.connected;
      this.connected = this.phoneOnline = false;
      this.ws = null;
      if (wasOnline) this.bridge.statusChanged();
      if (ev?.code === 4001) {
        log.info(`remote: ${this.device.name} was unpaired on the relay`);
        return;
      }
      this.scheduleReconnect(ev?.code === 4000 ? 30_000 : 0);
    };
  }

  private scheduleReconnect(min = 0): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.max(min, Math.min(60_000, 1000 * 2 ** this.retry++)) + Math.random() * 500;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onFrame(text: string): void {
    let frame: { t?: string; d?: string; role?: string; online?: boolean };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.t === 'peer' && frame.role === 'phone') {
      this.phoneOnline = !!frame.online;
      if (this.phoneOnline) {
        this.device.lastSeenAt = Date.now();
        this.bridge.saveSoon();
        this.send({ type: 'hb', ts: Date.now() });
      }
      this.bridge.statusChanged();
      return;
    }
    if (frame.t !== 'msg' || typeof frame.d !== 'string') return;
    let msg: unknown;
    try {
      msg = open(this.keys, 'p2h', frame.d);
    } catch {
      log.warn(`remote: dropped a frame that did not decrypt (${this.device.name})`);
      return;
    }
    void this.bridge.onCall(this, msg as Record<string, unknown>);
  }

  private raw(text: string): void {
    if (this.ws && this.connected && this.ws.readyState === 1) {
      try {
        this.ws.send(text);
      } catch {
        /* the close handler reconnects */
      }
    }
  }

  send(payload: unknown, keep = false): void {
    this.raw(JSON.stringify({ t: 'msg', d: seal(this.keys, 'h2p', payload), ...(keep ? { keep: true } : {}) }));
  }
}

export class RemoteBridge {
  private config: RemoteConfig;
  private readonly links = new Map<string, DeviceLink>();
  private readonly seen = new Map<string, number>();
  private readonly lastState = new Map<string, string>();
  private readonly pendingDelta = new Map<string, string>();
  private deltaTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly host: RemoteHost,
    readonly socket: SocketFactory = defaultSocket,
  ) {
    this.config = this.load();
  }

  get relayUrl(): string {
    return this.config.relayUrl;
  }

  start(): void {
    if (!this.config.relayUrl) return;
    for (const d of this.config.devices) this.startLink(d);
  }

  stop(): void {
    for (const l of this.links.values()) l.stop();
    this.links.clear();
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.save();
    }
  }

  private startLink(d: DeviceRecord): void {
    const link = new DeviceLink(d, this);
    this.links.set(d.id, link);
    link.start();
  }

  /** Credentials for the relay's update downloads: any paired phone's channel will do. */
  updateSource(): UpdateSource | null {
    const link = this.links.values().next().value as DeviceLink | undefined;
    if (!link || !this.config.relayUrl) return null;
    return relaySource(this.config.relayUrl.replace(/^ws/, 'http'), {
      'x-void-channel': link.keys.channelId,
      authorization: `Bearer ${link.keys.token}`,
    });
  }

  status(): { relayUrl: string; devices: DeviceStatus[] } {
    return {
      relayUrl: this.config.relayUrl,
      devices: this.config.devices.map((d) => {
        const l = this.links.get(d.id);
        return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, connected: !!l?.connected, phoneOnline: !!l?.phoneOnline };
      }),
    };
  }

  statusChanged(): void {
    this.host.emit('remote.status', this.status());
  }

  /** Create a pairing for a new phone. The QR code and link contain the secret; show them only to the user. */
  async pair(name: string): Promise<{ device: DeviceStatus; link: string; qrSvg: string }> {
    if (!this.config.relayUrl) throw new Error('Set your relay address first (deploy remote/relay to your Cloudflare account; the README explains how).');
    if (this.config.devices.length >= 5) throw new Error('At most 5 phones can be paired. Remove one first.');
    const secret = crypto.randomBytes(32);
    const d: DeviceRecord = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, 60) || 'Phone',
      secret: secret.toString('base64url'),
      createdAt: Date.now(),
      lastSeenAt: null,
    };
    this.config.devices.push(d);
    this.save();
    this.startLink(d);
    const link = pairingLink(this.config.relayUrl, secret, os.hostname().slice(0, 60));
    // A 4-module quiet zone, as the QR spec asks: scanners find the code much faster.
    const qrSvg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
    this.statusChanged();
    return { device: this.status().devices.find((x) => x.id === d.id)!, link, qrSvg };
  }

  /** Forget a phone here and on the relay (its channel and any kept notifications are deleted). */
  async unpair(id: string): Promise<void> {
    const d = this.config.devices.find((x) => x.id === id);
    if (!d) throw new Error('That phone is not paired.');
    const keys = deriveKeys(Buffer.from(d.secret, 'base64url'));
    this.links.get(id)?.stop();
    this.links.delete(id);
    this.config.devices = this.config.devices.filter((x) => x.id !== id);
    this.save();
    this.statusChanged();
    try {
      await fetch(`${this.config.relayUrl.replace(/^ws/, 'http')}/v1/channel/${keys.channelId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${keys.token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      log.warn(`remote: could not delete the relay channel: ${(err as Error).message}`);
    }
  }

  setRelay(url: string): void {
    const u = new URL(url);
    if (u.protocol !== 'wss:' || u.pathname.replace(/\/$/, '') !== '' || u.search) throw new Error('The relay address must look like wss://host');
    this.config.relayUrl = `wss://${u.host}`;
    this.save();
    for (const l of this.links.values()) l.stop();
    this.links.clear();
    this.start();
    this.statusChanged();
  }

  // ---- phone → PC ---------------------------------------------------------------------------
  async onCall(link: DeviceLink, msg: Record<string, unknown>): Promise<void> {
    if (msg.type !== 'call' || typeof msg.id !== 'string' || msg.id.length > 64) return;
    const id = msg.id;
    const reply = (ok: boolean, body: Record<string, unknown>) => link.send(redactValue({ type: 'reply', id, ok, ...body }));
    const now = Date.now();
    if (typeof msg.ts !== 'number' || Math.abs(now - msg.ts) > MAX_CALL_AGE_MS)
      return reply(false, { error: { code: 'stale', message: "The request is too old or the phone's clock is off." } });
    if (this.seen.has(id)) return;
    this.seen.set(id, now);
    for (const [k, at] of this.seen) if (now - at > 2 * MAX_CALL_AGE_MS) this.seen.delete(k);

    const method = String(msg.method ?? '');
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? { ...(msg.params as Record<string, unknown>) } : {};
    // The app sends absent optional values as null; the handlers expect them left out.
    for (const k of Object.keys(params)) if (params[k] === null) delete params[k];
    // Image pieces for the phone stay small enough for one relay frame.
    if (method === 'task.image') delete params.length;
    // Exports from the phone are read-only: nothing is written to the PC's Downloads folder.
    if (method === 'task.export') delete params.save;
    try {
      if (!REMOTE_METHODS.has(method)) throw new RemoteError('not-allowed', `${method} is not available from the phone.`);
      let result: unknown;
      if (method === 'remote.state') result = await this.host.remoteState();
      else {
        if (method === 'settings.update') {
          const password = typeof params.adminPassword === 'string' ? params.adminPassword : '';
          for (const k of Object.keys(params)) if (!REMOTE_SETTINGS.includes(k)) delete params[k];
          if (Object.keys(params).some((k) => SAFETY_SETTINGS.includes(k))) await this.host.confirmAdmin(password);
        }
        // The PC decides where admin calls come from: a phone can never set the first password or pass as the desktop.
        if (method.startsWith('admin.')) {
          params.origin = 'phone';
          params.device = link.device.name;
        }
        if ((method === 'task.start' || method === 'task.list') && !this.host.isRecentProject(String(params.root ?? '')))
          throw new RemoteError('project', 'That folder is not next to your projects. Open it in VOID Workshop on the PC first.');
        result = await this.host.handle(method, params);
        if (method === 'task.get' && result && typeof result === 'object') {
          const r = result as { events?: unknown[] };
          if (Array.isArray(r.events)) r.events = r.events.slice(-400);
        }
        if (method === 'task.export' && result && typeof result === 'object') {
          const r = result as { markdown?: string };
          if (typeof r.markdown === 'string' && r.markdown.length > REMOTE_EXPORT_CHARS)
            r.markdown = `${r.markdown.slice(0, REMOTE_EXPORT_CHARS)}\n\n… (cut here: export it on the PC for the whole task)\n`;
        }
      }
      reply(true, { result });
    } catch (err) {
      reply(false, { error: err instanceof RemoteError ? { code: err.code, message: err.message } : this.host.errorPayload(err) });
    }
  }

  // ---- PC → phone ---------------------------------------------------------------------------
  /** Every sidecar event passes through here: mirrored to connected phones, and turned into notifications. */
  onEvent(event: string, payload: unknown): void {
    if (!this.links.size || event.startsWith('remote.')) return;
    const p = (payload ?? {}) as Record<string, unknown>;
    this.notifyFor(event, p);
    if (![...this.links.values()].some((l) => l.phoneOnline)) return;
    if (event === 'agent.delta') {
      const taskId = String(p.taskId ?? '');
      this.pendingDelta.set(taskId, (this.pendingDelta.get(taskId) ?? '') + String(p.text ?? ''));
      this.deltaTimer ??= setTimeout(() => this.flushDeltas(), REMOTE_DELTA_MS);
      return;
    }
    if (FORWARD.has(event) || event.startsWith('agent.')) {
      this.flushDeltas();
      this.broadcast({ type: 'event', event, payload: redactValue(payload) });
    }
  }

  private flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    for (const [taskId, text] of this.pendingDelta) this.broadcast({ type: 'event', event: 'agent.delta', payload: { taskId, text } });
    this.pendingDelta.clear();
  }

  private broadcast(msg: unknown, keep = false): void {
    for (const l of this.links.values()) if (keep || l.phoneOnline) l.send(msg, keep);
  }

  private notify(kind: 'done' | 'approval' | 'alert', title: string, body: string, taskId: string | null, extra: Record<string, unknown> = {}): void {
    this.broadcast(redactValue({ type: 'notify', kind, title: clip(title, 120), body: clip(body, 400), taskId, ts: Date.now(), ...extra }), true);
  }

  private notifyFor(event: string, p: Record<string, unknown>): void {
    if (event === 'task.updated' && typeof p.id === 'string') {
      const state = String(p.state);
      const prev = this.lastState.get(p.id);
      this.lastState.set(p.id, state);
      if (prev === state) return;
      const where = typeof p.project === 'string' ? path.basename(p.project) : '';
      const title = String(p.title ?? 'Task');
      const working = prev === 'executing' || prev === 'planning';
      if (state === 'idle' && working) this.notify('done', `Done · ${where}`, `${title}\n${firstLines(String(p.summary ?? ''))}`, p.id);
      else if (state === 'awaiting-plan-approval' && working) this.notify('approval', `Plan ready · ${where}`, title, p.id);
      else if (['failed', 'stopped-budget', 'stopped-billing', 'stopped-limit', 'interrupted'].includes(state) && prev)
        this.notify('alert', `Stopped · ${where}`, `${title}\n${String(p.error ?? state)}`, p.id);
    } else if (event === 'approval.request') {
      const detail = typeof p.command === 'string' ? p.command : typeof p.rel === 'string' ? p.rel : '';
      const categories = (p.assessment as { categories?: unknown } | undefined)?.categories;
      const publishes = Array.isArray(categories) && categories.includes('publishes');
      const approval = {
        id: p.id,
        taskId: p.taskId,
        kind: p.kind,
        summary: p.summary,
        command: p.command,
        rel: p.rel,
        publishes,
        canAllowAll: p.canAllowAll === true,
      };
      this.notify('approval', 'Approval needed', `${String(p.summary ?? '')}${detail ? `\n${detail}` : ''}`, typeof p.taskId === 'string' ? p.taskId : null, {
        approval,
      });
    } else if (event === 'admin.changed') {
      const by = p.by === 'phone' ? (typeof p.device === 'string' ? p.device : 'a phone') : 'the PC';
      if (p.active) this.notify('alert', 'Admin session started', `From ${by}. The agent may change VOID Workshop and VOID Portal until you end it.`, null);
      else this.notify('alert', 'Admin session ended', 'VOID Workshop is back to normal.', null);
    } else if (event === 'admin.restarting') {
      const why = typeof p.reason === 'string' && p.reason ? p.reason : 'Admin session';
      this.notify(
        'alert',
        'VOID Workshop is restarting',
        `${why}${p.install ? '\nInstalling the new build first.' : ''}`,
        typeof p.taskId === 'string' ? p.taskId : null,
      );
    } else if (event === 'auth.switched' || event === 'plan.limited') {
      this.notify(
        'alert',
        event === 'plan.limited' ? 'Claude plan limit' : 'Account switched',
        String(p.text ?? p.message ?? ''),
        typeof p.taskId === 'string' ? p.taskId : null,
      );
    }
  }

  // ---- storage --------------------------------------------------------------------------------
  private load(): RemoteConfig {
    try {
      const st = fs.statSync(this.file);
      if ((st.mode & 0o077) !== 0) throw new Error(`${this.file} must have permissions 600`);
      const c = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<RemoteConfig>;
      return { relayUrl: typeof c.relayUrl === 'string' ? c.relayUrl : DEFAULT_RELAY, devices: Array.isArray(c.devices) ? c.devices : [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`remote: ${(err as Error).message}`);
      return { relayUrl: DEFAULT_RELAY, devices: [] };
    }
  }

  saveSoon(): void {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 5000);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}

function firstLines(text: string): string {
  return text.trim().split('\n').filter(Boolean).slice(0, 3).join('\n');
}
