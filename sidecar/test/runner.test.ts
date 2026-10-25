import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandRunner, commandEnv, detectCommands } from '../src/runner.js';
import { tempDir } from './helpers.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('command runner', () => {
  it('captures stdout, stderr, exit status and duration', async () => {
    const r = new CommandRunner();
    const chunks: string[] = [];
    const { done } = r.run({ argv: ['sh', '-c', 'echo out; echo err >&2; exit 3'], cwd: tempDir(), timeoutMs: 10_000, maxOutputBytes: 10_000 }, (c) =>
      chunks.push(c),
    );
    const res = await done;
    expect(res.exitCode).toBe(3);
    expect(res.output).toContain('out');
    expect(res.output).toContain('err');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(chunks.join('')).toContain('out');
  });

  it('passes arguments verbatim without a shell', async () => {
    const r = new CommandRunner();
    const { done } = r.run({ argv: ['printf', '%s', '$(whoami); rm -rf /'], cwd: tempDir(), timeoutMs: 5_000, maxOutputBytes: 10_000 }, () => {});
    expect((await done).output).toBe('$(whoami); rm -rf /');
  });

  it('times out and kills the whole process tree', async () => {
    const r = new CommandRunner();
    const dir = tempDir();
    const pidFile = path.join(dir, 'child.pid');
    const { done } = r.run({ argv: ['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`], cwd: dir, timeoutMs: 500, maxOutputBytes: 10_000 }, () => {});
    const res = await done;
    expect(res.timedOut).toBe(true);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((r2) => setTimeout(r2, 300));
    expect(alive(grandchild)).toBe(false);
  });

  it('cancels a running command', async () => {
    const r = new CommandRunner();
    const { id, done } = r.run({ argv: ['sleep', '30'], cwd: tempDir(), timeoutMs: 60_000, maxOutputBytes: 10_000 }, () => {});
    setTimeout(() => r.cancel(id), 100);
    const res = await done;
    expect(res.cancelled).toBe(true);
    expect(r.activeCount).toBe(0);
  });

  it('caps output size', async () => {
    const r = new CommandRunner();
    const { done } = r.run({ argv: ['sh', '-c', 'yes 0123456789 | head -c 200000'], cwd: tempDir(), timeoutMs: 10_000, maxOutputBytes: 1000 }, () => {});
    const res = await done;
    expect(res.truncated).toBe(true);
    expect(res.output.length).toBeLessThanOrEqual(1000);
  });

  it('reports missing programs', async () => {
    const r = new CommandRunner();
    const res = await r.run({ argv: ['definitely-not-a-program-xyz'], cwd: tempDir(), timeoutMs: 5_000, maxOutputBytes: 1000 }, () => {}).done;
    expect(res.error).toMatch(/not found/);
  });

  it('redacts secrets in output', async () => {
    const r = new CommandRunner();
    const res = await r.run(
      { argv: ['echo', 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET'], cwd: tempDir(), timeoutMs: 5_000, maxOutputBytes: 10_000 },
      () => {},
    ).done;
    expect(res.output).not.toContain('SECRETSECRET');
  });

  it('builds an environment without Anthropic or agent variables', () => {
    const env = commandEnv({ PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', CLAUDE_CONFIG_DIR: '/c', DBUS_SESSION_BUS_ADDRESS: 'unix:x' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it('detects build and test commands from manifests', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'vite build', dev: 'vite', postinstall: 'curl x' } }));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname="x"\n');
    const labels = detectCommands(dir).map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['npm run test', 'npm run build', 'cargo test']));
    expect(labels).not.toContain('npm run dev');
    expect(labels).not.toContain('npm run postinstall');
  });
});
