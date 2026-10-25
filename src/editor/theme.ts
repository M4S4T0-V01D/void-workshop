import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Built on the window's CSS variables, so every theme (built-in or custom) colours the editor too. Text and
 * background come from `.code-editor`, which the visual editor can restyle.
 */
const themeSpec: Parameters<typeof EditorView.theme>[0] = {
  '&': { color: 'inherit', backgroundColor: 'transparent', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--accent-2)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-2)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 60%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--text-dim)', borderRight: '1px solid var(--border)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--text)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-alt)', border: '1px solid var(--border)', color: 'var(--text-dim)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-2-soft)', outline: '1px solid var(--accent-2)' },
  '.cm-nonmatchingBracket': { backgroundColor: 'var(--danger-soft)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warning-soft)', outline: '1px solid var(--warning)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-2-soft)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel input, .cm-panel button': { fontSize: '12px' },
  '.cm-textfield': { backgroundColor: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--panel-alt)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel-alt)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
};

export const workshopTheme = (mode: 'dark' | 'light') => EditorView.theme(themeSpec, { dark: mode === 'dark' });

const syn = (k: string) => `var(--syn-${k})`;

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword], color: syn('keyword') },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape], color: syn('string') },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.variableName), t.standard(t.variableName)], color: syn('number') },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: syn('comment'), fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color: syn('function') },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.self], color: syn('type') },
  { tag: [t.tagName, t.heading], color: syn('tag'), fontWeight: '600' },
  { tag: t.attributeName, color: syn('attribute') },
  { tag: [t.propertyName, t.definition(t.propertyName), t.labelName], color: syn('property') },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--text)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], color: syn('operator') },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], color: syn('meta') },
  { tag: [t.link, t.url], color: syn('function'), textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.inserted, color: 'var(--success)' },
  { tag: t.deleted, color: 'var(--danger)' },
  { tag: t.invalid, color: 'var(--danger)', textDecoration: 'underline wavy' },
]);

export const workshopHighlight = syntaxHighlighting(highlight);
