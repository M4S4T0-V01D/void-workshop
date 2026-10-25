import { EditorState } from '@codemirror/state';
import { msg, t } from '../i18n';

/** CodeMirror's own interface texts (search panel, folding, go to line), translated through EditorState.phrases. */
const PHRASES = [
  msg('Find'),
  msg('Replace'),
  msg('next'),
  msg('previous'),
  msg('all'),
  msg('match case'),
  msg('regexp'),
  msg('by word'),
  msg('replace'),
  msg('replace all'),
  msg('close'),
  msg('current match'),
  msg('on line'),
  msg('Go to line'),
  msg('go'),
  msg('Folded lines'),
  msg('Unfolded lines'),
  msg('to'),
  msg('folded code'),
  msg('unfold'),
  msg('Fold line'),
  msg('Unfold line'),
  msg('Control character'),
  msg('Completions'),
  msg('Selection deleted'),
];

/** The phrases in the current interface language; editors pick them up when they open. */
export const editorPhrases = () => EditorState.phrases.of(Object.fromEntries(PHRASES.map((p) => [p, t(p)])));
