import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, CircleStop, FlaskConical, Loader2, ScrollText, SquareTerminal } from 'lucide-react';
import type { Project } from '../types';
import { t } from '../i18n';

export interface RunRecord {
  runId: string;
  origin: 'user' | 'agent';
  command: string;
  cwd: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'error';
  output: string;
  exitCode?: number | null;
  durationMs?: number;
  startedAt: number;
}

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

const TEST_RE = /\b(test|tests|check|lint|clippy|tsc|vitest|jest|pytest|typecheck|type-check|build|fmt)\b/;

type Tab = 'terminal' | 'tests' | 'log';

export function BottomPanel({
  project,
  runs,
  log,
  collapsed,
  onToggle,
  onPrepare,
  onCancelRun,
}: {
  project: Project | null;
  runs: RunRecord[];
  log: LogEntry[];
  collapsed: boolean;
  onToggle: () => void;
  onPrepare: (input: { command?: string; argv?: string[]; reason?: string }) => void;
  onCancelRun: (runId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('terminal');
  const [cmd, setCmd] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const shown = tab === 'tests' ? runs.filter((r) => TEST_RE.test(r.command)) : runs;
  const lastOutputLen = shown.at(-1)?.output.length ?? 0;

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [shown.length, lastOutputLen, tab, log.length]);

  const running = runs.filter((r) => r.status === 'running').length;

  return (
    <>
      <div className="tabs">
        <button className={`tab ${tab === 'terminal' ? 'active' : ''}`} onClick={() => setTab('terminal')}>
          <SquareTerminal size={13} /> {t('Terminal')} {running > 0 && <span className="count">{t('{n} running', { n: running })}</span>}
        </button>
        <button className={`tab ${tab === 'tests' ? 'active' : ''}`} onClick={() => setTab('tests')}>
          <FlaskConical size={13} /> {t('Tests & builds')}
        </button>
        <button className={`tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>
          <ScrollText size={13} /> {t('Activity log')}
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={onToggle} title={collapsed ? t('Expand panel') : t('Collapse panel')}>
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="panel-body" ref={body}>
            {tab !== 'log' && (
              <div className="term">
                {shown.length === 0 && (
                  <div className="muted">
                    {tab === 'tests'
                      ? t('Build, test, lint and type-check runs (yours and the agent’s) appear here.')
                      : t('No commands yet. Nothing runs without your approval: type a command below or pick a suggestion. There is no unrestricted shell.')}
                  </div>
                )}
                {shown.map((r) => (
                  <div key={r.runId} className="run">
                    <div className="run-head">
                      <span>{r.origin === 'agent' ? 'agent' : 'you'}</span>
                      <span className="cmd">$ {r.command}</span>
                      <span className="spacer grow" />
                      {r.status === 'running' ? (
                        <>
                          <Loader2 size={12} className="spin" />
                          {r.origin === 'user' && (
                            <button className="btn small danger" onClick={() => onCancelRun(r.runId)}>
                              <CircleStop size={11} /> {t('Cancel')}
                            </button>
                          )}
                        </>
                      ) : (
                        <span className={`chip ${r.status === 'succeeded' ? 'ok' : r.status === 'cancelled' ? '' : 'bad'}`}>
                          {r.status}
                          {r.exitCode !== undefined && r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}
                          {r.durationMs !== undefined ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ''}
                        </span>
                      )}
                    </div>
                    {r.output && <pre>{r.output}</pre>}
                  </div>
                ))}
              </div>
            )}
            {tab === 'log' && (
              <div style={{ padding: '4px 0' }}>
                {log.length === 0 && <div className="empty-small">{t('Approvals, denials, policy blocks and errors are recorded here for this session.')}</div>}
                {log.map((l, i) => (
                  <div key={i} className="log-row">
                    <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
                    <span style={{ color: l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warning)' : 'var(--text)' }}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {tab !== 'log' && project && (
            <>
              {project.commands.length > 0 && (
                <div className="suggestions">
                  {project.commands.map((c) => (
                    <button key={c.label} className="btn small" title={c.reason} onClick={() => onPrepare({ argv: c.argv, reason: c.reason })}>
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
              <form
                className="runner-input"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (cmd.trim()) onPrepare({ command: cmd, reason: t('Typed in the terminal panel') });
                  setCmd('');
                }}
              >
                <span className="prompt">{project.name} $</span>
                <input
                  className="input mono"
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  placeholder={t('Single command, e.g. npm test (no pipes or redirects; you confirm before it runs)')}
                />
                <button className="btn" type="submit" disabled={!cmd.trim()}>
                  {t('Review & run')}
                </button>
              </form>
            </>
          )}
        </>
      )}
    </>
  );
}
