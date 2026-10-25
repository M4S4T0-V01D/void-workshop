import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ClipboardList,
  FolderOpen,
  Info,
  Loader2,
  Sparkles,
  User,
  XCircle,
  Zap,
  FilePen,
  Hand,
  ListOrdered,
  Pencil,
  Send,
  X,
  Image as ImageIcon,
  Copy,
  Download,
  ZoomIn,
  ZoomOut,
  ClipboardCopy,
  FileDown,
} from 'lucide-react';
import type { AgentMode, AnthropicAuth, ContextInfo, InitData, Project, QueuedMessage, Settings, Task } from '../types';
import type { TimelineItem, TimelineState } from '../timeline';
import { ACTIVE, Callout, RUNNING, StateBadge, formatTokens, formatUsd } from './common';
import logo from '../assets/logo.svg';
import { Composer, type AccountSwitch } from './Composer';
import { AUTH_NAME, authProblem, effectiveAuth } from '../account';
import { call, errorText } from '../api';
import type { WindowMethod } from '../rpcMethods';
import { loadImage } from '../imageCache';
import { t, tn, useLanguage } from '../i18n';

function ToolLine({ item }: { item: Extract<TimelineItem, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={`tool-line ${item.status}`} onClick={() => setOpen(!open)} title={t('Show tool output')}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {item.status === 'running' ? (
          <Loader2 size={12} className="spin" />
        ) : item.status === 'error' ? (
          <XCircle size={12} color="var(--danger)" />
        ) : (
          <CheckCheck size={12} color="var(--success)" />
        )}
        <span className="summary">{item.summary}</span>
      </div>
      {open && <pre className="tool-output mono">{item.result ?? (item.status === 'running' ? t('Running…') : t('(no output)'))}</pre>}
    </>
  );
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Calls back once the element comes near the visible part of the conversation (at once without IntersectionObserver). */
function useNearView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '800px 0px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/** Copy an image to the clipboard as PNG (the only image type clipboards reliably take). */
async function copyImage(url: string): Promise<void> {
  let blob = await (await fetch(url)).blob();
  if (blob.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = [bmp.width, bmp.height];
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error(t('Could not convert the picture')))), 'image/png'));
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** Copy the task as Markdown, or save it as a new file in Downloads. */
function ExportButtons({ taskId }: { taskId: string }) {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(id);
  }, [note]);
  const run = (save: boolean) =>
    call<{ markdown: string; path?: string }>('task.export', { taskId, save })
      .then(async (r) => {
        if (r.path) return t('Saved to {path}', { path: r.path });
        await navigator.clipboard.writeText(r.markdown);
        return t('Copied as Markdown.');
      })
      .then(setNote, (err) => setNote(errorText(err)));
  return (
    <>
      {note && <span className="muted">{note}</span>}
      <button className="btn small ghost" onClick={() => void run(false)} title={t('Copy the conversation as Markdown')}>
        <ClipboardCopy size={13} />
      </button>
      <button className="btn small ghost" onClick={() => void run(true)} title={t('Save the conversation as Markdown in your Downloads folder')}>
        <FileDown size={13} />
      </button>
    </>
  );
}

