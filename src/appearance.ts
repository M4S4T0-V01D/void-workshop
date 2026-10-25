import type { ElementStyle, Layout, SavedLayout, Theme, ThemeColors, Ui, UiElement } from './types';
import { msg, t } from './i18n';
import { contrastWarnings, parseThemeJson, randomSyntax, slug } from './themes';

export const DEFAULT_LAYOUT: Layout = {
  leftW: 270,
  rightW: 360,
  bottomH: 230,
  leftSplit: 60,
  showLeft: true,
  showRight: true,
  showBottom: true,
  bottomCollapsed: false,
  swapSides: false,
};

export const DEFAULT_UI: Ui = {
  scale: 1,
  density: 'comfortable',
  radius: 8,
  fontSans: '',
  fontMono: '',
  layout: DEFAULT_LAYOUT,
  elements: {},
  customCss: '',
};

/** Size limits, the same as the backend's schema. */
export const LIMITS = {
  leftW: [160, 800],
  rightW: [200, 900],
  bottomH: [80, 800],
  leftSplit: [15, 85],
  scale: [0.8, 1.5],
  radius: [0, 16],
  zoom: [0.6, 2],
  padding: [0, 48],
  elementRadius: [0, 32],
  borderWidth: [0, 6],
} as const;

export const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

export const DENSITY_SPACE: Record<Ui['density'], number> = { compact: 0.7, comfortable: 1, spacious: 1.3 };

/** What the visual editor can select, most specific first (the first one matching a clicked node wins). */
export const ELEMENTS: Array<{ id: UiElement; label: string; selector: string; container?: boolean }> = [
  { id: 'primaryButtons', label: msg('Primary buttons'), selector: '.btn.primary' },
  { id: 'buttons', label: msg('Buttons'), selector: '.btn' },
  { id: 'inputs', label: msg('Inputs'), selector: '.input, .select, .textarea' },
  { id: 'userMessage', label: msg('Your messages'), selector: '.msg.user .bubble' },
  { id: 'assistantMessage', label: msg('Agent messages'), selector: '.msg.assistant .bubble' },
  { id: 'planCard', label: msg('Plan card'), selector: '.plan-card', container: true },
  { id: 'composer', label: msg('Prompt box'), selector: '.composer-box', container: true },
  { id: 'panelHeader', label: msg('Panel headers'), selector: '.panel-header', container: true },
  { id: 'tabs', label: msg('Tab bars'), selector: '.tabs', container: true },
  { id: 'fileTree', label: msg('File tree'), selector: '.tree', container: true },
  { id: 'topbar', label: msg('Top bar'), selector: '.topbar', container: true },
  { id: 'statusbar', label: msg('Status bar'), selector: '.statusbar', container: true },
  { id: 'left', label: msg('Files & tasks panel'), selector: '.left', container: true },
  { id: 'right', label: msg('Review & git panel'), selector: '.right', container: true },
  { id: 'bottom', label: msg('Terminal panel'), selector: '.bottom', container: true },
  { id: 'codeEditor', label: msg('Code editor'), selector: '.code-editor', container: true },
  { id: 'center', label: msg('Conversation'), selector: '.center', container: true },
];

export const elementLabel = (id: UiElement) => {
  const label = ELEMENTS.find((e) => e.id === id)?.label;
  return label ? t(label) : id;
};

/** The editable element a click landed on: the nearest ancestor (up to the window) that one of ELEMENTS matches. */
export function pickElement(target: Element | null): { id: UiElement; node: Element } | null {
  for (let n = target; n && !n.classList.contains('app'); n = n.parentElement) {
    for (const e of ELEMENTS) if (n.matches(e.selector)) return { id: e.id, node: n };
  }
  return null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const num = (v: unknown, r: readonly [number, number]) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, r) : undefined);

/** One element's overrides as CSS declarations (values are re-checked here so nothing else gets into the stylesheet). */
export function elementDecls(s: ElementStyle): string[] {
  const d: string[] = [];
  if (s.bg && HEX.test(s.bg)) d.push(`background: ${s.bg} !important`);
  if (s.text && HEX.test(s.text)) d.push(`color: ${s.text} !important`);
  if (s.border && HEX.test(s.border)) d.push(`border-color: ${s.border} !important`);
  const bw = num(s.borderWidth, LIMITS.borderWidth);
  if (bw !== undefined) d.push(`border-width: ${bw}px !important`, 'border-style: solid !important');
  const z = num(s.zoom, LIMITS.zoom);
  if (z !== undefined) d.push(`zoom: ${z}`);
  if (s.bold !== undefined) d.push(`font-weight: ${s.bold ? 700 : 400} !important`);
  const p = num(s.padding, LIMITS.padding);
  if (p !== undefined) d.push(`padding: ${p}px !important`);
  const r = num(s.radius, LIMITS.elementRadius);
  if (r !== undefined) d.push(`border-radius: ${r}px !important`);
  return d;
}

