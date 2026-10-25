import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, LogIn, LogOut, Save, Trash2, X } from 'lucide-react';
import { call, errorText, onSidecarEvent, openServiceUrl } from '../../api';
import type { CloudflareStatus, GithubDeviceCode, GithubStatus, Settings } from '../../types';
import { Callout } from '../common';
import { CopyLink } from './AccountSections';
import { GithubMark, notifyServicesChanged } from '../ServicePanels';
import { locale, t, tx } from '../../i18n';

type ToastFn = (t: 'info' | 'warn' | 'error', m: string) => void;

const OAUTH_APPS = 'https://github.com/settings/developers';
const NEW_OAUTH_APP = 'https://github.com/settings/applications/new';
const CF_TOKENS = 'https://dash.cloudflare.com/profile/api-tokens';

const storedIn = (b: 'secret-service' | 'file' | null) =>
  b === 'secret-service' ? t('Desktop Secret Service (KWallet / GNOME Keyring)') : b === 'file' ? t('Owner-only key file (0600)') : '—';

/** One toast per finished sign-in, even when Settings and the panel both listen. */
let lastSignInToast = 0;

export function GithubSection({ settings, save, toast }: { settings: Settings; save: (p: Partial<Settings>) => Promise<void>; toast: ToastFn }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    call<GithubStatus>('github.status')
      .then((s) => live && setStatus(s))
      .catch((err) => toast('error', errorText(err)));
    const off = onSidecarEvent((e) => {
      if (e.event === 'github.changed') setStatus((e.payload as { status: GithubStatus }).status);
    });
    return () => {
      live = false;
      void off.then((f) => f());
    };
  }, [toast]);

  const signedIn = !!status?.configured && !status.problem;

  return (
    <>
      <h4>{t('GitHub')}</h4>
      <p>
        {tx(
          "Shows this project's pull requests, issues, Actions runs and releases in the GitHub panel, and opens pull requests and issues as editor tabs. The token stays in the backend; this window and the agent never see it. The agent keeps using {gh} with your approval.",
          { gh: <code>gh</code> },
        )}
      </p>
      <div className="kv">
        <span className="k">{t('Status')}</span>
        <span className="row">
          <span className={`dot ${signedIn ? 'ok' : status?.configured ? 'warn' : 'bad'}`} />
          {!status
            ? t('Checking…')
            : signedIn
              ? t('Signed in as {login}', { login: `${status.login}${status.name ? ` (${status.name})` : ''}` })
              : status.configured
                ? t('Token stored but not accepted')
                : t('Not signed in')}
        </span>
        {signedIn && (
          <>
            <span className="k">{t('Scopes')}</span>
            <span className="mono">{status.scopes.length ? status.scopes.join(', ') : 'fine-grained token'}</span>
            <span className="k">{t('Stored in')}</span>
            <span>{storedIn(status.backend)}</span>
            <span className="k">{t('Fingerprint')}</span>
            <span className="mono">{status.fingerprint}</span>
          </>
        )}
      </div>
      {status?.problem && <Callout tone="bad">{status.problem}</Callout>}

      {signedIn ? (
        <div className="row">
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              call<GithubStatus>('github.logout')
                .then((s) => {
                  setStatus(s);
                  notifyServicesChanged();
                })
                .catch((err) => toast('error', errorText(err)))
                .finally(() => setBusy(false));
            }}
          >
            <LogOut size={14} /> {t('Sign out of GitHub')}
          </button>
        </div>
      ) : (
        status && <GithubConnect settings={settings} save={save} toast={toast} pending={status.pending} onSignedIn={setStatus} />
      )}
    </>
  );
}

/**
 * Sign in to GitHub: the device flow with the user's OAuth App, or a pasted token. Used in Settings and,
 * compact, in the GitHub panel itself.
 */
