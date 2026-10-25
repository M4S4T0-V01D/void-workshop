import { useEffect, useState } from 'react';
import { Download, RefreshCw, Save } from 'lucide-react';
import { call, errorText } from '../../api';
import type { PortalStatus, Settings, UpdateCheck } from '../../types';
import { Callout } from '../common';

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
        placeholder="wss://void-relay.<your-subdomain>.workers.dev"
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
              toast('info', s.relayUrl ? 'Relay address saved.' : 'Relay address cleared.');
            })
            .catch((err) => toast('error', errorText(err)))
        }
      >
        Save
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
      toast('info', `Installing VOID Workshop ${r.version}; it restarts by itself.`);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <>
      <h3>Updates</h3>
      <p className="muted">
        This is VOID Workshop {version}. Releases are signed with your Ed25519 release key; this build installs only packages whose signature matches the key
        built into it, and never an older version.
      </p>
      <div className="row">
        <button className="btn" onClick={run} disabled={busy !== null}>
          <RefreshCw size={13} className={busy === 'check' ? 'spin' : ''} /> Check for updates
        </button>
      </div>
      {error && <Callout tone="bad">{error}</Callout>}
      {check?.status === 'unavailable' && <Callout>{check.reason}</Callout>}
      {check?.status === 'current' && (
        <Callout>
          Up to date (the newest release on {check.source} is {check.latest}).
        </Callout>
      )}
      {check?.status === 'available' && (
        <Callout tone="warn">
          <b>VOID Workshop {check.release.version}</b> is available from {check.source}
          {check.release.date ? ` (${check.release.date.slice(0, 10)})` : ''}, signature checked.
          {check.release.notes && <pre className="update-notes">{check.release.notes}</pre>}
          <div className="row">
            <button className="btn primary" onClick={install} disabled={busy !== null}>
              <Download size={13} /> {busy === 'install' ? 'Downloading and checking…' : 'Install and restart'}
            </button>
            <span className="muted">Working tasks must finish first. The download is checked against the signed SHA-256 before anything is installed.</span>
          </div>
        </Callout>
      )}

      <h4>Where updates come from</h4>
      <p className="muted">
        Now: <b>{settings.updateRepo ? `GitHub releases of ${settings.updateRepo}` : 'the VOID Portal relay (needs a paired phone)'}</b>. Either way the package
        must be signed with the key built into this build, so changing the source can't install anything you didn't sign.
      </p>
      <p className="field-title">Update repository (owner/name)</p>
      <div className="row">
        <input
          className="input mono"
          value={repo}
          spellCheck={false}
          onChange={(e) => setRepo(e.target.value.trim())}
          placeholder="owner/void-workshop (empty: use the relay)"
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          className="btn"
          disabled={!repoOk || repo === settings.updateRepo}
          onClick={() =>
            void save({ updateRepo: repo }).then(() => {
              toast('info', repo ? `Updates now come from github.com/${repo}.` : 'Updates now come through the relay.');
              run();
            })
          }
        >
          <Save size={13} /> Save
        </button>
      </div>
      {!repoOk && <Callout tone="bad">Enter the repository as owner/name, e.g. octo/void-workshop.</Callout>}
      <p className="muted">
        The newest release tagged <code>workshop-v*</code> (not a draft or prerelease) with <code>latest.json</code> and the package attached, as{' '}
        <code>scripts/release.sh</code> publishes them. Private repositories work while you're signed in to GitHub (Settings → Accounts).
      </p>

      <p className="field-title">VOID Portal relay</p>
      <RelayField toast={toast} />
      <p className="muted">Used for updates when no repository is set, and always for VOID Portal on your phone (including the Portal app's own updates).</p>

      <h4>Running your own fork</h4>
      <p className="muted">
        Set your repository, relay Worker and R2 bucket once in <code>fork.json</code> with <code>scripts/fork-setup.sh</code>: it builds them in as the
        defaults and the release scripts publish there. Make your own signing key with <code>scripts/update-key.sh</code>. <code>guides/forking.md</code> walks
        through it.
      </p>
    </>
  );
}
