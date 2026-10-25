import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ModelEntry } from './auth.js';

/**
 * Claude subscription sign-in. The bundled Claude Code runtime runs its own OAuth login and keeps the
 * tokens in VOID Workshop's isolated runtime config dir (never ~/.claude), so the user's normal Claude
 * Code login is left alone and the tokens never pass through this process or the window.
 */

export interface SubscriptionStatus {
  signedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
  checkedAt: number;
  problem: string | null;
}

/** Store flag with the last known sign-in state. */
export const SUBSCRIPTION_FLAG = 'subscription';
/** Store flag set when the plan's usage limit is reached: { until, message }. */
export const PLAN_LIMIT_FLAG = 'planLimited';
export const SUBSCRIPTION_MODELS_FLAG = 'models:subscription';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_URL_RE = /^https:\/\/(?:claude\.ai|claude\.com|[a-z0-9-]+\.claude\.com|[a-z0-9-]+\.anthropic\.com)\/\S*oauth\/authorize\?\S+$/;

/** The Claude Code runtime binary shipped with the Agent SDK. */
export function bundledClaudeExecutable(): string {
  const req = createRequire(import.meta.url);
  for (const pkg of [
    '@anthropic-ai/claude-agent-sdk-linux-x64',
    '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
    '@anthropic-ai/claude-agent-sdk-linux-arm64',
  ]) {
    try {
      const bin = path.join(path.dirname(req.resolve(`${pkg}/package.json`)), 'claude');
      if (fs.existsSync(bin)) return bin;
    } catch {
      /* not installed for this platform */
    }
  }
  throw new Error('The Claude Code runtime that ships with the Agent SDK was not found. Reinstall VOID Workshop.');
}

export function isLoginUrl(url: string): boolean {
  return LOGIN_URL_RE.test(url) && url.length < 4000;
}

/** Model list from the runtime's initialize answer: aliases resolved to model ids, duplicates dropped. */
export function subscriptionModels(models: ModelInfo[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const m of models) {
    const id = m.resolvedModel || m.value;
    if (!id || id.length > 120 || out.some((x) => x.id === id)) continue;
    out.push({ id, displayName: m.displayName || id, createdAt: null, maxInputTokens: null, maxOutputTokens: null });
  }
  return out;
}

function run(bin: string, args: string[], env: Record<string, string>, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const lastLine = (s: string) =>
  s
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .pop()
    ?.slice(0, 300) ?? '';

export class ClaudeLogin {
  private child: ChildProcess | null = null;

  constructor(
    /** Runtime environment (scrubbed, with CLAUDE_CONFIG_DIR pointing at the isolated runtime dir). */
    private readonly env: () => Record<string, string>,
    private readonly bin: () => string = bundledClaudeExecutable,
  ) {}

  get inProgress(): boolean {
    return this.child !== null;
  }

  async status(): Promise<SubscriptionStatus> {
    const checkedAt = Date.now();
    let r;
    try {
      r = await run(this.bin(), ['auth', 'status', '--json'], this.env());
    } catch (err) {
      return { signedIn: false, email: null, subscriptionType: null, checkedAt, problem: (err as Error).message };
    }
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string };
      // Only a Claude plan login counts; a Console login made outside VOID Workshop is not used.
      const signedIn = j.loggedIn === true && !/console|api[_-]?key/i.test(j.authMethod ?? '');
      return {
        signedIn,
        email: signedIn && typeof j.email === 'string' ? j.email.slice(0, 200) : null,
        subscriptionType: signedIn && typeof j.subscriptionType === 'string' ? j.subscriptionType.slice(0, 40) : null,
        checkedAt,
        problem: j.loggedIn && !signedIn ? 'The runtime is signed in with a Console account, not a Claude plan. Sign out and sign in again.' : null,
      };
    } catch {
      return { signedIn: false, email: null, subscriptionType: null, checkedAt, problem: lastLine(r.stderr) || 'Could not read the sign-in status.' };
    }
  }

  /**
   * Run `claude auth login --claudeai`. The runtime makes two links: one it opens in the browser (through
   * a stand-in opener that only records it, since the sidecar has no display) whose page returns to a
   * listener on this machine and finishes by itself, and a fallback it prints whose page shows a code to
   * paste back. `onUrl` gets the automatic link (or the fallback if no browser is requested within a few
   * seconds), plus the fallback once known; `submitCode` passes a pasted code to the runtime.
   * Resolves when the login finished; rejects when it failed, timed out or was cancelled.
   */
  async login(onUrl: (urls: { url: string; manualUrl: string | null }) => void): Promise<void> {
    if (this.child) throw new Error('A sign-in is already in progress.');
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-login-'));
    const urlFile = path.join(shimDir, 'url');
    const shim = path.join(shimDir, 'xdg-open');
    fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$1" > '${urlFile}'\n`, { mode: 0o700 });
    for (const name of ['open', 'sensible-browser', 'x-www-browser']) fs.symlinkSync(shim, path.join(shimDir, name));
    const base = this.env();
    const env = { ...base, PATH: `${shimDir}:${base.PATH ?? '/usr/bin:/bin'}`, BROWSER: shim };

    let autoUrl: string | null = null;
    let manualUrl: string | null = null;
    let announced = '';
    const announce = () => {
      const url = autoUrl ?? manualUrl;
      if (!url) return;
      const key = `${url} ${manualUrl}`;
      if (key === announced) return;
      announced = key;
      onUrl({ url, manualUrl });
    };
    const started = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const child = spawn(this.bin(), ['auth', 'login', '--claudeai'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        child.stdin.on('error', () => undefined);
        const poll = setInterval(() => {
          if (!autoUrl && fs.existsSync(urlFile)) {
            const u = fs.readFileSync(urlFile, 'utf8').trim();
            if (isLoginUrl(u)) autoUrl = u;
          }
          // Prefer the link that finishes by itself; fall back to the code page if no browser was asked for.
          if (autoUrl || Date.now() - started > 3000) announce();
        }, 200);
        const timer = setTimeout(() => child.kill('SIGTERM'), LOGIN_TIMEOUT_MS);
        const onData = (d: Buffer) => {
          output = (output + d.toString('utf8')).slice(-20_000);
          for (const m of output.match(/https:\/\/\S+/g) ?? []) if (!manualUrl && isLoginUrl(m)) manualUrl = m;
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (err) => {
          clearInterval(poll);
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code, signal) => {
          clearInterval(poll);
          clearTimeout(timer);
          if (code === 0) resolve();
          else if (signal) reject(new Error('Sign-in was cancelled or timed out.'));
          else reject(new Error(`Sign-in did not finish${lastLine(output) ? `: ${lastLine(output)}` : ` (exit ${code})`}.`));
        });
      });
    } finally {
      this.child = null;
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  }

  /** Pass the code Claude's page showed ("Paste this into Claude Code") to the running sign-in. */
  submitCode(code: string): void {
    const c = code.trim();
    if (!/^[A-Za-z0-9_-]{8,512}#[A-Za-z0-9_-]{8,512}$/.test(c)) throw new Error('That does not look like the code from the Claude sign-in page.');
    if (!this.child?.stdin?.writable) throw new Error('No sign-in is waiting for a code. Start "Sign in with Claude" again.');
    this.child.stdin.write(`${c}\n`);
  }

  cancel(): boolean {
    if (!this.child) return false;
    this.child.kill('SIGTERM');
    return true;
  }

  async logout(): Promise<void> {
    const r = await run(this.bin(), ['auth', 'logout'], this.env());
    if (r.code !== 0) throw new Error(`Sign-out failed: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
  }
}
