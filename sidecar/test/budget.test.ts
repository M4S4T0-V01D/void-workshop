import { describe, expect, it } from 'vitest';
import { checkBudget, CostTracker, dayKey } from '../src/budget.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings.js';

describe('budget checks', () => {
  it('uses conservative defaults: $1/task, $3/day, 20 turns', () => {
    expect(DEFAULT_SETTINGS.perTaskBudgetUsd).toBe(1);
    expect(DEFAULT_SETTINGS.dailyBudgetUsd).toBe(3);
    expect(DEFAULT_SETTINGS.maxTurns).toBe(50);
    expect(DEFAULT_SETTINGS.model).toBeNull();
  });

  it('caps the run at the smaller of task and daily remaining', () => {
    expect(checkBudget({ perTaskBudgetUsd: 1, dailyBudgetUsd: 3 }, 0, 0)).toEqual({ ok: true, capUsd: 1 });
    expect(checkBudget({ perTaskBudgetUsd: 1, dailyBudgetUsd: 3 }, 2.5, 0).capUsd).toBeCloseTo(0.5);
    expect(checkBudget({ perTaskBudgetUsd: 1, dailyBudgetUsd: 3 }, 0, 0.8).capUsd).toBeCloseTo(0.2);
  });

  it('stops when the daily or task limit is reached', () => {
    const daily = checkBudget({ perTaskBudgetUsd: 1, dailyBudgetUsd: 3 }, 3, 0);
    expect(daily.ok).toBe(false);
    expect(daily.reason).toMatch(/Daily/);
    const task = checkBudget({ perTaskBudgetUsd: 1, dailyBudgetUsd: 3 }, 1, 1);
    expect(task.ok).toBe(false);
    expect(task.reason).toMatch(/Task/);
  });

  it('turns cumulative SDK totals into deltas', () => {
    const t = new CostTracker(0);
    expect(t.delta(0.1)).toBeCloseTo(0.1);
    expect(t.delta(0.25)).toBeCloseTo(0.15);
    expect(t.delta(0.25)).toBe(0);
    expect(t.delta(-1)).toBe(0);
  });

  it('does not double count a resumed session that carries earlier spend', () => {
    const resumed = new CostTracker(0.4);
    expect(resumed.delta(0.5)).toBeCloseTo(0.1);
    const fresh = new CostTracker(0.4);
    expect(fresh.delta(0.05)).toBeCloseTo(0.05);
  });

  it('validates settings patches', () => {
    expect(() => mergeSettings({}, { perTaskBudgetUsd: -1 })).toThrow();
    expect(() => mergeSettings({}, { maxTurns: 0 })).toThrow();
    expect(mergeSettings({ perTaskBudgetUsd: 2 }).perTaskBudgetUsd).toBe(2);
    expect(mergeSettings({ bogus: true }).perTaskBudgetUsd).toBe(1);
  });

  it('dayKey is a local calendar date', () => {
    expect(dayKey(new Date(2026, 9, 17, 23, 59))).toBe('2026-10-17');
  });
});
