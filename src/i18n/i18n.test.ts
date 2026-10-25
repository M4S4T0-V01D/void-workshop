import { afterAll, describe, expect, it } from 'vitest';
import { LANGUAGES, resolveLanguage, setLanguage, t, tn, tx, type Catalog } from './index';
import { extractKeys, placeholders } from './extract';

const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../i18n/**'], { query: '?raw', import: 'default', eager: true });
const catalogs = import.meta.glob<Catalog>('./locales/*.json', { import: 'default', eager: true });
const { keys, raw } = extractKeys(sources);
const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

describe('interface texts', () => {
  it('finds the texts', () => {
    expect(keys.size).toBeGreaterThan(500);
    expect(keys.has('Open project')).toBe(true);
  });

  it('has no JSX text outside t()', () => {
    expect(raw).toEqual([]);
  });
});

describe.each(LANGUAGES.filter((l) => l.code !== 'en').map((l) => l.code))('%s', (code) => {
  const catalog = catalogs[`./locales/${code}.json`] ?? {};

  it('translates every text', () => {
    expect([...keys.keys()].filter((k) => !catalog[k])).toEqual([]);
  });

  it('has no entries the window no longer uses', () => {
    expect(Object.keys(catalog).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('keeps the placeholders of every text', () => {
    const bad: string[] = [];
    for (const [key, value] of Object.entries(catalog)) {
      const want = placeholders(key);
      const forms = typeof value === 'string' ? { other: value } : value;
      if (typeof value !== 'string' && (!keys.get(key)?.one || !value.other || Object.keys(value).some((f) => !PLURAL_FORMS.has(f)))) bad.push(key);
      for (const [form, text] of Object.entries(forms)) {
        const got = placeholders(text ?? '');
        // A singular form may say the number in words ("one file") instead of {n}.
        const expected = form === 'other' ? want : want.filter((p) => !(p === 'n' && !got.includes('n')));
        if (got.join() !== expected.join()) bad.push(`${key} [${form}]: ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('translator', () => {
  afterAll(() => setLanguage('en'));

  it('resolves the language from the setting, then the system', () => {
    expect(resolveLanguage('de', ['fr-FR'])).toBe('de');
    expect(resolveLanguage('', ['pt-BR', 'en'])).toBe('pt');
    expect(resolveLanguage('', ['zh-Hans-CN'])).toBe('zh');
    expect(resolveLanguage('xx', ['nl-NL'])).toBe('en');
  });

  it('falls back to English and fills placeholders', async () => {
    await setLanguage('en');
    expect(t('Remove {name}', { name: 'a.png' })).toBe('Remove a.png');
    expect(tn(1, '{n} file touched by this task', '{n} files touched by this task')).toBe('1 file touched by this task');
    expect(tn(1200, '{n} file touched by this task', '{n} files touched by this task')).toBe('1,200 files touched by this task');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('switches language, direction and plural rules', async () => {
    await setLanguage('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(t('Open project')).not.toBe('Open project');
    await setLanguage('ru');
    const few = tn(3, '{n} changed file', '{n} changed files');
    const many = tn(5, '{n} changed file', '{n} changed files');
    expect(few).not.toBe(many);
    expect(tx('Start it with {cmd}.', { cmd: 'x' })).toBeTruthy();
  });
});
