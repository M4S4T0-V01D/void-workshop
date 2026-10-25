import { useEffect, useState } from 'react';
import { Download, RefreshCw, Save } from 'lucide-react';
import { call, errorText } from '../../api';
import type { PortalStatus, Settings, UpdateCheck } from '../../types';
import { Callout } from '../common';
import { t, tx } from '../../i18n';

type ToastFn = (tone: 'info' | 'warn' | 'error', text: string) => void;
const REPO = /^(?:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})?$/;

/** The VOID Portal relay address; shown under Updates and under VOID Portal (both edit the same value). */
export function RelayField({ toast, onSaved }: { toast: ToastFn; onSaved?: (s: PortalStatus) => void }) {
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [relay, setRelay] = useState('');
  useEffect(() => {
    call<PortalStatus>('remote.status')
      .then((s) => {
        setStatus(s);
        setRelay(s.relayUrl);
      })
      .catch((err) => toast('error', errorText(err)));
  }, [toast]);
  return (
    <div className="row">
      <input
        className="input mono"
        value={relay}
        onChange={(e) => setRelay(e.target.value.trim())}
        placeholder={t('wss://void-relay.<your-subdomain>.workers.dev')}
        style={{ flex: 1, minWidth: 0 }}
      />
      <button
        className="btn"
        disabled={!status || relay === status.relayUrl}
        onClick={() =>
          void call<PortalStatus>('remote.setRelay', { url: relay })
            .then((s) => {
              setStatus(s);
              setRelay(s.relayUrl);
              onSaved?.(s);
              toast('info', s.relayUrl ? t('Relay address saved.') : t('Relay address cleared.'));
            })
            .catch((err) => toast('error', errorText(err)))
        }
      >
        {t('Save')}
      </button>
    </div>
  );
}

/** Signed desktop updates (sidecar/src/updater.ts): check, read the notes, install and restart. */
export function UpdateSection({
  version,
  settings,
  save,
  toast,
}: {
  version: string;
  settings: Settings;
  save: (p: Partial<Settings>) => Promise<void>;
  toast: ToastFn;
}) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [repo, setRepo] = useState(settings.updateRepo);
  const repoOk = REPO.test(repo);
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setBusy('check');
    setError(null);
    call<UpdateCheck>('app.update.check', {})
      .then(setCheck, (err) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };
  useEffect(run, []);

  const install = async () => {
    setBusy('install');
    setError(null);
    try {
      const r = await call<{ version: string }>('app.update.install', {});
      toast('info', t('Installing VOID Workshop {version}; it restarts by itself.', { version: r.version }));
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <>
      <h3>{t('Updates')}</h3>
      <p className="muted">
        {t(
          'This is VOID Workshop {version}. Releases are signed with your Ed25519 release key; this build installs only packages whose signature matches the key built into it, and never an older version.',
          { version },
        )}
      </p>
      <div className="row">
        <button className="btn" onClick={run} disabled={busy !== null}>
          <RefreshCw size={13} className={busy === 'check' ? 'spin' : ''} /> {t('Check for updates')}
        </button>
      </div>
      {error && <Callout tone="bad">{error}</Callout>}
      {check?.status === 'unavailable' && <Callout>{check.reason}</Callout>}
      {check?.status === 'current' && (
        <Callout>{t('Up to date (the newest release on {source} is {latest}).', { source: check.source, latest: check.latest })}</Callout>
      )}
      {check?.status === 'available' && (
        <Callout tone="warn">
          {tx('{name} is available from {source}{date}, signature checked.', {
            name: <b>VOID Workshop {check.release.version}</b>,
            source: check.source,
            date: check.release.date ? ` (${check.release.date.slice(0, 10)})` : '',
          })}
          {check.release.notes && <pre className="update-notes">{check.release.notes}</pre>}
          <div className="row">
            <button className="btn primary" onClick={install} disabled={busy !== null}>
              <Download size={13} /> {busy === 'install' ? t('Downloading and checking…') : t('Install and restart')}
            </button>
            <span className="muted">
              {t('Working tasks must finish first. The download is checked against the signed SHA-256 before anything is installed.')}
            </span>
          </div>
        </Callout>
      )}

      <h4>{t('Where updates come from')}</h4>
      <p className="muted">
        {tx(
          "Now: {source}. Either way the package must be signed with the key built into this build, so changing the source can't install anything you didn't sign.",
          {
            source: (
              <b>{settings.updateRepo ? t('GitHub releases of {repo}', { repo: settings.updateRepo }) : t('the VOID Portal relay (needs a paired phone)')}</b>
            ),
          },
        )}
      </p>
      <p className="field-title">{t('Update repository (owner/name)')}</p>
      <div className="row">
        <input
          className="input mono"
          value={repo}
          spellCheck={false}
          onChange={(e) => setRepo(e.target.value.trim())}
          placeholder={t('owner/void-workshop (empty: use the relay)')}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          className="btn"
          disabled={!repoOk || repo === settings.updateRepo}
          onClick={() =>
            void save({ updateRepo: repo }).then(() => {
              toast('info', repo ? t('Updates now come from {repo}.', { repo: `github.com/${repo}` }) : t('Updates now come through the relay.'));
              run();
            })
          }
        >
          <Save size={13} /> {t('Save')}
        </button>
      </div>
      {!repoOk && <Callout tone="bad">{t('Enter the repository as owner/name, e.g. octo/void-workshop.')}</Callout>}
      <p className="muted">
        {tx(
          "The newest release tagged {tag} (not a draft or prerelease) with {manifest} and the package attached, as {script} publishes them. Private repositories work while you're signed in to GitHub (Settings → Accounts).",
          { tag: <code>workshop-v*</code>, manifest: <code>latest.json</code>, script: <code>scripts/release.sh</code> },
        )}
      </p>

      <p className="field-title">{t('VOID Portal relay')}</p>
      <RelayField toast={toast} />
      <p className="muted">
        {t("Used for updates when no repository is set, and always for VOID Portal on your phone (including the Portal app's own updates).")}
      </p>

      <h4>{t('Running your own fork')}</h4>
      <p className="muted">
        {tx(
          'Set your repository, relay Worker and R2 bucket once in {config} with {setup}: it builds them in as the defaults and the release scripts publish there. Make your own signing key with {key}. {guide} walks through it.',
          {
            config: <code>fork.json</code>,
            setup: <code>scripts/fork-setup.sh</code>,
            key: <code>scripts/update-key.sh</code>,
            guide: <code>guides/forking.md</code>,
          },
        )}
      </p>
    </>
  );
}
