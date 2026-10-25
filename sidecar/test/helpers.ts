import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AppPaths } from '../src/config.js';
import { ensureAppDirs } from '../src/config.js';

/** Disposable directory under the OS temp dir; never touches real projects. */
export function tempDir(prefix = 'vw-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function testPaths(base = tempDir('vw-app-')): AppPaths {
  const p: AppPaths = {
    dataDir: path.join(base, 'data'),
    configDir: path.join(base, 'config'),
    dbPath: path.join(base, 'data', 'workshop.db'),
    claudeConfigDir: path.join(base, 'data', 'agent-runtime'),
    logDir: path.join(base, 'data', 'logs'),
    preimageDir: path.join(base, 'data', 'preimages'),
    imageDir: path.join(base, 'data', 'images'),
    keyFile: path.join(base, 'config', 'credentials', 'anthropic-api-key'),
    keyHelper: path.resolve(import.meta.dirname, '..', 'bin', 'key-helper.sh'),
  };
  ensureAppDirs(p);
  return p;
}

/** A small disposable git repository with one commit. */
export function tempRepo(): string {
  const dir = tempDir('vw-repo-');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

export const FAKE_KEY = 'sk-ant-api03-' + 'A'.repeat(80) + '-BBBBBBAA';

export function writeKeyFile(paths: AppPaths, key = FAKE_KEY): void {
  fs.mkdirSync(path.dirname(paths.keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.keyFile, key, { mode: 0o600 });
}
