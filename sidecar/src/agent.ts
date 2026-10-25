import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSdkMcpServer,
  query as sdkQuery,
  tool as sdkTool,
  type AccountInfo,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AppPaths } from './config.js';
import { APP_VERSION } from './config.js';
import type { Store, TaskRow, TaskState } from './db.js';
import { ACTIVE_STATES } from './db.js';
import { PathPolicy, homeSecretPaths, isWithin } from './paths.js';
import { assessCommand, PUBLISH_SANDBOX_EXCLUSIONS, type CommandAssessment } from './commandPolicy.js';
import { applyEdit, EditApplyError, fileHash, PreimageStore, unifiedDiff } from './files.js';
import { checkBudget, CostTracker } from './budget.js';
import { ImageStore, imageMediaType, UPLOADS, type SavedImage } from './images.js';
import type { KeyStore } from './keystore.js';
import { validateApiKeyFormat } from './keystore.js';
import { clip, redactText, redactValue } from './redact.js';
import { log } from './log.js';
import {
  COMMAND_OUTPUT_CHARS,
  MAX_ALWAYS_ALLOW,
  OLLAMA_URL_RE,
  TOKEN_SAVER_CONTEXT,
  normalizeOllamaUrl,
  otherAuth,
  type AgentMode,
  type AnthropicAuth,
  type Settings,
} from './settings.js';
import { modelsFlagKey, type ModelEntry } from './auth.js';
import { PLAN_LIMIT_FLAG, SUBSCRIPTION_FLAG, type SubscriptionStatus } from './subscription.js';
import { CONTINUE_AFTER_SWITCH, PLANNING_SUFFIX, RESTART_TOOL, adminPrompt, planApproved, workshopPrompt, type AdminContext, type RestartRequest } from './prompts.js';

export { RESTART_TOOL, adminPrompt, workshopPrompt, type AdminContext, type RestartRequest };

export type QueryFn = typeof sdkQuery;

/**
 * Built-in tools the agent gets. Constant across phases so the prompt cache prefix stays stable.
 * TodoWrite instead of the TaskCreate/TaskUpdate/TaskList/TaskGet family: one ~1k-token tool definition
 * instead of ~4k, sent with every request.
 */
export const AGENT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite'];
/** Added to AGENT_TOOLS with full access. */
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const BOOKKEEPING_TOOLS = new Set(['TodoWrite']);
const DISALLOWED_TOOLS = [
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'NotebookEdit',
  'Skill',
  'Workflow',
  'CronCreate',
  'CronDelete',
  'ScheduleWakeup',
  'RemoteTrigger',
  'SendMessage',
  'EnterWorktree',
  'ExitWorktree',
  'Monitor',
  'ToolSearch',
];

/** Permission deny rules applied by the runtime itself (also best-effort for Grep/Glob). */
const SENSITIVE_DENY_RULES = [
  'Read(**/.env)',
  'Read(**/.env.local)',
  'Read(**/.env.production)',
  'Read(**/.env.development)',
  'Read(**/*.pem)',
  'Read(**/*.key)',
  'Read(**/id_rsa*)',
  'Read(**/id_ed25519*)',
  'Read(**/.npmrc)',
  'Read(**/.netrc)',
  'Read(**/.git-credentials)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.config/**)',
  'Read(~/.local/share/**)',
  'Edit(~/.config/**)',
  'Edit(~/.local/share/**)',
  'Edit(~/.ssh/**)',
  'Edit(**/.git/**)',
];

/** Full access reads ~/.config and ~/.local/share, so the runtime denies only the protected locations there. */
function fullAccessDenyRules(admin = false): string[] {
  const broad = /^(Read|Edit)\(~\/\.(config|local\/share)\/\*\*\)$/;
  // An absolute path in a permission rule starts with "//".
  const secrets = homeSecretPaths(undefined, admin).flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`, `Edit(/${p})`, `Edit(/${p}/**)`]);
  return [...SENSITIVE_DENY_RULES.filter((r) => !broad.test(r)), ...secrets];
}

/** Where Gradle, the Android Gradle plugin and Maven keep their caches (writable for sandboxed builds with `gradleBuilds`). */
export const GRADLE_CACHE_DIRS = ['.gradle', '.android', '.m2', '.kotlin'];
/** Repositories a Gradle/Android build downloads the wrapper, plugins and dependencies from. */
export const GRADLE_DOMAINS = [
  'services.gradle.org',
  'downloads.gradle.org',
  'plugins.gradle.org',
  'plugins-artifacts.gradle.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'dl.google.com',
  'maven.google.com',
];


/** What a session authenticates with: one of the two Anthropic methods, or the local Ollama server. */
export type AuthKind = AnthropicAuth | 'ollama';

export const AUTH_LABEL: Record<AuthKind, string> = { 'api-key': 'your API key', subscription: 'your Claude plan', ollama: 'Ollama' };

/** Plan limits without a reset time block the subscription for this long before it is tried again. */
const PLAN_LIMIT_DEFAULT_MS = 15 * 60_000;

/** Streamed text is sent to the window in batches at most this often. */
const DELTA_FLUSH_MS = 40;

/** How full the conversation's context is (tokens now / tokens before it compacts). */
export interface ContextInfo {
  tokens: number;
  max: number;
}

/** A message typed while the agent was working; it goes out when the turn ends. */
export interface QueuedMessage {
  id: string;
  text: string;
  mode: AgentMode | null;
  createdAt: number;
}

const MAX_QUEUE = 20;
export const MAX_ATTACHMENTS = 4;

/** Where the conversation compacts: the cap, lowered further by the token saver. null = the model's own window. */
export function compactWindow(settings: Pick<Settings, 'contextCapTokens' | 'tokenSaver'>): number | null {
  if (!settings.tokenSaver) return settings.contextCapTokens;
  return Math.min(settings.contextCapTokens ?? TOKEN_SAVER_CONTEXT, TOKEN_SAVER_CONTEXT);
}

/** Runtime settings that trade speed against tokens (flag-settings layer of the session). */
export function runtimeTuning(settings: Settings, local: boolean): Record<string, unknown> {
  if (local) return {};
  return {
    ...(compactWindow(settings) ? { autoCompactWindow: compactWindow(settings) } : {}),
    ...(settings.promptCacheTtl !== 'auto' ? { promptCacheTtl: settings.promptCacheTtl } : {}),
    ...(settings.fastMode ? { fastMode: true } : {}),
  };
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  kind: 'file-change' | 'command' | 'read';
  toolName: string;
  createdAt: number;
  summary: string;
  rel?: string;
  diff?: string;
  isNew?: boolean;
  sensitive?: string | null;
  command?: string;
  cwd?: string;
  description?: string;
  assessment?: CommandAssessment;
  sandboxed?: boolean;
  /** Commands: the user may choose "Always allow" for this exact command. */
  canAlwaysAllow?: boolean;
  /** The user may choose "Allow all": allow this and switch the task to Auto (not offered while planning). */
  canAllowAll?: boolean;
  /** Auto mode would have allowed this without asking, so "Allow all" on another request allows it too. */
  coveredByAuto?: boolean;
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny';
  /** Commands only: also allow this exact command from now on in this project. */
  always?: boolean;
  /** Allow this, switch the task to Auto, and allow the task's other waiting requests that Auto covers. */
  allowAll?: boolean;
  note?: string;
}

export interface PlanItem {
  ref: string;
  id: string | null;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
}

export interface AgentDeps {
  store: Store;
  paths: AppPaths;
  keys: KeyStore;
  emit: (event: string, payload: unknown) => void;
  queryFn?: QueryFn;
  /** Environment the runtime is built from (tests pass a fake one). */
  baseEnv?: NodeJS.ProcessEnv;
  initTimeoutMs?: number;
  /** The admin dev session, while one is active. */
  admin?: () => AdminContext | null;
  /** Install (optionally) and restart the app; the sidecar exits soon after. */
  restart?: (r: RestartRequest) => void;
}

export interface StartTaskInput {
  projectRoot: string;
  prompt: string;
  model?: string;
  mode?: AgentMode;
  /** Uploaded pictures (image.upload) that go with the first message. */
  imageIds?: string[];
  /** Older callers: true = plan mode, false = ask mode. */
  planFirst?: boolean;
}

/** Push-based async iterable feeding user messages into a streaming-input query. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  /** Text, optionally with pictures (base64) placed before it, as the API expects. */
  push(text: string, images: Array<{ mediaType: string; data: string }> = []): void {
    if (this.closed) throw new Error('Session input is closed');
    const content = images.length
      ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text }]
      : text;
    const msg = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export class AgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Placeholder credential for Ollama, which ignores it. Never a real key. */
export const OLLAMA_PLACEHOLDER_KEY = 'ollama';

/**
 * Build the runtime environment from scratch: no inherited Anthropic/Claude variables, no proxies.
 * With `ollama`, requests go to the local Ollama server with a placeholder key; every model alias
 * (including background/subagent models) points at the chosen local model.
 */
export function buildRuntimeEnv(base: NodeJS.ProcessEnv, paths: AppPaths, settings: Settings, ollama?: { url: string; model: string }): Record<string, string> {
  const env: Record<string, string> = {};
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'GOPATH',
    'JAVA_HOME',
    'NVM_DIR',
    'VOID_WORKSHOP_KEY_BACKEND',
  ];
  for (const k of keep) {
    const v = base[k];
    if (v) env[k] = v;
  }
  Object.assign(env, {
    SHELL: '/bin/bash',
    TERM: 'dumb',
    NO_COLOR: '1',
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    VOID_WORKSHOP_KEY_FILE: paths.keyFile,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    DO_NOT_TRACK: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    // TodoWrite planning (see AGENT_TOOLS), without the periodic "update your todo list" reminders.
    CLAUDE_CODE_ENABLE_TASKS: '0',
    CLAUDE_CODE_TODO_REMINDER_MODE: 'off',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(settings.maxOutputTokens),
    BASH_DEFAULT_TIMEOUT_MS: String(settings.commandTimeoutSec * 1000),
    // With full access the agent may give a long build up to an hour (it passes its own timeout per command).
    BASH_MAX_TIMEOUT_MS: String((settings.fullAccess ? Math.max(settings.commandTimeoutSec, 3600) : settings.commandTimeoutSec) * 1000),
    BASH_MAX_OUTPUT_LENGTH: String(settings.tokenSaver ? COMMAND_OUTPUT_CHARS.saver : COMMAND_OUTPUT_CHARS.normal),
    CLAUDE_AGENT_SDK_CLIENT_APP: `void-workshop/${APP_VERSION}`,
  });
  if (ollama) {
    if (!OLLAMA_URL_RE.test(ollama.url)) throw new AgentError('provider', 'Ollama must run on this machine (http://127.0.0.1:PORT).');
    Object.assign(env, {
      ANTHROPIC_BASE_URL: normalizeOllamaUrl(ollama.url),
      ANTHROPIC_API_KEY: OLLAMA_PLACEHOLDER_KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: ollama.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: ollama.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ollama.model,
      CLAUDE_CODE_SUBAGENT_MODEL: ollama.model,
    });
  }
  return env;
}