/** Full-size view: click the picture to switch between fitting the window and actual size; Esc or the backdrop closes it. */
export function ImageLightbox({ url, name, taskId, imageId, onClose }: { url: string; name: string; taskId: string; imageId: string; onClose: () => void }) {
  const [actual, setActual] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const act = (fn: () => Promise<string>) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn().then(setNote, (err) => setNote(errorText(err)));
  };
  return createPortal(
    <div className={`image-lightbox${actual ? ' actual' : ''}`} onClick={onClose} role="dialog" aria-label={name}>
      <div className="image-tools" onClick={(e) => e.stopPropagation()}>
        <span className="mono">{name}</span>
        {note && <span className="muted">{note}</span>}
        <span className="spacer grow" />
        <button className="btn small" onClick={() => setActual(!actual)} title={t('Switch between fit to window and actual size')}>
          {actual ? <ZoomOut size={13} /> : <ZoomIn size={13} />} {actual ? t('Fit') : t('Actual size')}
        </button>
        <button className="btn small" onClick={act(() => copyImage(url).then(() => t('Copied to the clipboard.')))}>
          <Copy size={13} /> {t('Copy')}
        </button>
        <button
          className="btn small"
          onClick={act(() => call<{ path: string }>('task.saveImage', { taskId, imageId, name }).then((r) => t('Saved to {path}', { path: r.path })))}
          title={t('Save a copy in your Downloads folder')}
        >
          <Download size={13} /> {t('Save')}
        </button>
        <button className="btn small ghost" onClick={onClose} title={t('Close (Esc)')}>
          <X size={13} />
        </button>
      </div>
      <div className="image-stage">
        <img
          src={url}
          alt={name}
          onClick={(e) => {
            e.stopPropagation();
            setActual(!actual);
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

/** A screenshot or other picture the agent looked at. Loads when scrolled near; click to see it full size. */
export function ImageCard({ taskId, item }: { taskId: string; item: Extract<TimelineItem, { type: 'image' }> }) {
  const [ref, near] = useNearView<HTMLDivElement>();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!near) return;
    let gone = false;
    loadImage(taskId, item.imageId).then(
      (u) => !gone && setUrl(u),
      (err) => !gone && setError(errorText(err)),
    );
    return () => {
      gone = true;
    };
  }, [near, taskId, item.imageId]);
  return (
    <div className="image-card" ref={ref}>
      <div className="image-head">
        <ImageIcon size={12} /> {item.name} <span className="muted">{formatBytes(item.bytes)}</span>
      </div>
      {error ? (
        <div className="muted">{error}</div>
      ) : url ? (
        <img src={url} alt={item.name} onClick={() => setBig(true)} title={t('Click to see it full size')} />
      ) : (
        <Loader2 size={14} className="spin" />
      )}
      {big && url && <ImageLightbox url={url} name={item.name} taskId={taskId} imageId={item.imageId} onClose={() => setBig(false)} />}
    </div>
  );
}

