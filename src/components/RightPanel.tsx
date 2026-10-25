import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, Cloud, ChevronRight, Circle, CircleDot, GitBranch, GitCommitHorizontal, History, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import type { GitStatus, PlanItem, Project, ReviewEntry, Task } from '../types';
import { Callout, ChangeBadge, ConfirmDialog, DiffView, changeLegend } from './common';
import { GithubMark } from './ServicePanels';

type Tab = 'plan' | 'changes' | 'git' | 'github' | 'cloudflare';

export function RightPanel({
  project,
  task,
  plan,
  review,
  git,
  onRefreshReview,
  onAccept,
  onReject,
  onCommit,
  onCheckpoint,
  onRefreshGit,
  services,
}: {
  project: Project | null;
  task: Task | null;
  plan: PlanItem[];
  review: ReviewEntry[];
  git: GitStatus | null;
  onRefreshReview: () => void;
  onAccept: (rel: string) => Promise<void>;
  onReject: (rel: string, force: boolean) => Promise<void>;
  onCommit: (paths: string[], message: string) => Promise<boolean>;
  onCheckpoint: () => Promise<void>;
  onRefreshGit: () => void;
  /** The GitHub and Cloudflare panels, when they are placed here. */
  services?: { github: ReactNode; cloudflare: ReactNode };
}) {
  const [picked, setTab] = useState<Tab>('plan');
  const tab: Tab = !services && (picked === 'github' || picked === 'cloudflare') ? 'plan' : picked;
  const visiblePlan = plan.filter((p) => p.status !== 'deleted');
  const pendingReview = review.filter((r) => !['accepted', 'rejected', 'committed'].includes(r.status)).length;
  return (
    <>
      <div className="tabs">
        <button className={`tab ${tab === 'plan' ? 'active' : ''}`} onClick={() => setTab('plan')}>
          Plan {visiblePlan.length > 0 && <span className="count">{visiblePlan.length}</span>}
        </button>
        <button className={`tab ${tab === 'changes' ? 'active' : ''}`} onClick={() => setTab('changes')}>
          Changes {pendingReview > 0 && <span className="count">{pendingReview}</span>}
        </button>
        <button className={`tab ${tab === 'git' ? 'active' : ''}`} onClick={() => setTab('git')}>
          Git {git?.dirty && <span className="count">{git.files.length}</span>}
        </button>
        {services && (
          <>
            <button className={`tab ${tab === 'github' ? 'active' : ''}`} onClick={() => setTab('github')} title="GitHub">
              <GithubMark /> GitHub
            </button>
            <button className={`tab ${tab === 'cloudflare' ? 'active' : ''}`} onClick={() => setTab('cloudflare')} title="Cloudflare">
              <Cloud size={13} /> Cloudflare
            </button>
          </>
        )}
      </div>
      <div className="panel-body">
        {tab === 'plan' && <PlanTab plan={visiblePlan} task={task} />}
        {tab === 'changes' && (
          <ChangesTab task={task} review={review} git={git} onRefresh={onRefreshReview} onAccept={onAccept} onReject={onReject} onCommit={onCommit} />
        )}
        {tab === 'git' && <GitTab project={project} git={git} onCheckpoint={onCheckpoint} onRefresh={onRefreshGit} />}
        {tab === 'github' && services?.github}
        {tab === 'cloudflare' && services?.cloudflare}
      </div>
    </>
  );
}

