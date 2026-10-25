import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronUp,
  CircleUser,
  ClipboardList,
  FilePen,
  Gauge,
  Hand,
  KeyRound,
  ListPlus,
  Loader2,
  Rabbit,
  Sparkles,
  Square,
  Zap,
  X,
} from 'lucide-react';
import type { AgentMode, AnthropicAuth, ContextInfo, Effort, ModelEntry } from '../types';
import { formatTokens } from './common';
import { MODE_LABEL } from '../timeline';
import { call, errorText } from '../api';
import { MAX_PICTURES, isPicture, preparePicture } from '../pictures';

/** A picture waiting to go with the next message. */
interface Attachment {
  key: number;
  name: string;
  preview: string;
  imageId: string | null;
  error: string | null;
}

export const MODES: Array<{ id: AgentMode; icon: ReactNode; hint: string }> = [
  { id: 'ask', icon: <Hand size={14} />, hint: 'Approve every file change and command' },
  { id: 'auto-edit', icon: <FilePen size={14} />, hint: 'File changes apply without asking; commands still ask' },
  { id: 'auto', icon: <Zap size={14} />, hint: 'Changes and sandboxed commands run without asking. Blocked commands stay blocked' },
  { id: 'plan', icon: <ClipboardList size={14} />, hint: 'Read-only: explore and propose a plan for you to approve' },
];

/** The Claude plan / API key switch. `using` differs from `value` while a fallback is in effect. */
export interface AccountSwitch {
  value: AnthropicAuth;
  using: AnthropicAuth | null;
  options: Array<{ id: AnthropicAuth; label: string; sub: string; usable: boolean }>;
  onChange: (a: AnthropicAuth) => void;
  onManage: () => void;
}

/** Effort and fast mode (Anthropic only); both apply to a running session immediately. */
export interface Tuning {
  effort: Effort | null;
  onEffortChange: (e: Effort | null) => void;
  fast: boolean;
  onFastChange: (on: boolean) => void;
}

const EFFORTS: Array<{ id: Effort | null; label: string; hint: string }> = [
  { id: null, label: 'Default', hint: "The model's default" },
  { id: 'low', label: 'Low', hint: 'Fastest, fewest thinking tokens' },
  { id: 'medium', label: 'Medium', hint: 'Good for routine edits' },
  { id: 'high', label: 'High', hint: 'More thinking for harder problems' },
  { id: 'xhigh', label: 'Extra high', hint: 'Slower; for tricky bugs and design' },
  { id: 'max', label: 'Max', hint: 'Slowest and most tokens' },
];

const AUTH_ICON: Record<AnthropicAuth, ReactNode> = { subscription: <CircleUser size={13} />, 'api-key': <KeyRound size={13} /> };

export const nextMode = (m: AgentMode): AgentMode => MODES[(MODES.findIndex((x) => x.id === m) + 1) % MODES.length]!.id;

