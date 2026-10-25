import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { call, errorText } from '../../api';
import type { UpdateCheck } from '../../types';
import { Callout } from '../common';

/** Signed desktop updates (sidecar/src/updater.ts): check, read the notes, install and restart. */
export function UpdateSection({ version, toast }: { version: string; toast: (tone: 'info' | 'warn' | 'error', text: string) => void }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
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
      {check?.status === 'current' && <Callout>Up to date (the newest release is {check.latest}).</Callout>}
      {check?.status === 'available' && (
        <Callout tone="warn">
          <b>VOID Workshop {check.release.version}</b> is available{check.release.date ? ` (${check.release.date.slice(0, 10)})` : ''}, signature checked.
          {check.release.notes && <pre className="update-notes">{check.release.notes}</pre>}
          <div className="row">
            <button className="btn primary" onClick={install} disabled={busy !== null}>
              <Download size={13} /> {busy === 'install' ? 'Downloading and checking…' : 'Install and restart'}
            </button>
            <span className="muted">Working tasks must finish first. The download is checked against the signed SHA-256 before anything is installed.</span>
          </div>
        </Callout>
      )}
    </>
  );
}
