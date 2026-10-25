import type { AgentMode, PlanItem, TaskEvent } from './types';
import { msg, t, tn } from './i18n';

export const MODE_LABEL: Record<AgentMode, string> = {
  ask: msg('Ask before edits'),
  'auto-edit': msg('Edit automatically'),
  auto: msg('Auto'),
  plan: msg('Plan mode'),
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
  rate_limit: msg('Rate limited by the API'),
  overloaded: msg('The API is overloaded'),
  server_error: msg('API server error'),
  unknown: msg('Network or API problem'),
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
        text: String(p.message ?? t('Stopped')),
      });
    case 'compact':
      return push({ type: 'notice', key: k(), level: 'info', text: t('Compacting the conversation to save tokens.') });
    case 'auth.switched':
      return push({
        type: 'notice',
        key: k(),
        level: 'warn',
        text: p.to === 'subscription' ? t('Switched to your Claude plan.') : t('Switched to your API key.'),
      });
    case 'policy.denied':
    case 'agent.policyDenied':
      return push({
        type: 'notice',
        key: k(),
        level: 'warn',
        text: t('Blocked {tool}: {reason}', { tool: String(p.tool ?? 'tool'), reason: String(p.reason ?? '') }),
      });
    case 'approval.resolved':
      if (!p.summary) return state;
      return push({ type: 'approval', key: k(), summary: String(p.summary), decision: String(p.decision ?? ''), kind: String(p.kind ?? ''), auto: !!p.auto });
    case 'agent.autoApproved':
      return push({ type: 'approval', key: k(), summary: String(p.summary ?? ''), decision: 'allow', kind: String(p.kind ?? ''), auto: true });
    case 'mode':
    case 'agent.mode':
      return push({
        type: 'notice',
        key: k(),
        level: 'info',
        text: t('Mode: {mode}', { mode: MODE_LABEL[p.mode as AgentMode] ? t(MODE_LABEL[p.mode as AgentMode]) : String(p.mode) }),
      });
    case 'model':
    case 'agent.model':
      return push({ type: 'notice', key: k(), level: 'info', text: t('Model switched to {model}', { model: String(p.model) }) });
    case 'retry':
    case 'agent.retry': {
      const err = String(p.error ?? 'unknown');
      const status = p.status === null || p.status === undefined ? t('no response') : `HTTP ${String(p.status)}`;
      const reason = RETRY_TEXT[err] ? t(RETRY_TEXT[err]) : err;
      const text = p.attempt
        ? t('{reason} ({status}); retrying, attempt {attempt}…', { reason, status, attempt: String(p.attempt) })
        : t('{reason} ({status}); retrying…', { reason, status });
      return push({ type: 'retry', key: k(), text });
    }
    case 'result': {
      const tokens = (p.tokens ?? {}) as Record<string, number>;
      return push({
        type: 'usage',
        key: k(),
        deltaUsd: Number(p.deltaUsd ?? 0),
        totalUsd: Number(p.totalUsd ?? 0),
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        cacheRead: tokens.cacheRead ?? 0,
        cacheWrite: tokens.cacheWrite ?? 0,
        costBasis: String(p.costBasis ?? 'list'),
      });
    }
    case 'usage.updated': {
      const tokens = (p.tokens ?? {}) as Record<string, number>;
      return push({
        type: 'usage',
        key: k(),
        deltaUsd: Number(p.deltaUsd ?? 0),
        totalUsd: Number(p.taskCostUsd ?? 0),
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        cacheRead: tokens.cacheRead ?? 0,
        cacheWrite: tokens.cacheWrite ?? 0,
        costBasis: String(p.costBasis ?? 'list'),
      });
    }
    case 'checkpoint':
      return p.ref
        ? push({
            type: 'notice',
            key: k(),
            level: 'info',
            text: t('Local checkpoint saved at {ref} (no branch or working-tree change).', { ref: String(p.ref) }),
          })
        : state;
    case 'git.commit':
      return push({
        type: 'notice',
        key: k(),
        level: 'info',
        text: tn((p.paths as string[] | undefined)?.length ?? 0, 'Committed {n} file as {sha}.', 'Committed {n} files as {sha}.', {
          sha: String(p.sha ?? '').slice(0, 10),
        }),
      });
    case 'auth':
    case 'agent.auth':
      return push({
        type: 'notice',
        key: k(),
        level: 'info',
        text:
          p.auth === 'subscription'
            ? p.subscriptionType
              ? t('Using your Claude plan ({plan}). No API key is loaded.', { plan: String(p.subscriptionType) })
              : t('Using your Claude plan. No API key is loaded.')
            : p.auth === 'ollama' || p.apiProvider === 'ollama'
              ? t('Using the local Ollama server. No API key is loaded.')
              : t('Authenticated with your Console API key (source: {source}, provider: {provider}).', {
                  source: String(p.apiKeySource),
                  provider: String(p.apiProvider),
                }),
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