function titleFrom(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line || 'Untitled task';
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

function preDecision(decision: 'deny' | 'ask', reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } } as HookJSONOutput;
}

/**
 * One task = one Agent SDK session. The session stays alive between turns (follow-ups, plan approval)
 * and can be resumed after an app restart via the stored session id.
 */
export class TaskSession {
  state: TaskState;
  private q: Query | null = null;
  private readonly input = new MessageQueue();
  private readonly abort = new AbortController();
  private readonly policy: PathPolicy;
  private cost: CostTracker;
  private plan: PlanItem[] = [];
  private readonly hookCwd = new Map<string, string>();
  private readonly pendingFileWrites = new Map<string, { real: string }>();
  private readonly commandStarts = new Map<string, { runId: string; started: number; command: string }>();
  /** Read calls on image files, by tool use id: the picture is kept when the result comes back. */
  private readonly imageReads = new Map<string, string>();
  private lastAssistantText = '';
  /** Streamed text not yet sent to the window; flushed every DELTA_FLUSH_MS or before any other event. */
  private pendingDelta = '';
  private deltaTimer: NodeJS.Timeout | null = null;
  /** Set while a turn is interrupted so a queued message can go next; the interrupted turn then ends as idle. */
  private yieldingToQueue = false;
  /** Set by cancel(): the interrupted turn's result must not turn the task into "failed". */
  private cancelling = false;
  context: ContextInfo | null = null;
  private lastTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private closed = false;
  /** Set when this session started inside an admin dev session (its powers are fixed for the session's life). */
  readonly admin: AdminContext | null;

  constructor(
    readonly task: TaskRow,
    private readonly mgr: AgentManager,
    private readonly settings: Settings,
    private mode: AgentMode,
    readonly auth: AuthKind,
  ) {
    const perms = mgr.deps.store.getProjectPermissions(task.project);
    this.admin = mgr.adminContext();
    const extra = [...perms.extraPaths];
    // An admin session can change Workshop's own source wherever the task's project is.
    const src = this.admin?.sourceDir;
    if (src && !isWithin(src, task.project) && !extra.some((x) => isWithin(src, x))) extra.push(src);
    this.policy = new PathPolicy(task.project, extra, undefined, settings.fullAccess, !!this.admin);
    this.state = task.state;
    this.cost = new CostTracker(task.cost_usd);
  }

  get id(): string {
    return this.task.id;
  }

  get currentMode(): AgentMode {
    return this.mode;
  }

  get active(): boolean {
    return ACTIVE_STATES.includes(this.state);
  }

  /** The agent is working (not waiting for the user). */
  get running(): boolean {
    return this.state === 'planning' || this.state === 'executing';
  }

  /** True when this session talks to the local Ollama server instead of the Anthropic API. */
  private get isLocal(): boolean {
    return this.auth === 'ollama';
  }

  /** Only API-key sessions cost money; the USD budgets gate those alone. */
  private get billed(): boolean {
    return this.auth === 'api-key';
  }

  /** Whether the runtime's key source is the one this session must use. A Claude plan login has no API key at all. */
  private keySourceOk(source: string | undefined): boolean {
    if (this.auth === 'subscription') return !source || source === 'none' || source === 'oauth';
    return source === (this.isLocal ? 'ANTHROPIC_API_KEY' : 'apiKeyHelper');
  }

  /** Whether the runtime authenticates the way this session must (checked before anything is sent). */
  private authSourceOk(a: { apiKeySource?: string; apiProvider?: string; tokenSource?: string; subscriptionType?: string }): boolean {
    if (a.apiProvider && a.apiProvider !== 'firstParty') return false;
    if (!this.keySourceOk(a.apiKeySource)) return false;
    return this.auth !== 'subscription' || !!(a.subscriptionType || (a.tokenSource && a.tokenSource !== 'none'));
  }

  private get store(): Store {
    return this.mgr.deps.store;
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    this.mgr.deps.emit(event, redactValue({ taskId: this.id, ...payload }));
  }

  private setState(state: TaskState, extra: Partial<TaskRow> = {}): void {
    this.state = state;
    const row = this.store.updateTask(this.id, { state, ...extra });
    this.mgr.deps.emit('task.updated', redactValue(row));
  }

