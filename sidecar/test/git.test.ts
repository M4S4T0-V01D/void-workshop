import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { commitPaths, createCheckpoint, git, gitDiffFile, gitStatus } from '../src/git.js';
import { tempDir, tempRepo } from './helpers.js';

const raw = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

describe('git integration', () => {
  it('reports non-repositories', async () => {
    expect((await gitStatus(tempDir())).isRepo).toBe(false);
  });

  it('reports branch and working tree state', async () => {
    const repo = tempRepo();
    fs.appendFileSync(path.join(repo, 'README.md'), 'more\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u');
    const st = await gitStatus(repo);
    expect(st).toMatchObject({ isRepo: true, branch: 'main', dirty: true });
    expect(st.files.find((f) => f.path === 'README.md')?.worktree).toBe('M');
    expect(st.files.find((f) => f.path === 'untracked.txt')?.untracked).toBe(true);
    expect(await gitDiffFile(repo, 'README.md')).toContain('+more');
    expect(await gitDiffFile(repo, 'untracked.txt')).toContain('+u');
  });

  it('checkpoints without touching the working tree, index, branches or history', async () => {
    const repo = tempRepo();
    fs.appendFileSync(path.join(repo, 'README.md'), 'wip\n');
    const headBefore = raw(repo, 'rev-parse', 'HEAD');
    const logBefore = raw(repo, 'log', '--oneline');
    const cp = await createCheckpoint(repo, 'test');
    expect(cp?.includesChanges).toBe(true);
    expect(raw(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(raw(repo, 'log', '--oneline')).toBe(logBefore);
    expect(raw(repo, 'stash', 'list')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('wip');
    expect(raw(repo, 'show', `${cp!.ref}:README.md`)).toContain('wip');
  });

  it('commits only the selected paths and keeps other work uncommitted', async () => {
    const repo = tempRepo();
    fs.appendFileSync(path.join(repo, 'README.md'), 'commit me\n');
    fs.appendFileSync(path.join(repo, 'src', 'math.js'), '// keep me uncommitted\n');
    const { sha } = await commitPaths(repo, ['README.md'], 'docs: update');
    expect(raw(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(raw(repo, 'log', '--oneline')).toMatch(/docs: update[\s\S]*initial/);
    expect(raw(repo, 'status', '--porcelain')).toContain('src/math.js');
  });

  it('does not run repository-configured fsmonitor programs', async () => {
    const repo = tempRepo();
    const marker = path.join(tempDir(), 'pwned');
    const evil = path.join(repo, 'evil.sh');
    fs.writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    raw(repo, 'config', 'core.fsmonitor', evil);
    await gitStatus(repo);
    await git(repo, ['diff']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects path traversal in commit paths', async () => {
    const repo = tempRepo();
    await expect(commitPaths(repo, ['../x'], 'm')).rejects.toThrow();
    await expect(commitPaths(repo, ['/etc/passwd'], 'm')).rejects.toThrow();
  });
});
