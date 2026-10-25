import { useCallback, useEffect, useRef, useState } from 'react';
import { RPC_REJECTED_EVENT, type RejectedCall } from '../api';
import type { LogEntry } from '../components/BottomPanel';
import type { Toast } from '../components/common';

/** Toasts (newest five, timed) and the bottom panel's log; also reports calls the shell refused. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((tone: Toast['tone'], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 9000 : 5000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const addLog = useCallback((level: LogEntry['level'], text: string) => setLog((l) => [...l.slice(-499), { ts: Date.now(), level, text }]), []);

  useEffect(() => {
    const onRejected = (e: Event) => {
      const { method, message } = (e as CustomEvent<RejectedCall>).detail;
      addLog('error', `${method}: ${message}`);
      toast('error', `Workshop bug: the window may not call ${method}. Please report it.`);
    };
    window.addEventListener(RPC_REJECTED_EVENT, onRejected);
    return () => window.removeEventListener(RPC_REJECTED_EVENT, onRejected);
  }, [addLog, toast]);

  return { toasts, dismiss, toast, log, addLog };
}
