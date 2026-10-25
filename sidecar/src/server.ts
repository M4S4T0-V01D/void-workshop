import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppPaths } from './config.js';
import { APP_VERSION } from './config.js';
import { Store } from './db.js';
import { KeyFormatError, KeyStore } from './keystore.js';
import { listOllamaModels, modelsFlagKey, ollamaStatus, verifyKeyAndListModels, type ModelEntry } from './auth.js';
import { AgentError, AgentManager, buildRuntimeEnv, MAX_ATTACHMENTS, type QueryFn, type RestartRequest } from './agent.js';
import { MAX_UPLOAD_BYTES, UPLOADS } from './images.js';
import { AdminError, AdminStore, MAX_PASSWORD, findWorkshopSource, type AdminStatus } from './admin.js';
import { ClaudeLogin, PLAN_LIMIT_FLAG, SUBSCRIPTION_FLAG, SUBSCRIPTION_MODELS_FLAG, subscriptionModels, type SubscriptionStatus } from './subscription.js';
import { PathPolicy, canonicalProjectRoot } from './paths.js';
import { listDir, readFileForView, PreimageStore, unifiedDiff, fileHash, writeFileFromEditor, SaveConflictError } from './files.js';
import { commitPaths, createCheckpoint, gitDiffFile, gitStatus } from './git.js';
import { CommandRunner, commandEnv, detectCommands } from './runner.js';
import { assessCommand, splitArgv, type CommandAssessment } from './commandPolicy.js';
import { AGENT_MODES, PROVIDERS, ProjectPermissionsSchema, SettingsPatchSchema, normalizeOllamaUrl, type Provider } from './settings.js';
import { redactValue, clip } from './redact.js';
import { REMOTE_SETTINGS, RemoteBridge, type RemoteHost, type SocketFactory } from './remote.js';
import { ACTIVE_STATES } from './db.js';
import { syncAutostart } from './autostart.js';
import { log } from './log.js';
import { exportName, taskMarkdown } from './export.js';
import { dayKey } from './budget.js';
import { PLAN_USAGE_FLAG, PlanUsageWatcher, type PlanUsage } from './planUsage.js';
import { Updater } from './updater.js';
import { UPDATE_PUBLIC_KEY } from './updateKey.js';
import { GithubService, ServiceError } from './github.js';
import { CloudflareService } from './cloudflare.js';

const UPDATE_PENDING_FLAG = 'update.pending';
const UPDATE_RESULT_FLAG = 'update.last';

export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Largest piece of an image the window reads at once. */
const MAX_WINDOW_CHUNK = 4 * 1024 * 1024;

const Root = z.object({ root: z.string().min(1).max(4096) });
const TaskId = z.object({ taskId: z.string().uuid() });
const Mode = z.enum(AGENT_MODES);
const ImageIds = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
  .max(MAX_ATTACHMENTS)
  .optional();
const Origin = z.enum(['desktop', 'phone']).default('desktop');
const Password = z.string().min(1).max(MAX_PASSWORD);
const CfAccount = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/) });
/** A restart's task is continued only this soon after it was asked for. */
const RESUME_WITHIN_MS = 30 * 60_000;

interface PreparedRun {
  root: string;
  argv: string[];
  reason: string;
  assessment: CommandAssessment;
  expires: number;
  taskId: string | null;
}

/**
 * All operations the desktop shell may invoke. Each handler validates its params with zod;
 * the Rust shell additionally allow-lists method names before forwarding.
 */
