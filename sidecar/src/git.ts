import { execFile } from 'node:child_process';
import path from 'node:path';

/** Git through argv arrays only (no shell), with prompts and hooks that could hang disabled. */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  LC_ALL: 'C',
};

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Repository config is untrusted: core.fsmonitor, hooks and external diff/textconv drivers can run
 * arbitrary programs, so they are overridden for every invocation.
 */
export const GIT_SAFETY_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
  '-c',
  'credential.helper=',
];

export function git(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...GIT_SAFETY_ARGS, ...args],
      { cwd, env: { ...cleanEnv(), ...GIT_ENV }, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          reject(new Error(`git ${args[0]} failed: ${(err as Error).message}`));
          return;
        }
        resolve({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GNUPGHOME']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  dirty: boolean;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (!top || top.code !== 0) {
    return { isRepo: false, root: null, branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [], dirty: false };
  }
  const res = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  const status: GitStatus = { isRepo: true, root: top.stdout.trim(), branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [], dirty: false };
  const records = res.stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (!rec) continue;
    if (rec.startsWith('# branch.oid ')) status.head = rec.slice(13) === '(initial)' ? null : rec.slice(13);
    else if (rec.startsWith('# branch.head ')) status.branch = rec.slice(14) === '(detached)' ? null : rec.slice(14);
    else if (rec.startsWith('# branch.upstream ')) status.upstream = rec.slice(18);
    else if (rec.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(rec);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (rec.startsWith('1 ') || rec.startsWith('2 ')) {
      const parts = rec.split(' ');
      const xy = parts[1] ?? '..';
      const file = rec.startsWith('1 ') ? parts.slice(8).join(' ') : parts.slice(9).join(' ');
      status.files.push({ path: file, index: xy[0]!, worktree: xy[1]!, untracked: false, conflicted: false });
      if (rec.startsWith('2 ')) i++; // rename source follows
    } else if (rec.startsWith('u ')) {
      status.files.push({ path: rec.split(' ').slice(10).join(' '), index: 'U', worktree: 'U', untracked: false, conflicted: true });
    } else if (rec.startsWith('? ')) {
      status.files.push({ path: rec.slice(2), index: '?', worktree: '?', untracked: true, conflicted: false });
    }
  }
  status.dirty = status.files.length > 0;
  return status;
}

export async function gitDiffFile(cwd: string, rel: string): Promise<string> {
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', rel]);
  if (tracked.code !== 0) {
    const res = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', rel]);
    return res.stdout;
  }
  const res = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', rel]);
  return res.stdout;
}

/**
 * Local checkpoint that changes neither the working tree, the index nor any branch:
 * `git stash create` builds a commit object from tracked changes, and a private ref keeps it
 * reachable. Untracked files are not included (VOID Workshop separately keeps pre-images of
 * every file the agent edits).
 */
export async function createCheckpoint(cwd: string, label: string): Promise<{ ref: string; sha: string; includesChanges: boolean } | null> {
  const st = await gitStatus(cwd);
  if (!st.isRepo || !st.head) return null;
  const created = await git(cwd, ['stash', 'create', `void-workshop checkpoint: ${label}`]);
  const sha = created.stdout.trim() || st.head;
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error('Could not create checkpoint');
  const safe = label.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
  const ref = `refs/void-workshop/checkpoints/${safe}`;
  const upd = await git(cwd, ['update-ref', '-m', 'void-workshop checkpoint', ref, sha]);
  if (upd.code !== 0) throw new Error(`Checkpoint ref failed: ${upd.stderr.trim()}`);
  return { ref, sha, includesChanges: created.stdout.trim().length > 0 };
}

/** Commit exactly the given paths with the given message. Only called after explicit user approval. */
export async function commitPaths(cwd: string, paths: string[], message: string): Promise<{ sha: string }> {
  if (!paths.length) throw new Error('No files selected for commit');
  if (!message.trim()) throw new Error('Commit message is required');
  for (const p of paths) if (path.isAbsolute(p) || p.split('/').includes('..')) throw new Error(`Invalid path ${p}`);
  const add = await git(cwd, ['add', '--', ...paths]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const commit = await git(cwd, ['commit', '--no-verify', '-F', '-', '--', ...paths], { input: message });
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  return { sha: head.stdout.trim() };
}
