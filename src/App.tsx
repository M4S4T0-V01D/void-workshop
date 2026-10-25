import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Check,
  ChevronDown,
  Cloud,
  FolderOpen,
  LayoutTemplate,
  Paintbrush,
  Plus,
  RotateCcw,
  Settings as SettingsIcon,
  ShieldAlert,
  X,
} from 'lucide-react';
import { call, errorText, onSidecarEvent, onSidecarExit, pickProjectDir, restartSidecar, setBackgroundMode, startupError } from './api';
import type { WindowMethod } from './rpcMethods';
import type {
  AdminStatus,
  AgentMode,
  ApprovalRequest,
  ContextInfo,
  GitStatus,
  InitData,
  ModelEntry,
  PreparedCommand,
  Project,
  QueuedMessage,
  ReviewEntry,
  Settings,
  Task,
} from './types';
import { applyEvent, buildTimeline, EMPTY_TIMELINE, type TimelineState } from './timeline';
import { applyTheme, findTheme } from './themes';
import { DEFAULT_LAYOUT, LIMITS, appClasses } from './appearance';
import { useToasts } from './hooks/useToasts';
import { useAppearance } from './hooks/useAppearance';
import { useUpdateNotice } from './hooks/useUpdateNotice';
import { useRuns } from './hooks/useRuns';
import { Resizer } from './components/Resizer';
import { UiEditor } from './components/UiEditor';
import { Conversation } from './components/Conversation';
import { FileTree, TaskList } from './components/LeftPanel';
import { EditorArea, type EditorAreaHandle } from './components/EditorArea';
import { RightPanel } from './components/RightPanel';
import { CloudflarePanel, GithubMark, GithubPanel } from './components/ServicePanels';
import { BottomPanel } from './components/BottomPanel';
import { StatusBar } from './components/StatusBar';
import { ApprovalDialog, CommandConfirmDialog } from './components/ApprovalDialog';
import { SettingsDialog, type SettingsSection } from './components/SettingsDialog';
import { ConfirmDialog, StateBadge, Toasts, formatUsd, timeAgo } from './components/common';
import logo from './assets/logo.svg';
import type { TaskEvent } from './types';
import { effectiveAuth } from './account';
import { WelcomeLanguage, shouldWelcome } from './components/WelcomeLanguage';
import { msg, resolveLanguage, setLanguage, t, tn, tx, useLanguage } from './i18n';

