import { useCallback, useState } from 'react';
import type { RunRecord } from '../components/BottomPanel';

const MAX_RUN_OUTPUT = 200_000;

/** Command runs shown in the bottom panel, kept from the runner.* events (newest 100, output capped). */
export function useRuns() {
  const [runs, setRuns] = useState<RunRecord[]>([]);

  /** Applies a runner event; true when it was one. */
  const applyRunEvent = useCallback((event: string, p: Record<string, unknown>): boolean => {
    switch (event) {
      case 'runner.started':
        setRuns((r) => [
          ...r.slice(-99),
          {
            runId: String(p.runId),
            origin: p.origin === 'agent' ? 'agent' : 'user',
            command: String(p.command),
            cwd: String(p.cwd),
            status: 'running',
            output: '',
            startedAt: Date.now(),
          },
        ]);
        return true;
      case 'runner.output':
        setRuns((r) => r.map((x) => (x.runId === p.runId ? { ...x, output: (x.output + String(p.chunk)).slice(-MAX_RUN_OUTPUT) } : x)));
        return true;
      case 'runner.finished':
        setRuns((r) =>
          r.map((x) =>
            x.runId === p.runId
              ? {
                  ...x,
                  status: (p.status as RunRecord['status']) ?? (p.ok ? 'succeeded' : 'failed'),
                  exitCode: (p.exitCode as number | null | undefined) ?? undefined,
                  durationMs: Number(p.durationMs ?? 0),
                  output: typeof p.output === 'string' ? p.output : x.output + (p.error ? `\n${String(p.error)}` : ''),
                }
              : x,
          ),
        );
        return true;
    }
    return false;
  }, []);
  const clearRuns = useCallback(() => setRuns([]), []);

  return { runs, clearRuns, applyRunEvent };
}
