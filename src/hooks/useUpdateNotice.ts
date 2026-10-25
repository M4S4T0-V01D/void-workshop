import { useEffect, useRef } from 'react';
import { call, onSidecarEvent } from '../api';
import type { InitData, UpdateCheck } from '../types';
import type { Toast } from '../components/common';

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
    if (last.ok) toast('info', `Updated VOID Workshop ${last.from} → ${last.version}.`);
    else toast('error', `The update to ${last.version} failed; still on ${last.from}. Log: ${last.logFile}`);
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
          toast('info', `VOID Workshop ${c.release.version} is available: Settings → Updates.`);
        })
        .catch(() => undefined);
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [ready, toast]);

  useEffect(() => {
    const un = onSidecarEvent(({ event, payload }) => {
      if (event !== 'app.updating') return;
      const v = String((payload as { version?: unknown })?.version ?? '');
      toast('info', `Installing VOID Workshop ${v}; the window restarts in a moment.`);
      log('info', `Installing update ${v}.`);
    });
    return () => void un.then((f) => f());
  }, [toast, log]);
}
