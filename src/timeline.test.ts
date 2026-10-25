import { describe, expect, it } from 'vitest';
import { applyEvent, buildTimeline, EMPTY_TIMELINE } from './timeline';

describe('timeline', () => {
  it('rebuilds a persisted task history', () => {
    const t = buildTimeline([
      { id: 1, ts: 1, kind: 'user', payload: { text: 'Add tests' } },
      { id: 2, ts: 2, kind: 'tool', payload: { id: 't1', name: 'Read', summary: 'Read src/a.ts' } },
      { id: 3, ts: 3, kind: 'tool.result', payload: { id: 't1', isError: false, text: 'contents' } },
      { id: 4, ts: 4, kind: 'assistant', payload: { text: 'Here is the plan' } },
      { id: 5, ts: 5, kind: 'result', payload: { deltaUsd: 0.02, totalUsd: 0.02, tokens: { input: 10, output: 5, cacheRead: 3 }, costBasis: 'list' } },
    ]);
    expect(t.items.map((i) => i.type)).toEqual(['user', 'tool', 'assistant', 'usage']);
    const tool = t.items[1];
    expect(tool?.type === 'tool' && tool.status).toBe('ok');
  });

  it('accumulates streaming text and clears it on the final block', () => {
    let s = applyEvent(EMPTY_TIMELINE, 'agent.delta', { text: 'Hel' });
    s = applyEvent(s, 'agent.delta', { text: 'lo' });
    expect(s.streaming).toBe('Hello');
    s = applyEvent(s, 'agent.text', { text: 'Hello' });
    expect(s.streaming).toBe('');
    expect(s.items.at(-1)).toMatchObject({ type: 'assistant', text: 'Hello' });
  });

  it('tracks plan items and errors', () => {
    let s = applyEvent(EMPTY_TIMELINE, 'agent.todos', { items: [{ ref: 'a', id: '1', subject: 'x', description: '', status: 'pending' }] });
    expect(s.plan).toHaveLength(1);
    s = applyEvent(s, 'agent.tool', { id: 'b', name: 'Bash', summary: 'Run: npm test' });
    s = applyEvent(s, 'agent.toolResult', { id: 'b', isError: true, text: 'fail' });
    const tool = s.items.at(-1);
    expect(tool?.type === 'tool' && tool.status).toBe('error');
  });

  it('describes retries honestly', () => {
    const s = applyEvent(EMPTY_TIMELINE, 'agent.retry', { error: 'rate_limit', status: 429, attempt: 2 });
    expect(s.items[0]).toMatchObject({ type: 'retry' });
    expect((s.items[0] as { text: string }).text).toMatch(/Rate limited.*429.*attempt 2/);
  });

  it('shows mode and model switches and auto-approvals, live and from history', () => {
    let s = applyEvent(EMPTY_TIMELINE, 'agent.mode', { mode: 'auto-edit' });
    s = applyEvent(s, 'agent.model', { model: 'claude-x' });
    s = applyEvent(s, 'agent.autoApproved', { kind: 'file-change', summary: 'Modify a.ts' });
    expect(s.items).toMatchObject([
      { type: 'notice', text: 'Mode: Edit automatically' },
      { type: 'notice', text: 'Model switched to claude-x' },
      { type: 'approval', decision: 'allow', auto: true, summary: 'Modify a.ts' },
    ]);
    const h = buildTimeline([
      { id: 1, ts: 0, kind: 'approval.resolved', payload: { kind: 'command', summary: 'Run tests', decision: 'allow', auto: true } },
    ] as never);
    expect(h.items[0]).toMatchObject({ type: 'approval', auto: true });
  });
});
