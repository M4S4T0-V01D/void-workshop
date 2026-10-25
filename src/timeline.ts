import type { AgentMode, PlanItem, TaskEvent } from './types';

export const MODE_LABEL: Record<AgentMode, string> = {
  ask: 'Ask before edits',
  'auto-edit': 'Edit automatically',
  auto: 'Auto',
  plan: 'Plan mode',
};

export type TimelineItem =
  | { type: 'user'; key: string; text: string }
  | { type: 'assistant'; key: string; text: string }
  | { type: 'tool'; key: string; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; result?: string }
  | { type: 'plan'; key: string; text: string }
  | { type: 'notice'; key: string; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'approval'; key: string; summary: string; decision: string; kind: string; auto?: boolean }
  | { type: 'usage'; key: string; deltaUsd: number; totalUsd: number; input: number; output: number; cacheRead: number; cacheWrite: number; costBasis: string }
  | { type: 'retry'; key: string; text: string }
  | { type: 'image'; key: string; imageId: string; name: string; mediaType: string; bytes: number };

export interface TimelineState {
  items: TimelineItem[];
  plan: PlanItem[];
  streaming: string;
}

export const EMPTY_TIMELINE: TimelineState = { items: [], plan: [], streaming: '' };

let seq = 0;
const k = () => `i${++seq}`;

const RETRY_TEXT: Record<string, string> = {
  rate_limit: 'Rate limited by the API',
  overloaded: 'The API is overloaded',
  server_error: 'API server error',
  unknown: 'Network or API problem',
};

