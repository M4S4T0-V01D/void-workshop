import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdit, EditApplyError, fileHash, listDir, MAX_VIEW_BYTES, PreimageStore, readFileForView, SaveConflictError, unifiedDiff, writeFileFromEditor } from '../src/files.js';
import { Store } from '../src/db.js';
import { PathPolicy } from '../src/paths.js';
import { tempDir } from './helpers.js';

const TASK = '44444444-4444-4444-8444-444444444444';

function setup() {
  const root = tempDir('vw-proj-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=abc');
  fs.mkdirSync(path.join(root, 'node_modules'));
  const store = new Store(':memory:');
  store.createTask({ id: TASK, project: root, title: 't', prompt: 'p', model: 'm', state: 'executing' });
  const pre = new PreimageStore(path.join(tempDir(), 'pre'), store);
  return { root, store, pre, policy: new PathPolicy(root) };
}

describe('edit application', () => {
  it('applies unique replacements and rejects ambiguous or stale edits', () => {
    expect(applyEdit('a b c', 'b', 'B')).toBe('a B c');
    expect(applyEdit('x x', 'x', 'y', true)).toBe('y y');
    expect(() => applyEdit('x x', 'x', 'y')).toThrow(EditApplyError);
    expect(() => applyEdit('abc', 'zzz', 'y')).toThrow(/not found/);
    expect(applyEdit('', '', 'new file')).toBe('new file');
  });

  it('produces a unified diff for new, modified and deleted files', () => {
    expect(unifiedDiff('a.txt', 'one\n', 'uno\n')).toContain('-one\n+uno');
    expect(unifiedDiff('n.txt', null, 'hi\n')).toContain('--- /dev/null');
    expect(unifiedDiff('d.txt', 'bye\n', null)).toContain('+++ /dev/null');
  });
});

describe('file tree and viewer', () => {
  it('lists entries, hides .git, marks artifacts and sensitive files', () => {
    const { root, policy } = setup();
    fs.mkdirSync(path.join(root, '.git'));
    const entries = listDir(policy, '');
    expect(entries.map((e) => e.name)).not.toContain('.git');
    expect(entries.find((e) => e.name === 'node_modules')?.artifact).toBe(true);
    expect(entries.find((e) => e.name === '.env')?.sensitive).toBeTruthy();
  });

  it('withholds sensitive file contents unless explicitly allowed', () => {
    const { policy } = setup();
    expect(readFileForView(policy, '.env', false).content).toBeNull();
    expect(readFileForView(policy, '.env', true).content).toBe('TOKEN=abc');
    expect(() => readFileForView(policy, '../../etc/passwd', true)).toThrow();
  });
});

describe('saving from the editor', () => {
  it('saves when the file is unchanged since it was opened, keeping its mode', () => {
    const { root, policy } = setup();
    const file = path.join(root, 'a.txt');
    fs.chmodSync(file, 0o755);
    const view = readFileForView(policy, 'a.txt', false);
    expect(view.hash).toBe(fileHash(file));
    const saved = writeFileFromEditor(policy, 'a.txt', 'edited\n', view.hash, false);
    expect(fs.readFileSync(file, 'utf8')).toBe('edited\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    expect(saved.hash).toBe(fileHash(file));
    // saving again from the new hash works; no temp files are left behind
    writeFileFromEditor(policy, 'a.txt', 'again\n', saved.hash, false);
    expect(fs.readdirSync(root).filter((n) => n.includes('void-save'))).toEqual([]);
  });

  it('refuses to overwrite changes made on disk since the file was opened', () => {
    const { root, policy } = setup();
    const view = readFileForView(policy, 'a.txt', false);
    fs.writeFileSync(path.join(root, 'a.txt'), 'agent edit\n');
    expect(() => writeFileFromEditor(policy, 'a.txt', 'mine\n', view.hash, false)).toThrow(SaveConflictError);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('agent edit\n');
    // a "new" file that appeared meanwhile is a conflict too
    fs.writeFileSync(path.join(root, 'n.txt'), 'x');
    expect(() => writeFileFromEditor(policy, 'n.txt', 'y', null, false)).toThrow(SaveConflictError);
  });

  it('creates new files only inside existing project folders', () => {
    const { root, policy } = setup();
    writeFileFromEditor(policy, 'new.ts', 'export {};\n', null, false);
    expect(fs.readFileSync(path.join(root, 'new.ts'), 'utf8')).toBe('export {};\n');
    expect(() => writeFileFromEditor(policy, 'missing/dir/x.ts', '', null, false)).toThrow(/folder/);
    expect(() => writeFileFromEditor(policy, '../escape.txt', 'x', null, false)).toThrow(/Outside/);
    expect(() => writeFileFromEditor(policy, 'node_modules', 'x', null, false)).toThrow(/directory/);
  });

  it('asks before saving sensitive files and refuses files that are too large', () => {
    const { root, policy } = setup();
    const env = readFileForView(policy, '.env', true);
    expect(() => writeFileFromEditor(policy, '.env', 'TOKEN=new', env.hash, false)).toThrow(/Sensitive/);
    writeFileFromEditor(policy, '.env', 'TOKEN=new', env.hash, true);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('TOKEN=new');
    // a hard-linked file may alias something outside the project
    fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'link.txt'));
    expect(() => writeFileFromEditor(policy, 'link.txt', 'x', fileHash(path.join(root, 'link.txt')), false)).toThrow(/Sensitive/);
    expect(() => writeFileFromEditor(policy, 'big.txt', 'x'.repeat(MAX_VIEW_BYTES + 1), null, false)).toThrow(/too large/);
  });
});

