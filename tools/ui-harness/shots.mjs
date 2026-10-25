#!/usr/bin/env node
// Captures the README / website screenshots from the real UI with a seeded demo project and task.
// Everything (project, database, config) lives in fresh temp directories and no API key is used,
// so nothing from the machine running it can appear in the images.
//
//   node tools/ui-harness/shots.mjs [--out docs/screenshots]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startHarness, SHIM } from './harness.mjs';

const args = process.argv.slice(2);
const out = path.resolve(args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/screenshots');
fs.mkdirSync(out, { recursive: true });

// ---- demo project ------------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-shots-'));
const project = path.join(root, 'orbit-api');
const keyFile = path.join(root, 'demo-key');
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), text);
};
const HTTP_BEFORE = `import type { Satellite } from './types';

const BASE = 'https://api.orbit.example/v1';

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(\`\${BASE}\${path}\`);
  if (!res.ok) throw new Error(\`GET \${path} failed: \${res.status}\`);
  return (await res.json()) as T;
}

export const listSatellites = () => getJson<Satellite[]>('/satellites');
export const getSatellite = (id: string) => getJson<Satellite>(\`/satellites/\${id}\`);
`;
const HTTP_AFTER = `import type { Satellite } from './types';
import { retry } from './retry';

const BASE = 'https://api.orbit.example/v1';

export async function getJson<T>(path: string): Promise<T> {
  return retry(async () => {
    const res = await fetch(\`\${BASE}\${path}\`);
    if (res.status >= 500) throw new Error(\`GET \${path} failed: \${res.status}\`);
    if (!res.ok) throw Object.assign(new Error(\`GET \${path} failed: \${res.status}\`), { retry: false });
    return (await res.json()) as T;
  });
}

export const listSatellites = () => getJson<Satellite[]>('/satellites');
export const getSatellite = (id: string) => getJson<Satellite>(\`/satellites/\${id}\`);
`;
const RETRY = `export interface RetryOptions {
  /** Attempts including the first one. */
  attempts?: number;
  /** Delay before the first retry, doubled after each failure. */
  baseMs?: number;
  /** Upper bound for a single delay. */
  maxMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fn, retrying failures with exponential backoff and full jitter. */
export async function retry<T>(fn: () => Promise<T>, { attempts = 4, baseMs = 200, maxMs = 5_000 }: RetryOptions = {}): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if ((err as { retry?: boolean }).retry === false || i === attempts - 1) break;
      await sleep(Math.random() * Math.min(maxMs, baseMs * 2 ** i));
    }
  }
  throw lastError;
}
`;
write('package.json', JSON.stringify({ name: 'orbit-api', version: '0.3.0', type: 'module', scripts: { test: 'vitest run', build: 'tsc -p .' } }, null, 2) + '\n');
write('README.md', '# orbit-api\n\nTiny typed client for the Orbit satellite tracking API.\n');
write('tsconfig.json', '{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022", "outDir": "dist" } }\n');
write('src/types.ts', 'export interface Satellite {\n  id: string;\n  name: string;\n  noradId: number;\n  inclination: number;\n  periodMinutes: number;\n}\n');
write('src/http.ts', HTTP_AFTER);
write('src/retry.ts', RETRY);
write('src/index.ts', "export * from './http';\nexport * from './retry';\nexport type { Satellite } from './types';\n");
write('test/retry.test.ts', "import { describe, expect, it } from 'vitest';\nimport { retry } from '../src/retry';\n\ndescribe('retry', () => {\n  it('retries until success', async () => {\n    let n = 0;\n    expect(await retry(async () => (++n < 3 ? Promise.reject(new Error('x')) : n), { baseMs: 1 })).toBe(3);\n  });\n});\n");
write('.gitignore', 'node_modules\ndist\n');

