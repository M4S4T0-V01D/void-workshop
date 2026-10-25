import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REMOTE_METHODS } from '../src/remote.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(repo, rel), 'utf8');
/** src/rpcMethods.ts lives outside the sidecar's TypeScript project, so read it as text. */
const WINDOW_METHODS = [...read('src/rpcMethods.ts').matchAll(/^ {2}'([A-Za-z.]+)',$/gm)].map((m) => m[1]!);

/** The Rust shell's allow-list: a call missing from it fails in the window, whatever the backend supports. */
function shellMethods(): string[] {
  const policy = read('src-tauri/src/policy.rs');
  const start = policy.indexOf('ALLOWED_METHODS');
  return [...policy.slice(start, policy.indexOf('];', start)).matchAll(/"([A-Za-z.]+)"/g)].map((m) => m[1]!);
}

/** Method names in the server's handler table. */
function handlers(): Set<string> {
  return new Set([...read('sidecar/src/server.ts').matchAll(/^ {4}'([A-Za-z.]+)': async/gm)].map((m) => m[1]!));
}

describe('RPC method lists', () => {
  it("the window's typed list is exactly the shell's allow-list", () => {
    expect([...WINDOW_METHODS].sort()).toEqual(shellMethods().sort());
  });

  it('every method the window or the phone may call has a handler', () => {
    const h = handlers();
    expect(h.size).toBeGreaterThan(40);
    expect(shellMethods().filter((m) => !h.has(m))).toEqual([]);
    // remote.state is answered by the bridge itself.
    expect([...REMOTE_METHODS].filter((m) => m !== 'remote.state' && !h.has(m))).toEqual([]);
  });

  it('allows every method the window calls', () => {
    const allowed = new Set(shellMethods());
    const used = new Set<string>();
    for (const f of readdirSync(path.join(repo, 'src'), { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f)) continue;
      for (const m of read(path.join('src', f)).matchAll(/\bcall(?:<[^(]*>)?\(\s*'([A-Za-z.]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((m) => !allowed.has(m)).sort()).toEqual([]);
  });
});
