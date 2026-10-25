import { Fragment, createElement, useSyncExternalStore, type ReactNode } from 'react';

/**
 * Interface translations. The English text is the key: `t('Open project')`, `t('Delete {name}?', { name })`.
 * Each language is a flat JSON file in ./locales mapping the English text to its translation; a missing entry
 * shows the English text. Plurals: `tn(n, '{n} file', '{n} files')` looks up the English plural form, whose
 * translation is either a string or an object keyed by plural category (one, few, many, other...).
 * `npm run i18n` lists what each language is missing; src/i18n/i18n.test.ts keeps every language complete.
 */

/** The languages the app ships, in the order the website lists them. `tag` is the BCP 47 tag for Intl and lang=. */
export const LANGUAGES = [
  { code: 'en', name: 'English', tag: 'en' },
  { code: 'zh', name: '简体中文', tag: 'zh-Hans' },
  { code: 'es', name: 'Español', tag: 'es' },
  { code: 'ar', name: 'العربية', tag: 'ar', rtl: true },
  { code: 'pt', name: 'Português', tag: 'pt' },
  { code: 'fr', name: 'Français', tag: 'fr' },
  { code: 'ja', name: '日本語', tag: 'ja' },
  { code: 'ru', name: 'Русский', tag: 'ru' },
  { code: 'de', name: 'Deutsch', tag: 'de' },
  { code: 'id', name: 'Bahasa Indonesia', tag: 'id' },
  { code: 'ko', name: '한국어', tag: 'ko' },
  { code: 'tr', name: 'Türkçe', tag: 'tr' },
  { code: 'hi', name: 'हिन्दी', tag: 'hi' },
] as const satisfies ReadonlyArray<{ code: string; name: string; tag: string; rtl?: boolean }>;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Catalog = Record<string, string | PluralForms>;
type Vars = Record<string, string | number>;

const loaders = import.meta.glob<Catalog>('./locales/*.json', { import: 'default' });
const STORAGE_KEY = 'vw-language';

let current: LanguageCode = 'en';
let catalog: Catalog = {};
let plurals = new Intl.PluralRules('en');
const listeners = new Set<() => void>();

const info = (code: string): { code: string; name: string; tag: string; rtl?: boolean } | undefined => LANGUAGES.find((l) => l.code === code);
const isLanguage = (code: string): code is LanguageCode => !!info(code);

/** The bundled language for a saved preference: the preference itself, else the system's first supported language, else English. */
export function resolveLanguage(pref: string | null | undefined, system: readonly string[] = navigator.languages ?? [navigator.language]): LanguageCode {
  if (pref && isLanguage(pref)) return pref;
  for (const tag of system) {
    const base = tag.toLowerCase().split(/[-_]/)[0] ?? '';
    if (isLanguage(base)) return base;
  }
  return 'en';
}

/** Switches the interface language (loads its catalog first) and remembers it for the next start's first paint. */
export async function setLanguage(code: LanguageCode): Promise<void> {
  const next = code === 'en' ? {} : ((await loaders[`./locales/${code}.json`]?.()) ?? {});
  current = code;
  catalog = next;
  plurals = new Intl.PluralRules(locale());
  const root = document.documentElement;
  root.lang = locale();
  root.dir = info(code)?.rtl ? 'rtl' : 'ltr';
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Storage can be unavailable; the setting still applies once the sidecar answers.
  }
  listeners.forEach((l) => l());
}

/** The language the last run used (saved by setLanguage), so the window starts in it before the settings load. */
export function lastLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export const language = (): LanguageCode => current;
/** BCP 47 tag of the interface language, for Intl and toLocaleString. */
export const locale = (): string => info(current)?.tag ?? 'en';
export const isRtl = (): boolean => !!info(current)?.rtl;

/** Re-renders the calling component when the language changes (the app root uses it; memo'd components need it too). */
export function useLanguage(): LanguageCode {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
}

const fill = (text: string, vars?: Vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text);

/** Marks a text for translation where it is defined (say, in a table at module level); translate it with t() where it shows. */
export const msg = <T extends string>(text: T): T => text;

/** Translates an English interface text, filling {placeholders} from vars. */
export function t(text: string, vars?: Vars): string {
  const hit = catalog[text];
  return fill(typeof hit === 'string' && hit ? hit : text, vars);
}

/** Translates a count: English picks one/other by n; translations pick their language's plural category. {n} is filled in. */
export function tn(n: number, one: string, other: string, vars?: Vars): string {
  const all = { n: n.toLocaleString(locale()), ...vars };
  const hit = catalog[other];
  if (hit && typeof hit === 'object') {
    const form = hit[plurals.select(n)] ?? hit.other;
    if (form) return fill(form, all);
  } else if (typeof hit === 'string' && hit) return fill(hit, all);
  return fill(n === 1 ? one : other, all);
}

/** Like t, but placeholders may be elements: `tx('Start it with {cmd}.', { cmd: <code>ollama serve</code> })`. */
export function tx(text: string, vars: Record<string, ReactNode>): ReactNode {
  const hit = catalog[text];
  const parts = (typeof hit === 'string' && hit ? hit : text).split(/\{(\w+)\}/);
  return parts.map((p, i) => createElement(Fragment, { key: i }, i % 2 === 0 ? p : p in vars ? vars[p] : `{${p}}`));
}