// ---- demo database -----------------------------------------------------------------------------
const RETRY_ID = crypto.randomUUID();
async function seed(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const { Store } = await import('../../sidecar/dist/db.js');
  const store = new Store(path.join(dataDir, 'workshop.db'));
  const db = store.db;
  store.updateSettings({ model: 'claude-sonnet-5-5' });
  // A dummy key (never sent: verification only runs when the user asks) and a model list.
  const model = (id, displayName) => ({ id, displayName, createdAt: null, maxInputTokens: 1_000_000, maxOutputTokens: 64_000 });
  store.setFlag('models', { models: [model('claude-opus-5-5', 'Claude Opus 5.5'), model('claude-sonnet-5-5', 'Claude Sonnet 5.5'), model('claude-haiku-5-5', 'Claude Haiku 5.5')], checkedAt: Date.now() });
  store.setFlag('lastVerify', { ok: true, checkedAt: Date.now(), modelCount: 3 });
  const now = Date.now();
  fs.writeFileSync(keyFile, 'sk-ant-api03-demo-key-for-screenshots-only\n', { mode: 0o600 });
  db.prepare('INSERT INTO projects(path, name, last_opened) VALUES (?, ?, ?)').run(project, 'orbit-api', now);

  const task = (id, title, prompt, state, ago, cost, events) => {
    const t0 = now - ago;
    db.prepare(
      `INSERT INTO tasks(id, project, title, prompt, model, state, created_at, updated_at, cost_usd, input_tokens, output_tokens, turns, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, project, title, prompt, 'claude-sonnet-5-5', state, t0, t0 + 90_000, cost, 48_210, 3_904, 9, null);
    const ins = db.prepare('INSERT INTO task_events(task_id, ts, kind, payload) VALUES (?, ?, ?, ?)');
    events.forEach(([kind, payload], i) => ins.run(id, t0 + i * 4000, kind, JSON.stringify(payload)));
  };
  const todo = (subject, status, i) => ({ ref: `t${i}`, id: String(i), subject, description: '', status });
  const items = [
    todo('Add a retry helper with exponential backoff', 'completed', 1),
    todo('Use it in getJson for 5xx responses', 'completed', 2),
    todo('Cover it with a unit test', 'completed', 3),
  ];
  task(RETRY_ID, 'Retry failed API calls with backoff', 'Our API client gives up on the first 503. Add retries with exponential backoff for server errors only, and a test.', 'completed', 600_000, 0.0841, [
    ['user', { text: 'Our API client gives up on the first 503. Add retries with exponential backoff for server errors only, and a test.' }],
    ['assistant', { text: "I'll look at how requests are made first." }],
    ['tool', { id: 'r1', name: 'Read', summary: 'src/http.ts' }],
    ['tool.result', { id: 'r1', isError: false, text: HTTP_BEFORE }],
    ['todos', { items: items.map((x) => ({ ...x, status: 'pending' })) }],
    ['tool', { id: 'w1', name: 'Write', summary: 'src/retry.ts' }],
    ['tool.result', { id: 'w1', isError: false, text: 'File created successfully at: src/retry.ts' }],
    ['tool', { id: 'e1', name: 'Edit', summary: 'src/http.ts' }],
    ['tool.result', { id: 'e1', isError: false, text: 'The file src/http.ts has been updated successfully.' }],
    ['tool', { id: 'w2', name: 'Write', summary: 'test/retry.test.ts' }],
    ['tool.result', { id: 'w2', isError: false, text: 'File created successfully at: test/retry.test.ts' }],
    ['approval.resolved', { kind: 'command', summary: 'npx vitest run test/retry.test.ts', decision: 'allow' }],
    ['tool', { id: 'b1', name: 'Bash', summary: 'npx vitest run test/retry.test.ts' }],
    ['tool.result', { id: 'b1', isError: false, text: ' ✓ test/retry.test.ts (1 test) 4ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)' }],
    ['todos', { items }],
    [
      'assistant',
      {
        text:
          'Done. src/retry.ts adds a retry helper with exponential backoff and full jitter (4 attempts, 200 ms base, 5 s cap); errors marked retry: false fail at once. src/http.ts now retries 5xx responses only, and test/retry.test.ts covers the retry path. The tests pass. Review the two changed files in the Changes panel before keeping them.',
      },
    ],
    ['result', { subtype: 'success', deltaUsd: 0.0841, totalUsd: 0.0841, tokens: { input: 48210, output: 3904, cacheRead: 31000, cacheWrite: 9000 }, costBasis: 'list' }],
  ]);
  task(crypto.randomUUID(), 'Document the client in the README', 'Write usage docs for the README.', 'completed', 86_400_000, 0.0312, [
    ['user', { text: 'Write usage docs for the README.' }],
    ['assistant', { text: 'Added an install and usage section to README.md.' }],
  ]);
  task(crypto.randomUUID(), 'Tighten Satellite types', 'Make the Satellite fields readonly.', 'completed', 2 * 86_400_000, 0.0127, [
    ['user', { text: 'Make the Satellite fields readonly.' }],
    ['assistant', { text: 'All Satellite fields are now readonly.' }],
  ]);

  // Review diffs: original contents are kept as preimages, like PreimageStore.capture does.
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const pre = path.join(dataDir, 'preimages', RETRY_ID);
  fs.mkdirSync(pre, { recursive: true });
  const httpReal = path.join(project, 'src/http.ts');
  const preFile = path.join(pre, sha(httpReal).slice(0, 32));
  fs.writeFileSync(preFile, HTTP_BEFORE);
  store.upsertFileChange({ task_id: RETRY_ID, path: httpReal, status: 'proposed', preimage_file: preFile, existed: 1, pre_hash: sha(HTTP_BEFORE), post_hash: null });
  for (const rel of ['src/retry.ts', 'test/retry.test.ts'])
    store.upsertFileChange({ task_id: RETRY_ID, path: path.join(project, rel), status: 'proposed', preimage_file: null, existed: 0, pre_hash: null, post_hash: null });
  db.close();
}

// ---- capture -----------------------------------------------------------------------------------
const harness = await startHarness({ pickDir: project, keyBackend: 'file', keyFile, seed });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 920 }, deviceScaleFactor: 1 });
await page.addInitScript(SHIM);
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const step = process.env.STEP;

try {
  await page.goto(harness.url);
  await page.locator('.statusbar').waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await shot('welcome');
  if (step === 'welcome') throw new Error('stop');
  await page.getByRole('button', { name: /Open project/ }).first().click();
  const openFolder = page.getByRole('button', { name: 'Open folder…' });
  if (await openFolder.isVisible().catch(() => false)) await openFolder.click();
  await page.getByText('Sessions', { exact: true }).waitFor();
  await page.getByText('Retry failed API calls with backoff').first().click();
  await page.getByTitle('Collapse panel').click();
  await page.waitForTimeout(800);
  await page.mouse.move(740, 300);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);
  await shot('workspace');

  // Review: the per-file diff in the Changes tab
  await page.locator('.tab', { hasText: 'Changes' }).click();
  await page.locator('.change-head', { hasText: 'http.ts' }).click();
  await page.waitForTimeout(400);
  await shot('review');

  // Editor: open a file from the tree
  await page.locator('.tree-row', { hasText: 'src' }).first().click();
  await page.locator('.tree-row', { hasText: 'retry.ts' }).first().click();
  await page.locator('.code-editor').waitFor();
  await page.waitForTimeout(500);
  await shot('editor');

  // Appearance settings, then the same editor in another theme
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Appearance' }).click();
  await page.waitForTimeout(300);
  await shot('themes');
  await page.getByRole('button', { name: 'Nebula' }).click();
  await page.getByRole('button', { name: 'VOID Portal (phone)' }).click();
  await page.waitForTimeout(300);
  await shot('portal-settings');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await shot('editor-nebula');
} catch (err) {
  if (String(err) !== 'Error: stop') {
    console.error(String(err));
    process.exitCode = 1;
  }
  await shot('failure').catch(() => {});
} finally {
  await browser.close();
  await harness.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
