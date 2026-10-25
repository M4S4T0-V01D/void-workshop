import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { redactValue, clip } from './redact.js';
import { mergeSettings, type Settings, type ProjectPermissions } from './settings.js';
import { dayKey } from './budget.js';

export type TaskState =
  | 'planning'
  | 'awaiting-plan-approval'
  | 'executing'
  | 'idle'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'stopped-budget'
  | 'stopped-billing'
  | 'stopped-limit'
  | 'interrupted';

export const ACTIVE_STATES: TaskState[] = ['planning', 'awaiting-plan-approval', 'executing'];

export interface TaskRow {
  id: string;
  project: string;
  title: string;
  prompt: string;
  model: string;
  state: TaskState;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  summary: string | null;
  error: string | null;
  checkpoint: string | null;
  cost_basis: string | null;
}

export type FileChangeStatus = 'proposed' | 'applied' | 'accepted' | 'rejected' | 'tested' | 'committed' | 'conflict';

export interface FileChangeRow {
  task_id: string;
  path: string;
  status: FileChangeStatus;
  preimage_file: string | null;
  existed: number;
  pre_hash: string | null;
  post_hash: string | null;
  updated_at: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_opened INTEGER NOT NULL,
  permissions TEXT NOT NULL DEFAULT '{"extraPaths":[],"networkDomains":[]}'
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  checkpoint TEXT,
  cost_basis TEXT
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project, created_at);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
CREATE TABLE IF NOT EXISTS file_changes (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  preimage_file TEXT,
  existed INTEGER NOT NULL,
  pre_hash TEXT,
  post_hash TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, path)
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  ts INTEGER NOT NULL,
  task_id TEXT,
  model TEXT,
  cost_usd REAL NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