/** The stylesheet for the visual editor's per-element overrides. */
export function elementCss(elements: Ui['elements']): string {
  const out: string[] = [];
  for (const e of [...ELEMENTS].reverse()) {
    const s = elements[e.id];
    if (!s) continue;
    const decls = elementDecls(s);
    if (!decls.length) continue;
    const sel = e.selector
      .split(',')
      .map((p) => `.app ${p.trim()}`)
      .join(', ');
    out.push(`${sel} { ${decls.join('; ')}; }`);
    // A solid colour replaces the hover look of buttons; keep some feedback.
    if (e.id === 'buttons' || e.id === 'primaryButtons')
      out.push(`${sel.replaceAll(/(\.btn[\w.]*)/g, '$1:hover:not(:disabled)')} { filter: brightness(1.15); }`);
  }
  return out.join('\n');
}

/** CSS custom properties for a layout; the outer grid columns follow swapSides and hidden panels. */
export function layoutVars(l: Layout, ui: Pick<Ui, 'elements'> = { elements: {} }): Record<string, string> {
  const left = l.showLeft ? `${clamp(l.leftW, LIMITS.leftW)}px` : '0px';
  const right = l.showRight ? `${clamp(l.rightW, LIMITS.rightW)}px` : '0px';
  const vars: Record<string, string> = {
    '--col-a': l.swapSides ? right : left,
    '--col-b': l.swapSides ? left : right,
    '--left-split': `${clamp(l.leftSplit, LIMITS.leftSplit)}%`,
    '--topbar-h': `${Math.round(48 * (num(ui.elements.topbar?.zoom, LIMITS.zoom) ?? 1))}px`,
    '--statusbar-h': `${Math.round(26 * (num(ui.elements.statusbar?.zoom, LIMITS.zoom) ?? 1))}px`,
  };
  return { ...vars, '--bottom-h': `${clamp(l.bottomH, LIMITS.bottomH)}px` };
}

export function appClasses(l: Layout): string {
  return [
    l.swapSides && 'swap-sides',
    !l.showLeft && 'hide-left',
    !l.showRight && 'hide-right',
    !l.showBottom && 'hide-bottom',
    l.showBottom && l.bottomCollapsed && 'bottom-collapsed',
  ]
    .filter(Boolean)
    .join(' ');
}

