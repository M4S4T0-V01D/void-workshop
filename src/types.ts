// Shapes returned by the sidecar (see sidecar/src). Kept narrow: only what the UI reads.

export type TaskState =
  | 'planning'
  | 'awaiting-plan-approval'
  | 'executing'
  | 'idle'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'stopped-budget'
  | 'stopped-billing'
  | 'stopped-limit'
  | 'interrupted';

export interface Task {
  id: string;
  project: string;
  title: string;
  prompt: string;
  model: string;
  state: TaskState;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  summary: string | null;
  error: string | null;
  checkpoint: string | null;
  cost_basis: string | null;
}

export interface ThemeColors {
  bg: string;
  panel: string;
  panelAlt: string;
  border: string;
  text: string;
  textDim: string;
  accent: string;
  accent2: string;
  success: string;
  warning: string;
  danger: string;
}

export interface Theme {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  colors: ThemeColors;
  /** Code editor token colours set by hand or randomised; missing ones are derived from `colors`. */
  syntax?: Partial<SyntaxColors>;
}

export interface SyntaxColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  tag: string;
  attribute: string;
  property: string;
  operator: string;
  meta: string;
}

export type UiElement =
  | 'topbar'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom'
  | 'statusbar'
  | 'panelHeader'
  | 'tabs'
  | 'userMessage'
  | 'assistantMessage'
  | 'composer'
  | 'buttons'
  | 'primaryButtons'
  | 'inputs'
  | 'planCard'
  | 'fileTree'
  | 'codeEditor';

export interface ElementStyle {
  bg?: string;
  text?: string;
  border?: string;
  borderWidth?: number;
  zoom?: number;
  bold?: boolean;
  padding?: number;
  radius?: number;
}

export interface Layout {
  leftW: number;
  rightW: number;
  bottomH: number;
  leftSplit: number;
  showLeft: boolean;
  showRight: boolean;
  showBottom: boolean;
  bottomCollapsed: boolean;
  swapSides: boolean;
}

export interface Ui {
  scale: number;
  density: 'compact' | 'comfortable' | 'spacious';
  radius: number;
  fontSans: string;
  fontMono: string;
  layout: Layout;
  elements: Partial<Record<UiElement, ElementStyle>>;
  customCss: string;
}

export interface SavedLayout {
  id: string;
  name: string;
  ui: Ui;
  themeId: string | null;
}

export type AgentMode = 'ask' | 'auto-edit' | 'auto' | 'plan';

export type Provider = 'anthropic' | 'ollama';

/** How Anthropic requests are paid for: the Console API key or the signed-in Claude plan. */
export type AnthropicAuth = 'api-key' | 'subscription';

export interface SubscriptionStatus {
  signedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
  checkedAt: number;
  problem: string | null;
}

/** Claude plan usage meters, as Claude Code's usage bar shows them (see sidecar/src/planUsage.ts). */
export interface PlanUsageRow {
  kind: string;
  group: string;
  label: string;
  percent: number;
  resetsAt: number | null;
  severity: string;
  active: boolean;
}

export interface PlanUsage {
  checkedAt: number;
  subscriptionType: string | null;
  rows: PlanUsageRow[];
  extra: { enabled: boolean; used: number | null; limit: number | null; currency: string; percent: number | null; reason: string | null } | null;
  problem: string | null;
}

export interface OllamaStatus {
  reachable: boolean;
  models: Array<{ name: string; sizeBytes: number; vramBytes: number; contextLength: number | null; expiresAt: string | null }>;
  totalBytes: number;
  vramBytes: number;
  system: { totalBytes: number; availableBytes: number };
  checkedAt: number;
}

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
}

export interface Settings {
  provider: Provider;
  anthropicAuth: AnthropicAuth;
  authFallback: boolean;
  ollamaUrl: string;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  perTaskBudgetUsd: number;
  dailyBudgetUsd: number;
  maxTurns: number;
  maxRunningTasks: number;
  maxOutputTokens: number;
  confirmTaskBudgetAboveUsd: number | null;
  agentMode: AgentMode;
  sandboxCommands: boolean;
  allowPublishCommands: boolean;
  gradleBuilds: boolean;
  fullAccess: boolean;
  autoPublish: boolean;
  commandTimeoutSec: number;
  commandOutputLimitKb: number;
  themeId: string;
  customThemes: Theme[];
  ui: Ui;
  layouts: SavedLayout[];
  editor: EditorSettings;
  checkpointBeforeTasks: boolean;
  contextCapTokens: number | null;
  tokenSaver: boolean;
  implementModel: string | null;
  promptCacheTtl: 'auto' | '5m' | '1h';
  fastMode: boolean;
  sendQueuedTogether: boolean;
  runInBackground: boolean;
  startAtLogin: boolean;
}