/** A pill button that opens a menu above itself (the composer sits at the bottom of the window). */
function Dropdown({
  trigger,
  title,
  className,
  children,
}: {
  trigger: ReactNode;
  title: string;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className={`pill ${className ?? ''} ${open ? 'open' : ''}`} title={title} onClick={() => setOpen(!open)}>
        {trigger}
        <ChevronUp size={12} className="chev" />
      </button>
      {open && <div className="dropdown-menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Composer({
  mode,
  onModeChange,
  model,
  models,
  onModelChange,
  onManageModels,
  account,
  tuning,
  context,
  onCompact,
  canQueue,
  running,
  blocked,
  placeholder,
  hint,
  onSubmit,
  onStop,
}: {
  mode: AgentMode;
  onModeChange: (m: AgentMode) => void;
  model: string | null;
  models: ModelEntry[];
  onModelChange: (id: string) => void;
  onManageModels: () => void;
  account: AccountSwitch | null;
  tuning: Tuning | null;
  context: ContextInfo | null;
  /** Set when compacting is possible right now. */
  onCompact: (() => void) | null;
  /** While the agent works, Enter queues the message instead of being blocked. */
  canQueue: boolean;
  running: boolean;
  blocked: boolean;
  placeholder: string;
  hint: string;
  onSubmit: (text: string, imageIds: string[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pictures, setPictures] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const nextKey = useRef(0);
  const uploading = pictures.some((p) => !p.imageId && !p.error);

  const dropPicture = (key: number) =>
    setPictures((ps) => {
      const gone = ps.find((p) => p.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return ps.filter((p) => p.key !== key);
    });

  /** Pictures pasted or dropped in: shown right away, uploaded (scaled down to fit) in the background. */
  const addPictures = (files: File[]) => {
    const room = MAX_PICTURES - pictures.length;
    for (const file of files.filter(isPicture).slice(0, Math.max(0, room))) {
      const key = ++nextKey.current;
      setPictures((ps) => [...ps, { key, name: file.name || 'Pasted picture', preview: URL.createObjectURL(file), imageId: null, error: null }]);
      preparePicture(file)
        .then((data) => call<{ imageId: string }>('image.upload', { data }))
        .then(
          (r) => setPictures((ps) => ps.map((p) => (p.key === key ? { ...p, imageId: r.imageId } : p))),
          (err) => setPictures((ps) => ps.map((p) => (p.key === key ? { ...p, error: errorText(err) } : p))),
        );
    }
  };

  // Grow with the text up to a limit, like an editor chat box.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy || uploading || (running && !canQueue) || blocked) return;
    setBusy(true);
    const ok = await onSubmit(t, pictures.flatMap((p) => (p.imageId ? [p.imageId] : [])));
    setBusy(false);
    if (ok) {
      setText('');
      for (const p of pictures) URL.revokeObjectURL(p.preview);
      setPictures([]);
    }
  };

  const current = MODES.find((m) => m.id === mode)!;
  const modelName = models.find((m) => m.id === model)?.displayName ?? model ?? 'Choose model';

  return (
    <div
      className={`composer-box mode-${mode}${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        addPictures([...e.dataTransfer.files]);
      }}
    >
      {pictures.length > 0 && (
        <div className="composer-pictures">
          {pictures.map((p) => (
            <div key={p.key} className={`composer-picture${p.error ? ' bad' : ''}`} title={p.error ?? p.name}>
              <img src={p.preview} alt={p.name} />
              {!p.imageId && !p.error && <Loader2 size={14} className="spin" />}
              <button className="btn small ghost" onClick={() => dropPicture(p.key)} title="Remove" aria-label={`Remove ${p.name}`}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        className="composer-input"
        rows={2}
        placeholder={placeholder}
        value={text}
        disabled={busy}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter(isPicture);
          if (!files.length) return;
          e.preventDefault();
          addPictures(files);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Tab' && e.shiftKey) {
            e.preventDefault();
            onModeChange(nextMode(mode));
          }
        }}
      />
      <div className="composer-bar">
        <Dropdown
          title="Mode (Shift+Tab to cycle)"
          className={`mode-pill mode-${mode}`}
          trigger={
            <>
              {current.icon} {MODE_LABEL[mode]}
            </>
          }
        >
          {(close) =>
            MODES.map((m) => (
              <button
                key={m.id}
                className={m.id === mode ? 'selected' : ''}
                onClick={() => {
                  close();
                  onModeChange(m.id);
                }}
              >
                <span className={`mode-icon mode-${m.id}`}>{m.icon}</span>
                <span className="grow">
                  <span className="label">{MODE_LABEL[m.id]}</span>
                  <span className="sub">{m.hint}</span>
                </span>
                {m.id === mode && <Check size={14} />}
              </button>
            ))
          }
        </Dropdown>
        <Dropdown
          title="Model"
          trigger={
            <>
              <Sparkles size={13} /> {modelName}
            </>
          }
        >
          {(close) => (
            <>
              {models.length === 0 && <div className="sub pad">No models loaded. Verify your key in Settings.</div>}
              {models.map((m) => (
                <button
                  key={m.id}
                  className={m.id === model ? 'selected' : ''}
                  onClick={() => {
                    close();
                    onModelChange(m.id);
                  }}
                >
                  <span className="grow">
                    <span className="label">{m.displayName}</span>
                    <span className="sub mono">{m.id}</span>
                  </span>
                  {m.id === model && <Check size={14} />}
                </button>
              ))}
              <button
                className="manage"
                onClick={() => {
                  close();
                  onManageModels();
                }}
              >
                Model settings…
              </button>
            </>
          )}
        </Dropdown>
        {account && (
          <Dropdown
            title={
              account.using && account.using !== account.value
                ? `Using ${account.options.find((o) => o.id === account.using)?.label} while ${account.options.find((o) => o.id === account.value)?.label} is unavailable`
                : 'Pay with your Claude plan or your API key'
            }
            className={account.using && account.using !== account.value ? 'warn' : ''}
            trigger={
              <>
                {AUTH_ICON[account.using ?? account.value]} {account.options.find((o) => o.id === (account.using ?? account.value))?.label}
                {account.using && account.using !== account.value && ' (fallback)'}
              </>
            }
          >
            {(close) => (
              <>
                {account.options.map((o) => (
                  <button
                    key={o.id}
                    className={o.id === account.value ? 'selected' : ''}
                    onClick={() => {
                      close();
                      account.onChange(o.id);
                    }}
                  >
                    <span className="mode-icon">{AUTH_ICON[o.id]}</span>
                    <span className="grow">
                      <span className="label">{o.label}</span>
                      <span className="sub">{o.sub}</span>
                    </span>
                    {o.id === account.value && <Check size={14} />}
                  </button>
                ))}
                <button
                  className="manage"
                  onClick={() => {
                    close();
                    account.onManage();
                  }}
                >
                  Sign-in &amp; key settings…
                </button>
              </>
            )}
          </Dropdown>
        )}
        {tuning && (
          <Dropdown
            title="Effort: how much the model thinks (applies immediately)"
            trigger={
              <>
                <Brain size={13} /> {EFFORTS.find((e) => e.id === tuning.effort)?.label ?? 'Default'}
              </>
            }
          >
            {(close) =>
              EFFORTS.map((e) => (
                <button
                  key={e.label}
                  className={e.id === tuning.effort ? 'selected' : ''}
                  onClick={() => {
                    close();
                    tuning.onEffortChange(e.id);
                  }}
                >
                  <span className="grow">
                    <span className="label">{e.label}</span>
                    <span className="sub">{e.hint}</span>
                  </span>
                  {e.id === tuning.effort && <Check size={14} />}
                </button>
              ))
            }
          </Dropdown>
        )}
        {tuning && (
          <button
            type="button"
            className={`pill ${tuning.fast ? 'warn' : ''}`}
            title={
              tuning.fast
                ? 'Fast mode is on: faster output at a higher price (extra usage on a Claude plan). Click to turn off.'
                : 'Fast mode: faster output at a higher price (extra usage on a Claude plan)'
            }
            onClick={() => tuning.onFastChange(!tuning.fast)}
          >
            <Rabbit size={13} /> Fast{tuning.fast ? ' on' : ''}
          </button>
        )}
        <span className="hint grow">{hint}</span>
        {context && context.max > 0 && (
          <button
            type="button"
            className={`pill ctx ${context.tokens / context.max > 0.8 ? 'warn' : ''}`}
            disabled={!onCompact}
            title={`Context: ${context.tokens.toLocaleString()} of ${context.max.toLocaleString()} tokens. Every step re-sends it, so a smaller context is cheaper and faster. ${
              onCompact ? 'Click to compact (summarise) the conversation now.' : 'Compacting is possible when the agent is idle.'
            }`}
            onClick={() => onCompact?.()}
          >
            <Gauge size={13} /> {formatTokens(context.tokens)} / {formatTokens(context.max)}
          </button>
        )}
        {running && (
          <button className="send stop" onClick={onStop} title="Stop the agent">
            <Square size={13} fill="currentColor" />
          </button>
        )}
        {(!running || canQueue) && (
          <button
            className="send"
            onClick={() => void submit()}
            disabled={!text.trim() || busy || blocked}
            title={running ? 'Queue: sent when the agent finishes (Enter)' : 'Send (Enter)'}
          >
            {busy ? <Loader2 size={15} className="spin" /> : running ? <ListPlus size={16} /> : <ArrowUp size={16} />}
          </button>
        )}
      </div>
    </div>
  );
}
