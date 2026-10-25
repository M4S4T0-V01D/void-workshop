import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Storage for the Anthropic Console API key.
 * Preferred: the desktop Secret Service (KWallet via ksecretd on KDE, GNOME Keyring elsewhere).
 * Headless alternative: a 0600 file in a 0700 directory.
 * The key is never returned to the frontend; callers get status and a short fingerprint only.
 */

export type KeyBackend = 'secret-service' | 'file';

/** What one stored secret is: its keyring entry, its label and how a pasted value is checked. */
export interface SecretSpec {
  account: string;
  label: string;
  validate: (raw: string) => string;
}

export class KeyFormatError extends Error {}

/**
 * Undo common copy/paste damage: whitespace or line breaks anywhere (including Unicode and
 * zero-width characters), surrounding quotes, and `ANTHROPIC_API_KEY=` / `export …=` / `x-api-key:` prefixes.
 */
export function normalizeApiKey(raw: string): string {
  let k = raw.replace(/[\s\u200b-\u200d\u2060\ufeff]+/g, '');
  k = k.replace(/^(?:export)?(?:ANTHROPIC_API_KEY|x-api-key|api[_-]?key)[=:]/i, '');
  k = k.replace(/^(["'`])(.*)\1$/, '$2');
  return k;
}

/** Name the provider of a non-Anthropic key so the user knows what they pasted. Prefixes only, never the key. */
function foreignKeyHint(k: string): string | null {
  if (/^sk-or-/i.test(k)) return 'an OpenRouter key';
  if (/^sk-proj-|^sk-svcacct-|^sk-[A-Za-z0-9]{40,}$/.test(k)) return 'an OpenAI key';
  if (/^AIza/.test(k)) return 'a Google key';
  if (/^gsk_/.test(k)) return 'a Groq key';
  if (/^xai-/.test(k)) return 'an xAI key';
  return null;
}

/**
 * Accept only keys created on the Console's API keys page: personal (sk-ant-usr-), service-account and
 * workspace (legacy sk-ant-api03-) keys. Subscription OAuth tokens, session cookies and admin keys are rejected.
 */
export function validateApiKeyFormat(key: string): string {
  const k = normalizeApiKey(key);
  if (!k) throw new KeyFormatError('The key is empty.');
  if (/^sk-ant-oat/i.test(k))
    throw new KeyFormatError('That is a Claude subscription OAuth token, not a Console API key. VOID Workshop only accepts Console API keys.');
  if (/^sk-ant-admin/i.test(k)) throw new KeyFormatError('That is an Admin API key. Create a regular API key in the Console workspace for this app.');
  if (/^sk-ant-sid/i.test(k)) throw new KeyFormatError("That is a browser session cookie, not an API key. Create a key on the Console's API keys page.");
  const foreign = foreignKeyHint(k);
  if (foreign) throw new KeyFormatError(`That looks like ${foreign}. VOID Workshop only works with Anthropic Console API keys (sk-ant-…).`);
  if (!/^sk-ant-/i.test(k)) throw new KeyFormatError('That is not an Anthropic API key: Console keys start with sk-ant-.');
  if (/[^A-Za-z0-9_-]/.test(k))
    throw new KeyFormatError('The key contains characters an Anthropic key never has. Copy it again from the Console, without extra text.');
  if (!/^sk-ant-[a-z]+\d*-/i.test(k)) throw new KeyFormatError('That is not a complete Anthropic API key (expected sk-ant-<type>-…).');
  if (k.length < 40) throw new KeyFormatError(`The key is only ${k.length} characters long; it looks cut off. Copy the whole key from the Console.`);
  if (k.length > 400) throw new KeyFormatError('The key is too long.');
  return k;
}

export function keyFingerprint(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);
}

function run(cmd: string, args: string[], input?: string, timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input ?? '');
  });
}

export interface KeyStatus {
  configured: boolean;
  backend: KeyBackend | null;
  fingerprint: string | null;
  formatOk: boolean;
  secretServiceAvailable: boolean;
  problem: string | null;
}

