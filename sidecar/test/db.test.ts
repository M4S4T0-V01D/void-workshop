import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { tempDir } from './helpers.js';

describe('persistence', () => {
  it('survives an application restart', () => {
    const dir = tempDir();
    const file = path.join(dir, 'w.db');
    const a = new Store(file);
    a.updateSettings({ perTaskBudgetUsd: 0.5, themeId: 'nebula' });
    a.touchProject('/x/proj', 'proj');
    a.createTask({ id: '11111111-1111-4111-8111-111111111111', project: '/x/proj', title: 't', prompt: 'p', model: 'm', state: 'executing' });
    a.addEvent('11111111-1111-4111-8111-111111111111', 'assistant', { text: 'hello' });
    a.addUsage({ taskId: '11111111-1111-4111-8111-111111111111', model: 'm', costUsd: 0.12, inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 });
    a.close();

    const b = new Store(file);
    expect(b.getSettings()).toMatchObject({ perTaskBudgetUsd: 0.5, themeId: 'nebula' });
    expect(b.recentProjects()[0]?.path).toBe('/x/proj');
    expect(b.spentOn()).toBeCloseTo(0.12);
    expect(b.events('11111111-1111-4111-8111-111111111111')[0]?.payload).toEqual({ text: 'hello' });
    // A task that was running when the app exited is marked interrupted, not left "running".
    expect(b.markInterruptedTasks()).toBe(1);
    expect(b.getTask('11111111-1111-4111-8111-111111111111')?.state).toBe('interrupted');
    b.close();
  });

  it('creates the database file with owner-only permissions', () => {
    const file = path.join(tempDir(), 'w.db');
    new Store(file).close();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('redacts secrets in persisted events and command history', () => {
    const s = new Store(':memory:');
    s.createTask({ id: '22222222-2222-4222-8222-222222222222', project: '/p', title: 't', prompt: 'p', model: 'm', state: 'idle' });
    s.addEvent('22222222-2222-4222-8222-222222222222', 'tool.result', { text: 'found sk-ant-api03-SECRETSECRETSECRETSECRET in log' });
    s.addCommandRun({
      id: 'r1',
      taskId: null,
      project: '/p',
      origin: 'user',
      command: 'curl -H "x-api-key: abcdef123456" x',
      cwd: '/p',
      reason: null,
      status: 'running',
    });
    expect(JSON.stringify(s.events('22222222-2222-4222-8222-222222222222'))).not.toContain('SECRETSECRET');
    expect(JSON.stringify(s.commandRuns('/p'))).not.toContain('abcdef123456');
  });

  it('flags persist and clear', () => {
    const s = new Store(':memory:');
    s.setFlag('billingBlocked', { message: 'x' });
    expect(s.getFlag('billingBlocked')).toEqual({ message: 'x' });
    s.setFlag('billingBlocked', null);
    expect(s.getFlag('billingBlocked')).toBeNull();
  });

  it('rejects unknown task columns', () => {
    const s = new Store(':memory:');
    s.createTask({ id: '33333333-3333-4333-8333-333333333333', project: '/p', title: 't', prompt: 'p', model: 'm', state: 'idle' });
    expect(() => s.updateTask('33333333-3333-4333-8333-333333333333', { ['project; DROP TABLE tasks' as 'title']: 'x' })).toThrow();
  });
});

describe('search, usage by model and export', () => {
  const A = '22222222-2222-4222-8222-222222222222';
  const B = '33333333-3333-4333-8333-333333333333';
  const store = () => {
    const s = new Store(path.join(tempDir(), 'w.db'));
    s.createTask({ id: A, project: '/x/a', title: 'Fix login', prompt: 'p', model: 'sonnet', state: 'completed' });
    s.createTask({ id: B, project: '/x/b', title: 'Other', prompt: 'p', model: 'opus', state: 'completed' });
    s.addEvent(B, 'assistant', { text: 'The 100%_ widget renders now' });
    s.addEvent(B, 'tool', { name: 'Bash', summary: 'login only in a tool' });
    s.addUsage({ taskId: A, model: 'sonnet', costUsd: 0.1, inputTokens: 10, outputTokens: 5, cacheRead: 100, cacheWrite: 1 });
    s.addUsage({ taskId: B, model: 'opus', costUsd: 0.3, inputTokens: 1, outputTokens: 50, cacheRead: 0, cacheWrite: 0 });
    s.addUsage({ taskId: A, model: 'sonnet', costUsd: 0.1, inputTokens: 10, outputTokens: 5, cacheRead: 100, cacheWrite: 1 });
    return s;
  };

  it('finds tasks by title or message, per project, with LIKE characters taken literally', () => {
    const s = store();
    expect(s.searchTasks('login', null).map((r) => r.task.id)).toEqual([A]);
    expect(s.searchTasks('100%_', null).map((r) => r.task.id)).toEqual([B]);
    expect(s.searchTasks('1_0', null)).toEqual([]);
    expect(s.searchTasks('widget', '/x/a')).toEqual([]);
    expect(s.searchTasks('WIDGET', '/x/b').map((r) => r.task.id)).toEqual([B]);
    expect(s.searchTasks('widget', null)[0]?.snippet).toContain('widget renders');
  });

  it('sums usage per model', () => {
    const rows = store().usageByModel('2000-01-01');
    expect(rows.find((r) => r.model === 'sonnet')).toMatchObject({ input: 20, output: 10, cacheRead: 200, cacheWrite: 2 });
    expect(rows.find((r) => r.model === 'opus')?.output).toBe(50);
    expect(store().usageByModel('2999-01-01')).toEqual([]);
  });

  it('exports a task as Markdown with a safe file name', async () => {
    const { taskMarkdown, exportName } = await import('../src/export.js');
    const s = store();
    const task = s.getTask(B)!;
    const md = taskMarkdown(task, s.events(B));
    expect(md).toMatch(/^# Other\n/);
    expect(md).toContain('The 100%_ widget renders now');
    expect(md).toContain('- `Bash` login only in a tool');
    expect(exportName({ ...task, title: '../etc/pass wd' })).toBe(`etc-pass-wd-${B.slice(0, 8)}.md`);
  });
});
