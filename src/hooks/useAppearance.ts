import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { call, errorText, setUiScale } from '../api';
import { applyUi, normalizeUi } from '../appearance';
import type { InitData, Settings, Ui } from '../types';
import type { Toast } from '../components/common';
import { t } from '../i18n';

/**
 * The window's appearance: the saved ui settings, the visual editor's draft, panel layout changes
 * and their shortcuts (Ctrl+B, Ctrl+Alt+B, Ctrl+J, Ctrl+Alt+E, Ctrl+Alt+Shift+0 for safe appearance).
 */
export function useAppearance(init: InitData | null, setInit: Dispatch<SetStateAction<InitData | null>>, toast: (tone: Toast['tone'], text: string) => void) {
  /** The visual editor's draft while it is open (applied live, saved or dropped when it closes). */
  const [uiDraft, setUiDraft] = useState<Ui | null>(null);
  /** Ctrl+Alt+Shift+0: custom CSS and element styles off, for when they made the window unusable. */
  const [safeUi, setSafeUi] = useState(false);

  const storedUi = init?.settings.ui;
  const savedUi = useMemo(() => normalizeUi(storedUi), [storedUi]);
  const ui = uiDraft ?? savedUi;
  useEffect(() => applyUi(ui, safeUi), [ui, safeUi]);
  useEffect(() => {
    void setUiScale(ui.scale).catch(() => undefined);
  }, [ui.scale]);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const editingRef = useRef(false);
  editingRef.current = uiDraft !== null;

  /** A layout change from a handle, menu or shortcut: part of the draft while editing, saved straight away otherwise. */
  const commitUi = useCallback(
    (next: Ui) => {
      if (editingRef.current) return setUiDraft(next);
      setInit((i) => (i ? { ...i, settings: { ...i.settings, ui: next } } : i));
      void call<Settings>('settings.update', { ui: next })
        .then((s) => setInit((i) => (i ? { ...i, settings: s } : i)))
        .catch((err) => toast('error', errorText(err)));
    },
    [setInit, toast],
  );
  const setLayout = useCallback((patch: Partial<Ui['layout']>) => commitUi({ ...uiRef.current, layout: { ...uiRef.current.layout, ...patch } }), [commitUi]);
  /** Live size while a handle is dragged; no re-render until it is let go. */
  const previewLayout = (patch: Partial<Ui['layout']>) => applyUi({ ...ui, layout: { ...ui.layout, ...patch } }, safeUi);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && e.code === 'Digit0') {
        e.preventDefault();
        setSafeUi((s) => {
          toast(
            s ? 'info' : 'warn',
            s
              ? t('Custom CSS and element styles are back on.')
              : t('Safe appearance: custom CSS and element styles are off until Ctrl+Alt+Shift+0 or a restart.'),
          );
          return !s;
        });
        return;
      }
      if (!e.ctrlKey || e.shiftKey || e.metaKey) return;
      const l = uiRef.current.layout;
      const key = e.key.toLowerCase();
      if (key === 'b') setLayout(e.altKey ? { showRight: !l.showRight } : { showLeft: !l.showLeft });
      else if (key === 'j' && !e.altKey) setLayout({ showBottom: !l.showBottom });
      else if (key === 'e' && e.altKey) setUiDraft((d) => d ?? uiRef.current);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setLayout, toast]);

  return { ui, savedUi, uiDraft, setUiDraft, setLayout, previewLayout };
}
