import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeftToLine, ArrowRightToLine, ChevronDown, ChevronRight, Cloud, ExternalLink, Lock, RefreshCw } from 'lucide-react';
import { call, errorText, onSidecarEvent, openServiceUrl } from '../api';
import type {
  CfResource,
  CfSection,
  CloudflareResources,
  CloudflareStatus,
  GithubListEntry,
  GithubListKind,
  GithubRepo,
  GithubStatus,
  Settings,
} from '../types';
import { CloudflareConnect, GithubConnect } from './settings/ServiceSections';
import { Callout, timeAgo } from './common';
import { msg, t } from '../i18n';

/** Sign-in changes in Settings tell the open panels to load again. */
export const SERVICES_CHANGED = 'void-services-changed';
export const notifyServicesChanged = () => window.dispatchEvent(new Event(SERVICES_CHANGED));

type ToastFn = (t: 'info' | 'warn' | 'error', m: string) => void;
type Side = 'left' | 'right';

export function GithubMark({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export const openExternal = (url: string, toast: ToastFn) => void openServiceUrl(url).catch((err) => toast('error', errorText(err)));
const ago = (iso: string | null) => (iso ? timeAgo(Date.parse(iso)) : '');

/** Reload on Settings changes and on sign-in finishing in the background. */
function useServicesChanged(reload: () => void) {
  useEffect(() => {
    window.addEventListener(SERVICES_CHANGED, reload);
    const off = onSidecarEvent((e) => e.event === 'github.changed' && reload());
    return () => {
      window.removeEventListener(SERVICES_CHANGED, reload);
      void off.then((f) => f());
    };
  }, [reload]);
}

function MoveButton({ side, onMove }: { side: Side; onMove: () => void }) {
  const to = side === 'right' ? 'left' : 'right';
  return (
    <button
      className="icon-btn"
      title={to === 'left' ? t('Move GitHub and Cloudflare to the left panel') : t('Move GitHub and Cloudflare to the right panel')}
      onClick={onMove}
    >
      {to === 'left' ? <ArrowLeftToLine size={14} /> : <ArrowRightToLine size={14} />}
    </button>
  );
}

function SignInPrompt({ what, problem, onOpenSettings, children }: { what: string; problem: string | null; onOpenSettings: () => void; children: ReactNode }) {
  return (
    <div className="service-signin">
      {problem ? <Callout tone="bad">{problem}</Callout> : <p className="muted">{what}</p>}
      {children}
      <button className="link small" onClick={onOpenSettings}>
        {t('More in Settings → GitHub & Cloudflare')}
      </button>
    </div>
  );
}

const KINDS: Array<[GithubListKind, string]> = [
  ['pulls', msg('Pull requests')],
  ['issues', msg('Issues')],
  ['runs', msg('Actions')],
  ['releases', msg('Releases')],
];

export function GithubPanel({
  root,
  side,
  onMove,
  onOpenItem,
  onOpenSettings,
  settings,
  save,
  toast,
}: {
  root: string | null;
  side: Side;
  onMove: () => void;
  onOpenItem: (number: number, title: string) => void;
  onOpenSettings: () => void;
  settings: Settings;
  save: (p: Partial<Settings>) => Promise<void>;
  toast: ToastFn;
}) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repo, setRepo] = useState<GithubRepo | null | undefined>(undefined);
  const [kind, setKind] = useState<GithubListKind>('pulls');
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [items, setItems] = useState<GithubListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  useServicesChanged(reload);

  useEffect(() => {
    let live = true;
    setError(null);
    void (async () => {
      try {
        const s = await call<GithubStatus>('github.status');
        if (!live) return;
        setStatus(s);
        if (!s.configured || s.problem || !root) return setRepo(null);
        const r = await call<GithubRepo | null>('github.repo', { root });
        if (live) setRepo(r);
      } catch (err) {
        if (live) setError(errorText(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [root, reloads]);

  useEffect(() => {
    if (!repo || !root) return setItems(null);
    let live = true;
    setItems(null);
    setError(null);
    call<GithubListEntry[]>('github.list', { root, kind, state })
      .then((r) => live && setItems(r))
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [repo, root, kind, state, reloads]);

  const header = (
    <div className="service-head">
      <GithubMark />
      {repo ? (
        <button className="link" title={repo.description ?? repo.fullName} onClick={() => openExternal(repo.htmlUrl, toast)}>
          {repo.fullName}
        </button>
      ) : (
        <b>{t('GitHub')}</b>
      )}
      {repo?.private && <Lock size={11} className="muted" />}
      <span className="spacer" />
      {status?.login && <span className="muted">{status.login}</span>}
      <button className="icon-btn" title={t('Refresh')} onClick={reload}>
        <RefreshCw size={13} />
      </button>
      <MoveButton side={side} onMove={onMove} />
    </div>
  );

  let body;
  if (!status) body = error ? <Callout tone="bad">{error}</Callout> : <div className="empty-small">{t('Loading…')}</div>;
  else if (!status.configured || status.problem)
    body = (
      <SignInPrompt
        what={t("Sign in to GitHub to see this project's pull requests, issues and Actions runs here.")}
        problem={status.problem}
        onOpenSettings={onOpenSettings}
      >
        <GithubConnect compact settings={settings} save={save} toast={toast} pending={status.pending} />
      </SignInPrompt>
    );
  else if (!root) body = <div className="empty-small">{t('Open a project.')}</div>;
  else if (repo === undefined) body = <div className="empty-small">{t('Loading…')}</div>;
  else if (repo === null) body = <div className="empty-small">{t('This project has no GitHub remote (git remote -v).')}</div>;
  else
    body = (
      <>
        <div className="service-filters">
          <div className="seg">
            {KINDS.map(([k, label]) => (
              <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {t(label)}
              </button>
            ))}
          </div>
          {(kind === 'pulls' || kind === 'issues') && (
            <select value={state} onChange={(e) => setState(e.target.value as typeof state)}>
              <option value="open">{t('Open')}</option>
              <option value="closed">{t('Closed')}</option>
              <option value="all">{t('All')}</option>
            </select>
          )}
        </div>
        {error && <Callout tone="bad">{error}</Callout>}
        {!items && !error && <div className="empty-small">{t('Loading…')}</div>}
        {items?.length === 0 && <div className="empty-small">{t('Nothing here.')}</div>}
        <div className="service-list">
          {items?.map((it) => {
            const openable = (kind === 'pulls' || kind === 'issues') && it.number !== null;
            return (
              <button
                key={it.id}
                className="service-row"
                title={openable ? t('Open in a tab') : t('Open on GitHub')}
                onClick={() => (openable ? onOpenItem(it.number!, it.title) : openExternal(it.htmlUrl, toast))}
              >
                <span className="title">
                  {it.number !== null && <span className="muted">#{it.number} </span>}
                  {it.title}
                </span>
                <span className="meta">
                  <span className={`chip ${stateTone(it.state)}`}>{it.draft ? 'draft' : it.state}</span>
                  {it.author && <span>{it.author}</span>}
                  {it.detail && <span>{it.detail}</span>}
                  <span>{ago(it.updatedAt)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </>
    );

  return (
    <div className="service-panel">
      {header}
      <div className="service-body">{body}</div>
    </div>
  );
}

function stateTone(state: string) {
  if (['open', 'success', 'published', 'latest'].includes(state)) return 'ok';
  if (['merged'].includes(state)) return 'accent';
  if (['failure', 'cancelled', 'timed_out', 'action_required'].includes(state)) return 'bad';
  if (['in_progress', 'queued', 'pending', 'waiting', 'prerelease'].includes(state)) return 'warn';
  return '';
}

const CF_SECTIONS: Array<[keyof Omit<CloudflareResources, 'accountId'>, string]> = [
  ['workers', msg('Workers')],
  ['pages', msg('Pages')],
  ['r2', msg('R2 buckets')],
  ['d1', msg('D1 databases')],
  ['kv', msg('KV namespaces')],
];

const ACCOUNT_KEY = 'void.cloudflare.account';

export function CloudflarePanel({
  side,
  onMove,
  onOpenWorker,
  onOpenSettings,
  toast,
}: {
  side: Side;
  onMove: () => void;
  onOpenWorker: (accountId: string, name: string) => void;
  onOpenSettings: () => void;
  toast: ToastFn;
}) {
  const [status, setStatus] = useState<CloudflareStatus | null>(null);
  const [account, setAccount] = useState<string | null>(() => localStorage.getItem(ACCOUNT_KEY));
  const [res, setRes] = useState<CloudflareResources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  useServicesChanged(reload);

  useEffect(() => {
    let live = true;
    call<CloudflareStatus>('cloudflare.status')
      .then((s) => live && setStatus(s))
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [reloads]);

  const accounts = status?.configured && !status.problem ? status.accounts : [];
  const accountId = accounts.find((a) => a.id === account)?.id ?? accounts[0]?.id ?? null;

  useEffect(() => {
    if (!accountId) return setRes(null);
    let live = true;
    setRes(null);
    setError(null);
    call<CloudflareResources>('cloudflare.resources', { accountId })
      .then((r) => live && setRes(r))
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [accountId, reloads]);

  const toggle = (k: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  let body;
  if (!status) body = error ? <Callout tone="bad">{error}</Callout> : <div className="empty-small">{t('Loading…')}</div>;
  else if (!status.configured || status.problem)
    body = (
      <SignInPrompt what={t('Add a Cloudflare API token to see Workers, Pages, R2, D1 and KV here.')} problem={status.problem} onOpenSettings={onOpenSettings}>
        <CloudflareConnect compact toast={toast} />
      </SignInPrompt>
    );
  else if (!accountId) body = <div className="empty-small">{t("This token can't see any account.")}</div>;
  else
    body = (
      <>
        {accounts.length > 1 && (
          <div className="service-filters">
            <select
              value={accountId}
              onChange={(e) => {
                setAccount(e.target.value);
                localStorage.setItem(ACCOUNT_KEY, e.target.value);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && <Callout tone="bad">{error}</Callout>}
        {!res && !error && <div className="empty-small">{t('Loading…')}</div>}
        {res &&
          CF_SECTIONS.map(([k, label]) => (
            <CfGroup
              key={k}
              label={t(label)}
              section={res[k]}
              open={!closed.has(k)}
              onToggle={() => toggle(k)}
              onClick={(r) => (k === 'workers' ? onOpenWorker(res.accountId, r.name) : r.url && openExternal(r.url, toast))}
              onDash={(r) => r.url && openExternal(r.url, toast)}
              openable={k === 'workers'}
            />
          ))}
      </>
    );

  return (
    <div className="service-panel">
      <div className="service-head">
        <Cloud size={14} />
        <b>{t('Cloudflare')}</b>
        {accounts.length === 1 && <span className="muted">{accounts[0]?.name}</span>}
        <span className="spacer" />
        <button className="icon-btn" title={t('Refresh')} onClick={reload}>
          <RefreshCw size={13} />
        </button>
        <MoveButton side={side} onMove={onMove} />
      </div>
      <div className="service-body">{body}</div>
    </div>
  );
}

function CfGroup({
  label,
  section,
  open,
  onToggle,
  onClick,
  onDash,
  openable,
}: {
  label: string;
  section: CfSection;
  open: boolean;
  onToggle: () => void;
  onClick: (r: CfResource) => void;
  onDash: (r: CfResource) => void;
  openable: boolean;
}) {
  return (
    <div className="service-group">
      <button className="service-group-head" onClick={onToggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {label}
        <span className="count">{section.error ? '!' : section.items.length}</span>
      </button>
      {open && section.error && <p className="muted service-note">{section.error}</p>}
      {open && !section.error && section.items.length === 0 && <p className="muted service-note">{t('None.')}</p>}
      {open &&
        section.items.map((r) => (
          <div
            key={r.id}
            className="service-row"
            role="button"
            tabIndex={0}
            title={openable ? t('Open in a tab') : t('Open in the Cloudflare dashboard')}
            onClick={() => onClick(r)}
            onKeyDown={(e) => e.key === 'Enter' && onClick(r)}
          >
            <span className="title">{r.name}</span>
            <span className="meta">
              {r.detail && <span>{r.detail}</span>}
              {r.updatedAt && <span>{ago(r.updatedAt)}</span>}
              {openable && r.url && (
                <button
                  className="icon-btn"
                  title={t('Open in the Cloudflare dashboard')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDash(r);
                  }}
                >
                  <ExternalLink size={11} />
                </button>
              )}
            </span>
          </div>
        ))}
    </div>
  );
}
