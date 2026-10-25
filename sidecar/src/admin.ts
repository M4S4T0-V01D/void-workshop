import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SIDECAR_DIR } from './config.js';
import { log } from './log.js';
import type { AgentMode } from './settings.js';

/**
 * Admin dev session: after the user's admin password, the agent may work on VOID Workshop and VOID Portal
 * themselves (their source, Workshop's logs and database, installing a new build and restarting into it).
 * Started and ended from the desktop or the phone. The password hash and the session live in the
 * credentials folder, which the agent never reaches, not even during an admin session.
 */

export type AdminOrigin = 'desktop' | 'phone';

export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 200;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;
/** scrypt cost: ~100 ms per check, 32 MiB of memory. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** A restart the agent asked for: the task to continue once the new build is running. */
export interface PendingResume {
  taskId: string;
  mode: AgentMode;
  install: boolean;
  at: number;
}

interface AdminFile {
  password: { salt: string; hash: string; setAt: number } | null;
  session: { since: number; by: AdminOrigin; device: string | null } | null;
  failures: number;
  lockedUntil: number | null;
  resume: PendingResume | null;
}

export interface AdminStatus {
  passwordSet: boolean;
  active: boolean;
  since: number | null;
  by: AdminOrigin | null;
  device: string | null;
  lockedUntil: number | null;
  /** The VOID Workshop source repository the admin session works on (null when it cannot be found). */
  sourceDir: string | null;
}

export class AdminError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const EMPTY: AdminFile = { password: null, session: null, failures: 0, lockedUntil: null, resume: null };

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password.normalize('NFKC'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
}

export class AdminStore {
  private data: AdminFile;

  constructor(
    private readonly file: string,
    private readonly findSource: () => string | null = () => null,
    private readonly now: () => number = Date.now,
  ) {
    this.data = this.load();
  }

  get active(): boolean {
    return !!this.data.session;
  }

  status(): AdminStatus {
    const s = this.data.session;
    const locked = this.data.lockedUntil && this.data.lockedUntil > this.now() ? this.data.lockedUntil : null;
    return {
      passwordSet: !!this.data.password,
      active: !!s,
      since: s?.since ?? null,
      by: s?.by ?? null,
      device: s?.device ?? null,
      lockedUntil: locked,
      sourceDir: this.findSource(),
    };
  }

  /** Checks the password; five wrong ones in a row lock it for five minutes. */
  async verify(password: string): Promise<void> {
    const pw = this.data.password;
    if (!pw) throw new AdminError('admin-no-password', 'Set an admin password on the PC first (Settings → Admin).');
    if (this.data.lockedUntil && this.data.lockedUntil > this.now()) {
      const min = Math.ceil((this.data.lockedUntil - this.now()) / 60_000);
      throw new AdminError('admin-locked', `Too many wrong passwords. Try again in ${min} min.`);
    }
    const key = await scrypt(String(password ?? ''), Buffer.from(pw.salt, 'base64'));
    if (!crypto.timingSafeEqual(key, Buffer.from(pw.hash, 'base64'))) {
      this.data.failures += 1;
      if (this.data.failures >= MAX_FAILURES) {
        this.data.failures = 0;
        this.data.lockedUntil = this.now() + LOCK_MS;
      }
      this.save();
      throw new AdminError('admin-password', 'Wrong admin password.');
    }
    if (this.data.failures || this.data.lockedUntil) {
      this.data.failures = 0;
      this.data.lockedUntil = null;
      this.save();
    }
  }

  /** Set the password (the first time only from the PC) or change it with the current one. */
  async setPassword(next: string, current: string | undefined, origin: AdminOrigin): Promise<AdminStatus> {
    if (typeof next !== 'string' || next.length < MIN_PASSWORD) throw new AdminError('admin-weak', `Use at least ${MIN_PASSWORD} characters.`);
    if (next.length > MAX_PASSWORD) throw new AdminError('admin-weak', 'That password is too long.');
    if (this.data.password) await this.verify(current ?? '');
    else if (origin !== 'desktop') throw new AdminError('admin-no-password', 'Set the admin password on the PC first (Settings → Admin).');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(next, salt);
    this.data.password = { salt: salt.toString('base64'), hash: hash.toString('base64'), setAt: this.now() };
    this.save();
    return this.status();
  }

  /** Remove the password (PC only); an admin session that is running ends with it. */
  async clearPassword(current: string): Promise<AdminStatus> {
    await this.verify(current);
    this.data = { ...EMPTY };
    this.save();
    return this.status();
  }

  async start(password: string, origin: AdminOrigin, device: string | null = null): Promise<AdminStatus> {
    await this.verify(password);
    if (!this.data.session) {
      this.data.session = { since: this.now(), by: origin, device: device?.slice(0, 60) ?? null };
      this.save();
    }
    return this.status();
  }

  /** Ending needs no password: going back to normal is always allowed. */
  end(): AdminStatus {
    if (this.data.session || this.data.resume) {
      this.data.session = null;
      this.data.resume = null;
      this.save();
    }
    return this.status();
  }

  setResume(r: PendingResume | null): void {
    this.data.resume = r;
    this.save();
  }

  /** The restart's task to continue, once (cleared as it is read). */
  takeResume(): PendingResume | null {
    const r = this.data.resume;
    if (r) this.setResume(null);
    return r;
  }

  private load(): AdminFile {
    try {
      const st = fs.statSync(this.file);
      if ((st.mode & 0o077) !== 0) throw new Error(`${this.file} must have permissions 600`);
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AdminFile>;
      return { ...EMPTY, ...d };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`admin: ${(err as Error).message}`);
      return { ...EMPTY };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}

/** A VOID Workshop checkout: the root package is named void-workshop and has the install script and the sidecar. */
export function isWorkshopRepo(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
    return pkg.name === 'void-workshop' && fs.existsSync(path.join(dir, 'scripts', 'install.sh')) && fs.existsSync(path.join(dir, 'sidecar', 'src'));
  } catch {
    return false;
  }
}

/**
 * Where the Workshop source lives: the path install.sh recorded next to the installed app, the tree the sidecar
 * runs from (development), or a void-workshop folder in or next to a recent project.
 */
export function findWorkshopSource(recentProjects: string[], sidecarDir = SIDECAR_DIR): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(fs.readFileSync(path.join(sidecarDir, '..', 'source-dir'), 'utf8').trim());
  } catch {
    /* not recorded (installed before this existed) */
  }
  candidates.push(path.resolve(sidecarDir, '..'));
  for (const p of recentProjects) candidates.push(p, path.join(p, 'void-workshop'), path.join(path.dirname(p), 'void-workshop'));
  for (const c of candidates) {
    if (!c || !path.isAbsolute(c)) continue;
    try {
      const real = fs.realpathSync(c);
      if (isWorkshopRepo(real)) return real;
    } catch {
      /* missing */
    }
  }
  return null;
}
