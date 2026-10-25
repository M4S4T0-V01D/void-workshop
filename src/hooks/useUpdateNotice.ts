import { useEffect, useRef } from 'react';
import { call, onSidecarEvent } from '../api';
import type { InitData, UpdateCheck } from '../types';
import type { Toast } from '../components/common';
import { t } from '../i18n';

const SEEN_KEY = 'vw.updateOffered';
const CHECK_DELAY_MS = 30_000;

/**
 * Desktop update notices: the result of the last install (once), the install starting, and one quiet
 * check shortly after start that mentions a new signed release once per version.
 */
export function useUpdateNotice(
  init: InitData | null,
  toast: (tone: Toast['tone'], text: string) => void,
  log: (level: 'info' | 'warn' | 'error', text: string) => void,
) {
  const ready = init !== null;
  const last = init?.lastUpdate ?? null;
  const shown = useRef(false);

  useEffect(() => {
    if (!last || shown.current) return;
    shown.current = true;
    if (last.ok) toast('info', t('Updated VOID Workshop {from} → {version}.', { from: last.from, version: last.version }));
    else toast('error', t('The update to {version} failed; still on {from}. Log: {log}', { version: last.version, from: last.from, log: last.logFile }));
    log(last.ok ? 'info' : 'error', `Update ${last.from} → ${last.version} ${last.ok ? 'installed' : `failed (log: ${last.logFile})`}`);
    void call('app.update.dismiss', {}).catch(() => undefined);
  }, [last, toast, log]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void call<UpdateCheck>('app.update.check', {})
        .then((c) => {
          if (c.status !== 'available' || localStorage.getItem(SEEN_KEY) === c.release.version) return;
          localStorage.setItem(SEEN_KEY, c.release.version);
          toast('info', t('VOID Workshop {version} is available: Settings → Updates.', { version: c.release.version }));
        })
        .catch(() => undefined);
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [ready, toast]);

  useEffect(() => {
    const un = onSidecarEvent(({ event, payload }) => {
      if (event !== 'app.updating') return;
      const v = String((payload as { version?: unknown })?.version ?? '');
      toast('info', t('Installing VOID Workshop {version}; the window restarts in a moment.', { version: v }));
      log('info', `Installing update ${v}.`);
    });
    return () => void un.then((f) => f());
  }, [toast, log]);
}
