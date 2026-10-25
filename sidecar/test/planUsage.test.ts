import { describe, expect, it, vi } from 'vitest';
import { normalizePlanUsage, PlanUsageWatcher, type PlanUsage } from '../src/planUsage.js';

/** Trimmed from a real Max plan answer (2026-10-21). */
const REAL = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 7, resets_at: '2026-10-21T19:59:59.532543+00:00' },
    seven_day: { utilization: 32, resets_at: '2026-10-25T18:59:59.532569+00:00' },
    extra_usage: {
      is_enabled: false,
      monthly_limit: 44000,
      used_credits: 15317,
      utilization: 34.81,
      currency: 'USD',
      decimal_places: 2,
      disabled_reason: 'out_of_credits',
    },
    limits: [
      { kind: 'session', group: 'session', percent: 7, resets_at: '2026-10-21T19:59:59.532543+00:00', severity: 'normal', is_active: false, scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 32, resets_at: '2026-10-25T18:59:59.532569+00:00', severity: 'normal', is_active: true, scope: null },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 0,
        resets_at: '2026-10-25T19:00:00+00:00',
        severity: 'normal',
        is_active: false,
        scope: { model: { display_name: 'Fable', id: null }, surface: null },
      },
    ],
    model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2026-10-25T19:00:00+00:00' }],
  },
};

describe('plan usage meters', () => {
  it("shows the server's rows as sent, with readable labels", () => {
    const u = normalizePlanUsage(REAL, 1000)!;
    expect(u.subscriptionType).toBe('max');
    expect(u.rows.map((r) => [r.label, r.percent, r.active])).toEqual([
      ['5-hour session', 7, false],
      ['Weekly', 32, true],
      ['Fable limit', 0, false],
    ]);
    expect(u.rows[0]!.resetsAt).toBe(Date.parse('2026-10-21T19:59:59.532Z'));
    expect(u.extra).toEqual({ enabled: false, used: 153.17, limit: 440, currency: 'USD', percent: 34.81, reason: 'out_of_credits' });
  });

  it('rebuilds the rows from the windows when the server sends no rows', () => {
    const { limits: _drop, ...older } = REAL.rate_limits;
    const u = normalizePlanUsage({ ...REAL, rate_limits: older })!;
    expect(u.rows.map((r) => [r.label, r.percent])).toEqual([
      ['5-hour session', 7],
      ['Weekly', 32],
      ['Fable limit', 0],
    ]);
    expect(u.rows.find((r) => r.active)?.label).toBe('Weekly');
  });

  it('is null when the plan reported nothing (API key or no usage scope)', () => {
    expect(normalizePlanUsage({ rate_limits_available: false, rate_limits: null })).toBeNull();
  });
});

describe('PlanUsageWatcher', () => {
  const make = (fetch: () => Promise<Record<string, unknown>>, signedIn = true) => {
    let saved: PlanUsage | null = null;
    const emitted: PlanUsage[] = [];
    const w = new PlanUsageWatcher({ fetch, signedIn: () => signedIn, load: () => saved, save: (u) => (saved = u), emit: (u) => emitted.push(u) });
    return { w, emitted, saved: () => saved };
  };

  it('checks once, reuses a fresh answer, and checks again when forced', async () => {
    const fetch = vi.fn(async () => REAL);
    const { w, emitted } = make(fetch);
    await Promise.all([w.refresh(), w.refresh()]);
    await w.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    await w.refresh(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(emitted).toHaveLength(2);
  });

  it('keeps the last numbers and says what went wrong when a check fails', async () => {
    let fail = false;
    const { w, saved } = make(async () => {
      if (fail) throw new Error('offline');
      return REAL;
    });
    await w.refresh();
    fail = true;
    await w.refresh(true);
    expect(saved()!.rows).toHaveLength(3);
    expect(saved()!.problem).toBe('offline');
  });

  it('does nothing without a Claude plan sign-in', async () => {
    const fetch = vi.fn(async () => REAL);
    const { w } = make(fetch, false);
    expect(await w.refresh(true)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('looks again shortly after plan-billed turns, once for a burst', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => REAL);
      const { w } = make(fetch);
      w.noteActivity();
      w.noteActivity();
      await vi.advanceTimersByTimeAsync(21_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
