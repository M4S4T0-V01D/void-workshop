import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminStore, findWorkshopSource, isWorkshopRepo } from '../src/admin.js';
import { assessCommand } from '../src/commandPolicy.js';
import { PathPolicy } from '../src/paths.js';
import { tempDir } from './helpers.js';

function store(now = () => Date.now()) {
  const dir = tempDir('vw-admin-');
  const file = path.join(dir, 'credentials', 'admin.json');
  return { file, admin: new AdminStore(file, () => '/src/void-workshop', now) };
}

describe('admin password and session', () => {
  it('sets the first password only from the PC and keeps just a salted hash, 0600', async () => {
    const { file, admin } = store();
    await expect(admin.setPassword('hunter22', undefined, 'phone')).rejects.toMatchObject({ code: 'admin-no-password' });
    await expect(admin.setPassword('short', undefined, 'desktop')).rejects.toMatchObject({ code: 'admin-weak' });
    const status = await admin.setPassword('hunter22', undefined, 'desktop');
    expect(status).toMatchObject({ passwordSet: true, active: false, sourceDir: '/src/void-workshop' });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('hunter22');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('starts with the right password, from either device, and ends without one', async () => {
    const { file, admin } = store();
    await admin.setPassword('hunter22', undefined, 'desktop');
    await expect(admin.start('nope', 'phone')).rejects.toMatchObject({ code: 'admin-password' });
    expect(admin.active).toBe(false);
    const started = await admin.start('hunter22', 'phone', 'Pixel');
    expect(started).toMatchObject({ active: true, by: 'phone', device: 'Pixel' });
    // Survives a restart of the sidecar.
    expect(new AdminStore(file).active).toBe(true);
    expect(admin.end()).toMatchObject({ active: false, by: null });
    expect(new AdminStore(file).active).toBe(false);
  });

  it('changes the password with the current one, from the phone too', async () => {
    const { admin } = store();
    await admin.setPassword('hunter22', undefined, 'desktop');
    await expect(admin.setPassword('another1', 'wrong!', 'phone')).rejects.toMatchObject({ code: 'admin-password' });
    await admin.setPassword('another1', 'hunter22', 'phone');
    await expect(admin.start('hunter22', 'desktop')).rejects.toMatchObject({ code: 'admin-password' });
    await expect(admin.start('another1', 'desktop')).resolves.toMatchObject({ active: true });
  });

  it('locks for five minutes after five wrong passwords', async () => {
    let now = 1_000_000;
    const { admin } = store(() => now);
    await admin.setPassword('hunter22', undefined, 'desktop');
    for (let i = 0; i < 5; i++) await expect(admin.start('wrong', 'phone')).rejects.toMatchObject({ code: 'admin-password' });
    await expect(admin.start('hunter22', 'phone')).rejects.toMatchObject({ code: 'admin-locked' });
    expect(admin.status().lockedUntil).toBe(now + 5 * 60_000);
    now += 5 * 60_000 + 1;
    await expect(admin.start('hunter22', 'phone')).resolves.toMatchObject({ active: true });
  });

  it('removing the password ends the session; the restart resume is read once', async () => {
    const { admin } = store();
    await admin.setPassword('hunter22', undefined, 'desktop');
    await admin.start('hunter22', 'desktop');
    admin.setResume({ taskId: 't', mode: 'auto', install: true, at: 1 });
    expect(admin.takeResume()).toMatchObject({ taskId: 't' });
    expect(admin.takeResume()).toBeNull();
    await admin.clearPassword('hunter22');
    expect(admin.status()).toMatchObject({ passwordSet: false, active: false });
  });
});

describe('finding the Workshop source', () => {
  it('recognises this checkout, from the sidecar folder or a recent project next to it', () => {
    const repo = path.resolve(import.meta.dirname, '..', '..');
    expect(isWorkshopRepo(repo)).toBe(true);
    expect(findWorkshopSource([], path.join(repo, 'sidecar'))).toBe(fs.realpathSync(repo));
    const elsewhere = tempDir('vw-lib-');
    expect(findWorkshopSource([], elsewhere)).toBeNull();
    expect(findWorkshopSource([path.dirname(repo)], elsewhere)).toBe(fs.realpathSync(repo));
  });

  it('prefers the path install.sh recorded', () => {
    const repo = path.resolve(import.meta.dirname, '..', '..');
    const lib = tempDir('vw-lib-');
    fs.mkdirSync(path.join(lib, 'sidecar'));
    fs.writeFileSync(path.join(lib, 'source-dir'), `${repo}\n`);
    expect(findWorkshopSource([], path.join(lib, 'sidecar'))).toBe(fs.realpathSync(repo));
  });
});

describe('what an admin session opens', () => {
  const home = tempDir('vw-home-');
  const root = path.join(home, 'Projects');
  fs.mkdirSync(root);
  const data = path.join(home, '.local/share/void-workshop');
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(data, 'agent-runtime'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/void-workshop/credentials'), { recursive: true });

  it('file tools reach the logs and database, never the agent runtime or the config folder', () => {
    const normal = new PathPolicy(root, [], home, true);
    const admin = new PathPolicy(root, [], home, true, true);
    expect(normal.check(path.join(data, 'logs/sidecar.log'), 'read').allowed).toBe(false);
    expect(admin.check(path.join(data, 'logs/sidecar.log'), 'read').allowed).toBe(true);
    expect(admin.check(path.join(data, 'workshop.db'), 'read').allowed).toBe(true);
    expect(admin.check(path.join(data, 'agent-runtime/.credentials.json'), 'read').allowed).toBe(false);
    expect(admin.check(path.join(home, '.config/void-workshop/credentials/admin.json'), 'read').allowed).toBe(false);
    expect(admin.check(path.join(home, '.ssh/id_ed25519'), 'read').allowed).toBe(false);
  });

  it('commands may name the agent env variables and read the logs; credentials stay blocked', () => {
    const ctx = { root, home, fullAccess: true };
    const grep = 'grep -rn CLAUDE_CODE_ENABLE_TASKS sidecar/src';
    const logs = `tail -50 ${data}/logs/sidecar.log`;
    const db = `sqlite3 -readonly ${data}/workshop.db "select kind from task_events limit 5"`;
    for (const c of [grep, logs, db]) {
      expect(assessCommand(c, ctx).blocked).toBe(true);
      expect(assessCommand(c, { ...ctx, admin: true }).blocked).toBe(false);
    }
    for (const c of [
      'cat ~/.config/void-workshop/credentials/admin.json',
      `cat ${data}/agent-runtime/.credentials.json`,
      'cat ~/.ssh/id_ed25519',
      'bash ~/.local/lib/void-workshop/sidecar/bin/key-helper.sh',
    ]) {
      expect(assessCommand(c, { ...ctx, admin: true }).blocked).toBe(true);
    }
  });
});