const SANS = "'Inter', 'Noto Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, 'Cascadia Code', 'DejaVu Sans Mono', monospace";
const FONT = /^[\w .,'"-]*$/;

function styleTag(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

/**
 * Apply everything but the UI scale (the webview's zoom, see api.setUiScale). `safe` leaves out the custom CSS and
 * element overrides, for when they made the window unusable.
 */
export function applyUi(ui: Ui, safe = false, root: HTMLElement = document.documentElement): void {
  const vars: Record<string, string> = {
    ...layoutVars(ui.layout, safe ? { elements: {} } : ui),
    '--radius': `${clamp(ui.radius, LIMITS.radius)}px`,
    '--space': String(DENSITY_SPACE[ui.density] ?? 1),
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  for (const [key, font, stack] of [
    ['--sans', ui.fontSans, SANS],
    ['--mono', ui.fontMono, MONO],
  ] as const) {
    if (font.trim() && FONT.test(font)) root.style.setProperty(key, `${font}, ${stack}`);
    else root.style.removeProperty(key);
  }
  styleTag('ui-elements').textContent = safe ? '' : elementCss(ui.elements);
  styleTag('ui-custom-css').textContent = safe ? '' : ui.customCss;
}

/** Fill gaps in a ui object (older saves, imported profiles) with the defaults. */
export function normalizeUi(raw: unknown): Ui {
  const o = raw && typeof raw === 'object' ? (raw as Partial<Ui>) : {};
  const layout = o.layout && typeof o.layout === 'object' ? o.layout : {};
  return {
    ...DEFAULT_UI,
    ...o,
    layout: { ...DEFAULT_LAYOUT, ...layout },
    elements: o.elements && typeof o.elements === 'object' ? o.elements : {},
  };
}

export function uniqueLayoutId(name: string, existing: string[]): string {
  const base = `layout-${slug(name)}`.slice(0, 36);
  let id = base;
  let n = 2;
  while (existing.includes(id)) id = `${base}-${n++}`;
  return id;
}

/** A new or replaced (same name) saved layout. */
export function saveLayout(layouts: SavedLayout[], name: string, ui: Ui, themeId: string | null): SavedLayout[] {
  const clean = name.trim().slice(0, 60) || t('My layout');
  const same = layouts.find((l) => l.name.toLowerCase() === clean.toLowerCase());
  const entry: SavedLayout = {
    id:
      same?.id ??
      uniqueLayoutId(
        clean,
        layouts.map((l) => l.id),
      ),
    name: clean,
    ui,
    themeId,
  };
  return same ? layouts.map((l) => (l.id === same.id ? entry : l)) : [...layouts, entry];
}

// ---- appearance profiles (theme + layout + CSS in one JSON) --------------------------------------

export const PROFILE_KIND = 'void-workshop-appearance';

export function exportProfile(name: string, ui: Ui, theme: Theme | null): string {
  return JSON.stringify(
    {
      kind: PROFILE_KIND,
      version: 1,
      name,
      theme: theme ? { name: theme.name, mode: theme.mode, colors: theme.colors, ...(theme.syntax && { syntax: theme.syntax }) } : null,
      ui,
    },
    null,
    2,
  );
}

export function parseProfile(text: string, existingThemeIds: string[]): { name: string; ui: Ui; theme: Theme | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(t('Not valid JSON.'));
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.kind !== PROFILE_KIND) throw new Error(t('This is not a VOID Workshop appearance profile.'));
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : t('Imported layout');
  const theme = o.theme ? parseThemeJson(JSON.stringify(o.theme), existingThemeIds) : null;
  return { name, ui: normalizeUi(o.ui), theme };
}

// ---- random themes ---------------------------------------------------------------------------------

function hsl(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, [0, 100]) / 100;
  l = clamp(l, [0, 100]) / 100;
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

const ADJECTIVES = [
  'Silent',
  'Electric',
  'Midnight',
  'Frozen',
  'Solar',
  'Velvet',
  'Neon',
  'Distant',
  'Hollow',
  'Crimson',
  'Lunar',
  'Static',
  'Drifting',
  'Quiet',
];
const NOUNS = ['Pulsar', 'Reef', 'Orbit', 'Nebula', 'Ember', 'Tide', 'Signal', 'Comet', 'Grove', 'Circuit', 'Aurora', 'Harbor', 'Quasar', 'Mirage'];

function candidate(rnd: () => number): Omit<Theme, 'id'> {
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const light = rnd() < 0.2;
  const h = rnd() * 360;
  const s = 15 + rnd() * 35;
  const ah = h + (rnd() * 80 - 40);
  const a2h = ah + 120 + rnd() * 120;
  const colors: ThemeColors = light
    ? {
        bg: hsl(h, s * 0.6, 96 + rnd() * 2),
        panel: hsl(h, s * 0.3, 99.5),
        panelAlt: hsl(h, s * 0.7, 92 + rnd() * 2),
        border: hsl(h, s * 0.6, 82),
        text: hsl(h, 35, 11),
        textDim: hsl(h, 15, 36),
        accent: hsl(ah, 70 + rnd() * 20, 42),
        accent2: hsl(a2h, 80, 34),
        success: hsl(145, 70, 32),
        warning: hsl(36, 85, 36),
        danger: hsl(350, 70, 45),
      }
    : {
        bg: hsl(h, s, 3 + rnd() * 3),
        panel: hsl(h, s, 7 + rnd() * 2),
        panelAlt: hsl(h, s, 12 + rnd() * 2),
        border: hsl(h, s + 10, 20 + rnd() * 6),
        text: hsl(h, 40, 92),
        textDim: hsl(h, 20, 66),
        accent: hsl(ah, 75 + rnd() * 25, 62 + rnd() * 8),
        accent2: hsl(a2h, 80 + rnd() * 20, 58 + rnd() * 10),
        success: hsl(140 + rnd() * 20, 65, 56),
        warning: hsl(38 + rnd() * 10, 90, 62),
        danger: hsl(345 + rnd() * 15, 85, 64),
      };
  return { name: `${pick(ADJECTIVES)} ${pick(NOUNS)}`, mode: light ? 'light' : 'dark', colors };
}

/** A readable random theme (passes the editor's contrast checks); the caller names and saves it. */
export function randomTheme(rnd: () => number = Math.random): Theme {
  let t = candidate(rnd);
  for (let i = 0; i < 60 && contrastWarnings({ ...t, id: 'x' }).length; i++) t = candidate(rnd);
  const theme: Theme = { ...t, id: `draft-${slug(t.name)}` };
  return rnd() < 0.5 ? { ...theme, syntax: randomSyntax(theme, rnd) } : theme;
}
