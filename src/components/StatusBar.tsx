import { useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, CircleUser, Cpu, FolderGit2, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { call } from '../api';
import type { InitData, OllamaStatus, PlanUsage, Project, Task } from '../types';
import { RUNNING, formatUsd } from './common';
import { AUTH_NAME, effectiveAuth } from '../account';
import { PlanMeter } from './PlanUsage';
import { UsageDialog } from './UsageDialog';
import { locale, msg, t, tn } from '../i18n';

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
      <span className="item clickable" onClick={onClick} title={t('Ollama is not answering. Start it with `ollama serve`.')}>
        <Cpu size={12} /> {t('Ollama offline')}
      </span>
    );

  const { totalBytes: sysTotal, availableBytes } = status.system;
  const sysUsed = Math.max(0, sysTotal - availableBytes);
  const frac = sysTotal > 0 ? Math.min(1, sysUsed / sysTotal) : 0;
  const ram = Math.max(0, status.totalBytes - status.vramBytes);
  const label = !status.models.length
    ? t('Ollama idle')
    : status.vramBytes
      ? t('Ollama {ram} RAM + {vram} VRAM', { ram: formatBytes(ram), vram: formatBytes(status.vramBytes) })
      : t('Ollama {ram} RAM', { ram: formatBytes(ram) });
  const title = [
    ...status.models.map(
      (m) =>
        t('{name}: {size} total', { name: m.name, size: formatBytes(m.sizeBytes) }) +
        ' ' +
        (m.vramBytes ? t('({percent}% on GPU)', { percent: Math.round((m.vramBytes / Math.max(1, m.sizeBytes)) * 100) }) : t('(CPU only)')) +
        (m.contextLength ? ', ' + t('context {tokens}', { tokens: m.contextLength.toLocaleString(locale()) }) : ''),
    ),
    status.models.length ? '' : t('No model loaded. Ollama loads one on the first request and unloads it after a few idle minutes.'),
    t('System RAM: {used} used of {total}', { used: formatBytes(sysUsed), total: formatBytes(sysTotal) }),
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className="item clickable" onClick={onClick} title={title}>
      <Cpu size={12} /> {label} · {t('RAM {used} / {total}', { used: formatBytes(sysUsed), total: formatBytes(sysTotal) })}
      <span className={`meter ${frac > 0.9 ? 'bad' : frac > 0.75 ? 'warn' : ''}`}>
        <div style={{ width: `${frac * 100}%` }} />
      </span>
    </span>
  );
}

const STATE_TEXT: Record<string, string> = {
  planning: msg('Planning'),
  'awaiting-plan-approval': msg('Plan awaiting approval'),
  executing: msg('Working'),
  idle: msg('Waiting for you'),
  completed: msg('Completed'),
  cancelled: msg('Cancelled'),
  failed: msg('Failed'),
  'stopped-budget': msg('Stopped: limit reached'),
  'stopped-billing': msg('Stopped: billing'),
  'stopped-limit': msg('Stopped: plan limit'),
  interrupted: msg('Interrupted'),
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
        {pendingApprovals > 0 ? tn(pendingApprovals, '{n} approval needed', '{n} approvals needed') : state ? t(STATE_TEXT[state] ?? state) : t('Idle')}
      </span>
      <span className="item" title={project?.root}>
        <FolderGit2 size={12} />
        {project ? `${project.name}${project.git.branch ? ` · ${project.git.branch}${project.git.dirty ? '*' : ''}` : ''}` : t('No project')}
      </span>
      <span className="item clickable" onClick={() => onOpenSettings('model')} title={t('Change model')}>
        <Sparkles size={12} />
        {init.settings.model ?? t('No model selected')}
      </span>
      {eff && (
        <span
          className={`item clickable ${eff.switched ? 'warn' : ''}`}
          onClick={() => onOpenSettings('key')}
          title={
            eff.switched ? `${eff.problem} ${t('Using the {account} until then.', { account: t(AUTH_NAME[eff.auth!]) })}` : t('Which account pays for requests')
          }
        >
          {eff.auth === 'subscription' ? <CircleUser size={12} /> : <KeyRound size={12} />}
          {eff.auth === 'subscription'
            ? `${t('Claude plan')}${sub?.subscriptionType ? ` · ${sub.subscriptionType}` : ''}`
            : eff.auth === 'api-key'
              ? `${t('API key')} · ${init.auth.backend === 'secret-service' ? 'Secret Service' : t('file')}`
              : t('No usable account')}
          {eff.switched && ` ${t('(fallback)')}`}
        </span>
      )}
      {init.settings.sandboxCommands && (
        <span className="item" title={t('Agent shell commands run in the bubblewrap sandbox')}>
          <ShieldCheck size={12} /> {t('Sandbox on')}
        </span>
      )}
      <span className="spacer" />
      {init.settings.provider === 'ollama' && <OllamaMemory onClick={() => onOpenSettings('model')} />}
      {task && eff?.auth === 'api-key' && (
        <span className="item" title={t('Estimated cost of this task (SDK token usage × built-in price table)')}>
          {t('Task ≈ {cost} / {budget}', { cost: formatUsd(task.cost_usd), budget: formatUsd(init.settings.perTaskBudgetUsd) })}
        </span>
      )}
      <span className="item clickable" onClick={() => setUsageOpen(true)} title={t('Token use in Workshop by day and model')}>
        <BarChart3 size={12} /> {t('Tokens')}
      </span>
      {usageOpen && <UsageDialog onClose={() => setUsageOpen(false)} />}
      {anthropic && sub?.signedIn && <PlanMeter usage={init.planUsage} onUsage={onPlanUsage} />}
      <span className="item clickable" onClick={() => onOpenSettings('limits')} title={t('Estimated spend today across all tasks. Local estimate only.')}>
        {t('Today ≈ {cost} / {budget}', { cost: formatUsd(init.spentTodayUsd), budget: formatUsd(daily) })}
        <span className={`meter ${frac > 0.9 ? 'bad' : frac > 0.7 ? 'warn' : ''}`}>
          <div style={{ width: `${frac * 100}%` }} />
        </span>
      </span>
      {eff?.auth !== 'subscription' && (
        <span
          className="item clickable"
          onClick={() => onOpenSettings('billing')}
          title={t('Console billing data is not available to this app. Estimates only. Click for details.')}
        >
          <AlertTriangle size={12} color="var(--warning)" /> {t('Estimates only: Console billing not connected')}
        </span>
      )}
    </div>
  );
}
