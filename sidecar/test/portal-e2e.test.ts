import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Server } from '../src/server.js';
import { deriveKeys, parsePairingLink } from '../src/remoteCrypto.js';
import { fakeQueryFn } from './fakeSdk.js';
import { tempRepo, testPaths, writeKeyFile } from './helpers.js';

/**
 * Opt-in end-to-end run through the REAL relay with the VOID Portal app on a phone or emulator:
 *   VOID_PORTAL_E2E=1 VOID_RELAY=wss://<your relay> VOID_PORTAL_LINK_FILE=/tmp/link npx vitest run test/portal-e2e.test.ts
 * It writes the pairing link to the file and prints STEP lines; something else (adb, or you) pairs the
 * phone with the link and approves the command from the phone. The model is simulated; no API is used.
 */
const step = (s: string) => console.log(`STEP ${s}`);
const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

describe.skipIf(process.env.VOID_PORTAL_E2E !== '1')('VOID Portal end to end', () => {
  it('pairs, runs a task approved from the phone, notifies, and goes offline', async () => {
    const paths = testPaths();
    writeKeyFile(paths);
    const events: Array<{ event: string; payload: any }> = [];
    const { fn } = fakeQueryFn({
      onUser: async (_t, ctx) => {
        ctx.text('Running the tests first.');
        const r = await ctx.useTool('Bash', { command: 'npm test', description: 'Run the test suite' });
        ctx.text(r.outcome === 'ran' ? 'All 12 tests pass. The multiply() helper is in place.' : 'You denied the test run.');
        ctx.result({ result: r.outcome === 'ran' ? 'All 12 tests pass. The multiply() helper is in place.' : 'Denied.' });
      },
    });
    const server = new Server(paths, (event, payload) => events.push({ event, payload }), {
      dbFile: ':memory:',
      queryFn: fn,
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    server.store.setFlag('models', { models: [{ id: 'claude-sim', displayName: 'Simulated Claude' }], checkedAt: Date.now() });
    server.store.updateSettings({ model: 'claude-sim', sandboxCommands: false, checkpointBeforeTasks: false, agentMode: 'ask' });
    const root = tempRepo();
    server.store.touchProject(root, 'demo-project');

    await server.handle('remote.setRelay', { url: process.env.VOID_RELAY });
    const { link, device } = (await server.handle('remote.pair', { name: 'Emulator' })) as { link: string; device: { id: string } };
    fs.writeFileSync(process.env.VOID_PORTAL_LINK_FILE!, link);
    step('PAIR_LINK_WRITTEN');
    const status = () => server.remote.status().devices.find((d) => d.id === device.id) ?? { phoneOnline: false };
    await until(() => status().phoneOnline, 180_000, 'the phone to connect');
    step('PHONE_ONLINE');

    const task = (await server.handle('task.start', { root, prompt: 'Add multiply() and run the tests', mode: 'ask' })) as { id: string };
    step('TASK_STARTED');
    await until(() => server.agents.pendingApprovals().length > 0, 30_000, 'the approval request');
    step('APPROVAL_PENDING');
    await until(() => server.store.getTask(task.id)!.state === 'idle', 240_000, 'the phone to approve');
    const resolved = events.find((e) => e.event === 'approval.resolved');
    expect(resolved?.payload.decision).toBe('allow');
    step('TASK_DONE');
    await new Promise((r) => setTimeout(r, 8000));

    step('PC_SHUTTING_DOWN');
    await server.shutdown();
    await new Promise((r) => setTimeout(r, 15_000));
    // Clean up the relay channel.
    const keys = deriveKeys(parsePairingLink(link).secret);
    await fetch(`${process.env.VOID_RELAY!.replace(/^ws/, 'http')}/v1/channel/${keys.channelId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${keys.token}` },
    });
    step('DONE');
  }, 600_000);
});
