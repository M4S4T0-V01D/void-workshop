import { useEffect, useState } from 'react';
import {
  CreditCard,
  Gauge,
  Smartphone,
  FolderLock,
  KeyRound,
  Palette,
  Plug,
  RefreshCw,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Download,
} from 'lucide-react';
import { call, errorText, onSidecarEvent } from '../api';
import type {
  AdminStatus,
  AgentMode,
  InitData,
  KeyStatus,
  ModelEntry,
  Project,
  ProjectPermissions,
  Provider,
  Settings,
  PortalStatus,
  SubscriptionStatus,
  VerifyResult,
} from '../types';
import { MODES } from './Composer';
import { MODE_LABEL } from '../timeline';
import { Callout, Modal, formatUsd, timeAgo } from './common';
import { CONSOLE, CopyLink, KeySection, SubscriptionSection } from './settings/AccountSections';
import { AdminSection } from './settings/AdminSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { RelayField, UpdateSection } from './settings/UpdateSection';
import { CloudflareSection, GithubSection, ServicesPlacement } from './settings/ServiceSections';
import { msg, t, tx } from '../i18n';

export type SettingsSection =
  'key' | 'accounts' | 'model' | 'speed' | 'portal' | 'limits' | 'safety' | 'admin' | 'project' | 'appearance' | 'billing' | 'updates';

const SECTIONS: Array<[SettingsSection, string, typeof KeyRound]> = [
  ['key', msg('Sign-in & API key'), KeyRound],
  ['accounts', msg('GitHub & Cloudflare'), Plug],
  ['model', msg('Provider & model'), Sparkles],
  ['speed', msg('Speed & tokens'), Gauge],
  ['portal', msg('VOID Portal (phone)'), Smartphone],
  ['limits', msg('Spending limits'), SlidersHorizontal],
  ['safety', msg('Safety'), Shield],
  ['admin', msg('Admin'), ShieldAlert],
  ['project', msg('Project access'), FolderLock],
  ['appearance', msg('Appearance & language'), Palette],
  ['billing', msg('Billing & usage'), CreditCard],
  ['updates', msg('Updates'), Download],
];