export function GithubConnect({
  settings,
  save,
  toast,
  pending,
  onSignedIn,
  compact = false,
}: {
  settings: Settings;
  save: (p: Partial<Settings>) => Promise<void>;
  toast: ToastFn;
  pending: GithubDeviceCode | null;
  onSignedIn?: (s: GithubStatus) => void;
  compact?: boolean;
}) {
  const [clientId, setClientId] = useState(settings.githubClientId);
  const [editId, setEditId] = useState(!settings.githubClientId);
  const [code, setCode] = useState<GithubDeviceCode | null>(pending);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(!compact);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => setCode(pending), [pending]);
  useEffect(() => {
    const off = onSidecarEvent((e) => {
      if (e.event !== 'github.changed') return;
      const p = e.payload as { status: GithubStatus; error: string | null };
      setCode(null);
      notifyServicesChanged();
      if (Date.now() - lastSignInToast < 2000) return;
      lastSignInToast = Date.now();
      if (p.error) toast('error', p.error);
      else if (p.status.login) toast('info', t('Signed in to GitHub as {login}.', { login: p.status.login }));
    });
    return () => void off.then((f) => f());
  }, [toast]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const signIn = () =>
    run('login', async () => {
      const id = clientId.trim();
      if (id !== settings.githubClientId) await save({ githubClientId: id });
      setEditId(false);
      const c = await call<GithubDeviceCode>('github.login');
      setCode(c);
      await openServiceUrl(c.verificationUri);
    });

  const storeToken = () =>
    run('token', async () => {
      const s = await call<GithubStatus>('github.setToken', { token });
      setToken('');
      onSignedIn?.(s);
      notifyServicesChanged();
      toast('info', t('Signed in to GitHub as {login}.', { login: s.login ?? '' }));
    });

  if (code)
    return (
      <div className="device-code">
        <p>{t('Enter this code on GitHub (the page opened in your browser):')}</p>
        <div className="row wrap">
          <code className="code-big">{code.userCode}</code>
          <button className="btn small" onClick={() => void navigator.clipboard.writeText(code.userCode)}>
            {t('Copy')}
          </button>
          <button className="btn small" onClick={() => void openServiceUrl(code.verificationUri).catch((err) => toast('error', errorText(err)))}>
            <ExternalLink size={13} /> {t('Open {site}', { site: code.verificationUri.replace(/^https:\/\//, '') })}
          </button>
          <button
            className="btn small ghost"
            onClick={() =>
              void run('cancel', async () => {
                await call('github.loginCancel');
                setCode(null);
              })
            }
          >
            <X size={13} /> {t('Cancel')}
          </button>
        </div>
        <p className="muted row">
          <Loader2 size={12} className="spin" />{' '}
          {t('Waiting for GitHub… the code expires {time}.', { time: new Date(code.expiresAt).toLocaleTimeString(locale()) })}
        </p>
      </div>
    );

  return (
    <div className={compact ? 'service-connect' : undefined}>
      {editId ? (
        <>
          {!compact && <h4>{t('Sign in with your OAuth App')}</h4>}
          <Callout tone="info">
            {tx('Register an OAuth App on GitHub (any homepage and callback URL), tick {flow}, and paste its {id} here. No client secret is needed.', {
              flow: <b>Enable Device Flow</b>,
              id: <b>Client ID</b>,
            })}
          </Callout>
          <div className="row wrap">
            <button className="btn small" onClick={() => void openServiceUrl(NEW_OAUTH_APP).catch((err) => toast('error', errorText(err)))}>
              <ExternalLink size={13} /> {t('Register an OAuth App')}
            </button>
            {!compact && <CopyLink url={OAUTH_APPS} />}
          </div>
          <div className="row">
            <input
              style={{ flex: 1, minWidth: 0 }}
              placeholder={t('Client ID, e.g. Ov23li…')}
              value={clientId}
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value.trim())}
            />
            <button className="btn primary" disabled={!clientId || !!busy} onClick={() => void signIn()}>
              {busy === 'login' ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />} {t('Sign in')}
            </button>
          </div>
        </>
      ) : (
        <div className="row wrap">
          <button className="btn primary" disabled={!!busy} onClick={() => void signIn()}>
            {busy === 'login' ? <Loader2 size={14} className="spin" /> : <GithubMark size={14} />} {t('Sign in with GitHub')}
          </button>
          <button className="btn small ghost" title={t('Client ID {id}', { id: settings.githubClientId })} onClick={() => setEditId(true)}>
            {t('Change OAuth App')}
          </button>
        </div>
      )}

      {showToken ? (
        <>
          {compact ? <p className="muted">{t('Or paste a personal access token:')}</p> : <h4>{t('Or paste a token')}</h4>}
          {!compact && (
            <p className="muted">
              {tx(
                'A personal access token works too (classic with {scope}, or fine-grained with read access to the repositories, plus write to issues and pull requests for commenting).',
                { scope: <code>repo</code> },
              )}
            </p>
          )}
          <div className="row">
            <input
              type="password"
              style={{ flex: 1, minWidth: 0 }}
              placeholder={t('ghp_… or github_pat_…')}
              value={token}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && token && !busy && void storeToken()}
            />
            <button className="btn" disabled={!token || !!busy} onClick={() => void storeToken()}>
              {busy === 'token' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} {compact ? t('Use') : t('Store token')}
            </button>
          </div>
        </>
      ) : (
        <button className="link small" onClick={() => setShowToken(true)}>
          {t('Use a personal access token instead')}
        </button>
      )}
    </div>
  );
}

export function CloudflareSection({ toast }: { toast: ToastFn }) {
  const [status, setStatus] = useState<CloudflareStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    call<CloudflareStatus>('cloudflare.status')
      .then((s) => live && setStatus(s))
      .catch((err) => toast('error', errorText(err)));
    return () => {
      live = false;
    };
  }, [toast]);

  const run = async (fn: () => Promise<CloudflareStatus>, done?: string) => {
    setBusy(true);
    try {
      setStatus(await fn());
      notifyServicesChanged();
      if (done) toast('info', done);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ok = !!status?.configured && !status.problem;

  return (
    <>
      <h4>{t('Cloudflare')}</h4>
      <p>
        {tx(
          "Lists Workers, Pages projects, R2 buckets, D1 databases and KV namespaces in the Cloudflare panel, and opens a Worker's deployed code as a read-only editor tab. Cloudflare has no sign-in for desktop apps, so this uses an API token you create. It stays in the backend; the agent keeps using {wrangler} with its own login.",
          { wrangler: <code>wrangler</code> },
        )}
      </p>
      <div className="kv">
        <span className="k">{t('Status')}</span>
        <span className="row">
          <span className={`dot ${ok ? 'ok' : status?.configured ? 'warn' : 'bad'}`} />
          {!status
            ? t('Checking…')
            : ok
              ? t('Token {status}', { status: status.tokenStatus ?? 'active' })
              : status.configured
                ? t('Token stored but not accepted')
                : t('No token')}
        </span>
        {ok && (
          <>
            <span className="k">{t('Accounts')}</span>
            <span>{status.accounts.map((a) => a.name).join(', ') || 'none visible to this token'}</span>
            <span className="k">{t('Expires')}</span>
            <span>{status.expiresOn ? new Date(status.expiresOn).toLocaleDateString() : 'never'}</span>
            <span className="k">{t('Stored in')}</span>
            <span>{storedIn(status.backend)}</span>
            <span className="k">{t('Fingerprint')}</span>
            <span className="mono">{status.fingerprint}</span>
          </>
        )}
      </div>
      {status?.problem && <Callout tone="bad">{status.problem}</Callout>}
      {status?.configured ? (
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => void run(() => call<CloudflareStatus>('cloudflare.logout'), t('Cloudflare token removed.'))}>
            <Trash2 size={14} /> {t('Remove token')}
          </button>
        </div>
      ) : (
        status && <CloudflareConnect toast={toast} onConnected={setStatus} />
      )}
    </>
  );
}