export default function App() {
  const [init, setInit] = useState<InitData | null>(null);
  useLanguage();
  const [welcome, setWelcome] = useState(false);
  const languagePref = init?.settings.language;
  useEffect(() => {
    if (languagePref !== undefined) void setLanguage(resolveLanguage(languagePref));
  }, [languagePref]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  /** Tasks working (or waiting on a plan) in any project; several can run at once. */
  const [working, setWorking] = useState<Task[]>([]);
  const [workingMenu, setWorkingMenu] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineState>(EMPTY_TIMELINE);
  const [loadingTask, setLoadingTask] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [review, setReview] = useState<ReviewEntry[]>([]);
  const [git, setGit] = useState<GitStatus | null>(null);
  const { runs, clearRuns, applyRunEvent } = useRuns();
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  const [prepared, setPrepared] = useState<PreparedCommand | null>(null);
  const [confirmStart, setConfirmStart] = useState<{ prompt: string; imageIds: string[]; resolve: (ok: boolean) => void } | null>(null);
  const [mode, setMode] = useState<AgentMode>('ask');
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [confirmAdminEnd, setConfirmAdminEnd] = useState(false);
  /** What an admin restart is doing (scheduled, restarting), shown on the admin chip. */
  const [adminRestart, setAdminRestart] = useState<string | null>(null);

  // The shell decides on close: quit, or hide to the tray so VOID Portal keeps working.
  const runInBackground = init?.settings.runInBackground;
  useEffect(() => {
    if (runInBackground !== undefined) void setBackgroundMode(runInBackground).catch(() => undefined);
  }, [runInBackground]);
  const [projectMenu, setProjectMenu] = useState(false);
  const [layoutMenu, setLayoutMenu] = useState(false);
  const leftRef = useRef<HTMLDivElement>(null);
  const [treeKey, setTreeKey] = useState(0);
  const editorRef = useRef<EditorAreaHandle>(null);
  /** The file in the front editor tab, highlighted in the tree. */
  const [openFile, setOpenFile] = useState<string | null>(null);
  /** What the left panel shows while the GitHub and Cloudflare panels are placed there. */
  const [leftTab, setLeftTab] = useState<'files' | 'github' | 'cloudflare'>('files');

  const activeRef = useRef<string | null>(null);
  const projectRef = useRef<Project | null>(null);
  /** The prompt of a task being started, so its first update selects it (other tasks may be working too). */
  const startingRef = useRef<string | null>(null);
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const refreshTimer = useRef<number | undefined>(undefined);
  const modeLoaded = useRef(false);

  activeRef.current = activeId;
  projectRef.current = project;
  approvalsRef.current = approvals;

  const { toasts, dismiss: dismissToast, toast, log, addLog } = useToasts();
  const { ui, savedUi, uiDraft, setUiDraft, setLayout, previewLayout } = useAppearance(init, setInit, toast);
  useUpdateNotice(init, toast, addLog);

  // ---- loading ------------------------------------------------------------------------------
  const loadInit = useCallback(async () => {
    try {
      const data = await call<InitData>('app.init');
      setInit(data);
      if (shouldWelcome(data.settings.language)) setWelcome(true);
      setApprovals(data.pendingApprovals);
      if (!modeLoaded.current) {
        modeLoaded.current = true;
        setMode(data.settings.agentMode);
      }
      applyTheme(findTheme(data.settings.themeId, data.settings.customThemes));
      setFatal(null);
    } catch (err) {
      const why = (await startupError().catch(() => null)) ?? errorText(err);
      setFatal(why);
    }
  }, []);

  useEffect(() => {
    void loadInit();
  }, [loadInit]);

  const ready = !!init;
  useEffect(() => {
    if (ready) void call<Task[]>('task.active').then(setWorking, () => undefined);
  }, [ready]);

  const refreshReview = useCallback(
    async (taskId = activeRef.current) => {
      if (!taskId) return setReview([]);
      try {
        setReview(await call<ReviewEntry[]>('review.list', { taskId }));
      } catch (err) {
        addLog('error', t('Could not load changes: {error}', { error: errorText(err) }));
      }
    },
    [addLog],
  );

  const refreshGit = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const g = await call<GitStatus>('git.status', { root: p.root });
      setGit(g);
      setProject((cur) => (cur && cur.root === p.root ? { ...cur, git: g } : cur));
    } catch (err) {
      addLog('warn', t('Git status failed: {error}', { error: errorText(err) }));
    }
  }, [addLog]);

  const refreshTasks = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      setTasks(await call<Task[]>('task.list', { root: p.root }));
    } catch (err) {
      addLog('warn', errorText(err));
    }
  }, [addLog]);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      void refreshReview();
      void refreshGit();
      setTreeKey((k) => k + 1);
    }, 400);
  }, [refreshReview, refreshGit]);

  const selectTask = useCallback(
    async (id: string | null) => {
      setActiveId(id);
      activeRef.current = id;
      setTimeline(EMPTY_TIMELINE);
      setReview([]);
      setQueue([]);
      setContext(null);
      if (!id) return;
      setLoadingTask(true);
      try {
        const res = await call<{
          task: Task;
          events: TaskEvent[];
          approvals: ApprovalRequest[];
          mode: AgentMode | null;
          queue: QueuedMessage[];
          context: ContextInfo | null;
        }>('task.get', { taskId: id });
        if (activeRef.current !== id) return;
        setQueue(res.queue ?? []);
        setContext(res.context ?? null);
        if (res.mode) setMode(res.mode);
        else if (res.task.state === 'awaiting-plan-approval') setMode('plan');
        setTimeline(buildTimeline(res.events));
        setTasks((ts) => ts.map((t) => (t.id === id ? res.task : t)));
        void refreshReview(id);
      } catch (err) {
        toast('error', errorText(err));
      } finally {
        setLoadingTask(false);
      }
    },
    [refreshReview, toast],
  );

  // ---- sidecar events -------------------------------------------------------------------------
  useEffect(() => {
    const handlers: Array<Promise<() => void>> = [];
    handlers.push(
      onSidecarEvent(({ event, payload }) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const taskId = typeof p.taskId === 'string' ? p.taskId : null;
        switch (event) {
          case 'task.updated': {
            const task = payload as Task;
            if (projectRef.current && task.project === projectRef.current.root) {
              setTasks((ts) => (ts.some((x) => x.id === task.id) ? ts.map((x) => (x.id === task.id ? task : x)) : [task, ...ts]));
            }
            setWorking((w) => {
              const rest = w.filter((x) => x.id !== task.id);
              return ['planning', 'executing', 'awaiting-plan-approval'].includes(task.state) ? [task, ...rest] : rest;
            });
            if (
              startingRef.current !== null &&
              task.prompt === startingRef.current &&
              activeRef.current !== task.id &&
              (task.state === 'planning' || task.state === 'executing')
            ) {
              startingRef.current = null;
              activeRef.current = task.id;
              setActiveId(task.id);
              setTimeline(EMPTY_TIMELINE);
              setReview([]);
              setQueue([]);
              setContext(null);
            }
            if (
              task.id === activeRef.current &&
              ['idle', 'awaiting-plan-approval', 'completed', 'failed', 'cancelled', 'stopped-budget', 'stopped-billing', 'stopped-limit'].includes(task.state)
            )
              scheduleRefresh();
            if (task.state === 'failed' && task.error) addLog('error', t('Task failed: {error}', { error: task.error }));
            return;
          }
          case 'approval.request': {
            const req = payload as ApprovalRequest;
            setApprovals((a) => (a.some((x) => x.id === req.id) ? a : [...a, req]));
            addLog('info', t('Approval requested: {summary}', { summary: `${req.summary}${req.command ? ` — ${req.command}` : ''}` }));
            return;
          }
          case 'approval.resolved': {
            const req = approvalsRef.current.find((a) => a.id === p.id);
            setApprovals((a) => a.filter((x) => x.id !== p.id));
            if (req && taskId === activeRef.current)
              setTimeline((s) => applyEvent(s, 'approval.resolved', { summary: req.summary, decision: p.decision, kind: req.kind }));
            if (req)
              addLog(
                p.decision === 'allow' ? 'info' : 'warn',
                p.decision === 'allow' ? t('Approved: {summary}', { summary: req.summary }) : t('Denied: {summary}', { summary: req.summary }),
              );
            return;
          }
          case 'usage.updated':
            setInit((i) => (i ? { ...i, spentTodayUsd: Number(p.spentTodayUsd ?? i.spentTodayUsd) } : i));
            if (taskId === activeRef.current) setTimeline((s) => applyEvent(s, event, p));
            return;
          case 'queue.updated':
            if (taskId === activeRef.current) setQueue((p.items as QueuedMessage[]) ?? []);
            return;
          case 'agent.context':
            if (taskId === activeRef.current) setContext({ tokens: Number(p.tokens), max: Number(p.max) });
            return;
          case 'plan.usage':
            setInit((i) => (i ? { ...i, planUsage: payload as InitData['planUsage'] } : i));
            return;
          case 'plan.limited':
            setInit((i) => (i ? { ...i, planLimited: { until: Number(p.until), message: String(p.message) } } : i));
            addLog('warn', String(p.message));
            return;
          case 'auth.switched':
            toast('warn', String(p.text));
            addLog('warn', String(p.text));
            return;
          case 'auth.subscription': {
            const r = payload as { status: InitData['subscription']; models: ModelEntry[] };
            setInit((i) =>
              i ? { ...i, subscription: r.status, models: i.settings.provider === 'anthropic' ? { models: r.models, checkedAt: Date.now() } : i.models } : i,
            );
            return;
          }
          case 'billing.blocked':
            setInit((i) => (i ? { ...i, billingBlocked: { at: Date.now(), message: String(p.message) } } : i));
            toast('error', String(p.message));
            addLog('error', String(p.message));
            return;
          case 'file.changed':
          case 'review.updated':
            // Any task may touch a file that is open in an editor tab.
            editorRef.current?.checkDisk();
            if (taskId === activeRef.current) scheduleRefresh();
            return;
          case 'file.conflict':
            toast('warn', t('{name} {reason}. The edit was not applied.', { name: String(p.rel), reason: String(p.reason) }));
            addLog('warn', t('External change detected in {name}; edit refused.', { name: String(p.rel) }));
            return;
          case 'runner.started':
            applyRunEvent(event, p);
            addLog('info', t('Command started ({origin}): {command}', { origin: String(p.origin), command: String(p.command) }));
            return;
          case 'runner.output':
            applyRunEvent(event, p);
            return;
          case 'runner.finished':
            applyRunEvent(event, p);
            addLog(
              p.status === 'succeeded' || p.ok ? 'info' : 'warn',
              t('Command finished: {status}', { status: String(p.status ?? (p.ok ? 'succeeded' : 'failed')) }),
            );
            scheduleRefresh();
            return;
          case 'agent.mode':
            if (taskId === activeRef.current) setMode(p.mode as AgentMode);
            break;
          case 'agent.policyDenied':
            addLog('warn', t('Policy blocked {tool}: {reason}', { tool: String(p.tool), reason: String(p.reason) }));
            break;
          case 'agent.notice':
            if (p.level === 'error' || p.level === 'warn') addLog(p.level, String(p.text));
            break;
          case 'agent.retry':
            addLog('warn', t('API retry: {error} ({status})', { error: String(p.error), status: p.status === null ? t('no response') : String(p.status) }));
            break;
          // Settings changed in VOID Portal (or anywhere else): show them, and apply a new theme.
          case 'settings.changed': {
            const s = p as unknown as Settings;
            setInit((i) => (i ? { ...i, settings: s } : i));
            applyTheme(findTheme(s.themeId, s.customThemes));
            break;
          }
          case 'admin.changed': {
            const a = p as unknown as AdminStatus;
            setInit((i) => (i ? { ...i, admin: a } : i));
            if (!a.active) setAdminRestart(null);
            addLog(
              a.active ? 'warn' : 'info',
              a.active
                ? a.by === 'phone'
                  ? t('Admin dev session started from {device}.', { device: a.device ?? t('a phone') })
                  : t('Admin dev session started on this PC.')
                : t('Admin dev session ended.'),
            );
            break;
          }
          case 'admin.restartPending':
            setAdminRestart(p.install ? t('restart with the new build scheduled') : t('restart scheduled'));
            addLog(
              'info',
              p.reason
                ? t('Restart requested by the agent: {reason}. It happens once no task is working.', { reason: String(p.reason) })
                : t('Restart requested by the agent. It happens once no task is working.'),
            );
            break;
          case 'admin.restarting':
            setAdminRestart(p.install ? t('installing and restarting…') : t('restarting…'));
            break;
          case 'admin.restartFailed':
            setAdminRestart(null);
            toast('error', String(p.message));
            break;
        }
        if (taskId && taskId === activeRef.current && event.startsWith('agent.')) setTimeline((s) => applyEvent(s, event, p));
      }),
    );
    handlers.push(
      onSidecarExit((code) => {
        setFatal(
          code !== null
            ? t('The agent backend stopped (exit code {code}). Running tasks were interrupted; their history is saved.', { code })
            : t('The agent backend stopped. Running tasks were interrupted; their history is saved.'),
        );
      }),
    );
    return () => {
      for (const h of handlers) void h.then((un) => un());
    };
  }, [addLog, applyRunEvent, scheduleRefresh, toast]);

  // ---- projects -----------------------------------------------------------------------------
  const openProject = useCallback(
    async (root?: string) => {
      setProjectMenu(false);
      const path = root ?? (await pickProjectDir().catch((err) => (toast('error', errorText(err)), null)));
      if (!path) return;
      try {
        const p = await call<Project>('project.open', { root: path });
        setProject(p);
        projectRef.current = p;
        setGit(p.git);
        clearRuns();
        await selectTask(null);
        setTasks(await call<Task[]>('task.list', { root: p.root }));
        setInit((i) =>
          i
            ? {
                ...i,
                recentProjects: [{ path: p.root, name: p.name, last_opened: Date.now() }, ...i.recentProjects.filter((r) => r.path !== p.root)].slice(0, 12),
              }
            : i,
        );
        addLog('info', t('Opened project {path}', { path: p.root }));
      } catch (err) {
        toast('error', errorText(err));
      }
    },
    [addLog, clearRuns, selectTask, toast],
  );

  // ---- task actions -----------------------------------------------------------------------------
  const saveSettings = (patch: Partial<Settings>) =>
    call<Settings>('settings.update', patch)
      .then((s) => setInit((i) => (i ? { ...i, settings: s } : i)))
      .catch((err) => toast('error', errorText(err)));

  const changeMode = (m: AgentMode) => {
    setMode(m);
    void saveSettings({ agentMode: m });
    if (activeRef.current) void call('task.setMode', { taskId: activeRef.current, mode: m }).catch((err) => toast('error', errorText(err)));
  };

  const changeModel = async (model: string) => {
    const t = tasks.find((x) => x.id === activeRef.current);
    if (t && t.state !== 'cancelled') {
      try {
        const updated = await call<Task>('task.setModel', { taskId: t.id, model });
        setTasks((ts) => ts.map((x) => (x.id === updated.id ? updated : x)));
      } catch (err) {
        return toast('error', errorText(err));
      }
    }
    await saveSettings({ model });
  };

  const doStart = async (prompt: string, imageIds: string[] = []): Promise<boolean> => {
    if (!project) return false;
    startingRef.current = prompt.trim();
    try {
      const t = await call<Task>('task.start', { root: project.root, prompt, mode, ...(imageIds.length ? { imageIds } : {}) });
      startingRef.current = null;
      if (activeRef.current !== t.id) {
        activeRef.current = t.id;
        setActiveId(t.id);
      }
      void refreshTasks();
      return true;
    } catch (err) {
      startingRef.current = null;
      toast('error', errorText(err));
      void refreshTasks();
      return false;
    }
  };

  const startTask = (prompt: string, imageIds: string[] = []): Promise<boolean> => {
    const threshold = init?.settings.confirmTaskBudgetAboveUsd;
    if (
      init &&
      init.settings.provider !== 'ollama' &&
      effectiveAuth(init).auth === 'api-key' &&
      threshold !== null &&
      threshold !== undefined &&
      init.settings.perTaskBudgetUsd >= threshold
    ) {
      return new Promise((resolve) => setConfirmStart({ prompt, imageIds, resolve }));
    }
    return doStart(prompt, imageIds);
  };

  const sendFollowUp = async (text: string, imageIds: string[] = []): Promise<boolean> => {
    if (!activeId) return false;
    try {
      await call('task.send', { taskId: activeId, text, mode, ...(imageIds.length ? { imageIds } : {}) });
      return true;
    } catch (err) {
      toast('error', errorText(err));
      return false;
    }
  };

  const simple = (method: WindowMethod, params: Record<string, unknown>, ok?: string) => async () => {
    try {
      await call(method, params);
      if (ok) toast('info', ok);
    } catch (err) {
      toast('error', errorText(err));
    }
  };

  const active = tasks.find((t) => t.id === activeId) ?? null;

  /** Jump to a working task, opening its project first when it is another one. */
  const openWorking = async (t: Task) => {
    setWorkingMenu(false);
    if (projectRef.current?.root !== t.project) await openProject(t.project);
    await selectTask(t.id);
  };

  const taskLabel = (id: string): string | null => {
    if (id === activeId) return null;
    const t = working.find((x) => x.id === id) ?? tasks.find((x) => x.id === id);
    return t ? `${t.title} · ${t.project.split('/').pop()}` : 'another task';
  };

  // ---- render -----------------------------------------------------------------------------------
  if (fatal && !init) {
    return (
      <div className="empty" style={{ height: '100vh', justifyContent: 'center' }}>
        <img className="logo" src={logo} alt="" />
        <h2>{t('VOID Workshop could not start its backend')}</h2>
        <p>{fatal}</p>
        <button
          className="btn primary"
          onClick={() => {
            void restartSidecar()
              .then(loadInit)
              .catch((e) => setFatal(errorText(e)));
          }}
        >
          <RotateCcw size={14} /> {t('Retry')}
        </button>
      </div>
    );
  }
  if (!init) {
    return (
      <div className="empty" style={{ height: '100vh', justifyContent: 'center' }}>
        <img className="logo" src={logo} alt="" />
        <p>{t('Starting VOID Workshop…')}</p>
      </div>
    );
  }

  const servicesSide = init.settings.servicesPanel ?? 'right';
  const moveServices = () => {
    setLeftTab('files');
    void saveSettings({ servicesPanel: servicesSide === 'right' ? 'left' : 'right' });
  };
  const services = {
    github: (
      <GithubPanel
        root={project?.root ?? null}
        side={servicesSide}
        onMove={moveServices}
        onOpenItem={(number, title) => editorRef.current?.openView({ kind: 'gh-item', number, title })}
        onOpenSettings={() => setSettingsOpen('accounts')}
        settings={init.settings}
        save={saveSettings}
        toast={toast}
      />
    ),
    cloudflare: (
      <CloudflarePanel
        side={servicesSide}
        onMove={moveServices}
        onOpenWorker={(accountId, name) => editorRef.current?.openView({ kind: 'cf-worker', accountId, name })}
        onOpenSettings={() => setSettingsOpen('accounts')}
        toast={toast}
      />
    ),
  };
  const leftView = servicesSide === 'left' ? leftTab : 'files';

  return (
    <div className={`app ${appClasses(ui.layout)} ${init.admin.active ? 'admin-mode' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <img src={logo} alt="" />
          <span>
            <span className="void">{t('VOID')}</span> {t('WORKSHOP')}
          </span>
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn" onClick={() => setProjectMenu(!projectMenu)}>
            <FolderOpen size={14} /> {project ? project.name : t('Open project')} <ChevronDown size={12} />
          </button>
          {projectMenu && (
            <div className="menu" onMouseLeave={() => setProjectMenu(false)}>
              <button onClick={() => void openProject()}>
                <FolderOpen size={14} /> {t('Open folder…')}
              </button>
              {init.recentProjects.length > 0 && (
                <div className="muted" style={{ padding: '6px 10px 2px', fontSize: 11 }}>
                  {t('RECENT')}
                </div>
              )}
              {init.recentProjects.map((r) => (
                <button key={r.path} onClick={() => void openProject(r.path)}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div>{r.name}</div>
                    <div className="sub">{r.path}</div>
                  </div>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {timeAgo(r.last_opened)}
                  </span>
                  <span
                    className="icon-btn"
                    title={t('Remove from recent')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void call('project.forget', { root: r.path }).then(() =>
                        setInit((i) => (i ? { ...i, recentProjects: i.recentProjects.filter((x) => x.path !== r.path) } : i)),
                      );
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {project && (
          <button className="btn ghost" onClick={() => void selectTask(null)} disabled={!activeId} title={t('Start a new session in this project')}>
            <Plus size={14} /> {t('New session')}
          </button>
        )}
        {working.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button className="btn ghost" onClick={() => setWorkingMenu(!workingMenu)} title={t('Tasks working right now, in every project')}>
              <Activity size={14} /> {t('Working ({n})', { n: working.length })} <ChevronDown size={12} />
            </button>
            {workingMenu && (
              <div className="menu" onMouseLeave={() => setWorkingMenu(false)}>
                {working.map((t) => (
                  <button key={t.id} onClick={() => void openWorking(t)}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div>{t.title}</div>
                      <div className="sub">
                        {t.project.split('/').pop()} · {timeAgo(t.updated_at)}
                      </div>
                    </div>
                    <StateBadge state={t.state} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <span className="spacer" />
        {init.admin.active && (
          <span
            className="chip warn admin-chip"
            title={`${t('The agent may change VOID Workshop and VOID Portal')}${init.admin.sourceDir ? ` (${init.admin.sourceDir})` : ''}`}
          >
            <ShieldAlert size={12} /> {t('Admin dev session')}
            {init.admin.since ? ` · ${timeAgo(init.admin.since)}` : ''}
            {init.admin.by === 'phone' ? ` · ${t('from {device}', { device: init.admin.device ?? t('phone') })}` : ''}
            {adminRestart ? ` · ${adminRestart}` : ''}
            <button className="btn small" onClick={() => setConfirmAdminEnd(true)}>
              {t('End')}
            </button>
          </span>
        )}
        {fatal && (
          <span className="chip bad" title={fatal}>
            {t('Backend stopped')}
            <button
              className="btn small"
              onClick={() => {
                void restartSidecar()
                  .then(loadInit)
                  .then(() => toast('info', t('Backend restarted.')))
                  .catch((e) => toast('error', errorText(e)));
              }}
            >
              {t('Restart')}
            </button>
          </span>
        )}
        <div style={{ position: 'relative' }}>
          <button className="btn ghost" onClick={() => setLayoutMenu(!layoutMenu)} title={t('Panels, saved layouts and the visual editor')}>
            <LayoutTemplate size={14} /> {t('Layout')} <ChevronDown size={12} />
          </button>
          {layoutMenu && (
            <div className="menu" style={{ right: 0, left: 'auto' }} onMouseLeave={() => setLayoutMenu(false)}>
              <button
                onClick={() => {
                  setLayoutMenu(false);
                  setUiDraft((d) => d ?? ui);
                }}
              >
                <Paintbrush size={14} /> <span className="grow">{t('Edit UI…')}</span> <span className="muted">{t('Ctrl+Alt+E')}</span>
              </button>
              {(
                [
                  ['showLeft', msg('Files & tasks'), 'Ctrl+B'],
                  ['showRight', msg('Review & git'), 'Ctrl+Alt+B'],
                  ['showBottom', msg('Terminal & log'), 'Ctrl+J'],
                ] as const
              ).map(([k, label, keys]) => (
                <button key={k} onClick={() => setLayout({ [k]: !ui.layout[k] })}>
                  <Check size={14} style={{ opacity: ui.layout[k] ? 1 : 0 }} /> <span className="grow">{t(label)}</span> <span className="muted">{keys}</span>
                </button>
              ))}
              <button onClick={() => setLayout({ swapSides: !ui.layout.swapSides })}>
                <ArrowLeftRight size={14} /> <span className="grow">{t('Swap side panels')}</span>
              </button>
              <button onClick={() => setLayout(DEFAULT_LAYOUT)}>
                <RotateCcw size={14} /> <span className="grow">{t('Default layout')}</span>
              </button>
              {init.settings.layouts.length > 0 && (
                <div className="muted" style={{ padding: '6px 10px 2px', fontSize: 11 }}>
                  {t('SAVED LAYOUTS')}
                </div>
              )}
              {init.settings.layouts.map((l) => (
                <button
                  key={l.id}
                  onClick={() => {
                    setLayoutMenu(false);
                    if (uiDraft) setUiDraft(l.ui);
                    else void saveSettings({ ui: l.ui, ...(l.themeId ? { themeId: l.themeId } : {}) });
                    if (l.themeId) applyTheme(findTheme(l.themeId, init.settings.customThemes));
                  }}
                >
                  <LayoutTemplate size={14} /> <span className="grow">{l.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="btn ghost" onClick={() => setSettingsOpen('key')}>
          <SettingsIcon size={14} /> {t('Settings')}
        </button>
      </header>

      <aside className="left panel" ref={leftRef}>
        {servicesSide === 'left' && (
          <div className="tabs">
            <button className={`tab ${leftView === 'files' ? 'active' : ''}`} onClick={() => setLeftTab('files')}>
              {t('Files')}
            </button>
            <button className={`tab ${leftView === 'github' ? 'active' : ''}`} onClick={() => setLeftTab('github')}>
              <GithubMark /> {t('GitHub')}
            </button>
            <button className={`tab ${leftView === 'cloudflare' ? 'active' : ''}`} onClick={() => setLeftTab('cloudflare')}>
              <Cloud size={13} /> {t('Cloudflare')}
            </button>
          </div>
        )}
        {leftView !== 'files' ? (
          <div className="panel-body">{services[leftView]}</div>
        ) : project ? (
          <>
            <div style={{ flex: '0 0 var(--left-split, 60%)', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <FileTree project={project} refreshKey={treeKey} selected={openFile} onOpen={(rel) => editorRef.current?.open(rel)} />
            </div>
            <div className="left-split" style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' }}>
              <Resizer
                edge="top"
                title={t('Drag to share the panel between files and tasks')}
                value={ui.layout.leftSplit}
                min={LIMITS.leftSplit[0]}
                max={LIMITS.leftSplit[1]}
                grow={1}
                scale={100 / (leftRef.current?.clientHeight || 600)}
                onMove={(leftSplit) => previewLayout({ leftSplit })}
                onEnd={(leftSplit) => setLayout({ leftSplit })}
                onReset={() => setLayout({ leftSplit: DEFAULT_LAYOUT.leftSplit })}
              />
              <TaskList root={project.root} tasks={tasks} activeId={activeId} onSelect={(id) => void selectTask(id)} />
            </div>
          </>
        ) : (
          <div className="empty-small">{t('Open a project to browse its files.')}</div>
        )}
        <Resizer
          edge={ui.layout.swapSides ? 'left' : 'right'}
          title={t('Drag to resize')}
          value={ui.layout.leftW}
          min={LIMITS.leftW[0]}
          max={LIMITS.leftW[1]}
          grow={ui.layout.swapSides ? -1 : 1}
          onMove={(leftW) => previewLayout({ leftW })}
          onEnd={(leftW) => setLayout({ leftW })}
          onReset={() => setLayout({ leftW: DEFAULT_LAYOUT.leftW })}
        />
      </aside>

      <main className="center panel">
        <EditorArea handle={editorRef} root={project?.root ?? null} settings={init.settings.editor} toast={toast} onActiveFile={setOpenFile}>
          <Conversation
            init={init}
            project={project}
            task={active}
            timeline={timeline}
            loading={loadingTask}
            onOpenProject={() => void openProject()}
            onStart={startTask}
            onSend={sendFollowUp}
            onApprovePlan={(m) => {
              if (!activeId) return;
              setMode(m);
              void saveSettings({ agentMode: m });
              void simple('task.approvePlan', { taskId: activeId, mode: m })();
            }}
            onCancel={() => activeId && void simple('task.cancel', { taskId: activeId }, t('Task stopped.'))()}
            onFinish={() => activeId && void simple('task.finish', { taskId: activeId }, t('Task marked as completed.'))()}
            onOpenSettings={(s) => setSettingsOpen(s)}
            mode={mode}
            onModeChange={changeMode}
            model={active && active.state !== 'cancelled' ? active.model : init.settings.model}
            onModelChange={(m) => void changeModel(m)}
            onAccountChange={(a) => void saveSettings({ anthropicAuth: a })}
            queue={queue}
            context={context}
            onQueueAction={(method, params) => void simple(method, { taskId: activeId, ...params })()}
            onSettingsPatch={(patch) => void saveSettings(patch)}
          />
        </EditorArea>
      </main>

      <aside className="right panel">
        <Resizer
          edge={ui.layout.swapSides ? 'right' : 'left'}
          title={t('Drag to resize')}
          value={ui.layout.rightW}
          min={LIMITS.rightW[0]}
          max={LIMITS.rightW[1]}
          grow={ui.layout.swapSides ? 1 : -1}
          onMove={(rightW) => previewLayout({ rightW })}
          onEnd={(rightW) => setLayout({ rightW })}
          onReset={() => setLayout({ rightW: DEFAULT_LAYOUT.rightW })}
        />
        <RightPanel
          project={project}
          task={active}
          plan={timeline.plan}
          review={review}
          git={git}
          onRefreshReview={() => void refreshReview()}
          onAccept={async (rel) => {
            try {
              await call('review.accept', { taskId: activeId, rel });
              addLog('info', t('Accepted change to {name}', { name: rel }));
            } catch (err) {
              toast('error', errorText(err));
            }
            await refreshReview();
          }}
          onReject={async (rel, force) => {
            try {
              const r = await call<{ restored: boolean; conflict: boolean }>('review.reject', { taskId: activeId, rel, force });
              if (r.conflict) toast('warn', t('{name} was changed outside VOID Workshop. Confirm to overwrite those edits.', { name: rel }));
              else addLog('info', t('Rejected change to {name} (original restored)', { name: rel }));
            } catch (err) {
              toast('error', errorText(err));
            }
            await refreshReview();
            void refreshGit();
            setTreeKey((k) => k + 1);
          }}
          onCommit={async (paths, message) => {
            if (!project) return false;
            try {
              const r = await call<{ sha: string }>('git.commit', { root: project.root, paths, message, taskId: activeId ?? undefined });
              toast(
                'info',
                tn(paths.length, 'Committed {n} file: {sha}. Nothing was pushed.', 'Committed {n} files: {sha}. Nothing was pushed.', {
                  sha: r.sha.slice(0, 10),
                }),
              );
              addLog('info', `Commit ${r.sha.slice(0, 10)}: ${paths.join(', ')}`);
              await refreshReview();
              await refreshGit();
              return true;
            } catch (err) {
              toast('error', errorText(err));
              return false;
            }
          }}
          onCheckpoint={async () => {
            if (!project) return;
            try {
              const cp = await call<{ ref: string; includesChanges: boolean }>('git.checkpoint', { root: project.root, label: 'manual' });
              toast(
                'info',
                cp.includesChanges
                  ? t('Checkpoint saved at {ref}.', { ref: cp.ref })
                  : t('Checkpoint saved at {ref} (no uncommitted tracked changes).', { ref: cp.ref }),
              );
              addLog('info', `Checkpoint ${cp.ref}`);
            } catch (err) {
              toast('error', errorText(err));
            }
          }}
          onRefreshGit={() => void refreshGit()}
          services={servicesSide === 'right' ? services : undefined}
        />
      </aside>

      <section className="bottom panel">
        {!ui.layout.bottomCollapsed && (
          <Resizer
            edge="top"
            title={t('Drag to resize')}
            value={ui.layout.bottomH}
            min={LIMITS.bottomH[0]}
            max={LIMITS.bottomH[1]}
            grow={-1}
            onMove={(bottomH) => previewLayout({ bottomH })}
            onEnd={(bottomH) => setLayout({ bottomH })}
            onReset={() => setLayout({ bottomH: DEFAULT_LAYOUT.bottomH })}
          />
        )}
        <BottomPanel
          project={project}
          runs={runs}
          log={log}
          collapsed={ui.layout.bottomCollapsed}
          onToggle={() => setLayout({ bottomCollapsed: !ui.layout.bottomCollapsed })}
          onPrepare={async (input) => {
            if (!project) return;
            try {
              setPrepared(await call<PreparedCommand>('runner.prepare', { root: project.root, ...input, taskId: activeId ?? undefined }));
            } catch (err) {
              toast('error', errorText(err));
            }
          }}
          onCancelRun={(runId) => void simple('runner.cancel', { runId })()}
        />
      </section>

      <StatusBar
        init={init}
        project={project}
        task={active}
        pendingApprovals={approvals.length}
        onOpenSettings={(s) => setSettingsOpen(s)}
        onPlanUsage={(u) => setInit((i) => (i ? { ...i, planUsage: u } : i))}
      />

      {approvals[0] && (
        <ApprovalDialog
          key={approvals[0].id}
          request={approvals[0]}
          queueLength={approvals.length}
          from={taskLabel(approvals[0].taskId)}
          onDecide={async (decision, note, extra) => {
            const req = approvals[0]!;
            try {
              await call('approval.respond', { approvalId: req.id, decision, note, ...extra });
            } catch (err) {
              toast('error', errorText(err));
              setApprovals((a) => a.filter((x) => x.id !== req.id));
            }
          }}
          onAllowAndSwitch={async (m) => {
            const req = approvals[0]!;
            setMode(m);
            void saveSettings({ agentMode: m });
            try {
              await call('task.setMode', { taskId: req.taskId, mode: m });
              await call('approval.respond', { approvalId: req.id, decision: 'allow' });
            } catch (err) {
              toast('error', errorText(err));
              setApprovals((a) => a.filter((x) => x.id !== req.id));
            }
          }}
        />
      )}

      {prepared && (
        <CommandConfirmDialog
          prepared={prepared}
          onCancel={() => setPrepared(null)}
          onRun={() => {
            const token = prepared.approvalToken;
            setPrepared(null);
            void call('runner.run', { approvalToken: token }).catch((err) => toast('error', errorText(err)));
          }}
        />
      )}

      {confirmAdminEnd && (
        <ConfirmDialog
          title={t('End the admin session?')}
          confirmLabel={t('End admin session')}
          danger
          onCancel={() => setConfirmAdminEnd(false)}
          onConfirm={() => {
            setConfirmAdminEnd(false);
            call<AdminStatus>('admin.end')
              .then((a) => setInit((i) => (i ? { ...i, admin: a } : i)))
              .catch((e) => toast('error', errorText(e)));
          }}
        >
          <p>
            {t('Workshop goes back to normal: the agent can no longer change VOID Workshop or VOID Portal.')}
            {working.length > 0 &&
              ` ${tn(working.length, 'The task still working in it will be stopped (history is kept).', 'The {n} tasks still working in it will be stopped (history is kept).')}`}
          </p>
        </ConfirmDialog>
      )}
      {confirmStart && (
        <ConfirmDialog
          title={t('Start this task?')}
          confirmLabel={t('Start task')}
          onCancel={() => {
            confirmStart.resolve(false);
            setConfirmStart(null);
          }}
          onConfirm={() => {
            const c = confirmStart;
            setConfirmStart(null);
            void doStart(c.prompt, c.imageIds).then(c.resolve);
          }}
        >
          <p>
            {tx('This task may use up to {cost} (estimated) on {model}, which is at or above your confirmation threshold of {threshold}.', {
              cost: <b>{formatUsd(init.settings.perTaskBudgetUsd)}</b>,
              model: <b>{init.settings.model}</b>,
              threshold: formatUsd(init.settings.confirmTaskBudgetAboveUsd ?? 0),
            })}
          </p>
          <p className="muted">
            {t('Estimated today so far: {spent} of {budget}. These are local estimates, not your Console balance.', {
              spent: formatUsd(init.spentTodayUsd),
              budget: formatUsd(init.settings.dailyBudgetUsd),
            })}
          </p>
        </ConfirmDialog>
      )}

      {settingsOpen && (
        <SettingsDialog
          init={init}
          project={project}
          initialSection={settingsOpen}
          onClose={() => {
            setSettingsOpen(null);
            void loadInit();
          }}
          onSettings={(s) => setInit((i) => (i ? { ...i, settings: s } : i))}
          onAuth={(a) => setInit((i) => (i ? { ...i, auth: a } : i))}
          onModels={(models, v) => setInit((i) => (i ? { ...i, models: { models, checkedAt: v.checkedAt } } : i))}
          onPermissions={(perm) => setProject((p) => (p ? { ...p, permissions: perm } : p))}
          onBillingCleared={() => setInit((i) => (i ? { ...i, billingBlocked: null } : i))}
          onSubscription={(sub, models) =>
            setInit((i) => (i ? { ...i, subscription: sub, models: i.settings.provider === 'anthropic' ? { models, checkedAt: Date.now() } : i.models } : i))
          }
          onAdmin={(a) => setInit((i) => (i ? { ...i, admin: a } : i))}
          onEditUi={() => {
            setSettingsOpen(null);
            void loadInit();
            setUiDraft((d) => d ?? ui);
          }}
          onPlanLimitCleared={() => setInit((i) => (i ? { ...i, planLimited: null } : i))}
          toast={toast}
        />
      )}

      {welcome && (
        <WelcomeLanguage
          onDone={(code) => {
            setWelcome(false);
            if (code) void saveSettings({ language: code });
            else void setLanguage(resolveLanguage(''));
          }}
        />
      )}

      {uiDraft && (
        <UiEditor
          ui={uiDraft}
          saved={savedUi}
          settings={init.settings}
          onUi={setUiDraft}
          save={(patch) =>
            call<Settings>('settings.update', patch).then(
              (s) => (setInit((i) => (i ? { ...i, settings: s } : i)), true),
              (err) => (toast('error', errorText(err)), false),
            )
          }
          onClose={() => setUiDraft(null)}
          toast={toast}
        />
      )}

      <Toasts toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}