function PlanTab({ plan, task }: { plan: PlanItem[]; task: Task | null }) {
  if (!task) return <div className="empty-small">Start a task to see its plan here.</div>;
  if (!plan.length)
    return (
      <div className="empty-small">
        {task.state === 'planning'
          ? 'The agent is exploring. Plan steps appear here as it records them.'
          : 'No structured plan steps were recorded for this task. The full plan text is in the conversation.'}
      </div>
    );
  return (
    <div>
      {plan.map((p) => (
        <div key={p.ref} className={`plan-item ${p.status}`}>
          {p.status === 'completed' ? (
            <Check size={15} color="var(--success)" />
          ) : p.status === 'in_progress' ? (
            <CircleDot size={15} color="var(--accent-2)" />
          ) : (
            <Circle size={15} color="var(--text-dim)" />
          )}
          <div>
            <div className="subj">{p.subject}</div>
            {p.description && <div className="desc">{p.description}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChangesTab({
  task,
  review,
  git,
  onRefresh,
  onAccept,
  onReject,
  onCommit,
}: {
  task: Task | null;
  review: ReviewEntry[];
  git: GitStatus | null;
  onRefresh: () => void;
  onAccept: (rel: string) => Promise<void>;
  onReject: (rel: string, force: boolean) => Promise<void>;
  onCommit: (paths: string[], message: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [forceFor, setForceFor] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);

  if (!task) return <div className="empty-small">Changes made by a task are listed here for review.</div>;

  const committable = review.filter((r) => ['applied', 'tested', 'accepted'].includes(r.status));
  const act = async (rel: string, fn: () => Promise<void>) => {
    setBusy(rel);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="row" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
        <span className="muted grow">{review.length ? `${review.length} file(s) touched by this task` : 'No file changes yet.'}</span>
        <button className="icon-btn" title="What do the labels mean?" onClick={() => setLegend(!legend)}>
          <History size={13} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={onRefresh}>
          <RefreshCw size={13} />
        </button>
      </div>
      {legend && (
        <div className="legend">
          {changeLegend().map(([s, d]) => (
            <span key={s} className="row" style={{ width: '100%' }}>
              <ChangeBadge status={s} /> <span className="muted">{d}</span>
            </span>
          ))}
        </div>
      )}
      {review.map((r) => {
        const decided = ['accepted', 'rejected', 'committed'].includes(r.status);
        return (
          <div key={r.rel} className="change">
            <div className="change-head" onClick={() => setOpen(open === r.rel ? null : r.rel)}>
              {open === r.rel ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {git?.isRepo && !decided && (
                <input
                  type="checkbox"
                  title="Include in commit"
                  checked={selected.has(r.rel)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(r.rel);
                    else next.delete(r.rel);
                    setSelected(next);
                  }}
                />
              )}
              <span className="path" title={r.rel}>
                {r.rel}
              </span>
              {!r.existed && <span className="chip cyan">new</span>}
              <ChangeBadge status={r.status} />
            </div>
            {r.externallyModified && (
              <div style={{ padding: '0 10px 6px' }}>
                <Callout tone="warn">Modified outside VOID Workshop since the agent wrote it.</Callout>
              </div>
            )}
            {open === r.rel && (
              <div style={{ padding: '0 10px 8px' }}>
                {r.diff ? (
                  <DiffView diff={r.diff} maxHeight={360} />
                ) : (
                  <span className="muted">
                    {r.status === 'rejected' ? 'Restored to the original.' : 'Original no longer stored (change was accepted or committed).'}
                  </span>
                )}
              </div>
            )}
            {!decided && (
              <div className="change-actions">
                <button className="btn small cyan" disabled={busy === r.rel || r.status === 'proposed'} onClick={() => void act(r.rel, () => onAccept(r.rel))}>
                  {busy === r.rel ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Accept
                </button>
                <button
                  className="btn small danger"
                  disabled={busy === r.rel || ['planning', 'executing'].includes(task.state)}
                  title={['planning', 'executing'].includes(task.state) ? 'Wait for the agent turn to finish' : 'Restore the original content'}
                  onClick={() => (r.status === 'conflict' || r.externallyModified ? setForceFor(r.rel) : void act(r.rel, () => onReject(r.rel, false)))}
                >
                  <Undo2 size={12} /> Reject
                </button>
              </div>
            )}
          </div>
        );
      })}
      {git?.isRepo && committable.length > 0 && (
        <div style={{ padding: 10 }}>
          <button className="btn" disabled={selected.size === 0} onClick={() => setCommitOpen(true)}>
            <GitCommitHorizontal size={14} /> Commit selected ({selected.size})
          </button>
        </div>
      )}
      {forceFor && (
        <ConfirmDialog
          title="Overwrite external changes?"
          confirmLabel="Restore original anyway"
          danger
          onCancel={() => setForceFor(null)}
          onConfirm={() => {
            const rel = forceFor;
            setForceFor(null);
            void act(rel, () => onReject(rel, true));
          }}
        >
          <p>
            <code>{forceFor}</code> was changed outside VOID Workshop after the agent wrote it. Restoring the original will discard those later edits too.
          </p>
        </ConfirmDialog>
      )}
      {commitOpen && (
        <ConfirmDialog
          title="Create a Git commit"
          confirmLabel="Commit"
          busy={busy === '__commit'}
          onCancel={() => setCommitOpen(false)}
          onConfirm={() => {
            setBusy('__commit');
            void onCommit([...selected], message).then((ok) => {
              setBusy(null);
              if (ok) {
                setCommitOpen(false);
                setSelected(new Set());
                setMessage('');
              }
            });
          }}
        >
          <p>
            Commits exactly these files on <b>{git?.branch ?? 'the current branch'}</b>. Nothing is pushed.
          </p>
          <ul className="mono">
            {[...selected].map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <label className="field">
            Commit message
            <textarea className="textarea" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}

function GitTab({
  project,
  git,
  onCheckpoint,
  onRefresh,
}: {
  project: Project | null;
  git: GitStatus | null;
  onCheckpoint: () => Promise<void>;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!project) return <div className="empty-small">Open a project.</div>;
  if (!git) return <div className="empty-small">Loading…</div>;
  if (!git.isRepo)
    return (
      <div className="empty-small">
        Not a Git repository. VOID Workshop still keeps the original of every file the agent changes so you can reject changes individually.
      </div>
    );
  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="kv">
        <span className="k">Branch</span>
        <span className="row">
          <GitBranch size={13} /> {git.branch ?? '(detached)'}
        </span>
        <span className="k">HEAD</span>
        <span className="mono">{git.head?.slice(0, 12) ?? '(no commits)'}</span>
        <span className="k">Upstream</span>
        <span>{git.upstream ? `${git.upstream} (↑${git.ahead} ↓${git.behind})` : 'none'}</span>
        <span className="k">Working tree</span>
        <span>{git.dirty ? `${git.files.length} changed file(s)` : 'clean'}</span>
      </div>
      {git.dirty && (
        <Callout tone="warn">
          There is uncommitted work. The agent can edit these files too; a checkpoint keeps a copy of tracked changes without touching your branch.
        </Callout>
      )}
      <div className="row">
        <button
          className="btn"
          disabled={busy || !git.head}
          onClick={() => {
            setBusy(true);
            void onCheckpoint().finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <History size={14} />} Create checkpoint
        </button>
        <button className="btn ghost" onClick={onRefresh}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div>
        {git.files.map((f) => (
          <div key={f.path} className="row" style={{ padding: '2px 0' }}>
            <code style={{ width: 24, color: f.untracked ? 'var(--accent-2)' : f.conflicted ? 'var(--danger)' : 'var(--warning)' }}>
              {f.untracked ? '??' : `${f.index}${f.worktree}`.replace(/\./g, ' ')}
            </code>
            <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {f.path}
            </span>
          </div>
        ))}
      </div>
      <p className="muted">VOID Workshop never pushes, force-pushes, rebases or deletes history. Commits happen only when you click Commit.</p>
    </div>
  );
}