/** Store a Cloudflare API token; used in Settings and, compact, in the Cloudflare panel. */
export function CloudflareConnect({ toast, onConnected, compact = false }: { toast: ToastFn; onConnected?: (s: CloudflareStatus) => void; compact?: boolean }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const store = async () => {
    setBusy(true);
    try {
      const s = await call<CloudflareStatus>('cloudflare.setToken', { token });
      setToken('');
      onConnected?.(s);
      notifyServicesChanged();
      toast('info', t('Cloudflare token stored and checked.'));
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? 'service-connect' : undefined}>
      <Callout tone="info">
        {compact ? (
          <>
            {tx("Create an API token with the {template} template and paste it here. Don't use the Global API Key.", { template: <b>Read all resources</b> })}
          </>
        ) : (
          <>
            {tx(
              "Create a token under My Profile → API Tokens with the {template} template (or a custom token with Account Settings, Workers Scripts, Pages, R2, D1 and Workers KV set to Read). Don't use the Global API Key.",
              { template: <b>Read all resources</b> },
            )}
          </>
        )}
      </Callout>
      <div className="row">
        <button className="btn small" onClick={() => void openServiceUrl(CF_TOKENS).catch((err) => toast('error', errorText(err)))}>
          <ExternalLink size={13} /> {t('Open API Tokens')}
        </button>
      </div>
      <div className="row">
        <input
          type="password"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={t('Cloudflare API token')}
          value={token}
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token && !busy && void store()}
        />
        <button className="btn primary" disabled={!token || busy} onClick={() => void store()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} {compact ? t('Connect') : t('Store token')}
        </button>
      </div>
    </div>
  );
}

export function ServicesPlacement({ settings, save }: { settings: Settings; save: (p: Partial<Settings>) => Promise<void> }) {
  return (
    <>
      <h4>{t('Panel placement')}</h4>
      <div className="row">
        <span>{t('GitHub and Cloudflare panels')}</span>
        <select value={settings.servicesPanel} onChange={(e) => void save({ servicesPanel: e.target.value as Settings['servicesPanel'] })}>
          <option value="right">{t('Right panel')}</option>
          <option value="left">{t('Left panel')}</option>
        </select>
      </div>
      <p className="muted">{t("The arrow button in each panel's header moves them too.")}</p>
    </>
  );
}
