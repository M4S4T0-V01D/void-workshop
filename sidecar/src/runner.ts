import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from './redact.js';

/**
 * Runs user-approved commands as argv arrays (never through a shell) in their own process group,
 * with a timeout, an output cap and full process-tree cleanup.
 */

export interface RunSpec {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

/** Environment for project commands: user basics only, never Anthropic or agent-runtime variables. */
export function commandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'SHELL',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'GOPATH',
    'NVM_DIR',
    'JAVA_HOME',
    'ANDROID_HOME',
  ];
  const env: NodeJS.ProcessEnv = { TERM: 'dumb', NO_COLOR: '1', CI: '1' };
  for (const k of keep) if (base[k]) env[k] = base[k];
  return env;
}

export class CommandRunner {
  private readonly running = new Map<string, { child: ChildProcess; cancel: () => void }>();

  run(spec: RunSpec, onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void): { id: string; done: Promise<RunResult> } {
    const id = crypto.randomUUID();
    const started = Date.now();
    let output = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    const done = new Promise<RunResult>((resolve) => {
      if (!spec.argv.length || !spec.argv[0]) {
        resolve({ exitCode: null, signal: null, durationMs: 0, output: '', truncated: false, timedOut: false, cancelled: false, error: 'Empty command' });
        return;
      }
      if (!fs.existsSync(spec.cwd) || !fs.statSync(spec.cwd).isDirectory()) {
        resolve({
          exitCode: null,
          signal: null,
          durationMs: 0,
          output: '',
          truncated: false,
          timedOut: false,
          cancelled: false,
          error: 'Working directory does not exist',
        });
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(spec.argv[0]!, spec.argv.slice(1), {
          cwd: spec.cwd,
          env: spec.env ?? commandEnv(),
          shell: false,
          detached: true, // own process group so the whole tree can be signalled
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          exitCode: null,
          signal: null,
          durationMs: Date.now() - started,
          output: '',
          truncated: false,
          timedOut: false,
          cancelled: false,
          error: (err as Error).message,
        });
        return;
      }

      const killTree = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = () => {
        killTree('SIGTERM');
        killTimer = setTimeout(() => killTree('SIGKILL'), 3000);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, spec.timeoutMs);

      this.running.set(id, {
        child,
        cancel: () => {
          cancelled = true;
          terminate();
        },
      });

      const onData = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
        if (truncated) return;
        const remaining = spec.maxOutputBytes - bytes;
        let chunk = data;
        if (data.length > remaining) {
          chunk = data.subarray(0, Math.max(0, remaining));
          truncated = true;
        }
        bytes += chunk.length;
        const text = redactText(chunk.toString('utf8'));
        output += text;
        if (text) onOutput(text, stream);
        if (truncated) {
          onOutput(`\n[output limit of ${Math.round(spec.maxOutputBytes / 1024)} KB reached; further output discarded]\n`, 'stderr');
        }
      };
      child.stdout?.on('data', onData('stdout'));
      child.stderr?.on('data', onData('stderr'));

      let spawnError: string | undefined;
      child.on('error', (err) => {
        spawnError = (err as NodeJS.ErrnoException).code === 'ENOENT' ? `Command not found: ${spec.argv[0]}` : err.message;
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        // Make sure nothing in the group survives (e.g. grandchildren that ignored SIGTERM).
        killTree('SIGKILL');
        if (killTimer) clearTimeout(killTimer);
        this.running.delete(id);
        resolve({ exitCode: code, signal, durationMs: Date.now() - started, output, truncated, timedOut, cancelled, error: spawnError });
      });
    });
    return { id, done };
  }

  cancel(id: string): boolean {
    const r = this.running.get(id);
    if (!r) return false;
    r.cancel();
    return true;
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.cancel();
  }

  get activeCount(): number {
    return this.running.size;
  }
}

export interface SuggestedCommand {
  label: string;
  argv: string[];
  reason: string;
}

/** Suggest build/test/lint/type-check commands from project manifests. Nothing runs until approved. */
export function detectCommands(root: string): SuggestedCommand[] {
  const out: SuggestedCommand[] = [];
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const pm = fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : fs.existsSync(path.join(root, 'yarn.lock'))
          ? 'yarn'
          : fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))
            ? 'bun'
            : 'npm';
      for (const name of Object.keys(pkg.scripts ?? {})) {
        if (/^(test|build|lint|typecheck|type-check|check|format|fmt|tsc)(:.*)?$/.test(name)) {
          out.push({ label: `${pm} run ${name}`, argv: [pm, 'run', name], reason: `package.json script: ${(pkg.scripts ?? {})[name]}` });
        }
      }
    } catch {
      /* ignore malformed package.json */
    }
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    out.push({ label: 'cargo check', argv: ['cargo', 'check'], reason: 'Type-check the Rust crate' });
    out.push({ label: 'cargo test', argv: ['cargo', 'test'], reason: 'Run Rust tests' });
    out.push({ label: 'cargo clippy', argv: ['cargo', 'clippy'], reason: 'Lint Rust code' });
    out.push({ label: 'cargo fmt --check', argv: ['cargo', 'fmt', '--check'], reason: 'Check Rust formatting' });
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
    out.push({ label: 'pytest', argv: ['pytest'], reason: 'Run Python tests' });
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    out.push({ label: 'go test ./...', argv: ['go', 'test', './...'], reason: 'Run Go tests' });
    out.push({ label: 'go vet ./...', argv: ['go', 'vet', './...'], reason: 'Vet Go code' });
  }
  if (fs.existsSync(path.join(root, 'Makefile'))) {
    out.push({ label: 'make test', argv: ['make', 'test'], reason: 'Makefile test target (if defined)' });
  }
  return out;
}
