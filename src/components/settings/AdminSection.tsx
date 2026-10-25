import { useState } from 'react';
import { call, errorText } from '../../api';
import type { AdminStatus } from '../../types';
import { Callout, timeAgo } from '../common';
import type { WindowMethod } from '../../rpcMethods';

export function AdminSection({
  status,
  onAdmin,
  toast,
}: {
  status: AdminStatus;
  onAdmin: (s: AdminStatus) => void;
  toast: (t: 'info' | 'warn' | 'error', m: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (method: WindowMethod, params: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      onAdmin(await call<AdminStatus>(method, params));
      setPassword('');
      setCurrent('');
      setNext('');
      setRepeat('');
      setChanging(false);
      toast('info', done);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const newPassword = (label: string, extra: Record<string, unknown>, done: string) => (
    <>
      <div className="grid2">
        <label className="field">
          New password
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="field">
          Repeat it
          <input className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={busy || next.length < 6 || next !== repeat}
          onClick={() => void run('admin.setPassword', { password: next, ...extra }, done)}
        >
          {label}
        </button>
        <span className="muted">{next && repeat && next !== repeat ? 'The two passwords differ.' : 'At least 6 characters.'}</span>
      </div>
    </>
  );

  return (
    <>
      <h4>Admin dev session</h4>
      <p>
        With your admin password the agent may work on VOID Workshop and VOID Portal themselves: their source
        {status.sourceDir && (
          <>
            {' '}
            (<code>{status.sourceDir}</code>)
          </>
        )}
        , Workshop&apos;s logs and database, full access with Auto publishing, and installing a new build and restarting into it (the task then continues on its
        own). Start and end it here or in VOID Portal. Ending it puts everything back to normal and stops tasks still working in it. Your keys, Claude sign-in,
        phone pairings and this password stay out of the agent&apos;s reach either way.
      </p>
      {!status.sourceDir && (
        <Callout tone="warn">
          The VOID Workshop source folder was not found. Open it as a project once (or install from it with <code>./scripts/install.sh</code>) so admin sessions
          know where to work.
        </Callout>
      )}
      {status.lockedUntil && <Callout tone="warn">Too many wrong passwords: locked until {new Date(status.lockedUntil).toLocaleTimeString()}.</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}

      {!status.passwordSet ? (
        <>
          <p className="muted">Set the admin password first. VOID Portal can change it later, but not set the first one.</p>
          {newPassword('Set admin password', {}, 'Admin password set.')}
        </>
      ) : status.active ? (
        <>
          <Callout tone="warn">
            Admin session running since {status.since ? timeAgo(status.since) : '—'}, started{' '}
            {status.by === 'phone' ? `from ${status.device ?? 'a phone'}` : 'on this PC'}.
          </Callout>
          <div className="row">
            <button className="btn danger" disabled={busy} onClick={() => void run('admin.end', {}, 'Admin session ended.')}>
              End admin session
            </button>
          </div>
        </>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) void run('admin.start', { password }, 'Admin session started.');
          }}
        >
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder="Admin password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn primary" type="submit" disabled={busy || !password}>
            Start admin session
          </button>
        </form>
      )}

      {status.passwordSet && (
        <>
          <h4>Password</h4>
          {!changing ? (
            <div className="row">
              <button className="btn" onClick={() => setChanging(true)}>
                Change password…
              </button>
            </div>
          ) : (
            <>
              <label className="field">
                Current password
                <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              </label>
              {newPassword('Change password', { current }, 'Admin password changed.')}
              <div className="row">
                <button
                  className="btn danger small"
                  disabled={busy || !current}
                  title="Removes the password and ends a running admin session"
                  onClick={() => void run('admin.clearPassword', { current }, 'Admin password removed.')}
                >
                  Remove password
                </button>
                <button className="btn ghost small" onClick={() => setChanging(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
