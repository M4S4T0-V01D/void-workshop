import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  DEFAULT_UI,
  appClasses,
  applyUi,
  elementCss,
  exportProfile,
  layoutVars,
  normalizeUi,
  parseProfile,
  pickElement,
  randomTheme,
  saveLayout,
} from './appearance';
import { BUILTIN_THEMES, contrastWarnings } from './themes';

function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

describe('appearance', () => {
  it('defaults reproduce the original grid', () => {
    expect(layoutVars(DEFAULT_LAYOUT)).toMatchObject({ '--col-a': '270px', '--col-b': '360px', '--bottom-h': '230px', '--topbar-h': '48px' });
    expect(appClasses(DEFAULT_LAYOUT)).toBe('');
  });

  it('hidden and swapped panels move the columns', () => {
    const l = { ...DEFAULT_LAYOUT, swapSides: true, showLeft: false };
    expect(layoutVars(l)).toMatchObject({ '--col-a': '360px', '--col-b': '0px' });
    expect(appClasses(l)).toBe('swap-sides hide-left');
    expect(appClasses({ ...DEFAULT_LAYOUT, bottomCollapsed: true })).toBe('bottom-collapsed');
    expect(appClasses({ ...DEFAULT_LAYOUT, showBottom: false, bottomCollapsed: true })).toBe('hide-bottom');
  });

  it('clamps sizes to the limits', () => {
    expect(layoutVars({ ...DEFAULT_LAYOUT, leftW: 5, rightW: 5000 })).toMatchObject({ '--col-a': '160px', '--col-b': '900px' });
  });

  it('turns element styles into CSS and drops anything that is not a plain value', () => {
    const css = elementCss({
      topbar: { bg: '#112233', zoom: 1.5, bold: true },
      buttons: { radius: 2 },
      inputs: { bg: 'red; } body { display: none' as string, padding: 999 },
    });
    expect(css).toContain('.app .topbar { background: #112233 !important; zoom: 1.5; font-weight: 700 !important; }');
    expect(css).toContain('.app .btn { border-radius: 2px !important; }');
    expect(css).toContain('.app .input, .app .select, .app .textarea { padding: 48px !important; }');
    expect(css).not.toContain('display: none');
    expect(layoutVars(DEFAULT_LAYOUT, { elements: { topbar: { zoom: 1.5 } } })['--topbar-h']).toBe('72px');
  });

  it('applies variables, element styles and custom CSS, and leaves them out in safe mode', () => {
    const ui = { ...DEFAULT_UI, radius: 4, density: 'compact' as const, fontSans: 'Ubuntu', elements: { topbar: { bg: '#000000' } }, customCss: '.x{}' };
    applyUi(ui);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--radius')).toBe('4px');
    expect(root.style.getPropertyValue('--space')).toBe('0.7');
    expect(root.style.getPropertyValue('--sans')).toMatch(/^Ubuntu, /);
    expect(document.getElementById('ui-custom-css')!.textContent).toBe('.x{}');
    expect(document.getElementById('ui-elements')!.textContent).toContain('#000000');
    applyUi(ui, true);
    expect(document.getElementById('ui-custom-css')!.textContent).toBe('');
    expect(document.getElementById('ui-elements')!.textContent).toBe('');
    applyUi({ ...ui, fontSans: 'x;}' });
    expect(root.style.getPropertyValue('--sans')).toBe('');
  });

  it('picks the most specific editable element under the pointer', () => {
    document.body.innerHTML = `<div class="app"><aside class="left panel"><div class="panel-header"><button class="btn primary"><span id="t">Go</span></button></div><p id="p">x</p></aside></div>`;
    expect(pickElement(document.getElementById('t'))?.id).toBe('primaryButtons');
    expect(pickElement(document.getElementById('p'))?.id).toBe('left');
    expect(pickElement(document.querySelector('.app'))).toBeNull();
  });

  it('random themes are readable and varied', () => {
    const rnd = seeded(42);
    const names = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const t = randomTheme(rnd);
      expect(contrastWarnings(t), JSON.stringify(t)).toEqual([]);
      for (const c of Object.values(t.colors)) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      names.add(t.colors.accent);
    }
    expect(names.size).toBeGreaterThan(30);
  });

  it('saves layouts by name, replacing one with the same name', () => {
    let l = saveLayout([], 'Wide chat', DEFAULT_UI, 'void');
    l = saveLayout(l, 'Focus', DEFAULT_UI, null);
    l = saveLayout(l, 'wide chat', { ...DEFAULT_UI, scale: 1.2 }, null);
    expect(l.map((x) => x.name)).toEqual(['wide chat', 'Focus']);
    expect(l[0]!.ui.scale).toBe(1.2);
    expect(new Set(l.map((x) => x.id)).size).toBe(2);
  });

  it('round-trips a profile and rejects other JSON', () => {
    const ui = { ...DEFAULT_UI, layout: { ...DEFAULT_LAYOUT, leftW: 400 } };
    const p = parseProfile(exportProfile('Mine', ui, BUILTIN_THEMES[1]!), ['void']);
    expect(p.name).toBe('Mine');
    expect(p.ui.layout.leftW).toBe(400);
    expect(p.theme?.colors).toEqual(BUILTIN_THEMES[1]!.colors);
    expect(p.theme?.id.startsWith('custom-')).toBe(true);
    expect(() => parseProfile('{"name":"x"}', [])).toThrow(/not a VOID Workshop/);
    expect(() => parseProfile('nope', [])).toThrow(/JSON/);
  });

  it('fills in missing fields of older or partial ui objects', () => {
    const u = normalizeUi({ scale: 1.1, layout: { leftW: 300 } });
    expect(u.scale).toBe(1.1);
    expect(u.layout.leftW).toBe(300);
    expect(u.layout.rightW).toBe(360);
    expect(normalizeUi(undefined)).toEqual(DEFAULT_UI);
  });

});
