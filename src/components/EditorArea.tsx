import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { createTwoFilesPatch } from 'diff';
import { Circle, Cloud, FileCode2, MessagesSquare, Save, X } from 'lucide-react';
import { call, errorText } from '../api';
import type { EditorSettings, FileView, SaveResult, ServiceView } from '../types';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { Callout, ConfirmDialog, DiffView, Modal, type Toast } from './common';
import { GithubMark } from './ServicePanels';
import { ServiceViewPane } from './ServiceViews';
import { locale, t, tn } from '../i18n';

export const DEFAULT_EDITOR: EditorSettings = { fontSize: 13, tabSize: 2, wordWrap: false };

/** What is on disk when it no longer matches what the tab was opened (or last saved) from. */
type DiskChange = { kind: 'changed'; hash: string | null; content: string | null } | { kind: 'deleted' };

interface Tab {
  key: string;
  root: string;
  rel: string;
  initial: string;
  /** Hash of the file as last read or saved; the save is refused when the disk no longer matches. */
  hash: string | null;
  readOnly: boolean;
  note: string | null;
  sensitive: string | null;
  /** The user confirmed saving this sensitive file. */
  saveOk: boolean;
  dirty: boolean;
  saving: boolean;
  disk: DiskChange | null;
}

export interface EditorAreaHandle {
  open(rel: string): void;
  /** Files may have changed on disk (agent edits, a rejected change); look at the open tabs again. */
  checkDisk(): void;
  /** A pull request, issue or Worker in a tab of its own. */
  openView(view: ServiceView): void;
}

/** A service tab; GitHub items belong to the project, Workers (root null) show in every project. */
interface ViewTab {
  key: string;
  root: string | null;
  view: ServiceView;
  title: string;
}

const CHAT = 'chat';
const tabKey = (root: string, rel: string) => `${root}\0${rel}`;
const baseName = (rel: string) => rel.split('/').pop() ?? rel;
const viewKey = (root: string | null, v: ServiceView) => (v.kind === 'gh-item' ? `${root}\0view:gh:${v.number}` : `view:cf:${v.accountId}/${v.name}`);
const isNotFound = (err: unknown) => (err as { code?: string } | null)?.code === 'not_found';

