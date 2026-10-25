import { z } from 'zod';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * How much the agent may do without asking. Enforced by VOID Workshop's own approval gate, so the
 * command blocklist, sandbox, path policy and budgets apply in every mode.
 *   ask       - every file change and command needs approval
 *   auto-edit - file changes apply without asking; commands still need approval
 *   auto      - file changes and sandboxed commands run without asking
 *   plan      - read-only exploration, then a plan to approve
 */
export const AGENT_MODES = ['ask', 'auto-edit', 'auto', 'plan'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/**
 * Where model requests go.
 *   anthropic - the Anthropic API with the user's Console key (via the key helper)
 *   ollama    - a local Ollama server's Anthropic-compatible endpoint; no key leaves this machine
 */
export const PROVIDERS = ['anthropic', 'ollama'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * How Anthropic requests are paid for (provider `anthropic` only).
 *   api-key      - the Console API key, billed per token and capped by the USD budgets
 *   subscription - the Claude plan the user signed in with (Settings → Sign-in), within the plan's usage limits
 */
export const ANTHROPIC_AUTHS = ['api-key', 'subscription'] as const;
export type AnthropicAuth = (typeof ANTHROPIC_AUTHS)[number];

export const otherAuth = (a: AnthropicAuth): AnthropicAuth => (a === 'api-key' ? 'subscription' : 'api-key');

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/** Ollama must be on this machine: plain http to a loopback host, optional port, no path. */
export const OLLAMA_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/?$/;

export function normalizeOllamaUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Prompt cache lifetime: the runtime's default (1 hour on a Claude plan, 5 minutes on an API key) or a fixed one. */
export const CACHE_TTLS = ['auto', '5m', '1h'] as const;

/** Upper bound for the per-task turn limit. Anthropic spend is still capped by the USD budgets. */
export const MAX_TURNS_LIMIT = 1000;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const ThemeSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(60),
  mode: z.enum(['dark', 'light']),
  colors: z.object({
    bg: color,
    panel: color,
    panelAlt: color,
    border: color,
    text: color,
    textDim: color,
    accent: color,
    accent2: color,
    success: color,
    warning: color,
    danger: color,
  }),
  /** Code editor token colours; missing ones are derived from `colors` by the window. */
  syntax: z
    .object({
      keyword: color,
      string: color,
      number: color,
      comment: color,
      function: color,
      type: color,
      tag: color,
      attribute: color,
      property: color,
      operator: color,
      meta: color,
    })
    .partial()
    .optional(),
});
export type Theme = z.infer<typeof ThemeSchema>;

/** Parts of the window the visual editor can restyle (the window maps each to its CSS selector). */
export const UI_ELEMENTS = [
  'topbar',
  'left',
  'center',
  'right',
  'bottom',
  'statusbar',
  'panelHeader',
  'tabs',
  'userMessage',
  'assistantMessage',
  'composer',
  'buttons',
  'primaryButtons',
  'inputs',
  'planCard',
  'fileTree',
  'codeEditor',
] as const;

export const ElementStyleSchema = z.object({
  bg: color.optional(),
  text: color.optional(),
  border: color.optional(),
  borderWidth: z.number().min(0).max(6).optional(),
  /** Size of the element and everything in it (1 = normal). */
  zoom: z.number().min(0.6).max(2).optional(),
  bold: z.boolean().optional(),
  padding: z.number().min(0).max(48).optional(),
  radius: z.number().min(0).max(32).optional(),
});
export type ElementStyle = z.infer<typeof ElementStyleSchema>;

