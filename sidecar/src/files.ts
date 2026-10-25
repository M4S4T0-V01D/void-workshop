import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { PathPolicy } from './paths.js';
import type { Store, FileChangeRow } from './db.js';

export const MAX_VIEW_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** Directories hidden from automatic context and collapsed in the tree. */
export const ARTIFACT_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.gradle',
  '.idea',
  'coverage',
  '.parcel-cache',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'vendor',
]);

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function fileHash(real: string): string | null {
  try {
    return sha256(fs.readFileSync(real));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface DirEntry {
  name: string;
  rel: string;
  kind: 'dir' | 'file' | 'symlink' | 'other';
  sensitive: string | null;
  artifact: boolean;
  outside: boolean;
}

export function listDir(policy: PathPolicy, rel: string): DirEntry[] {
  const decision = policy.check(rel || '.', 'read');
  if (!decision.allowed) throw new Error(decision.reason ?? 'Not allowed');
  const dir = decision.real;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const e of entries) {
    if (e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    let kind: DirEntry['kind'] = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other';
    const d = policy.check(abs, 'read');
    if (kind === 'symlink' && d.allowed && d.exists) {
      try {
        kind = fs.statSync(d.real).isDirectory() ? 'dir' : 'file';
      } catch {
        kind = 'symlink';
      }
    }
    out.push({
      name: e.name,
      rel: path.relative(policy.root, abs),
      kind,
      sensitive: d.sensitive,
      artifact: e.isDirectory() && ARTIFACT_DIRS.has(e.name),
      outside: !d.allowed,
    });
  }
  out.sort((a, b) => ((a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return out;
}

export interface FileView {
  rel: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
  sensitive: string | null;
  /** sha256 of the whole file on disk; the editor sends it back on save to detect changes made meanwhile. */
  hash: string | null;
}

export function readFileForView(policy: PathPolicy, rel: string, allowSensitive: boolean): FileView {
  const d = policy.check(rel, 'read');
  if (!d.allowed) throw new Error(d.reason ?? 'Not allowed');
  if (d.sensitive && !allowSensitive) {
    return { rel: policy.rel(d.real), size: 0, binary: false, truncated: false, content: null, sensitive: d.sensitive, hash: null };
  }
  const st = fs.statSync(d.real);
  if (!st.isFile()) throw new Error('Not a regular file');
  const fd = fs.openSync(d.real, 'r');
  try {
    const len = Math.min(st.size, MAX_VIEW_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const binary = isProbablyBinary(buf);
    return {
      rel: policy.rel(d.real),
      size: st.size,
      binary,
      truncated: st.size > MAX_VIEW_BYTES,
      content: binary ? null : buf.toString('utf8'),
      sensitive: d.sensitive,
      hash: st.size > MAX_VIEW_BYTES ? fileHash(d.real) : sha256(buf),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export class SaveConflictError extends Error {}

export interface SaveResult {
  rel: string;
  hash: string;
  size: number;
}

/**
 * Save a file from the window's editor. `baseHash` is the hash the editor loaded (null for a new
 * file); the save is refused when the file on disk no longer matches it, so edits made meanwhile
 * (by the agent or another program) are never silently overwritten. Writes go through a temp file
 * and a rename, keeping the file's mode.
 */
export function writeFileFromEditor(policy: PathPolicy, rel: string, content: string, baseHash: string | null, allowSensitive: boolean): SaveResult {
  const d = policy.check(rel, 'write');
  if (!d.allowed) throw new Error(d.reason ?? 'Not allowed');
  if (d.outside) throw new Error('Outside the project');
  if (d.sensitive && !allowSensitive) throw new Error(`Sensitive file (${d.sensitive}): confirm before saving`);
  const data = Buffer.from(content, 'utf8');
  if (data.length > MAX_VIEW_BYTES) throw new Error('File too large to save from the editor');
  const current = fileHash(d.real);
  if (current !== baseHash) {
    throw new SaveConflictError(current === null ? 'The file was deleted since it was opened' : 'The file changed on disk since it was opened');
  }
  if (d.exists && !fs.statSync(d.real).isFile()) throw new Error('Not a regular file');
  if (!fs.existsSync(path.dirname(d.real))) throw new Error('The folder does not exist');
  const mode = d.exists ? fs.statSync(d.real).mode & 0o7777 : 0o644;
  const tmp = `${d.real}.void-save-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, d.real);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { rel: policy.rel(d.real), hash: sha256(data), size: data.length };
}

export function unifiedDiff(rel: string, before: string | null, after: string | null): string {
  const a = before ?? '';
  const b = after ?? '';
  if (a.length + b.length > MAX_DIFF_BYTES) return `(diff omitted: file too large, ${a.length} → ${b.length} bytes)`;
  return createTwoFilesPatch(before === null ? '/dev/null' : `a/${rel}`, after === null ? '/dev/null' : `b/${rel}`, a, b, '', '', { context: 3 });
}

export class EditApplyError extends Error {}

/** Apply an Edit-tool style replacement exactly as the tool would, or explain why it cannot apply. */
export function applyEdit(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === '') {
    if (content.length === 0) return newString;
    throw new EditApplyError('old_string is empty but the file is not empty');
  }
  const first = content.indexOf(oldString);
  if (first < 0) throw new EditApplyError('old_string was not found in the current file (it may have changed since the agent read it)');
  if (!replaceAll && content.indexOf(oldString, first + oldString.length) >= 0) {
    throw new EditApplyError('old_string matches more than once; the edit is ambiguous');
  }
  return replaceAll ? content.split(oldString).join(newString) : content.slice(0, first) + newString + content.slice(first + oldString.length);
}

/**
 * Keeps the original content of every file a task changes, so each change can be reviewed
 * against the original and rejected (restored) individually.
 */
export class PreimageStore {
  constructor(
    private readonly baseDir: string,
    private readonly store: Store,
  ) {}

  private fileFor(taskId: string, real: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) throw new Error('bad task id');
    return path.join(this.baseDir, taskId, sha256(real).slice(0, 32));
  }

  /** Record the original content the first time a task touches a file. Idempotent. */
  capture(taskId: string, real: string): FileChangeRow {
    const existing = this.store.getFileChange(taskId, real);
    if (existing) return existing;
    const dest = this.fileFor(taskId, real);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    let existed = 0;
    let preHash: string | null = null;
    if (fs.existsSync(real)) {
      const data = fs.readFileSync(real);
      fs.writeFileSync(dest, data, { mode: 0o600 });
      existed = 1;
      preHash = sha256(data);
    }
    const row = { task_id: taskId, path: real, status: 'proposed' as const, preimage_file: existed ? dest : null, existed, pre_hash: preHash, post_hash: null };
    this.store.upsertFileChange(row);
    return { ...row, updated_at: Date.now() };
  }

  original(row: FileChangeRow): string | null {
    if (!row.existed || !row.preimage_file) return null;
    return fs.readFileSync(row.preimage_file, 'utf8');
  }

  /** Accept: keep the current content, drop the stored original. */
  accept(taskId: string, real: string): void {
    const row = this.store.getFileChange(taskId, real);
    if (!row) throw new Error('No recorded change for this file');
    if (row.preimage_file) fs.rmSync(row.preimage_file, { force: true });
    this.store.upsertFileChange({ ...row, status: 'accepted', preimage_file: null });
  }

  /**
   * Reject: restore the original. Refuses (status `conflict`) when the file changed after the
   * agent's last write, unless `force` is set, so external edits are never silently overwritten.
   */
  reject(taskId: string, real: string, force = false): { restored: boolean; conflict: boolean } {
    const row = this.store.getFileChange(taskId, real);
    if (!row) throw new Error('No recorded change for this file');
    if (row.status === 'accepted') throw new Error('Change was already accepted; its original is no longer stored');
    const current = fileHash(real);
    if (!force && row.post_hash && current !== row.post_hash) {
      this.store.setFileChangeStatus(taskId, real, 'conflict');
      return { restored: false, conflict: true };
    }
    if (row.existed && row.preimage_file) {
      const tmp = `${real}.void-restore-${process.pid}`;
      const mode = fs.existsSync(real) ? fs.statSync(real).mode & 0o7777 : 0o644;
      fs.copyFileSync(row.preimage_file, tmp);
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, real);
    } else if (fs.existsSync(real)) {
      fs.rmSync(real);
    }
    this.store.setFileChangeStatus(taskId, real, 'rejected');
    return { restored: true, conflict: false };
  }
}
