import type { TaskRow } from './db.js';

/** A task as a Markdown report: what was asked, what the agent said and did, and what it cost. */

type Event = { ts: number; kind: string; payload: unknown };

const fence = (text: string) => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${text}\n${ticks}`;
};
const when = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function taskMarkdown(task: TaskRow, events: Event[]): string {
  const out: string[] = [
    `# ${task.title}`,
    '',
    `- Project: \`${task.project}\``,
    `- Model: ${task.model}`,
    `- Started: ${when(task.created_at)}, last activity: ${when(task.updated_at)}`,
    `- State: ${task.state}`,
    `- Tokens: ${task.input_tokens} input, ${task.output_tokens} output, ${task.cache_read_tokens} cache read, ${task.cache_write_tokens} cache write`,
    '',
  ];
  let tools: string[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    out.push(...tools, '');
    tools = [];
  };
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case 'user':
        flushTools();
        out.push(`## You (${when(e.ts)})`, '', str(p.text), '');
        break;
      case 'assistant':
        flushTools();
        if (str(p.text).trim()) out.push('## Agent', '', str(p.text), '');
        break;
      case 'plan':
        flushTools();
        out.push('## Plan', '', str(p.text), '');
        break;
      case 'tool':
        tools.push(`- \`${str(p.name)}\` ${str(p.summary).replace(/\s+/g, ' ').slice(0, 300)}`);
        break;
      case 'tool.result':
        if (p.isError && tools.length) tools[tools.length - 1] += ' (failed)';
        break;
      case 'image':
        tools.push(`- Picture: ${str(p.name)}`);
        break;
      case 'stopped':
        flushTools();
        out.push(`> ${str(p.message)}`, '');
        break;
    }
  }
  flushTools();
  if (task.summary) out.push('## Summary', '', task.summary, '');
  if (task.error) out.push('## Error', '', fence(task.error), '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A file name for the report: the title with anything unusual replaced. */
export function exportName(task: TaskRow): string {
  const stem = task.title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'task';
  return `${stem}-${task.id.slice(0, 8)}.md`;
}
