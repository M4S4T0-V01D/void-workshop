import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Server } from '../src/server.js';
import { RESTART_TOOL, compactWindow, type ApprovalRequest } from '../src/agent.js';
import { fakeQueryFn, realisticAccount, write, type FakeScript } from './fakeSdk.js';
import { FAKE_KEY, testPaths, tempRepo, writeKeyFile } from './helpers.js';
import { mergeSettings } from '../src/settings.js';
import { listOllamaModels, ollamaStatus } from '../src/auth.js';

const MODEL = 'claude-test-model';

interface Harness {
  server: Server;
  root: string;
  events: Array<{ event: string; payload: any }>;
  instances: ReturnType<typeof fakeQueryFn>['instances'];
  waitFor: (event: string, pred?: (p: any) => boolean, timeoutMs?: number) => Promise<any>;
  rpc: (method: string, params?: unknown) => Promise<any>;
}

function harness(
  script: FakeScript,
  opts: { key?: boolean; settings?: Record<string, unknown>; claudeBin?: string; env?: Record<string, string> } = {},
): Harness {
  const paths = testPaths();
  if (opts.key !== false) writeKeyFile(paths);
  const events: Harness['events'] = [];
  const listeners: Array<() => void> = [];
  const { fn, instances } = fakeQueryFn(script);
  const server = new Server(
    paths,
    (event, payload) => {
      events.push({ event, payload });
      for (const l of listeners.splice(0)) l();
    },
    {
      queryFn: fn,
      dbFile: ':memory:',
      baseEnv: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANTHROPIC_API_KEY: 'sk-ant-api03-SHOULD-NOT-LEAK',
        ANTHROPIC_BASE_URL: 'https://evil.example',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        ANTHROPIC_AUTH_TOKEN: 'tok',
        CLAUDECODE: '1',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x',
        ...opts.env,
      },
      initTimeoutMs: 2000,
      claudeBin: opts.claudeBin,
    },
  );
  server.store.setFlag('models', { models: [{ id: MODEL, displayName: 'Test' }], checkedAt: Date.now() });
  server.store.updateSettings({ model: MODEL, sandboxCommands: false, checkpointBeforeTasks: false, ...(opts.settings ?? {}) });
  const root = tempRepo();
  server.store.touchProject(root, 'repo');
  const waitFor = (event: string, pred: (p: any) => boolean = () => true, timeoutMs = 5000) =>
    new Promise<any>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const hit = events.find((e) => e.event === event && pred(e.payload) && !(e as { used?: boolean }).used);
        if (hit) {
          (hit as { used?: boolean }).used = true;
          return resolve(hit.payload);
        }
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${event}`));
        listeners.push(check);
        setTimeout(check, 50);
      };
      check();
    });
  return { server, root, events, instances, waitFor, rpc: (m, p) => server.handle(m, p) };
}

const taskState = (h: Harness, id: string) => h.server.store.getTask(id)!.state;
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('authentication and credit gates', () => {
  it('refuses to start without an API key and never launches the runtime', async () => {
    const h = harness({ onUser: async () => {} }, { key: false });
    await expect(h.rpc('task.start', { root: h.root, prompt: 'do it' })).rejects.toMatchObject({ code: 'missing-key' });
    expect(h.instances).toHaveLength(0);
  });

  it('refuses a stored subscription OAuth token', async () => {
    const h = harness({ onUser: async () => {} }, { key: false });
    fs.mkdirSync(path.dirname(h.server.paths.keyFile), { recursive: true });
    fs.writeFileSync(h.server.paths.keyFile, 'sk-ant-oat01-' + 'x'.repeat(60), { mode: 0o600 });
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x' })).rejects.toMatchObject({ code: 'bad-key' });
    expect(h.instances).toHaveLength(0);
  });

  it('stops before sending anything when the runtime is not using the app key helper', async () => {
    const h = harness({ account: { apiKeySource: 'none', tokenSource: 'claude.ai' }, onUser: async (_t, ctx) => ctx.result() });
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x' })).rejects.toMatchObject({ code: 'auth-source' });
    expect(h.instances[0]!.received).toHaveLength(0);
    expect(h.instances[0]!.closed).toBe(true);
  });

  it('stops before sending anything when routed to another provider', async () => {
    const h = harness({ account: { apiKeySource: 'apiKeyHelper', apiProvider: 'bedrock' }, onUser: async (_t, ctx) => ctx.result() });
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x' })).rejects.toMatchObject({ code: 'auth-source' });
    expect(h.instances[0]!.received).toHaveLength(0);
  });

  it('passes a clean environment and API-key-only configuration to the runtime', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const o = h.instances[0]!.options;
    const env = o.env as Record<string, string>;
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE'])
      expect(env[k], k).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(h.server.paths.claudeConfigDir);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.DISABLE_TELEMETRY).toBe('1');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('16000');
    expect((o.settings as { apiKeyHelper: string }).apiKeyHelper).toBe(h.server.paths.keyHelper);
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('default');
    expect(o.maxBudgetUsd).toBe(1);
    expect(o.maxTurns).toBe(50);
    expect(o.model).toBe(MODEL);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'Task', 'Agent']));
    expect(JSON.stringify(o)).not.toContain(FAKE_KEY);
  });

  it('enables the bubblewrap sandbox with project-only writes and no network by default', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() }, { settings: { sandboxCommands: true } });
    await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const sb = h.instances[0]!.options.sandbox!;
    expect(sb).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
    expect(sb.filesystem?.allowWrite).toEqual([h.root]);
    expect(sb.network?.allowedDomains).toEqual([]);
  });

  it('stops all requests and blocks new tasks when credit is exhausted', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        ctx.emit({
          type: 'system',
          subtype: 'api_retry',
          error: 'billing_error',
          error_status: 400,
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 1000,
        } as never);
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await h.waitFor('billing.blocked');
    await until(() => taskState(h, task.id) === 'stopped-billing');
    expect(h.instances[0]!.closed).toBe(true);
    await expect(h.rpc('task.start', { root: h.root, prompt: 'again' })).rejects.toMatchObject({ code: 'billing' });
    await h.rpc('billing.acknowledge');
    await expect(h.rpc('task.start', { root: h.root, prompt: 'again', planFirst: false })).resolves.toBeTruthy();
  });

  it('stops on authentication failure instead of retrying', async () => {
    const h = harness({
      onUser: async (_t, ctx) =>
        ctx.emit({
          type: 'system',
          subtype: 'api_retry',
          error: 'authentication_failed',
          error_status: 401,
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 1000,
        } as never),
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'failed');
    expect(h.server.store.getTask(task.id)!.error).toMatch(/authentication failed/);
  });

  it('reports rate limits and network retries without stopping', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        ctx.emit({ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 1, max_retries: 10, retry_delay_ms: 500 } as never);
        ctx.emit({ type: 'system', subtype: 'api_retry', error: 'unknown', error_status: null, attempt: 2, max_retries: 10, retry_delay_ms: 500 } as never);
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    expect((await h.waitFor('agent.retry')).error).toBe('rate_limit');
    expect((await h.waitFor('agent.retry')).status).toBeNull();
    await until(() => taskState(h, task.id) === 'idle');
  });

  it('marks model errors as failures with a clear message', async () => {
    const h = harness({
      onUser: async (_t, ctx) =>
        ctx.emit({ type: 'assistant', error: 'model_not_found', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } } as never),
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'failed');
    expect(h.server.store.getTask(task.id)!.error).toMatch(/not available/);
  });
});

describe('budgets', () => {
  it('refuses to start when the daily estimated limit is used up', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    h.server.store.addUsage({ taskId: null, model: MODEL, costUsd: 3, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x' })).rejects.toMatchObject({ code: 'budget' });
    expect(h.instances).toHaveLength(0);
  });

  it('caps the SDK budget to the remaining daily allowance', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    h.server.store.addUsage({ taskId: null, model: MODEL, costUsd: 2.6, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
    await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    expect(h.instances[0]!.options.maxBudgetUsd).toBeCloseTo(0.4);
  });

  it('stops when the SDK reports the budget cap or turn limit', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result({ subtype: 'error_max_budget_usd', cost: 1.02 }) });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'stopped-budget');
    expect(h.server.store.getTask(task.id)!.cost_usd).toBeCloseTo(1.02);
    expect(h.server.store.spentOn()).toBeCloseTo(1.02);

    const h2 = harness({ onUser: async (_t, ctx) => ctx.result({ subtype: 'error_max_turns' }) });
    const t2 = await h2.rpc('task.start', { root: h2.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h2, t2.id) === 'stopped-budget');
    expect(h2.server.store.getTask(t2.id)!.error).toMatch(/turn limit/);
  });

  it('records usage per turn without double counting cumulative totals', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result({ cost: 0.1 }) });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'idle');
    await h.rpc('task.send', { taskId: task.id, text: 'more' });
    await until(() => h.server.store.getTask(task.id)!.cost_usd > 0.15);
    await until(() => taskState(h, task.id) === 'idle');
    expect(h.server.store.getTask(task.id)!.cost_usd).toBeCloseTo(0.2);
    expect(h.server.store.spentOn()).toBeCloseTo(0.2);
    expect(h.server.store.getTask(task.id)!.input_tokens).toBe(100);
  });

  it('runs several tasks at once, up to the limit', async () => {
    const h = harness({ onUser: async () => new Promise(() => {}) });
    const a = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const b = await h.rpc('task.start', { root: h.root, prompt: 'y', planFirst: false });
    expect([taskState(h, a.id), taskState(h, b.id)]).toEqual(['executing', 'executing']);
    expect((await h.rpc('task.active', {})).map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id].sort());
    await h.rpc('settings.update', { maxRunningTasks: 2 });
    await expect(h.rpc('task.start', { root: h.root, prompt: 'z', planFirst: false })).rejects.toMatchObject({ code: 'busy' });
  });

  it('reads plan usage with a short-lived runtime that may reach claude.ai, and offers it to the window', async () => {
    const h = harness({
      onUser: async () => undefined,
      usage: {
        subscription_type: 'max',
        rate_limits: { limits: [{ kind: 'session', group: 'session', percent: 12, resets_at: null, severity: 'normal', is_active: true }] },
      },
    });
    expect(await h.rpc('plan.usage', {})).toBeNull();
    h.server.store.setFlag('subscription', { signedIn: true, email: null, subscriptionType: 'max', checkedAt: Date.now(), problem: null });
    const u = await h.rpc('plan.usage', { force: true });
    expect(u.rows).toEqual([expect.objectContaining({ label: '5-hour session', percent: 12 })]);
    expect(h.events.some((e) => e.event === 'plan.usage')).toBe(true);
    expect((await h.rpc('app.init', {})).planUsage.rows[0].percent).toBe(12);
    const env = h.instances.at(-1)!.options.env!;
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    expect(env.DISABLE_TELEMETRY).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps the images the agent looked at, and serves them in pieces', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300 * 1024, 7)]);
    const shot = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('tiny')]);
    const h = harness({
      onUser: async (_t, ctx) => {
        const file = path.join(ctx.options.cwd!, 'screen.png');
        fs.writeFileSync(file, png);
        await ctx.useTool('Read', { file_path: file });
        // A tool result that carries the picture itself (what the runtime sends for a Read of an image).
        ctx.emit({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'img-tool', name: 'mcp__x__shot', input: {} }] },
        } as never);
        ctx.emit({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'img-tool',
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot.toString('base64') } }],
              },
            ],
          },
        } as never);
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'look', planFirst: false });
    await until(() => taskState(h, task.id) === 'idle');
    const images = h.server.store
      .events(task.id)
      .filter((e) => e.kind === 'image')
      .map((e) => e.payload as { imageId: string; name: string; bytes: number });
    expect(images.map((i) => [i.name, i.bytes])).toEqual([
      ['screen.png', png.length],
      ['image', shot.length],
    ]);
    // The file can change afterwards (screenshots reuse names); the kept copy does not.
    fs.writeFileSync(path.join(h.root, 'screen.png'), 'overwritten');
    const first = await h.rpc('task.image', { taskId: task.id, imageId: images[0]!.imageId });
    expect(first).toMatchObject({ mediaType: 'image/png', bytes: png.length, offset: 0, done: false });
    const rest = await h.rpc('task.image', { taskId: task.id, imageId: images[0]!.imageId, offset: Buffer.from(first.data, 'base64').length });
    expect(rest.done).toBe(true);
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(rest.data, 'base64')]).equals(png)).toBe(true);
    // The window reads it in one piece.
    const whole = await h.rpc('task.image', { taskId: task.id, imageId: images[0]!.imageId, length: 4 * 1024 * 1024 });
    expect(whole.done && Buffer.from(whole.data, 'base64').equals(png)).toBe(true);
    await expect(h.rpc('task.image', { taskId: task.id, imageId: images[0]!.imageId, length: 64 * 1024 * 1024 })).rejects.toBeTruthy();
    expect(Buffer.from((await h.rpc('task.image', { taskId: task.id, imageId: images[1]!.imageId })).data, 'base64').equals(shot)).toBe(true);
    await expect(h.rpc('task.image', { taskId: task.id, imageId: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('plan, approvals and file changes', () => {
  it('runs a read-only planning phase, then implements after approval', async () => {
    const h = harness({
      onUser: async (text, ctx, turn) => {
        if (turn === 0) {
          expect(text).toContain('planning phase');
          await ctx.useTool('Read', { file_path: path.join(ctx.options.cwd!, 'src/math.js') });
          await ctx.useTool('TodoWrite', { todos: [{ content: 'Add subtract()', activeForm: 'Adding subtract()', status: 'pending' }] });
          const attempt = await ctx.useTool('Edit', {
            file_path: path.join(ctx.options.cwd!, 'src/math.js'),
            old_string: 'return a + b;',
            new_string: 'return a - b;',
          });
          expect(attempt.outcome).toBe('denied-by-hook');
          const cmd = await ctx.useTool('Bash', { command: 'npm install left-pad' });
          expect(cmd.outcome).toBe('denied-by-hook');
          ctx.text('## Plan\n1. Add subtract()');
          ctx.result({ result: '## Plan\n1. Add subtract()' });
        } else {
          await ctx.useTool('Edit', {
            file_path: path.join(ctx.options.cwd!, 'src/math.js'),
            old_string: '  return a + b;\n}\n',
            new_string: '  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n',
          });
          ctx.result({ result: 'Added subtract()' });
        }
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'Add a subtract function', mode: 'plan' });
    const plan = await h.waitFor('agent.plan');
    expect(plan.text).toContain('Plan');
    expect(plan.items[0].subject).toBe('Add subtract()');
    expect(taskState(h, task.id)).toBe('awaiting-plan-approval');
    expect(fs.readFileSync(path.join(h.root, 'src/math.js'), 'utf8')).not.toContain('subtract');

    await h.rpc('task.approvePlan', { taskId: task.id });
    const approval: ApprovalRequest = await h.waitFor('approval.request');
    expect(approval.kind).toBe('file-change');
    expect(approval.rel).toBe('src/math.js');
    expect(approval.diff).toContain('+export function subtract(a, b) {');
    // nothing written before approval
    expect(fs.readFileSync(path.join(h.root, 'src/math.js'), 'utf8')).not.toContain('subtract');
    await h.rpc('approval.respond', { approvalId: approval.id, decision: 'allow' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(fs.readFileSync(path.join(h.root, 'src/math.js'), 'utf8')).toContain('subtract');

    const review = await h.rpc('review.list', { taskId: task.id });
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ rel: 'src/math.js', status: 'applied', existed: true });
    expect(review[0].diff).toContain('+export function subtract');

    // reject restores the original
    await h.rpc('review.reject', { taskId: task.id, rel: 'src/math.js' });
    expect(fs.readFileSync(path.join(h.root, 'src/math.js'), 'utf8')).not.toContain('subtract');
  });

  it('denies an edit when the file changed on disk while awaiting approval', async () => {
    let result: unknown;
    const h = harness({
      onUser: async (_t, ctx) => {
        result = await ctx.useTool('Edit', { file_path: path.join(ctx.options.cwd!, 'README.md'), old_string: '# demo', new_string: '# Demo' });
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const approval = await h.waitFor('approval.request');
    fs.writeFileSync(path.join(h.root, 'README.md'), '# demo\nedited by the user meanwhile\n');
    await h.rpc('approval.respond', { approvalId: approval.id, decision: 'allow' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(result).toMatchObject({ outcome: 'denied' });
    expect((result as { message: string }).message).toMatch(/changed on disk/);
    expect(fs.readFileSync(path.join(h.root, 'README.md'), 'utf8')).toContain('edited by the user meanwhile');
  });

  it('asks before every command and honours denials', async () => {
    const outcomes: unknown[] = [];
    const h = harness({
      onUser: async (_t, ctx) => {
        outcomes.push(await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests' }));
        outcomes.push(await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests again' }));
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const first: ApprovalRequest = await h.waitFor('approval.request');
    expect(first).toMatchObject({ kind: 'command', command: 'npm test', cwd: h.root, description: 'Run tests' });
    expect(first.assessment?.categories).toEqual(['project-script']);
    await h.rpc('approval.respond', { approvalId: first.id, decision: 'allow' });
    // the identical command is asked about again: no silent re-approval
    const second: ApprovalRequest = await h.waitFor('approval.request', (p) => p.id !== first.id);
    await h.rpc('approval.respond', { approvalId: second.id, decision: 'deny', note: 'not now' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes[0]).toMatchObject({ outcome: 'ran' });
    expect(outcomes[1]).toMatchObject({ outcome: 'denied' });
    expect((outcomes[1] as { message: string }).message).toContain('not now');
  });

  it('blocks dangerous commands and out-of-project paths without asking', async () => {
    const outcomes: Array<{ outcome: string }> = [];
    const h = harness({
      onUser: async (_t, ctx) => {
        outcomes.push(await ctx.useTool('Bash', { command: 'rm -rf ~' }));
        outcomes.push(await ctx.useTool('Bash', { command: 'cat ~/.ssh/id_rsa' }));
        outcomes.push(await ctx.useTool('Bash', { command: 'sleep 10', run_in_background: true }));
        outcomes.push(await ctx.useTool('Bash', { command: 'ls', dangerouslyDisableSandbox: true }));
        outcomes.push(await ctx.useTool('Read', { file_path: '/etc/passwd' }));
        outcomes.push(await ctx.useTool('Read', { file_path: path.join(ctx.options.cwd!, '../../etc/hostname') }));
        outcomes.push(await ctx.useTool('Write', { file_path: '/tmp/void-escape.txt', content: 'x' }));
        outcomes.push(await ctx.useTool('WebFetch', { url: 'https://example.com' }));
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes.map((o) => o.outcome)).toEqual(Array(8).fill('denied-by-hook'));
    expect(h.events.filter((e) => e.event === 'approval.request')).toHaveLength(0);
    expect(fs.existsSync('/tmp/void-escape.txt')).toBe(false);
  });

  it('asks before reading sensitive files inside the project', async () => {
    let outcome: unknown;
    const h = harness({
      onUser: async (_t, ctx) => {
        outcome = await ctx.useTool('Read', { file_path: path.join(ctx.options.cwd!, '.env') });
        ctx.result();
      },
    });
    write(h.root, '.env', 'SECRET=1');
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const approval: ApprovalRequest = await h.waitFor('approval.request');
    expect(approval.kind).toBe('read');
    expect(approval.sensitive).toBeTruthy();
    await h.rpc('approval.respond', { approvalId: approval.id, decision: 'deny' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcome).toMatchObject({ outcome: 'denied' });
  });

  it('cancellation denies pending approvals, stops the runtime and leaves files untouched', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        await ctx.useTool('Write', { file_path: path.join(ctx.options.cwd!, 'new.txt'), content: 'x' });
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await h.waitFor('approval.request');
    await h.rpc('task.cancel', { taskId: task.id });
    expect(taskState(h, task.id)).toBe('cancelled');
    expect(h.instances[0]!.interrupted).toBe(true);
    expect(h.instances[0]!.closed).toBe(true);
    expect(await h.rpc('approval.pending')).toEqual([]);
    expect(fs.existsSync(path.join(h.root, 'new.txt'))).toBe(false);
  });

  it('resumes a finished session with the saved session id', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'idle');
    const sessionId = h.server.store.getTask(task.id)!.session_id;
    expect(sessionId).toBe(h.instances[0]!.sessionId);
    await h.rpc('task.finish', { taskId: task.id });
    expect(taskState(h, task.id)).toBe('completed');
    await h.rpc('task.send', { taskId: task.id, text: 'one more thing' });
    expect(h.instances).toHaveLength(2);
    expect(h.instances[1]!.options.resume).toBe(sessionId);
    await until(() => taskState(h, task.id) === 'idle');
  });

  it('commits only after an explicit request and marks files committed', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        await ctx.useTool('Write', { file_path: path.join(ctx.options.cwd!, 'docs.md'), content: 'hello\n' });
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const approval = await h.waitFor('approval.request');
    await h.rpc('approval.respond', { approvalId: approval.id, decision: 'allow' });
    await until(() => taskState(h, task.id) === 'idle');
    const before = (await h.rpc('git.status', { root: h.root })).head;
    expect((await h.rpc('git.status', { root: h.root })).files.map((f: { path: string }) => f.path)).toContain('docs.md');
    const { sha } = await h.rpc('git.commit', { root: h.root, paths: ['docs.md'], message: 'Add docs', taskId: task.id });
    expect(sha).not.toBe(before);
    const review = await h.rpc('review.list', { taskId: task.id });
    expect(review[0].status).toBe('committed');
  });

  it('review.commit commits only files the task changed', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        await ctx.useTool('Write', { file_path: path.join(ctx.options.cwd!, 'docs.md'), content: 'hello\n' });
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const approval = await h.waitFor('approval.request');
    await h.rpc('approval.respond', { approvalId: approval.id, decision: 'allow' });
    await until(() => taskState(h, task.id) === 'idle');
    fs.writeFileSync(path.join(h.root, 'other.md'), 'not the agent\n');
    await expect(h.rpc('review.commit', { taskId: task.id, paths: ['other.md'], message: 'x' })).rejects.toMatchObject({ code: 'path' });
    await expect(h.rpc('review.commit', { taskId: task.id, paths: ['docs.md'], message: '   ' })).rejects.toThrow();
    const { sha } = await h.rpc('review.commit', { taskId: task.id, paths: ['docs.md'], message: 'Add docs' });
    expect(sha).toBeTruthy();
    expect((await h.rpc('review.list', { taskId: task.id }))[0].status).toBe('committed');
    expect((await h.rpc('git.status', { root: h.root })).files.map((f: { path: string }) => f.path)).toEqual(['other.md']);
  });
});

describe('pictures from the phone', () => {
  // A 1x1 PNG.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('sends uploaded pictures with the first message and with later ones', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    const up = await h.rpc('image.upload', { data: PNG });
    expect(up).toMatchObject({ mediaType: 'image/png' });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'what is this', planFirst: false, imageIds: [up.imageId] });
    await until(() => taskState(h, task.id) === 'idle');
    const first = JSON.parse(h.instances[0]!.received[0]!);
    expect(first[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(first.at(-1).text).toContain('what is this');
    expect(h.server.store.events(task.id).filter((e) => e.kind === 'image').map((e) => (e.payload as { name: string }).name)).toEqual(['Shared picture']);
    // A picture is used once: it moved to the task.
    await expect(h.rpc('task.send', { taskId: task.id, text: 'again', imageIds: [up.imageId] })).rejects.toMatchObject({ code: 'attachments' });
    const up2 = await h.rpc('image.upload', { data: PNG });
    await h.rpc('task.send', { taskId: task.id, text: 'and this', imageIds: [up2.imageId] });
    await until(() => h.instances[0]!.received.length === 2);
    expect(JSON.parse(h.instances[0]!.received[1]!)[0].type).toBe('image');
  });

  it('refuses non-pictures, too many pictures and unknown ids', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    await expect(h.rpc('image.upload', { data: Buffer.from('hello').toString('base64') })).rejects.toMatchObject({ code: 'not-image' });
    await expect(h.rpc('image.upload', { data: Buffer.alloc(600 * 1024, 1).toString('base64') })).rejects.toThrow();
    const ids = await Promise.all([1, 2, 3, 4, 5].map(async () => (await h.rpc('image.upload', { data: PNG })).imageId));
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x', imageIds: ids })).rejects.toThrow();
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x', imageIds: ['nope'] })).rejects.toMatchObject({ code: 'attachments' });
    expect(h.server.store.listTasks(h.root)).toHaveLength(0);
  });
});

describe('rpc validation', () => {
  it('rejects unknown methods and malformed params', async () => {
    const h = harness({ onUser: async () => {} });
    await expect(h.rpc('fs.deleteEverything', {})).rejects.toMatchObject({ code: 'method' });
    await expect(h.rpc('task.get', { taskId: 'not-a-uuid' })).rejects.toThrow();
    await expect(h.rpc('project.open', { root: '/' })).rejects.toThrow();
    await expect(h.rpc('project.readFile', { root: h.root, rel: '../../../etc/passwd' })).rejects.toThrow();
    await expect(h.rpc('settings.update', { model: 'invented-model-id' })).rejects.toMatchObject({ code: 'model' });
  });

  it('runner requires a prepared approval token and refuses blocked commands', async () => {
    const h = harness({ onUser: async () => {} });
    const prep = await h.rpc('runner.prepare', { root: h.root, command: 'git status' });
    expect(prep.cwd).toBe(h.root);
    expect(prep.assessment.categories).toEqual(['read-only']);
    const { runId } = await h.rpc('runner.run', { approvalToken: prep.approvalToken });
    const fin = await h.waitFor('runner.finished', (p) => p.runId === runId);
    expect(fin.status).toBe('succeeded');
    await expect(h.rpc('runner.run', { approvalToken: prep.approvalToken })).rejects.toMatchObject({ code: 'expired' });
    const bad = await h.rpc('runner.prepare', { root: h.root, argv: ['sudo', 'id'] });
    expect(bad.assessment.blocked).toBe(true);
    await expect(h.rpc('runner.run', { approvalToken: bad.approvalToken })).rejects.toMatchObject({ code: 'blocked' });
    await expect(h.rpc('runner.prepare', { root: h.root, command: 'ls | sh' })).rejects.toMatchObject({ code: 'parse' });
  });
});

describe('agent modes', () => {
  const edit = (ctx: { options: { cwd?: string } }) => ({
    file_path: path.join(ctx.options.cwd!, 'src/math.js'),
    old_string: 'return a + b;',
    new_string: 'return b + a;',
  });
  const math = (h: Harness) => fs.readFileSync(path.join(h.root, 'src/math.js'), 'utf8');

  it('auto-edit applies file changes without asking but still asks before commands', async () => {
    const outcomes: unknown[] = [];
    const h = harness({
      onUser: async (_t, ctx) => {
        outcomes.push(await ctx.useTool('Edit', edit(ctx)));
        outcomes.push(await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests' }));
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto-edit' });
    const ask: ApprovalRequest = await h.waitFor('approval.request');
    expect(ask.kind).toBe('command');
    expect(math(h)).toContain('return b + a;');
    await h.rpc('approval.respond', { approvalId: ask.id, decision: 'allow' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes).toMatchObject([{ outcome: 'ran' }, { outcome: 'ran' }]);
    expect(h.events.some((e) => e.event === 'agent.autoApproved' && e.payload.kind === 'file-change')).toBe(true);
    // the change is still reviewable and can be rejected
    const review = await h.rpc('review.list', { taskId: task.id });
    expect(review[0]).toMatchObject({ rel: 'src/math.js', status: 'tested' });
  });

  it('auto runs edits and sandboxed commands unasked, but keeps blocks and sensitive-file prompts', async () => {
    const outcomes: unknown[] = [];
    const h = harness(
      {
        onUser: async (_t, ctx) => {
          outcomes.push(await ctx.useTool('Edit', edit(ctx)));
          outcomes.push(await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'git push origin main' }));
          outcomes.push(await ctx.useTool('Write', { file_path: path.join(ctx.options.cwd!, '.env'), content: 'X=1' }));
          ctx.result();
        },
      },
      { settings: { sandboxCommands: true } },
    );
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    const ask: ApprovalRequest = await h.waitFor('approval.request');
    expect(ask).toMatchObject({ kind: 'file-change', rel: '.env' });
    await h.rpc('approval.respond', { approvalId: ask.id, decision: 'deny' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes).toMatchObject([{ outcome: 'ran' }, { outcome: 'ran' }, { outcome: 'denied-by-hook' }, { outcome: 'denied' }]);
    expect(h.events.filter((e) => e.event === 'approval.request')).toHaveLength(1);
  });

  it('with publishing allowed, auto still asks before gh / git push and runs them outside the sandbox', async () => {
    const outcomes: unknown[] = [];
    const h = harness(
      {
        onUser: async (_t, ctx) => {
          outcomes.push(await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'git push origin main', description: 'Push' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'git push --force' }));
          ctx.result();
        },
      },
      { settings: { sandboxCommands: true, allowPublishCommands: true, gradleBuilds: true } },
    );
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    const ask: ApprovalRequest = await h.waitFor('approval.request');
    expect(ask).toMatchObject({ kind: 'command', command: 'git push origin main', sandboxed: false });
    expect(ask.assessment?.categories).toContain('publishes');
    await h.rpc('approval.respond', { approvalId: ask.id, decision: 'allow' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes).toMatchObject([{ outcome: 'ran' }, { outcome: 'ran' }, { outcome: 'denied-by-hook' }]);
    expect(h.events.filter((e) => e.event === 'approval.request')).toHaveLength(1);
    const o = h.instances[0]!.options;
    expect(o.sandbox?.excludedCommands).toContain('git push *');
    expect(o.sandbox?.filesystem?.allowWrite).toContain(path.join(os.homedir(), '.gradle'));
    expect(o.sandbox?.network?.allowedDomains).toContain('dl.google.com');
    expect((o.systemPrompt as { append: string }).append).toContain('Push and publish (gh, git push');
  });

  it('"Always allow" remembers the exact command for the project; other commands still ask', async () => {
    const outcomes: unknown[] = [];
    const h = harness({
      onUser: async (_t, ctx) => {
        outcomes.push(await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests' }));
        outcomes.push(await ctx.useTool('Bash', { command: 'npm test' }));
        outcomes.push(await ctx.useTool('Bash', { command: 'npm test -- --watch' }));
        outcomes.push(await ctx.useTool('Bash', { command: 'git push origin main' }));
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'ask' });
    const first: ApprovalRequest = await h.waitFor('approval.request');
    expect(first).toMatchObject({ command: 'npm test', canAlwaysAllow: true });
    await h.rpc('approval.respond', { approvalId: first.id, decision: 'allow', always: true });
    await until(() => h.events.filter((e) => e.event === 'approval.request').length === 2);
    const second = h.events.filter((e) => e.event === 'approval.request')[1]!.payload as ApprovalRequest;
    expect(second.command).toBe('npm test -- --watch');
    await h.rpc('approval.respond', { approvalId: second.id, decision: 'deny' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes).toMatchObject([{ outcome: 'ran' }, { outcome: 'ran' }, { outcome: 'denied' }, { outcome: 'denied-by-hook' }]);
    expect(await h.rpc('project.allowedCommands', { root: h.root })).toEqual(['npm test']);
    // Saving other project access keeps the list; removing works.
    await h.rpc('project.setPermissions', { root: h.root, permissions: { extraPaths: [], networkDomains: [] } });
    expect(await h.rpc('project.allowedCommands', { root: h.root })).toEqual(['npm test']);
    expect(await h.rpc('project.forgetCommand', { root: h.root, command: 'npm test' })).toEqual([]);
  });

  it('auto still asks before commands when the sandbox is off', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests' });
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    const ask: ApprovalRequest = await h.waitFor('approval.request');
    expect(ask.kind).toBe('command');
    await h.rpc('approval.respond', { approvalId: ask.id, decision: 'allow' });
    await until(() => taskState(h, task.id) === 'idle');
  });

  it('with full access, auto runs ordinary work anywhere and asks only for risky commands and outside edits', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-outside-'));
    fs.writeFileSync(path.join(outside, 'notes.txt'), 'hello');
    const outcomes: unknown[] = [];
    const h = harness(
      {
        onUser: async (_t, ctx) => {
          outcomes.push(await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests' }));
          outcomes.push(await ctx.useTool('Read', { file_path: path.join(outside, 'notes.txt') }));
          outcomes.push(await ctx.useTool('WebSearch', { query: 'media3 foreground service timeout' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'git reset --hard', description: 'Reset' }));
          outcomes.push(await ctx.useTool('Write', { file_path: path.join(outside, 'new.txt'), content: 'x' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'cat ~/.ssh/id_ed25519' }));
          ctx.result();
        },
      },
      { settings: { sandboxCommands: true, fullAccess: true } },
    );
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    const risky: ApprovalRequest = await h.waitFor('approval.request');
    expect(risky).toMatchObject({ kind: 'command', command: 'git reset --hard', sandboxed: false });
    expect(risky.assessment?.askReasons).toContain('git reset --hard discards work');
    await h.rpc('approval.respond', { approvalId: risky.id, decision: 'allow' });
    await until(() => h.events.filter((e) => e.event === 'approval.request').length === 2);
    const edit = h.events.filter((e) => e.event === 'approval.request')[1]!.payload as ApprovalRequest;
    expect(edit.kind).toBe('file-change');
    await h.rpc('approval.respond', { approvalId: edit.id, decision: 'deny' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes).toMatchObject([
      { outcome: 'ran' },
      { outcome: 'ran' },
      { outcome: 'ran' },
      { outcome: 'ran' },
      { outcome: 'denied' },
      { outcome: 'denied-by-hook' },
    ]);
    const o = h.instances[0]!.options;
    expect(o.sandbox).toBeUndefined();
    expect(o.tools).toContain('WebFetch');
    expect((o.systemPrompt as { append: string }).append).toContain('other folders are fine');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('with full access, auto also runs background jobs, git config and (by default) pushes; force-push still asks', async () => {
    const outcomes: unknown[] = [];
    const h = harness(
      {
        onUser: async (_t, ctx) => {
          outcomes.push(await ctx.useTool('Bash', { command: 'npm run dev', run_in_background: true, description: 'Dev server' }));
          outcomes.push(await ctx.useTool('TaskStop', { task_id: 'b1' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'git config user.email me@example.com' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'git push' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'git push --force origin main' }));
          ctx.result();
        },
      },
      { settings: { fullAccess: true, maxTurns: 200 } },
    );
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    const force: ApprovalRequest = await h.waitFor('approval.request');
    expect(force.command).toBe('git push --force origin main');
    await h.rpc('approval.respond', { approvalId: force.id, decision: 'deny' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes).toMatchObject([{ outcome: 'ran' }, { outcome: 'ran' }, { outcome: 'ran' }, { outcome: 'ran' }, { outcome: 'denied' }]);
    // Each start gets the whole turn allowance, however many turns the task has used before.
    expect(h.instances[0]!.options.maxTurns).toBe(200);
  });

  it('with full access and auto publishing off, pushes ask; without full access, background jobs stay refused', async () => {
    const outcomes: unknown[] = [];
    const h = harness(
      {
        onUser: async (_t, ctx) => {
          outcomes.push(await ctx.useTool('Bash', { command: 'git push' }));
          ctx.result();
        },
      },
      { settings: { fullAccess: true, autoPublish: false } },
    );
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    const push: ApprovalRequest = await h.waitFor('approval.request');
    expect(push).toMatchObject({ command: 'git push', coveredByAuto: false });
    await h.rpc('approval.respond', { approvalId: push.id, decision: 'allow' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes).toMatchObject([{ outcome: 'ran' }]);

    const plain: unknown[] = [];
    const h2 = harness({
      onUser: async (_t, ctx) => {
        plain.push(await ctx.useTool('Bash', { command: 'npm run dev', run_in_background: true }));
        ctx.result();
      },
    });
    const t2 = await h2.rpc('task.start', { root: h2.root, prompt: 'x', mode: 'auto' });
    await until(() => taskState(h2, t2.id) === 'idle');
    expect(plain).toMatchObject([{ outcome: 'denied-by-hook' }]);
  });

  it('"Allow all" allows the request and switches the task to auto; risky commands still ask, blocks stay', async () => {
    const outcomes: unknown[] = [];
    const h = harness(
      {
        onUser: async (_t, ctx) => {
          outcomes.push(await ctx.useTool('Bash', { command: 'npm test', description: 'Run tests' }));
          outcomes.push(await ctx.useTool('Edit', edit(ctx)));
          outcomes.push(await ctx.useTool('Bash', { command: 'npm run build', description: 'Build' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'git reset --hard', description: 'Reset' }));
          outcomes.push(await ctx.useTool('Bash', { command: 'cat ~/.ssh/id_ed25519' }));
          ctx.result();
        },
      },
      { settings: { fullAccess: true } },
    );
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'ask' });
    const first: ApprovalRequest = await h.waitFor('approval.request');
    expect(first).toMatchObject({ command: 'npm test', canAllowAll: true, coveredByAuto: true });
    await h.rpc('approval.respond', { approvalId: first.id, decision: 'allow', allowAll: true });
    await until(() => h.events.filter((e) => e.event === 'approval.request').length === 2);
    const risky = h.events.filter((e) => e.event === 'approval.request')[1]!.payload as ApprovalRequest;
    expect(risky).toMatchObject({ command: 'git reset --hard', coveredByAuto: false });
    await h.rpc('approval.respond', { approvalId: risky.id, decision: 'deny' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(outcomes).toMatchObject([{ outcome: 'ran' }, { outcome: 'ran' }, { outcome: 'ran' }, { outcome: 'denied' }, { outcome: 'denied-by-hook' }]);
    expect(math(h)).toContain('return b + a;');
    expect(h.events.find((e) => e.event === 'agent.mode')?.payload).toMatchObject({ taskId: task.id, mode: 'auto' });
    expect(
      String(
        (h.events.find((e) => e.event === 'agent.notice' && String((e.payload as { text?: string }).text).startsWith('Allow all'))?.payload as { text: string })
          .text,
      ),
    ).toContain('Auto');
  });

  it('approving a plan can switch straight into auto-edit', async () => {
    const received: string[] = [];
    const h = harness({
      onUser: async (text, ctx, turn) => {
        received.push(text);
        if (turn === 0) return ctx.result({ result: '## Plan' });
        await ctx.useTool('Edit', edit(ctx));
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'plan' });
    await until(() => taskState(h, task.id) === 'awaiting-plan-approval');
    await h.rpc('task.approvePlan', { taskId: task.id, mode: 'auto-edit' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(received[1]).toMatch(/plan is approved.*applied without asking/);
    expect(math(h)).toContain('return b + a;');
    expect(h.events.some((e) => e.event === 'approval.request')).toBe(false);
  });

  it('a reply in another mode while a plan waits approves it with that reply', async () => {
    const received: string[] = [];
    const h = harness({
      onUser: async (text, ctx) => {
        received.push(text);
        ctx.result({ result: '## Plan' });
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'plan' });
    await until(() => taskState(h, task.id) === 'awaiting-plan-approval');
    await h.rpc('task.send', { taskId: task.id, text: 'use tabs', mode: 'plan' });
    await until(() => received.length === 2 && taskState(h, task.id) === 'awaiting-plan-approval');
    expect(received[1]).toContain('planning phase');
    await h.rpc('task.send', { taskId: task.id, text: 'go ahead, keep it short', mode: 'ask' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(received[2]).toMatch(/plan is approved[\s\S]*keep it short/);
  });

  it('switching to plan mode mid-session blocks edits', async () => {
    let outcome: unknown;
    const h = harness({
      onUser: async (_t, ctx, turn) => {
        if (turn === 1) outcome = await ctx.useTool('Edit', edit(ctx));
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    await until(() => taskState(h, task.id) === 'idle');
    await h.rpc('task.setMode', { taskId: task.id, mode: 'plan' });
    await h.rpc('task.send', { taskId: task.id, text: 'now plan the next step' });
    await until(() => taskState(h, task.id) === 'awaiting-plan-approval');
    expect(outcome).toMatchObject({ outcome: 'denied-by-hook' });
    expect(math(h)).not.toContain('return b + a;');
  });

  it('switches the model of a live session and rejects unknown models', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    h.server.store.setFlag('models', { models: [{ id: MODEL }, { id: 'claude-other' }], checkedAt: Date.now() });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'ask' });
    await until(() => taskState(h, task.id) === 'idle');
    await h.rpc('task.setModel', { taskId: task.id, model: 'claude-other' });
    expect(h.instances[0]!.models).toEqual(['claude-other']);
    expect(h.server.store.getTask(task.id)!.model).toBe('claude-other');
    await expect(h.rpc('task.setModel', { taskId: task.id, model: 'nope' })).rejects.toMatchObject({ code: 'model' });
  });

  it('implements an approved plan with the implementation model, before the go-ahead is sent', async () => {
    const seen: Array<{ text: string; models: string[] }> = [];
    const h = harness(
      {
        onUser: async (text, ctx) => {
          seen.push({ text, models: [...h.instances[0]!.models] });
          ctx.result({ result: '## Plan' });
        },
      },
      { settings: { implementModel: 'claude-cheap' } },
    );
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'plan' });
    await until(() => taskState(h, task.id) === 'awaiting-plan-approval');
    expect(h.instances[0]!.models).toEqual([]);
    await h.rpc('task.approvePlan', { taskId: task.id, mode: 'auto-edit' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(seen[1]).toMatchObject({ text: expect.stringMatching(/plan is approved/), models: ['claude-cheap'] });
    expect(h.server.store.getTask(task.id)!.model).toBe('claude-cheap');
  });

  it('migrates the old plan-first setting to a mode', () => {
    expect(mergeSettings({ planFirst: true }).agentMode).toBe('plan');
    expect(mergeSettings({ planFirst: false }).agentMode).toBe('ask');
    expect(mergeSettings({}).agentMode).toBe('ask');
    expect(mergeSettings({ planFirst: true, agentMode: 'auto' }).agentMode).toBe('auto');
  });
});

describe('ollama provider', () => {
  const LOCAL = 'qwen3-coder:30b';
  const ollama = (script: FakeScript, key = false) => {
    const h = harness(script, { key, settings: { provider: 'ollama', model: LOCAL } });
    h.server.store.setFlag('models:ollama', { models: [{ id: LOCAL, displayName: LOCAL }], checkedAt: Date.now() });
    return h;
  };
  const localAccount = { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' };

  it('routes to the local server with a placeholder key and never configures the key helper', async () => {
    const h = ollama({ account: localAccount, onUser: async (_t, ctx) => ctx.result({ cost: 3 }) }, true);
    h.server.store.updateSettings({ effort: 'high' });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const o = h.instances[0]!.options;
    const env = o.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(env.ANTHROPIC_API_KEY).toBe('ollama');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(LOCAL);
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(LOCAL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(o)).not.toContain(FAKE_KEY);
    expect((o.settings as { apiKeyHelper?: string }).apiKeyHelper).toBeUndefined();
    expect(o.maxBudgetUsd).toBeUndefined();
    expect(o.effort).toBeUndefined();
    expect(o.model).toBe(LOCAL);
    await until(() => taskState(h, task.id) === 'idle');
    // The runtime's Claude price table does not apply to local models.
    expect(h.server.store.getTask(task.id)!.cost_usd).toBe(0);
  });

  it('works without a Console key and ignores spend limits', async () => {
    const h = ollama({ account: localAccount, onUser: async (_t, ctx) => ctx.result() });
    h.server.store.addUsage({ taskId: null, model: 'x', costUsd: 100, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'idle');
  });

  it('stops before sending anything if the runtime loaded the Console key helper', async () => {
    const h = ollama({ account: { apiKeySource: 'apiKeyHelper', apiProvider: 'firstParty' }, onUser: async (_t, ctx) => ctx.result() }, true);
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x' })).rejects.toMatchObject({ code: 'auth-source' });
    expect(h.instances[0]!.received).toHaveLength(0);
  });

  it('refuses a model that is not installed in Ollama', async () => {
    const h = ollama({ account: localAccount, onUser: async (_t, ctx) => ctx.result() });
    h.server.store.updateSettings({ model: MODEL });
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x' })).rejects.toMatchObject({ code: 'model' });
    expect(h.instances).toHaveLength(0);
  });

  it('accepts only loopback Ollama addresses and drops a model the new provider lacks', async () => {
    const h = harness({ onUser: async () => {} });
    for (const url of ['http://192.168.1.5:11434', 'https://127.0.0.1:11434', 'http://127.0.0.1.evil.com', 'http://localhost:11434/v1'])
      await expect(h.rpc('settings.update', { ollamaUrl: url }), url).rejects.toBeTruthy();
    expect((await h.rpc('settings.update', { ollamaUrl: 'http://localhost:11500/' })).ollamaUrl).toBe('http://localhost:11500');
    const s = await h.rpc('settings.update', { provider: 'ollama' });
    expect(s.provider).toBe('ollama');
    expect(s.model).toBeNull();
    await expect(h.rpc('settings.update', { model: MODEL })).rejects.toMatchObject({ code: 'model' });
  });
});

describe('listOllamaModels', () => {
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('lists installed models from /api/tags', async () => {
    let asked = '';
    const fetchFn = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ models: [{ name: 'gpt-oss:20b', model: 'gpt-oss:20b', details: { parameter_size: '20.9B' } }] }));
    }) as unknown as typeof fetch;
    const res = await listOllamaModels('http://127.0.0.1:11434/', fetchFn);
    expect(asked).toBe('http://127.0.0.1:11434/api/tags');
    expect(res).toMatchObject({ ok: true, models: [{ id: 'gpt-oss:20b', displayName: 'gpt-oss:20b (20.9B)' }] });
  });

  it('reports an empty install, an unreachable server and remote URLs', async () => {
    expect(await listOllamaModels('http://127.0.0.1:11434', ok({ models: [] }))).toMatchObject({ ok: false, kind: 'api-error' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await listOllamaModels('http://127.0.0.1:11434', down)).toMatchObject({ ok: false, kind: 'network' });
    expect(await listOllamaModels('http://example.com:11434', ok({ models: [] }))).toMatchObject({ ok: false, kind: 'bad-format' });
  });
});

describe('ollamaStatus', () => {
  it('sums loaded model memory from /api/ps and reports system RAM', async () => {
    let asked = '';
    const fetchFn = (async (url: string) => {
      asked = url;
      return new Response(
        JSON.stringify({
          models: [
            { name: 'qwen3-coder:30b', size: 20e9, size_vram: 8e9, context_length: 32768 },
            { name: 'gpt-oss:20b', size: 14e9, size_vram: 0 },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const s = await ollamaStatus('http://127.0.0.1:11434', fetchFn);
    expect(asked).toBe('http://127.0.0.1:11434/api/ps');
    expect(s).toMatchObject({ reachable: true, totalBytes: 34e9, vramBytes: 8e9 });
    expect(s.models[0]).toMatchObject({ name: 'qwen3-coder:30b', contextLength: 32768 });
    expect(s.models[1]).toMatchObject({ vramBytes: 0, contextLength: null });
    expect(s.system.totalBytes).toBeGreaterThan(0);
  });

  it('reports unreachable for a down server or a remote URL without contacting it', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await ollamaStatus('http://127.0.0.1:11434', down)).toMatchObject({ reachable: false, models: [] });
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(await ollamaStatus('http://example.com:11434', spy)).toMatchObject({ reachable: false });
    expect(called).toBe(false);
  });
});

describe('claude plan sign-in and switching', () => {
  const SIGNED_IN = { signedIn: true, email: 'me@example.com', subscriptionType: 'max', checkedAt: 1, problem: null };
  const plan = (script: Omit<FakeScript, 'account'>, opts: { key?: boolean; settings?: Record<string, unknown> } = {}) => {
    const h = harness({ ...script, account: realisticAccount }, { ...opts, settings: { anthropicAuth: 'subscription', ...(opts.settings ?? {}) } });
    h.server.store.setFlag('subscription', SIGNED_IN);
    return h;
  };
  const planLimit = (ctx: Parameters<FakeScript['onUser']>[1]) =>
    ctx.emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    } as never);

  it('runs on the Claude plan without loading the key helper or spending against the budgets', async () => {
    const h = plan({ onUser: async (_t, ctx) => ctx.result({ cost: 5 }) });
    h.server.store.addUsage({ taskId: null, model: 'x', costUsd: 100, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const o = h.instances[0]!.options;
    expect((o.settings as { apiKeyHelper?: string }).apiKeyHelper).toBeUndefined();
    expect(o.maxBudgetUsd).toBeUndefined();
    const env = o.env as Record<string, string>;
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']) expect(env[k], k).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(h.server.paths.claudeConfigDir);
    expect(JSON.stringify(o)).not.toContain(FAKE_KEY);
    await until(() => taskState(h, task.id) === 'idle');
    const row = h.server.store.getTask(task.id)!;
    expect(row.cost_usd).toBe(0);
    expect(row.cost_basis).toBe('subscription');
    expect(row.output_tokens).toBe(50);
  });

  it('stops before sending anything if the runtime is not on the plan login', async () => {
    const h = harness(
      { account: { apiKeySource: 'apiKeyHelper', apiProvider: 'firstParty' }, onUser: async (_t, ctx) => ctx.result() },
      { settings: { anthropicAuth: 'subscription' } },
    );
    h.server.store.setFlag('subscription', SIGNED_IN);
    await expect(h.rpc('task.start', { root: h.root, prompt: 'x' })).rejects.toMatchObject({ code: 'auth-source' });
    expect(h.instances[0]!.received).toHaveLength(0);
    const noPlan = harness(
      { account: { apiKeySource: 'none', apiProvider: 'firstParty' }, onUser: async (_t, ctx) => ctx.result() },
      { settings: { anthropicAuth: 'subscription' } },
    );
    noPlan.server.store.setFlag('subscription', SIGNED_IN);
    await expect(noPlan.rpc('task.start', { root: noPlan.root, prompt: 'x' })).rejects.toMatchObject({ code: 'auth-source' });
  });

  it('uses the API key when not signed in, or refuses when fallback is off', async () => {
    const h = harness({ account: realisticAccount, onUser: async (_t, ctx) => ctx.result() }, { settings: { anthropicAuth: 'subscription' } });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    expect(await h.waitFor('auth.switched')).toMatchObject({ from: 'subscription', to: 'api-key' });
    expect((h.instances[0]!.options.settings as { apiKeyHelper?: string }).apiKeyHelper).toBe(h.server.paths.keyHelper);
    await until(() => taskState(h, task.id) === 'idle');
    await h.rpc('settings.update', { authFallback: false });
    await expect(h.rpc('task.start', { root: h.root, prompt: 'y' })).rejects.toMatchObject({ code: 'not-signed-in' });
  });

  it('continues the same session with the API key when the plan limit is hit, and goes back once it resets', async () => {
    let limited = false;
    const h = plan({
      onUser: async (_t, ctx) => {
        if (!limited && !(ctx.options.settings as { apiKeyHelper?: string }).apiKeyHelper) {
          limited = true;
          return planLimit(ctx);
        }
        ctx.result({ cost: 0.05 });
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'build it', planFirst: false });
    expect(await h.waitFor('plan.limited')).toMatchObject({ message: expect.stringMatching(/5-hour usage limit/) });
    await until(() => h.instances.length === 2 && taskState(h, task.id) === 'idle');
    const second = h.instances[1]!;
    expect(second.options.resume).toBe(h.instances[0]!.sessionId);
    expect((second.options.settings as { apiKeyHelper?: string }).apiKeyHelper).toBe(h.server.paths.keyHelper);
    expect(second.options.maxBudgetUsd).toBe(1);
    expect(second.received[0]).toMatch(/continue the task/i);
    expect(h.server.store.getTask(task.id)!.cost_usd).toBeCloseTo(0.05);
    // While limited, new tasks go straight to the API key; after the reset, back to the plan.
    const t2 = await h.rpc('task.start', { root: h.root, prompt: 'another', planFirst: false });
    expect((h.instances[2]!.options.settings as { apiKeyHelper?: string }).apiKeyHelper).toBeDefined();
    await until(() => taskState(h, t2.id) === 'idle');
    h.server.store.setFlag('planLimited', { until: Date.now() - 1, message: 'old' });
    await h.rpc('task.start', { root: h.root, prompt: 'third', planFirst: false });
    expect((h.instances[3]!.options.settings as { apiKeyHelper?: string }).apiKeyHelper).toBeUndefined();
  });

  it('stops with a plan-limit state when fallback is off', async () => {
    const h = plan({ onUser: async (_t, ctx) => planLimit(ctx) }, { settings: { authFallback: false } });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'stopped-limit');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.instances).toHaveLength(1);
    await expect(h.rpc('task.start', { root: h.root, prompt: 'y' })).rejects.toMatchObject({ code: 'plan-limit' });
  });

  it('continues with the Claude plan when the API key runs out of credit', async () => {
    const h = plan(
      {
        onUser: async (_t, ctx) => {
          if ((ctx.options.settings as { apiKeyHelper?: string }).apiKeyHelper)
            return ctx.emit({ type: 'assistant', error: 'billing_error', message: { role: 'assistant', content: [] } } as never);
          ctx.result();
        },
      },
      { settings: { anthropicAuth: 'api-key' } },
    );
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await h.waitFor('billing.blocked');
    await until(() => h.instances.length === 2 && taskState(h, task.id) === 'idle');
    expect((h.instances[1]!.options.settings as { apiKeyHelper?: string }).apiKeyHelper).toBeUndefined();
    expect(h.instances[1]!.options.resume).toBe(h.instances[0]!.sessionId);
  });

  it('moves a live conversation to the other account when the switch changes between messages', async () => {
    const h = plan({ onUser: async (_t, ctx) => ctx.result() }, { settings: { anthropicAuth: 'api-key' } });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'idle');
    await h.rpc('task.send', { taskId: task.id, text: 'same account' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(h.instances).toHaveLength(1);
    await h.rpc('settings.update', { anthropicAuth: 'subscription' });
    await h.rpc('task.send', { taskId: task.id, text: 'now on the plan' });
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.closed).toBe(true);
    expect(h.instances[1]!.options.resume).toBe(h.instances[0]!.sessionId);
    expect((h.instances[1]!.options.settings as { apiKeyHelper?: string }).apiKeyHelper).toBeUndefined();
    expect(h.instances[1]!.received[0]).toBe('now on the plan');
    await until(() => taskState(h, task.id) === 'idle');
  });

  it('signs in through the bundled runtime, hands the link to the window and lists the plan models', async () => {
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vw-claude-')), 'claude');
    fs.writeFileSync(
      bin,
      `#!/bin/sh
