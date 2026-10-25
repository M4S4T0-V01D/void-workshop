import type { SyntaxColors, Theme, ThemeColors } from './types';

export const COLOR_KEYS: Array<{ key: keyof ThemeColors; label: string }> = [
  { key: 'bg', label: 'Background' },
  { key: 'panel', label: 'Panels' },
  { key: 'panelAlt', label: 'Raised surfaces' },
  { key: 'border', label: 'Borders' },
  { key: 'text', label: 'Text' },
  { key: 'textDim', label: 'Secondary text' },
  { key: 'accent', label: 'Primary accent' },
  { key: 'accent2', label: 'Secondary accent' },
  { key: 'success', label: 'Success' },
  { key: 'warning', label: 'Warning' },
  { key: 'danger', label: 'Danger' },
];

export const BUILTIN_THEMES: Theme[] = [
  {
    id: 'void',
    name: 'Void (default)',
    mode: 'dark',
    colors: {
      bg: '#0b0a12',
      panel: '#121020',
      panelAlt: '#1a1730',
      border: '#2a2546',
      text: '#e8e4ff',
      textDim: '#9a93c0',
      accent: '#a970ff',
      accent2: '#22e3ff',
      success: '#3ee08f',
      warning: '#ffc857',
      danger: '#ff5c7a',
    },
  },
  {
    id: 'nebula',
    name: 'Nebula',
    mode: 'dark',
    colors: {
      bg: '#0e0814',
      panel: '#170d22',
      panelAlt: '#22142f',
      border: '#3a2350',
      text: '#f5e8ff',
      textDim: '#b394c8',
      accent: '#ff5fd2',
      accent2: '#4df5d1',
      success: '#5ee6a0',
      warning: '#ffd166',
      danger: '#ff6b6b',
    },
  },
  {
    id: 'abyss',
    name: 'Abyss',
    mode: 'dark',
    colors: {
      bg: '#05080f',
      panel: '#0a101c',
      panelAlt: '#111a2b',
      border: '#1e2b45',
      text: '#dce8ff',
      textDim: '#7f93b8',
      accent: '#5b8cff',
      accent2: '#00e0ff',
      success: '#2fd6a0',
      warning: '#f5c451',
      danger: '#ff5577',
    },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    mode: 'dark',
    colors: {
      bg: '#060a06',
      panel: '#0b120b',
      panelAlt: '#111c11',
      border: '#1f331f',
      text: '#c9ffcf',
      textDim: '#79a77f',
      accent: '#39ff6a',
      accent2: '#ffb000',
      success: '#39ff6a',
      warning: '#ffb000',
      danger: '#ff4f4f',
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    mode: 'dark',
    colors: {
      bg: '#0f0a0a',
      panel: '#181010',
      panelAlt: '#221616',
      border: '#3a2424',
      text: '#ffece4',
      textDim: '#c49a8c',
      accent: '#ff7a3d',
      accent2: '#c77dff',
      success: '#5ad38b',
      warning: '#ffcc4d',
      danger: '#ff4d6d',
    },
  },
  {
    id: 'daylight',
    name: 'Daylight',
    mode: 'light',
    colors: {
      bg: '#f6f5fb',
      panel: '#ffffff',
      panelAlt: '#eeebf8',
      border: '#d6d1ea',
      text: '#1c1830',
      textDim: '#5d5878',
      accent: '#7a3cff',
      accent2: '#0090b8',
      success: '#16a35f',
      warning: '#b7791f',
      danger: '#d23a5a',
    },
  },
  {
    id: 'high-contrast',
    name: 'High contrast',
    mode: 'dark',
    colors: {
      bg: '#000000',
      panel: '#0a0a0a',
      panelAlt: '#161616',
      border: '#5a5a5a',
      text: '#ffffff',
      textDim: '#d0d0d0',
      accent: '#d48cff',
      accent2: '#00ffff',
      success: '#00ff7f',
      warning: '#ffd400',
      danger: '#ff4d4d',
    },
  },
];

const HEX = /^#[0-9a-fA-F]{6}$/;

export function allThemes(custom: Theme[]): Theme[] {
  return [...BUILTIN_THEMES, ...custom];
}

export function findTheme(id: string, custom: Theme[]): Theme {
  return allThemes(custom).find((t) => t.id === id) ?? BUILTIN_THEMES[0]!;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Readability problems worth warning about in the theme editor. */
export function contrastWarnings(t: Theme): string[] {
  const w: string[] = [];
  const c = t.colors;
  if (contrast(c.text, c.bg) < 7) w.push(`Text on background contrast is ${contrast(c.text, c.bg).toFixed(1)}:1 (aim for 7:1).`);
  if (contrast(c.text, c.panel) < 4.5) w.push(`Text on panels contrast is ${contrast(c.text, c.panel).toFixed(1)}:1 (minimum 4.5:1).`);
  if (contrast(c.textDim, c.panel) < 3) w.push(`Secondary text on panels is hard to read (${contrast(c.textDim, c.panel).toFixed(1)}:1).`);
  if (contrast(c.accent, c.panel) < 3) w.push(`Primary accent blends into panels (${contrast(c.accent, c.panel).toFixed(1)}:1).`);
  if (contrast(c.danger, c.panel) < 3) w.push(`Danger colour is hard to see on panels.`);
  return w;
}

export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

// ---- code editor syntax colours ----------------------------------------------------------------------

export const SYNTAX_KEYS: Array<{ key: keyof SyntaxColors; label: string }> = [
  { key: 'keyword', label: 'Keywords' },
  { key: 'string', label: 'Strings' },
  { key: 'number', label: 'Numbers & constants' },
  { key: 'comment', label: 'Comments' },
  { key: 'function', label: 'Functions' },
  { key: 'type', label: 'Types & classes' },
  { key: 'tag', label: 'Tags & headings' },
  { key: 'attribute', label: 'Attributes' },
  { key: 'property', label: 'Properties' },
  { key: 'operator', label: 'Operators & punctuation' },
  { key: 'meta', label: 'Decorators & meta' },
];

export function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.min(100, Math.max(0, s)) / 100;
  l = Math.min(100, Math.max(0, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[0, 8, 4]
    .map((n) =>
      Math.round(f(n) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Lighten (dark themes) or darken (light themes) `hex` until it reaches `min`:1 contrast on `bg`. */
export function readableOn(hex: string, bg: string, min: number, mode: Theme['mode']): string {
  const [h, s, l0] = hexToHsl(hex);
  let out = hex;
  for (let l = l0; contrast(out, bg) < min && l >= 0 && l <= 100; l += mode === 'dark' ? 2 : -2) out = hslToHex(h, s, l);
  return out;
}

function readable(t: Theme, c: SyntaxColors): SyntaxColors {
  const out = { ...c };
  for (const { key } of SYNTAX_KEYS) out[key] = readableOn(c[key], t.colors.bg, key === 'comment' || key === 'operator' ? 3 : 4.5, t.mode);
  return out;
}

/** The palette a theme gets without overrides: its accents and status colours, spread over the token kinds. */
export function deriveSyntax(t: Theme): SyntaxColors {
  const c = t.colors;
  return readable(t, {
    keyword: c.accent,
    string: c.success,
    number: mix(c.warning, c.danger, 0.45),
    comment: c.textDim,
    function: c.accent2,
    type: c.warning,
    tag: c.danger,
    attribute: mix(c.accent, c.warning, 0.5),
    property: mix(c.accent2, c.text, 0.4),
    operator: mix(c.textDim, c.text, 0.35),
    meta: mix(c.danger, c.accent, 0.5),
  });
}

/** A random palette that still belongs to the theme: hues grow out of its accents, readable on its background. */
export function randomSyntax(t: Theme, rnd: () => number = Math.random): SyntaxColors {
  const [ah, as] = hexToHsl(t.colors.accent);
  const [bh] = hexToHsl(t.colors.accent2);
  const [gh, gs] = hexToHsl(t.colors.bg);
  const dark = t.mode === 'dark';
  const base = rnd() < 0.5 ? ah : bh;
  const scheme = Math.floor(rnd() * 3);
  // 0: hues around the accents' arc, 1: analogous around one accent, 2: golden-angle spread from it.
  const arc = ((bh - ah + 540) % 360) - 180;
  const hue = (i: number) =>
    scheme === 0 ? ah + (arc * i) / 8 + (rnd() * 16 - 8) : scheme === 1 ? base + (i - 4) * (12 + rnd() * 6) : base + i * 137.508 + (rnd() * 20 - 10);
  const sat = Math.min(95, Math.max(45, as + rnd() * 30 - 15));
  const keys: Array<keyof SyntaxColors> = ['keyword', 'string', 'number', 'function', 'type', 'tag', 'attribute', 'property', 'meta'];
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }
  const out = {} as SyntaxColors;
  keys.forEach((k, i) => (out[k] = hslToHex(hue(i), sat + rnd() * 10 - 5, dark ? 62 + rnd() * 14 : 32 + rnd() * 10)));
  out.comment = hslToHex(gh + rnd() * 40 - 20, Math.min(30, gs + 8), dark ? 45 : 58);
  out.operator = mix(t.colors.textDim, t.colors.text, 0.2 + rnd() * 0.4);
  return readable(t, out);
}

/** The colours the code editor uses for a theme: its saved overrides over the derived palette. */
export function syntaxColors(t: Theme): SyntaxColors {
  const derived = deriveSyntax(t);
  if (!t.syntax) return derived;
  const out = { ...derived };
  for (const { key } of SYNTAX_KEYS) {
    const v = t.syntax[key];
    if (v && HEX.test(v)) out[key] = v;
  }
  return out;
}

export function applyTheme(t: Theme, root: HTMLElement = document.documentElement): void {
  const c = t.colors;
  const vars: Record<string, string> = {
    '--bg': c.bg,
    '--panel': c.panel,
    '--panel-alt': c.panelAlt,
    '--border': c.border,
    '--text': c.text,
    '--text-dim': c.textDim,
    '--accent': c.accent,
    '--accent-2': c.accent2,
    '--success': c.success,
    '--warning': c.warning,
    '--danger': c.danger,
    '--accent-soft': mix(c.panel, c.accent, 0.18),
    '--accent-2-soft': mix(c.panel, c.accent2, 0.16),
    '--danger-soft': mix(c.panel, c.danger, 0.16),
    '--warning-soft': mix(c.panel, c.warning, 0.16),
    '--success-soft': mix(c.panel, c.success, 0.16),
    '--hover': mix(c.panel, c.text, t.mode === 'dark' ? 0.06 : 0.05),
    '--shadow': t.mode === 'dark' ? '0 12px 40px rgba(0,0,0,0.55)' : '0 12px 40px rgba(40,30,80,0.18)',
  };
  for (const [k, v] of Object.entries(syntaxColors(t))) vars[`--syn-${k}`] = v;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.themeMode = t.mode;
  root.style.colorScheme = t.mode;
}

/** Validate an imported theme (pasted JSON). Returns a normalised theme or throws. */
export function parseThemeJson(text: string, existingIds: string[]): Theme {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON.');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Theme must be an object.');
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'Imported theme';
  const mode = o.mode === 'light' ? 'light' : 'dark';
  const colors = o.colors as Record<string, unknown> | undefined;
  if (!colors || typeof colors !== 'object') throw new Error('Theme needs a "colors" object.');
  const out = {} as ThemeColors;
  for (const { key } of COLOR_KEYS) {
    const v = colors[key];
    if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`Colour "${key}" must be a #rrggbb value.`);
    out[key] = v.toLowerCase();
  }
  const theme: Theme = { id: uniqueId(slug(name), existingIds), name, mode, colors: out };
  if (o.syntax && typeof o.syntax === 'object') {
    const raw = o.syntax as Record<string, unknown>;
    const syntax: Partial<SyntaxColors> = {};
    for (const { key } of SYNTAX_KEYS) {
      const v = raw[key];
      if (v === undefined) continue;
      if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`Syntax colour "${key}" must be a #rrggbb value.`);
      syntax[key] = v.toLowerCase();
    }
    if (Object.keys(syntax).length) theme.syntax = syntax;
  }
  return theme;
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'theme'
  );
}

export function uniqueId(base: string, existing: string[]): string {
  let id = `custom-${base}`;
  let n = 2;
  while (existing.includes(id)) id = `custom-${base}-${n++}`;
  return id.slice(0, 40);
}
