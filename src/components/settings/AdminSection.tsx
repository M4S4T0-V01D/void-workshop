import { useState } from 'react';
import { call, errorText } from '../../api';
import type { AdminStatus } from '../../types';
import { Callout, timeAgo } from '../common';
import type { WindowMethod } from '../../rpcMethods';
import { locale, t, tx } from '../../i18n';

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
          {t('New password')}
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="field">
          {t('Repeat it')}
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
        <span className="muted">{next && repeat && next !== repeat ? t('The two passwords differ.') : t('At least 6 characters.')}</span>
      </div>
    </>
  );

  return (
    <>
      <h4>{t('Admin dev session')}</h4>
      <p>
        {tx(
          "With your admin password the agent may work on VOID Workshop and VOID Portal themselves: their source{folder}, Workshop's logs and database, full access with Auto publishing, and installing a new build and restarting into it (the task then continues on its own). Start and end it here or in VOID Portal. Ending it puts everything back to normal and stops tasks still working in it. Your keys, Claude sign-in, phone pairings and this password stay out of the agent's reach either way.",
          {
            folder: status.sourceDir ? (
              <>
                {' '}
                (<code>{status.sourceDir}</code>)
              </>
            ) : (
              ''
            ),
          },
        )}
      </p>
      {!status.sourceDir && (
        <Callout tone="warn">
          {tx(
            'The VOID Workshop source folder was not found. Open it as a project once (or install from it with {script}) so admin sessions know where to work.',
            {
              script: <code>./scripts/install.sh</code>,
            },
          )}
        </Callout>
      )}
      {status.lockedUntil && (
        <Callout tone="warn">
          {t('Too many wrong passwords: locked until {time}.', { time: new Date(status.lockedUntil).toLocaleTimeString(locale()) })}
        </Callout>
      )}
      {error && <Callout tone="bad">{error}</Callout>}

      {!status.passwordSet ? (
        <>
          <p className="muted">{t('Set the admin password first. VOID Portal can change it later, but not set the first one.')}</p>
          {newPassword(t('Set admin password'), {}, t('Admin password set.'))}
        </>
      ) : status.active ? (
        <>
          <Callout tone="warn">
            {status.by === 'phone'
              ? t('Admin session running since {when}, started from {device}.', {
                  when: status.since ? timeAgo(status.since) : '—',
                  device: status.device ?? t('a phone'),
                })
              : t('Admin session running since {when}, started on this PC.', { when: status.since ? timeAgo(status.since) : '—' })}
          </Callout>
          <div className="row">
            <button className="btn danger" disabled={busy} onClick={() => void run('admin.end', {}, t('Admin session ended.'))}>
              {t('End admin session')}
            </button>
          </div>
        </>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) void run('admin.start', { password }, t('Admin session started.'));
          }}
        >
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder={t('Admin password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn primary" type="submit" disabled={busy || !password}>
            {t('Start admin session')}
          </button>
        </form>
      )}

      {status.passwordSet && (
        <>
          <h4>{t('Password')}</h4>
          {!changing ? (
            <div className="row">
              <button className="btn" onClick={() => setChanging(true)}>
                {t('Change password…')}
              </button>
            </div>
          ) : (
            <>
              <label className="field">
                {t('Current password')}
                <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              </label>
              {newPassword(t('Change password'), { current }, t('Admin password changed.'))}
              <div className="row">
                <button
                  className="btn danger small"
                  disabled={busy || !current}
                  title={t('Removes the password and ends a running admin session')}
                  onClick={() => void run('admin.clearPassword', { current }, t('Admin password removed.'))}
                >
                  {t('Remove password')}
                </button>
                <button className="btn ghost small" onClick={() => setChanging(false)}>
                  {t('Cancel')}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
