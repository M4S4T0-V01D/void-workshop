import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEMES,
  SYNTAX_KEYS,
  applyTheme,
  contrast,
  contrastWarnings,
  deriveSyntax,
  findTheme,
  hexToHsl,
  hslToHex,
  parseThemeJson,
  randomSyntax,
  syntaxColors,
  uniqueId,
} from './themes';
import { randomTheme } from './appearance';
import type { SyntaxColors, Theme } from './types';

/** Deterministic Math.random stand-in. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const minContrast = (key: keyof SyntaxColors) => (key === 'comment' || key === 'operator' ? 3 : 4.5);
function expectReadable(t: Theme, c: SyntaxColors) {
  for (const { key } of SYNTAX_KEYS) {
    expect(c[key], `${t.id} ${key}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(c[key], t.colors.bg), `${t.id} ${key} ${c[key]}`).toBeGreaterThanOrEqual(minContrast(key));
  }
}

describe('themes', () => {
  it('every built-in theme is readable', () => {
    for (const t of BUILTIN_THEMES) expect(contrastWarnings(t), t.id).toEqual([]);
  });

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1);
  });

  it('falls back to the default theme for unknown ids', () => {
    expect(findTheme('nope', []).id).toBe('void');
  });

  it('imports valid theme JSON and rejects bad input', () => {
    const json = JSON.stringify({ name: 'Mine', mode: 'dark', colors: { ...BUILTIN_THEMES[0]!.colors, accent: '#FF00FF' } });
    const t = parseThemeJson(json, []);
    expect(t).toMatchObject({ id: 'custom-mine', name: 'Mine', mode: 'dark' });
    expect(t.colors.accent).toBe('#ff00ff');
    expect(() => parseThemeJson('{', [])).toThrow(/JSON/);
    expect(() => parseThemeJson(JSON.stringify({ name: 'x', colors: { bg: 'red' } }), [])).toThrow(/#rrggbb/);
    expect(() => parseThemeJson(JSON.stringify({ name: 'x', colors: { ...BUILTIN_THEMES[0]!.colors, text: 'url(javascript:x)' } }), [])).toThrow();
  });

  it('generates unique ids', () => {
    expect(uniqueId('mine', ['custom-mine'])).toBe('custom-mine-2');
  });

  it('applies CSS variables to the document', () => {
    const el = document.createElement('div');
    applyTheme(BUILTIN_THEMES[0]!, el);
    expect(el.style.getPropertyValue('--accent')).toBe('#a970ff');
    expect(el.dataset.themeMode).toBe('dark');
  });

  it('converts between hex and HSL', () => {
    for (const hex of ['#a970ff', '#22e3ff', '#000000', '#ffffff', '#3ee08f']) expect(hslToHex(...hexToHsl(hex))).toBe(hex);
  });

  it('derives a readable syntax palette for every built-in theme', () => {
    for (const t of BUILTIN_THEMES) expectReadable(t, deriveSyntax(t));
  });

  it('randomizes syntax colours that stay readable and vary', () => {
    const rnd = seeded(7);
    for (const t of BUILTIN_THEMES) {
      const a = randomSyntax(t, rnd);
      const b = randomSyntax(t, rnd);
      expectReadable(t, a);
      expectReadable(t, b);
      expect(a).not.toEqual(b);
    }
    for (let i = 0; i < 30; i++) {
      const t = randomTheme(rnd);
      expectReadable(t, syntaxColors(t));
    }
  });

  it('applies syntax overrides over the derived palette and sets --syn-* variables', () => {
    const t: Theme = { ...BUILTIN_THEMES[0]!, syntax: { keyword: '#123456', string: 'red' } };
    const c = syntaxColors(t);
    expect(c.keyword).toBe('#123456');
    expect(c.string).toBe(deriveSyntax(t).string);
    const el = document.createElement('div');
    applyTheme(t, el);
    expect(el.style.getPropertyValue('--syn-keyword')).toBe('#123456');
    expect(el.style.getPropertyValue('--syn-comment')).toMatch(/^#/);
  });

  it('imports syntax colours with a theme and rejects bad ones', () => {
    const colors = BUILTIN_THEMES[0]!.colors;
    const t = parseThemeJson(JSON.stringify({ name: 'S', mode: 'dark', colors, syntax: { keyword: '#ABCDEF', bogus: '#000000' } }), []);
    expect(t.syntax).toEqual({ keyword: '#abcdef' });
    expect(parseThemeJson(JSON.stringify({ name: 'S', colors }), []).syntax).toBeUndefined();
    expect(() => parseThemeJson(JSON.stringify({ name: 'S', colors, syntax: { tag: 'url(x)' } }), [])).toThrow(/Syntax colour/);
  });
});