export function SettingsDialog({
  init,
  project,
  initialSection,
  onClose,
  onSettings,
  onAuth,
  onModels,
  onPermissions,
  onBillingCleared,
  onSubscription,
  onPlanLimitCleared,
  onAdmin,
  onEditUi,
  toast,
}: {
  init: InitData;
  project: Project | null;
  initialSection: SettingsSection;
  onClose: () => void;
  onSettings: (s: Settings) => void;
  onAuth: (s: KeyStatus) => void;
  onModels: (m: ModelEntry[], verify: VerifyResult) => void;
  onPermissions: (p: ProjectPermissions) => void;
  onBillingCleared: () => void;
  onSubscription: (s: SubscriptionStatus, models: ModelEntry[]) => void;
  onPlanLimitCleared: () => void;
  onAdmin: (s: AdminStatus) => void;
  /** Close Settings and open the visual editor. */
  onEditUi: () => void;
  toast: (tone: 'info' | 'warn' | 'error', text: string) => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [settings, setSettings] = useState<Settings>(init.settings);

  const save = async (patch: Partial<Settings>) => {
    try {
      const next = await call<Settings>('settings.update', patch);
      setSettings(next);
      onSettings(next);
    } catch (err) {
      toast('error', errorText(err));
    }
  };

  return (
    <Modal title={t('Settings')} onClose={onClose} wide>
      <div className="settings" style={{ margin: '-14px -18px' }}>
        <nav>
          {SECTIONS.map(([id, label, Icon]) => (
            <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
              <Icon size={15} /> {t(label)}
            </button>
          ))}
        </nav>
        <section>
          {section === 'accounts' && (
            <>
              <GithubSection settings={settings} save={save} toast={toast} />
              <CloudflareSection toast={toast} />
              <ServicesPlacement settings={settings} save={save} />
            </>
          )}
          {section === 'key' && (
            <SubscriptionSection
              init={init}
              settings={settings}
              save={save}
              onSubscription={onSubscription}
              onPlanLimitCleared={onPlanLimitCleared}
              toast={toast}
            />
          )}
          {section === 'key' && (
            <KeySection
              init={init}
              onAuth={onAuth}
              // The Anthropic list only becomes the active one while Anthropic is the provider.
              onModels={(m, v) => settings.provider === 'anthropic' && onModels(m, v)}
              toast={toast}
            />
          )}
          {section === 'model' && <ModelSection init={init} settings={settings} save={save} onModels={onModels} toast={toast} />}
          {section === 'speed' && (
            <SpeedSection settings={settings} save={save} models={settings.provider === 'anthropic' ? (init.models?.models ?? []) : []} />
          )}
          {section === 'portal' && <PortalSection settings={settings} save={save} toast={toast} />}
          {section === 'limits' && <LimitsSection settings={settings} save={save} spentToday={init.spentTodayUsd} />}
          {section === 'safety' && <SafetySection settings={settings} save={save} sandbox={init.sandbox} />}
          {section === 'admin' && <AdminSection status={init.admin} onAdmin={onAdmin} toast={toast} />}
          {section === 'project' && <ProjectSection project={project} onPermissions={onPermissions} toast={toast} />}
          {section === 'appearance' && <AppearanceSection settings={settings} save={save} toast={toast} onEditUi={onEditUi} />}
          {section === 'billing' && <BillingSection init={init} onBillingCleared={onBillingCleared} />}
          {section === 'updates' && <UpdateSection version={init.version} settings={settings} save={save} toast={toast} />}
        </section>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

function ModelSection({
  init,
  settings,
  save,
  onModels,
  toast,
}: {
  init: InitData;
  settings: Settings;
  save: (p: Partial<Settings>) => Promise<void>;
  onModels: (m: ModelEntry[], v: VerifyResult) => void;
  toast: (t: 'info' | 'warn' | 'error', m: string) => void;
}) {
  const [models, setModels] = useState<ModelEntry[]>(init.models?.models ?? []);
  const [checkedAt, setCheckedAt] = useState(init.models?.checkedAt ?? 0);
  const [busy, setBusy] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaUrl);
  const local = settings.provider === 'ollama';
  const refresh = async () => {
    setBusy(true);
    try {
      const res = await call<VerifyResult>('models.refresh');
      if (res.ok && res.models) {
        setModels(res.models);
        setCheckedAt(res.checkedAt);
        onModels(res.models, res);
      } else {
        setModels([]);
        setCheckedAt(0);
        onModels([], res);
        toast('error', res.message ?? t('Could not list models'));
      }
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const switchProvider = async (provider: Provider) => {
    await save({ provider });
    await refresh();
  };
  return (
    <>
      <h4>{t('Provider')}</h4>
      <div className="row wrap">
        <label className="check">
          <input type="radio" checked={!local} disabled={busy} onChange={() => void switchProvider('anthropic')} />
          <span>
            {t('Anthropic')} <span className="muted">{t('(Claude plan or Console API key)')}</span>
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={local} disabled={busy} onChange={() => void switchProvider('ollama')} />
          <span>
            {t('Ollama')} <span className="muted">{t('(local models on this computer, free)')}</span>
          </span>
        </label>
      </div>
      {local && (
        <>
          <label className="field">
            {t('Ollama address')}
            <input
              className="input mono"
              spellCheck={false}
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              onBlur={() => {
                if (ollamaUrl !== settings.ollamaUrl) void save({ ollamaUrl }).then(refresh);
              }}
            />
            <span className="muted">{t('Must be on this computer (http://127.0.0.1:11434 by default). Start Ollama with `ollama serve`.')}</span>
          </label>
          <Callout tone="info">
            {t(
              'Local models are free and your Console key is never sent to Ollama. The agent uses many tools and a long system prompt, so pick a capable coding model (for example qwen3-coder, gpt-oss:20b or devstral) and give Ollama a large context window, e.g. OLLAMA_CONTEXT_LENGTH=32768 or more. Spending limits and effort do not apply.',
            )}
          </Callout>
        </>
      )}
      <h4>{t('Model')}</h4>
      <p>
        {local
          ? t('The list shows the models installed in your Ollama server. Run `ollama pull <model>`, then Refresh.')
          : t(
              'The list comes from the Anthropic Models API for your key, so it only shows models your organization can use. No model IDs are built into the app.',
            )}
      </p>
      <div className="row">
        <select className="select" value={settings.model ?? ''} onChange={(e) => void save({ model: e.target.value || null })} disabled={!models.length}>
          <option value="">{models.length ? t('Choose a model…') : local ? t('Refresh to load Ollama models') : t('Verify your key to load models')}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} ({m.id})
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} /> {t('Refresh')}
        </button>
      </div>
      {checkedAt > 0 && <span className="muted">{t('List fetched {when}.', { when: timeAgo(checkedAt) })}</span>}
      {!local && (
        <>
          <Callout tone="info">
            {t(
              "Larger models cost more per token. Check current prices on the Anthropic pricing page; VOID Workshop's cost estimates use the price table built into the Agent SDK for the model that served each request.",
            )}
          </Callout>
          <label className="field">
            {t('Effort (thinking depth)')}
            <select className="select" value={settings.effort ?? ''} onChange={(e) => void save({ effort: (e.target.value || null) as Settings['effort'] })}>
              <option value="">{t('Model default')}</option>
              <option value="low">{t('Low: cheapest, fine for small edits')}</option>
              <option value="medium">{t('Medium')}</option>
              <option value="high">{t('High')}</option>
              <option value="xhigh">{t('Extra high')}</option>
              <option value="max">{t('Max: most expensive')}</option>
            </select>
          </label>
        </>
      )}
      <label className="field">
        {t('Max output tokens per request')}
        <input
          className="input"
          type="number"
          min={1024}
          max={128000}
          step={1024}
          value={settings.maxOutputTokens}
          onChange={(e) => void save({ maxOutputTokens: Number(e.target.value) })}
        />
      </label>
    </>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (n: number) => void;
  hint?: string;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="field">
      {label}
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n);
          else setV(String(value));
        }}
      />
      {hint && <span className="muted">{hint}</span>}
    </label>
  );
}

