import { useEffect, useState } from 'react';
import { Copy, ExternalLink, KeyRound, LogIn, LogOut, RefreshCw, Trash2 } from 'lucide-react';
import { call, errorText, onSidecarEvent, openLoginUrl } from '../../api';
import type { InitData, KeyStatus, ModelEntry, Settings, SubscriptionStatus, VerifyResult } from '../../types';
import { Callout, timeAgo } from '../common';
import type { WindowMethod } from '../../rpcMethods';
import { t, tn, tx } from '../../i18n';

export const CONSOLE = {
  keys: 'https://platform.claude.com/settings/keys',
  workspaces: 'https://platform.claude.com/settings/workspaces',
  billing: 'https://platform.claude.com/settings/billing',
  limits: 'https://platform.claude.com/settings/limits',
  usage: 'https://platform.claude.com/usage',
};

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="row">
      <code>{url}</code>
      <button
        className="icon-btn"
        title={t('Copy link')}
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        <Copy size={13} />
      </button>
      {copied && <span className="muted">{t('copied')}</span>}
    </span>
  );
}

export function SubscriptionSection({
  init,
  settings,
  save,
  onSubscription,
  onPlanLimitCleared,
  toast,
}: {
  init: InitData;
  settings: Settings;
  save: (p: Partial<Settings>) => Promise<void>;
  onSubscription: (s: SubscriptionStatus, models: ModelEntry[]) => void;
  onPlanLimitCleared: () => void;
  toast: (t: 'info' | 'warn' | 'error', m: string) => void;
}) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(init.subscription);
  const [busy, setBusy] = useState<'login' | 'check' | 'logout' | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');

  // The runtime produces the sign-in link; the shell opens it in the browser (the backend has no display).
  useEffect(() => {
    const un = onSidecarEvent(({ event, payload }) => {
      if (event !== 'auth.loginUrl') return;
      const p = payload as { url?: unknown; manualUrl?: unknown };
      const u = String(p.url ?? '');
      setManualUrl(typeof p.manualUrl === 'string' ? p.manualUrl : null);
      // Open each new link once (the same event repeats when the fallback link becomes known).
      setUrl((prev) => {
        if (prev !== u) void openLoginUrl(u).catch((err) => toast('warn', `${errorText(err)} ${t('Open the link below yourself.')}`));
        return u;
      });
    });
    return () => void un.then((f) => f());
  }, [toast]);

  const run = async (kind: 'login' | 'check' | 'logout', method: WindowMethod, done: (s: SubscriptionStatus) => string | null) => {
    setBusy(kind);
    try {
      const r = await call<{ status: SubscriptionStatus; models: ModelEntry[] }>(method);
      setStatus(r.status);
      onSubscription(r.status, r.models);
      const msg = done(r.status);
      if (r.status.problem) toast('warn', r.status.problem);
      else if (msg) toast('info', msg);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
      setUrl(null);
    }
  };

  const who = status?.signedIn
    ? `${status.email ?? t('Signed in')}${status.subscriptionType ? ` · ${t('{plan} plan', { plan: status.subscriptionType })}` : ''}`
    : t('Not signed in');
  const limit = init.planLimited && init.planLimited.until > Date.now() ? init.planLimited : null;

  return (
    <>
      <h4>{t('Claude plan (Pro / Max)')}</h4>
      <p>
        {t(
          "Sign in with your Claude account to use your plan's usage instead of API credit. The sign-in runs in the Claude Code runtime that ships with VOID Workshop and is kept in VOID Workshop's own data folder, separate from your normal Claude Code login. This window never sees the tokens. Approvals, the sandbox and the turn limit apply the same way; the dollar limits only apply to the API key.",
        )}
      </p>
      <div className="kv">
        <span className="k">{t('Status')}</span>
        <span className="row">
          <span className={`dot ${status?.signedIn ? (limit ? 'warn' : 'ok') : 'bad'}`} />
          {who}
        </span>
        {limit && (
          <>
            <span className="k">{t('Usage')}</span>
            <span className="row">
              {limit.message}
              <button
                className="btn small"
                onClick={() =>
                  void call('auth.clearPlanLimit')
                    .then(onPlanLimitCleared)
                    .catch((err) => toast('error', errorText(err)))
                }
              >
                {t('Try the plan again now')}
              </button>
            </span>
          </>
        )}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {busy === 'login' ? (
          <button className="btn" onClick={() => void call('auth.subscriptionLoginCancel')}>
            {t('Cancel sign-in')}
          </button>
        ) : (
          <button
            className={`btn ${status?.signedIn ? '' : 'primary'}`}
            disabled={!!busy}
            onClick={() =>
              void run('login', 'auth.subscriptionLogin', (s) =>
                s.signedIn ? (s.email ? t('Signed in to your Claude plan as {email}.', { email: s.email }) : t('Signed in to your Claude plan.')) : null,
              )
            }
          >
            <LogIn size={14} /> {status?.signedIn ? t('Sign in again') : t('Sign in with Claude')}
          </button>
        )}
        <button className="btn" disabled={!!busy} onClick={() => void run('check', 'auth.subscriptionStatus', () => null)}>
          <RefreshCw size={14} className={busy === 'check' ? 'spin' : ''} /> {t('Check')}
        </button>
        {status?.signedIn && (
          <button
            className="btn danger"
            disabled={!!busy}
            onClick={() => void run('logout', 'auth.subscriptionLogout', () => t('Signed out of your Claude plan.'))}
          >
            <LogOut size={14} /> {t('Sign out')}
          </button>
        )}
      </div>
      {busy === 'login' && (
        <Callout tone="info">
          {t('Finish signing in in your browser; this updates by itself when you are done.')}
          {url && (
            <>
              {' '}
              {t('If no browser tab opened:')}{' '}
              <button className="btn small" onClick={() => void openLoginUrl(url).catch((err) => toast('error', errorText(err)))}>
                <ExternalLink size={13} /> {t('Open again')}
              </button>
              <CopyLink url={url} />
            </>
          )}
          <div style={{ marginTop: 8 }}>
            {tx('If the page says {quote}, paste that code here:', { quote: <i>Paste this into Claude Code</i> })}
            <div className="row" style={{ marginTop: 6 }}>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={code}
                placeholder={t('Authentication code')}
                onChange={(e) => setCode(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="btn small primary"
                disabled={!code.trim()}
                onClick={() =>
                  void call('auth.subscriptionLoginCode', { code })
                    .then(() => setCode(''))
                    .catch((err) => toast('error', errorText(err)))
                }
              >
                {t('Submit code')}
              </button>
            </div>
            {manualUrl && manualUrl !== url && (
              <button
                className="btn small ghost"
                style={{ marginTop: 6 }}
                onClick={() => void openLoginUrl(manualUrl).catch((err) => toast('error', errorText(err)))}
              >
                <ExternalLink size={13} /> {t('Sign in with a code instead')}
              </button>
            )}
          </div>
        </Callout>
      )}

      <h4>{t('Which account pays')}</h4>
      <div className="row wrap">
        <label className="check">
          <input type="radio" checked={settings.anthropicAuth === 'subscription'} onChange={() => void save({ anthropicAuth: 'subscription' })} />
          <span>
            {t('Claude plan')} <span className="muted">{t("(your subscription's usage limits)")}</span>
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={settings.anthropicAuth === 'api-key'} onChange={() => void save({ anthropicAuth: 'api-key' })} />
          <span>
            {t('API key')} <span className="muted">{t('(Console credit, billed per token)')}</span>
          </span>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={settings.authFallback} onChange={(e) => void save({ authFallback: e.target.checked })} />
        <span>
          {t(
            "Switch when one runs out. When the Claude plan hits its usage limit, the task continues with the API key (spending limits still apply); when the API key runs out of credit, it continues with the plan. It switches back once the plan's limit resets.",
          )}
        </span>
      </label>
      <p className="muted">
        {t('You can also switch from the account button under the prompt box. A running conversation carries over to the other account.')}
      </p>
    </>
  );
}

export function KeySection({
  init,
  onAuth,
  onModels,
  toast,
}: {
  init: InitData;
  onAuth: (s: KeyStatus) => void;
  onModels: (m: ModelEntry[], v: VerifyResult) => void;
  toast: (t: 'info' | 'warn' | 'error', m: string) => void;
}) {
  const [status, setStatus] = useState<KeyStatus>(init.auth);
  const [key, setKey] = useState('');
  const [backend, setBackend] = useState<'secret-service' | 'file'>(init.auth.secretServiceAvailable ? 'secret-service' : 'file');
  const [busy, setBusy] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(init.lastVerify ? ({ ...init.lastVerify } as VerifyResult) : null);

  const runVerify = async () => {
    setBusy('verify');
    try {
      const res = await call<VerifyResult>('auth.verify');
      setVerify(res);
      if (res.ok && res.models) {
        onModels(res.models, res);
        toast('info', tn(res.models.length, 'Key verified. {n} model available to this key.', 'Key verified. {n} models available to this key.'));
      } else toast('error', res.message ?? t('Verification failed'));
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const store = async () => {
    setBusy('store');
    try {
      const s = await call<KeyStatus>('auth.setKey', { key, backend });
      setKey('');
      setStatus(s);
      onAuth(s);
      toast('info', t('Key stored. Verifying with the Models API (free)…'));
      await runVerify();
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      const s = await call<KeyStatus>('auth.deleteKey');
      setStatus(s);
      onAuth(s);
      setVerify(null);
      toast('info', t('Key removed from this computer.'));
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h4>{t('Anthropic Console API key')}</h4>
      <p>
        {tx(
          'Used when {account} is selected above (or as the fallback). The key is never sent to local providers such as Ollama and is not loaded while the Claude plan is in use. The key stays in the backend; this window never displays it.',
          { account: <b>{t('API key')}</b> },
        )}
      </p>
      <div className="kv">
        <span className="k">{t('Status')}</span>
        <span className="row">
          <span className={`dot ${status.configured && status.formatOk ? 'ok' : status.configured ? 'warn' : 'bad'}`} />
          {status.configured ? (status.formatOk ? t('Key stored') : t('Stored key is invalid')) : t('No key configured')}
        </span>
        <span className="k">{t('Stored in')}</span>
        <span>
          {status.backend === 'secret-service'
            ? t('Desktop Secret Service (KWallet / GNOME Keyring)')
            : status.backend === 'file'
              ? t('Owner-only key file (0600)')
              : '—'}
        </span>
        <span className="k">{t('Fingerprint')}</span>
        <span className="mono">{status.fingerprint ? t('{fingerprint} (SHA-256 prefix, not the key)', { fingerprint: status.fingerprint }) : '—'}</span>
        <span className="k">{t('Last check')}</span>
        <span>
          {verify
            ? verify.ok
              ? t('OK {when}', { when: timeAgo(verify.checkedAt) })
              : `${verify.message ?? t('Failed')} (${timeAgo(verify.checkedAt)})`
            : t('Not verified yet')}
        </span>
      </div>
      {status.problem && <Callout tone="bad">{status.problem}</Callout>}

      <h4>{status.configured ? t('Replace the key') : t('Add a key')}</h4>
      <Callout tone="info">
        {t(
          'Create a dedicated workspace and key for this app in the Console, and paste the key here (not into a chat). Recommended: workspace spend limit as low as practical, no auto-reload.',
        )}
      </Callout>
      <label className="field">
        {t('API key')}
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('sk-ant-…')}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <div className="row wrap">
        <label className="check">
          <input type="radio" checked={backend === 'secret-service'} disabled={!status.secretServiceAvailable} onChange={() => setBackend('secret-service')} />
          <span>
            {t('Desktop Secret Service')} <span className="muted">{status.secretServiceAvailable ? t('(recommended)') : t('(not available)')}</span>
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={backend === 'file'} onChange={() => setBackend('file')} />
          <span>
            {t('Owner-only file')} <span className="muted">{t('(headless setups)')}</span>
          </span>
        </label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={!key.trim() || !!busy} onClick={() => void store()}>
          <KeyRound size={14} /> {t('Save key')}
        </button>
        <button className="btn" disabled={!status.configured || !!busy} onClick={() => void runVerify()}>
          <RefreshCw size={14} className={busy === 'verify' ? 'spin' : ''} /> {t('Verify (free)')}
        </button>
        <span className="spacer grow" />
        <button className="btn danger" disabled={!status.configured || !!busy} onClick={() => void remove()}>
          <Trash2 size={14} /> {t('Remove key')}
        </button>
      </div>
      <h4>{t('If a key is compromised')}</h4>
      <p>
        {tx(
          '1. Disable or delete it in the Console (Settings → API keys). 2. Create a new key in the same workspace. 3. Click {button}, then save the new key here. Revoking in the Console is what stops the old key from working; removing it here only deletes the local copy.',
          { button: <b>{t('Remove key')}</b> },
        )}
      </p>
      <CopyLink url={CONSOLE.keys} />
    </>
  );
}
