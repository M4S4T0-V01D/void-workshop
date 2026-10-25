import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { call, errorText } from '../api';
import { Callout, Modal, formatTokens, formatUsd } from './common';

type Tokens = { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number };
type Summary = { today: string; spentTodayUsd: number; days: Array<Tokens & { day: string }>; week: Array<Tokens & { model: string }> };

/**
 * Rough weight of each token kind against a plan's limits, relative to an uncached input token. Taken from
 * API list-price ratios; Anthropic does not publish how plan limits count, so this is only an estimate.
 */
export const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const;

export function weighted(t: Tokens): number {
  return t.input * WEIGHTS.input + t.cacheWrite * WEIGHTS.cacheWrite + t.cacheRead * WEIGHTS.cacheRead + t.output * WEIGHTS.output;
}

const sum = (rows: Tokens[]): Tokens =>
  rows.reduce((a, r) => ({ cost: a.cost + r.cost, input: a.input + r.input, output: a.output + r.output, cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite }), {
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

/** Workshop's own token use: the last 30 days per day and the last 7 days per model, with where the weight goes. */
export function UsageDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<Summary>('usage.summary', {}).then(setData, (err) => setError(errorText(err)));
  }, []);

  const week = data ? sum(data.week) : null;
  const weekWeight = week ? weighted(week) : 0;
  const days = data ? [...data.days].sort((a, b) => a.day.localeCompare(b.day)) : [];
  const peak = Math.max(1, ...days.map(weighted));

  return (
    <Modal title="Token usage in Workshop" icon={<BarChart3 size={16} />} onClose={onClose} wide>
      {error && <Callout tone="bad">{error}</Callout>}
      {!data && !error && <span className="muted">Loading…</span>}
      {data && week && (
        <>
          <h4>Last 7 days by model</h4>
          {data.week.length === 0 ? (
            <span className="muted">No use in the last 7 days.</span>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Cache write</th>
                  <th>Cache read</th>
                  <th>Output</th>
                  <th title="Share of the estimated weight against plan limits">Weight</th>
                  <th>API est.</th>
                </tr>
              </thead>
              <tbody>
                {[...data.week]
                  .sort((a, b) => weighted(b) - weighted(a))
                  .map((r) => (
                    <tr key={r.model}>
                      <td className="mono">{r.model}</td>
                      <td>{formatTokens(r.input)}</td>
                      <td>{formatTokens(r.cacheWrite)}</td>
                      <td>{formatTokens(r.cacheRead)}</td>
                      <td>{formatTokens(r.output)}</td>
                      <td>{pct(weighted(r), weekWeight)}</td>
                      <td>{formatUsd(r.cost)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          {weekWeight > 0 && (
            <Callout>
              Where the weight went this week: cache reads {pct(week.cacheRead * WEIGHTS.cacheRead, weekWeight)}, cache writes{' '}
              {pct(week.cacheWrite * WEIGHTS.cacheWrite, weekWeight)}, output {pct(week.output * WEIGHTS.output, weekWeight)}, new input{' '}
              {pct(week.input * WEIGHTS.input, weekWeight)}. Cache reads grow with long sessions; the token saver (Settings → Speed) compacts
              them sooner. Weights are estimates from API prices, not how Anthropic counts plan limits.
            </Callout>
          )}
          <h4>Last 30 days</h4>
          {days.length === 0 ? (
            <span className="muted">No use yet.</span>
          ) : (
            <div className="usage-bars" aria-label="Weighted tokens per day">
              {days.map((d) => (
                <div
                  key={d.day}
                  style={{ height: `${Math.max(2, (weighted(d) / peak) * 100)}%` }}
                  title={`${d.day}: ${formatTokens(d.input + d.cacheWrite + d.cacheRead + d.output)} tokens, ${formatTokens(d.output)} output, ${formatUsd(d.cost)} API est.`}
                />
              ))}
            </div>
          )}
          <div className="muted">Counts only Workshop's own tasks. The plan meter in the status bar shows the real limits from claude.ai.</div>
        </>
      )}
    </Modal>
  );
}
