import { useEffect, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { call, errorText } from '../api';
import type { PlanUsage, PlanUsageRow } from '../types';
import { timeAgo } from './common';

/** The short name a status-bar meter uses: 5h, Week, Fable… */
export function shortLabel(r: PlanUsageRow): string {
  if (r.kind === 'session') return '5h';
  if (r.kind === 'weekly_all') return 'Week';
  return r.label.replace(/ limit$/, '');
}

export function meterTone(r: PlanUsageRow): string {
  return r.severity === 'critical' || r.percent >= 90 ? 'bad' : r.severity === 'warning' || r.percent >= 75 ? 'warn' : '';
}

/** "resets in 3h 28m" within a day, otherwise the weekday and time. */
export function resetText(at: number | null, now = Date.now()): string {
  if (!at) return '';
  const ms = at - now;
  if (ms <= 0) return 'resetting now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  if (mins < 24 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `resets ${new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

function money(v: number | null, currency: string): string {
  return v === null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency });
}

/**
 * Claude plan usage in the status bar (5-hour session, weekly, per-model weekly), like Claude Code's usage
 * bar. Click for the details, reset times and extra usage.
 */
export function PlanMeter({ usage, onUsage }: { usage: PlanUsage | null; onUsage: (u: PlanUsage) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const box = useRef<HTMLSpanElement>(null);

  // Reset countdowns move on their own; the numbers come in as events.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const refresh = () => {
    setBusy(true);
    setError(null);
    call<PlanUsage | null>('plan.usage', { force: true })
      .then((u) => u && onUsage(u))
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const rows = usage?.rows ?? [];
  return (
    <span className="item clickable plan-meter" ref={box} onClick={() => setOpen(!open)} title="Claude plan usage: click for details">
      <Gauge size={12} />
      {rows.length === 0 ? (
        <span>{usage?.problem ? 'Plan usage unavailable' : 'Plan usage…'}</span>
      ) : (
        rows.map((r) => (
          <span key={`${r.kind}-${r.label}`} className="plan-meter-cell">
            {shortLabel(r)} {Math.round(r.percent)}%
            <span className={`meter small ${meterTone(r)}`}>
              <div style={{ width: `${Math.min(100, r.percent)}%` }} />
            </span>
          </span>
        ))
      )}
      {open && (
        <div className="plan-pop" onClick={(e) => e.stopPropagation()}>
          <div className="plan-pop-head">
            <b>Claude plan usage</b>
            {usage?.subscriptionType && <span className="chip cyan">{usage.subscriptionType}</span>}
            <span className="spacer" />
            <button className="btn small" onClick={refresh} disabled={busy}>
              <RefreshCw size={12} className={busy ? 'spin' : ''} /> Refresh
            </button>
          </div>
          {rows.map((r) => (
            <div key={`${r.kind}-${r.label}`} className="plan-row">
              <div className="plan-row-top">
                <span>{r.label}</span>
                <span className="spacer" />
                <b>{Math.round(r.percent)}% used</b>
              </div>
              <span className={`meter wide ${meterTone(r)}`}>
                <div style={{ width: `${Math.min(100, r.percent)}%` }} />
              </span>
              <div className="muted">{resetText(r.resetsAt)}</div>
            </div>
          ))}
          {usage?.extra && (
            <div className="plan-row">
              <div className="plan-row-top">
                <span>Extra usage</span>
                <span className="spacer" />
                <b>
                  {money(usage.extra.used, usage.extra.currency)} / {money(usage.extra.limit, usage.extra.currency)}
                </b>
              </div>
              {usage.extra.percent !== null && (
                <span className="meter wide">
                  <div style={{ width: `${Math.min(100, usage.extra.percent)}%` }} />
                </span>
              )}
              <div className="muted">
                {usage.extra.enabled ? 'On: covers you past the plan limits' : `Off${usage.extra.reason ? ` (${usage.extra.reason.replace(/_/g, ' ')})` : ''}`}
              </div>
            </div>
          )}
          {(error ?? usage?.problem) && <div className="plan-problem">{error ?? usage?.problem}</div>}
          <div className="muted plan-foot">
            {usage?.checkedAt ? `Checked ${timeAgo(usage.checkedAt)}` : 'Not checked yet'} · from claude.ai, includes use on other devices
          </div>
        </div>
      )}
    </span>
  );
}
