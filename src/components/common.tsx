import { useEffect, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { FileChangeStatus, TaskState } from '../types';
import { locale, msg, t, tn } from '../i18n';

export function formatUsd(v: number | null | undefined): string {
  const n = v ?? 0;
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return tn(Math.floor(s / 60), '{n}m ago', '{n}m ago');
  if (s < 86400) return tn(Math.floor(s / 3600), '{n}h ago', '{n}h ago');
  return new Date(ts).toLocaleDateString(locale());
}

const STATE_LABEL: Record<TaskState, [string, string]> = {
  planning: [msg('Planning'), 'cyan'],
  'awaiting-plan-approval': [msg('Plan ready'), 'accent'],
  executing: [msg('Working'), 'cyan'],
  idle: [msg('Waiting for you'), 'accent'],
  completed: [msg('Completed'), 'ok'],
  cancelled: [msg('Cancelled'), ''],
  failed: [msg('Failed'), 'bad'],
  'stopped-budget': [msg('Limit reached'), 'warn'],
  'stopped-billing': [msg('Billing stop'), 'bad'],
  'stopped-limit': [msg('Plan limit'), 'warn'],
  interrupted: [msg('Interrupted'), 'warn'],
};

export function StateBadge({ state }: { state: TaskState }) {
  const [label, tone] = STATE_LABEL[state] ?? [state, ''];
  return <span className={`chip ${tone}`}>{t(label)}</span>;
}

export const ACTIVE: TaskState[] = ['planning', 'awaiting-plan-approval', 'executing'];
export const RUNNING: TaskState[] = ['planning', 'executing'];

const CHANGE_LABEL: Record<FileChangeStatus, [string, string, string]> = {
  proposed: [msg('Proposed'), 'cyan', msg('Approved for writing; not yet applied')],
  applied: [msg('Applied'), 'accent', msg('Written to disk; not yet tested or reviewed')],
  tested: [msg('Tested'), 'ok', msg('A build/test/lint command succeeded after this change')],
  accepted: [msg('Accepted'), 'ok', msg('You kept this change')],
  rejected: [msg('Rejected'), '', msg('Restored to the original content')],
  committed: [msg('Committed'), 'ok', msg('Included in a Git commit')],
  conflict: [msg('Conflict'), 'bad', msg('Changed outside VOID Workshop after the agent wrote it')],
};

export function ChangeBadge({ status }: { status: FileChangeStatus }) {
  const [label, tone, title] = CHANGE_LABEL[status] ?? [status, '', ''];
  return (
    <span className={`chip ${tone}`} title={title && t(title)}>
      {t(label)}
    </span>
  );
}

export function changeLegend(): Array<[FileChangeStatus, string]> {
  return (Object.keys(CHANGE_LABEL) as FileChangeStatus[]).map((s) => [s, t(CHANGE_LABEL[s][2])]);
}

export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide,
  className,
}: {
  title: string;
  icon?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`modal ${wide ? 'wide' : ''} ${className ?? ''}`}>
        <div className="modal-head">
          {icon}
          <h3>{title}</h3>
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function DiffView({ diff, maxHeight }: { diff: string; maxHeight?: number }) {
  const lines = diff.split('\n');
  return (
    <div className="diff" style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((l, i) => {
        let cls = '';
        if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('====') || l.startsWith('Index:')) cls = 'meta';
        else if (l.startsWith('@@')) cls = 'hunk';
        else if (l.startsWith('+')) cls = 'add';
        else if (l.startsWith('-')) cls = 'del';
        else if (l.startsWith('\\')) cls = 'meta';
        return (
          <div key={i} className={`line ${cls}`}>
            {l || ' '}
          </div>
        );
      })}
    </div>
  );
}

export function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }) {
  const Icon = tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`callout ${tone}`}>
      <Icon size={15} />
      <div>{children}</div>
    </div>
  );
}

export interface Toast {
  id: number;
  tone: 'info' | 'warn' | 'error';
  text: string;
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`}>
          {toast.tone === 'error' ? (
            <XCircle size={15} color="var(--danger)" />
          ) : toast.tone === 'warn' ? (
            <AlertTriangle size={15} color="var(--warning)" />
          ) : (
            <CheckCircle2 size={15} color="var(--accent-2)" />
          )}
          <div>{toast.text}</div>
          <button className="icon-btn x" onClick={() => dismiss(toast.id)} aria-label={t('Dismiss')}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t('Cancel')}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