describe('pre-images and review', () => {
  it('keeps the original until the change is accepted', () => {
    const { root, pre, store } = setup();
    const file = path.join(root, 'a.txt');
    const row = pre.capture(TASK, file);
    fs.writeFileSync(file, 'changed\n');
    store.upsertFileChange({ ...row, status: 'applied', post_hash: fileHash(file) });
    expect(pre.original(store.getFileChange(TASK, file)!)).toBe('one\ntwo\nthree\n');
    // capturing again must not overwrite the original with the modified content
    pre.capture(TASK, file);
    expect(pre.original(store.getFileChange(TASK, file)!)).toBe('one\ntwo\nthree\n');
    pre.accept(TASK, file);
    expect(store.getFileChange(TASK, file)?.status).toBe('accepted');
    expect(fs.readFileSync(file, 'utf8')).toBe('changed\n');
  });

  it('reject restores the original file, or removes a newly created one', () => {
    const { root, pre, store } = setup();
    const file = path.join(root, 'a.txt');
    const row = pre.capture(TASK, file);
    fs.writeFileSync(file, 'changed\n');
    store.upsertFileChange({ ...row, status: 'applied', post_hash: fileHash(file) });
    expect(pre.reject(TASK, file)).toEqual({ restored: true, conflict: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');

    const created = path.join(root, 'new.txt');
    const row2 = pre.capture(TASK, created);
    fs.writeFileSync(created, 'new\n');
    store.upsertFileChange({ ...row2, status: 'applied', post_hash: fileHash(created) });
    pre.reject(TASK, created);
    expect(fs.existsSync(created)).toBe(false);
  });

  it('never silently overwrites a file edited outside the app', () => {
    const { root, pre, store } = setup();
    const file = path.join(root, 'a.txt');
    const row = pre.capture(TASK, file);
    fs.writeFileSync(file, 'agent edit\n');
    store.upsertFileChange({ ...row, status: 'applied', post_hash: fileHash(file) });
    fs.writeFileSync(file, 'user edited this afterwards\n');
    expect(pre.reject(TASK, file)).toEqual({ restored: false, conflict: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('user edited this afterwards\n');
    expect(store.getFileChange(TASK, file)?.status).toBe('conflict');
    // explicit force restores
    expect(pre.reject(TASK, file, true).restored).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('preserves file permissions when restoring', () => {
    const { root, pre, store } = setup();
    const file = path.join(root, 'run.sh');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    const row = pre.capture(TASK, file);
    fs.writeFileSync(file, '#!/bin/sh\necho hi\n');
    store.upsertFileChange({ ...row, status: 'applied', post_hash: fileHash(file) });
    pre.reject(TASK, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
  });
});