export class Server implements RemoteHost {
  readonly store: Store;
  readonly keys: KeyStore;
  readonly agents: AgentManager;
  private readonly planUsage: PlanUsageWatcher;
  readonly runner = new CommandRunner();
  private readonly prepared = new Map<string, PreparedRun>();
  private readonly preimages: PreimageStore;
  readonly login: ClaudeLogin;
  readonly remote: RemoteBridge;
  readonly admin: AdminStore;
  readonly updater: Updater;
  readonly github: GithubService;
  readonly cloudflare: CloudflareService;
  private updating = false;
  private sourceCache: { dir: string | null; at: number } | null = null;
  /** Every event goes to the window and to paired phones. */
  readonly emit: (event: string, payload: unknown) => void;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly paths: AppPaths,
    emitToWindow: (event: string, payload: unknown) => void,
    opts: {
      queryFn?: QueryFn;
      baseEnv?: NodeJS.ProcessEnv;
      dbFile?: string;
      initTimeoutMs?: number;
      claudeBin?: string;
      remoteSocket?: SocketFactory;
      /** Where task.saveImage puts copies; ~/Downloads by default. */
      downloadsDir?: string;
      /** Tests pin their own update key and server. */
      updateKey?: string | null;
      updateFetch?: typeof fetch;
      /** Tests answer GitHub and Cloudflare calls themselves. */
      serviceFetch?: typeof fetch;
    } = {},
  ) {
    this.downloadsDir = opts.downloadsDir ?? path.join(os.homedir(), 'Downloads');
    this.emit = (event, payload) => {
      emitToWindow(event, payload);
      this.remote?.onEvent(event, payload);
      // A turn paid by the Claude plan moved the meters: look again shortly.
      if (event === 'usage.updated' && (payload as { costBasis?: string } | null)?.costBasis === 'subscription') this.planUsage?.noteActivity();
    };
    const emit = this.emit;
    this.env = opts.baseEnv ?? process.env;
    this.store = new Store(opts.dbFile ?? paths.dbPath);
    const interrupted = this.store.markInterruptedTasks();
    if (interrupted) log.info(`marked ${interrupted} task(s) as interrupted after restart`);
    this.keys = new KeyStore(paths.keyFile);
    const credentials = path.dirname(paths.keyFile);
    this.github = new GithubService(
      path.join(credentials, 'github-token'),
      (status, error) => this.emit('github.changed', { status, error: error ?? null }),
      opts.serviceFetch,
    );
    this.cloudflare = new CloudflareService(path.join(credentials, 'cloudflare-api-token'), opts.serviceFetch);
    this.preimages = new PreimageStore(paths.preimageDir, this.store);
    this.admin = new AdminStore(path.join(paths.configDir, 'credentials', 'admin.json'), () => this.workshopSource());
    this.agents = new AgentManager({
      store: this.store,
      paths,
      keys: this.keys,
      emit,
      queryFn: opts.queryFn,
      baseEnv: opts.baseEnv,
      initTimeoutMs: opts.initTimeoutMs,
      admin: () =>
        this.admin.active
          ? {
              sourceDir: this.workshopSource(),
              dataDir: paths.dataDir,
              // Set by the desktop shell when it can install a build and start again (see src-tauri/src/restart.rs).
              canRestart: this.env.VOID_WORKSHOP_SHELL_RESTART === '1',
            }
          : null,
      restart: (r) => this.restartApp(r),
    });
    this.login = new ClaudeLogin(
      () => buildRuntimeEnv(opts.baseEnv ?? process.env, paths, this.store.getSettings()),
      opts.claudeBin ? () => opts.claudeBin! : undefined,
    );
    this.remote = new RemoteBridge(path.join(paths.configDir, 'credentials', 'remote.json'), this, opts.remoteSocket);
    this.remote.start();
    this.updater = new Updater({
      current: APP_VERSION,
      publicKey: opts.updateKey === undefined ? UPDATE_PUBLIC_KEY : opts.updateKey,
      dir: path.join(paths.dataDir, 'updates'),
      source: () => this.remote.updateSource(),
      fetch: opts.updateFetch,
    });
    this.noteUpdateResult();
    this.planUsage = new PlanUsageWatcher({
      fetch: () => this.agents.probePlanUsage(),
      signedIn: () => this.store.getSettings().provider === 'anthropic' && !!this.store.getFlag<SubscriptionStatus>(SUBSCRIPTION_FLAG)?.signedIn,
      load: () => this.store.getFlag<PlanUsage>(PLAN_USAGE_FLAG),
      save: (u) => this.store.setFlag(PLAN_USAGE_FLAG, u),
      emit: (u) => this.emit('plan.usage', u),
    });
  }

  /** Background work that only the real app does (tests drive it by hand). */
  startBackground(): void {
    this.planUsage.start();
    // After an admin restart: continue the task that asked for it, once the window has had a moment to connect.
    setTimeout(() => void this.resumeAfterRestart(), 1500);
  }

  // ---- admin dev session ------------------------------------------------------------------------
  /** The VOID Workshop source repository (looked up at most once a minute). */
  workshopSource(): string | null {
    const now = Date.now();
    if (!this.sourceCache || now - this.sourceCache.at > 60_000) {
      this.sourceCache = { dir: findWorkshopSource(this.store.recentProjects(50).map((p) => p.path)), at: now };
    }
    return this.sourceCache.dir;
  }

  private get restartFiles(): { statusFile: string; logFile: string } {
    return { statusFile: path.join(this.paths.logDir, 'admin-restart.json'), logFile: path.join(this.paths.logDir, 'admin-restart.log') };
  }

  /** Tell the window and phones, and bring the sessions in line with the new state. */
  private async adminChanged(status: AdminStatus): Promise<AdminStatus> {
    this.emit('admin.changed', status);
    await this.agents.adminChanged();
    return status;
  }

  /** The phone needs the admin password (or a running admin session) to change safety settings. */
  async confirmAdmin(password: string): Promise<void> {
    if (!this.admin.active) await this.admin.verify(password);
  }

  /** Hand the restart to the desktop shell: it waits for the app to exit, installs the build if asked, and starts it again. */
  private restartApp(r: RestartRequest): void {
    const { statusFile, logFile } = this.restartFiles;
    this.admin.setResume({ taskId: r.taskId, mode: r.mode, install: r.install, at: Date.now() });
    fs.rmSync(statusFile, { force: true });
    this.emit('admin.restarting', { taskId: r.taskId, install: r.install, reason: r.reason });
    this.emit('app.restart', { install: r.install, sourceDir: this.workshopSource(), statusFile, logFile });
  }

  private get updateFiles(): { statusFile: string; logFile: string } {
    return { statusFile: path.join(this.paths.logDir, 'update-status.json'), logFile: path.join(this.paths.logDir, 'update.log') };
  }

  /** After an update's restart: record whether the install worked (the window shows it once). */
  private noteUpdateResult(): void {
    const pending = this.store.getFlag<{ version: string; from: string; at: number }>(UPDATE_PENDING_FLAG);
    if (!pending) return;
    this.store.setFlag(UPDATE_PENDING_FLAG, null);
    let ok = false;
    try {
      ok = (JSON.parse(fs.readFileSync(this.updateFiles.statusFile, 'utf8')) as { ok?: unknown }).ok === true && APP_VERSION === pending.version;
    } catch {
      /* the helper never wrote it */
    }
    const result = { version: pending.version, from: pending.from, ok, at: Date.now(), logFile: this.updateFiles.logFile };
    this.store.setFlag(UPDATE_RESULT_FLAG, result);
    if (ok) log.info(`update: now running ${APP_VERSION} (was ${pending.from})`);
    else log.warn(`update: installing ${pending.version} failed; still ${APP_VERSION}. See ${result.logFile}`);
    fs.rmSync(path.join(this.paths.dataDir, 'updates'), { recursive: true, force: true });
  }

  /** Download and check the newest signed release, then hand it to the shell's restart helper to install. */
  private async installUpdate(): Promise<{ version: string }> {
    if (this.env.VOID_WORKSHOP_SHELL_RESTART !== '1')
      throw new RpcError('unsupported', 'This VOID Workshop build cannot restart itself; update from source with ./scripts/install.sh.');
    if (this.updating) throw new RpcError('busy', 'An update is already being prepared.');
    if (this.agents.workingCount) throw new RpcError('busy', 'Tasks are still working. Update once they finish or stop them.');
    this.updating = true;
    try {
      const { release, dir } = await this.updater.prepare();
      if (this.agents.workingCount) throw new RpcError('busy', 'A task started while the update downloaded. Update once it finishes.');
      const { statusFile, logFile } = this.updateFiles;
      fs.rmSync(statusFile, { force: true });
      this.store.setFlag(UPDATE_PENDING_FLAG, { version: release.version, from: APP_VERSION, at: Date.now() });
      log.info(`update: installing ${release.version} from ${dir}`);
      this.emit('app.updating', { version: release.version });
      this.emit('app.restart', { install: true, sourceDir: dir, statusFile, logFile });
      // Normally the app exits now; if the shell could not restart, allow another try.
      setTimeout(() => (this.updating = false), 60_000).unref();
      return { version: release.version };
    } catch (err) {
      this.updating = false;
      throw err instanceof RpcError ? err : new RpcError('update', (err as Error).message);
    }
  }

  private async resumeAfterRestart(): Promise<void> {
    const r = this.admin.takeResume();
    if (!r || !this.admin.active || Date.now() - r.at > RESUME_WITHIN_MS) return;
    const { statusFile, logFile } = this.restartFiles;
    let note = '';
    if (r.install) {
      let ok: boolean | null = null;
      try {
        ok = (JSON.parse(fs.readFileSync(statusFile, 'utf8')) as { ok?: unknown }).ok === true;
      } catch {
        /* the helper never wrote it */
      }
      note =
        ok === true
          ? ' The new build is installed and running.'
          : ok === false
            ? ` The install FAILED, so the previous build is still running; the install output is in ${logFile}.`
            : ` Whether the install worked is unknown (no status was written); check ${logFile}.`;
    }
    const text = `[VOID Workshop restarted.${note} Continue the task: check that the change works, then finish with a short summary.]`;
    try {
      await this.agents.send(r.taskId, text, r.mode);
    } catch (err) {
      log.warn(`admin: could not continue task ${r.taskId} after the restart: ${(err as Error).message}`);
      this.emit('agent.notice', { taskId: r.taskId, level: 'error', text: `Could not continue after the restart: ${errorPayload(err).message}` });
    }
  }

  // ---- RemoteHost ---------------------------------------------------------------------------
  /** What the phone shows on its home screen. */
  async remoteState(): Promise<unknown> {
    const init = (await this.methods['app.init']!(undefined)) as Record<string, unknown> & { settings: Record<string, unknown> };
    const pick = REMOTE_SETTINGS;
    const recent = this.store.recentProjects(10);
    // Working tasks first (from any folder), then the latest ones of the recent projects.
    const active = this.store.activeTasks();
    const tasks = [...active, ...recent.flatMap((p) => this.store.listTasks(p.path, 10)).filter((t) => !active.some((a) => a.id === t.id))]
      .sort((a, b) => Number(ACTIVE_STATES.includes(b.state)) - Number(ACTIVE_STATES.includes(a.state)) || b.updated_at - a.updated_at)
      .slice(0, Math.max(25, active.length))
      .map((t) => ({
        id: t.id,
        project: t.project,
        title: t.title,
        state: t.state,
        model: t.model,
        updated_at: t.updated_at,
        cost_usd: t.cost_usd,
        // The agent's last reply, short: the home screen widget shows it under the title.
        summary: t.summary ? t.summary.slice(0, 240) : null,
      }));
    return {
      pc: os.hostname(),
      version: APP_VERSION,
      settings: Object.fromEntries(pick.map((k) => [k, init.settings[k]])),
      models: { anthropic: this.modelList('anthropic')?.models ?? [], ollama: this.modelList('ollama')?.models ?? [] },
      keyConfigured: (init.auth as { configured: boolean }).configured,
      subscription: init.subscription,
      planLimited: init.planLimited,
      planUsage: init.planUsage,
      billingBlocked: init.billingBlocked,
      spentTodayUsd: init.spentTodayUsd,
      projects: recent,
      // Every other folder next to those (VOID Portal lists them under "All projects").
      folders: this.projectFolders().filter((f) => !recent.some((p) => p.path === f.path)),
      tasks,
      running: tasks.filter((t) => ACTIVE_STATES.includes(t.state)).map((t) => t.id),
      pendingApprovals: init.pendingApprovals,
      // The phone can match the PC's theme: a built-in id it knows, or the colours of a custom theme.
      theme: {
        id: init.settings.themeId,
        custom: (init.settings.customThemes as Array<{ id: string }>).find((t) => t.id === init.settings.themeId) ?? null,
      },
      // The PC's own themes with their colours, so the phone can show them, wear them, and switch the desktop's theme.
      customThemes: (init.settings.customThemes as Array<{ id: string; name: string; mode: string; colors: Record<string, string> }>).map((t) => ({
        id: t.id,
        name: t.name,
        mode: t.mode,
        colors: t.colors,
      })),
      sandbox: init.sandbox,
      admin: init.admin,
    };
  }

  /**
   * The folders next to the user's recent projects (say, everything in ~/Documents/Projects): VOID Portal offers them
   * as well, so a task can start in a project the PC hasn't opened yet. Never the contents of the home folder itself.
   */
  projectFolders(): Array<{ name: string; path: string }> {
    const recent = this.store.recentProjects(50).map((p) => p.path);
    const parents = [...new Set(recent.map((p) => path.dirname(p)))].filter((p) => p !== os.homedir() && p !== path.parse(p).root);
    const out = new Map<string, { name: string; path: string }>();
    for (const parent of parents) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(parent, e.name);
        out.set(p, { name: e.name, path: p });
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300);
  }

  /** May the phone start or list tasks in [root]? A recent project, or a folder next to one. */
  isRecentProject(root: string): boolean {
    return this.store.recentProjects(50).some((p) => p.path === root) || this.projectFolders().some((f) => f.path === root);
  }

  errorPayload(err: unknown): { code: string; message: string } {
    return errorPayload(err);
  }

  /** Models of a provider. For Anthropic: the API key's list plus the Claude plan's, without duplicates. */
  private modelList(provider: Provider = this.store.getSettings().provider): { models: ModelEntry[]; checkedAt: number } | null {
    type Cached = { models: ModelEntry[]; checkedAt: number };
    const own = this.store.getFlag<Cached>(modelsFlagKey(provider));
    if (provider === 'ollama') return own;
    const sub = this.store.getFlag<Cached>(SUBSCRIPTION_MODELS_FLAG);
    if (!sub || !own) return own ?? sub;
    return { models: [...own.models, ...sub.models.filter((m) => !own.models.some((o) => o.id === m.id))], checkedAt: Math.max(own.checkedAt, sub.checkedAt) };
  }

  private knownModels(provider: Provider = this.store.getSettings().provider): ModelEntry[] {
    return this.modelList(provider)?.models ?? [];
  }

  /** Re-read the Claude plan sign-in and its model list, and tell the window. */
  private async refreshSubscription(): Promise<{ status: SubscriptionStatus; models: ModelEntry[] }> {
    const status = await this.login.status();
    let models: ModelEntry[] = [];
    if (status.signedIn) {
      try {
        const probe = await this.agents.probeSubscription();
        models = subscriptionModels(probe.models);
        status.subscriptionType ??= probe.account.subscriptionType ?? null;
        status.email ??= probe.account.email ?? null;
      } catch (err) {
        status.problem = `Signed in, but the runtime could not be started: ${(err as Error).message}`;
      }
    }
    this.store.setFlag(SUBSCRIPTION_FLAG, status);
    this.store.setFlag(SUBSCRIPTION_MODELS_FLAG, models.length ? { models, checkedAt: status.checkedAt } : null);
    const all = this.knownModels('anthropic');
    this.emit('auth.subscription', { status, models: all });
    if (status.signedIn) void this.planUsage.refresh(true);
    return { status, models: all };
  }

  private readonly downloadsDir: string;

  private methods: Record<string, (params: unknown) => Promise<unknown>> = {
    'app.init': async () => {
      const settings = this.store.getSettings();
      return {
        version: APP_VERSION,
        settings,
        auth: await this.keys.status(),
        subscription: this.store.getFlag(SUBSCRIPTION_FLAG),
        planLimited: this.store.getFlag(PLAN_LIMIT_FLAG),
        planUsage: this.store.getFlag(PLAN_USAGE_FLAG),
        models: this.modelList(settings.provider),
        lastVerify: this.store.getFlag('lastVerify'),
        billingBlocked: this.store.getFlag('billingBlocked'),
        spentTodayUsd: this.store.spentOn(),
        today: dayKey(),
        recentProjects: this.store.recentProjects(),
        pendingApprovals: this.agents.pendingApprovals(),
        sandbox: sandboxAvailability(),
        dataDir: this.paths.dataDir,
        admin: this.admin.status(),
        lastUpdate: this.store.getFlag(UPDATE_RESULT_FLAG),
      };
    },
    'app.update.check': async () => {
      try {
        return await this.updater.check();
      } catch (err) {
        throw new RpcError('update', (err as Error).message);
      }
    },
    'app.update.install': async () => this.installUpdate(),
    'app.update.dismiss': async () => {
      this.store.setFlag(UPDATE_RESULT_FLAG, null);
      return { ok: true };
    },

    // ---- settings & auth ---------------------------------------------------------------
    'settings.get': async () => this.store.getSettings(),
    'settings.update': async (p) => {
      const patch = SettingsPatchSchema.parse(p);
      const current = this.store.getSettings();
      const provider = patch.provider ?? current.provider;
      if (patch.ollamaUrl !== undefined) {
        patch.ollamaUrl = normalizeOllamaUrl(patch.ollamaUrl);
        // A different server has different models: the cached list no longer applies.
        if (patch.ollamaUrl !== current.ollamaUrl) {
          this.store.setFlag(modelsFlagKey('ollama'), null);
          if (provider === 'ollama' && patch.model === undefined) patch.model = null;
        }
      }
      if (patch.model) {
        if (!this.knownModels(provider).some((m) => m.id === patch.model))
          throw new RpcError('model', 'Pick a model from the list returned by the provider (refresh it in Settings).');
      } else if (patch.model === undefined && provider !== current.provider && current.model) {
        // Switching provider keeps the model only if the other provider offers it too.
        if (!this.knownModels(provider).some((m) => m.id === current.model)) patch.model = null;
      }
      const updated = this.store.updateSettings(patch);
      if (patch.effort !== undefined || patch.fastMode !== undefined) await this.agents.applyLiveSettings(updated);
      if (patch.startAtLogin !== undefined) syncAutostart(updated.startAtLogin, this.env);
      // The window and the phone both change settings: each hears about the other's changes.
      this.emit('settings.changed', updated);
      return updated;
    },
    /** Refresh the model list of a provider (Anthropic: verifies the key; Ollama: asks the local server). */
    'models.refresh': async (p) => {
      const settings = this.store.getSettings();
      const { provider } = z.object({ provider: z.enum(PROVIDERS).optional() }).parse(p ?? {});
      if ((provider ?? settings.provider) === 'anthropic') return this.methods['auth.verify']!(undefined);
      const outcome = await listOllamaModels(settings.ollamaUrl);
      if (outcome.ok) {
        this.store.setFlag(modelsFlagKey('ollama'), { models: outcome.models, checkedAt: outcome.checkedAt });
        if (settings.provider === 'ollama' && settings.model && !outcome.models.some((m) => m.id === settings.model))
          this.store.updateSettings({ model: null });
      }
      return outcome;
    },
    'ollama.status': async () => ollamaStatus(this.store.getSettings().ollamaUrl),
    'auth.status': async () => this.keys.status(),
    'auth.setKey': async (p) => {
      const { key, backend } = z.object({ key: z.string().min(1).max(500), backend: z.enum(['secret-service', 'file']) }).parse(p);
      const status = await this.keys.store(key, backend);
      this.store.setFlag('lastVerify', null);
      return status;
    },
    'auth.deleteKey': async () => {
      const status = await this.keys.remove();
      this.store.setFlag('lastVerify', null);
      return status;
    },
    'auth.verify': async () => {
      const outcome = await verifyKeyAndListModels(this.keys);
      if (outcome.ok) {
        this.store.setFlag(modelsFlagKey('anthropic'), { models: outcome.models, checkedAt: outcome.checkedAt });
        this.store.setFlag('lastVerify', { ok: true, checkedAt: outcome.checkedAt, modelCount: outcome.models.length });
        const s = this.store.getSettings();
        const all = this.knownModels('anthropic');
        if (s.provider === 'anthropic' && s.model && !all.some((m) => m.id === s.model)) this.store.updateSettings({ model: null });
        return { ...outcome, models: all };
      } else {
        this.store.setFlag('lastVerify', { ok: false, kind: outcome.kind, message: outcome.message, checkedAt: outcome.checkedAt });
        if (outcome.kind === 'billing') this.store.setFlag('billingBlocked', { at: Date.now(), message: outcome.message });
      }
      return outcome;
    },
    'auth.subscriptionStatus': async () => this.refreshSubscription(),
    'auth.subscriptionLogin': async () => {
      await this.login.login((urls) => this.emit('auth.loginUrl', urls));
      return this.refreshSubscription();
    },
    'auth.subscriptionLoginCode': async (p) => {
      this.login.submitCode(z.object({ code: z.string().min(1).max(1100) }).parse(p).code);
      return { ok: true };
    },
    'auth.subscriptionLoginCancel': async () => ({ ok: this.login.cancel() }),
    'auth.subscriptionLogout': async () => {
      await this.login.logout();
      this.store.setFlag(PLAN_USAGE_FLAG, null);
      return this.refreshSubscription();
    },
    /** Claude plan usage meters; `force` checks again even when the last check is recent. */
    'plan.usage': async (p) => {
      const { force } = z.object({ force: z.boolean().optional() }).parse(p ?? {});
      return (await this.planUsage.refresh(force ?? false)) ?? this.store.getFlag(PLAN_USAGE_FLAG);
    },
    'auth.clearPlanLimit': async () => {
      this.store.setFlag(PLAN_LIMIT_FLAG, null);
      return { ok: true };
    },
    // ---- phone remote (desktop window only; the phone has its own allow-list) -----------------
    'remote.status': async () => this.remote.status(),
    'remote.pair': async (p) => this.remote.pair(z.object({ name: z.string().max(60).default('Phone') }).parse(p ?? {}).name),
    'remote.unpair': async (p) => {
      await this.remote.unpair(z.object({ id: z.string().uuid() }).parse(p).id);
      return this.remote.status();
    },
    'remote.setRelay': async (p) => {
      this.remote.setRelay(z.object({ url: z.string().min(6).max(300) }).parse(p).url);
      return this.remote.status();
    },
    // ---- admin dev session (the phone may use all but clearPassword; see remote.ts) --------------
    'admin.status': async () => this.admin.status(),
    'admin.setPassword': async (p) => {
      const { password, current, origin } = z.object({ password: Password, current: z.string().max(MAX_PASSWORD).optional(), origin: Origin }).parse(p);
      return this.admin.setPassword(password, current, origin);
    },
    'admin.clearPassword': async (p) => {
      const { current } = z.object({ current: z.string().max(MAX_PASSWORD) }).parse(p);
      const wasActive = this.admin.active;
      const status = await this.admin.clearPassword(current);
      return wasActive ? this.adminChanged(status) : status;
    },
    'admin.start': async (p) => {
      const { password, origin, device } = z.object({ password: Password, origin: Origin, device: z.string().max(60).optional() }).parse(p);
      const wasActive = this.admin.active;
      const status = await this.admin.start(password, origin, device ?? null);
      log.info(`admin: session ${wasActive ? 'already running' : 'started'} (${origin})`);
      return wasActive ? status : this.adminChanged(status);
    },
    'admin.end': async () => {
      const wasActive = this.admin.active;
      const status = this.admin.end();
      if (wasActive) log.info('admin: session ended');
      return wasActive ? this.adminChanged(status) : status;
    },
    'github.status': async () => this.github.status(),
    'github.login': async () => this.github.startLogin(this.store.getSettings().githubClientId),
    'github.loginCancel': async () => ({ ok: this.github.cancelLogin() }),
    'github.setToken': async (p) => this.github.setToken(z.object({ token: z.string().min(1).max(500) }).parse(p).token),
    'github.logout': async () => this.github.logout(),
    'github.repo': async (p) => this.github.repo(this.policy(Root.parse(p).root).root),
    'github.list': async (p) => {
      const { root, kind, state } = Root.extend({
        kind: z.enum(['pulls', 'issues', 'runs', 'releases']),
        state: z.enum(['open', 'closed', 'all']).default('open'),
      }).parse(p);
      return this.github.list(this.policy(root).root, kind, state);
    },
    'github.item': async (p) => {
      const { root, number } = Root.extend({ number: z.number().int().min(1).max(1e9) }).parse(p);
      return this.github.item(this.policy(root).root, number);
    },
    'github.comment': async (p) => {
      const { root, number, body } = Root.extend({ number: z.number().int().min(1).max(1e9), body: z.string().trim().min(1).max(65_000) }).parse(p);
      return this.github.comment(this.policy(root).root, number, body);
    },
    'cloudflare.status': async () => this.cloudflare.status(),
    'cloudflare.setToken': async (p) => this.cloudflare.setToken(z.object({ token: z.string().min(1).max(500) }).parse(p).token),
    'cloudflare.logout': async () => this.cloudflare.logout(),
    'cloudflare.resources': async (p) => this.cloudflare.resources(CfAccount.parse(p).accountId),
    'cloudflare.worker': async (p) => {
      const { accountId, name } = CfAccount.extend({ name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).parse(p);
      return this.cloudflare.worker(accountId, name);
    },
    'billing.acknowledge': async () => {
      this.store.setFlag('billingBlocked', null);
      return { ok: true };
    },
    'usage.summary': async () => ({
      today: dayKey(),
      spentTodayUsd: this.store.spentOn(),
      days: this.store.usageSummary(30),
      // The last 7 days per model: what a Claude plan's weekly limit is counted over.
      week: this.store.usageByModel(dayKey(new Date(Date.now() - 6 * 86_400_000))),
    }),

    // ---- projects ----------------------------------------------------------------------
    'project.open': async (p) => {
      const { root } = Root.parse(p);
      const real = canonicalProjectRoot(root);
      this.store.touchProject(real, path.basename(real));
      return {
        root: real,
        name: path.basename(real),
        permissions: this.store.getProjectPermissions(real),
        git: await gitStatus(real),
        commands: detectCommands(real),
      };
    },
    'project.recent': async () => this.store.recentProjects(),
    'project.forget': async (p) => {
      this.store.forgetProject(Root.parse(p).root);
      return { ok: true };
    },
    'project.setPermissions': async (p) => {
      const { root, permissions } = z.object({ root: z.string(), permissions: ProjectPermissionsSchema }).parse(p);
      const real = canonicalProjectRoot(root);
      const extra = permissions.extraPaths.map((x) => canonicalProjectRoot(x));
      for (const x of extra) if (x === real) throw new RpcError('perm', 'The project itself is already accessible.');
      this.store.setProjectPermissions(real, {
        extraPaths: extra,
        networkDomains: permissions.networkDomains.map((d) => d.toLowerCase()),
        // Added only from an approval ("Always allow"), removed with project.forgetCommand.
        alwaysAllowCommands: this.store.getProjectPermissions(real).alwaysAllowCommands,
      });
      return this.store.getProjectPermissions(real);
    },
    'project.allowedCommands': async (p) => this.store.getProjectPermissions(canonicalProjectRoot(Root.parse(p).root)).alwaysAllowCommands,
    'project.forgetCommand': async (p) => {
      const { root, command } = Root.extend({ command: z.string().max(2000) }).parse(p);
      const real = canonicalProjectRoot(root);
      const perms = this.store.getProjectPermissions(real);
      this.store.setProjectPermissions(real, { ...perms, alwaysAllowCommands: perms.alwaysAllowCommands.filter((c) => c !== command) });
      return this.store.getProjectPermissions(real).alwaysAllowCommands;
    },
    'project.listDir': async (p) => {
      const { root, rel } = Root.extend({ rel: z.string().max(4096).default('') }).parse(p);
      return listDir(this.policy(root), rel);
    },
    'project.readFile': async (p) => {
      const { root, rel, allowSensitive } = Root.extend({ rel: z.string().min(1).max(4096), allowSensitive: z.boolean().default(false) }).parse(p);
      try {
        return readFileForView(this.policy(root), rel, allowSensitive);
      } catch (err) {
        // Open editor tabs ask again after agent edits; a deleted file is an answer, not a failure.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new RpcError('not_found', `${rel} no longer exists`);
        throw err;
      }
    },
    'project.writeFile': async (p) => {
      const { root, rel, content, baseHash, allowSensitive } = Root.extend({
        rel: z.string().min(1).max(4096),
        content: z.string(),
        baseHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        allowSensitive: z.boolean().default(false),
      }).parse(p);
      try {
        const saved = writeFileFromEditor(this.policy(root), rel, content, baseHash, allowSensitive);
        log.info(`editor: saved ${saved.rel} (${saved.size} bytes)`);
        return saved;
      } catch (err) {
        if (err instanceof SaveConflictError) throw new RpcError('conflict', err.message);
        throw err;
      }
    },

    // ---- git ---------------------------------------------------------------------------
    'git.status': async (p) => gitStatus(this.policy(Root.parse(p).root).root),
    'git.diff': async (p) => {
      const { root, rel } = Root.extend({ rel: z.string().min(1).max(4096) }).parse(p);
      const policy = this.policy(root);
      const d = policy.check(rel, 'read');
      if (!d.allowed) throw new RpcError('path', d.reason ?? 'Not allowed');
      return { diff: clip(await gitDiffFile(policy.root, path.relative(policy.root, d.real)), 400_000) };
    },
    'git.checkpoint': async (p) => {
      const { root, label } = Root.extend({ label: z.string().max(80).default('manual') }).parse(p);
      const cp = await createCheckpoint(this.policy(root).root, `${label}-${Date.now()}`);
      if (!cp) throw new RpcError('git', 'Not a Git repository with at least one commit.');
      return cp;
    },
    'git.commit': async (p) => {
      const { root, paths, message, taskId } = Root.extend({
        paths: z.array(z.string().min(1).max(4096)).min(1).max(500),
        message: z.string().min(1).max(5000),
        taskId: z.string().uuid().optional(),
      }).parse(p);
      const policy = this.policy(root);
      const rels = paths.map((r) => {
        const d = policy.check(r, 'read');
        if (!d.allowed) throw new RpcError('path', d.reason ?? 'Not allowed');
        return path.relative(policy.root, d.real);
      });
      const res = await commitPaths(policy.root, rels, message);
      if (taskId) {
        for (const fc of this.store.fileChanges(taskId)) {
          if (rels.includes(path.relative(policy.root, fc.path))) this.store.setFileChangeStatus(taskId, fc.path, 'committed');
        }
        this.store.addEvent(taskId, 'git.commit', { sha: res.sha, paths: rels });
      }
      return res;
    },

    // ---- tasks -------------------------------------------------------------------------
    'task.list': async (p) => this.store.listTasks(this.policy(Root.parse(p).root).root),
    'task.get': async (p) => {
      const { taskId } = TaskId.parse(p);
      const task = this.store.getTask(taskId);
      if (!task) throw new RpcError('not-found', 'Task not found');
      return {
        task,
        events: this.store.events(taskId),
        live: this.agents.isLive(taskId),
        mode: this.agents.modeOf(taskId),
        approvals: this.agents.pendingApprovals().filter((a) => a.taskId === taskId),
        queue: this.agents.queue(taskId),
        context: this.agents.contextOf(taskId),
      };
    },
    'task.active': async () => this.store.activeTasks(),
    'task.image': async (p) => {
      const { taskId, imageId, offset, length } = TaskId.extend({
        imageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        offset: z.number().int().min(0).optional(),
        // The window reads bigger pieces; the phone's bridge drops this so replies fit a relay frame.
        length: z.number().int().min(1).max(MAX_WINDOW_CHUNK).optional(),
      }).parse(p);
      const chunk = this.agents.images.read(taskId, imageId, offset ?? 0, length);
      if (!chunk) throw new RpcError('not-found', 'That image is no longer kept (images are kept for 30 days).');
      return chunk;
    },
    'task.search': async (p) => {
      const { query, root } = z.object({ query: z.string().trim().min(2).max(200), root: z.string().max(4096).optional() }).parse(p);
      return this.store.searchTasks(query, root ? canonicalProjectRoot(root) : null);
    },
    /** A task as Markdown; with save, also written to the Downloads folder as a new file. */
    'task.export': async (p) => {
      const { taskId, save } = TaskId.extend({ save: z.boolean().optional() }).parse(p);
      const task = this.store.getTask(taskId);
      if (!task) throw new RpcError('not-found', 'Task not found');
      const markdown = taskMarkdown(task, this.store.events(taskId, 20_000));
      if (!save) return { markdown };
      fs.mkdirSync(this.downloadsDir, { recursive: true });
      const name = exportName(task);
      for (let i = 0; i < 1000; i++) {
        const file = path.join(this.downloadsDir, i ? name.replace(/\.md$/, `-${i}.md`) : name);
        try {
          fs.writeFileSync(file, markdown, { flag: 'wx', mode: 0o600 });
          return { markdown, path: file };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      throw new RpcError('exists', 'Too many exports of this task in Downloads.');
    },
    /** Desktop only: a copy of a kept image in the Downloads folder (a new file, never an overwrite). */
    'task.saveImage': async (p) => {
      const { taskId, imageId, name } = TaskId.extend({ imageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: z.string().max(200).default('image') }).parse(
        p,
      );
      const file = this.agents.images.saveCopy(taskId, imageId, this.downloadsDir, name);
      if (!file) throw new RpcError('not-found', 'That image is no longer kept (images are kept for 30 days).');
      return { path: file };
    },
    'task.start': async (p) => {
      const { root, prompt, mode, planFirst, checkpoint, imageIds } = Root.extend({
        prompt: z.string().min(1).max(50_000),
        mode: Mode.optional(),
        planFirst: z.boolean().optional(),
        checkpoint: z.boolean().optional(),
        imageIds: ImageIds,
      }).parse(p);
      const policy = this.policy(root);
      const settings = this.store.getSettings();
      let checkpointInfo: unknown = null;
      if (checkpoint ?? settings.checkpointBeforeTasks) {
        checkpointInfo = await createCheckpoint(policy.root, `task-${Date.now()}`).catch((err: Error) => ({ error: err.message }));
      }
      const task = await this.agents.startTask({ projectRoot: policy.root, prompt, mode, planFirst, imageIds });
      if (checkpointInfo && typeof checkpointInfo === 'object' && 'ref' in checkpointInfo) {
        this.store.updateTask(task.id, { checkpoint: (checkpointInfo as { ref: string }).ref });
        this.store.addEvent(task.id, 'checkpoint', checkpointInfo);
      }
      return this.store.getTask(task.id);
    },
    'task.send': async (p) => {
      const { taskId, text, mode, imageIds } = TaskId.extend({ text: z.string().min(1).max(50_000), mode: Mode.optional(), imageIds: ImageIds }).parse(p);
      if (!this.store.getTask(taskId)) throw new RpcError('not-found', 'Task not found');
      this.agents.attach(taskId, imageIds ?? []);
      return this.agents.send(taskId, text, mode);
    },
    /** A picture shared from the phone; it waits (a day at most) until task.start or task.send takes it with imageIds. */
    'image.upload': async (p) => {
      const { data } = z
        .object({
          data: z
            .string()
            .min(1)
            .max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4),
        })
        .parse(p);
      const buf = Buffer.from(data, 'base64');
      if (buf.length > MAX_UPLOAD_BYTES) throw new RpcError('too-big', 'That picture is too big to send.');
      const img = this.agents.images.save(UPLOADS, buf);
      if (!img) throw new RpcError('not-image', 'Only PNG, JPEG, GIF and WebP pictures can be sent.');
      return img;
    },
    'task.approvePlan': async (p) => {
      const { taskId, mode } = TaskId.extend({ mode: z.enum(['ask', 'auto-edit', 'auto']).optional() }).parse(p);
      this.agents.get(taskId).approvePlan(mode);
      return this.store.getTask(taskId);
    },
    'task.setMode': async (p) => {
      const { taskId, mode } = TaskId.extend({ mode: Mode }).parse(p);
      this.agents.setMode(taskId, mode);
      return { mode: this.agents.modeOf(taskId) };
    },
    'task.setModel': async (p) => {
      const { taskId, model } = TaskId.extend({ model: z.string().min(1).max(120) }).parse(p);
      if (!this.knownModels().some((m) => m.id === model))
        throw new RpcError('model', 'Pick a model from the list returned by the provider (refresh it in Settings).');
      return this.agents.setModel(taskId, model);
    },
    'task.compact': async (p) => {
      await this.agents.compact(TaskId.parse(p).taskId);
      return { ok: true };
    },
    'task.queue.edit': async (p) => {
      const { taskId, id, text } = TaskId.extend({ id: z.string().uuid(), text: z.string().min(1).max(50_000) }).parse(p);
      this.agents.editQueued(taskId, id, text);
      return this.agents.queue(taskId);
    },
    /** Remove one queued message, or all of them without `id`. */
    'task.queue.remove': async (p) => {
      const { taskId, id } = TaskId.extend({ id: z.string().uuid().optional() }).parse(p);
      this.agents.removeQueued(taskId, id);
      return this.agents.queue(taskId);
    },
    'task.queue.sendNow': async (p) => {
      const { taskId, id } = TaskId.extend({ id: z.string().uuid() }).parse(p);
      await this.agents.sendQueuedNow(taskId, id);
      return this.agents.queue(taskId);
    },
    'task.queue.flush': async (p) => {
      const { taskId } = TaskId.parse(p);
      await this.agents.flushQueue(taskId);
      return this.agents.queue(taskId);
    },
    'task.cancel': async (p) => {
      await this.agents.cancel(TaskId.parse(p).taskId);
      return { ok: true };
    },
    'task.finish': async (p) => this.agents.finishTask(TaskId.parse(p).taskId),
    'approval.respond': async (p) => {
      const { approvalId, decision, note, always, allowAll } = z
        .object({
          approvalId: z.string().uuid(),
          decision: z.enum(['allow', 'deny']),
          note: z.string().max(2000).optional(),
          always: z.boolean().optional(),
          allowAll: z.boolean().optional(),
        })
        .parse(p);
      this.agents.respondApproval(approvalId, {
        decision,
        note,
        ...(always && decision === 'allow' ? { always } : {}),
        ...(allowAll && decision === 'allow' ? { allowAll } : {}),
      });
      return { ok: true };
    },
    'approval.pending': async () => this.agents.pendingApprovals(),

    // ---- review ------------------------------------------------------------------------
    'review.list': async (p) => {
      const { taskId } = TaskId.parse(p);
      const task = this.store.getTask(taskId);
      if (!task) throw new RpcError('not-found', 'Task not found');
      return this.store.fileChanges(taskId).map((fc) => {
        const rel = path.relative(task.project, fc.path);
        let current: string | null;
        let externallyModified = false;
        try {
          current = fs.existsSync(fc.path) ? fs.readFileSync(fc.path, 'utf8') : null;
          externallyModified = !!fc.post_hash && fileHash(fc.path) !== fc.post_hash && !['accepted', 'rejected', 'committed'].includes(fc.status);
        } catch {
          current = null;
        }
        const original = fc.preimage_file && fs.existsSync(fc.preimage_file) ? fs.readFileSync(fc.preimage_file, 'utf8') : null;
        const canDiff = fc.status !== 'accepted' && fc.status !== 'committed';
        return {
          rel,
          status: fc.status,
          existed: !!fc.existed,
          externallyModified,
          diff: canDiff ? clip(unifiedDiff(rel, fc.existed ? original : null, current), 400_000) : null,
          updatedAt: fc.updated_at,
        };
      });
    },
    /** Commit some of a task's changed files (the phone's Commit button): only files this task changed, in its own project. */
    'review.commit': async (p) => {
      const { taskId, paths, message } = TaskId.extend({
        paths: z.array(z.string().min(1).max(4096)).min(1).max(500),
        message: z.string().trim().min(1).max(5000),
      }).parse(p);
      const task = this.store.getTask(taskId);
      if (!task) throw new RpcError('not-found', 'Task not found');
      const changed = new Set(this.store.fileChanges(taskId).map((fc) => path.relative(task.project, fc.path)));
      for (const rel of paths) if (!changed.has(rel)) throw new RpcError('path', `${rel} was not changed by this task.`);
      return this.methods['git.commit']!({ root: task.project, paths, message, taskId });
    },
    'review.accept': async (p) => {
      const { taskId, rel } = TaskId.extend({ rel: z.string().min(1) }).parse(p);
      const fc = this.fileChangeFor(taskId, rel);
      this.preimages.accept(taskId, fc);
      this.store.addEvent(taskId, 'review.accept', { rel });
      return { ok: true };
    },
    'review.reject': async (p) => {
      const { taskId, rel, force } = TaskId.extend({ rel: z.string().min(1), force: z.boolean().default(false) }).parse(p);
      if (this.agents.isLive(taskId) && ['planning', 'executing'].includes(this.store.getTask(taskId)!.state)) {
        throw new RpcError('busy', 'Wait for the agent turn to finish before rejecting changes.');
      }
      const fc = this.fileChangeFor(taskId, rel);
      const res = this.preimages.reject(taskId, fc, force);
      this.store.addEvent(taskId, 'review.reject', { rel, ...res });
      return res;
    },

    // ---- command runner ----------------------------------------------------------------
    'runner.detect': async (p) => detectCommands(this.policy(Root.parse(p).root).root),
    'runner.history': async (p) => this.store.commandRuns(this.policy(Root.parse(p).root).root),
    'runner.prepare': async (p) => {
      const { root, command, argv, reason, taskId } = Root.extend({
        command: z.string().max(4000).optional(),
        argv: z.array(z.string().max(4000)).max(200).optional(),
        reason: z.string().max(500).default('Run by user'),
        taskId: z.string().uuid().optional(),
      }).parse(p);
      const policy = this.policy(root);
      let args: string[];
      try {
        args = argv ?? splitArgv(command ?? '');
      } catch (err) {
        throw new RpcError('parse', (err as Error).message);
      }
      if (!args.length) throw new RpcError('parse', 'Enter a command.');
      const display = args.map((a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
      const assessment = assessCommand(display, {
        root: policy.root,
        extraRoots: policy.extraRoots,
        allowPublish: this.store.getSettings().allowPublishCommands,
      });
      const approvalToken = crypto.randomUUID();
      this.prepared.set(approvalToken, { root: policy.root, argv: args, reason, assessment, expires: Date.now() + 5 * 60_000, taskId: taskId ?? null });
      return { approvalToken, argv: args, display, cwd: policy.root, reason, assessment };
    },
    'runner.run': async (p) => {
      const { approvalToken } = z.object({ approvalToken: z.string().uuid() }).parse(p);
      const prep = this.prepared.get(approvalToken);
      this.prepared.delete(approvalToken);
      if (!prep || prep.expires < Date.now()) throw new RpcError('expired', 'This approval expired. Prepare the command again.');
      if (prep.assessment.blocked) throw new RpcError('blocked', `Blocked by policy: ${prep.assessment.blockReasons.join('; ')}`);
      const settings = this.store.getSettings();
      const display = prep.assessment.command;
      const { id, done } = this.runner.run(
        {
          argv: prep.argv,
          cwd: prep.root,
          timeoutMs: settings.commandTimeoutSec * 1000,
          maxOutputBytes: settings.commandOutputLimitKb * 1024,
          env: commandEnv(),
        },
        (chunk, stream) => this.emit('runner.output', { runId: id, stream, chunk }),
      );
      this.store.addCommandRun({
        id,
        taskId: prep.taskId,
        project: prep.root,
        origin: 'user',
        command: display,
        cwd: prep.root,
        reason: prep.reason,
        status: 'running',
      });
      this.emit('runner.started', { runId: id, origin: 'user', command: display, cwd: prep.root, taskId: prep.taskId });
      void done.then((r) => {
        const status = r.cancelled ? 'cancelled' : r.timedOut ? 'timed-out' : r.error ? 'error' : r.exitCode === 0 ? 'succeeded' : 'failed';
        this.store.finishCommandRun(id, { status, exitCode: r.exitCode, durationMs: r.durationMs, outputTail: r.output.slice(-8000) });
        this.emit('runner.finished', {
          runId: id,
          origin: 'user',
          status,
          exitCode: r.exitCode,
          signal: r.signal,
          durationMs: r.durationMs,
          truncated: r.truncated,
          error: r.error,
        });
        if (status === 'succeeded' && prep.taskId && /\b(test|check|lint|clippy|tsc|build|vitest|jest|pytest|typecheck)\b/.test(display))
          this.agents.markTested(prep.taskId);
      });
      return { runId: id };
    },
    'runner.cancel': async (p) => ({ ok: this.runner.cancel(z.object({ runId: z.string().uuid() }).parse(p).runId) }),
  };

  get methodNames(): string[] {
    return Object.keys(this.methods);
  }

  private policy(root: string): PathPolicy {
    const real = canonicalProjectRoot(root);
    return new PathPolicy(real, this.store.getProjectPermissions(real).extraPaths);
  }

  private fileChangeFor(taskId: string, rel: string): string {
    const task = this.store.getTask(taskId);
    if (!task) throw new RpcError('not-found', 'Task not found');
    const abs = path.resolve(task.project, rel);
    const fc = this.store.getFileChange(taskId, abs);
    if (!fc) throw new RpcError('not-found', 'No recorded change for that file in this task');
    return abs;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    const fn = this.methods[method];
    if (!fn) throw new RpcError('method', `Unknown method ${method}`);
    return fn(params ?? {});
  }

  async shutdown(): Promise<void> {
    this.planUsage.stop();
    this.remote.stop();
    this.login.cancel();
    this.runner.cancelAll();
    await this.agents.shutdownAll();
    this.store.close();
  }
}

export function errorPayload(err: unknown): { code: string; message: string } {
  if (err instanceof RpcError || err instanceof AgentError || err instanceof AdminError) return { code: err.code, message: err.message };
  if (err instanceof KeyFormatError) return { code: 'bad-key', message: err.message };
  if (err instanceof ServiceError) return { code: err.code, message: redactValue(err.message).slice(0, 500) };
  if (err instanceof z.ZodError)
    return {
      code: 'invalid-params',
      message: err.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 500),
    };
  if (err && typeof err === 'object' && (err as Error).name === 'PathError') return { code: 'path', message: (err as Error).message };
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal', message: redactValue(message).slice(0, 500) };
}

function sandboxAvailability(): { available: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const bin of ['bwrap', 'socat']) {
    const found = (process.env.PATH ?? '').split(':').some((d) => d && fs.existsSync(path.join(d, bin)));
    if (!found) missing.push(bin);
  }
  return { available: missing.length === 0, missing };
}