/** Font family names only (they go into a CSS variable): letters, digits, spaces, quotes, commas, dashes. */
const fontFamily = z
  .string()
  .max(120)
  .regex(/^[\w .,'"-]*$/, 'Font names may only use letters, digits, spaces, quotes, commas and dashes.');

export const LayoutSchema = z.object({
  leftW: z.number().int().min(160).max(800).default(270),
  rightW: z.number().int().min(200).max(900).default(360),
  bottomH: z.number().int().min(80).max(800).default(230),
  /** Share of the left panel taken by the file tree (the task list gets the rest), in percent. */
  leftSplit: z.number().int().min(15).max(85).default(60),
  showLeft: z.boolean().default(true),
  showRight: z.boolean().default(true),
  showBottom: z.boolean().default(true),
  bottomCollapsed: z.boolean().default(false),
  /** Files and tasks on the right, review and git on the left. */
  swapSides: z.boolean().default(false),
});
export type Layout = z.infer<typeof LayoutSchema>;

export const UiSchema = z.object({
  scale: z.number().min(0.8).max(1.5).default(1),
  density: z.enum(['compact', 'comfortable', 'spacious']).default('comfortable'),
  radius: z.number().int().min(0).max(16).default(8),
  /** Empty = the built-in font stack. */
  fontSans: fontFamily.default(''),
  fontMono: fontFamily.default(''),
  layout: LayoutSchema.default(() => LayoutSchema.parse({})),
  elements: z.partialRecord(z.enum(UI_ELEMENTS), ElementStyleSchema).default({}),
  /** The user's own stylesheet. The window's CSP keeps it from loading anything off this machine. */
  customCss: z.string().max(64_000).default(''),
});
export type Ui = z.infer<typeof UiSchema>;

/** The code editor in the window's center tabs. */
export const EditorSchema = z.object({
  fontSize: z.number().int().min(9).max(28).default(13),
  tabSize: z.number().int().min(1).max(8).default(2),
  wordWrap: z.boolean().default(false),
});
export type Editor = z.infer<typeof EditorSchema>;

/** A named snapshot of the window's look and layout, optionally with the theme it was made with. */
export const SavedLayoutSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(60),
  ui: UiSchema,
  themeId: z.string().max(40).nullable().default(null),
});
export type SavedLayout = z.infer<typeof SavedLayoutSchema>;

export const SERVICE_PANELS = ['right', 'left'] as const;

/** With the token saver on, the conversation compacts by this size (unless the cap is lower already). */
export const TOKEN_SAVER_CONTEXT = 120_000;
/** Characters of a shell command's output the agent keeps in its context (the runtime's BASH_MAX_OUTPUT_LENGTH). */
export const COMMAND_OUTPUT_CHARS = { normal: 30_000, saver: 12_000 };

export const SettingsSchema = z.object({
  provider: z.enum(PROVIDERS),
  anthropicAuth: z.enum(ANTHROPIC_AUTHS),
  /** When the chosen Anthropic auth runs out (plan limit or no credit), continue with the other one if it is set up. */
  authFallback: z.boolean(),
  /** Base URL of the local Ollama server (loopback only). */
  ollamaUrl: z.string().max(100).regex(OLLAMA_URL_RE, 'Ollama must run on this machine (http://127.0.0.1:PORT or http://localhost:PORT).'),
  /** Model id chosen by the user from the provider's model list. null until chosen. */
  model: z.string().max(120).nullable(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  perTaskBudgetUsd: z.number().min(0.01).max(100),
  dailyBudgetUsd: z.number().min(0.01).max(500),
  maxTurns: z.number().int().min(1).max(MAX_TURNS_LIMIT),
  /** How many tasks may work at the same time (each is its own agent process). */
  maxRunningTasks: z.number().int().min(1).max(8),
  maxOutputTokens: z.number().int().min(1024).max(128000),
  /** Ask before starting a task whose budget cap is at or above this value. null disables. */
  confirmTaskBudgetAboveUsd: z.number().min(0).max(100).nullable(),
  /** Mode for new sessions; the composer remembers the last one used. */
  agentMode: z.enum(AGENT_MODES),
  /** Run agent shell commands inside the bubblewrap sandbox (project-only writes, no network by default). */
  sandboxCommands: z.boolean(),
  /** gh, git push, wrangler and release.sh become approvable instead of blocked; they always ask and run outside the sandbox. */
  allowPublishCommands: z.boolean(),
  /** Sandboxed commands may write the Gradle/Android/Maven caches in ~ and reach the Gradle, Maven and Google repositories. */
  gradleBuilds: z.boolean(),
  /**
   * Full access, like Claude Code: no sandbox, file tools reach outside the project (writes there ask),
   * WebSearch/WebFetch and background commands on. In Auto, routine commands just run and risky ones ask;
   * secrets, credential stores and disk tools stay blocked. Overrides sandboxCommands and allowPublishCommands.
   */
  fullAccess: z.boolean(),
  /** With full access in Auto, pushes and releases (gh, git push, wrangler, release scripts) run without asking too. */
  autoPublish: z.boolean(),
  commandTimeoutSec: z.number().int().min(5).max(3600),
  commandOutputLimitKb: z.number().int().min(16).max(4096),
  themeId: z.string().max(40),
  customThemes: z.array(ThemeSchema).max(20),
  /** Layout, text and per-element styles from the visual editor (desktop only; the phone can't change it). */
  ui: UiSchema,
  layouts: z.array(SavedLayoutSchema).max(20),
  editor: EditorSchema,
  checkpointBeforeTasks: z.boolean(),
  /**
   * Spend less of the plan or API budget: compact by TOKEN_SAVER_CONTEXT tokens, keep less command output in the
   * context and ask the agent for quiet commands and small screenshots. Every step re-sends the whole context.
   */
  tokenSaver: z.boolean(),
  /** After a plan is approved, implement it with this model (e.g. plan with Opus, build with Sonnet). null = keep the model. */
  implementModel: z.string().max(120).nullable(),
  /** Compact the conversation before its context grows past this many tokens. null = the model's own window. */
  contextCapTokens: z.number().int().min(100_000).max(1_000_000).nullable(),
  promptCacheTtl: z.enum(CACHE_TTLS),
  /** Anthropic fast mode: faster output at a higher price (uses extra usage on a Claude plan). */
  fastMode: z.boolean(),
  /** Messages queued while the agent works go out as one message when the turn ends (one request instead of several). */
  sendQueuedTogether: z.boolean(),
  /** Closing the window hides it to the tray, so VOID Portal on the phone keeps working. */
  runInBackground: z.boolean(),
  /** Start hidden in the tray at login (writes an XDG autostart entry). */
  startAtLogin: z.boolean(),
  /** Client ID of the user's GitHub OAuth App (device flow enabled) for "Sign in with GitHub". Not a secret. */
  githubClientId: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9._-]*$/, 'A GitHub client ID has only letters, digits, dots, dashes and underscores.'),
  /** Which side panel holds the GitHub and Cloudflare tabs. */
  servicesPanel: z.enum(SERVICE_PANELS),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  anthropicAuth: 'api-key',
  authFallback: true,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  model: null,
  effort: null,
  perTaskBudgetUsd: 1,
  dailyBudgetUsd: 3,
  maxTurns: 50,
  maxRunningTasks: 4,
  maxOutputTokens: 16000,
  confirmTaskBudgetAboveUsd: 2,
  agentMode: 'ask',
  sandboxCommands: true,
  allowPublishCommands: false,
  gradleBuilds: false,
  fullAccess: false,
  autoPublish: true,
  commandTimeoutSec: 600,
  commandOutputLimitKb: 512,
  themeId: 'void',
  customThemes: [],
  ui: UiSchema.parse({}),
  layouts: [],
  editor: EditorSchema.parse({}),
  checkpointBeforeTasks: true,
  contextCapTokens: 200_000,
  tokenSaver: true,
  implementModel: null,
  promptCacheTtl: 'auto',
  fastMode: false,
  sendQueuedTogether: true,
  runInBackground: false,
  startAtLogin: false,
  githubClientId: '',
  servicesPanel: 'right',
};

