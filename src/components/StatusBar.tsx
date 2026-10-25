import { useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, CircleUser, Cpu, FolderGit2, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { call } from '../api';
import type { InitData, OllamaStatus, PlanUsage, Project, Task } from '../types';
import { RUNNING, formatUsd } from './common';
import { AUTH_NAME, effectiveAuth } from '../account';
import { PlanMeter } from './PlanUsage';
import { UsageDialog } from './UsageDialog';

const POLL_MS = 3000;

export function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.round(b / 1024)} KB`;
}

/** Live memory use of the local Ollama server: loaded models (RAM/VRAM split) and system RAM. */
function OllamaMemory({ onClick }: { onClick: () => void }) {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      if (document.hidden) return;
      call<OllamaStatus>('ollama.status')
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!status) return null;
  if (!status.reachable)
    return (
      <span className="item clickable" onClick={onClick} title="Ollama is not answering. Start it with `ollama serve`.">
        <Cpu size={12} /> Ollama offline
      </span>
    );

  const { totalBytes: sysTotal, availableBytes } = status.system;
  const sysUsed = Math.max(0, sysTotal - availableBytes);
  const frac = sysTotal > 0 ? Math.min(1, sysUsed / sysTotal) : 0;
  const ram = Math.max(0, status.totalBytes - status.vramBytes);
  const label = !status.models.length ? 'Ollama idle' : `Ollama ${formatBytes(ram)} RAM${status.vramBytes ? ` + ${formatBytes(status.vramBytes)} VRAM` : ''}`;
  const title = [
    ...status.models.map(
      (m) =>
        `${m.name}: ${formatBytes(m.sizeBytes)} total` +
        (m.vramBytes ? ` (${Math.round((m.vramBytes / Math.max(1, m.sizeBytes)) * 100)}% on GPU)` : ' (CPU only)') +
        (m.contextLength ? `, context ${m.contextLength.toLocaleString()}` : ''),
    ),
    status.models.length ? '' : 'No model loaded. Ollama loads one on the first request and unloads it after a few idle minutes.',
    `System RAM: ${formatBytes(sysUsed)} used of ${formatBytes(sysTotal)}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className="item clickable" onClick={onClick} title={title}>
      <Cpu size={12} /> {label} · RAM {formatBytes(sysUsed)} / {formatBytes(sysTotal)}
      <span className={`meter ${frac > 0.9 ? 'bad' : frac > 0.75 ? 'warn' : ''}`}>
        <div style={{ width: `${frac * 100}%` }} />
      </span>
    </span>
  );
}

const STATE_TEXT: Record<string, string> = {
  planning: 'Planning',
  'awaiting-plan-approval': 'Plan awaiting approval',
  executing: 'Working',
  idle: 'Waiting for you',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  'stopped-budget': 'Stopped: limit reached',
  'stopped-billing': 'Stopped: billing',
  'stopped-limit': 'Stopped: plan limit',
  interrupted: 'Interrupted',
};

export function StatusBar({
  init,
  project,
  task,
  pendingApprovals,
  onOpenSettings,
  onPlanUsage,
}: {
  init: InitData;
  project: Project | null;
  task: Task | null;
  pendingApprovals: number;
  onOpenSettings: (s: 'key' | 'model' | 'limits' | 'billing') => void;
  onPlanUsage: (u: PlanUsage) => void;
}) {
  const [usageOpen, setUsageOpen] = useState(false);
  const daily = init.settings.dailyBudgetUsd;
  const frac = Math.min(1, init.spentTodayUsd / daily);
  const state = task ? task.state : null;
  const anthropic = init.settings.provider === 'anthropic';
  const eff = anthropic ? effectiveAuth(init) : null;
  const sub = init.subscription;
  const dot = eff && !eff.auth ? 'bad' : state && RUNNING.includes(state) ? 'busy' : pendingApprovals > 0 || state === 'awaiting-plan-approval' ? 'warn' : 'ok';
  return (
    <div className="statusbar">
      <span className="item">
        <span className={`dot ${dot}`} />
        {pendingApprovals > 0 ? `${pendingApprovals} approval(s) needed` : state ? STATE_TEXT[state] : 'Idle'}
      </span>
      <span className="item" title={project?.root}>
        <FolderGit2 size={12} />
        {project ? `${project.name}${project.git.branch ? ` · ${project.git.branch}${project.git.dirty ? '*' : ''}` : ''}` : 'No project'}
      </span>
      <span className="item clickable" onClick={() => onOpenSettings('model')} title="Change model">
        <Sparkles size={12} />
        {init.settings.model ?? 'No model selected'}
      </span>
      {eff && (
        <span
          className={`item clickable ${eff.switched ? 'warn' : ''}`}
          onClick={() => onOpenSettings('key')}
          title={eff.switched ? `${eff.problem} Using the ${AUTH_NAME[eff.auth!]} until then.` : 'Which account pays for requests'}
        >
          {eff.auth === 'subscription' ? <CircleUser size={12} /> : <KeyRound size={12} />}
          {eff.auth === 'subscription'
            ? `Claude plan${sub?.subscriptionType ? ` · ${sub.subscriptionType}` : ''}`
            : eff.auth === 'api-key'
              ? `API key${init.auth.backend === 'secret-service' ? ' · Secret Service' : ' · file'}`
              : 'No usable account'}
          {eff.switched && ' (fallback)'}
        </span>
      )}
      {init.settings.sandboxCommands && (
        <span className="item" title="Agent shell commands run in the bubblewrap sandbox">
          <ShieldCheck size={12} /> Sandbox on
        </span>
      )}
      <span className="spacer" />
      {init.settings.provider === 'ollama' && <OllamaMemory onClick={() => onOpenSettings('model')} />}
      {task && eff?.auth === 'api-key' && (
        <span className="item" title="Estimated cost of this task (SDK token usage × built-in price table)">
          Task ≈ {formatUsd(task.cost_usd)} / {formatUsd(init.settings.perTaskBudgetUsd)}
        </span>
      )}
      <span className="item clickable" onClick={() => setUsageOpen(true)} title="Token use in Workshop by day and model">
        <BarChart3 size={12} /> Tokens
      </span>
      {usageOpen && <UsageDialog onClose={() => setUsageOpen(false)} />}
      {anthropic && sub?.signedIn && <PlanMeter usage={init.planUsage} onUsage={onPlanUsage} />}
      <span className="item clickable" onClick={() => onOpenSettings('limits')} title="Estimated spend today across all tasks. Local estimate only.">
        Today ≈ {formatUsd(init.spentTodayUsd)} / {formatUsd(daily)}
        <span className={`meter ${frac > 0.9 ? 'bad' : frac > 0.7 ? 'warn' : ''}`}>
          <div style={{ width: `${frac * 100}%` }} />
        </span>
      </span>
      {eff?.auth !== 'subscription' && (
        <span
          className="item clickable"
          onClick={() => onOpenSettings('billing')}
          title="Console billing data is not available to this app. Estimates only. Click for details."
        >
          <AlertTriangle size={12} color="var(--warning)" /> Estimates only: Console billing not connected
        </span>
      )}
    </div>
  );
}
