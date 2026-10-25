import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { createTwoFilesPatch } from 'diff';
import { Circle, FileCode2, MessagesSquare, Save, X } from 'lucide-react';
import { call, errorText } from '../api';
import type { EditorSettings, FileView, SaveResult } from '../types';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { Callout, ConfirmDialog, DiffView, Modal, type Toast } from './common';

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
}

const CHAT = 'chat';
const tabKey = (root: string, rel: string) => `${root}\0${rel}`;
const baseName = (rel: string) => rel.split('/').pop() ?? rel;
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
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const editors = useRef(new Map<string, CodeEditorHandle>());
  const checkTimer = useRef<number | undefined>(undefined);
  const editorSettings = settings ?? DEFAULT_EDITOR;

  const visible = tabs.filter((t) => t.root === root);
  const current = visible.some((t) => t.key === active) ? active : CHAT;
  const currentTab = visible.find((t) => t.key === current) ?? null;

  useEffect(() => onActiveFile(currentTab?.rel ?? null), [currentTab?.rel, onActiveFile]);

  const update = useCallback((key: string, patch: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t))), []);

  const addTab = useCallback(
    (projectRoot: string, v: FileView) => {
      if (v.binary) return toast('info', `${v.rel} is a binary file (${v.size} bytes); it is not opened.`);
      const key = tabKey(projectRoot, v.rel);
      const tab: Tab = {
        key,
        root: projectRoot,
        rel: v.rel,
        initial: v.content ?? '',
        hash: v.hash,
        readOnly: v.truncated,
        note: v.truncated ? `Showing the first 1 MB of ${Math.round(v.size / 1024)} KB; files this large open read-only.` : null,
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
        toast('error', `Could not open ${rel}: ${errorText(err)}`);
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
    const tab = tabsRef.current.find((t) => t.key === key);
    if (!tab) return;
    if (tab.dirty && !force) return setConfirmClose(key);
    const idx = visible.findIndex((t) => t.key === key);
    if (current === key) setActive(visible[idx + 1]?.key ?? visible[idx - 1]?.key ?? CHAT);
    editors.current.delete(key);
    setTabs((ts) => ts.filter((t) => t.key !== key));
  };

  const save = async (key: string, confirmed = false) => {
    const tab = tabsRef.current.find((t) => t.key === key);
    const ed = editors.current.get(key);
    if (!tab || !ed || tab.readOnly || tab.saving) return;
    if (tab.disk) return toast('warn', `${tab.rel} changed on disk. Reload it, or keep your version, before saving.`);
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
        toast('warn', `${tab.rel} changed on disk since you opened it. Nothing was saved.`);
        tabsRef.current = tabsRef.current.map((t) => (t.key === key ? { ...t, saving: false } : t));
        void checkTab(key);
      } else {
        toast('error', `Could not save ${tab.rel}: ${errorText(err)}`);
      }
    }
  };

  const reloadFromDisk = (tab: Tab) => {
    const d = tab.disk;
    if (!d) return;
    if (d.kind === 'deleted') return close(tab.key, true);
    if (d.content === null) {
      close(tab.key, true);
      return toast('info', `${tab.rel} is no longer a text file; its tab was closed.`);
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
      ? createTwoFilesPatch(diffTab.rel, diffTab.rel, diffTab.disk.content, editors.current.get(diffTab.key)?.text() ?? '', 'on disk', 'your edits')
      : null;

  return (
    <>
      {visible.length > 0 && (
        <div className="tabs editor-tabs" role="tablist">
          <button role="tab" aria-selected={current === CHAT} className={`tab ${current === CHAT ? 'active' : ''}`} onClick={() => activate(CHAT)}>
            <MessagesSquare size={13} /> Conversation
          </button>
          {visible.map((t) => (
            <div
              key={t.key}
              role="tab"
              aria-selected={current === t.key}
              className={`tab file-tab ${current === t.key ? 'active' : ''}`}
              title={t.rel}
              onClick={() => activate(t.key)}
              onAuxClick={(e) => e.button === 1 && close(t.key)}
            >
              <FileCode2 size={13} />
              <span className="name">{baseName(t.rel)}</span>
              {t.disk && <span className="tab-flag" title="Changed on disk" />}
              <button
                className={`icon-btn tab-close ${t.dirty ? 'dirty' : ''}`}
                aria-label={t.dirty ? `Close ${t.rel} (unsaved)` : `Close ${t.rel}`}
                onClick={(e) => {
                  e.stopPropagation();
                  close(t.key);
                }}
              >
                {t.dirty ? <Circle size={9} fill="currentColor" /> : <X size={12} />}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="center-pane" hidden={current !== CHAT}>
        {children}
      </div>
      {tabs.map((t) => (
        <div key={t.key} className="center-pane editor-pane" hidden={current !== t.key}>
          <div className="editor-bar">
            <span className="path">{t.rel}</span>
            <span className="spacer" />
            <span className="muted">{t.saving ? 'Saving…' : t.readOnly ? 'Read-only' : t.dirty ? 'Unsaved' : ''}</span>
            {!t.readOnly && (
              <button className="btn small" onClick={() => void save(t.key)} disabled={t.saving || !t.dirty} title="Save (Ctrl+S)">
                <Save size={13} /> Save
              </button>
            )}
          </div>
          {t.note && <Callout tone="warn">{t.note}</Callout>}
          {t.disk && (
            <div className="editor-banner">
              <Callout tone="warn">
                {t.disk.kind === 'deleted' ? `${t.rel} was deleted on disk.` : `${t.rel} changed on disk (perhaps by the agent) while you had unsaved edits.`}
              </Callout>
              <div className="actions">
                <button className="btn small" onClick={() => reloadFromDisk(t)}>
                  {t.disk.kind === 'deleted' ? 'Close tab' : 'Reload from disk'}
                </button>
                {t.disk.kind === 'changed' && t.disk.content !== null && (
                  <button className="btn small" onClick={() => setDiffFor(t.key)}>
                    Show diff
                  </button>
                )}
                <button className="btn small" onClick={() => keepMine(t)}>
                  {t.disk.kind === 'deleted' ? 'Keep editing (save recreates it)' : 'Keep mine'}
                </button>
              </div>
            </div>
          )}
          <CodeEditor
            rel={t.rel}
            initial={t.initial}
            readOnly={t.readOnly}
            settings={editorSettings}
            onDirty={(dirty) => update(t.key, { dirty })}
            onSave={() => void save(t.key)}
            handle={(h) => {
              if (h) editors.current.set(t.key, h);
            }}
          />
        </div>
      ))}

      {confirmOpen && (
        <ConfirmDialog
          title="Open a sensitive file?"
          confirmLabel="Show contents"
          onCancel={() => setConfirmOpen(null)}
          onConfirm={() => {
            const rel = confirmOpen.rel;
            setConfirmOpen(null);
            void read(rel, true);
          }}
        >
          {confirmOpen.rel} looks sensitive ({confirmOpen.sensitive}). Opening it here shows its contents in this window; it is not sent to the agent.
        </ConfirmDialog>
      )}
      {confirmSave && (
        <ConfirmDialog
          title="Save a sensitive file?"
          confirmLabel="Save"
          onCancel={() => setConfirmSave(null)}
          onConfirm={() => {
            const key = confirmSave;
            setConfirmSave(null);
            void save(key, true);
          }}
        >
          {tabs.find((t) => t.key === confirmSave)?.rel} looks sensitive ({tabs.find((t) => t.key === confirmSave)?.sensitive}). Save your changes to it?
        </ConfirmDialog>
      )}
      {confirmClose && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          confirmLabel="Discard"
          danger
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => {
            const key = confirmClose;
            setConfirmClose(null);
            close(key, true);
          }}
        >
          {tabs.find((t) => t.key === confirmClose)?.rel} has changes that are not saved.
        </ConfirmDialog>
      )}
      {diffTab && diffText !== null && (
        <Modal title={`${diffTab.rel}: disk → your edits`} wide onClose={() => setDiffFor(null)}>
          <DiffView diff={diffText} maxHeight={520} />
        </Modal>
      )}
    </>
  );
}