for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL; do
  eval "x=\\\${$v:-}"; [ -n "$x" ] && { echo "leaked $v" >&2; exit 3; }
done
case "$1 $2" in
  "auth status")
    if [ -f "$CLAUDE_CONFIG_DIR/.fake-login" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","email":"me@example.com","subscriptionType":"max"}';
    else echo '{"loggedIn":false,"authMethod":"none"}'; exit 1; fi ;;
  "auth login")
    # Like the real runtime: the fallback (code page) link is printed before the browser link is opened.
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc"
    printf 'Paste code here if prompted > '
    if [ -f "$CLAUDE_CONFIG_DIR/.use-code" ]; then
      read -r code
      [ "$code" = "goodcode123#state4567" ] || { echo "Login failed: Request failed with status code 400"; exit 1; }
    else
      sleep 0.2
      xdg-open 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback&state=abc' || exit 4
      sleep 0.3
    fi
    touch "$CLAUDE_CONFIG_DIR/.fake-login" ;;
  "auth logout") rm -f "$CLAUDE_CONFIG_DIR/.fake-login" ;;
esac
`,
      { mode: 0o755 },
    );
    const h = harness(
      {
        account: realisticAccount,
        models: [
          { value: 'default', resolvedModel: 'claude-plan-big', displayName: 'Default', description: '' },
          { value: 'big', resolvedModel: 'claude-plan-big', displayName: 'Big', description: '' },
          { value: 'claude-plan-small', displayName: 'Small', description: '' },
        ],
        onUser: async (_t, ctx) => ctx.result(),
      },
      { claudeBin: bin },
    );
    expect((await h.rpc('auth.subscriptionStatus')).status.signedIn).toBe(false);
    const res = await h.rpc('auth.subscriptionLogin');
    // The browser gets the link that finishes by itself, not the code-page fallback printed first.
    const urls = await h.waitFor('auth.loginUrl');
    expect(urls.url).toContain('redirect_uri=http%3A%2F%2Flocalhost');
    expect(urls.manualUrl).toContain('oauth%2Fcode%2Fcallback');
    expect(res.status).toMatchObject({ signedIn: true, email: 'me@example.com', subscriptionType: 'max' });
    // The plan's models join the API key's list; aliases resolve to model ids.
    expect(res.models.map((m: { id: string }) => m.id)).toEqual([MODEL, 'claude-plan-big', 'claude-plan-small']);
    // The sign-in check and the plan usage check that follows it: neither sends a message, both close.
    await h.waitFor('plan.usage');
    await until(() => h.instances.every((p) => p.closed));
    expect(h.instances.length).toBeGreaterThanOrEqual(2);
    for (const probe of h.instances) expect(probe.received).toHaveLength(0);
    await h.rpc('settings.update', { anthropicAuth: 'subscription', model: 'claude-plan-small' });
    const init = await h.rpc('app.init');
    expect(init.subscription.signedIn).toBe(true);
    const out = await h.rpc('auth.subscriptionLogout');
    expect(out.status.signedIn).toBe(false);
    expect(h.server.store.getFlag('models:subscription')).toBeNull();

    // When Claude's page shows a code instead ("Paste this into Claude Code"), the pasted code finishes it.
    fs.writeFileSync(path.join(h.server.paths.claudeConfigDir, '.use-code'), '');
    await expect(h.rpc('auth.subscriptionLoginCode', { code: 'goodcode123#state4567' })).rejects.toThrow(/No sign-in is waiting/);
    const login = h.rpc('auth.subscriptionLogin');
    const fallback = await h.waitFor('auth.loginUrl', () => true, 8000);
    expect(fallback.url).toContain('oauth%2Fcode%2Fcallback');
    await expect(h.rpc('auth.subscriptionLoginCode', { code: 'not a code' })).rejects.toThrow(/does not look like/);
    await h.rpc('auth.subscriptionLoginCode', { code: '  goodcode123#state4567 ' });
    expect((await login).status.signedIn).toBe(true);
  }, 20_000);
});

describe('speed and token efficiency', () => {
  it('uses the lean tool set, the context cap and the TodoWrite plan list', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        await ctx.useTool('TodoWrite', {
          todos: [
            { content: 'Read code', activeForm: 'Reading code', status: 'completed' },
            { content: 'Fix bug', activeForm: 'Fixing bug', status: 'in_progress' },
          ],
        });
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const o = h.instances[0]!.options;
    expect(o.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite']);
    const env = o.env as Record<string, string>;
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('0');
    expect(env.CLAUDE_CODE_TODO_REMINDER_MODE).toBe('off');
    // The token saver (on by default) compacts earlier and keeps less command output.
    expect(o.settings).toMatchObject({ autoCompactWindow: 120_000 });
    expect(env.BASH_MAX_OUTPUT_LENGTH).toBe('12000');
    expect((o.systemPrompt as { append: string }).append).toMatch(/scale them to at most 1280 px/);
    expect((o.settings as Record<string, unknown>).promptCacheTtl).toBeUndefined();
    expect((o.settings as Record<string, unknown>).fastMode).toBeUndefined();
    const todos = await h.waitFor('agent.todos');
    expect(todos.items.map((i: { subject: string; status: string }) => `${i.subject}:${i.status}`)).toEqual(['Read code:completed', 'Fix bug:in_progress']);
    expect(await h.waitFor('agent.context')).toEqual({ taskId: task.id, tokens: 12_000, max: 120_000 });
    await until(() => taskState(h, task.id) === 'idle');
    expect((await h.rpc('task.get', { taskId: task.id })).context).toEqual({ tokens: 12_000, max: 120_000 });
  });

  it('without the token saver keeps the configured cap, full command output and the plain prompt', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() }, { settings: { tokenSaver: false } });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const o = h.instances[0]!.options;
    expect(o.settings).toMatchObject({ autoCompactWindow: 200_000 });
    expect((o.env as Record<string, string>).BASH_MAX_OUTPUT_LENGTH).toBe('30000');
    expect((o.systemPrompt as { append: string }).append).not.toMatch(/1280 px/);
    await until(() => taskState(h, task.id) === 'idle');
  });

  it('the token saver never raises a lower cap, and caps the full window', () => {
    expect(compactWindow({ tokenSaver: true, contextCapTokens: 100_000 })).toBe(100_000);
    expect(compactWindow({ tokenSaver: true, contextCapTokens: null })).toBe(120_000);
    expect(compactWindow({ tokenSaver: false, contextCapTokens: null })).toBeNull();
  });

  it('passes cache lifetime and fast mode, and applies effort and fast mode to a live session', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() }, { settings: { promptCacheTtl: '1h', fastMode: true, contextCapTokens: null, tokenSaver: false } });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    const o = h.instances[0]!.options;
    expect(o.settings).toMatchObject({ promptCacheTtl: '1h', fastMode: true });
    expect((o.settings as Record<string, unknown>).autoCompactWindow).toBeUndefined();
    await until(() => taskState(h, task.id) === 'idle');
    await h.rpc('settings.update', { effort: 'low', fastMode: false });
    expect(h.instances[0]!.flagSettings.at(-1)).toEqual({ effortLevel: 'low', fastMode: false });
    expect(h.instances).toHaveLength(1);
  });

  it('batches streamed text into fewer events', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        for (const piece of 'Hello there, this streams token by token.'.split(' '))
          ctx.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece + ' ' } } } as never);
        ctx.text('Hello there, this streams token by token.');
        ctx.result();
      },
    });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', planFirst: false });
    await until(() => taskState(h, task.id) === 'idle');
    const deltas = h.events.filter((e) => e.event === 'agent.delta');
    expect(deltas.length).toBeLessThan(3);
    expect(deltas.map((d) => d.payload.text).join('')).toBe('Hello there, this streams token by token. ');
    // Text deltas always arrive before the final text block.
    const order = h.events.map((e) => e.event).filter((e) => e === 'agent.delta' || e === 'agent.text');
    expect(order.at(-1)).toBe('agent.text');
  });

  it('compacts on request without the planning wrapper', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'plan' });
    await until(() => taskState(h, task.id) === 'awaiting-plan-approval');
    await expect(h.rpc('task.compact', { taskId: task.id })).rejects.toMatchObject({ code: 'busy' });
    await h.rpc('task.approvePlan', { taskId: task.id });
    await until(() => taskState(h, task.id) === 'idle');
    await h.rpc('task.compact', { taskId: task.id });
    await until(() => taskState(h, task.id) === 'idle' && h.instances[0]!.received.length === 3);
    expect(h.instances[0]!.received[2]).toBe('/compact');
    // A closed session is resumed to compact it.
    await h.rpc('task.finish', { taskId: task.id });
    await h.rpc('task.compact', { taskId: task.id });
    await until(() => h.instances.length === 2 && taskState(h, task.id) === 'idle');
    expect(h.instances[1]!.received[0]).toBe('/compact');
  });
});

describe('message queue', () => {
  /** A script whose first turn waits until released (or interrupted). */
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const texts: string[] = [];
    const script: FakeScript = {
      onUser: async (text, ctx) => {
        texts.push(text);
        if (texts.length === 1) {
          const how = await Promise.race([gate.then(() => 'done'), ctx.interrupted.then(() => 'interrupted')]);
          if (how === 'interrupted') return;
        }
        ctx.result();
      },
    };
    return { script, release: () => release(), texts };
  };

  it('queues messages sent while the agent works and sends them together when the turn ends', async () => {
    const g = gated();
    const h = harness(g.script);
    const task = await h.rpc('task.start', { root: h.root, prompt: 'first', planFirst: false });
    await h.rpc('task.send', { taskId: task.id, text: 'also add tests' });
    await h.rpc('task.send', { taskId: task.id, text: 'and update the README' });
    const q = (await h.rpc('task.get', { taskId: task.id })).queue;
    expect(q.map((i: { text: string }) => i.text)).toEqual(['also add tests', 'and update the README']);
    await h.rpc('task.queue.edit', { taskId: task.id, id: q[1].id, text: 'and update the docs' });
    g.release();
    await until(() => g.texts.length === 2 && taskState(h, task.id) === 'idle');
    expect(g.texts[1]).toBe('also add tests\n\nand update the docs');
    expect(h.server.agents.queue(task.id)).toEqual([]);
    expect(h.instances).toHaveLength(1);
  });

  it('sends one queued message per turn when "send together" is off, and can remove messages', async () => {
    const g = gated();
    const h = harness(g.script, { settings: { sendQueuedTogether: false } });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'first', planFirst: false });
    for (const t of ['one', 'two', 'three']) await h.rpc('task.send', { taskId: task.id, text: t });
    const q = h.server.agents.queue(task.id);
    await h.rpc('task.queue.remove', { taskId: task.id, id: q[1]!.id });
    g.release();
    await until(() => g.texts.length === 3 && taskState(h, task.id) === 'idle');
    expect(g.texts.slice(1)).toEqual(['one', 'three']);
  });

  it('"send now" interrupts the running turn and sends that message next', async () => {
    const g = gated();
    const h = harness(g.script);
    const task = await h.rpc('task.start', { root: h.root, prompt: 'long job', planFirst: false });
    await h.rpc('task.send', { taskId: task.id, text: 'stop, do this instead' });
    const [item] = h.server.agents.queue(task.id);
    await h.rpc('task.queue.sendNow', { taskId: task.id, id: item!.id });
    await until(() => g.texts.length === 2 && taskState(h, task.id) === 'idle');
    expect(h.instances[0]!.interrupted).toBe(true);
    expect(g.texts[1]).toBe('stop, do this instead');
    expect(h.server.store.getTask(task.id)!.error).toBeNull();
  });

  it('keeps the queue after the user stops the task, and sends it on request', async () => {
    const g = gated();
    const h = harness(g.script);
    const task = await h.rpc('task.start', { root: h.root, prompt: 'first', planFirst: false });
    await h.rpc('task.send', { taskId: task.id, text: 'later' });
    await h.rpc('task.cancel', { taskId: task.id });
    expect(taskState(h, task.id)).toBe('cancelled');
    expect(h.server.agents.queue(task.id)).toHaveLength(1);
    await h.rpc('task.queue.flush', { taskId: task.id });
    await until(() => h.instances.length === 2 && taskState(h, task.id) === 'idle');
    expect(h.instances[1]!.received[0]).toBe('later');
    expect(h.server.agents.queue(task.id)).toEqual([]);
  });
});

describe('admin dev session', () => {
  const PASSWORD = 'hunter22';
  const appendOf = (o: { systemPrompt?: unknown }) => String((o.systemPrompt as { append?: string }).append ?? '');

  it('gives tasks Workshop powers only while it runs, and the next message picks up the change', async () => {
    const outcomes: Record<string, string> = {};
    const h = harness({
      onUser: async (text, ctx) => {
        if (text.startsWith('probe')) {
          outcomes[`${text}:grep`] = (await ctx.useTool('Bash', { command: 'grep -rn CLAUDE_CODE_ENABLE_TASKS sidecar/src', description: 'x' })).outcome;
          outcomes[`${text}:cred`] = (await ctx.useTool('Bash', { command: 'cat ~/.config/void-workshop/credentials/admin.json' })).outcome;
          outcomes[`${text}:restart`] = (await ctx.useTool(RESTART_TOOL, { install: false, reason: 'x' })).outcome;
        }
        ctx.result();
      },
    });
    await h.rpc('admin.setPassword', { password: PASSWORD });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'probe-normal', mode: 'auto' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(h.instances[0]!.options.mcpServers).toEqual({});
    expect(appendOf(h.instances[0]!.options)).not.toContain('Admin dev session');
    expect(outcomes).toMatchObject({ 'probe-normal:grep': 'denied-by-hook', 'probe-normal:cred': 'denied-by-hook', 'probe-normal:restart': 'denied-by-hook' });

    await expect(h.rpc('admin.start', { password: 'wrong' })).rejects.toMatchObject({ code: 'admin-password' });
    const status = await h.rpc('admin.start', { password: PASSWORD });
    expect(status).toMatchObject({ active: true, by: 'desktop' });
    expect(h.events.find((e) => e.event === 'admin.changed')?.payload).toMatchObject({ active: true });
    // The idle normal session was closed; the next message resumes it with admin powers.
    expect(h.instances[0]!.closed).toBe(true);
    await h.rpc('task.send', { taskId: task.id, text: 'probe-admin' });
    await until(() => h.instances.length === 2 && taskState(h, task.id) === 'idle');
    // Closed only to change its powers, it resumed in the mode it had (Auto), not the default Ask.
    expect(h.server.agents.modeOf(task.id)).toBe('auto');
    const o = h.instances[1]!.options;
    expect(o.resume).toBe(h.instances[0]!.sessionId);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['workshop']);
    expect(appendOf(o)).toContain('Admin dev session');
    expect(o.tools).toContain('WebSearch');
    const src = h.server.admin.status().sourceDir;
    expect(src).toBeTruthy();
    expect(o.additionalDirectories).toContain(src);
    expect(outcomes).toMatchObject({ 'probe-admin:grep': 'ran', 'probe-admin:cred': 'denied-by-hook', 'probe-admin:restart': 'ran' });

    await h.rpc('admin.end');
    expect(h.instances[1]!.closed).toBe(true);
    await h.rpc('task.send', { taskId: task.id, text: 'probe-after' });
    await until(() => h.instances.length === 3 && taskState(h, task.id) === 'idle');
    expect(h.instances[2]!.options.mcpServers).toEqual({});
    expect(outcomes).toMatchObject({ 'probe-after:grep': 'denied-by-hook', 'probe-after:restart': 'denied-by-hook' });
  });

  it('ending it stops admin tasks that are still working', async () => {
    const h = harness({
      onUser: async (_t, ctx) => {
        await ctx.useTool('Bash', { command: 'git reset --hard', description: 'risky, so it asks' });
        ctx.result();
      },
    });
    await h.rpc('admin.setPassword', { password: PASSWORD });
    await h.rpc('admin.start', { password: PASSWORD });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    await h.waitFor('approval.request');
    await h.rpc('admin.end');
    expect(taskState(h, task.id)).toBe('cancelled');
    expect(h.server.store.getTask(task.id)!.error).toContain('admin session ended');
    expect(await h.rpc('approval.pending')).toEqual([]);
  });

  it('restarts once the turn has ended, then continues the task that asked', async () => {
    const received: string[] = [];
    const h = harness(
      {
        onUser: async (text, ctx) => {
          received.push(text);
          ctx.result();
        },
      },
      { env: { VOID_WORKSHOP_SHELL_RESTART: '1' } },
    );
    await h.rpc('admin.setPassword', { password: PASSWORD });
    await h.rpc('admin.start', { password: PASSWORD });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'change workshop', mode: 'auto' });
    await until(() => taskState(h, task.id) === 'idle');
    const text = h.server.agents.requestRestart(h.server.agents.get(task.id), false, 'new composer');
    expect(text).toContain('Restart scheduled');
    expect(h.events.find((e) => e.event === 'admin.restartPending')?.payload).toMatchObject({ taskId: task.id, reason: 'new composer' });
    const restart = await h.waitFor('app.restart', () => true, 5000);
    expect(restart).toMatchObject({ install: false });
    expect(path.isAbsolute(restart.statusFile)).toBe(true);
    expect(h.events.some((e) => e.event === 'admin.restarting')).toBe(true);
    // What the next start does (here without actually restarting): continue the task that asked.
    await (h.server as unknown as { resumeAfterRestart(): Promise<void> }).resumeAfterRestart();
    await until(() => received.length === 2);
    expect(received[1]).toMatch(/^\[VOID Workshop restarted\./);
    // Only once.
    expect(h.server.admin.takeResume()).toBeNull();
  });

  it('refuses to restart when the shell cannot, or outside an admin session', async () => {
    const h = harness({ onUser: async (_t, ctx) => ctx.result() });
    await h.rpc('admin.setPassword', { password: PASSWORD });
    await h.rpc('admin.start', { password: PASSWORD });
    const task = await h.rpc('task.start', { root: h.root, prompt: 'x', mode: 'auto' });
    await until(() => taskState(h, task.id) === 'idle');
    expect(() => h.server.agents.requestRestart(h.server.agents.get(task.id), false, 'x')).toThrow(/cannot restart itself/);
  });
});
