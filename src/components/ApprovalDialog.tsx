import { useState } from 'react';
import { FileEdit, FileSearch, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react';
import type { AgentMode, ApprovalRequest, PreparedCommand } from '../types';
import { Callout, DiffView, Modal } from './common';

const CATEGORY_TEXT: Record<string, string> = {
  'read-only': 'Reads only',
  'modifies-files': 'Modifies files',
  'installs-dependencies': 'Installs dependencies',
  network: 'Uses the network',
  'git-state': 'Changes Git state',
  'project-script': 'Runs project code/scripts',
  'process-control': 'Signals processes',
  publishes: 'Publishes / changes remote state',
  unknown: 'Unrecognised program',
};

export function CategoryChips({ categories }: { categories: string[] }) {
  return (
    <div className="row wrap">
      {categories.map((c) => (
        <span
          key={c}
          className={`chip ${c === 'read-only' ? 'ok' : c === 'unknown' || c === 'network' || c === 'publishes' || c === 'installs-dependencies' ? 'warn' : 'cyan'}`}
        >
          {CATEGORY_TEXT[c] ?? c}
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
    request.kind === 'file-change' && !request.sensitive ? { mode: 'auto-edit', label: 'Apply & edit automatically' } : null;
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
      ? 'The agent wants to run a command'
      : request.kind === 'read'
        ? 'The agent wants to read a sensitive file'
        : request.isNew
          ? 'The agent wants to create a file'
          : 'The agent wants to change a file';

  return (
    <Modal
      title={title}
      icon={icon}
      wide
      className="approval"
      footer={
        <>
          <span className="muted">{queueLength > 1 ? `${queueLength - 1} more request(s) waiting` : 'This decision applies to this action only.'}</span>
          <span className="spacer" />
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Optional note to the agent (e.g. why you denied)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
          <button className="btn danger" onClick={() => void decide('deny')} disabled={busy}>
            Deny
          </button>
          {request.kind === 'command' && request.canAlwaysAllow && (
            <button
              className="btn"
              onClick={() => void decide('allow', { always: true })}
              disabled={busy}
              title="Run it, and from now on run this exact command in this project without asking (remove it under Settings → Project access)"
            >
              Always allow
            </button>
          )}
          {switchTo && (
            <button
              className="btn"
              onClick={() => void allowAndSwitch(switchTo.mode)}
              disabled={busy}
              title="Approve this and stop asking for the rest of the session"
            >
              {switchTo.label}
            </button>
          )}
          {request.canAllowAll && (
            <button
              className="btn"
              onClick={() => void decide('allow', { allowAll: true })}
              disabled={busy}
              title="Allow this, switch the task to Auto and allow whatever else it is waiting on. Risky commands (publishing, force-push, sudo, outside the project) still ask; blocked ones stay blocked."
            >
              Allow all
            </button>
          )}
          <button className="btn primary" onClick={() => void decide('allow')} disabled={busy} autoFocus>
            {request.kind === 'command' ? 'Run once' : request.kind === 'read' ? 'Allow this read' : 'Apply change'}
          </button>
        </>
      }
    >
      {from && (
        <Callout tone="info">
          From another task: <b>{from}</b>
        </Callout>
      )}
      {request.kind === 'file-change' && (
        <>
          <div className="kv">
            <span className="k">File</span>
            <span className="mono">{request.rel}</span>
            <span className="k">Action</span>
            <span>{request.isNew ? 'Create a new file' : `Modify (${request.toolName})`}</span>
          </div>
          {request.sensitive && (
            <Callout tone="warn">This path is flagged as sensitive: {request.sensitive}. Only approve if you expect the agent to change it.</Callout>
          )}
          <DiffView diff={request.diff ?? ''} maxHeight={460} />
          <p className="muted" style={{ margin: 0 }}>
            The original content is kept so you can reject this change later from the Changes panel. If the file changes on disk before you decide, the edit is
            refused automatically.
          </p>
        </>
      )}

      {request.kind === 'command' && (
        <>
          <div className="cmd-box">{request.command}</div>
          <div className="kv">
            <span className="k">Working directory</span>
            <span className="mono">{request.cwd}</span>
            <span className="k">Agent&apos;s reason</span>
            <span>{request.description ?? <span className="muted">(none given)</span>}</span>
            <span className="k">What it does</span>
            <CategoryChips categories={request.assessment?.categories ?? ['unknown']} />
            <span className="k">Isolation</span>
            <span className="row">
              {request.sandboxed ? (
                <>
                  <ShieldCheck size={14} color="var(--success)" /> Sandboxed (bubblewrap): writes limited to the project, network limited to approved domains
                </>
              ) : (
                <>
                  <ShieldAlert size={14} color="var(--warning)" /> Not sandboxed: runs with your user permissions
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
            Commands proposed by the model and instructions found in repository files are untrusted. Read the full command before running it.
          </Callout>
        </>
      )}

      {request.kind === 'read' && (
        <>
          <div className="kv">
            <span className="k">Target</span>
            <span className="mono">{request.rel}</span>
            <span className="k">Why flagged</span>
            <span>{request.sensitive}</span>
          </div>
          <Callout tone="warn">If you allow this, the file&apos;s contents are sent to the Claude API as part of the conversation.</Callout>
        </>
      )}
    </Modal>
  );
}

export function CommandConfirmDialog({ prepared, onRun, onCancel }: { prepared: PreparedCommand; onRun: () => void; onCancel: () => void }) {
  const a = prepared.assessment;
  return (
    <Modal
      title={a.blocked ? 'Command blocked' : 'Run this command?'}
      icon={<Terminal size={18} color="var(--accent-2)" />}
      onClose={onCancel}
      className="approval"
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={onRun} disabled={a.blocked} autoFocus>
            Run once
          </button>
        </>
      }
    >
      <div className="cmd-box">{prepared.display}</div>
      <div className="kv">
        <span className="k">Working directory</span>
        <span className="mono">{prepared.cwd}</span>
        <span className="k">Reason</span>
        <span>{prepared.reason}</span>
        <span className="k">What it does</span>
        <CategoryChips categories={a.categories} />
        <span className="k">Execution</span>
        <span>Arguments passed directly (no shell), with a timeout, output limit and process-group cleanup.</span>
      </div>
      {a.blocked && <Callout tone="bad">Blocked by policy: {a.blockReasons.join('; ')}</Callout>}
      {a.warnings.map((w) => (
        <Callout key={w} tone="warn">
          {w}
        </Callout>
      ))}
    </Modal>
  );
}