/** The center area: the conversation plus a tab per open file. Tabs stay mounted (undo history, scroll) across project switches. */
export function EditorArea({
  root,
  settings,
  toast,
  onActiveFile,
  handle,
  children,
}: {
  root: string | null;
  settings: EditorSettings | undefined;
  toast: (tone: Toast['tone'], text: string) => void;
  onActiveFile: (rel: string | null) => void;
  handle: Ref<EditorAreaHandle>;
  children: ReactNode;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>(CHAT);
  const [confirmOpen, setConfirmOpen] = useState<{ rel: string; sensitive: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState<string | null>(null);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [views, setViews] = useState<ViewTab[]>([]);
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const editors = useRef(new Map<string, CodeEditorHandle>());
  const checkTimer = useRef<number | undefined>(undefined);
  const editorSettings = settings ?? DEFAULT_EDITOR;

  const visible = tabs.filter((t) => t.root === root);
  const visibleViews = views.filter((v) => v.root === null || v.root === root);
  const allVisible = [...visible.map((t) => t.key), ...visibleViews.map((v) => v.key)];
  const current = allVisible.includes(active) ? active : CHAT;
  const currentTab = visible.find((t) => t.key === current) ?? null;

  useEffect(() => onActiveFile(currentTab?.rel ?? null), [currentTab?.rel, onActiveFile]);

  const update = useCallback((key: string, patch: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t))), []);

  const addTab = useCallback(
    (projectRoot: string, v: FileView) => {
      if (v.binary)
        return toast(
          'info',
          tn(v.size, '{name} is a binary file ({n} byte); it is not opened.', '{name} is a binary file ({n} bytes); it is not opened.', { name: v.rel }),
        );
      const key = tabKey(projectRoot, v.rel);
      const tab: Tab = {
        key,
        root: projectRoot,
        rel: v.rel,
        initial: v.content ?? '',
        hash: v.hash,
        readOnly: v.truncated,
        note: v.truncated
          ? t('Showing the first 1 MB of {size} KB; files this large open read-only.', { size: Math.round(v.size / 1024).toLocaleString(locale()) })
          : null,
        sensitive: v.sensitive,
        saveOk: false,
        dirty: false,
        saving: false,
        disk: null,
      };
      setTabs((ts) => (ts.some((t) => t.key === key) ? ts : [...ts, tab]));
      setActive(key);
    },
    [toast],
  );

  const read = useCallback(
    async (rel: string, allowSensitive: boolean) => {
      if (!root) return;
      try {
        const v = await call<FileView>('project.readFile', { root, rel, allowSensitive });
        if (v.sensitive && v.content === null) return setConfirmOpen({ rel, sensitive: v.sensitive });
        addTab(root, v);
      } catch (err) {
        toast('error', t('Could not open {name}: {error}', { name: rel, error: errorText(err) }));
      }
    },
    [root, addTab, toast],
  );

  /** Compare one tab with the disk: reload it when it has no unsaved edits, otherwise let the user decide. */
  const checkTab = useCallback(
    async (key: string) => {
      const tab = tabsRef.current.find((t) => t.key === key);
      if (!tab || tab.saving) return;
      let disk: DiskChange | null = null;
      let v: FileView | null = null;
      try {
        v = await call<FileView>('project.readFile', { root: tab.root, rel: tab.rel, allowSensitive: true });
        if (v.hash !== tab.hash) disk = { kind: 'changed', hash: v.hash, content: v.binary ? null : v.content };
      } catch (err) {
        if (!isNotFound(err)) return console.warn(`[editor] could not check ${tab.rel}:`, err);
        if (tab.hash !== null) disk = { kind: 'deleted' };
      }
      const now = tabsRef.current.find((t) => t.key === key);
      if (!now || now.saving || now.hash !== tab.hash) return; // saved or closed meanwhile
      if (disk?.kind === 'changed' && !now.dirty && disk.content !== null && v && !v.truncated) {
        editors.current.get(key)?.replace(disk.content);
        return update(key, { hash: disk.hash, disk: null, readOnly: false, note: null });
      }
      update(key, { disk });
    },
    [update],
  );

  const checkAll = useCallback(() => {
    for (const t of tabsRef.current) if (t.root === root) void checkTab(t.key);
  }, [root, checkTab]);

  useImperativeHandle(
    handle,
    () => ({
      open: (rel) => {
        if (!root) return;
        const key = tabKey(root, rel);
        if (tabsRef.current.some((t) => t.key === key)) {
          setActive(key);
          void checkTab(key);
          return;
        }
        void read(rel, false);
      },
      openView: (view) => {
        const projectRoot = view.kind === 'gh-item' ? root : null;
        if (view.kind === 'gh-item' && !projectRoot) return;
        const key = viewKey(projectRoot, view);
        const title = view.kind === 'gh-item' ? `#${view.number}${view.title ? ` ${view.title}` : ''}` : view.name;
        setViews((vs) => (vs.some((v) => v.key === key) ? vs : [...vs, { key, root: projectRoot, view, title }]));
        setActive(key);
      },
      checkDisk: () => {
        window.clearTimeout(checkTimer.current);
        checkTimer.current = window.setTimeout(checkAll, 300);
      },
    }),
    [root, read, checkTab, checkAll],
  );

  // Back from another app (an editor, a terminal) or another project: the files may have changed.
  useEffect(() => {
    checkAll();
    window.addEventListener('focus', checkAll);
    return () => window.removeEventListener('focus', checkAll);
  }, [checkAll]);

  const activate = (key: string) => {
    setActive(key);
    if (key !== CHAT) void checkTab(key);
  };

  const close = (key: string, force = false) => {
    if (views.some((v) => v.key === key)) {
      const idx = allVisible.indexOf(key);
      if (current === key) setActive(allVisible[idx + 1] ?? allVisible[idx - 1] ?? CHAT);
      return setViews((vs) => vs.filter((v) => v.key !== key));
    }
    const tab = tabsRef.current.find((t) => t.key === key);
    if (!tab) return;
    if (tab.dirty && !force) return setConfirmClose(key);
    const idx = allVisible.indexOf(key);
    if (current === key) setActive(allVisible[idx + 1] ?? allVisible[idx - 1] ?? CHAT);
    editors.current.delete(key);
    setTabs((ts) => ts.filter((t) => t.key !== key));
  };

  const save = async (key: string, confirmed = false) => {
    const tab = tabsRef.current.find((t) => t.key === key);
    const ed = editors.current.get(key);
    if (!tab || !ed || tab.readOnly || tab.saving) return;
    if (tab.disk) return toast('warn', t('{name} changed on disk. Reload it, or keep your version, before saving.', { name: tab.rel }));
    const allowSensitive = tab.saveOk || confirmed;
    if (tab.sensitive && !allowSensitive) return setConfirmSave(key);
    const content = ed.text();
    update(key, { saving: true, saveOk: allowSensitive });
    tabsRef.current = tabsRef.current.map((t) => (t.key === key ? { ...t, saving: true } : t));
    try {
      const r = await call<SaveResult>('project.writeFile', { root: tab.root, rel: tab.rel, content, baseHash: tab.hash, allowSensitive });
      ed.markSaved(content);
      update(key, { saving: false, hash: r.hash });
    } catch (err) {
      update(key, { saving: false });
      if ((err as { code?: string } | null)?.code === 'conflict') {
        toast('warn', t('{name} changed on disk since you opened it. Nothing was saved.', { name: tab.rel }));
        tabsRef.current = tabsRef.current.map((t) => (t.key === key ? { ...t, saving: false } : t));
        void checkTab(key);
      } else {
        toast('error', t('Could not save {name}: {error}', { name: tab.rel, error: errorText(err) }));
      }
    }
  };

  const reloadFromDisk = (tab: Tab) => {
    const d = tab.disk;
    if (!d) return;
    if (d.kind === 'deleted') return close(tab.key, true);
    if (d.content === null) {
      close(tab.key, true);
      return toast('info', t('{name} is no longer a text file; its tab was closed.', { name: tab.rel }));
    }
    editors.current.get(tab.key)?.replace(d.content);
    update(tab.key, { hash: d.hash, disk: null });
  };

  /** Keep the editor's text; the next save replaces (or recreates) what is on disk. */
  const keepMine = (tab: Tab) => {
    const d = tab.disk;
    if (!d) return;
    update(tab.key, { hash: d.kind === 'deleted' ? null : d.hash, disk: null });
  };

  const diffTab = tabs.find((t) => t.key === diffFor);
  const diffText =
    diffTab?.disk?.kind === 'changed' && diffTab.disk.content !== null
      ? createTwoFilesPatch(diffTab.rel, diffTab.rel, diffTab.disk.content, editors.current.get(diffTab.key)?.text() ?? '', t('on disk'), t('your edits'))
      : null;

  return (
    <>
      {allVisible.length > 0 && (
        <div className="tabs editor-tabs" role="tablist">
          <button role="tab" aria-selected={current === CHAT} className={`tab ${current === CHAT ? 'active' : ''}`} onClick={() => activate(CHAT)}>
            <MessagesSquare size={13} /> {t('Conversation')}
          </button>
          {visible.map((tab) => (
            <div
              key={tab.key}
              role="tab"
              aria-selected={current === tab.key}
              className={`tab file-tab ${current === tab.key ? 'active' : ''}`}
              title={tab.rel}
              onClick={() => activate(tab.key)}
              onAuxClick={(e) => e.button === 1 && close(tab.key)}
            >
              <FileCode2 size={13} />
              <span className="name">{baseName(tab.rel)}</span>
              {tab.disk && <span className="tab-flag" title={t('Changed on disk')} />}
              <button
                className={`icon-btn tab-close ${tab.dirty ? 'dirty' : ''}`}
                aria-label={tab.dirty ? t('Close {name} (unsaved)', { name: tab.rel }) : t('Close {name}', { name: tab.rel })}
                onClick={(e) => {
                  e.stopPropagation();
                  close(tab.key);
                }}
              >
                {tab.dirty ? <Circle size={9} fill="currentColor" /> : <X size={12} />}
              </button>
            </div>
          ))}
          {visibleViews.map((v) => (
            <div
              key={v.key}
              role="tab"
              aria-selected={current === v.key}
              className={`tab file-tab ${current === v.key ? 'active' : ''}`}
              title={v.title}
              onClick={() => activate(v.key)}
              onAuxClick={(e) => e.button === 1 && close(v.key)}
            >
              {v.view.kind === 'gh-item' ? <GithubMark size={12} /> : <Cloud size={13} />}
              <span className="name">{v.title}</span>
              <button
                className="icon-btn tab-close"
                aria-label={t('Close {name}', { name: v.title })}
                onClick={(e) => {
                  e.stopPropagation();
                  close(v.key);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="center-pane" hidden={current !== CHAT}>
        {children}
      </div>
      {tabs.map((tab) => (
        <div key={tab.key} className="center-pane editor-pane" hidden={current !== tab.key}>
          <div className="editor-bar">
            <span className="path">{tab.rel}</span>
            <span className="spacer" />
            <span className="muted">{tab.saving ? t('Saving…') : tab.readOnly ? t('Read-only') : tab.dirty ? t('Unsaved') : ''}</span>
            {!tab.readOnly && (
              <button className="btn small" onClick={() => void save(tab.key)} disabled={tab.saving || !tab.dirty} title={t('Save (Ctrl+S)')}>
                <Save size={13} /> {t('Save')}
              </button>
            )}
          </div>
          {tab.note && <Callout tone="warn">{tab.note}</Callout>}
          {tab.disk && (
            <div className="editor-banner">
              <Callout tone="warn">
                {tab.disk.kind === 'deleted'
                  ? t('{name} was deleted on disk.', { name: tab.rel })
                  : t('{name} changed on disk (perhaps by the agent) while you had unsaved edits.', { name: tab.rel })}
              </Callout>
              <div className="actions">
                <button className="btn small" onClick={() => reloadFromDisk(tab)}>
                  {tab.disk.kind === 'deleted' ? t('Close tab') : t('Reload from disk')}
                </button>
                {tab.disk.kind === 'changed' && tab.disk.content !== null && (
                  <button className="btn small" onClick={() => setDiffFor(tab.key)}>
                    {t('Show diff')}
                  </button>
                )}
                <button className="btn small" onClick={() => keepMine(tab)}>
                  {tab.disk.kind === 'deleted' ? t('Keep editing (save recreates it)') : t('Keep mine')}
                </button>
              </div>
            </div>
          )}
          <CodeEditor
            rel={tab.rel}
            initial={tab.initial}
            readOnly={tab.readOnly}
            settings={editorSettings}
            onDirty={(dirty) => update(tab.key, { dirty })}
            onSave={() => void save(tab.key)}
            handle={(h) => {
              if (h) editors.current.set(tab.key, h);
            }}
          />
        </div>
      ))}
      {views.map((v) => (
        <div key={v.key} className="center-pane editor-pane" hidden={current !== v.key}>
          <ServiceViewPane view={v.view} root={v.root} settings={editorSettings} toast={toast} />
        </div>
      ))}

      {confirmOpen && (
        <ConfirmDialog
          title={t('Open a sensitive file?')}
          confirmLabel={t('Show contents')}
          onCancel={() => setConfirmOpen(null)}
          onConfirm={() => {
            const rel = confirmOpen.rel;
            setConfirmOpen(null);
            void read(rel, true);
          }}
        >
          {t('{name} looks sensitive ({reason}). Opening it here shows its contents in this window; it is not sent to the agent.', {
            name: confirmOpen.rel,
            reason: confirmOpen.sensitive,
          })}
        </ConfirmDialog>
      )}
      {confirmSave && (
        <ConfirmDialog
          title={t('Save a sensitive file?')}
          confirmLabel={t('Save')}
          onCancel={() => setConfirmSave(null)}
          onConfirm={() => {
            const key = confirmSave;
            setConfirmSave(null);
            void save(key, true);
          }}
        >
          {t('{name} looks sensitive ({reason}). Save your changes to it?', {
            name: tabs.find((x) => x.key === confirmSave)?.rel ?? '',
            reason: tabs.find((x) => x.key === confirmSave)?.sensitive ?? '',
          })}
        </ConfirmDialog>
      )}
      {confirmClose && (
        <ConfirmDialog
          title={t('Discard unsaved changes?')}
          confirmLabel={t('Discard')}
          danger
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => {
            const key = confirmClose;
            setConfirmClose(null);
            close(key, true);
          }}
        >
          {t('{name} has changes that are not saved.', { name: tabs.find((x) => x.key === confirmClose)?.rel ?? '' })}
        </ConfirmDialog>
      )}
      {diffTab && diffText !== null && (
        <Modal title={t('{name}: disk → your edits', { name: diffTab.rel })} wide onClose={() => setDiffFor(null)}>
          <DiffView diff={diffText} maxHeight={520} />
        </Modal>
      )}
    </>
  );
}
