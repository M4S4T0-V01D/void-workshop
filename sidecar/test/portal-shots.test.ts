import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, vi } from 'vitest';
import { Server } from '../src/server.js';
import { parsePairingLink } from '../src/remoteCrypto.js';
import { fakeQueryFn, write } from './fakeSdk.js';
import { tempRepo, testPaths, writeKeyFile } from './helpers.js';

/**
 * Opt-in: a demo PC for VOID Portal screenshots (see Screenshots in remote/README.md). The real sidecar talks
 * to a LOCAL relay (wrangler dev) with a simulated model and demo projects, so no API, no real relay and
 * nothing from this machine shows up on the phone:
 *   VOID_PORTAL_SHOTS=1 VOID_RELAY=ws://127.0.0.1:8787 VOID_PORTAL_LINK_FILE=/tmp/x npx vitest run test/portal-shots.test.ts
 * Writes "<relay> <secret hex>" to the link file and runs until <link file>.done exists.
 */
const step = (s: string) => console.log(`STEP ${s}`);
const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

describe.skipIf(process.env.VOID_PORTAL_SHOTS !== '1')('VOID Portal screenshot PC', () => {
  it('serves demo tasks to the phone', async () => {
    // The PC name the phone shows comes from os.hostname(); a demo name keeps this machine's out of the shots.
    vi.spyOn(os, 'hostname').mockReturnValue('Workstation');
    const paths = testPaths();
    writeKeyFile(paths);
    // Straight into the config file: setRelay only takes wss://, and this relay is on loopback.
    const conf = path.join(paths.configDir, 'credentials', 'remote.json');
    fs.writeFileSync(conf, JSON.stringify({ relayUrl: process.env.VOID_RELAY, devices: [] }), { mode: 0o600 });

    const { fn } = fakeQueryFn({
      onUser: async (text, ctx) => {
        const cwd = ctx.options.cwd!;
        if (text.startsWith('Our API client')) {
          await ctx.useTool('TodoWrite', {
            todos: [
              { content: 'Add a retry helper with exponential backoff', activeForm: 'Adding a retry helper', status: 'completed' },
              { content: 'Use it in getJson for 5xx responses', activeForm: 'Using it in getJson', status: 'completed' },
              { content: 'Cover it with a unit test', activeForm: 'Covering it with a test', status: 'completed' },
            ],
          });
          ctx.text("I'll look at how requests are made first.");
          await ctx.useTool('Read', { file_path: path.join(cwd, 'src/http.ts') });
          await ctx.useTool('Write', { file_path: path.join(cwd, 'src/retry.ts'), content: 'export const retry = async <T>(fn: () => Promise<T>) => fn();\n' });
          const done =
            'Done. src/retry.ts adds a retry helper with exponential backoff and full jitter; src/http.ts retries 5xx responses only. The tests pass.';
          ctx.text(done);
          ctx.result({ result: done, cost: 0.08, turns: 6 });
        } else if (text.startsWith('Tighten')) {
          const done = 'Satellite.orbit is now a union of the four orbit kinds, and the two call sites narrow it.';
          ctx.text(done);
          ctx.result({ result: done, cost: 0.02, turns: 3 });
        } else {
          ctx.text('Adding a usage section with a short example for getSatellite().');
          await ctx.useTool('TodoWrite', {
            todos: [
              { content: 'Read the current README', activeForm: 'Reading the README', status: 'completed' },
              { content: 'Add a usage section', activeForm: 'Adding a usage section', status: 'in_progress' },
              { content: 'Document error handling', activeForm: 'Documenting error handling', status: 'pending' },
            ],
          });
          const r = await ctx.useTool('Edit', {
            file_path: path.join(cwd, 'README.md'),
            old_string: '# orbit-api',
            new_string:
              '# orbit-api\n\nTyped client for the Orbit satellite API.\n\n## Usage\n\n```ts\nconst sat = await getSatellite("ISS");\nconsole.log(sat.orbit);\n```',
          });
          ctx.result({ result: r.outcome === 'ran' ? 'README updated.' : 'Stopped.', cost: 0.03, turns: 2 });
        }
      },
    });
    const server = new Server(paths, () => {}, { dbFile: ':memory:', queryFn: fn, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME } });
    server.store.setFlag('models', {
      models: [
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
      ],
      checkedAt: Date.now(),
    });
    server.store.updateSettings({ model: 'claude-sonnet-5-5', sandboxCommands: false, checkpointBeforeTasks: false, agentMode: 'ask' });

    // Demo repos with tidy names, so the phone shows "orbit-api" and not a temp folder.
    const demoBase = fs.mkdtempSync(path.join(path.dirname(paths.configDir), 'demo-'));
    const project = async (name: string) => {
      const root = path.join(demoBase, name);
      fs.renameSync(tempRepo(), root);
      return ((await server.handle('project.open', { root })) as { root: string }).root;
    };
    const site = await project('nebula-site');
    const api = await project('orbit-api');
    write(api, 'README.md', '# orbit-api\n');
    write(api, 'src/http.ts', 'export const getJson = (p: string) => fetch(p).then((r) => r.json());\n');

    const { link } = (await server.handle('remote.pair', { name: 'Pixel' })) as { link: string };
    fs.writeFileSync(process.env.VOID_PORTAL_LINK_FILE!, `${process.env.VOID_RELAY} ${parsePairingLink(link).secret.toString('hex')}`);
    step('PAIR_LINK_WRITTEN');
    await until(() => server.remote.status().devices.some((d) => d.phoneOnline), 300_000, 'the phone to connect');
    step('PHONE_ONLINE');

    const run = async (root: string, prompt: string, mode: string) => {
      const t = (await server.handle('task.start', { root, prompt, mode })) as { id: string };
      return t.id;
    };
    const t1 = await run(site, 'Tighten the Satellite types', 'auto-edit');
    await until(() => server.store.getTask(t1)!.state === 'idle', 30_000, 'task 1');
    const t2 = await run(api, 'Our API client gives up on the first 503. Add retries with exponential backoff for server errors only.', 'auto-edit');
    await until(() => server.store.getTask(t2)!.state === 'idle', 30_000, 'task 2');
    await run(api, 'Document the client in the README with a usage example', 'ask');
    await until(() => server.agents.pendingApprovals().length > 0, 30_000, 'the approval request');
    step('READY');

    await until(() => fs.existsSync(`${process.env.VOID_PORTAL_LINK_FILE}.done`), 1_200_000, 'the screenshots');
    await server.shutdown();
    step('DONE');
  }, 1_500_000);
});
