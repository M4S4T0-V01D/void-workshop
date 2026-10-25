import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings, ThemeSchema, UiSchema } from '../src/settings.js';
import { REMOTE_SETTINGS } from '../src/remote.js';

describe('ui settings', () => {
  it('defaults match the original fixed layout', () => {
    const l = DEFAULT_SETTINGS.ui.layout;
    expect([l.leftW, l.rightW, l.bottomH]).toEqual([270, 360, 230]);
    expect(DEFAULT_SETTINGS.ui.scale).toBe(1);
    expect(DEFAULT_SETTINGS.ui.customCss).toBe('');
    expect(DEFAULT_SETTINGS.layouts).toEqual([]);
  });

  it('fills in missing ui fields from a partial save', () => {
    const s = mergeSettings({}, { ui: { scale: 1.2, layout: { leftW: 400 } } });
    expect(s.ui.scale).toBe(1.2);
    expect(s.ui.layout.leftW).toBe(400);
    expect(s.ui.layout.rightW).toBe(360);
    expect(s.ui.density).toBe('comfortable');
  });

  it('rejects out-of-range sizes, bad colours and unknown elements', () => {
    expect(() => mergeSettings({}, { ui: { layout: { leftW: 20 } } })).toThrow();
    expect(() => mergeSettings({}, { ui: { scale: 3 } })).toThrow();
    expect(() => mergeSettings({}, { ui: { elements: { topbar: { bg: 'red' } } } })).toThrow();
    expect(() => mergeSettings({}, { ui: { elements: { nope: {} } } })).toThrow();
    expect(mergeSettings({}, { ui: { elements: { topbar: { bg: '#112233', zoom: 1.2 } } } }).ui.elements.topbar).toEqual({ bg: '#112233', zoom: 1.2 });
  });

  it('keeps font names from breaking out of the CSS variable', () => {
    expect(UiSchema.safeParse({ fontSans: "'Inter', sans-serif" }).success).toBe(true);
    expect(UiSchema.safeParse({ fontSans: 'x; } body { display:none' }).success).toBe(false);
    expect(UiSchema.safeParse({ fontMono: 'a)url(http://x' }).success).toBe(false);
  });

  it('a bad stored field resets only itself', () => {
    const s = mergeSettings({ perTaskBudgetUsd: 2, ui: { scale: 99 } });
    expect(s.perTaskBudgetUsd).toBe(2);
    expect(s.ui.scale).toBe(1);
  });

  it('saves named layouts', () => {
    const s = mergeSettings({}, { layouts: [{ id: 'l1', name: 'Wide chat', ui: { layout: { showLeft: false } } }] });
    expect(s.layouts[0]!.ui.layout.showLeft).toBe(false);
    expect(s.layouts[0]!.themeId).toBeNull();
  });

  it('the phone cannot change the layout or custom CSS', () => {
    expect(REMOTE_SETTINGS).not.toContain('ui');
    expect(REMOTE_SETTINGS).not.toContain('layouts');
    expect(REMOTE_SETTINGS).not.toContain('customThemes');
  });

  it("the window's CSP keeps custom CSS from loading anything off this machine", () => {
    const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: string } } };
    const csp = Object.fromEntries(
      conf.app.security.csp.split(';').map((d) => {
        const [k, ...v] = d.trim().split(/\s+/);
        return [k, v];
      }),
    ) as Record<string, string[]>;
    for (const d of ['default-src', 'img-src', 'font-src', 'style-src', 'connect-src']) {
      for (const src of csp[d] ?? []) {
        if (d === 'img-src' && src === 'blob:') continue;
        expect(src, `${d} ${src}`).toMatch(/^('self'|'unsafe-inline'|data:|ipc:|http:\/\/ipc\.localhost)$/);
      }
    }
    // Screenshots are shown from object URLs the window makes itself; CSS cannot mint those.
    expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp['default-src']).toEqual(["'self'"]);
  });

  it("keeps a theme's syntax colours and rejects anything but #rrggbb", () => {
    const base = { id: 'custom-x', name: 'X', mode: 'dark' };
    const colors = Object.fromEntries(
      ['bg', 'panel', 'panelAlt', 'border', 'text', 'textDim', 'accent', 'accent2', 'success', 'warning', 'danger'].map((k) => [k, '#101010']),
    );
    expect(ThemeSchema.parse({ ...base, colors, syntax: { keyword: '#a970ff' } }).syntax).toEqual({ keyword: '#a970ff' });
    expect(ThemeSchema.parse({ ...base, colors }).syntax).toBeUndefined();
    expect(ThemeSchema.safeParse({ ...base, colors, syntax: { keyword: 'red; background:url(x)' } }).success).toBe(false);
  });
});