CREATE TABLE IF NOT EXISTS command_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  project TEXT NOT NULL,
  origin TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output_tail TEXT,
  started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS command_runs_project ON command_runs(project, started_at);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* ignore */
      }
    }
    this.db.exec(SCHEMA);
    this.db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')`).run();
  }

  close(): void {
    this.db.close();
  }

  // ---- settings --------------------------------------------------------------------------
  getSettings(): Settings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'app'`).get() as { value: string } | undefined;
    return mergeSettings(row ? JSON.parse(row.value) : {});
  }

  updateSettings(patch: unknown): Settings {
    const next = mergeSettings(this.getSettings(), patch);
    this.db.prepare(`INSERT INTO settings(key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
    return next;
  }

  getFlag<T>(key: string): T | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`flag:${key}`) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setFlag(key: string, value: unknown | null): void {
    if (value === null) this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(`flag:${key}`);
    else
      this.db
        .prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(`flag:${key}`, JSON.stringify(value));
  }

  // ---- projects --------------------------------------------------------------------------
  touchProject(path: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO projects(path, name, last_opened) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET last_opened = excluded.last_opened, name = excluded.name`,
      )
      .run(path, name, Date.now());
  }

  recentProjects(limit = 12): Array<{ path: string; name: string; last_opened: number }> {
    return this.db.prepare(`SELECT path, name, last_opened FROM projects ORDER BY last_opened DESC LIMIT ?`).all(limit) as Array<{
      path: string;
      name: string;
      last_opened: number;
    }>;
  }

  forgetProject(path: string): void {
    this.db.prepare(`DELETE FROM projects WHERE path = ?`).run(path);
  }

  getProjectPermissions(path: string): ProjectPermissions {
    const row = this.db.prepare(`SELECT permissions FROM projects WHERE path = ?`).get(path) as { permissions: string } | undefined;
    const empty: ProjectPermissions = { extraPaths: [], networkDomains: [], alwaysAllowCommands: [] };
    return row ? { ...empty, ...(JSON.parse(row.permissions) as Partial<ProjectPermissions>) } : empty;
  }

  setProjectPermissions(path: string, perms: ProjectPermissions): void {
    this.db.prepare(`UPDATE projects SET permissions = ? WHERE path = ?`).run(JSON.stringify(perms), path);
  }

  // ---- tasks -----------------------------------------------------------------------------
  createTask(t: Pick<TaskRow, 'id' | 'project' | 'title' | 'prompt' | 'model' | 'state'>): TaskRow {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO tasks(id, project, title, prompt, model, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.project, t.title, t.prompt, t.model, t.state, now, now);
    return this.getTask(t.id)!;
  }

  getTask(id: string): TaskRow | null {
    return (this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as TaskRow | undefined) ?? null;
  }

  listTasks(project: string, limit = 100): TaskRow[] {
    return this.db.prepare(`SELECT * FROM tasks WHERE project = ? ORDER BY created_at DESC LIMIT ?`).all(project, limit) as unknown as TaskRow[];
  }

  /** Tasks working or waiting for a plan approval, in every project. */
  activeTasks(): TaskRow[] {
    const states = ACTIVE_STATES.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM tasks WHERE state IN (${states}) ORDER BY updated_at DESC`).all(...ACTIVE_STATES) as unknown as TaskRow[];
  }

  updateTask(id: string, patch: Partial<Omit<TaskRow, 'id' | 'project' | 'created_at'>>): TaskRow {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length) {
      const allowed = new Set([
        'title',
        'model',
        'state',
        'session_id',
        'cost_usd',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'turns',
        'summary',
        'error',
        'checkpoint',
        'cost_basis',
        'updated_at',
      ]);
      for (const k of keys) if (!allowed.has(k)) throw new Error(`Unknown task column ${k}`);
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      const values = keys.map((k) => {
        const v = patch[k];
        return typeof v === 'string' ? redactText1(v) : (v as number | null);
      });
      this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
    }
    return this.getTask(id)!;
  }

  /** Tasks that were running when the app last exited. */
  markInterruptedTasks(): number {
    const res = this.db
      .prepare(`UPDATE tasks SET state = 'interrupted', updated_at = ? WHERE state IN ('planning', 'awaiting-plan-approval', 'executing')`)
      .run(Date.now());
    return Number(res.changes);
  }

  addEvent(taskId: string, kind: string, payload: unknown): void {
    const text = clip(JSON.stringify(redactValue(payload)), 60_000);
    this.db.prepare(`INSERT INTO task_events(task_id, ts, kind, payload) VALUES (?, ?, ?, ?)`).run(taskId, Date.now(), kind, text);
  }

  events(taskId: string, limit = 2000): Array<{ id: number; ts: number; kind: string; payload: unknown }> {
    const rows = this.db.prepare(`SELECT id, ts, kind, payload FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?`).all(taskId, limit) as Array<{
      id: number;
      ts: number;
      kind: string;
      payload: string;
    }>;
    return rows.reverse().map((r) => ({ ...r, payload: safeParse(r.payload) }));
  }

  // ---- file changes ----------------------------------------------------------------------
  getFileChange(taskId: string, path: string): FileChangeRow | null {
    return (this.db.prepare(`SELECT * FROM file_changes WHERE task_id = ? AND path = ?`).get(taskId, path) as unknown as FileChangeRow | undefined) ?? null;
  }

  upsertFileChange(row: Omit<FileChangeRow, 'updated_at'>): void {
    this.db
      .prepare(
        `INSERT INTO file_changes(task_id, path, status, preimage_file, existed, pre_hash, post_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, path) DO UPDATE SET status = excluded.status, preimage_file = excluded.preimage_file, post_hash = excluded.post_hash, updated_at = excluded.updated_at`,
      )
      .run(row.task_id, row.path, row.status, row.preimage_file, row.existed, row.pre_hash, row.post_hash, Date.now());
  }

  setFileChangeStatus(taskId: string, path: string, status: FileChangeStatus): void {
    this.db.prepare(`UPDATE file_changes SET status = ?, updated_at = ? WHERE task_id = ? AND path = ?`).run(status, Date.now(), taskId, path);
  }

  fileChanges(taskId: string): FileChangeRow[] {
    return this.db.prepare(`SELECT * FROM file_changes WHERE task_id = ? ORDER BY path`).all(taskId) as unknown as FileChangeRow[];
  }

  // ---- usage -----------------------------------------------------------------------------
  addUsage(u: {
    taskId: string | null;
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO usage(day, ts, task_id, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(dayKey(), Date.now(), u.taskId, u.model, u.costUsd, u.inputTokens, u.outputTokens, u.cacheRead, u.cacheWrite);
  }

  spentOn(day = dayKey()): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE day = ?`).get(day) as { total: number };
    return row.total;
  }

  usageSummary(days = 30): Array<{ day: string; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }> {
    return this.db
      .prepare(
        `SELECT day, SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite
         FROM usage GROUP BY day ORDER BY day DESC LIMIT ?`,
      )
      .all(days) as Array<{ day: string; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
  }

  /** Token totals per model since `sinceDay` (YYYY-MM-DD). */
  usageByModel(sinceDay: string): Array<{ model: string; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }> {
    return this.db
      .prepare(
        `SELECT COALESCE(model, '?') AS model, SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite
         FROM usage WHERE day >= ? GROUP BY model ORDER BY SUM(output_tokens) DESC`,
      )
      .all(sinceDay) as Array<{ model: string; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
  }

  /**
   * Tasks whose title, prompt, summary or conversation contains `query` (case-insensitive), newest first,
   * with the first matching message as a snippet. `project` limits it to one project.
   */
  searchTasks(query: string, project: string | null, limit = 30): Array<{ task: TaskRow; snippet: string | null }> {
    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const tasks = this.db
      .prepare(
        `SELECT * FROM tasks t WHERE ($project IS NULL OR t.project = $project) AND (
           t.title LIKE $like ESCAPE '\\' OR t.prompt LIKE $like ESCAPE '\\' OR t.summary LIKE $like ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.kind IN ('user', 'assistant', 'plan') AND e.payload LIKE $like ESCAPE '\\'))
         ORDER BY t.updated_at DESC LIMIT $limit`,
      )
      .all({ $project: project, $like: like, $limit: limit }) as unknown as TaskRow[];
    const first = this.db.prepare(
      `SELECT payload FROM task_events WHERE task_id = ? AND kind IN ('user', 'assistant', 'plan') AND payload LIKE ? ESCAPE '\\' ORDER BY id LIMIT 1`,
    );
    const needle = query.toLowerCase();
    return tasks.map((task) => {
      const row = first.get(task.id, like) as { payload: string } | undefined;
      const text = row ? String((safeParse(row.payload) as { text?: unknown })?.text ?? '') : '';
      const at = text.toLowerCase().indexOf(needle);
      const snippet = at < 0 ? null : `${at > 60 ? '…' : ''}${text.slice(Math.max(0, at - 60), at + needle.length + 100).replace(/\s+/g, ' ')}`;
      return { task, snippet };
    });
  }

  // ---- command runs ----------------------------------------------------------------------
  addCommandRun(r: {
    id: string;
    taskId: string | null;
    project: string;
    origin: 'agent' | 'user';
    command: string;
    cwd: string;
    reason: string | null;
    status: string;
  }): void {
    this.db
      .prepare(`INSERT INTO command_runs(id, task_id, project, origin, command, cwd, reason, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.taskId, r.project, r.origin, redactText1(r.command), r.cwd, r.reason ? redactText1(r.reason) : null, r.status, Date.now());
  }

  finishCommandRun(id: string, f: { status: string; exitCode: number | null; durationMs: number; outputTail: string }): void {
    this.db
      .prepare(`UPDATE command_runs SET status = ?, exit_code = ?, duration_ms = ?, output_tail = ? WHERE id = ?`)
      .run(f.status, f.exitCode, f.durationMs, clip(redactText1(f.outputTail), 8000), id);
  }

  commandRuns(project: string, limit = 50): unknown[] {
    return this.db.prepare(`SELECT * FROM command_runs WHERE project = ? ORDER BY started_at DESC LIMIT ?`).all(project, limit);
  }
}

function redactText1(s: string): string {
  return redactValue(s);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
