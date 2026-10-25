import { StreamLanguage, type StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

type Loader = () => Promise<Extension>;

/** A grammar from @codemirror/legacy-modes (shell, TOML, Dockerfile, …): smaller and good enough for highlighting. */
const legacy =
  (load: () => Promise<StreamParser<unknown>>): Loader =>
  async () =>
    StreamLanguage.define(await load());

const js =
  (opts: { jsx?: boolean; typescript?: boolean }): Loader =>
  () =>
    import('@codemirror/lang-javascript').then((m) => m.javascript(opts));

const LOADERS: Record<string, Loader> = {
  js: js({}),
  mjs: js({}),
  cjs: js({}),
  jsx: js({ jsx: true }),
  ts: js({ typescript: true }),
  mts: js({ typescript: true }),
  cts: js({ typescript: true }),
  tsx: js({ jsx: true, typescript: true }),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  htm: () => import('@codemirror/lang-html').then((m) => m.html()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  h: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cc: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  hpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  svg: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  sh: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  bash: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  zsh: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  toml: legacy(() => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
  kt: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
  kts: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
  lua: legacy(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  rb: legacy(() => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
  swift: legacy(() => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
  ini: legacy(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  conf: legacy(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  properties: legacy(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  diff: legacy(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  patch: legacy(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  dockerfile: legacy(() => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile)),
};

/** Files known by their whole name rather than an extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'sh',
  '.bashrc': 'sh',
  '.zshrc': 'sh',
  '.profile': 'sh',
  '.env': 'ini',
  '.gitignore': 'ini',
  '.editorconfig': 'ini',
  'cargo.lock': 'toml',
};

/** The language key for a path, or null for plain text. */
export function languageKey(rel: string): string | null {
  const base = rel.split(/[/\\]/).pop()!.toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  if (base.startsWith('.env.')) return 'ini';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  return LOADERS[ext] ? ext : null;
}

export async function loadLanguage(rel: string): Promise<Extension | null> {
  const key = languageKey(rel);
  return key ? LOADERS[key]!() : null;
}