export const SettingsPatchSchema = SettingsSchema.partial();

/** The stored fields that are still valid; one bad value (say, from an older version) only resets itself. */
function validStored(stored: unknown): Partial<Settings> {
  if (!stored || typeof stored !== 'object') return {};
  const shape = SettingsSchema.shape as Record<string, z.ZodType>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) {
    const r = Object.hasOwn(shape, k) ? shape[k]!.safeParse(v) : null;
    if (r?.success) out[k] = r.data;
  }
  return out as Partial<Settings>;
}

export function mergeSettings(stored: unknown, patch?: unknown): Settings {
  const base = { ...DEFAULT_SETTINGS, ...validStored(stored) };
  // Settings saved before modes existed had a planFirst checkbox.
  const legacy = stored as { planFirst?: unknown; agentMode?: unknown } | null;
  if (legacy && typeof legacy.planFirst === 'boolean' && legacy.agentMode === undefined) base.agentMode = legacy.planFirst ? 'plan' : 'ask';
  if (patch === undefined) return SettingsSchema.parse(base);
  return SettingsSchema.parse({ ...base, ...SettingsPatchSchema.parse(patch) });
}

export const MAX_ALWAYS_ALLOW = 100;

export const ProjectPermissionsSchema = z.object({
  /** Extra directories (absolute) the agent may access, approved explicitly by the user. */
  extraPaths: z.array(z.string().max(4096)).max(10),
  /** Domains sandboxed commands may reach (e.g. registry.npmjs.org). Empty = no network. */
  networkDomains: z
    .array(
      z
        .string()
        .regex(/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/i)
        .max(253),
    )
    .max(30),
  /** Exact commands the user chose to always allow in this project: they run without asking (policy blocks still apply). */
  alwaysAllowCommands: z.array(z.string().min(1).max(2000)).max(MAX_ALWAYS_ALLOW).default([]),
});
export type ProjectPermissions = z.infer<typeof ProjectPermissionsSchema>;
