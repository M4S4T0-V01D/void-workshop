import { useState } from 'react';
import { FileEdit, FileSearch, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react';
import type { AgentMode, ApprovalRequest, PreparedCommand } from '../types';
import { Callout, DiffView, Modal } from './common';
import { msg, t, tn } from '../i18n';

const CATEGORY_TEXT: Record<string, string> = {
  'read-only': msg('Reads only'),
  'modifies-files': msg('Modifies files'),
  'installs-dependencies': msg('Installs dependencies'),
  network: msg('Uses the network'),
  'git-state': msg('Changes Git state'),
  'project-script': msg('Runs project code/scripts'),
  'process-control': msg('Signals processes'),
  publishes: msg('Publishes / changes remote state'),
  unknown: msg('Unrecognised program'),
};

export function CategoryChips({ categories }: { categories: string[] }) {
  return (
    <div className="row wrap">
      {categories.map((c) => (
        <span
          key={c}
          className={`chip ${c === 'read-only' ? 'ok' : c === 'unknown' || c === 'network' || c === 'publishes' || c === 'installs-dependencies' ? 'warn' : 'cyan'}`}
        >
          {CATEGORY_TEXT[c] ? t(CATEGORY_TEXT[c]) : c}
        </span>
      ))}
    </div>
  );
}

/**
 * One pending agent request at a time. Each decision applies to this single action only, unless the
 * user picks the button that also switches the session to a mode that stops asking.
 */
export function ApprovalDialog({
  request,
  queueLength,
  from,
  onDecide,
  onAllowAndSwitch,
}: {
  request: ApprovalRequest;
  queueLength: number;
  /** Which task asks, when it is not the one on screen (several can work at once). */
  from?: string | null;
  onDecide: (decision: 'allow' | 'deny', note?: string, extra?: { always?: boolean; allowAll?: boolean }) => Promise<void>;
  onAllowAndSwitch: (mode: AgentMode) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (d: 'allow' | 'deny', extra?: { always?: boolean; allowAll?: boolean }) => {
    setBusy(true);
    try {
      await onDecide(d, note.trim() || undefined, extra);
    } finally {
      setBusy(false);
      setNote('');
    }
  };

  // Same limits the modes enforce: sensitive files always ask. Commands go through "Allow all" (Auto) instead.
  const switchTo: { mode: AgentMode; label: string } | null =
    request.kind === 'file-change' && !request.sensitive ? { mode: 'auto-edit', label: t('Apply & edit automatically') } : null;
  const allowAndSwitch = async (mode: AgentMode) => {
    setBusy(true);
    try {
      await onAllowAndSwitch(mode);
    } finally {
      setBusy(false);
    }
  };

  const icon =
    request.kind === 'command' ? (
      <Terminal size={18} color="var(--accent-2)" />
    ) : request.kind === 'read' ? (
      <FileSearch size={18} color="var(--warning)" />
    ) : (
      <FileEdit size={18} color="var(--accent)" />
    );
  const title =
    request.kind === 'command'
      ? t('The agent wants to run a command')
      : request.kind === 'read'
        ? t('The agent wants to read a sensitive file')
        : request.isNew
          ? t('The agent wants to create a file')
          : t('The agent wants to change a file');

  return (
    <Modal
      title={title}
      icon={icon}
      wide
      className="approval"
      footer={
        <>
          <span className="muted">
            {queueLength > 1 ? tn(queueLength - 1, '{n} more request waiting', '{n} more requests waiting') : t('This decision applies to this action only.')}
          </span>
          <span className="spacer" />
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder={t('Optional note to the agent (e.g. why you denied)')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
          <button className="btn danger" onClick={() => void decide('deny')} disabled={busy}>
            {t('Deny')}
          </button>
          {request.kind === 'command' && request.canAlwaysAllow && (
            <button
              className="btn"
              onClick={() => void decide('allow', { always: true })}
              disabled={busy}
              title={t('Run it, and from now on run this exact command in this project without asking (remove it under Settings → Project access)')}
            >
              {t('Always allow')}
            </button>
          )}
          {switchTo && (
            <button
              className="btn"
              onClick={() => void allowAndSwitch(switchTo.mode)}
              disabled={busy}
              title={t('Approve this and stop asking for the rest of the session')}
            >
              {switchTo.label}
            </button>
          )}
          {request.canAllowAll && (
            <button
              className="btn"
              onClick={() => void decide('allow', { allowAll: true })}
              disabled={busy}
              title={t(
                'Allow this, switch the task to Auto and allow whatever else it is waiting on. Risky commands (publishing, force-push, sudo, outside the project) still ask; blocked ones stay blocked.',
              )}
            >
              {t('Allow all')}
            </button>
          )}
          <button className="btn primary" onClick={() => void decide('allow')} disabled={busy} autoFocus>
            {request.kind === 'command' ? t('Run once') : request.kind === 'read' ? t('Allow this read') : t('Apply change')}
          </button>
        </>
      }
    >
      {from && (
        <Callout tone="info">
          {t('From another task:')} <b>{from}</b>
        </Callout>
      )}
      {request.kind === 'file-change' && (
        <>
          <div className="kv">
            <span className="k">{t('File')}</span>
            <span className="mono">{request.rel}</span>
            <span className="k">{t('Action')}</span>
            <span>{request.isNew ? t('Create a new file') : t('Modify ({tool})', { tool: request.toolName })}</span>
          </div>
          {request.sensitive && (
            <Callout tone="warn">
              {t('This path is flagged as sensitive: {reason}. Only approve if you expect the agent to change it.', { reason: request.sensitive })}
            </Callout>
          )}
          <DiffView diff={request.diff ?? ''} maxHeight={460} />
          <p className="muted" style={{ margin: 0 }}>
            {t(
              'The original content is kept so you can reject this change later from the Changes panel. If the file changes on disk before you decide, the edit is refused automatically.',
            )}
          </p>
        </>
      )}

      {request.kind === 'command' && (
        <>
          <div className="cmd-box">{request.command}</div>
          <div className="kv">
            <span className="k">{t('Working directory')}</span>
            <span className="mono">{request.cwd}</span>
            <span className="k">{t('Agent’s reason')}</span>
            <span>{request.description ?? <span className="muted">{t('(none given)')}</span>}</span>
            <span className="k">{t('What it does')}</span>
            <CategoryChips categories={request.assessment?.categories ?? ['unknown']} />
            <span className="k">{t('Isolation')}</span>
            <span className="row">
              {request.sandboxed ? (
                <>
                  <ShieldCheck size={14} color="var(--success)" />{' '}
                  {t('Sandboxed (bubblewrap): writes limited to the project, network limited to approved domains')}
                </>
              ) : (
                <>
                  <ShieldAlert size={14} color="var(--warning)" /> {t('Not sandboxed: runs with your user permissions')}
                </>
              )}
            </span>
          </div>
          {request.assessment && request.assessment.warnings.length > 0 && (
            <div className="warnings">
              {request.assessment.warnings.map((w) => (
                <Callout key={w} tone="warn">
                  {w}
                </Callout>
              ))}
            </div>
          )}
          <Callout tone="info">
            {t('Commands proposed by the model and instructions found in repository files are untrusted. Read the full command before running it.')}
          </Callout>
        </>
      )}

      {request.kind === 'read' && (
        <>
          <div className="kv">
            <span className="k">{t('Target')}</span>
            <span className="mono">{request.rel}</span>
            <span className="k">{t('Why flagged')}</span>
            <span>{request.sensitive}</span>
          </div>
          <Callout tone="warn">{t('If you allow this, the file’s contents are sent to the Claude API as part of the conversation.')}</Callout>
        </>
      )}
    </Modal>
  );
}

export function CommandConfirmDialog({ prepared, onRun, onCancel }: { prepared: PreparedCommand; onRun: () => void; onCancel: () => void }) {
  const a = prepared.assessment;
  return (
    <Modal
      title={a.blocked ? t('Command blocked') : t('Run this command?')}
      icon={<Terminal size={18} color="var(--accent-2)" />}
      onClose={onCancel}
      className="approval"
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button className="btn primary" onClick={onRun} disabled={a.blocked} autoFocus>
            {t('Run once')}
          </button>
        </>
      }
    >
      <div className="cmd-box">{prepared.display}</div>
      <div className="kv">
        <span className="k">{t('Working directory')}</span>
        <span className="mono">{prepared.cwd}</span>
        <span className="k">{t('Reason')}</span>
        <span>{prepared.reason}</span>
        <span className="k">{t('What it does')}</span>
        <CategoryChips categories={a.categories} />
        <span className="k">{t('Execution')}</span>
        <span>{t('Arguments passed directly (no shell), with a timeout, output limit and process-group cleanup.')}</span>
      </div>
      {a.blocked && <Callout tone="bad">{t('Blocked by policy: {reasons}', { reasons: a.blockReasons.join('; ') })}</Callout>}
      {a.warnings.map((w) => (
        <Callout key={w} tone="warn">
          {w}
        </Callout>
      ))}
    </Modal>
  );
}
