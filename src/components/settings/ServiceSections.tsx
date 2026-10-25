import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, LogIn, LogOut, Save, Trash2, X } from 'lucide-react';
import { call, errorText, onSidecarEvent, openServiceUrl } from '../../api';
import type { CloudflareStatus, GithubDeviceCode, GithubStatus, Settings } from '../../types';
import { Callout } from '../common';
import { CopyLink } from './AccountSections';
import { notifyServicesChanged } from '../ServicePanels';

type ToastFn = (t: 'info' | 'warn' | 'error', m: string) => void;

const OAUTH_APPS = 'https://github.com/settings/developers';
const CF_TOKENS = 'https://dash.cloudflare.com/profile/api-tokens';

const storedIn = (b: 'secret-service' | 'file' | null) =>
  b === 'secret-service' ? 'Desktop Secret Service (KWallet / GNOME Keyring)' : b === 'file' ? 'Owner-only key file (0600)' : '—';

export function GithubSection({ settings, save, toast }: { settings: Settings; save: (p: Partial<Settings>) => Promise<void>; toast: ToastFn }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [clientId, setClientId] = useState(settings.githubClientId);
  const [code, setCode] = useState<GithubDeviceCode | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call<GithubStatus>('github.status')
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setCode(s.pending);
      })
      .catch((err) => toast('error', errorText(err)));
    const off = onSidecarEvent((e) => {
      if (e.event !== 'github.changed') return;
      const p = e.payload as { status: GithubStatus; error: string | null };
      setStatus(p.status);
      setCode(null);
      if (p.error) toast('error', p.error);
      else if (p.status.login) toast('info', `Signed in to GitHub as ${p.status.login}.`);
      notifyServicesChanged();
    });
    return () => {
      live = false;
      void off.then((f) => f());
    };
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
      if (clientId !== settings.githubClientId) await save({ githubClientId: clientId.trim() });
      const c = await call<GithubDeviceCode>('github.login');
      setCode(c);
      await openServiceUrl(c.verificationUri);
    });

  const signedIn = !!status?.configured && !status.problem;

  return (
    <>
      <h4>GitHub</h4>
      <p>
        Shows this project's pull requests, issues, Actions runs and releases in the GitHub panel, and opens pull requests and issues as editor tabs. The token
        stays in the backend; this window and the agent never see it. The agent keeps using <code>gh</code> with your approval.
      </p>
      <div className="kv">
        <span className="k">Status</span>
        <span className="row">
          <span className={`dot ${signedIn ? 'ok' : status?.configured ? 'warn' : 'bad'}`} />
          {!status
            ? 'Checking…'
            : signedIn
              ? `Signed in as ${status.login}${status.name ? ` (${status.name})` : ''}`
              : status.configured
                ? 'Token stored but not accepted'
                : 'Not signed in'}
        </span>
        {signedIn && (
          <>
            <span className="k">Scopes</span>
            <span className="mono">{status.scopes.length ? status.scopes.join(', ') : 'fine-grained token'}</span>
            <span className="k">Stored in</span>
            <span>{storedIn(status.backend)}</span>
            <span className="k">Fingerprint</span>
            <span className="mono">{status.fingerprint}</span>
          </>
        )}
      </div>
      {status?.problem && <Callout tone="bad">{status.problem}</Callout>}

      {signedIn ? (
        <div className="row">
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              void run('logout', async () => {
                setStatus(await call<GithubStatus>('github.logout'));
                notifyServicesChanged();
              })
            }
          >
            <LogOut size={14} /> Sign out of GitHub
          </button>
        </div>
      ) : (
        <>
          <h4>Sign in with your OAuth App</h4>
          <Callout tone="info">
            Register an OAuth App at GitHub → Settings → Developer settings → OAuth Apps (any homepage and callback URL), tick <b>Enable Device Flow</b>, and
            paste its <b>Client ID</b> here. No client secret is needed.
          </Callout>
          <CopyLink url={OAUTH_APPS} />
          <div className="row">
            <input
              style={{ flex: 1 }}
              placeholder="Client ID, e.g. Ov23li…"
              value={clientId}
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value.trim())}
            />
            <button className="btn ghost" disabled={clientId === settings.githubClientId} onClick={() => void save({ githubClientId: clientId })}>
              <Save size={14} /> Save
            </button>
            <button className="btn primary" disabled={!clientId || !!busy || !!code} onClick={() => void signIn()}>
              {busy === 'login' ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />} Sign in
            </button>
          </div>
          {code && (
            <div className="device-code">
              <p>Enter this code on GitHub (the page opened in your browser):</p>
              <div className="row">
                <code className="code-big">{code.userCode}</code>
                <button className="btn small" onClick={() => void navigator.clipboard.writeText(code.userCode)}>
                  Copy
                </button>
                <button className="btn small" onClick={() => void openServiceUrl(code.verificationUri).catch((err) => toast('error', errorText(err)))}>
                  <ExternalLink size={13} /> Open {code.verificationUri.replace(/^https:\/\//, '')}
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
                  <X size={13} /> Cancel
                </button>
              </div>
              <p className="muted row">
                <Loader2 size={12} className="spin" /> Waiting for GitHub… the code expires {new Date(code.expiresAt).toLocaleTimeString()}.
              </p>
            </div>
          )}

          <h4>Or paste a token</h4>
          <p className="muted">
            A personal access token works too (classic with <code>repo</code>, or fine-grained with read access to the repositories, plus write to issues and
            pull requests for commenting).
          </p>
          <div className="row">
            <input
              type="password"
              style={{ flex: 1 }}
              placeholder="ghp_… or github_pat_…"
              value={token}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              className="btn"
              disabled={!token || !!busy}
              onClick={() =>
                void run('token', async () => {
                  const s = await call<GithubStatus>('github.setToken', { token });
                  setToken('');
                  setStatus(s);
                  notifyServicesChanged();
                  toast('info', `Signed in to GitHub as ${s.login}.`);
                })
              }
            >
              {busy === 'token' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} Store token
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function CloudflareSection({ toast }: { toast: ToastFn }) {
  const [status, setStatus] = useState<CloudflareStatus | null>(null);
  const [token, setToken] = useState('');
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
      <h4>Cloudflare</h4>
      <p>
        Lists Workers, Pages projects, R2 buckets, D1 databases and KV namespaces in the Cloudflare panel, and opens a Worker's deployed code as a read-only
        editor tab. Cloudflare has no sign-in for desktop apps, so this uses an API token you create. It stays in the backend; the agent keeps using{' '}
        <code>wrangler</code> with its own login.
      </p>
      <div className="kv">
        <span className="k">Status</span>
        <span className="row">
          <span className={`dot ${ok ? 'ok' : status?.configured ? 'warn' : 'bad'}`} />
          {!status ? 'Checking…' : ok ? `Token ${status.tokenStatus ?? 'active'}` : status.configured ? 'Token stored but not accepted' : 'No token'}
        </span>
        {ok && (
          <>
            <span className="k">Accounts</span>
            <span>{status.accounts.map((a) => a.name).join(', ') || 'none visible to this token'}</span>
            <span className="k">Expires</span>
            <span>{status.expiresOn ? new Date(status.expiresOn).toLocaleDateString() : 'never'}</span>
            <span className="k">Stored in</span>
            <span>{storedIn(status.backend)}</span>
            <span className="k">Fingerprint</span>
            <span className="mono">{status.fingerprint}</span>
          </>
        )}
      </div>
      {status?.problem && <Callout tone="bad">{status.problem}</Callout>}
      {status?.configured ? (
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => void run(() => call<CloudflareStatus>('cloudflare.logout'), 'Cloudflare token removed.')}>
            <Trash2 size={14} /> Remove token
          </button>
        </div>
      ) : (
        <>
          <Callout tone="info">
            Create a token under My Profile → API Tokens with the <b>Read all resources</b> template (or a custom token with Account Settings, Workers Scripts,
            Pages, R2, D1 and Workers KV set to Read). Don't use the Global API Key.
          </Callout>
          <div className="row">
            <button className="btn small" onClick={() => void openServiceUrl(CF_TOKENS).catch((err) => toast('error', errorText(err)))}>
              <ExternalLink size={13} /> Open API Tokens
            </button>
          </div>
          <div className="row">
            <input
              type="password"
              style={{ flex: 1 }}
              placeholder="Cloudflare API token"
              value={token}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              className="btn primary"
              disabled={!token || busy}
              onClick={() =>
                void run(async () => {
                  const s = await call<CloudflareStatus>('cloudflare.setToken', { token });
                  setToken('');
                  return s;
                }, 'Cloudflare token stored and checked.')
              }
            >
              {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} Store token
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function ServicesPlacement({ settings, save }: { settings: Settings; save: (p: Partial<Settings>) => Promise<void> }) {
  return (
    <>
      <h4>Panel placement</h4>
      <div className="row">
        <span>Show the GitHub and Cloudflare panels in the</span>
        <select value={settings.servicesPanel} onChange={(e) => void save({ servicesPanel: e.target.value as Settings['servicesPanel'] })}>
          <option value="right">right panel</option>
          <option value="left">left panel</option>
        </select>
      </div>
      <p className="muted">The arrow button in each panel's header moves them too.</p>
    </>
  );
}
