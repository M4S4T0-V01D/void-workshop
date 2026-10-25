import { describe, expect, it } from 'vitest';
import { Server } from '../src/server.js';
import { testPaths, tempRepo, writeKeyFile } from './helpers.js';

/**
 * Opt-in checks against the REAL Agent SDK runtime (VOID_LIVE_SDK=1).
 * They use a well-formed but invalid key, so the API answers 401 and nothing is billed.
 * Run with: npm run test:live
 */
const live = process.env.VOID_LIVE_SDK === '1';
const INVALID_KEYS = {
  workspace: 'sk-ant-api03-' + 'Z'.repeat(86) + '-INVALIDAA',
  personal: 'sk-ant-usr-1v-' + 'Z'.repeat(84) + '-INVALIDAA',
};

describe.skipIf(!live)('real Agent SDK runtime (zero-cost)', () => {
  function setup(key: string | null) {
    const paths = testPaths();
    if (key) writeKeyFile(paths, key);
    const events: Array<{ event: string; payload: any }> = [];
    const server = new Server(paths, (event, payload) => events.push({ event, payload }), {
      dbFile: ':memory:',
      baseEnv: { ...process.env, VOID_WORKSHOP_KEY_BACKEND: 'file' },
    });
    // A model id is required to start; it is only sent to the API after the auth gate passes.
    server.store.setFlag('models', { models: [{ id: 'claude-haiku-5-5', displayName: 'Haiku' }], checkedAt: Date.now() });
    server.store.updateSettings({ model: 'claude-haiku-5-5', checkpointBeforeTasks: false, sandboxCommands: true });
    return { server, events, root: tempRepo() };
  }

  it('without a key: refuses before launching anything', async () => {
    const { server, root } = setup(null);
    await expect(server.handle('task.start', { root, prompt: 'hello' })).rejects.toMatchObject({ code: 'missing-key' });
    await server.shutdown();
  });

  it.each(Object.entries(INVALID_KEYS))(
    'with an invalid %s key: authenticates via the key helper only, gets 401 and stops at once',
    async (_kind, key) => {
      const { server, events, root } = setup(key);
      const task = (await server.handle('task.start', { root, prompt: 'Say hello.', planFirst: false })) as { id: string };
      const auth = events.find((e) => e.event === 'agent.auth');
      expect(auth?.payload).toMatchObject({ apiKeySource: 'apiKeyHelper', apiProvider: 'firstParty' });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !['failed', 'idle'].includes(server.store.getTask(task.id)!.state)) await new Promise((r) => setTimeout(r, 200));
      const row = server.store.getTask(task.id)!;
      expect(row.state).toBe('failed');
      expect(row.error).toMatch(/authentication|rejected|key/i);
      expect(row.cost_usd).toBe(0);
      expect(JSON.stringify(events)).not.toContain(key.slice(20, 60));
      await server.shutdown();
    },
    90_000,
  );

  it('without a Claude plan login: reports signed out and refuses a plan session before sending anything', async () => {
    const { server, events, root } = setup(null);
    const res = (await server.handle('auth.subscriptionStatus', {})) as { status: { signedIn: boolean } };
    expect(res.status.signedIn).toBe(false);
    // A stale "signed in" record must not get past the runtime's own account check.
    server.store.setFlag('subscription', { signedIn: true, email: null, subscriptionType: null, checkedAt: Date.now(), problem: null });
    await server.handle('settings.update', { anthropicAuth: 'subscription', authFallback: false });
    await expect(server.handle('task.start', { root, prompt: 'hello', planFirst: false })).rejects.toMatchObject({ code: 'auth-source' });
    expect(events.some((e) => e.event === 'agent.user')).toBe(false);
    const probe = await server.agents.probeSubscription();
    console.log('runtime account without login:', JSON.stringify(probe.account), 'models:', probe.models.map((m) => m.value).join(','));
    await server.shutdown();
  }, 90_000);
});