function PortalSection({
  settings,
  save,
  toast,
}: {
  settings: Settings;
  save: (p: Partial<Settings>) => Promise<void>;
  toast: (t: 'info' | 'warn' | 'error', m: string) => void;
}) {
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [name, setName] = useState(() => t('My phone'));
  const [pairing, setPairing] = useState<{ qrSvg: string; link: string; id: string } | null>(null);

  useEffect(() => {
    void call<PortalStatus>('remote.status').then(setStatus);
    const un = onSidecarEvent(({ event, payload }) => {
      if (event === 'remote.status') setStatus(payload as PortalStatus);
    });
    return () => void un.then((f) => f());
  }, []);

  // The QR code is a key: hide it as soon as the new phone has connected.
  const pairedOnline = pairing && status?.devices.find((d) => d.id === pairing.id)?.phoneOnline;
  useEffect(() => {
    if (pairedOnline) {
      setPairing(null);
      toast('info', t('Phone paired. VOID Portal is connected.'));
    }
  }, [pairedOnline, toast]);

  const pair = async () => {
    try {
      const r = await call<{ qrSvg: string; link: string; device: { id: string } }>('remote.pair', { name });
      setPairing({ qrSvg: r.qrSvg, link: r.link, id: r.device.id });
      if (!settings.runInBackground) void save({ runInBackground: true });
    } catch (err) {
      toast('error', errorText(err));
    }
  };

  const unpair = async (id: string) => {
    try {
      setStatus(await call<PortalStatus>('remote.unpair', { id }));
      if (pairing?.id === id) setPairing(null);
    } catch (err) {
      toast('error', errorText(err));
    }
  };

  return (
    <>
      <h4>{t('VOID Portal')}</h4>
      <p>
        {t(
          "Drive VOID Workshop from your phone: start tasks, queue messages, approve changes and commands, switch between your Claude plan, API key and Ollama, and get notified when a task is done or needs you. Phone and PC both connect out to your relay, and everything between them is end-to-end encrypted with a key only they hold. The phone can't change keys, sign-in, limits, safety settings, project access or commits.",
        )}
      </p>
      {status && status.devices.length > 0 && (
        <div className="kv">
          {status.devices.map((d) => (
            <div key={d.id} style={{ display: 'contents' }}>
              <span className="k">{d.name}</span>
              <span className="row">
                <span className={`dot ${d.phoneOnline ? 'ok' : d.connected ? 'warn' : 'bad'}`} />
                {d.phoneOnline
                  ? t('Connected now')
                  : d.connected
                    ? `${t('Waiting for the phone')}${d.lastSeenAt ? ` · ${t('last seen {when}', { when: timeAgo(d.lastSeenAt) })}` : ''}`
                    : t('Relay not reachable')}
                <button className="btn small danger" onClick={() => void unpair(d.id)}>
                  <Trash2 size={12} /> {t('Remove')}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <input
          className="input"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('Phone name')}
          style={{ maxWidth: 220 }}
        />
        <button
          className="btn primary"
          onClick={() => void pair()}
          disabled={!status?.relayUrl}
          title={status?.relayUrl ? undefined : t('Set your relay address below first')}
        >
          <Smartphone size={14} /> {t('Pair a phone')}
        </button>
      </div>
      {status && !status.relayUrl && <p className="muted">{t('No relay yet: deploy your own below, then pair a phone.')}</p>}
      {pairing && (
        <div className="pair-box">
          <div className="qr" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
          <div>
            <p>
              {tx('Open {app} on your phone and tap {button}. This disappears once the phone connects.', {
                app: <b>VOID Portal</b>,
                button: <b>{t('Scan pairing code')}</b>,
              })}
            </p>
            <Callout tone="warn">{t("This code is a key to your PC. Don't photograph it or share it; remove the phone here if it ever leaks.")}</Callout>
            <p className="muted">
              {t(
                "Won't scan? Turn the screen brightness up and hold the phone 20–30 cm away. Or copy the link and type it into VOID Portal (Or paste the pairing link):",
              )}
            </p>
            <CopyLink url={pairing.link} />
            <button className="btn small" onClick={() => setPairing(null)}>
              {t('Hide code')}
            </button>
          </div>
        </div>
      )}

      <h4>{t('Keep it reachable')}</h4>
      <label className="check">
        <input type="checkbox" checked={settings.runInBackground} onChange={(e) => void save({ runInBackground: e.target.checked })} />
        <span>{t('Keep running in the background when the window is closed (open it again from the tray icon; Quit is in the tray menu).')}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.startAtLogin} onChange={(e) => void save({ startAtLogin: e.target.checked })} />
        <span>{t('Start VOID Workshop hidden in the tray when you log in.')}</span>
      </label>
      <p className="muted">{t("VOID Portal also tells you when this PC goes offline or comes back, so you'll know if it shuts down.")}</p>

      <h4>{t('Relay')}</h4>
      <RelayField toast={toast} onSaved={setStatus} />
      <p className="muted">
        {tx(
          'Your own Cloudflare Worker: run {cmd} in {dir} (the free plan is enough) and enter the address it prints, with wss:// instead of https://. It only forwards sealed messages and never sees their contents.',
          { cmd: <code>npx wrangler deploy</code>, dir: <code>remote/relay</code> },
        )}
      </p>
    </>
  );
}

function SpeedSection({ settings, save, models }: { settings: Settings; save: (p: Partial<Settings>) => Promise<void>; models: ModelEntry[] }) {
  return (
    <>
      <h4>{t('Token saver')}</h4>
      <p>
        {t(
          "Most of a Claude plan's allowance goes into re-sending the conversation on every step. The token saver compacts it at 120k tokens at the latest, keeps less command output in it (12k instead of 30k characters per command) and asks the agent for quiet commands and small screenshots.",
        )}
      </p>
      <label className="check">
        <input type="checkbox" checked={settings.tokenSaver} onChange={(e) => void save({ tokenSaver: e.target.checked })} /> {t('Save tokens (recommended)')}
      </label>

      <h4>{t('Model for approved plans')}</h4>
      <p>
        {t(
          "Plan with a strong model, then build with a cheaper one: once you approve a plan, the task switches to this model. Sonnet uses far less of a Claude plan's weekly allowance than Opus.",
        )}
      </p>
      <label className="field">
        {t('Implement approved plans with')}
        <select className="select" value={settings.implementModel ?? ''} onChange={(e) => void save({ implementModel: e.target.value || null })}>
          <option value="">{t('The same model')}</option>
          {settings.implementModel && !models.some((m) => m.id === settings.implementModel) && (
            <option value={settings.implementModel}>{settings.implementModel}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>

      <h4>{t('Context size')}</h4>
      <p>
        {t(
          'Every step the agent takes re-sends the whole conversation. When it reaches this size, the conversation is compacted (summarised) automatically, which keeps each step cheaper and faster. You can also compact at any time with the context meter under the prompt box.',
        )}
      </p>
      <label className="field">
        {t('Compact the conversation at')}
        <select
          className="select"
          value={settings.contextCapTokens ?? ''}
          onChange={(e) => void save({ contextCapTokens: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="100000">{t('100k tokens: cheapest, compacts often')}</option>
          <option value="200000">{t('200k tokens (recommended)')}</option>
          <option value="400000">{t('400k tokens')}</option>
          <option value="">{t("The model's full window (up to 1M on some models)")}</option>
        </select>
      </label>

      <h4>{t('Prompt cache')}</h4>
      <p>
        {t(
          'Repeated context is read from the prompt cache at a tenth of the price. The cache expires when nothing is sent for a while, for example while you review a diff. A 1-hour cache survives longer breaks; on an API key its cache writes cost more (2× instead of 1.25× the input price).',
        )}
      </p>
      <label className="field">
        {t('Cache lifetime')}
        <select
          className="select"
          value={settings.promptCacheTtl}
          onChange={(e) => void save({ promptCacheTtl: e.target.value as Settings['promptCacheTtl'] })}
        >
          <option value="auto">{t('Automatic: 1 hour on a Claude plan, 5 minutes on an API key')}</option>
          <option value="5m">{t('5 minutes')}</option>
          <option value="1h">{t('1 hour: best if you often take a while to approve changes')}</option>
        </select>
      </label>

      <h4>{t('Speed')}</h4>
      <label className="check">
        <input type="checkbox" checked={settings.fastMode} onChange={(e) => void save({ fastMode: e.target.checked })} />
        <span>
          {t(
            'Fast mode: noticeably faster output on supported models, at a higher price per token (on a Claude plan it draws on extra usage). Also in the prompt bar; applies to a running task immediately.',
          )}
        </span>
      </label>
      <p className="muted">{t('Effort (thinking depth) is in the prompt bar too: lower effort answers faster and uses fewer tokens.')}</p>

      <h4>{t('Message queue')}</h4>
      <label className="check">
        <input type="checkbox" checked={settings.sendQueuedTogether} onChange={(e) => void save({ sendQueuedTogether: e.target.checked })} />
        <span>
          {t(
            'Send queued messages together. Messages you type while the agent works go out as one message when it finishes: one request instead of one per message. Turn off to send them one at a time, each after the previous reply.',
          )}
        </span>
      </label>
    </>
  );
}

function LimitsSection({ settings, save, spentToday }: { settings: Settings; save: (p: Partial<Settings>) => Promise<void>; spentToday: number }) {
  return (
    <>
      <h4>{t('Local spending limits (estimates)')}</h4>
      <Callout tone="warn">
        {t(
          "These limits are local estimates computed from token usage the SDK reports. They are not your billing balance. Retries, prompt caching, price changes, parallel work and other apps using the same organization all affect what is actually charged. The organization's real spend limit is set in the Console.",
        )}
      </Callout>
      <div className="grid2">
        <NumberField
          label={t('Max estimated spend per task (USD)')}
          value={settings.perTaskBudgetUsd}
          min={0.01}
          max={100}
          step={0.25}
          onCommit={(n) => void save({ perTaskBudgetUsd: n })}
        />
        <NumberField
          label={t('Max estimated spend per day (USD)')}
          value={settings.dailyBudgetUsd}
          min={0.01}
          max={500}
          step={0.5}
          onCommit={(n) => void save({ dailyBudgetUsd: n })}
          hint={t('Today so far: {cost} (estimate)', { cost: formatUsd(spentToday) })}
        />
        <NumberField
          label={t('Max agent turns per task')}
          value={settings.maxTurns}
          min={1}
          max={1000}
          step={10}
          onCommit={(n) => void save({ maxTurns: n })}
          hint={t('Each tool call and reply is a turn. Local Ollama models can use a high limit freely.')}
        />
        <NumberField
          label={t('Tasks working at the same time')}
          value={settings.maxRunningTasks}
          min={1}
          max={8}
          step={1}
          onCommit={(n) => void save({ maxRunningTasks: n })}
          hint={t('Each working task is its own agent process (a few hundred MB of memory). The daily spend limit covers all of them together.')}
        />
        <NumberField
          label={t('Max output tokens per request')}
          value={settings.maxOutputTokens}
          min={1024}
          max={128000}
          step={1024}
          onCommit={(n) => void save({ maxOutputTokens: n })}
        />
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.confirmTaskBudgetAboveUsd !== null}
          onChange={(e) => void save({ confirmTaskBudgetAboveUsd: e.target.checked ? 2 : null })}
        />
        <span>{t('Ask for confirmation before starting a task whose budget is at or above a threshold')}</span>
      </label>
      {settings.confirmTaskBudgetAboveUsd !== null && (
        <NumberField
          label={t('Confirmation threshold (USD)')}
          value={settings.confirmTaskBudgetAboveUsd}
          min={0}
          max={100}
          step={0.25}
          onCommit={(n) => void save({ confirmTaskBudgetAboveUsd: n })}
        />
      )}
    </>
  );
}

function SafetySection({ settings, save, sandbox }: { settings: Settings; save: (p: Partial<Settings>) => Promise<void>; sandbox: InitData['sandbox'] }) {
  return (
    <>
      <h4>{t('Agent behaviour')}</h4>
      <label className="field">
        {t('Mode')}
        <select className="select" value={settings.agentMode} onChange={(e) => void save({ agentMode: e.target.value as AgentMode })}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {t(MODE_LABEL[m.id])}: {t(m.hint)}
            </option>
          ))}
        </select>
        <span className="muted">{t('Used for new sessions. The mode button under the prompt box changes it too (Shift+Tab cycles).')}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.checkpointBeforeTasks} onChange={(e) => void save({ checkpointBeforeTasks: e.target.checked })} />
        <span>{t('Create a local Git checkpoint before each task (a private ref; does not change branches, the index or your files).')}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.fullAccess} onChange={(e) => void save({ fullAccess: e.target.checked })} />
        <span>
          {tx(
            "{title}: no sandbox, so builds, installs, other repos and the network just work; the agent can read outside the project, search or fetch the web, and run background jobs (emulators, dev servers). In Auto, ordinary work runs without asking: other folders, {gitConfig} and remotes, global installs, long builds (up to an hour). Risky commands (force-push, history rewrites, {reset}, deleting outside the project, uploads, {sudo}, {ssh}) and edits outside the project ask you, from VOID Portal too. Your keys, keyrings, {claudeDir}, Workshop's own credentials and disk tools stay blocked. Applies to new sessions.",
            {
              title: <strong>{t('Full access (like Claude Code)')}</strong>,
              gitConfig: <code>git config</code>,
              reset: <code>git reset --hard</code>,
              sudo: <code>sudo</code>,
              ssh: <code>ssh</code>,
              claudeDir: <code>~/.claude</code>,
            },
          )}
        </span>
      </label>
      {settings.fullAccess && (
        <>
          <label className="check">
            <input type="checkbox" checked={settings.autoPublish} onChange={(e) => void save({ autoPublish: e.target.checked })} />
            <span>
              {tx(
                '{title}: {push}, {gh}, {wrangler} and release scripts run without asking in Auto (force-pushes and deletions still ask). Off: each one asks first.',
                {
                  title: <strong>{t('Auto also pushes and publishes')}</strong>,
                  push: <code>git push</code>,
                  gh: <code>gh</code>,
                  wrangler: <code>wrangler</code>,
                },
              )}
            </span>
          </label>
          <Callout tone="warn">
            {t('Commands run with your full user permissions. The sandbox and publish options below are ignored while this is on.')}
          </Callout>
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={settings.sandboxCommands}
          disabled={!sandbox.available}
          onChange={(e) => void save({ sandboxCommands: e.target.checked })}
        />
        <span>
          {t('Run agent shell commands in the bubblewrap sandbox: writes only inside the project, no network unless you allow domains in Project access.')}{' '}
          {!sandbox.available && <span className="muted">{t('(missing: {list})', { list: sandbox.missing.join(', ') })}</span>}
        </span>
      </label>
      {!settings.sandboxCommands && <Callout tone="warn">{t('Without the sandbox, approved commands run with your full user permissions.')}</Callout>}
      <label className="check">
        <input type="checkbox" checked={settings.gradleBuilds} onChange={(e) => void save({ gradleBuilds: e.target.checked })} />
        <span>
          {tx(
            'Gradle / Android builds: sandboxed commands may write {dirs} and download from the Gradle, Maven Central and Google repositories. Applies to new sessions.',
            {
              dirs: (
                <>
                  <code>~/.gradle</code>, <code>~/.android</code>, <code>~/.m2</code>, <code>~/.kotlin</code>
                </>
              ),
            },
          )}
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.allowPublishCommands} onChange={(e) => void save({ allowPublishCommands: e.target.checked })} />
        <span>
          {tx(
            'Allow GitHub, push and release commands with approval: {gh}, {push}, {wrangler} and project {release} scripts. They always ask (even in Auto, and from VOID Portal) and run outside the sandbox with your logins. Force-pushes, deletions and {auth} stay blocked. Applies to new sessions.',
            {
              gh: <code>gh</code>,
              push: <code>git push</code>,
              wrangler: <code>wrangler</code>,
              release: <code>release.sh</code>,
              auth: <code>gh auth</code>,
            },
          )}
        </span>
      </label>
      {settings.allowPublishCommands && (
        <Callout tone="warn">{t('Approving one of these publishes for real: read the exact command before you tap Run once.')}</Callout>
      )}
      <div className="grid2">
        <NumberField
          label={t('Command timeout (seconds)')}
          value={settings.commandTimeoutSec}
          min={5}
          max={3600}
          step={5}
          onCommit={(n) => void save({ commandTimeoutSec: n })}
        />
        <NumberField
          label={t('Command output limit (KB)')}
          value={settings.commandOutputLimitKb}
          min={16}
          max={4096}
          step={16}
          onCommit={(n) => void save({ commandOutputLimitKb: n })}
        />
      </div>
      <h4>{t('Always enforced')}</h4>
      <p>
        {tx(
          "Every file write and every shell command needs your approval, one action at a time. Privilege escalation, recursive deletion of broad targets, pushes, history rewrites, publishing, credential and keyring access, raw network tools and attempts to touch VOID Workshop's own settings are refused outright (an admin dev session opens Workshop's own source, logs and database; see Admin). Paths are canonicalised, so {dots} and symlinks cannot escape the project.",
          { dots: <code>..</code> },
        )}
      </p>
    </>
  );
}

function ProjectSection({
  project,
  onPermissions,
  toast,
}: {
  project: Project | null;
  onPermissions: (p: ProjectPermissions) => void;
  toast: (t: 'info' | 'warn' | 'error', m: string) => void;
}) {
  const [paths, setPaths] = useState((project?.permissions.extraPaths ?? []).join('\n'));
  const [domains, setDomains] = useState((project?.permissions.networkDomains ?? []).join('\n'));
  if (!project) return <p>{t('Open a project to configure its access.')}</p>;
  const saveIt = async () => {
    try {
      const p = await call<ProjectPermissions>('project.setPermissions', {
        root: project.root,
        permissions: {
          extraPaths: paths
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          networkDomains: domains
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      onPermissions(p);
      toast('info', t('Project access updated. Applies to the next agent session.'));
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  return (
    <>
      <h4>{t('Access for {name}', { name: project.name })}</h4>
      <p className="mono">{project.root}</p>
      <label className="field">
        {t('Extra directories the agent may read and edit (one absolute path per line). Leave empty unless the task genuinely needs a sibling directory.')}
        <textarea
          className="textarea mono"
          rows={3}
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
          placeholder={t('/home/you/Documents/Projects/shared-lib')}
        />
      </label>
      <label className="field">
        {t('Network domains sandboxed commands may reach (one per line), e.g. registry.npmjs.org for npm install. Empty means no network.')}
        <textarea className="textarea mono" rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={t('registry.npmjs.org')} />
      </label>
      <div>
        <button className="btn primary" onClick={() => void saveIt()}>
          {t('Save access')}
        </button>
      </div>
      <AlwaysAllowedCommands root={project.root} toast={toast} />
    </>
  );
}

/** Exact commands remembered with "Always allow" in an approval; they run without asking in this project. */
function AlwaysAllowedCommands({ root, toast }: { root: string; toast: (t: 'info' | 'warn' | 'error', m: string) => void }) {
  const [commands, setCommands] = useState<string[] | null>(null);
  useEffect(() => {
    call<string[]>('project.allowedCommands', { root }).then(setCommands, (err) => toast('error', errorText(err)));
  }, [root, toast]);
  const forget = async (command: string) => {
    try {
      setCommands(await call<string[]>('project.forgetCommand', { root, command }));
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  return (
    <>
      <h4>{t('Always-allowed commands')}</h4>
      <p className="muted">
        {tx(
          'Chosen with {button} in a command approval. Only the exact same command runs without asking; blocked commands stay blocked, and publishing commands always ask.',
          { button: <b>{t('Always allow')}</b> },
        )}
      </p>
      {commands === null ? null : commands.length === 0 ? (
        <p className="muted">{t('None yet.')}</p>
      ) : (
        <ul className="always-allowed">
          {commands.map((c) => (
            <li key={c} className="row">
              <code className="mono">{c}</code>
              <span className="spacer" />
              <button className="btn" onClick={() => void forget(c)}>
                {t('Remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BillingSection({ init, onBillingCleared }: { init: InitData; onBillingCleared: () => void }) {
  const [blocked, setBlocked] = useState(init.billingBlocked);
  return (
    <>
      <h4>{t('What VOID Workshop can and cannot see')}</h4>
      <Callout tone="warn">
        {t(
          'Console billing data is not available to this app. There is no supported API for an individual API key to read your organization\'s remaining credit, so VOID Workshop never shows a "balance". It shows local estimates only. Check the real numbers on the Console Billing and Usage pages.',
        )}
      </Callout>
      {blocked && (
        <>
          <Callout tone="bad">{blocked.message}</Callout>
          <div>
            <button
              className="btn"
              onClick={() => {
                void call('billing.acknowledge').then(() => {
                  setBlocked(null);
                  onBillingCleared();
                });
              }}
            >
              {t('I checked the Console. Allow requests again')}
            </button>
          </div>
        </>
      )}
      <h4>{t('Three different limits')}</h4>
      <p>
        <b>{t('1. Local app limits')}</b>{' '}
        {t(
          '(Spending limits section): per-task and per-day estimates plus turn and token caps. VOID Workshop stops itself when they are reached. They protect against runaway tasks but are estimates.',
        )}
      </p>
      <p>
        <b>{t('2. Workspace / organization spend limits')}</b>{' '}
        {t(
          '(Console → Limits): enforced by Anthropic. Create a dedicated workspace for VOID Workshop, set its monthly spend limit as low as practical, and use a key from that workspace. When the limit is hit, the API refuses requests and the app stops with a clear message.',
        )}
      </p>
      <p>
        <b>{t('3. Monthly promotional API credits')}</b>{' '}
        {t(
          '(for example credits included with a Claude plan): applied by Anthropic to the linked Console organization and shared with all other API usage in that organization. Unused credit typically expires at the end of the period; confirm the exact terms in the Console. When credit runs out, Anthropic either bills your payment method or refuses requests, depending on your billing setup. VOID Workshop never buys credits, enables auto-reload, or switches billing source.',
        )}
      </p>
      <Callout tone="info">{t('Keep auto-reload off in Console Billing if you want requests to stop when the included credit is used up.')}</Callout>
      <div className="kv">
        <span className="k">{t('Billing')}</span>
        <CopyLink url={CONSOLE.billing} />
        <span className="k">{t('Spend limits')}</span>
        <CopyLink url={CONSOLE.limits} />
        <span className="k">{t('Usage')}</span>
        <CopyLink url={CONSOLE.usage} />
        <span className="k">{t('Workspaces')}</span>
        <CopyLink url={CONSOLE.workspaces} />
      </div>
      <p className="muted">{t('Local data (task history, estimates, logs) is stored in {path}.', { path: init.dataDir })}</p>
    </>
  );
}
