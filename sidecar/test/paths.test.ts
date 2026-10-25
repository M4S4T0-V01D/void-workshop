import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathPolicy, canonicalProjectRoot, sensitiveReason, realpathLoose } from '../src/paths.js';
import { tempDir } from './helpers.js';

function project() {
  const root = tempDir('vw-proj-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, '.env.example'), 'SECRET=');
  return root;
}

describe('project root validation', () => {
  it('rejects system directories, home and relative paths', () => {
    expect(() => canonicalProjectRoot('/')).toThrow();
    expect(() => canonicalProjectRoot('/etc')).toThrow();
    expect(() => canonicalProjectRoot(os.homedir())).toThrow(/home directory/);
    expect(() => canonicalProjectRoot('relative/dir')).toThrow(/absolute/);
    expect(() => canonicalProjectRoot(path.join(os.homedir(), '.ssh'))).toThrow();
  });

  it('canonicalises symlinked project roots', () => {
    const root = project();
    const link = path.join(tempDir(), 'link');
    fs.symlinkSync(root, link);
    expect(canonicalProjectRoot(link)).toBe(root);
  });
});

describe('path policy', () => {
  it('allows files inside the project', () => {
    const root = project();
    const p = new PathPolicy(root);
    expect(p.check('src/a.ts', 'read')).toMatchObject({ allowed: true, sensitive: null });
    expect(p.check(path.join(root, 'src/new.ts'), 'write')).toMatchObject({ allowed: true, exists: false });
  });

  it('blocks .. traversal and absolute escapes', () => {
    const root = project();
    const p = new PathPolicy(root);
    expect(p.check('../outside.txt', 'read').allowed).toBe(false);
    expect(p.check('src/../../outside.txt', 'write').allowed).toBe(false);
    expect(p.check('/etc/passwd', 'read').allowed).toBe(false);
    expect(p.check('~/.bashrc', 'read').allowed).toBe(false);
    expect(p.check(`${root}/./src//../../x`, 'read').allowed).toBe(false);
  });

  it('blocks symlinks that point outside the project', () => {
    const root = project();
    const outside = tempDir('vw-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'innocent.txt'));
    fs.symlinkSync(outside, path.join(root, 'linkdir'));
    const p = new PathPolicy(root);
    expect(p.check('innocent.txt', 'read').allowed).toBe(false);
    expect(p.check('linkdir/secret.txt', 'read').allowed).toBe(false);
    // writing a brand-new file through a symlinked directory is also an escape
    expect(p.check('linkdir/new.txt', 'write').allowed).toBe(false);
  });

  it('allows symlinks that stay inside the project', () => {
    const root = project();
    fs.symlinkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'alias.ts'));
    const p = new PathPolicy(root);
    expect(p.check('alias.ts', 'read')).toMatchObject({ allowed: true, real: path.join(root, 'src', 'a.ts') });
  });

  it('flags sensitive files but not example env files', () => {
    const root = project();
    const p = new PathPolicy(root);
    expect(p.check('.env', 'read').sensitive).toMatch(/sensitive/);
    expect(p.check('.env.example', 'read').sensitive).toBeNull();
    fs.writeFileSync(path.join(root, 'server.pem'), 'x');
    expect(p.check('server.pem', 'read').sensitive).not.toBeNull();
  });

  it('treats a symlink named like a secret as sensitive', () => {
    const root = project();
    fs.symlinkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'id_rsa'));
    expect(new PathPolicy(root).check('id_rsa', 'read').sensitive).not.toBeNull();
  });

  it('flags hard-linked files on write', () => {
    const root = project();
    const outside = tempDir('vw-outside-');
    fs.writeFileSync(path.join(outside, 'orig.txt'), 'x');
    fs.linkSync(path.join(outside, 'orig.txt'), path.join(root, 'hl.txt'));
    const d = new PathPolicy(root).check('hl.txt', 'write');
    expect(d.allowed).toBe(true);
    expect(d.sensitive).toMatch(/hard link/);
  });

  it('rejects NUL bytes and empty paths', () => {
    const p = new PathPolicy(project());
    expect(p.check('a\0b', 'read').allowed).toBe(false);
    expect(p.check('', 'read').allowed).toBe(false);
  });

  it('respects explicitly approved extra roots only', () => {
    const root = project();
    const extra = tempDir('vw-extra-');
    fs.writeFileSync(path.join(extra, 'shared.ts'), 'x');
    expect(new PathPolicy(root).check(path.join(extra, 'shared.ts'), 'read').allowed).toBe(false);
    expect(new PathPolicy(root, [extra]).check(path.join(extra, 'shared.ts'), 'read').allowed).toBe(true);
  });

  it('sensitiveReason recognises credential directories', () => {
    expect(sensitiveReason(path.join(os.homedir(), '.ssh', 'config'))).not.toBeNull();
    expect(sensitiveReason('/x/project/.aws/credentials')).not.toBeNull();
    expect(sensitiveReason('/x/project/src/index.ts')).toBeNull();
  });

  it('realpathLoose resolves the existing prefix', () => {
    const root = project();
    expect(realpathLoose(path.join(root, 'nope', 'deeper.txt'))).toEqual({ real: path.join(root, 'nope', 'deeper.txt'), exists: false });
  });
});
