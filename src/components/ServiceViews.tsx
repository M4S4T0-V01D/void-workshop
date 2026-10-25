import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, GitMerge, Loader2, RefreshCw, Send } from 'lucide-react';
import { call, errorText } from '../api';
import type { EditorSettings, GithubComment, GithubItem, ServiceView, WorkerDetail } from '../types';
import { CodeEditor } from './CodeEditor';
import { Callout, DiffView, timeAgo } from './common';
import { openExternal } from './ServicePanels';

type ToastFn = (t: 'info' | 'warn' | 'error', m: string) => void;

const ago = (iso: string) => timeAgo(Date.parse(iso));
const dash = (accountId: string, name: string) => `https://dash.cloudflare.com/${accountId}/workers/services/view/${name}/production`;

/** The pane behind a service tab in the editor area. */
export function ServiceViewPane({ view, root, settings, toast }: { view: ServiceView; root: string | null; settings: EditorSettings; toast: ToastFn }) {
  if (view.kind === 'gh-item')
    return root ? <GithubItemPane root={root} number={view.number} toast={toast} /> : <div className="empty-small">Open the project.</div>;
  return <WorkerPane accountId={view.accountId} name={view.name} settings={settings} toast={toast} />;
}

function GithubItemPane({ root, number, toast }: { root: string; number: number; toast: ToastFn }) {
  const [item, setItem] = useState<GithubItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showFiles, setShowFiles] = useState(true);

  const load = useCallback(() => {
    setError(null);
    call<GithubItem>('github.item', { root, number })
      .then(setItem)
      .catch((err) => setError(errorText(err)));
  }, [root, number]);
  useEffect(load, [load]);

  const send = async () => {
    setSending(true);
    try {
      const c = await call<GithubComment>('github.comment', { root, number, body: draft });
      setDraft('');
      setItem((it) => (it ? { ...it, comments: [...it.comments, c] } : it));
    } catch (err) {
      toast('error', `Comment not posted: ${errorText(err)}`);
    } finally {
      setSending(false);
    }
  };

  if (!item) return <div className="service-view">{error ? <Callout tone="bad">{error}</Callout> : <div className="empty-small">Loading #{number}…</div>}</div>;
  const state = item.merged ? 'merged' : item.draft ? 'draft' : item.state;
  const general = item.comments.filter((c) => !c.path);
  const review = item.comments.filter((c) => c.path);

  return (
    <>
      <div className="editor-bar">
        <span className="path">
          {item.kind === 'pull' ? 'Pull request' : 'Issue'} #{item.number}
        </span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={load} title="Reload">
          <RefreshCw size={13} />
        </button>
        <button className="btn small" onClick={() => openExternal(item.htmlUrl, toast)}>
          <ExternalLink size={13} /> Open on GitHub
        </button>
      </div>
      <div className="service-view">
        {error && <Callout tone="bad">{error}</Callout>}
        <h2>{item.title}</h2>
        <div className="row meta-line">
          <span className={`chip ${state === 'open' ? 'ok' : state === 'merged' ? 'accent' : ''}`}>{state}</span>
          {item.author && <b>{item.author}</b>}
          <span className="muted">opened {ago(item.createdAt)}</span>
          {item.head && (
            <span className="mono muted row">
              <GitMerge size={12} /> {item.head} → {item.base}
            </span>
          )}
          {item.labels.map((l) => (
            <span key={l} className="chip">
              {l}
            </span>
          ))}
        </div>
        <div className="gh-comment">
          <div className="gh-text">{item.body || <span className="muted">No description.</span>}</div>
        </div>

        {item.files && (
          <>
            <button className="service-group-head" onClick={() => setShowFiles((v) => !v)}>
              Files changed <span className="count">{item.files.length}</span>
              <span className="muted">
                +{item.files.reduce((n, f) => n + f.additions, 0)} −{item.files.reduce((n, f) => n + f.deletions, 0)}
              </span>
            </button>
            {showFiles &&
              item.files.map((f) => (
                <details key={f.filename} className="gh-file">
                  <summary>
                    <span className="mono">{f.filename}</span> <span className="muted">{f.status}</span> <span className="add">+{f.additions}</span>{' '}
                    <span className="del">−{f.deletions}</span>
                  </summary>
                  {f.patch ? (
                    <DiffView diff={`--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`} maxHeight={480} />
                  ) : (
                    <p className="muted">No text diff (binary or too large).</p>
                  )}
                </details>
              ))}
          </>
        )}

        {review.length > 0 && <h4>Review comments</h4>}
        {review.map((c) => (
          <Comment key={c.id} c={c} />
        ))}
        <h4>Conversation</h4>
        {general.length === 0 && <p className="muted">No comments yet.</p>}
        {general.map((c) => (
          <Comment key={c.id} c={c} />
        ))}

        <div className="gh-reply">
          <textarea rows={4} placeholder="Leave a comment (posted to GitHub as you)" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <span className="spacer" />
            <button className="btn primary" disabled={!draft.trim() || sending} onClick={() => void send()}>
              {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Comment
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function Comment({ c }: { c: GithubComment }) {
  return (
    <div className="gh-comment">
      <div className="gh-comment-head">
        <b>{c.author ?? 'ghost'}</b> <span className="muted">{ago(c.createdAt)}</span>
        {c.path && <span className="mono muted">{c.path}</span>}
      </div>
      <div className="gh-text">{c.body}</div>
    </div>
  );
}

function WorkerPane({ accountId, name, settings, toast }: { accountId: string; name: string; settings: EditorSettings; toast: ToastFn }) {
  const [w, setW] = useState<WorkerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mod, setMod] = useState(0);

  useEffect(() => {
    let live = true;
    call<WorkerDetail>('cloudflare.worker', { accountId, name })
      .then((r) => live && setW(r))
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [accountId, name]);

  const m = w?.modules[mod];
  return (
    <>
      <div className="editor-bar">
        <span className="path">Worker {name}</span>
        {w && w.modules.length > 1 && (
          <select value={mod} onChange={(e) => setMod(Number(e.target.value))}>
            {w.modules.map((x, i) => (
              <option key={x.name} value={i}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <span className="muted">Read-only (deployed code)</span>
        <button className="btn small" onClick={() => openExternal(dash(accountId, name), toast)}>
          <ExternalLink size={13} /> Dashboard
        </button>
      </div>
      {error && <Callout tone="bad">{error}</Callout>}
      {!w && !error && <div className="empty-small">Loading {name}…</div>}
      {w && w.deployments.length > 0 && (
        <details className="worker-deploys">
          <summary>
            Deployments <span className="count">{w.deployments.length}</span> <span className="muted">latest {ago(w.deployments[0]!.createdOn)}</span>
          </summary>
          {w.deployments.map((d) => (
            <div key={d.id} className="row">
              <span className="muted">{ago(d.createdOn)}</span>
              <span>{d.source ?? ''}</span>
              <span className="mono">{d.versions.join(', ')}</span>
              {d.message && <span className="muted">{d.message}</span>}
            </div>
          ))}
        </details>
      )}
      {m &&
        (m.content === null ? (
          <div className="empty-small">
            {m.name} is {m.contentType} ({Math.round(m.size / 1024)} KB) and is not shown.
          </div>
        ) : (
          <CodeEditor key={m.name} rel={m.name} initial={m.content} readOnly settings={settings} onDirty={() => {}} onSave={() => {}} handle={() => {}} />
        ))}
    </>
  );
}