export interface PortalDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** This PC is connected to the relay for that phone. */
  connected: boolean;
  /** The phone is connected right now. */
  phoneOnline: boolean;
}

export interface PortalStatus {
  relayUrl: string;
  devices: PortalDevice[];
}

export type Effort = NonNullable<Settings['effort']>;

/** A message typed while the agent was working; it goes out when the turn ends. */
export interface QueuedMessage {
  id: string;
  text: string;
  mode: AgentMode | null;
  createdAt: number;
}

/** How full the conversation's context is (tokens now / tokens before it compacts). */
export interface ContextInfo {
  tokens: number;
  max: number;
}

export interface KeyStatus {
  configured: boolean;
  backend: 'secret-service' | 'file' | null;
  fingerprint: string | null;
  formatOk: boolean;
  secretServiceAvailable: boolean;
  problem: string | null;
}

export interface ModelEntry {
  id: string;
  displayName: string;
  createdAt: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

export interface VerifyResult {
  ok: boolean;
  kind?: string;
  message?: string;
  models?: ModelEntry[];
  checkedAt: number;
}

export interface GitFile {
  path: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  dirty: boolean;
}

export interface SuggestedCommand {
  label: string;
  argv: string[];
  reason: string;
}

export interface ProjectPermissions {
  extraPaths: string[];
  networkDomains: string[];
  alwaysAllowCommands?: string[];
}

export interface Project {
  root: string;
  name: string;
  permissions: ProjectPermissions;
  git: GitStatus;
  commands: SuggestedCommand[];
}

export interface RecentProject {
  path: string;
  name: string;
  last_opened: number;
}

export interface DirEntry {
  name: string;
  rel: string;
  kind: 'dir' | 'file' | 'symlink' | 'other';
  sensitive: string | null;
  artifact: boolean;
  outside: boolean;
}

export interface FileView {
  rel: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
  sensitive: string | null;
  hash: string | null;
}

export interface SaveResult {
  rel: string;
  hash: string;
  size: number;
}

export interface CommandAssessment {
  command: string;
  blocked: boolean;
  blockReasons: string[];
  categories: string[];
  warnings: string[];
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
  canAlwaysAllow?: boolean;
  canAllowAll?: boolean;
  coveredByAuto?: boolean;
}

export interface PlanItem {
  ref: string;
  id: string | null;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
}

export type FileChangeStatus = 'proposed' | 'applied' | 'accepted' | 'rejected' | 'tested' | 'committed' | 'conflict';

export interface ReviewEntry {
  rel: string;
  status: FileChangeStatus;
  existed: boolean;
  externallyModified: boolean;
  diff: string | null;
  updatedAt: number;
}

export interface TaskEvent {
  id: number;
  ts: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface InitData {
  version: string;
  settings: Settings;
  auth: KeyStatus;
  subscription: SubscriptionStatus | null;
  planLimited: { until: number; message: string } | null;
  planUsage: PlanUsage | null;
  models: { models: ModelEntry[]; checkedAt: number } | null;
  lastVerify: { ok: boolean; kind?: string; message?: string; checkedAt: number; modelCount?: number } | null;
  billingBlocked: { at: number; message: string } | null;
  spentTodayUsd: number;
  today: string;
  recentProjects: RecentProject[];
  pendingApprovals: ApprovalRequest[];
  sandbox: { available: boolean; missing: string[] };
  dataDir: string;
  admin: AdminStatus;
  /** The last update install, until the window has shown it (app.update.dismiss). */
  lastUpdate: { version: string; from: string; ok: boolean; at: number; logFile: string } | null;
}

export interface UpdateRelease {
  version: string;
  sha256: string;
  size: number;
  notes: string;
  date: string;
}

export type UpdateCheck =
  | { status: 'unavailable'; current: string; reason: string }
  | { status: 'current'; current: string; latest: string }
  | { status: 'available'; current: string; release: UpdateRelease };

/** Admin dev session: the agent may work on VOID Workshop and VOID Portal themselves (sidecar/src/admin.ts). */
export interface AdminStatus {
  passwordSet: boolean;
  active: boolean;
  since: number | null;
  by: 'desktop' | 'phone' | null;
  device: string | null;
  lockedUntil: number | null;
  sourceDir: string | null;
}

export interface PreparedCommand {
  approvalToken: string;
  argv: string[];
  display: string;
  cwd: string;
  reason: string;
  assessment: CommandAssessment;
}

export interface RpcError {
  code: string;
  message: string;
}
