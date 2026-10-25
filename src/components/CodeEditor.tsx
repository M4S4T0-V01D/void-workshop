import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Text } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { loadLanguage } from '../editor/languages';
import { workshopHighlight, workshopTheme } from '../editor/theme';
import type { EditorSettings } from '../types';

export interface CodeEditorHandle {
  text(): string;
  /** Replace the whole document (a reload from disk) and treat it as saved. */
  replace(content: string): void;
  /** `content` (what was just written) is what is on disk now. */
  markSaved(content: string): void;
  focus(): void;
}

const themeMode = (): 'dark' | 'light' => (document.documentElement.dataset.themeMode === 'light' ? 'light' : 'dark');

function settingsExtensions(s: EditorSettings) {
  return [
    EditorView.theme({ '.cm-scroller': { fontSize: `${s.fontSize}px` } }),
    EditorState.tabSize.of(s.tabSize),
    indentUnit.of(' '.repeat(s.tabSize)),
    s.wordWrap ? EditorView.lineWrapping : [],
  ];
}

/** One open file: CodeMirror 6 with the language picked from the file name, loaded on demand. */
export function CodeEditor({
  rel,
  initial,
  readOnly,
  settings,
  onDirty,
  onSave,
  handle,
}: {
  rel: string;
  initial: string;
  readOnly: boolean;
  settings: EditorSettings;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
  handle: Ref<CodeEditorHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<Text | null>(null);
  const dirty = useRef(false);
  const cb = useRef({ onDirty, onSave });
  cb.current = { onDirty, onSave };
  const compartments = useRef({ lang: new Compartment(), settings: new Compartment(), readOnly: new Compartment(), theme: new Compartment() });

  const setDirty = (d: boolean) => {
    if (dirty.current === d) return;
    dirty.current = d;
    cb.current.onDirty(d);
  };

  useEffect(() => {
    const c = compartments.current;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          // Keep Windows line endings as they are; CodeMirror would otherwise save them as \n.
          initial.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : [],
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                cb.current.onSave();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          c.theme.of(workshopTheme(themeMode())),
          workshopHighlight,
          c.lang.of([]),
          c.settings.of(settingsExtensions(settings)),
          c.readOnly.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': `Editor: ${rel}` }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(!u.state.doc.eq(saved.current!));
          }),
        ],
      }),
    });
    saved.current = v.state.doc;
    view.current = v;
    // Colours follow the CSS variables by themselves; only the light/dark flag needs a reconfigure.
    let mode = themeMode();
    const modeWatch = new MutationObserver(() => {
      if (themeMode() === mode) return;
      mode = themeMode();
      v.dispatch({ effects: c.theme.reconfigure(workshopTheme(mode)) });
    });
    modeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-mode'] });
    let live = true;
    loadLanguage(rel)
      .then((lang) => live && lang && v.dispatch({ effects: c.lang.reconfigure(lang) }))
      .catch((err) => console.warn(`[editor] no highlighting for ${rel}:`, err));
    return () => {
      live = false;
      modeWatch.disconnect();
      v.destroy();
      view.current = null;
    };
    // The view is created once per open file; later changes go through the compartments below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.settings.reconfigure(settingsExtensions(settings)) });
  }, [settings]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.readOnly.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useImperativeHandle(
    handle,
    () => ({
      text: () => view.current?.state.doc.toString() ?? '',
      replace: (content) => {
        const v = view.current;
        if (!v) return;
        const head = Math.min(v.state.selection.main.head, content.length);
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, selection: { anchor: head } });
        saved.current = v.state.doc;
        setDirty(false);
      },
      markSaved: (content) => {
        const v = view.current;
        if (!v) return;
        // Typing may have continued while the save was on its way.
        saved.current = v.state.toText(content);
        setDirty(!v.state.doc.eq(saved.current));
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );

  return <div className="code-editor" ref={host} />;
}