/** Messages waiting for the current turn to end. Each can be edited, removed or sent right away. */
function QueuePanel({
  queue,
  running,
  together,
  onTogether,
  onAction,
}: {
  queue: QueuedMessage[];
  running: boolean;
  together: boolean;
  onTogether: (on: boolean) => void;
  onAction: (method: WindowMethod, params: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  return (
    <div className="queue">
      <div className="queue-head">
        <ListOrdered size={14} />
        <span className="grow">
          {tn(queue.length, '{n} queued', '{n} queued')} · {running ? t('sent when the agent finishes') : t('paused')}
        </span>
        <label className="check small" title={t('One message (one request) instead of one per queued message')}>
          <input type="checkbox" checked={together} onChange={(e) => onTogether(e.target.checked)} /> {t('Send together')}
        </label>
        {!running && (
          <button className="btn small primary" onClick={() => onAction('task.queue.flush', {})}>
            <Send size={12} /> {together && queue.length > 1 ? t('Send all') : t('Send next')}
          </button>
        )}
        <button className="btn small ghost" onClick={() => onAction('task.queue.remove', {})}>
          {t('Clear')}
        </button>
      </div>
      {queue.map((q) =>
        editing?.id === q.id ? (
          <div key={q.id} className="queue-item editing">
            <textarea
              value={editing.text}
              autoFocus
              rows={2}
              onChange={(e) => setEditing({ id: q.id, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(null);
                if (e.key === 'Enter' && !e.shiftKey && editing.text.trim()) {
                  e.preventDefault();
                  onAction('task.queue.edit', { id: q.id, text: editing.text.trim() });
                  setEditing(null);
                }
              }}
            />
          </div>
        ) : (
          <div key={q.id} className="queue-item">
            <span className="text grow" title={q.text}>
              {q.text}
            </span>
            <button
              className="icon-btn"
              title={running ? t('Send now: interrupts the current step and sends this next') : t('Send this now')}
              onClick={() => onAction('task.queue.sendNow', { id: q.id })}
            >
              <Zap size={13} />
            </button>
            <button className="icon-btn" title={t('Edit')} onClick={() => setEditing({ id: q.id, text: q.text })}>
              <Pencil size={13} />
            </button>
            <button className="icon-btn" title={t('Remove')} onClick={() => onAction('task.queue.remove', { id: q.id })}>
              <X size={13} />
            </button>
          </div>
        ),
      )}
    </div>
  );
}

/** Items never change once pushed (tool lines are replaced), so memo keeps streaming from re-rendering the history. */
const Item = memo(function Item({ item, taskId }: { item: TimelineItem; taskId: string | null }) {
  useLanguage();
  switch (item.type) {
    case 'image':
      return taskId ? <ImageCard taskId={taskId} item={item} /> : null;
    case 'user':
      return (
        <div className="msg user">
          <div className="who">
            <User size={12} /> {t('You')}
          </div>
          <div className="bubble">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg assistant">
          <div className="who">
            <Bot size={12} /> {t('Agent')}
          </div>
          <div className="bubble">{item.text}</div>
        </div>
      );
    case 'tool':
      return <ToolLine item={item} />;
    case 'plan':
      return (
        <div className="plan-card">
          <h4>
            <ClipboardList size={15} /> {t('Proposed plan')}
          </h4>
          <div className="body">{item.text}</div>
        </div>
      );
    case 'notice':
      return (
        <div className={`notice ${item.level}`}>
          {item.level === 'info' ? <Info size={14} /> : <AlertTriangle size={14} />}
          <span>{item.text}</span>
        </div>
      );
    case 'retry':
      return (
        <div className="notice warn">
          <Loader2 size={14} className="spin" />
          <span>{item.text}</span>
        </div>
      );
    case 'approval':
      return (
        <div className="notice">
          {item.decision === 'allow' ? <CheckCheck size={14} color="var(--success)" /> : <XCircle size={14} color="var(--danger)" />}
          <span>
            {item.auto
              ? t('Auto-approved: {summary}', { summary: item.summary })
              : item.decision === 'allow'
                ? t('Approved: {summary}', { summary: item.summary })
                : t('Denied: {summary}', { summary: item.summary })}
          </span>
        </div>
      );
    case 'usage':
      return (
        <div className="usage-line" title={t('Estimate from SDK-reported token usage and its built-in price table. Not a billing statement.')}>
          {item.costBasis === 'subscription' ? (
            <span>{t('Claude plan')}</span>
          ) : (
            <>
              <span>{t('turn ≈ {cost}', { cost: formatUsd(item.deltaUsd) })}</span>
              <span>{t('task ≈ {cost}', { cost: formatUsd(item.totalUsd) })}</span>
            </>
          )}
          <span>
            {t('{input} in / {output} out / {cached} cached', {
              input: formatTokens(item.input),
              output: formatTokens(item.output),
              cached: formatTokens(item.cacheRead),
            })}
          </span>
          {item.input + item.cacheRead + item.cacheWrite > 0 && (
            <span title={t('Share of input read from the prompt cache (cheaper and faster). Low values mean the cache expired or the context changed.')}>
              {t('{percent}% cache hits', { percent: Math.round((item.cacheRead / (item.input + item.cacheRead + item.cacheWrite)) * 100) })}
            </span>
          )}
          {item.costBasis === 'unknown' && <span style={{ color: 'var(--warning)' }}>{t('price unknown for this model')}</span>}
        </div>
      );
  }
});

export function Conversation({
  init,
  project,
  task,
  timeline,
  loading,
  onOpenProject,
  onStart,
  onSend,
  onApprovePlan,
  onCancel,
  onFinish,
  onOpenSettings,
  mode,
  onModeChange,
  model,
  onModelChange,
  onAccountChange,
  queue,
  context,
  onQueueAction,
  onSettingsPatch,
}: {
  init: InitData;
  project: Project | null;
  task: Task | null;
  timeline: TimelineState;
  loading: boolean;
  onOpenProject: () => void;
  onStart: (prompt: string, imageIds: string[]) => Promise<boolean>;
  onSend: (text: string, imageIds: string[]) => Promise<boolean>;
  onApprovePlan: (mode: Exclude<AgentMode, 'plan'>) => void;
  onCancel: () => void;
  onFinish: () => void;
  onOpenSettings: (section: 'key' | 'model' | 'billing') => void;
  mode: AgentMode;
  onModeChange: (m: AgentMode) => void;
  model: string | null;
  onModelChange: (id: string) => void;
  onAccountChange: (a: AnthropicAuth) => void;
  queue: QueuedMessage[];
  context: ContextInfo | null;
  onQueueAction: (method: WindowMethod, params: Record<string, unknown>) => void;
  onSettingsPatch: (patch: Partial<Settings>) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.items.length, timeline.streaming]);

  if (!project) {
    return (
      <div className="empty">
        <img className="logo" src={logo} alt="" />
        <h2>{t('VOID Workshop')}</h2>
        <p>{t('A local, approval-first coding agent. You pick the project, it proposes a plan, you approve each change.')}</p>
        <div className="steps">
          <div>
            <span className="n">1</span> {t('Sign in with your Claude plan or add a Console API key, then choose a model in Settings.')}
          </div>
          <div>
            <span className="n">2</span> {t('Open a project folder (the agent can only touch that folder).')}
          </div>
          <div>
            <span className="n">3</span> {t('Describe a task, review the plan, approve edits and commands.')}
          </div>
        </div>
        <div className="row">
          {init.settings.provider === 'anthropic' && !init.auth.configured && !init.subscription?.signedIn && (
            <button className="btn" onClick={() => onOpenSettings('key')}>
              {t('Sign in or add API key')}
            </button>
          )}
          <button className="btn primary" onClick={onOpenProject}>
            <FolderOpen size={14} /> {t('Open project')}
          </button>
        </div>
      </div>
    );
  }

  const running = task ? RUNNING.includes(task.state) : false;
  const awaitingPlan = task?.state === 'awaiting-plan-approval';
  const anthropic = init.settings.provider === 'anthropic';
  const eff = anthropic ? effectiveAuth(init) : null;
  const blockers: Array<{ text: string; action?: () => void; label?: string }> = [];
  if (eff && !eff.auth) {
    const billing = init.settings.anthropicAuth === 'api-key' && !!init.billingBlocked;
    blockers.push({
      text: eff.problem ?? t('No account is usable.'),
      action: () => onOpenSettings(billing ? 'billing' : 'key'),
      label: billing ? t('Details') : t('Settings'),
    });
  } else if (!init.settings.model) blockers.push({ text: t('No model selected.'), action: () => onOpenSettings('model'), label: t('Choose model') });
  const billed = eff?.auth === 'api-key';
  const remainingToday = init.settings.dailyBudgetUsd - init.spentTodayUsd;
  if (billed && remainingToday <= 0) blockers.push({ text: t('Daily estimated spend limit reached.') });

  const sub = init.subscription;
  const account: AccountSwitch | null = anthropic
    ? {
        value: init.settings.anthropicAuth,
        using: eff?.auth ?? null,
        options: (['subscription', 'api-key'] as const).map((id) => {
          const problem = authProblem(init, id);
          const ok =
            id === 'subscription'
              ? `${sub?.email ? t('Signed in as {email}', { email: sub.email }) : t('Signed in')}${sub?.subscriptionType ? ` · ${sub.subscriptionType}` : ''}`
              : t('Console key, billed per token');
          return { id, label: t(AUTH_NAME[id]), sub: problem ?? ok, usable: !problem };
        }),
        onChange: onAccountChange,
        onManage: () => onOpenSettings('key'),
      }
    : null;

  const isNewTask = !task || task.state === 'cancelled';
  // While the agent works, messages to this task are queued by the backend.
  const submit = (t: string, imageIds: string[]) => (!isNewTask && task ? onSend(t, imageIds) : onStart(t, imageIds));
  const canCompact = !!task && !isNewTask && (task.state === 'idle' || task.state === 'completed' || task.state === 'interrupted');

  return (
    <>
      {task && (
        <div className="task-header">
          <span className="title" title={task.prompt}>
            {task.title}
          </span>
          <StateBadge state={task.state} />
          <span className="muted">{task.model}</span>
          <span className="spacer grow" />
          <span className="muted" title={t('Estimated from SDK token usage; not a billing statement')}>
            {t('{cost} est. of {budget}', { cost: formatUsd(task.cost_usd), budget: formatUsd(init.settings.perTaskBudgetUsd) })}
          </span>
          <ExportButtons taskId={task.id} />
          {ACTIVE.includes(task.state) && (
            <button className="btn danger small" onClick={onCancel}>
              <CircleStop size={13} /> {t('Stop')}
            </button>
          )}
          {(task.state === 'idle' || task.state === 'interrupted' || task.state === 'stopped-budget' || task.state === 'stopped-limit') && (
            <button className="btn small" onClick={onFinish} title={t('Mark the task done and end its session')}>
              <CheckCheck size={13} /> {t('Finish')}
            </button>
          )}
        </div>
      )}
      <div className="convo" ref={scroller}>
        {loading && <div className="empty-small">{t('Loading task…')}</div>}
        {!task && !loading && (
          <div className="empty">
            <Sparkles size={34} color="var(--accent)" />
            <h2>{t('What should we build in {name}?', { name: project.name })}</h2>
            <p>
              {t(
                'Describe what you want in your own words. Pick how much the agent may do on its own with the mode button below (Shift+Tab cycles): ask before edits, edit automatically, auto, or plan first.',
              )}
            </p>
            {project.git.isRepo && project.git.dirty && (
              <Callout tone="warn">
                {tn(
                  project.git.files.length,
                  'You have {n} uncommitted change. A local checkpoint is saved before each task, but consider committing first.',
                  'You have {n} uncommitted changes. A local checkpoint is saved before each task, but consider committing first.',
                )}
              </Callout>
            )}
            {!project.git.isRepo && (
              <Callout tone="warn">
                {t('This folder is not a Git repository. Changes can still be reviewed and rejected per file, but there is no Git history to fall back on.')}
              </Callout>
            )}
          </div>
        )}
        {timeline.items.map((it) => (
          <Item key={it.key} item={it} taskId={task?.id ?? null} />
        ))}
        {timeline.streaming && (
          <div className="msg assistant">
            <div className="who">
              <Bot size={12} /> {t('Agent')}
            </div>
            <div className="bubble streaming">{timeline.streaming}</div>
          </div>
        )}
        {running && !timeline.streaming && (
          <div className="notice">
            <Loader2 size={14} className="spin" /> <span>{task?.state === 'planning' ? t('Exploring the project and drafting a plan…') : t('Working…')}</span>
          </div>
        )}
        {task?.error && !ACTIVE.includes(task.state) && task.state !== 'idle' && (
          <div className={`notice ${task.state === 'stopped-budget' || task.state === 'stopped-limit' || task.state === 'interrupted' ? 'warn' : 'error'}`}>
            <AlertTriangle size={14} /> <span>{task.error}</span>
          </div>
        )}
      </div>

      {awaitingPlan && (
        <div className="plan-actions">
          <ClipboardList size={16} color="var(--accent)" />
          <span className="grow">{t('Approve the plan and choose how to continue, or reply below to revise it.')}</span>
          <button className="btn small" onClick={() => onApprovePlan('ask')} title={t('Approve every change and command')}>
            <Hand size={13} /> {t('Ask before edits')}
          </button>
          <button className="btn small" onClick={() => onApprovePlan('auto-edit')} title={t('File changes apply without asking; commands ask')}>
            <FilePen size={13} /> {t('Edit automatically')}
          </button>
          <button className="btn primary small" onClick={() => onApprovePlan('auto')} title={t('Changes and sandboxed commands run without asking')}>
            <Zap size={13} /> {t('Auto')}
          </button>
        </div>
      )}

      <div className="composer">
        {blockers.map((b) => (
          <div key={b.text} className="callout warn">
            <AlertTriangle size={14} />
            <span className="grow">{b.text}</span>
            {b.action && (
              <button className="btn small" onClick={b.action}>
                {b.label}
              </button>
            )}
          </div>
        ))}
        {!isNewTask &&
          (task?.state === 'completed' ||
            task?.state === 'interrupted' ||
            task?.state === 'stopped-budget' ||
            task?.state === 'stopped-limit' ||
            task?.state === 'stopped-billing' ||
            task?.state === 'failed') && <span className="hint">{t('Sending resumes this session.')}</span>}
        {queue.length > 0 && !isNewTask && (
          <QueuePanel
            queue={queue}
            running={running}
            together={init.settings.sendQueuedTogether}
            onTogether={(on) => onSettingsPatch({ sendQueuedTogether: on })}
            onAction={onQueueAction}
          />
        )}
        <Composer
          mode={mode}
          onModeChange={onModeChange}
          model={model}
          models={init.models?.models ?? []}
          onModelChange={onModelChange}
          onManageModels={() => onOpenSettings('model')}
          account={account}
          tuning={
            anthropic
              ? {
                  effort: init.settings.effort,
                  onEffortChange: (effort) => onSettingsPatch({ effort }),
                  fast: init.settings.fastMode,
                  onFastChange: (fastMode) => onSettingsPatch({ fastMode }),
                }
              : null
          }
          context={isNewTask ? null : context}
          onCompact={canCompact ? () => onQueueAction('task.compact', {}) : null}
          canQueue={!isNewTask && !!task}
          running={running}
          blocked={blockers.length > 0}
          placeholder={
            isNewTask
              ? t('Describe a task, e.g. "Add input validation to the signup form and a test for it"')
              : awaitingPlan && mode === 'plan'
                ? t('Ask for changes to the plan…')
                : running
                  ? t('Queue a message: it is sent when the agent finishes…')
                  : t('Reply or ask for something else…')
          }
          hint={`${
            init.settings.provider === 'ollama'
              ? t('Ollama (local, free)')
              : !billed
                ? t('Plan usage')
                : t('≤ {cost} est.', {
                    cost: formatUsd(Math.max(0, Math.min(init.settings.perTaskBudgetUsd - (isNewTask ? 0 : (task?.cost_usd ?? 0)), remainingToday))),
                  })
          } · ${tn(init.settings.maxTurns, '{n} turn', '{n} turns')}`}
          onSubmit={submit}
          onStop={onCancel}
        />
      </div>
    </>
  );
}
