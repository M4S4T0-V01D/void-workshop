import type { Settings } from './settings.js';

/** Local calendar day used for the daily limit. */
export function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
  /** USD cap to hand to the SDK (`maxBudgetUsd`) for the next query. */
  capUsd: number;
}

/**
 * Decide whether a task may start (or continue) and with which estimated-spend cap.
 * All values are local estimates; the organization's real balance is only visible in the Console.
 */
export function checkBudget(settings: Pick<Settings, 'perTaskBudgetUsd' | 'dailyBudgetUsd'>, spentToday: number, spentOnTask: number): BudgetCheck {
  const dailyLeft = settings.dailyBudgetUsd - spentToday;
  const taskLeft = settings.perTaskBudgetUsd - spentOnTask;
  if (dailyLeft <= 0.0005) {
    return { ok: false, capUsd: 0, reason: `Daily estimated spend limit reached ($${spentToday.toFixed(2)} of $${settings.dailyBudgetUsd.toFixed(2)}).` };
  }
  if (taskLeft <= 0.0005) {
    return { ok: false, capUsd: 0, reason: `Task estimated spend limit reached ($${spentOnTask.toFixed(2)} of $${settings.perTaskBudgetUsd.toFixed(2)}).` };
  }
  return { ok: true, capUsd: Math.max(0.01, Math.min(dailyLeft, taskLeft)) };
}

/**
 * The SDK reports cumulative `total_cost_usd` per query; a resumed query may or may not carry
 * the earlier total. Convert successive totals into per-turn deltas without double counting.
 */
export class CostTracker {
  private last: number | null = null;
  constructor(private readonly priorTaskCost: number) {}

  delta(total: number): number {
    if (!Number.isFinite(total) || total < 0) return 0;
    if (this.last === null) {
      this.last = total;
      // First result of a resumed query: if it already includes the earlier spend, subtract it.
      if (this.priorTaskCost > 0 && total + 1e-9 >= this.priorTaskCost) return total - this.priorTaskCost;
      return total;
    }
    const d = Math.max(0, total - this.last);
    this.last = Math.max(this.last, total);
    return d;
  }
}

export function formatUsd(v: number): string {
  return v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
