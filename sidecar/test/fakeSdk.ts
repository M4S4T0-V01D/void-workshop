import fs from 'node:fs';
import path from 'node:path';
import type { ModelInfo, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../src/agent.js';
import { applyEdit } from '../src/files.js';

/**
 * Scripted stand-in for the Agent SDK `query()`. It runs the *real* hooks and canUseTool
 * callbacks VOID Workshop passes in, so policy, approvals and budget handling are exercised
 * exactly as with the SDK; only the model and API are simulated.
 */

export interface FakeCtx {
  options: Options;
  emit(msg: Partial<SDKMessage> & { type: string }): void;
  /** Simulate the model calling a tool. Returns what happened. */
  useTool(name: string, input: Record<string, unknown>): Promise<{ outcome: 'denied-by-hook' | 'denied' | 'ran'; message?: string }>;
  text(t: string): void;
  result(r?: { cost?: number; subtype?: string; isError?: boolean; result?: string; turns?: number }): void;
  /** Resolves when VOID Workshop interrupts the running turn. */
  interrupted: Promise<void>;
}

export interface FakeScript {
  /** Account the runtime reports; a function sees the options it was started with. */
  account?: Record<string, unknown> | ((options: Options) => Record<string, unknown>);
  models?: ModelInfo[];
  onUser: (text: string, ctx: FakeCtx, turn: number) => Promise<void>;
  /** What get_usage answers (plan usage meters). */
  usage?: Record<string, unknown>;
}

/** What the real runtime reports for each way VOID Workshop configures it. */
export function realisticAccount(options: Options): Record<string, unknown> {
  if ((options.settings as { apiKeyHelper?: string } | undefined)?.apiKeyHelper) return { apiKeySource: 'apiKeyHelper', apiProvider: 'firstParty' };
  if ((options.env as Record<string, string> | undefined)?.ANTHROPIC_API_KEY) return { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' };
  return { apiKeySource: 'none', tokenSource: 'claude.ai', subscriptionType: 'max', email: 'me@example.com', apiProvider: 'firstParty' };
}

export class FakeQuery {
  readonly received: string[] = [];
  closed = false;
  interrupted = false;
  readonly flagSettings: Array<Record<string, unknown>> = [];
  private onInterrupt: () => void = () => {};
  private interruptPromise = new Promise<void>((r) => (this.onInterrupt = r));
  private queue: SDKMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKMessage>) => void> = [];
  private cost = 0;
  private toolSeq = 0;
  readonly sessionId = 'sess-' + Math.random().toString(36).slice(2, 10);

  constructor(
    readonly prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
    readonly script: FakeScript,
  ) {
    void this.drive();
  }

  private push(m: SDKMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.queue.push(m);
  }

  private get account(): Record<string, unknown> {
    const a = this.script.account;
    return typeof a === 'function' ? a(this.options) : (a ?? { apiKeySource: 'apiKeyHelper', tokenSource: 'apiKeyHelper', apiProvider: 'firstParty' });
  }

  private async drive(): Promise<void> {
    let turn = 0;
    for await (const msg of this.prompt) {
      if (this.closed) break;
      const text = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
      this.received.push(text);
      if (turn === 0)
        this.emit({
          type: 'system',
          subtype: 'init',
          apiKeySource: (this.account.apiKeySource as string) ?? 'none',
          session_id: this.sessionId,
          model: String(this.options.model),
          tools: this.options.tools,
        });
      await this.script.onUser(text, this.ctx(), turn++);
    }
  }

  private emit(m: Record<string, unknown>): void {
    this.push({ uuid: 'u', session_id: this.sessionId, parent_tool_use_id: null, ...m } as unknown as SDKMessage);
  }

  private ctx(): FakeCtx {
    return {
      options: this.options,
      interrupted: this.interruptPromise,
      emit: (m) => this.emit(m as Record<string, unknown>),
      text: (t) => this.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } }),
      result: (r = {}) => {
        this.cost += r.cost ?? 0.01;
        this.emit({
          type: 'result',
          subtype: r.subtype ?? 'success',
          is_error: r.isError ?? false,
          result: r.result ?? 'done',
          errors: r.subtype && r.subtype !== 'success' ? ['stopped'] : undefined,
          num_turns: r.turns ?? 1,
          duration_ms: 10,
          total_cost_usd: this.cost,
          modelUsage: {
            [String(this.options.model)]: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadInputTokens: 10,
              cacheCreationInputTokens: 5,
              webSearchRequests: 0,
              costUSD: this.cost,
              contextWindow: 1000,
              maxOutputTokens: 100,
              costBasis: 'list',
            },
          },
        });
      },
      useTool: async (name, input) => {
        const id = `toolu_${++this.toolSeq}`;
        this.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
        const signal = new AbortController().signal;
        let decision: string | undefined;
        let reason = '';
        for (const m of this.options.hooks?.PreToolUse ?? []) {
          for (const h of m.hooks) {
            const out = (await h(
              {
                hook_event_name: 'PreToolUse',
                tool_name: name,
                tool_input: input,
                tool_use_id: id,
                cwd: this.options.cwd,
                session_id: this.sessionId,
                transcript_path: '',
              } as never,
              id,
              { signal },
            )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
            decision = out.hookSpecificOutput?.permissionDecision ?? decision;
            reason = out.hookSpecificOutput?.permissionDecisionReason ?? reason;
          }
        }
        const finish = (isError: boolean, content: string) =>
          this.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
        if (decision === 'deny') {
          finish(true, reason);
          return { outcome: 'denied-by-hook', message: reason };
        }
        if (decision === 'ask' || !['Read', 'Glob', 'Grep', 'TodoWrite'].includes(name)) {
          const res = await this.options.canUseTool!(name, input, { signal, toolUseID: id, requestId: id } as never);
          if (!res || res.behavior === 'deny') {
            finish(true, res?.behavior === 'deny' ? res.message : 'denied');
            return { outcome: 'denied', message: res?.behavior === 'deny' ? res.message : undefined };
          }
        }
        let response: unknown = 'ok';
        let ok = true;
        try {
          if (name === 'Write') fs.writeFileSync(String(input.file_path), String(input.content));
          else if (name === 'Edit') {
            const f = String(input.file_path);
            fs.writeFileSync(
              f,
              applyEdit(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', String(input.old_string), String(input.new_string), input.replace_all === true),
            );
          } else if (name === 'Bash') response = { stdout: `ran: ${String(input.command)}`, stderr: '' };
        } catch (err) {
          ok = false;
          response = (err as Error).message;
        }
        const post = ok ? this.options.hooks?.PostToolUse : this.options.hooks?.PostToolUseFailure;
        for (const m of post ?? [])
          for (const h of m.hooks)
            await h(
              {
                hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure',
                tool_name: name,
                tool_input: input,
                tool_use_id: id,
                tool_response: response,
                error: ok ? undefined : String(response),
              } as never,
              id,
              { signal },
            );
        finish(!ok, typeof response === 'string' ? response : JSON.stringify(response));
        return { outcome: 'ran' };
      },
    };
  }

  // ---- Query surface used by VOID Workshop -------------------------------------------------
  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
    return this.script.usage ?? { subscription_type: null, rate_limits_available: false, rate_limits: null };
  }

  async initializationResult() {
    return {
      account: this.account,
      models: this.script.models ?? [],
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: [],
    };
  }

  readonly models: string[] = [];
  async setModel(model?: string) {
    if (model) this.models.push(model);
  }

  async interrupt() {
    this.interrupted = true;
    this.onInterrupt();
    this.interruptPromise = new Promise<void>((r) => (this.onInterrupt = r));
    // The runtime ends an interrupted turn with an error result.
    this.ctx().result({ subtype: 'error_during_execution', cost: 0 });
    return undefined;
  }

  async applyFlagSettings(settings: Record<string, unknown>) {
    this.flagSettings.push(settings);
  }

  contextTokens = 12_000;
  async getContextUsage() {
    return { totalTokens: this.contextTokens, maxTokens: 1_000_000, percentage: 1, categories: [] };
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export function fakeQueryFn(script: FakeScript): { fn: QueryFn; instances: FakeQuery[] } {
  const instances: FakeQuery[] = [];
  const fn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const q = new FakeQuery(params.prompt, params.options, script);
    instances.push(q);
    return q;
  }) as unknown as QueryFn;
  return { fn, instances };
}

export function write(root: string, rel: string, content: string): string {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}
