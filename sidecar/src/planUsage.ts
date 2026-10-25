import { log } from './log.js';

/**
 * Claude plan usage meters (5-hour session, weekly, per-model weekly such as Fable), the same numbers
 * Claude Code's usage bar shows. They come from the runtime's /usage data, which reads the claude.ai
 * usage endpoint: no model request, nothing billed.
 */

export const PLAN_USAGE_FLAG = 'planUsage';

export interface PlanUsageRow {
  /** The server's meter kind ('session', 'weekly_all', 'weekly_scoped', …). */
  kind: string;
  group: string;
  label: string;
  percent: number;
  resetsAt: number | null;
  /** The server's grading: 'normal', 'warning' or 'critical'. */
  severity: string;
  /** The row a one-number indicator should show. */
  active: boolean;
}

export interface PlanUsage {
  checkedAt: number;
  subscriptionType: string | null;
  rows: PlanUsageRow[];
  /** Extra usage (paid credits past the plan limits), in the currency's major unit. */
  extra: { enabled: boolean; used: number | null; limit: number | null; currency: string; percent: number | null; reason: string | null } | null;
  /** Why the last check failed; the rows are then from the check before. */
  problem: string | null;
}

type Window = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type Raw = Record<string, unknown>;

function time(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function severityOf(percent: number): string {
  return percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal';
}

function labelFor(kind: string, scope: Raw | null | undefined): string {
  const scoped = (scope?.model as Raw | null)?.display_name ?? (scope?.surface as Raw | null)?.display_name;
  if (typeof scoped === 'string' && scoped) return `${scoped} limit`;
  if (kind === 'session') return '5-hour session';
  if (kind === 'weekly_all') return 'Weekly';
  return kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** The runtime's get_usage answer → meters. The server's own rows win; older answers are rebuilt from the windows. */
export function normalizePlanUsage(res: Raw, now = Date.now()): PlanUsage | null {
  const rl = res.rate_limits as Raw | null | undefined;
  if (!rl) return null;
  let rows: PlanUsageRow[];
  if (Array.isArray(rl.limits)) {
    rows = (rl.limits as Raw[]).map((r) => {
      const percent = Math.max(0, Math.min(100, Number(r.percent ?? 0)));
      return {
        kind: String(r.kind ?? ''),
        group: String(r.group ?? ''),
        label: labelFor(String(r.kind ?? ''), r.scope as Raw | null),
        percent,
        resetsAt: time(r.resets_at),
        severity: typeof r.severity === 'string' ? r.severity : severityOf(percent),
        active: r.is_active === true,
      };
    });
  } else {
    rows = [];
    const add = (kind: string, group: string, label: string, w: Window) => {
      if (!w || typeof w.utilization !== 'number') return;
      rows.push({ kind, group, label, percent: w.utilization, resetsAt: time(w.resets_at), severity: severityOf(w.utilization), active: false });
    };
    add('session', 'session', '5-hour session', rl.five_hour as Window);
    add('weekly_all', 'weekly', 'Weekly', rl.seven_day as Window);
    add('weekly_opus', 'weekly', 'Opus limit', rl.seven_day_opus as Window);
    add('weekly_sonnet', 'weekly', 'Sonnet limit', rl.seven_day_sonnet as Window);
    for (const m of (rl.model_scoped as Raw[] | undefined) ?? [])
      add('weekly_scoped', 'weekly', `${String(m.display_name)} limit`, {
        utilization: m.utilization as number | null,
        resets_at: m.resets_at as string | null,
      });
    const top = rows.reduce<PlanUsageRow | null>((a, r) => (!a || r.percent > a.percent ? r : a), null);
    if (top) top.active = true;
  }
  const x = rl.extra_usage as Raw | null | undefined;
  const scale = (v: unknown) => (typeof v === 'number' ? v / 10 ** (typeof x?.decimal_places === 'number' ? x.decimal_places : 2) : null);
  return {
    checkedAt: now,
    subscriptionType: typeof res.subscription_type === 'string' ? res.subscription_type : null,
    rows,
    extra: x
      ? {
          enabled: x.is_enabled === true,
          used: scale(x.used_credits),
          limit: scale(x.monthly_limit),
          currency: typeof x.currency === 'string' ? x.currency : 'USD',
          percent: typeof x.utilization === 'number' ? x.utilization : null,
          reason: typeof x.disabled_reason === 'string' ? x.disabled_reason : null,
        }
      : null,
    problem: null,
  };
}

export interface PlanUsageDeps {
  /** Asks the runtime for /usage data with the plan login. */
  fetch: () => Promise<Raw>;
  signedIn: () => boolean;
  load: () => PlanUsage | null;
  save: (u: PlanUsage) => void;
  emit: (u: PlanUsage) => void;
}

/** Fresh enough to show without asking again. */
const FRESH_MS = 60_000;
/** While tasks use the plan, look again this often. */
const BUSY_MS = 3 * 60_000;
/** With nothing going on, still look now and then (the plan is also used from other devices). */
const IDLE_MS = 15 * 60_000;

/**
 * Keeps the meters current without a process per minute: a check (a short-lived runtime, ~0.5 s) after
 * plan-billed turns (debounced), every few minutes while tasks work, rarely when idle, or on request.
 */
export class PlanUsageWatcher {
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private inflight: Promise<PlanUsage | null> | null = null;
  private lastActivity = 0;
  private lastAttempt = 0;

  constructor(private readonly deps: PlanUsageDeps) {}

  get current(): PlanUsage | null {
    return this.deps.load();
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref?.();
    void this.refresh().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = this.soon = null;
  }

  private tick(): void {
    const age = Date.now() - Math.max(this.current?.checkedAt ?? 0, this.lastAttempt);
    const busy = Date.now() - this.lastActivity < BUSY_MS;
    if (age >= (busy ? BUSY_MS : IDLE_MS)) void this.refresh().catch(() => undefined);
  }

  /** A plan-billed turn ended: look again shortly (one check for a burst of turns). */
  noteActivity(): void {
    this.lastActivity = Date.now();
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.refresh().catch(() => undefined);
    }, 20_000);
    this.soon.unref?.();
  }

  async refresh(force = false): Promise<PlanUsage | null> {
    if (!this.deps.signedIn()) return null;
    const cur = this.current;
    if (!force && cur && !cur.problem && Date.now() - cur.checkedAt < FRESH_MS) return cur;
    this.inflight ??= (async () => {
      this.lastAttempt = Date.now();
      try {
        const next = normalizePlanUsage(await this.deps.fetch());
        const u = next ?? {
          ...(cur ?? { rows: [], extra: null, subscriptionType: null }),
          checkedAt: Date.now(),
          problem: 'Claude did not report plan usage this time.',
        };
        this.deps.save(u);
        this.deps.emit(u);
        return u;
      } catch (err) {
        log.warn(`plan usage: ${(err as Error).message}`);
        const u = { ...(cur ?? { rows: [], extra: null, subscriptionType: null, checkedAt: 0 }), problem: (err as Error).message };
        this.deps.save(u);
        this.deps.emit(u);
        return u;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