  /** Start (or resume) the SDK session and send the first message once authentication is verified. */
  async start(firstMessage: string, resumeSessionId: string | null): Promise<void> {
    const { deps } = this.mgr;
    const local = this.isLocal;
    // Local models and plan usage cost nothing per token, so the USD budgets only gate API-key sessions.
    const budget = !this.billed ? null : checkBudget(this.settings, this.store.spentOn(), this.store.getTask(this.id)!.cost_usd);
    if (budget && !budget.ok) throw new AgentError('budget', budget.reason!);
    // Each start (a new task, or continuing one that stopped) gets the full turn allowance. Counting over the task's whole
    // life meant a long task that once reached the limit stopped again on its very next turn, whatever was asked.
    const turnsLeft = this.settings.maxTurns;
    const perms = this.store.getProjectPermissions(this.task.project);
    const full = this.settings.fullAccess;

    const options: Options = {
      cwd: this.policy.root,
      additionalDirectories: this.policy.extraRoots,
      model: this.task.model,
      ...(this.settings.effort && !local ? { effort: this.settings.effort } : {}),
      maxTurns: turnsLeft,
      ...(budget ? { maxBudgetUsd: budget.capUsd } : {}),
      tools: full ? [...AGENT_TOOLS, ...WEB_TOOLS] : AGENT_TOOLS,
      disallowedTools: full ? DISALLOWED_TOOLS.filter((t) => !WEB_TOOLS.includes(t)) : DISALLOWED_TOOLS,
      permissionMode: 'default',
      permissionPrompts: 'host',
      canUseTool: this.canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse] }],
        PostToolUse: [{ hooks: [this.postToolUse] }],
        PostToolUseFailure: [{ hooks: [this.postToolUseFailure] }],
      },
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: this.admin ? { workshop: this.adminTools() } : {},
      settings: {
        // The key helper (and so the Console key) is only ever configured for API-key sessions.
        ...(this.auth === 'api-key' ? { apiKeyHelper: deps.paths.keyHelper } : {}),
        permissions: { deny: full ? fullAccessDenyRules(!!this.admin) : SENSITIVE_DENY_RULES, defaultMode: 'default' },
        ...runtimeTuning(this.settings, local),
      } as Options['settings'],
      // Full access runs commands like Claude Code does, with the user's own permissions.
      ...(this.settings.sandboxCommands && !full
        ? {
            sandbox: {
              enabled: true,
              failIfUnavailable: true,
              autoAllowBashIfSandboxed: false,
              allowUnsandboxedCommands: false,
              filesystem: {
                allowWrite: [...this.policy.roots, ...(this.settings.gradleBuilds ? GRADLE_CACHE_DIRS.map((d) => path.join(os.homedir(), d)) : [])],
                denyRead: homeSecretPaths(),
              },
              network: { allowedDomains: [...new Set([...perms.networkDomains, ...(this.settings.gradleBuilds ? GRADLE_DOMAINS : [])])] },
              // Publishing commands need the user's logins; they always ask first (see approveCommand).
              ...(this.settings.allowPublishCommands ? { excludedCommands: PUBLISH_SANDBOX_EXCLUSIONS } : {}),
              credentials: { envVars: [{ name: 'DBUS_SESSION_BUS_ADDRESS', mode: 'deny' }] },
            },
          }
        : {}),
      env: buildRuntimeEnv(
        deps.baseEnv ?? process.env,
        deps.paths,
        this.settings,
        local ? { url: this.settings.ollamaUrl, model: this.task.model } : undefined,
      ),
      includePartialMessages: true,
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: workshopPrompt(this.settings) + (this.admin ? adminPrompt(this.admin) : ''),
        snapshot: true,
      },
      abortController: this.abort,
      stderr: (d: string) => log.warn(`agent-runtime[${this.id}]: ${d.trim().slice(0, 500)}`),
    };

    const queryFn = deps.queryFn ?? sdkQuery;
    this.q = queryFn({ prompt: this.input, options });
    void this.consume();

    // Authentication gate, before any message (and therefore any request) is sent:
    //   api-key      - the runtime must use the VOID Workshop key helper against the first-party API
    //   subscription - the runtime must use the Claude plan login, with no API key in play
    //   ollama       - the runtime must use the placeholder key (so the Console key is not loaded)
    const init = await Promise.race([
      this.q.initializationResult(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new AgentError('init-timeout', 'The agent runtime did not start in time.')), deps.initTimeoutMs ?? 30_000),
      ),
    ]).catch(async (err) => {
      await this.shutdown();
      throw err instanceof AgentError ? err : new AgentError('init-failed', `The agent runtime failed to start: ${(err as Error).message}`);
    });
    const account = init.account ?? {};
    if (!this.authSourceOk(account)) {
      await this.shutdown();
      this.setState('failed', {
        error: `Authentication source check failed (source: ${account.apiKeySource ?? 'none'}, provider: ${account.apiProvider ?? 'unknown'}). No request was sent.`,
      });
      throw new AgentError(
        'auth-source',
        local
          ? 'The agent runtime did not pick up the local Ollama settings. No request was sent.'
          : this.auth === 'subscription'
            ? 'The agent runtime is not signed in to your Claude plan. Sign in again under Settings → Sign-in. No request was sent.'
            : 'The agent runtime is not using the VOID Workshop API key. No request was sent.',
      );
    }
    const provider = local ? 'ollama' : (account.apiProvider ?? 'firstParty');
    const authInfo = {
      auth: this.auth,
      apiKeySource: account.apiKeySource,
      apiProvider: provider,
      ...(this.auth === 'subscription' ? { subscriptionType: account.subscriptionType ?? null } : {}),
    };
    this.emit('agent.auth', authInfo);
    this.store.addEvent(this.id, 'auth', authInfo);
    this.sendInternal(firstMessage);
  }

  /** In-process tools of an admin dev session. */
  private adminTools() {
    return createSdkMcpServer({
      name: 'workshop',
      version: APP_VERSION,
      tools: [
        sdkTool(
          'restart_workshop',
          'Restart VOID Workshop, after installing the build in its source tree (scripts/build.sh output) when install is true. ' +
            'Call it as the last step of a turn: the restart happens once this turn has ended and no other task is working, ' +
            'then this task continues with a message saying whether the install worked.',
          {
            install: z.boolean().describe('true: run scripts/install.sh with the current build first; false: restart only'),
            reason: z.string().max(300).describe('What changed, in a few words; shown to the user'),
          },
          async (args) => {
            try {
              return { content: [{ type: 'text' as const, text: this.mgr.requestRestart(this, args.install, args.reason) }] };
            } catch (err) {
              return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
            }
          },
        ),
      ],
    });
  }

  /** Apply effort / fast mode to the running session without restarting it. */
  async applyLiveSettings(settings: Pick<Settings, 'effort' | 'fastMode'>): Promise<void> {
    if (!this.q || this.closed || this.isLocal) return;
    await this.q.applyFlagSettings({ effortLevel: settings.effort as never, fastMode: settings.fastMode });
  }

  /** Summarise the conversation so far to shrink the context (the runtime's /compact). */
  compact(): void {
    if (this.closed) throw new AgentError('closed', 'This task session has ended. Resume it to continue.');
    if (this.active) throw new AgentError('busy', 'Wait for the agent to finish (or approve the plan) before compacting.');
    this.store.addEvent(this.id, 'compact', {});
    this.emit('agent.notice', { text: 'Compacting the conversation…' });
    this.setState('executing');
    this.input.push('/compact');
  }

  /** End the running turn early so the next queued message goes out now. */
  async yieldToQueue(): Promise<void> {
    if (!this.q || this.closed || (this.state !== 'executing' && this.state !== 'planning')) return;
    this.yieldingToQueue = true;
    this.mgr.denyApprovalsFor(this.id, 'The user sent a new message instead.');
    await this.q.interrupt().catch(() => undefined);
    // Normally the interrupted turn ends with a result message; do not hang if it does not.
    setTimeout(() => {
      if (this.yieldingToQueue && !this.closed) this.turnEnded('idle', '');
    }, 5000);
  }

  private turnEnded(state: 'idle' | 'awaiting-plan-approval', summary: string): void {
    this.yieldingToQueue = false;
    this.setState(state, { summary: clip(summary, 4000) });
    if (!!this.admin !== this.mgr.adminActive) {
      // An admin session started or ended while this turn ran: the next message resumes with the right powers.
      this.mgr.carryMode(this);
      void this.shutdown().then(() => state === 'idle' && this.mgr.turnFinished(this.id));
      return;
    }
    if (state === 'idle') this.mgr.turnFinished(this.id);
  }

  private async refreshContext(): Promise<void> {
    if (!this.q || this.closed) return;
    try {
      const cu = await this.q.getContextUsage({ detail: 'summary' });
      const cap = this.isLocal ? null : compactWindow(this.settings);
      this.context = { tokens: cu.totalTokens, max: cap ? Math.min(cap, cu.maxTokens) : cu.maxTokens };
      this.emit('agent.context', { ...this.context });
    } catch {
      /* older runtimes or a closed session: no meter */
    }
  }

  private flushDelta(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    if (!this.pendingDelta) return;
    const text = this.pendingDelta;
    this.pendingDelta = '';
    this.emit('agent.delta', { text });
  }

  private sendInternal(text: string): void {
    this.store.addEvent(this.id, 'user', { text });
    this.emit('agent.user', { text });
    // Pictures attached to this task (shared from the phone) go with the next message.
    const images = [];
    for (const img of this.mgr.takeAttachments(this.id)) {
      const data = this.mgr.images.base64(this.id, img.imageId);
      if (!data) continue;
      images.push(data);
      const payload = { id: `attach-${img.imageId}`, name: 'Shared picture', ...img };
      this.store.addEvent(this.id, 'image', payload);
      this.emit('agent.image', payload);
    }
    this.input.push(text, images);
  }

  send(text: string, mode?: AgentMode): void {
    if (this.closed) throw new AgentError('closed', 'This task session has ended. Resume it to continue.');
    if (this.state === 'planning' || this.state === 'executing')
      throw new AgentError('busy', 'The agent is still working. Wait for the turn to finish or stop it.');
    if (this.billed) {
      const budget = checkBudget(this.settings, this.store.spentOn(), this.store.getTask(this.id)!.cost_usd);
      if (!budget.ok) throw new AgentError('budget', budget.reason!);
    }
    if (mode) this.setMode(mode);
    if (this.mode === 'plan') {
      // A reply to a pending plan revises it; in an idle session it starts a new planning round.
      this.setState('planning');
      this.sendInternal(`${text}${PLANNING_SUFFIX}`);
      return;
    }
    if (this.state === 'awaiting-plan-approval') {
      // Leaving plan mode with a message approves the plan, with the message as extra instructions.
      this.store.addEvent(this.id, 'plan.approved', { mode: this.mode });
      this.setState('executing');
      this.implement(`${planApproved(this.mode, this.settings.fullAccess)}\n\n${text}`);
      return;
    }
    this.setState('executing');
    this.sendInternal(text);
  }

  approvePlan(mode: Exclude<AgentMode, 'plan'> = this.mode === 'plan' ? 'ask' : this.mode): void {
    if (this.state !== 'awaiting-plan-approval') throw new AgentError('state', 'There is no plan waiting for approval.');
    this.setMode(mode);
    this.store.addEvent(this.id, 'plan.approved', { mode });
    this.setState('executing');
    this.implement(planApproved(mode, this.settings.fullAccess));
  }

  /**
   * Send the go-ahead for an approved plan, first switching to the implementation model when one is set
   * (plan with a strong model, build with a cheaper one: most of a task's tokens go into implementing).
   */
  private implement(text: string): void {
    const next = this.settings.implementModel;
    if (!next || this.isLocal || next === this.task.model) return this.sendInternal(text);
    const from = this.task.model;
    this.setModel(next)
      .then(() => this.emit('agent.notice', { text: `Plan approved: implementing with ${next} instead of ${from}.` }))
      .catch((err: unknown) =>
        this.emit('agent.notice', { level: 'warn', text: `Could not switch to ${next} (${err instanceof Error ? err.message : String(err)}); staying on ${from}.` }),
      )
      .finally(() => {
        if (!this.closed) this.sendInternal(text);
      });
  }

  /** Change how much the agent may do without asking. Takes effect for the next tool call. */
  setMode(mode: AgentMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.store.addEvent(this.id, 'mode', { mode });
    this.emit('agent.mode', { mode });
  }

  /** Switch the model for the rest of this session. */
  async setModel(model: string): Promise<void> {
    if (model === this.task.model) return;
    await this.q?.setModel(model);
    this.task.model = model;
    this.store.updateTask(this.id, { model });
    this.store.addEvent(this.id, 'model', { model });
    this.emit('agent.model', { model });
  }

  async cancel(reason = 'Cancelled by user'): Promise<void> {
    this.cancelling = true;
    this.mgr.denyApprovalsFor(this.id, 'The user stopped the task.');
    if (this.q && this.active) {
      await Promise.race([this.q.interrupt().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    }
    await this.shutdown();
    if (this.active || this.state === 'idle') this.setState('cancelled', { error: reason });
  }

  /** End the session process; the transcript stays on disk so the task can be resumed. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.flushDelta();
    this.closed = true;
    this.mgr.denyApprovalsFor(this.id, 'The session ended.');
    this.input.close();
    try {
      this.q?.close();
    } catch {
      /* already closed */
    }
    if (!this.abort.signal.aborted) this.abort.abort();
    this.mgr.sessionClosed(this);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---------------------------------------------------------------------------------------
  // Message stream
  // ---------------------------------------------------------------------------------------
  private async consume(): Promise<void> {
    try {
      for await (const m of this.q!) this.handle(m);
      if (!this.closed && this.active) this.setState('interrupted', { error: 'The agent runtime exited unexpectedly.' });
    } catch (err) {
      if (!this.closed && !this.abort.signal.aborted) {
        log.error(`task ${this.id} stream error`, err);
        this.setState('failed', { error: redactText((err as Error).message).slice(0, 500) });
      }
    } finally {
      await this.shutdown();
    }
  }

  private handle(m: SDKMessage): void {
    if (m.type !== 'stream_event') this.flushDelta();
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          if (!this.keySourceOk(m.apiKeySource)) {
            void this.stopWith('failed', `Unexpected authentication source (${m.apiKeySource}). Stopped.`);
            return;
          }
          if (m.session_id && m.session_id !== this.task.session_id) {
            this.task.session_id = m.session_id;
            this.store.updateTask(this.id, { session_id: m.session_id });
          }
          this.emit('agent.init', { model: m.model, tools: m.tools, sessionId: m.session_id });
        } else if (m.subtype === 'api_retry') {
          const err = m.error;
          if (err === 'billing_error') return void this.stopBilling();
          if (err === 'authentication_failed' || err === 'oauth_org_not_allowed' || err === 'account_on_hold') {
            void this.stopWith('failed', this.authFailedText());
            return;
          }
          this.emit('agent.retry', { error: err, status: m.error_status, attempt: m.attempt, maxRetries: m.max_retries, delayMs: m.retry_delay_ms });
          this.store.addEvent(this.id, 'retry', { error: err, status: m.error_status, attempt: m.attempt });
        } else if (m.subtype === 'compact_boundary') {
          this.emit('agent.notice', { text: 'Context was compacted to stay within the model window.' });
        }
        return;
      }
      case 'rate_limit_event': {
        if (this.auth !== 'subscription') return;
        const info = m.rate_limit_info;
        if (info.status === 'rejected') return void this.stopPlanLimit(info.resetsAt, info.rateLimitType);
        if (info.status === 'allowed_warning')
          this.emit('agent.notice', { level: 'warn', text: `Your Claude plan is close to its ${limitName(info.rateLimitType)}.` });
        return;
      }
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event as { type: string; delta?: { type: string; text?: string } };
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          // Batch token-sized deltas: far fewer IPC messages and re-renders while streaming.
          this.pendingDelta += ev.delta.text;
          this.deltaTimer ??= setTimeout(() => this.flushDelta(), DELTA_FLUSH_MS);
        }
        if (ev.type === 'message_start') {
          this.flushDelta();
          this.emit('agent.messageStart', {});
        }
        return;
      }
      case 'assistant': {
        if (m.error) {
          if (m.error === 'billing_error') return void this.stopBilling();
          if (m.error === 'rate_limit' && this.auth === 'subscription') return void this.stopPlanLimit();
          if (m.error === 'authentication_failed') return void this.stopWith('failed', this.authFailedText());
          if (m.error === 'model_not_found')
            return void this.stopWith(
              'failed',
              this.isLocal
                ? `Ollama does not have the model ${this.task.model}. Pull it or refresh the model list in Settings.`
                : `The model ${this.task.model} is not available to this API key. Refresh the model list in Settings.`,
            );
          this.emit('agent.notice', { level: 'error', text: `API error: ${m.error}` });
        }
        for (const block of m.message.content as unknown as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            if (!m.parent_tool_use_id) this.lastAssistantText = block.text;
            this.store.addEvent(this.id, 'assistant', { text: block.text });
            this.emit('agent.text', { text: block.text, sub: !!m.parent_tool_use_id });
          } else if (block.type === 'tool_use') {
            const name = String(block.name);
            const input = (block.input ?? {}) as Record<string, unknown>;
            this.trackPlan(String(block.id), name, input);
            if (name === 'Read' && typeof input.file_path === 'string' && imageMediaType(input.file_path))
              this.imageReads.set(String(block.id), path.resolve(this.task.project, input.file_path));
            const summary = this.summarizeTool(name, input);
            this.store.addEvent(this.id, 'tool', { id: block.id, name, summary });
            this.emit('agent.tool', { id: block.id, name, summary });
          }
        }
        return;
      }
      case 'user': {
        const content = (m.message as { content?: unknown }).content;
        if (!Array.isArray(content)) return;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type !== 'tool_result') continue;
          const text = toolResultText(block.content);
          const id = String(block.tool_use_id);
          const isError = block.is_error === true;
          this.store.addEvent(this.id, 'tool.result', { id, isError, text: clip(text, 4000) });
          this.emit('agent.toolResult', { id, isError, text: clip(text, 4000) });
          this.keepImages(id, block.content, isError);
        }
        return;
      }
      case 'result':
        this.handleResult(m);
        return;
      default:
        return;
    }
  }

  /** Save the pictures a tool result carries (or the image file a Read looked at) so they can be shown later. */
  private keepImages(toolId: string, content: unknown, isError: boolean): void {
    const file = this.imageReads.get(toolId);
    this.imageReads.delete(toolId);
    if (isError) return;
    const images = this.mgr.images;
    const saved = [];
    try {
      if (Array.isArray(content)) {
        for (const c of content as Array<Record<string, unknown>>) {
          const src = c?.type === 'image' ? (c.source as Record<string, unknown> | undefined) : undefined;
          if (src?.type === 'base64' && typeof src.data === 'string') {
            const img = images.save(this.id, Buffer.from(src.data, 'base64'));
            if (img) saved.push(img);
          }
        }
      }
      if (!saved.length && file) {
        const img = images.saveFile(this.id, file);
        if (img) saved.push(img);
      }
    } catch (err) {
      log.warn(`image not kept: ${(err as Error).message}`);
    }
    const name = file ? path.basename(file) : 'image';
    for (const img of saved) {
      const payload = { id: toolId, name, ...img };
      this.store.addEvent(this.id, 'image', payload);
      this.emit('agent.image', payload);
    }
  }

  private handleResult(m: Extract<SDKMessage, { type: 'result' }>): void {
    // The runtime prices local models and plan usage as if they were billed per token; they are not.
    const total = this.billed && typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0;
    const delta = this.cost.delta(total);
    const usage = Object.values(m.modelUsage ?? {});
    const tokens = usage.reduce(
      (acc, u) => ({
        input: acc.input + u.inputTokens,
        output: acc.output + u.outputTokens,
        cacheRead: acc.cacheRead + u.cacheReadInputTokens,
        cacheWrite: acc.cacheWrite + u.cacheCreationInputTokens,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const costBasis = this.auth === 'subscription' ? 'subscription' : (usage.find((u) => u.costBasis)?.costBasis ?? 'list');
    const prev = this.store.getTask(this.id)!;
    // modelUsage is cumulative for this query: record per-turn deltas.
    const d = {
      input: Math.max(0, tokens.input - this.lastTokens.input),
      output: Math.max(0, tokens.output - this.lastTokens.output),
      cacheRead: Math.max(0, tokens.cacheRead - this.lastTokens.cacheRead),
      cacheWrite: Math.max(0, tokens.cacheWrite - this.lastTokens.cacheWrite),
    };
    this.lastTokens = tokens;
    if (delta > 0 || d.input + d.output > 0) {
      this.store.addUsage({
        taskId: this.id,
        model: this.task.model,
        costUsd: delta,
        inputTokens: d.input,
        outputTokens: d.output,
        cacheRead: d.cacheRead,
        cacheWrite: d.cacheWrite,
      });
    }
    const updated = this.store.updateTask(this.id, {
      cost_usd: prev.cost_usd + delta,
      input_tokens: prev.input_tokens + d.input,
      output_tokens: prev.output_tokens + d.output,
      cache_read_tokens: prev.cache_read_tokens + d.cacheRead,
      cache_write_tokens: prev.cache_write_tokens + d.cacheWrite,
      turns: prev.turns + (m.num_turns ?? 0),
      cost_basis: costBasis,
      session_id: m.session_id || prev.session_id,
    });
    const spentToday = this.store.spentOn();
    this.emit('usage.updated', { taskCostUsd: updated.cost_usd, deltaUsd: delta, spentTodayUsd: spentToday, tokens: d, costBasis, durationMs: m.duration_ms });
    this.store.addEvent(this.id, 'result', { subtype: m.subtype, deltaUsd: delta, totalUsd: updated.cost_usd, tokens: d, costBasis });

    if (this.cancelling) return;
    void this.refreshContext();
    if (this.yieldingToQueue) return this.turnEnded('idle', this.lastAssistantText);
    if (m.subtype === 'error_max_budget_usd')
      return void this.stopWith('stopped-budget', `Stopped: the estimated spend cap for this run was reached ($${updated.cost_usd.toFixed(2)} on this task).`);
    if (m.subtype === 'error_max_turns') return void this.stopWith('stopped-budget', `Stopped: the turn limit (${this.settings.maxTurns}) was reached.`);
    if (m.subtype !== 'success') return void this.stopWith('failed', clip(redactText((m.errors ?? []).join('\n') || 'The agent run failed.'), 1000));
    if (m.is_error) {
      const text = redactText(String(m.result ?? 'Request failed'));
      if (this.billed && /credit balance|billing|purchase credits/i.test(text)) return void this.stopBilling();
      if (this.auth === 'subscription' && /hit your (?:usage )?limit|usage limit reached|limit reached/i.test(text)) return void this.stopPlanLimit();
      return void this.stopWith('failed', clip(text, 1000));
    }

    const budget = !this.billed ? { ok: true as const, capUsd: 0 } : checkBudget(this.settings, spentToday, updated.cost_usd);
    const summary = String(m.result ?? this.lastAssistantText ?? '');
    if (!budget.ok) {
      this.setState(this.state === 'planning' ? 'awaiting-plan-approval' : 'idle', { summary: clip(summary, 4000) });
      return void this.stopWith('stopped-budget', budget.reason!);
    }
    if (this.billed && updated.cost_usd >= this.settings.perTaskBudgetUsd * 0.75) {
      this.emit('agent.notice', {
        level: 'warn',
        text: `This task has used ${Math.round((updated.cost_usd / this.settings.perTaskBudgetUsd) * 100)}% of its estimated budget.`,
      });
    }
    if (this.state === 'planning') {
      this.store.addEvent(this.id, 'plan', { text: summary, items: this.plan });
      this.emit('agent.plan', { text: summary, items: this.plan });
      this.turnEnded('awaiting-plan-approval', summary);
    } else {
      this.turnEnded('idle', summary);
    }
  }

  private async stopWith(state: TaskState, message: string): Promise<void> {
    if (this.closed && !this.active) return;
    this.mgr.denyApprovalsFor(this.id, message);
    this.store.addEvent(this.id, 'stopped', { state, message });
    this.emit('agent.notice', { level: state === 'stopped-budget' ? 'warn' : 'error', text: message });
    this.setState(state, { error: message });
    await this.shutdown();
  }

  private async stopBilling(): Promise<void> {
    if (this.closed && !this.active) return;
    const message =
      'The API reports the organization has no usable credit (billing error). API-key requests are stopped. Check Billing in the Anthropic Console; VOID Workshop never buys credits.';
    this.store.setFlag('billingBlocked', { at: Date.now(), taskId: this.id, message });
    this.mgr.deps.emit('billing.blocked', { message });
    await this.stopWith('stopped-billing', message);
    await this.mgr.continueAfterExhaustion(this.id, 'api-key', this.mode);
  }

  /** The Claude plan's usage limit was reached: block the plan until it resets, then try the API key. */
  private async stopPlanLimit(resetsAt?: number, type?: string): Promise<void> {
    if (this.closed && !this.active) return;
    // resetsAt is in seconds since the epoch.
    const until = resetsAt && resetsAt > Date.now() / 1000 ? resetsAt * 1000 : Date.now() + PLAN_LIMIT_DEFAULT_MS;
    const when = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const message = `Your Claude plan reached its ${limitName(type)}. It resets around ${when}.`;
    this.store.setFlag(PLAN_LIMIT_FLAG, { until, message, type: type ?? null });
    this.mgr.deps.emit('plan.limited', { until, message });
    await this.stopWith('stopped-limit', message);
    await this.mgr.continueAfterExhaustion(this.id, 'subscription', this.mode);
  }

  private authFailedText(): string {
    return this.auth === 'subscription'
      ? 'Your Claude sign-in was rejected (it may have expired or been revoked). Sign in again under Settings → Sign-in.'
      : 'The API rejected the key (authentication failed). Check Settings → API key.';
  }

  // ---------------------------------------------------------------------------------------
  // Plan tracking (TodoWrite: each call carries the whole list)
  // ---------------------------------------------------------------------------------------
  private trackPlan(toolUseId: string, name: string, input: Record<string, unknown>): void {
    if (name !== 'TodoWrite' || !Array.isArray(input.todos)) return;
    this.plan = (input.todos as Array<Record<string, unknown>>).slice(0, 100).map((t, i) => ({
      ref: `${toolUseId}:${i}`,
      id: String(i + 1),
      subject: String(t.content ?? 'Step').slice(0, 300),
      description: typeof t.activeForm === 'string' ? t.activeForm.slice(0, 300) : '',
      status: (['pending', 'in_progress', 'completed'].includes(String(t.status)) ? t.status : 'pending') as PlanItem['status'],
    }));
    this.emit('agent.todos', { items: this.plan });
    this.store.addEvent(this.id, 'todos', { items: this.plan });
  }

  private summarizeTool(name: string, input: Record<string, unknown>): string {
    const p = (v: unknown) => (typeof v === 'string' ? this.policy.rel(path.resolve(this.policy.root, v)) : '');
    switch (name) {
      case 'Read':
        return `Read ${p(input.file_path)}`;
      case 'Edit':
        return `Edit ${p(input.file_path)}`;
      case 'Write':
        return `Write ${p(input.file_path)}`;
      case 'Glob':
        return `Find files ${String(input.pattern ?? '')}`;
      case 'Grep':
        return `Search for ${JSON.stringify(String(input.pattern ?? '')).slice(0, 80)}`;
      case 'Bash':
        return `Run: ${String(input.command ?? '').slice(0, 200)}`;
      case 'TodoWrite': {
        const todos = Array.isArray(input.todos) ? (input.todos as Array<{ status?: string }>) : [];
        return `Plan: ${todos.length} step(s), ${todos.filter((t) => t.status === 'completed').length} done`;
      }
      default:
        return name;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Policy hooks and approvals
  // ---------------------------------------------------------------------------------------
  private readonly preToolUse: HookCallback = async (input, toolUseID) => {
    const i = input as { tool_name: string; tool_input: Record<string, unknown>; cwd?: string };
    if (toolUseID && i.cwd) this.hookCwd.set(toolUseID, i.cwd);
    const verdict = this.policyVerdict(i.tool_name, i.tool_input ?? {});
    if (verdict.kind === 'deny') {
      this.store.addEvent(this.id, 'policy.denied', { tool: i.tool_name, reason: verdict.reason });
      this.emit('agent.policyDenied', { tool: i.tool_name, reason: verdict.reason });
      return preDecision('deny', verdict.reason);
    }
    if (verdict.kind === 'ask') return preDecision('ask', verdict.reason);
    return {};
  };

  /** Pure policy decision for a tool call; exposed for tests. */
  policyVerdict(tool: string, input: Record<string, unknown>): { kind: 'deny' | 'ask' | 'pass'; reason: string } {
    const planning = this.state === 'planning' || this.state === 'awaiting-plan-approval' || this.mode === 'plan';
    if (BOOKKEEPING_TOOLS.has(tool)) return { kind: 'pass', reason: '' };
    if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
      const target = (tool === 'Read' ? input.file_path : input.path) as string | undefined;
      if (target !== undefined) {
        const d = this.policy.check(String(target), 'read');
        if (!d.allowed) return { kind: 'deny', reason: d.reason ?? 'Outside the project' };
        if (d.sensitive) return { kind: 'ask', reason: `Sensitive: ${d.sensitive}` };
      }
      const pattern = String(input.pattern ?? '') + ' ' + String(input.glob ?? '');
      if (
        !this.settings.fullAccess &&
        tool !== 'Read' &&
        (/(^|\s|\/)\.\.(\/|\s|$)/.test(pattern) || (/(^|\s)\//.test(String(input.pattern ?? '')) && tool === 'Glob'))
      ) {
        return { kind: 'deny', reason: 'Search patterns must stay inside the project' };
      }
      if (tool !== 'Read' && /\.env|id_rsa|id_ed25519|\.pem|credentials|\.npmrc|\.netrc/i.test(pattern)) {
        return { kind: 'ask', reason: 'Search targets sensitive files' };
      }
      return { kind: 'pass', reason: '' };
    }
    if (tool === 'Edit' || tool === 'Write') {
      const d = this.policy.check(String(input.file_path ?? ''), 'write');
      if (!d.allowed) return { kind: 'deny', reason: d.reason ?? 'Outside the project' };
      if (planning) return { kind: 'deny', reason: 'Planning phase is read-only. Present your plan; edits are enabled after the user approves it.' };
      return { kind: 'ask', reason: 'File changes require approval' };
    }
    // Stopping a background command the agent started (full access only, where those are allowed).
    if (tool === 'TaskStop')
      return this.settings.fullAccess ? { kind: 'pass', reason: '' } : { kind: 'deny', reason: 'There are no background commands without full access.' };
    if (tool === 'Bash') {
      if (input.run_in_background && !this.settings.fullAccess) return { kind: 'deny', reason: 'Background commands need full access in VOID Workshop.' };
      if (input.dangerouslyDisableSandbox) return { kind: 'deny', reason: 'Running outside the sandbox is not allowed.' };
      const a = this.assess(String(input.command ?? ''));
      if (a.blocked) return { kind: 'deny', reason: `Blocked by VOID Workshop policy: ${a.blockReasons.join('; ')}` };
      if (planning && !(a.categories.length === 1 && a.categories[0] === 'read-only')) {
        return { kind: 'deny', reason: 'Planning phase allows only read-only commands. Present your plan first.' };
      }
      return { kind: 'ask', reason: 'Commands require approval' };
    }
    if (WEB_TOOLS.includes(tool) && this.settings.fullAccess) return { kind: 'ask', reason: 'Web access requires approval' };
    if (tool === RESTART_TOOL)
      return this.admin && this.mgr.adminActive ? { kind: 'pass', reason: '' } : { kind: 'deny', reason: 'Restarting Workshop needs an admin dev session.' };
    return { kind: 'deny', reason: `The ${tool} tool is not available in VOID Workshop.` };
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
    try {
      if (BOOKKEEPING_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };
      const verdict = this.policyVerdict(toolName, input);
      if (verdict.kind === 'deny') return deny(verdict.reason);
      if (toolName === 'TaskStop' || toolName === RESTART_TOOL) return { behavior: 'allow', updatedInput: input };
      if (toolName === 'Edit' || toolName === 'Write') return await this.approveFileChange(toolName, input, signal, toolUseID);
      if (toolName === 'Bash') return await this.approveCommand(input, signal, toolUseID);
      if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') return await this.approveRead(toolName, input, signal);
      if (WEB_TOOLS.includes(toolName)) return await this.approveWeb(toolName, input, signal);
      return deny(`The ${toolName} tool is not available in VOID Workshop.`);
    } catch (err) {
      log.error(`approval error in task ${this.id}`, err);
      return deny(`Approval failed: ${(err as Error).message}`);
    }
  };

  private async approveFileChange(tool: 'Edit' | 'Write', input: Record<string, unknown>, signal: AbortSignal, toolUseID: string): Promise<PermissionResult> {
    const d = this.policy.check(String(input.file_path ?? ''), 'write');
    if (!d.allowed) return deny(d.reason ?? 'Not allowed');
    const rel = this.policy.rel(d.real);
    let current: string | null = null;
    if (d.exists) {
      const buf = fs.readFileSync(d.real);
      if (buf.includes(0)) return deny('Refusing to edit a binary file.');
      current = buf.toString('utf8');
    }
    const preHash = d.exists ? fileHash(d.real) : null;
    let proposed: string;
    try {
      proposed =
        tool === 'Write'
          ? String(input.content ?? '')
          : applyEdit(current ?? '', String(input.old_string ?? ''), String(input.new_string ?? ''), input.replace_all === true);
    } catch (err) {
      if (err instanceof EditApplyError) return deny(`${err.message}. Read the file again before editing.`);
      throw err;
    }
    const summary = `${current === null ? 'Create' : 'Modify'} ${rel}`;
    // Sensitive files, and files outside the project (full access), always ask, whatever the mode.
    const coveredByAuto = !d.sensitive && !d.outside;
    const decision =
      (this.mode === 'auto-edit' || this.mode === 'auto') && coveredByAuto
        ? this.autoApproved('file-change', summary)
        : await this.mgr.requestApproval(
            {
              taskId: this.id,
              kind: 'file-change',
              canAllowAll: this.mode !== 'plan',
              coveredByAuto,
              toolName: tool,
              summary,
              rel,
              diff: unifiedDiff(rel, current, proposed),
              isNew: current === null,
              sensitive: d.sensitive,
            },
            signal,
          );
    if (decision.decision !== 'allow') return deny(decision.note ? `The user declined this change: ${decision.note}` : 'The user declined this change.');
    // External change detection: the file must be exactly what the user reviewed.
    if (fileHash(d.real) !== preHash) {
      this.emit('file.conflict', { rel, reason: 'changed on disk while the change was awaiting approval' });
      return deny(`${rel} changed on disk while waiting for approval (edited outside VOID Workshop). Re-read it and propose the change again.`);
    }
    new PreimageStore(this.mgr.deps.paths.preimageDir, this.store).capture(this.id, d.real);
    this.pendingFileWrites.set(toolUseID, { real: d.real });
    this.emit('file.changed', { rel, status: 'proposed' });
    return { behavior: 'allow', updatedInput: input };
  }

  private async approveCommand(input: Record<string, unknown>, signal: AbortSignal, toolUseID: string): Promise<PermissionResult> {
    const command = String(input.command ?? '');
    const assessment = this.assess(command);
    if (assessment.blocked) return deny(`Blocked by VOID Workshop policy: ${assessment.blockReasons.join('; ')}`);
    const cwd = this.hookCwd.get(toolUseID) ?? this.policy.root;
    const summary = String(input.description ?? 'Run a shell command');
    // Publishing commands run outside the sandbox (sandbox.excludedCommands), so they always ask.
    const publishes = assessment.categories.includes('publishes');
    const full = this.settings.fullAccess;
    const sandboxed = this.settings.sandboxCommands && !full && !publishes;
    // Read fresh each time, so "Always allow" applies to the rest of this session too.
    const remembered = !publishes && this.store.getProjectPermissions(this.task.project).alwaysAllowCommands.includes(command.trim());
    // Auto mode runs commands unasked inside the sandbox, or with full access unless the policy wants the user to see them
    // (risky ones) or it publishes and the user hasn't let Auto publish too.
    const coveredByAuto = sandboxed || (full && (!publishes || this.settings.autoPublish) && !assessment.askReasons.length);
    const decision =
      (this.mode === 'auto' && coveredByAuto) || remembered
        ? this.autoApproved('command', `${remembered ? 'Always allowed' : summary}: ${redactText(command).slice(0, 200)}`)
        : await this.mgr.requestApproval(
            {
              taskId: this.id,
              kind: 'command',
              toolName: 'Bash',
              summary,
              command,
              cwd,
              description: typeof input.description === 'string' ? input.description : undefined,
              assessment,
              sandboxed,
              canAlwaysAllow: !publishes,
              canAllowAll: this.mode !== 'plan',
              coveredByAuto,
            },
            signal,
          );
    if (decision.decision !== 'allow') return deny(decision.note ? `The user declined this command: ${decision.note}` : 'The user declined this command.');
    if (decision.always && !publishes) this.rememberCommand(command.trim());
    const runId = crypto.randomUUID();
    this.commandStarts.set(toolUseID, { runId, started: Date.now(), command });
    this.store.addCommandRun({
      id: runId,
      taskId: this.id,
      project: this.task.project,
      origin: 'agent',
      command,
      cwd,
      reason: (input.description as string) ?? null,
      status: 'running',
    });
    this.mgr.deps.emit('runner.started', { runId, taskId: this.id, origin: 'agent', command: redactText(command), cwd });
    return { behavior: 'allow', updatedInput: input };
  }

  private rememberCommand(command: string): void {
    const perms = this.store.getProjectPermissions(this.task.project);
    if (perms.alwaysAllowCommands.includes(command)) return;
    if (perms.alwaysAllowCommands.length >= MAX_ALWAYS_ALLOW) {
      this.emit('agent.notice', { level: 'warn', text: `Not remembered: this project already has ${MAX_ALWAYS_ALLOW} always-allowed commands.` });
      return;
    }
    this.store.setProjectPermissions(this.task.project, { ...perms, alwaysAllowCommands: [...perms.alwaysAllowCommands, command] });
    this.store.addEvent(this.id, 'command.alwaysAllowed', { command: redactText(command) });
    this.emit('agent.notice', { text: `Always allowed in this project from now on: ${redactText(command).slice(0, 200)}` });
  }

  private assess(command: string): CommandAssessment {
    return assessCommand(command, {
      root: this.policy.root,
      extraRoots: this.policy.extraRoots,
      allowPublish: this.settings.allowPublishCommands,
      fullAccess: this.settings.fullAccess,
      admin: !!this.admin,
    });
  }

  private autoApproved(kind: ApprovalRequest['kind'], summary: string): ApprovalDecision {
    this.store.addEvent(this.id, 'approval.resolved', { kind, summary, decision: 'allow', auto: true });
    this.emit('agent.autoApproved', { kind, summary });
    return { decision: 'allow' };
  }

  private async approveRead(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const target = String((tool === 'Read' ? input.file_path : input.path) ?? input.pattern ?? '');
    const d = target ? this.policy.check(target, 'read') : null;
    const decision = await this.mgr.requestApproval(
      {
        taskId: this.id,
        kind: 'read',
        toolName: tool,
        summary: `${tool} ${d ? this.policy.rel(d.real) : target}`,
        rel: d ? this.policy.rel(d.real) : target,
        sensitive: d?.sensitive ?? 'pattern may match sensitive files',
      },
      signal,
    );
    if (decision.decision !== 'allow') return deny('The user declined access to this file.');
    return { behavior: 'allow', updatedInput: input };
  }

  /** Full access only: searches and fetches run unasked in the auto modes and ask in Ask mode. */
  private async approveWeb(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const target = String((tool === 'WebFetch' ? input.url : input.query) ?? '').slice(0, 300);
    const summary = `${tool === 'WebFetch' ? 'Fetch' : 'Search the web for'} ${target}`;
    const decision =
      this.mode !== 'ask'
        ? this.autoApproved('read', summary)
        : await this.mgr.requestApproval(
            { taskId: this.id, kind: 'read', toolName: tool, summary, rel: target, sensitive: null, canAllowAll: true, coveredByAuto: true },
            signal,
          );
    if (decision.decision !== 'allow') return deny('The user declined this web request.');
    return { behavior: 'allow', updatedInput: input };
  }

  private readonly postToolUse: HookCallback = async (input) => {
    const i = input as { tool_name: string; tool_use_id: string; tool_response?: unknown };
    this.afterTool(i.tool_name, i.tool_use_id, true, i.tool_response);
    return {};
  };

  private readonly postToolUseFailure: HookCallback = async (input) => {
    const i = input as { tool_name: string; tool_use_id: string; error?: string };
    this.afterTool(i.tool_name, i.tool_use_id, false, i.error);
    return {};
  };

  private afterTool(tool: string, toolUseId: string, ok: boolean, response: unknown): void {
    if (tool === 'Edit' || tool === 'Write') {
      const pending = this.pendingFileWrites.get(toolUseId);
      if (!pending) return;
      this.pendingFileWrites.delete(toolUseId);
      const row = this.store.getFileChange(this.id, pending.real);
      if (!row) return;
      const post = fileHash(pending.real);
      if (ok && post !== row.pre_hash) {
        this.store.upsertFileChange({ ...row, status: 'applied', post_hash: post });
        this.emit('file.changed', { rel: this.policy.rel(pending.real), status: 'applied' });
      } else if (!ok && row.status === 'proposed' && post === row.pre_hash) {
        this.emit('file.changed', { rel: this.policy.rel(pending.real), status: 'failed' });
      }
    } else if (tool === 'Bash') {
      const start = this.commandStarts.get(toolUseId);
      if (!start) return;
      this.commandStarts.delete(toolUseId);
      const text = redactText(toolResultText(response));
      const durationMs = Date.now() - start.started;
      this.store.finishCommandRun(start.runId, { status: ok ? 'succeeded' : 'failed', exitCode: null, durationMs, outputTail: text });
      this.mgr.deps.emit('runner.finished', { runId: start.runId, taskId: this.id, origin: 'agent', ok, durationMs, output: clip(text, 20_000) });
      if (ok && /\b(test|tests|check|lint|clippy|tsc|vitest|jest|pytest|typecheck|type-check|build)\b/.test(start.command)) this.mgr.markTested(this.id);
    }
  }
}

function limitName(type?: string): string {
  switch (type) {
    case 'five_hour':
      return '5-hour usage limit';
    case 'seven_day':
    case 'seven_day_opus':
    case 'seven_day_sonnet':
      return 'weekly usage limit';
    default:
      return 'usage limit';
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : typeof c === 'string' ? c : '')).join('\n');
  }
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.stdout === 'string' || typeof o.stderr === 'string') return [o.stdout, o.stderr].filter(Boolean).join('\n');
    try {
      return JSON.stringify(content).slice(0, 20_000);
    } catch {
      return '';
    }
  }
  return content === undefined || content === null ? '' : String(content);
}

/** Owns task sessions, pending approvals and queued messages. Up to `maxRunningTasks` tasks work at once. */
export class AgentManager {
  private readonly sessions = new Map<string, TaskSession>();
  private readonly queues = new Map<string, QueuedMessage[]>();
  private readonly approvals = new Map<string, { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }>();
  readonly images: ImageStore;

  constructor(readonly deps: AgentDeps) {
    this.images = new ImageStore(deps.paths.imageDir);
    this.images.prune();
  }

  private pendingRestart: { req: RestartRequest; timer: NodeJS.Timeout } | null = null;
  /** Modes of sessions closed only to change their admin powers: they resume in the same mode. */
  private readonly carriedModes = new Map<string, AgentMode>();
  /** Pictures waiting to go with a task's next message (moved there from the phone's uploads). */
  private readonly attachments = new Map<string, SavedImage[]>();

  /** Attach uploaded pictures to a task's next message. Unknown ids are refused, so nothing is half-attached. */
  attach(taskId: string, imageIds: string[]): void {
    if (!imageIds.length) return;
    const have = this.attachments.get(taskId) ?? [];
    this.checkUploads(have.length + imageIds.length, imageIds);
    const moved = imageIds.map((id) => this.images.adopt(UPLOADS, taskId, id)).filter((x): x is SavedImage => !!x);
    this.attachments.set(taskId, [...have, ...moved]);
  }

  private checkUploads(total: number, imageIds: string[]): void {
    if (total > MAX_ATTACHMENTS) throw new AgentError('attachments', `At most ${MAX_ATTACHMENTS} pictures can go with one message.`);
    for (const id of imageIds) if (!this.images.has(UPLOADS, id)) throw new AgentError('attachments', 'A picture is no longer on the PC. Share it again.');
  }

  takeAttachments(taskId: string): SavedImage[] {
    const a = this.attachments.get(taskId) ?? [];
    this.attachments.delete(taskId);
    return a;
  }

  private settings(): Settings {
    const s = this.deps.store.getSettings();
    // An admin dev session works like Full access with Auto publishing, whatever the settings say.
    return this.adminActive ? { ...s, fullAccess: true, autoPublish: true } : s;
  }

  // ---- admin dev session ------------------------------------------------------------------------
  get adminActive(): boolean {
    return !!this.deps.admin?.();
  }

  adminContext(): AdminContext | null {
    return this.deps.admin?.() ?? null;
  }

  /**
   * An admin session started or ended. Sessions keep the powers they started with, so the ones that differ are
   * closed and resume as they should on their next message. Ending stops admin tasks that are still working,
   * so nothing keeps running with admin powers; starting lets running tasks finish their turn first.
   */
  async adminChanged(): Promise<void> {
    const active = this.adminActive;
    if (!active) this.cancelRestart();
    for (const s of [...this.sessions.values()]) {
      if (s.isClosed || !!s.admin === active) continue;
      if (s.running) {
        if (!active) await s.cancel('The admin session ended.');
      } else {
        this.carryMode(s);
        await s.shutdown();
      }
    }
  }

  carryMode(s: TaskSession): void {
    this.carriedModes.set(s.id, s.currentMode);
  }

  /** The admin restart tool: remember the request; it runs once the turn has ended and every task is idle. */
  requestRestart(s: TaskSession, install: boolean, reason: string): string {
    const ctx = this.adminContext();
    if (!ctx || !s.admin) throw new AgentError('admin', 'Restarting Workshop needs an admin dev session.');
    if (!ctx.canRestart || !this.deps.restart)
      throw new AgentError(
        'admin',
        'This VOID Workshop build cannot restart itself yet. Ask the user to run ./scripts/install.sh once and restart Workshop by hand.',
      );
    if (install) {
      const src = ctx.sourceDir;
      if (!src) throw new AgentError('admin', 'The VOID Workshop source folder was not found, so there is nothing to install.');
      const missing = ['src-tauri/target/release/void-workshop', 'sidecar/dist/main.js'].filter((f) => !fs.existsSync(path.join(src, f)));
      if (missing.length) throw new AgentError('admin', `Build first (./scripts/build.sh): missing ${missing.join(', ')}.`);
    }
    this.cancelRestart();
    const req: RestartRequest = { taskId: s.id, install, mode: s.currentMode, reason: reason.trim().slice(0, 300) };
    this.pendingRestart = { req, timer: setInterval(() => this.maybeRestart(), 2000) };
    this.deps.emit('admin.restartPending', { taskId: s.id, install, reason: req.reason });
    log.info(`admin: restart requested by task ${s.id} (install: ${install})`);
    return `Restart scheduled${install ? ' with the new build' : ''}. It happens when this turn ends${
      this.runningCount(s.id) ? ' and the other working tasks are idle' : ''
    }; end your turn now with a short summary. This task continues automatically after the restart.`;
  }

  /** Tasks the agent is working on right now. */
  get workingCount(): number {
    return this.runningCount();
  }

  private runningCount(except?: string): number {
    return [...this.sessions.values()].filter((x) => !x.isClosed && x.running && x.id !== except).length;
  }

  private cancelRestart(): void {
    if (!this.pendingRestart) return;
    clearInterval(this.pendingRestart.timer);
    this.pendingRestart = null;
  }

  private maybeRestart(): void {
    const p = this.pendingRestart;
    if (!p) return;
    const state = this.deps.store.getTask(p.req.taskId)?.state;
    // The user stopped the task that asked for it: no restart.
    if (!state || ['cancelled', 'failed', 'completed'].includes(state) || !this.adminActive) return this.cancelRestart();
    if (this.runningCount() > 0) return;
    this.cancelRestart();
    log.info(`admin: restarting for task ${p.req.taskId}`);
    this.deps.restart?.(p.req);
  }

  /** Why one Anthropic auth method cannot be used right now, or null when it can. */
  async authProblem(auth: AnthropicAuth): Promise<AgentError | null> {
    const { store } = this.deps;
    if (auth === 'subscription') {
      if (!store.getFlag<SubscriptionStatus>(SUBSCRIPTION_FLAG)?.signedIn)
        return new AgentError('not-signed-in', 'You are not signed in to a Claude plan. Sign in under Settings → Sign-in.');
      const limit = store.getFlag<{ until: number; message: string }>(PLAN_LIMIT_FLAG);
      if (limit && limit.until > Date.now()) return new AgentError('plan-limit', limit.message);
      return null;
    }
    const billing = store.getFlag<{ message: string }>('billingBlocked');
    if (billing) return new AgentError('billing', `${billing.message} Acknowledge the billing stop in Settings after checking the Console.`);
    let key;
    try {
      key = await this.deps.keys.read();
    } catch (err) {
      return new AgentError('missing-key', (err as Error).message);
    }
    if (!key) return new AgentError('missing-key', 'No API key is configured. Add your Console API key in Settings → API key.');
    try {
      validateApiKeyFormat(key.key);
    } catch (err) {
      return new AgentError('bad-key', (err as Error).message);
    }
    return null;
  }

  /**
   * The Anthropic auth method to use: the one chosen in settings (or `prefer`), or the other one when the
   * chosen one is unavailable and fallback is on.
   */
  async pickAnthropicAuth(prefer?: AnthropicAuth): Promise<{ auth: AnthropicAuth; switchedFrom?: AnthropicAuth; reason?: string }> {
    const settings = this.settings();
    const first = prefer ?? settings.anthropicAuth;
    const problem = await this.authProblem(first);
    if (!problem) return { auth: first };
    if (settings.authFallback && !(await this.authProblem(otherAuth(first)))) return { auth: otherAuth(first), switchedFrom: first, reason: problem.message };
    throw problem;
  }

  /**
   * Start the runtime with the Claude plan login and read its account and model list from the initialize
   * answer. No message is sent, so no model request is made.
   */
  async probeSubscription(): Promise<{ account: AccountInfo; models: ModelInfo[] }> {
    return this.withProbe(async (_q, init) => ({ account: init.account ?? {}, models: init.models ?? [] }));
  }

  /**
   * The plan's usage meters (5-hour, weekly, per model) as Claude Code's /usage reads them from claude.ai.
   * Only this short-lived runtime may fetch them: sessions run with non-essential traffic off, which hides them.
   * No message is sent and nothing is billed.
   */
  async probePlanUsage(): Promise<Record<string, unknown>> {
    return this.withProbe(
      async (q) => (await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })) as unknown as Record<string, unknown>,
      (env) => delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    );
  }

  private async withProbe<T>(
    use: (q: Query, init: Awaited<ReturnType<Query['initializationResult']>>) => Promise<T>,
    tweakEnv?: (env: Record<string, string>) => void,
  ): Promise<T> {
    const input = new MessageQueue();
    const env = buildRuntimeEnv(this.deps.baseEnv ?? process.env, this.deps.paths, this.settings());
    tweakEnv?.(env);
    const q = (this.deps.queryFn ?? sdkQuery)({
      prompt: input,
      options: {
        cwd: this.deps.paths.dataDir,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        persistSession: false,
        env,
        stderr: (d: string) => log.warn(`agent-runtime[probe]: ${d.trim().slice(0, 500)}`),
      },
    });
    try {
      const timeout = <R>(p: Promise<R>, what: string) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(what)), this.deps.initTimeoutMs ?? 30_000))]);
      const init = await timeout(q.initializationResult(), 'The agent runtime did not start in time.');
      return await timeout(use(q, init), 'The agent runtime did not answer in time.');
    } finally {
      input.close();
      try {
        q.close();
      } catch {
        /* already closed */
      }
    }
  }

  /** The auth a session started now would use (null when none is usable). */
  async desiredAuth(): Promise<AuthKind | null> {
    if (this.settings().provider === 'ollama') return 'ollama';
    return this.pickAnthropicAuth().then(
      (r) => r.auth,
      () => null,
    );
  }

  private async preflight(model: string | null | undefined, prefer?: AnthropicAuth): Promise<{ model: string; auth: AuthKind }> {
    let auth: AuthKind;
    if (this.settings().provider === 'ollama') {
      if (!model) throw new AgentError('model', 'Choose an Ollama model in Settings first (refresh the list to see installed models).');
      const known = this.deps.store.getFlag<{ models: ModelEntry[] }>(modelsFlagKey('ollama'))?.models ?? [];
      if (!known.some((m) => m.id === model))
        throw new AgentError('model', `${model} is not an installed Ollama model. Pick one in Settings (refresh the list after \`ollama pull\`).`);
      auth = 'ollama';
    } else {
      if (!model) throw new AgentError('model', 'Choose a model in Settings first (the list comes from the Models API or your Claude plan).');
      const picked = await this.pickAnthropicAuth(prefer);
      if (picked.switchedFrom) {
        const text = `${picked.reason} Using ${AUTH_LABEL[picked.auth]} instead.`;
        this.deps.emit('auth.switched', { from: picked.switchedFrom, to: picked.auth, text });
      }
      auth = picked.auth;
    }
    const working = [...this.sessions.values()].filter((s) => !s.isClosed && (s.state === 'planning' || s.state === 'executing')).length;
    const limit = this.settings().maxRunningTasks;
    if (working >= limit)
      throw new AgentError(
        'busy',
        `${working} task${working === 1 ? ' is' : 's are'} already working (the limit is ${limit}). Wait for one to finish, stop one, or raise "Tasks working at the same time" in Settings → Spending limits.`,
      );
    // Idle sessions keep a process each; close them (they resume from their saved session when used again).
    for (const s of [...this.sessions.values()]) if (!s.active) await s.shutdown();
    return { model, auth };
  }

  /**
   * After one Anthropic auth ran out mid-task, resume the same session with the other one, if fallback is
   * on and the other one is set up. Spending limits still apply to the API key.
   */
  async continueAfterExhaustion(taskId: string, from: AnthropicAuth, mode: AgentMode): Promise<void> {
    const to = otherAuth(from);
    const say = (level: 'info' | 'warn' | 'error', text: string) => this.deps.emit('agent.notice', { taskId, level, text });
    if (!this.settings().authFallback) {
      say('info', `Turn on "Switch when one runs out" or switch to ${AUTH_LABEL[to]} in the prompt bar, then send a message to continue.`);
      return;
    }
    const problem = await this.authProblem(to);
    if (problem) {
      say('warn', `Could not switch to ${AUTH_LABEL[to]}: ${problem.message}`);
      return;
    }
    say('warn', `Continuing with ${AUTH_LABEL[to]}.`);
    this.deps.emit('auth.switched', {
      taskId,
      from,
      to,
      text: `${from === 'subscription' ? 'Claude plan limit reached' : 'API credit ran out'}. Continuing with ${AUTH_LABEL[to]}.`,
    });
    this.deps.store.addEvent(taskId, 'auth.switched', { from, to });
    try {
      await this.resumeTask(taskId, CONTINUE_AFTER_SWITCH, mode, to);
    } catch (err) {
      say('error', `Could not continue with ${AUTH_LABEL[to]}: ${(err as Error).message}`);
    }
  }

  async startTask(input: StartTaskInput): Promise<TaskRow> {
    const settings = this.settings();
    const { model, auth } = await this.preflight(input.model ?? settings.model);
    const policy = new PathPolicy(input.projectRoot);
    const prompt = input.prompt.trim();
    if (!prompt) throw new AgentError('prompt', 'Describe the task first.');
    if (prompt.length > 50_000) throw new AgentError('prompt', 'The task description is too long.');
    this.checkUploads(input.imageIds?.length ?? 0, input.imageIds ?? []);
    const mode: AgentMode = input.mode ?? (input.planFirst === undefined ? settings.agentMode : input.planFirst ? 'plan' : 'ask');
    const planFirst = mode === 'plan';
    const task = this.deps.store.createTask({
      id: crypto.randomUUID(),
      project: policy.root,
      title: titleFrom(prompt),
      prompt,
      model,
      state: planFirst ? 'planning' : 'executing',
    });
    this.deps.emit('task.updated', task);
    const session = new TaskSession(task, this, settings, mode, auth);
    this.sessions.set(task.id, session);
    try {
      this.attach(task.id, input.imageIds ?? []);
      await session.start(planFirst ? `${prompt}${PLANNING_SUFFIX}` : prompt, null);
    } catch (err) {
      const row = this.deps.store.getTask(task.id)!;
      if (ACTIVE_STATES.includes(row.state)) {
        this.deps.store.updateTask(task.id, { state: 'failed', error: (err as Error).message });
        this.deps.emit('task.updated', this.deps.store.getTask(task.id));
      }
      this.sessions.delete(task.id);
      throw err;
    }
    return this.deps.store.getTask(task.id)!;
  }

  /** Continue a task whose session process ended (idle timeout, app restart, budget stop after raising limits). */
  async resumeTask(taskId: string, message: string, requested?: AgentMode, prefer?: AnthropicAuth, raw = false): Promise<TaskRow> {
    const row = this.deps.store.getTask(taskId);
    if (!row) throw new AgentError('not-found', 'Task not found');
    if (!row.session_id) throw new AgentError('no-session', 'This task has no saved session to resume.');
    const live = this.sessions.get(taskId);
    if (live && !live.isClosed) {
      live.send(message, requested);
      return this.deps.store.getTask(taskId)!;
    }
    const settings = this.settings();
    const { auth } = await this.preflight(row.model, prefer);
    const pendingPlan = row.state === 'awaiting-plan-approval';
    const carried = this.carriedModes.get(taskId);
    this.carriedModes.delete(taskId);
    const mode: AgentMode = requested ?? carried ?? (pendingPlan ? 'plan' : 'ask');
    const state: TaskState = mode === 'plan' ? 'planning' : 'executing';
    const first = raw
      ? message
      : mode === 'plan'
        ? `${message}${PLANNING_SUFFIX}`
        : pendingPlan
          ? `${planApproved(mode, settings.fullAccess)}\n\n${message}`
          : message;
    const updated = this.deps.store.updateTask(taskId, { state: raw ? 'executing' : state, error: null });
    this.deps.emit('task.updated', updated);
    const session = new TaskSession(updated, this, settings, mode, auth);
    this.sessions.set(taskId, session);
    try {
      await session.start(first, row.session_id);
    } catch (err) {
      this.sessions.delete(taskId);
      const after = this.deps.store.getTask(taskId)!;
      if (ACTIVE_STATES.includes(after.state)) {
        this.deps.store.updateTask(taskId, { state: 'failed', error: (err as Error).message });
        this.deps.emit('task.updated', this.deps.store.getTask(taskId));
      }
      throw err;
    }
    return this.deps.store.getTask(taskId)!;
  }

  /**
   * Send to a task. A live session whose auth no longer matches the switch (Claude plan / API key) is
   * closed first and resumed with the new one; the conversation carries over.
   */
  async send(taskId: string, text: string, mode?: AgentMode): Promise<TaskRow> {
    const live = this.sessions.get(taskId);
    if (live && !live.isClosed && (live.state === 'planning' || live.state === 'executing')) {
      // The agent is working: hold the message until the turn ends.
      this.enqueue(taskId, text, mode ?? null);
      return this.deps.store.getTask(taskId)!;
    }
    if (live && !live.isClosed) {
      const want = live.auth === 'ollama' ? 'ollama' : await this.desiredAuth();
      if (want === live.auth || want === null || want === 'ollama' || live.active) {
        live.send(text, mode);
        return this.deps.store.getTask(taskId)!;
      }
      const keep = live.currentMode;
      await live.shutdown();
      return this.resumeTask(taskId, text, mode ?? keep);
    }
    return this.resumeTask(taskId, text, mode);
  }

  // ---- message queue ------------------------------------------------------------------------
  queue(taskId: string): QueuedMessage[] {
    return this.queues.get(taskId) ?? [];
  }

  enqueue(taskId: string, text: string, mode: AgentMode | null, front = false): QueuedMessage {
    const q = this.queue(taskId);
    if (q.length >= MAX_QUEUE) throw new AgentError('queue-full', `At most ${MAX_QUEUE} messages can wait in the queue.`);
    const item: QueuedMessage = { id: crypto.randomUUID(), text, mode, createdAt: Date.now() };
    this.queues.set(taskId, front ? [item, ...q] : [...q, item]);
    this.queueChanged(taskId);
    return item;
  }

  editQueued(taskId: string, id: string, text: string): void {
    const q = this.queue(taskId);
    const item = q.find((i) => i.id === id);
    if (!item) throw new AgentError('not-found', 'That message already left the queue.');
    item.text = text;
    this.queueChanged(taskId);
  }

  removeQueued(taskId: string, id?: string): void {
    this.queues.set(taskId, id ? this.queue(taskId).filter((i) => i.id !== id) : []);
    this.queueChanged(taskId);
  }

  /** Send one queued message right away: the running turn is interrupted, then that message goes next. */
  async sendQueuedNow(taskId: string, id: string): Promise<void> {
    const q = this.queue(taskId);
    const item = q.find((i) => i.id === id);
    if (!item) throw new AgentError('not-found', 'That message already left the queue.');
    this.queues.set(taskId, [item, ...q.filter((i) => i !== item)]);
    this.queueChanged(taskId);
    const live = this.sessions.get(taskId);
    if (live && !live.isClosed && (live.state === 'executing' || live.state === 'planning')) await live.yieldToQueue();
    else await this.flushQueue(taskId, true);
  }

  /** Called when a turn ends with the agent waiting for the user. */
  turnFinished(taskId: string): void {
    void this.flushQueue(taskId);
  }

  /**
   * Send what is queued: everything as one message (one request, the default) or just the next one.
   * `onlyFirst` sends a single message regardless (used by "send now").
   */
  async flushQueue(taskId: string, onlyFirst = false): Promise<void> {
    const q = this.queue(taskId);
    if (!q.length) return;
    const together = this.settings().sendQueuedTogether && !onlyFirst;
    const batch = together ? q : q.slice(0, 1);
    this.queues.set(taskId, q.slice(batch.length));
    this.queueChanged(taskId);
    const text = batch.map((i) => i.text).join('\n\n');
    const mode = batch[batch.length - 1]!.mode ?? undefined;
    try {
      await this.send(taskId, text, mode);
    } catch (err) {
      // Put them back and say why; the user can retry from the queue.
      this.queues.set(taskId, [...batch, ...this.queue(taskId)]);
      this.queueChanged(taskId);
      this.deps.emit('agent.notice', { taskId, level: 'error', text: `Queued message not sent: ${(err as Error).message}` });
    }
  }

  private queueChanged(taskId: string): void {
    this.deps.emit('queue.updated', { taskId, items: this.queue(taskId) });
  }

  /** Compact a task's conversation; a closed session is resumed to do it. */
  async compact(taskId: string): Promise<void> {
    const live = this.sessions.get(taskId);
    if (live && !live.isClosed) return live.compact();
    const row = this.deps.store.getTask(taskId);
    if (row?.state === 'awaiting-plan-approval') throw new AgentError('state', 'Approve or revise the plan before compacting.');
    await this.resumeTask(taskId, '/compact', undefined, undefined, true);
  }

  /** Effort and fast mode apply to running sessions immediately. */
  async applyLiveSettings(settings: Settings): Promise<void> {
    for (const s of this.sessions.values()) await s.applyLiveSettings(settings).catch((err: Error) => log.warn(`live settings: ${err.message}`));
  }

  contextOf(taskId: string): ContextInfo | null {
    return this.sessions.get(taskId)?.context ?? null;
  }

  get(taskId: string): TaskSession {
    const s = this.sessions.get(taskId);
    if (!s || s.isClosed) throw new AgentError('not-live', 'This task is not running. Resume it to continue.');
    return s;
  }

  setMode(taskId: string, mode: AgentMode): void {
    const s = this.sessions.get(taskId);
    if (s && !s.isClosed) s.setMode(mode);
  }

  /** Live sessions switch immediately; a closed one picks the model up when it is resumed. */
  async setModel(taskId: string, model: string): Promise<TaskRow> {
    const row = this.deps.store.getTask(taskId);
    if (!row) throw new AgentError('not-found', 'Task not found');
    const s = this.sessions.get(taskId);
    if (s && !s.isClosed) await s.setModel(model);
    else this.deps.store.updateTask(taskId, { model });
    const updated = this.deps.store.getTask(taskId)!;
    this.deps.emit('task.updated', updated);
    return updated;
  }

  modeOf(taskId: string): AgentMode | null {
    const s = this.sessions.get(taskId);
    return s && !s.isClosed ? s.currentMode : null;
  }

  isLive(taskId: string): boolean {
    const s = this.sessions.get(taskId);
    return !!s && !s.isClosed;
  }

  async finishTask(taskId: string): Promise<TaskRow> {
    const s = this.sessions.get(taskId);
    if (s && s.active) throw new AgentError('busy', 'The task is still running. Stop it first.');
    if (s) await s.shutdown();
    const row = this.deps.store.updateTask(taskId, { state: 'completed' });
    this.deps.emit('task.updated', row);
    return row;
  }

  async cancel(taskId: string): Promise<void> {
    const s = this.sessions.get(taskId);
    if (s) await s.cancel();
  }

  async shutdownAll(): Promise<void> {
    for (const s of [...this.sessions.values()]) await s.cancel('VOID Workshop closed');
  }

  sessionClosed(s: TaskSession): void {
    if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
  }

  requestApproval(req: Omit<ApprovalRequest, 'id' | 'createdAt'>, signal: AbortSignal): Promise<ApprovalDecision> {
    const full: ApprovalRequest = redactValue({ ...req, id: crypto.randomUUID(), createdAt: Date.now() });
    return new Promise<ApprovalDecision>((resolve) => {
      const finish = (d: ApprovalDecision) => {
        if (!this.approvals.has(full.id)) return;
        this.approvals.delete(full.id);
        this.deps.store.addEvent(full.taskId, 'approval.resolved', { id: full.id, kind: full.kind, summary: full.summary, decision: d.decision, note: d.note });
        this.deps.emit('approval.resolved', { id: full.id, taskId: full.taskId, decision: d.decision });
        resolve(d);
      };
      this.approvals.set(full.id, { req: full, resolve: finish });
      signal.addEventListener('abort', () => finish({ decision: 'deny', note: 'aborted' }), { once: true });
      this.deps.store.addEvent(full.taskId, 'approval.requested', {
        id: full.id,
        kind: full.kind,
        summary: full.summary,
        command: full.command,
        rel: full.rel,
      });
      this.deps.emit('approval.request', full);
    });
  }

  respondApproval(id: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(id);
    if (!pending) throw new AgentError('not-found', 'That approval request is no longer pending.');
    const { taskId } = pending.req;
    const s = this.sessions.get(taskId);
    const allowAll = decision.decision === 'allow' && decision.allowAll && pending.req.canAllowAll && s && !s.isClosed && s.currentMode !== 'plan';
    if (allowAll) s.setMode('auto');
    pending.resolve(decision);
    if (!allowAll) return;
    // Whatever else this task is waiting on that Auto would have run goes too; risky requests keep asking.
    let more = 0;
    for (const a of [...this.approvals.values()]) {
      if (a.req.taskId === taskId && a.req.coveredByAuto) {
        a.resolve({ decision: 'allow' });
        more++;
      }
    }
    this.deps.store.addEvent(taskId, 'approval.allowAll', { more });
    this.deps.emit('agent.notice', {
      taskId,
      text: `Allow all: switched to Auto${more ? ` and allowed ${more} more waiting request${more === 1 ? '' : 's'}` : ''}. Risky commands, publishing and blocked commands still ask or stay blocked.`,
    });
  }

  pendingApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].map((a) => a.req);
  }

  denyApprovalsFor(taskId: string, note: string): void {
    for (const a of [...this.approvals.values()]) if (a.req.taskId === taskId) a.resolve({ decision: 'deny', note });
  }

  markTested(taskId: string): void {
    for (const fc of this.deps.store.fileChanges(taskId)) {
      if (fc.status === 'applied') this.deps.store.setFileChangeStatus(taskId, fc.path, 'tested');
    }
    this.deps.emit('review.updated', { taskId });
  }
}