/** Fold one event (persisted kind or live event name) into the timeline. */
export function applyEvent(state: TimelineState, kind: string, p: Record<string, unknown>): TimelineState {
  const items = state.items;
  const push = (item: TimelineItem): TimelineState => ({ ...state, items: [...items, item] });
  switch (kind) {
    case 'user':
    case 'agent.user':
      return push({ type: 'user', key: k(), text: String(p.text ?? '') });
    case 'agent.delta':
      return { ...state, streaming: state.streaming + String(p.text ?? '') };
    case 'agent.messageStart':
      return { ...state, streaming: '' };
    case 'assistant':
    case 'agent.text':
      if (p.sub) return state;
      return { ...push({ type: 'assistant', key: k(), text: String(p.text ?? '') }), streaming: '' };
    case 'tool':
    case 'agent.tool': {
      const name = String(p.name ?? '');
      // Plan bookkeeping shows in the Plan panel, not as conversation lines.
      if (name === 'TodoWrite' || name === 'TaskList' || name === 'TaskGet') return state;
      return { ...push({ type: 'tool', key: k(), id: String(p.id ?? ''), name, summary: String(p.summary ?? name), status: 'running' }), streaming: '' };
    }
    case 'tool.result':
    case 'agent.toolResult': {
      const id = String(p.id ?? '');
      let found = false;
      const next = items.map((it) => {
        if (it.type === 'tool' && it.id === id) {
          found = true;
          return { ...it, status: p.isError ? ('error' as const) : ('ok' as const), result: String(p.text ?? '') };
        }
        return it;
      });
      return found ? { ...state, items: next } : state;
    }
    case 'image':
    case 'agent.image':
      if (typeof p.imageId !== 'string') return state;
      return push({
        type: 'image',
        key: k(),
        imageId: p.imageId,
        name: String(p.name ?? 'image'),
        mediaType: String(p.mediaType ?? ''),
        bytes: Number(p.bytes ?? 0),
      });
    case 'plan':
    case 'agent.plan': {
      const plan = Array.isArray(p.items) && p.items.length ? (p.items as PlanItem[]) : state.plan;
      return { ...push({ type: 'plan', key: k(), text: String(p.text ?? '') }), plan, streaming: '' };
    }
    case 'todos':
    case 'agent.todos':
      return { ...state, plan: Array.isArray(p.items) ? (p.items as PlanItem[]) : state.plan };
    case 'agent.notice':
      return push({ type: 'notice', key: k(), level: (p.level as 'info' | 'warn' | 'error') ?? 'info', text: String(p.text ?? '') });
    case 'stopped':
      return push({
        type: 'notice',
        key: k(),
        level: p.state === 'stopped-budget' || p.state === 'stopped-limit' ? 'warn' : 'error',
        text: String(p.message ?? 'Stopped'),
      });
    case 'compact':
      return push({ type: 'notice', key: k(), level: 'info', text: 'Compacting the conversation to save tokens.' });
    case 'auth.switched':
      return push({ type: 'notice', key: k(), level: 'warn', text: `Switched to ${p.to === 'subscription' ? 'your Claude plan' : 'your API key'}.` });
    case 'policy.denied':
    case 'agent.policyDenied':
      return push({ type: 'notice', key: k(), level: 'warn', text: `Blocked ${String(p.tool ?? 'tool')}: ${String(p.reason ?? '')}` });
    case 'approval.resolved':
      if (!p.summary) return state;
      return push({ type: 'approval', key: k(), summary: String(p.summary), decision: String(p.decision ?? ''), kind: String(p.kind ?? ''), auto: !!p.auto });
    case 'agent.autoApproved':
      return push({ type: 'approval', key: k(), summary: String(p.summary ?? ''), decision: 'allow', kind: String(p.kind ?? ''), auto: true });
    case 'mode':
    case 'agent.mode':
      return push({ type: 'notice', key: k(), level: 'info', text: `Mode: ${MODE_LABEL[p.mode as AgentMode] ?? String(p.mode)}` });
    case 'model':
    case 'agent.model':
      return push({ type: 'notice', key: k(), level: 'info', text: `Model switched to ${String(p.model)}` });
    case 'retry':
    case 'agent.retry': {
      const err = String(p.error ?? 'unknown');
      const status = p.status === null || p.status === undefined ? 'no response' : `HTTP ${String(p.status)}`;
      return push({ type: 'retry', key: k(), text: `${RETRY_TEXT[err] ?? err} (${status}); retrying${p.attempt ? `, attempt ${String(p.attempt)}` : ''}…` });
    }
    case 'result': {
      const t = (p.tokens ?? {}) as Record<string, number>;
      return push({
        type: 'usage',
        key: k(),
        deltaUsd: Number(p.deltaUsd ?? 0),
        totalUsd: Number(p.totalUsd ?? 0),
        input: t.input ?? 0,
        output: t.output ?? 0,
        cacheRead: t.cacheRead ?? 0,
        cacheWrite: t.cacheWrite ?? 0,
        costBasis: String(p.costBasis ?? 'list'),
      });
    }
    case 'usage.updated': {
      const t = (p.tokens ?? {}) as Record<string, number>;
      return push({
        type: 'usage',
        key: k(),
        deltaUsd: Number(p.deltaUsd ?? 0),
        totalUsd: Number(p.taskCostUsd ?? 0),
        input: t.input ?? 0,
        output: t.output ?? 0,
        cacheRead: t.cacheRead ?? 0,
        cacheWrite: t.cacheWrite ?? 0,
        costBasis: String(p.costBasis ?? 'list'),
      });
    }
    case 'checkpoint':
      return p.ref
        ? push({ type: 'notice', key: k(), level: 'info', text: `Local checkpoint saved at ${String(p.ref)} (no branch or working-tree change).` })
        : state;
    case 'git.commit':
      return push({
        type: 'notice',
        key: k(),
        level: 'info',
        text: `Committed ${String((p.paths as string[] | undefined)?.length ?? 0)} file(s) as ${String(p.sha ?? '').slice(0, 10)}.`,
      });
    case 'auth':
    case 'agent.auth':
      return push({
        type: 'notice',
        key: k(),
        level: 'info',
        text:
          p.auth === 'subscription'
            ? `Using your Claude plan${p.subscriptionType ? ` (${String(p.subscriptionType)})` : ''}. No API key is loaded.`
            : p.auth === 'ollama' || p.apiProvider === 'ollama'
              ? 'Using the local Ollama server. No API key is loaded.'
              : `Authenticated with your Console API key (source: ${String(p.apiKeySource)}, provider: ${String(p.apiProvider)}).`,
      });
    default:
      return state;
  }
}

export function buildTimeline(events: TaskEvent[]): TimelineState {
  let s = EMPTY_TIMELINE;
  for (const e of events) s = applyEvent(s, e.kind, e.payload ?? {});
  return { ...s, streaming: '' };
}