export const ANTHROPIC_SECRET: SecretSpec = { account: 'anthropic-api-key', label: 'VOID Workshop: Anthropic API key', validate: validateApiKeyFormat };

export class KeyStore {
  private readonly attrs: string[];
  private readonly validate: (raw: string) => string;
  private readonly label: string;

  constructor(
    private readonly keyFile: string,
    private readonly mode: 'auto' | KeyBackend = (process.env.VOID_WORKSHOP_KEY_BACKEND as 'auto' | KeyBackend) || 'auto',
    spec: SecretSpec = ANTHROPIC_SECRET,
  ) {
    this.attrs = ['service', 'void-workshop', 'account', spec.account];
    this.validate = spec.validate;
    this.label = spec.label;
  }

  async secretServiceAvailable(): Promise<boolean> {
    if (this.mode === 'file') return false;
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
    // A lookup for attributes that never exist: exit 1 with no stderr means the service answered.
    const r = await run('secret-tool', ['lookup', 'service', 'void-workshop-probe', 'account', 'none'], undefined, 8000);
    return r.code !== 127 && !/cannot|error|failed|not provided/i.test(r.stderr);
  }

  async store(rawKey: string, backend: KeyBackend): Promise<KeyStatus> {
    const key = this.validate(rawKey);
    if (backend === 'secret-service') {
      if (!(await this.secretServiceAvailable())) throw new Error('The desktop Secret Service is not available. Use the file backend for headless setups.');
      const r = await run('secret-tool', ['store', `--label=${this.label}`, ...this.attrs], key);
      if (r.code !== 0) throw new Error(`Secret Service refused to store the key (${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}).`);
      // Avoid two competing copies.
      this.removeFile();
    } else {
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(this.keyFile), 0o700);
      const tmp = `${this.keyFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, key, { mode: 0o600, flag: 'w' });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.keyFile);
      if (this.mode !== 'file') await run('secret-tool', ['clear', ...this.attrs]).catch(() => undefined);
    }
    return this.status();
  }

  async remove(): Promise<KeyStatus> {
    if (this.mode !== 'file') await run('secret-tool', ['clear', ...this.attrs]);
    this.removeFile();
    return this.status();
  }

  private removeFile(): void {
    try {
      fs.rmSync(this.keyFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  /** Read the key for an outgoing API call. Callers must not log or forward it. */
  async read(): Promise<{ key: string; backend: KeyBackend } | null> {
    if (this.mode !== 'file') {
      const r = await run('secret-tool', ['lookup', ...this.attrs], undefined, 15_000);
      if (r.code === 0 && r.stdout.trim()) return { key: r.stdout.trim(), backend: 'secret-service' };
    }
    if (this.mode !== 'secret-service' && fs.existsSync(this.keyFile)) {
      const st = fs.statSync(this.keyFile);
      if ((st.mode & 0o077) !== 0) throw new Error(`Key file ${this.keyFile} must have permissions 600.`);
      const key = fs.readFileSync(this.keyFile, 'utf8').trim();
      if (key) return { key, backend: 'file' };
    }
    return null;
  }

  async status(): Promise<KeyStatus> {
    const secretServiceAvailable = await this.secretServiceAvailable();
    try {
      const found = await this.read();
      if (!found) return { configured: false, backend: null, fingerprint: null, formatOk: false, secretServiceAvailable, problem: null };
      let formatOk = true;
      let problem: string | null = null;
      try {
        this.validate(found.key);
      } catch (err) {
        formatOk = false;
        problem = (err as Error).message;
      }
      return { configured: true, backend: found.backend, fingerprint: keyFingerprint(found.key), formatOk, secretServiceAvailable, problem };
    } catch (err) {
      return { configured: false, backend: null, fingerprint: null, formatOk: false, secretServiceAvailable, problem: (err as Error).message };
    }
  }
}
