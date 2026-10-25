import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Dices, GripHorizontal, MousePointerClick, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react';
import type { ElementStyle, Settings, Theme, Ui, UiElement } from '../types';
import {
  DEFAULT_LAYOUT,
  DEFAULT_UI,
  ELEMENTS,
  LIMITS,
  elementLabel,
  exportProfile,
  parseProfile,
  pickElement,
  randomTheme,
  saveLayout,
} from '../appearance';
import { COLOR_KEYS, allThemes, applyTheme, contrastWarnings, findTheme, slug, uniqueId } from '../themes';

type Tab = 'element' | 'layout' | 'text' | 'theme' | 'css' | 'saved';
const TABS: Array<[Tab, string]> = [
  ['element', 'Element'],
  ['layout', 'Layout'],
  ['text', 'Text'],
  ['theme', 'Theme'],
  ['css', 'CSS'],
  ['saved', 'Saved'],
];

const FONT_SUGGESTIONS = ['Inter', 'Noto Sans', 'Cantarell', 'Ubuntu', 'Roboto', 'Fira Sans', 'IBM Plex Sans', 'DejaVu Sans', 'system-ui'];
const MONO_SUGGESTIONS = ['JetBrains Mono', 'Fira Code', 'Hack', 'Cascadia Code', 'IBM Plex Mono', 'Source Code Pro', 'DejaVu Sans Mono', 'monospace'];

function toHex(css: string, fallback: string): string {
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
  if (!m || m[4] === '0') return fallback;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

/** The element's current look, to start the colour pickers from what is on screen. */
function computed(id: UiElement): { bg: string; text: string; border: string } {
  const sel = ELEMENTS.find((e) => e.id === id)!.selector;
  const node = document.querySelector(sel.split(',').map((p) => `.app ${p.trim()}`).join(', '));
  const root = getComputedStyle(document.documentElement);
  const panel = root.getPropertyValue('--panel').trim() || '#121020';
  if (!node) return { bg: panel, text: root.getPropertyValue('--text').trim() || '#e8e4ff', border: root.getPropertyValue('--border').trim() || '#2a2546' };
  const cs = getComputedStyle(node);
  return { bg: toHex(cs.backgroundColor, panel), text: toHex(cs.color, '#e8e4ff'), border: toHex(cs.borderTopColor, '#2a2546') };
}

function Slider({
  label,
  value,
  range,
  step = 1,
  fmt = String,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  step?: number;
  fmt?: (v: number) => string;
  onChange: (v: number) => void;
  onReset?: () => void;
}) {
  return (
    <label className="ui-prop">
      <span>{label}</span>
      <input type="range" min={range[0]} max={range[1]} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="val" onDoubleClick={onReset} title={onReset ? 'Double-click to reset' : undefined}>
        {fmt(value)}
      </span>
    </label>
  );
}

function ColorProp({ label, value, shown, onChange, onReset }: { label: string; value?: string; shown: string; onChange: (v: string) => void; onReset: () => void }) {
  return (
    <div className="ui-prop">
      <span>{label}</span>
      <input type="color" value={value ?? shown} onChange={(e) => onChange(e.target.value)} />
      {value ? (
        <button className="icon-btn" title="Back to the theme's colour" onClick={onReset}>
          <RotateCcw size={12} />
        </button>
      ) : (
        <span className="val">theme</span>
      )}
    </div>
  );
}

export function UiEditor({
  ui,
  saved,
  settings,
  onUi,
  save,
  onClose,
  toast,
}: {
  /** The draft being edited (already applied to the window). */
  ui: Ui;
  /** What is saved, for Cancel. */
  saved: Ui;
  settings: Settings;
  onUi: (ui: Ui) => void;
  /** Saves and reports whether it worked (failures are shown as a toast already). */
  save: (patch: Partial<Settings>) => Promise<boolean>;
  onClose: (keep: boolean) => void;
  toast: (tone: 'info' | 'warn' | 'error', text: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('element');
  const [selected, setSelected] = useState<UiElement | null>(null);
  const [hover, setHover] = useState<UiElement | null>(null);
  const [pos, setPos] = useState(() => ({ x: Math.max(16, window.innerWidth - 360), y: 60 }));
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [themeDraft, setThemeDraft] = useState<Theme | null>(null);
  const [layoutName, setLayoutName] = useState('');
  const [withTheme, setWithTheme] = useState(true);
  const [importText, setImportText] = useState('');
  const dirty = JSON.stringify(ui) !== JSON.stringify(saved);

  // Click-to-select: while the editor is open, clicks in the window pick an element instead of doing their usual thing.
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('ui-editing');
    let hovered: Element | null = null;
    const exempt = (t: EventTarget | null) => !(t instanceof Element) || !!t.closest('.ui-editor, .resizer, .overlay, .toasts');
    const unhover = () => {
      hovered?.removeAttribute('data-ui-hover');
      hovered = null;
    };
    const over = (e: MouseEvent) => {
      if (exempt(e.target)) return unhover(), setHover(null);
      const p = pickElement(e.target as Element);
      if (p?.node === hovered) return;
      unhover();
      if (p) {
        hovered = p.node;
        p.node.setAttribute('data-ui-hover', '');
      }
      setHover(p?.id ?? null);
    };
    const block = (e: Event) => {
      if (exempt(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const click = (e: MouseEvent) => {
      if (exempt(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const p = pickElement(e.target as Element);
      if (p) {
        setSelected(p.id);
        setTab('element');
      }
    };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('mousedown', block, true);
    document.addEventListener('click', click, true);
    document.addEventListener('dblclick', block, true);
    return () => {
      unhover();
      html.classList.remove('ui-editing');
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('mousedown', block, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('dblclick', block, true);
    };
  }, []);

  // Outline every instance of the selected element (all buttons, all panel headers…): edits apply to all of them.
  useEffect(() => {
    const tag = document.createElement('style');
    tag.id = 'ui-selected';
    const sel = selected && ELEMENTS.find((e) => e.id === selected)!.selector;
    if (sel)
      tag.textContent = `${sel
        .split(',')
        .map((p) => `.app ${p.trim()}`)
        .join(', ')} { outline: 2px solid var(--accent) !important; outline-offset: -2px; }`;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, [selected]);

  // Theme previews are live; leaving restores the saved theme.
  const savedTheme = useRef(settings);
  savedTheme.current = settings;
  useEffect(() => {
    if (themeDraft) applyTheme(themeDraft);
    else applyTheme(findTheme(savedTheme.current.themeId, savedTheme.current.customThemes));
  }, [themeDraft, settings.themeId]);
  useEffect(() => () => applyTheme(findTheme(savedTheme.current.themeId, savedTheme.current.customThemes)), []);

  const setLayout = (patch: Partial<Ui['layout']>) => onUi({ ...ui, layout: { ...ui.layout, ...patch } });
  const style: ElementStyle = (selected && ui.elements[selected]) || {};
  const setStyle = (patch: Partial<ElementStyle>) => {
    if (!selected) return;
    const next: ElementStyle = { ...style, ...patch };
    for (const k of Object.keys(next) as Array<keyof ElementStyle>) if (next[k] === undefined) delete next[k];
    const elements = { ...ui.elements };
    if (Object.keys(next).length) elements[selected] = next;
    else delete elements[selected];
    onUi({ ...ui, elements });
  };
  const shown = selected ? computed(selected) : null;

  const themes = allThemes(settings.customThemes);
  const rollTheme = () => setThemeDraft(randomTheme());
  const saveThemeDraft = async () => {
    if (!themeDraft) return;
    if (settings.customThemes.length >= 20) return toast('warn', 'You can keep up to 20 custom themes. Delete one in Settings → Appearance first.');
    const name = themeDraft.name.trim().slice(0, 60) || 'Random theme';
    const t: Theme = { ...themeDraft, name, id: uniqueId(slug(name), themes.map((x) => x.id)) };
    if (!(await save({ customThemes: [...settings.customThemes, t], themeId: t.id }))) return;
    setThemeDraft(null);
    toast('info', `Saved theme "${t.name}".`);
  };

  const applySaved = async (id: string) => {
    const l = settings.layouts.find((x) => x.id === id);
    if (!l) return;
    if (!(await save({ ui: l.ui, ...(l.themeId && themes.some((t) => t.id === l.themeId) ? { themeId: l.themeId } : {}) }))) return;
    onUi(l.ui);
    toast('info', `Layout "${l.name}" applied.`);
  };
  const storeLayout = async () => {
    const name = layoutName.trim() || 'My layout';
    const layouts = saveLayout(settings.layouts, name, ui, withTheme ? settings.themeId : null);
    if (layouts.length > 20) return toast('warn', 'You can keep up to 20 layouts.');
    if (!(await save({ layouts }))) return;
    setLayoutName('');
    toast('info', `Saved layout "${name}".`);
  };
  const currentTheme = findTheme(settings.themeId, settings.customThemes);
  const doImport = async () => {
    try {
      const p = parseProfile(
        importText,
        themes.map((t) => t.id),
      );
      const customThemes = p.theme ? [...settings.customThemes, p.theme] : settings.customThemes;
      if (customThemes.length > 20) return toast('warn', 'You can keep up to 20 custom themes.');
      const layouts = saveLayout(settings.layouts, p.name, p.ui, p.theme?.id ?? null);
      if (!(await save({ customThemes, layouts, ui: p.ui, ...(p.theme ? { themeId: p.theme.id } : {}) }))) return;
      onUi(p.ui);
      setImportText('');
      toast('info', `Imported "${p.name}".`);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  // Outside the window's .app tree, so element styles and selectors never reach the editor itself.
  return createPortal(
    <div className="ui-editor" style={{ left: pos.x, top: pos.y }}>
      <div
        className="ui-editor-head"
        onPointerDown={(e) => {
          if ((e.target as Element).closest('button')) return;
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPos({
            x: Math.min(window.innerWidth - 120, Math.max(0, e.clientX - drag.current.dx)),
            y: Math.min(window.innerHeight - 40, Math.max(0, e.clientY - drag.current.dy)),
          });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <GripHorizontal size={14} />
        <span className="grow">Edit UI{dirty ? ' •' : ''}</span>
        <button className="icon-btn" title="Close without saving" onClick={() => onClose(false)}>
          <X size={14} />
        </button>
      </div>
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="ui-editor-body">
        {tab === 'element' && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              <MousePointerClick size={12} /> Click any part of the window to select it{hover ? ` (pointing at: ${elementLabel(hover)})` : ''}. Drag the
              highlighted panel edges to resize.
            </p>
            <select className="select" value={selected ?? ''} onChange={(e) => setSelected((e.target.value || null) as UiElement | null)}>
              <option value="">Choose an element…</option>
              {ELEMENTS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                  {ui.elements[e.id] ? ' •' : ''}
                </option>
              ))}
            </select>
            {selected && shown && (
              <>
                <h5>{elementLabel(selected)}</h5>
                <ColorProp label="Background" value={style.bg} shown={shown.bg} onChange={(bg) => setStyle({ bg })} onReset={() => setStyle({ bg: undefined })} />
                <ColorProp label="Text" value={style.text} shown={shown.text} onChange={(text) => setStyle({ text })} onReset={() => setStyle({ text: undefined })} />
                <ColorProp
                  label="Border"
                  value={style.border}
                  shown={shown.border}
                  onChange={(border) => setStyle({ border })}
                  onReset={() => setStyle({ border: undefined })}
                />
                <Slider
                  label="Border width"
                  value={style.borderWidth ?? 1}
                  range={LIMITS.borderWidth}
                  fmt={(v) => `${v}px`}
                  onChange={(borderWidth) => setStyle({ borderWidth })}
                  onReset={() => setStyle({ borderWidth: undefined })}
                />
                <Slider
                  label="Size"
                  value={style.zoom ?? 1}
                  range={LIMITS.zoom}
                  step={0.05}
                  fmt={(v) => `${Math.round(v * 100)}%`}
                  onChange={(zoom) => setStyle({ zoom })}
                  onReset={() => setStyle({ zoom: undefined })}
                />
                <Slider
                  label="Padding"
                  value={style.padding ?? 0}
                  range={LIMITS.padding}
                  fmt={(v) => (style.padding === undefined ? 'auto' : `${v}px`)}
                  onChange={(padding) => setStyle({ padding })}
                  onReset={() => setStyle({ padding: undefined })}
                />
                <Slider
                  label="Corners"
                  value={style.radius ?? ui.radius}
                  range={LIMITS.elementRadius}
                  fmt={(v) => (style.radius === undefined ? 'auto' : `${v}px`)}
                  onChange={(radius) => setStyle({ radius })}
                  onReset={() => setStyle({ radius: undefined })}
                />
                <div className="ui-prop">
                  <span>Weight</span>
                  <div className="ui-chips">
                    {(
                      [
                        [undefined, 'Default'],
                        [false, 'Normal'],
                        [true, 'Bold'],
                      ] as const
                    ).map(([v, label]) => (
                      <button key={label} className={`btn small ${style.bold === v ? 'active' : ''}`} onClick={() => setStyle({ bold: v })}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="row">
                  <button className="btn small" disabled={!ui.elements[selected]} onClick={() => setStyle({ ...Object.fromEntries(Object.keys(style).map((k) => [k, undefined])) })}>
                    <RotateCcw size={12} /> Reset {elementLabel(selected).toLowerCase()}
                  </button>
                  <button className="btn small" disabled={!Object.keys(ui.elements).length} onClick={() => onUi({ ...ui, elements: {} })}>
                    Reset all elements
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {tab === 'layout' && (
          <>
            <h5>Panels</h5>
            {(
              [
                ['showLeft', 'Files & tasks', 'Ctrl+B'],
                ['showRight', 'Review & git', 'Ctrl+Alt+B'],
                ['showBottom', 'Terminal & log', 'Ctrl+J'],
              ] as const
            ).map(([k, label, keys]) => (
              <label key={k} className="row">
                <input type="checkbox" checked={ui.layout[k]} onChange={(e) => setLayout({ [k]: e.target.checked })} />
                <span className="grow">{label}</span>
                <span className="muted">{keys}</span>
              </label>
            ))}
            <label className="row">
              <input type="checkbox" checked={ui.layout.swapSides} onChange={(e) => setLayout({ swapSides: e.target.checked })} />
              <span className="grow">Swap the side panels</span>
            </label>
            <h5>Sizes</h5>
            <Slider label="Files & tasks" value={ui.layout.leftW} range={LIMITS.leftW} fmt={(v) => `${v}px`} onChange={(leftW) => setLayout({ leftW })} />
            <Slider label="Review & git" value={ui.layout.rightW} range={LIMITS.rightW} fmt={(v) => `${v}px`} onChange={(rightW) => setLayout({ rightW })} />
            <Slider label="Terminal" value={ui.layout.bottomH} range={LIMITS.bottomH} fmt={(v) => `${v}px`} onChange={(bottomH) => setLayout({ bottomH })} />
            <Slider label="File tree share" value={ui.layout.leftSplit} range={LIMITS.leftSplit} fmt={(v) => `${v}%`} onChange={(leftSplit) => setLayout({ leftSplit })} />
            <div>
              <button className="btn small" onClick={() => onUi({ ...ui, layout: DEFAULT_LAYOUT })}>
                <RotateCcw size={12} /> Default layout
              </button>
            </div>
          </>
        )}

        {tab === 'text' && (
          <>
            <Slider
              label="UI scale"
              value={ui.scale}
              range={LIMITS.scale}
              step={0.05}
              fmt={(v) => `${Math.round(v * 100)}%`}
              onChange={(scale) => onUi({ ...ui, scale })}
              onReset={() => onUi({ ...ui, scale: 1 })}
            />
            <div className="ui-prop">
              <span>Density</span>
              <div className="ui-chips">
                {(['compact', 'comfortable', 'spacious'] as const).map((d) => (
                  <button key={d} className={`btn small ${ui.density === d ? 'active' : ''}`} onClick={() => onUi({ ...ui, density: d })}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <Slider label="Corners" value={ui.radius} range={LIMITS.radius} fmt={(v) => `${v}px`} onChange={(radius) => onUi({ ...ui, radius })} />
            <label className="field">
              Interface font (empty = default)
              <input className="input" list="ui-fonts" value={ui.fontSans} maxLength={120} onChange={(e) => onUi({ ...ui, fontSans: e.target.value })} />
            </label>
            <label className="field">
              Code font (empty = default)
              <input className="input" list="ui-mono-fonts" value={ui.fontMono} maxLength={120} onChange={(e) => onUi({ ...ui, fontMono: e.target.value })} />
            </label>
            <datalist id="ui-fonts">
              {FONT_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <datalist id="ui-mono-fonts">
              {MONO_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <p className="muted" style={{ margin: 0 }}>
              Fonts must be installed on this PC; letters, digits, spaces, quotes, commas and dashes only.
            </p>
          </>
        )}

        {tab === 'theme' && (
          <>
            <div className="row">
              <button className="btn primary" onClick={rollTheme}>
                <Dices size={14} /> Random theme
              </button>
              {themeDraft && (
                <button className="btn" onClick={() => setThemeDraft(null)}>
                  Discard
                </button>
              )}
            </div>
            {themeDraft ? (
              <>
                <label className="field">
                  Name
                  <input className="input" value={themeDraft.name} maxLength={60} onChange={(e) => setThemeDraft({ ...themeDraft, name: e.target.value })} />
                </label>
                <div className="ui-chips">
                  {COLOR_KEYS.map(({ key, label }) => (
                    <label key={key} title={label} className="ui-prop" style={{ gridTemplateColumns: '1fr auto' }}>
                      <span>{label}</span>
                      <input type="color" value={themeDraft.colors[key]} onChange={(e) => setThemeDraft({ ...themeDraft, colors: { ...themeDraft.colors, [key]: e.target.value } })} />
                    </label>
                  ))}
                </div>
                {contrastWarnings(themeDraft).map((w) => (
                  <p key={w} className="muted" style={{ margin: 0, color: 'var(--warning)' }}>
                    {w}
                  </p>
                ))}
                <div className="row">
                  <button className="btn primary" onClick={() => void saveThemeDraft()}>
                    <Save size={14} /> Save theme
                  </button>
                  <button className="btn" onClick={rollTheme}>
                    <Dices size={14} /> Another
                  </button>
                </div>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Roll until you like one, name it, save it. It previews on the whole window.
              </p>
            )}
            <h5>Themes</h5>
            <div className="ui-list">
              {themes.map((t) => (
                <div key={t.id} className="row">
                  <span style={{ display: 'flex', gap: 2 }}>
                    {[t.colors.bg, t.colors.panel, t.colors.accent, t.colors.accent2].map((c, i) => (
                      <span key={i} style={{ width: 10, height: 14, background: c, borderRadius: 2 }} />
                    ))}
                  </span>
                  <span className="grow">{t.name}</span>
                  <button
                    className={`btn small ${!themeDraft && settings.themeId === t.id ? 'active' : ''}`}
                    onClick={() => {
                      setThemeDraft(null);
                      void save({ themeId: t.id });
                    }}
                  >
                    {settings.themeId === t.id ? 'In use' : 'Use'}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'css' && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              Your own stylesheet, applied after everything else (live). It can't load anything from the internet. If it breaks the window, press
              Ctrl+Alt+Shift+0 to turn it off until the next start.
            </p>
            <textarea
              className="textarea mono"
              rows={14}
              spellCheck={false}
              maxLength={64000}
              value={ui.customCss}
              placeholder={'.topbar {\n  background: #000;\n}'}
              onChange={(e) => onUi({ ...ui, customCss: e.target.value })}
            />
          </>
        )}

        {tab === 'saved' && (
          <>
            <h5>Save this layout</h5>
            <div className="row">
              <input className="input" placeholder="Name" value={layoutName} maxLength={60} onChange={(e) => setLayoutName(e.target.value)} />
              <button className="btn primary" onClick={() => void storeLayout()}>
                <Save size={14} /> Save
              </button>
            </div>
            <label className="row">
              <input type="checkbox" checked={withTheme} onChange={(e) => setWithTheme(e.target.checked)} />
              <span>Include the theme ({currentTheme.name})</span>
            </label>
            <h5>Saved layouts</h5>
            {settings.layouts.length === 0 && <p className="muted">None yet. Layouts keep sizes, panels, text settings, element styles and CSS.</p>}
            <div className="ui-list">
              {settings.layouts.map((l) => (
                <div key={l.id} className="row">
                  <span className="grow" title={l.themeId ? `With theme ${findTheme(l.themeId, settings.customThemes).name}` : undefined}>
                    {l.name}
                  </span>
                  <button className="btn small" onClick={() => void applySaved(l.id)}>
                    Apply
                  </button>
                  <button
                    className="icon-btn"
                    title="Copy as a profile (JSON)"
                    onClick={() => {
                      const theme = l.themeId ? findTheme(l.themeId, settings.customThemes) : null;
                      void navigator.clipboard.writeText(exportProfile(l.name, l.ui, theme)).then(() => toast('info', 'Profile copied to the clipboard.'));
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <button className="icon-btn" title="Delete" onClick={() => void save({ layouts: settings.layouts.filter((x) => x.id !== l.id) })}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <h5>Share</h5>
            <button
              className="btn small"
              onClick={() =>
                void navigator.clipboard.writeText(exportProfile(layoutName.trim() || 'My layout', ui, currentTheme)).then(() => toast('info', 'Profile copied to the clipboard.'))
              }
            >
              <Copy size={12} /> Copy current look as a profile
            </button>
            <textarea
              className="textarea mono"
              rows={3}
              placeholder="Paste a profile to import it…"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <div>
              <button className="btn small" disabled={!importText.trim()} onClick={() => void doImport()}>
                <Upload size={12} /> Import
              </button>
            </div>
          </>
        )}
      </div>
      <div className="ui-editor-foot">
        <button className="btn small" title="Everything back to how VOID Workshop looks out of the box (not saved yet)" onClick={() => onUi(DEFAULT_UI)}>
          Reset all
        </button>
        <span className="spacer grow" />
        <button className="btn small" onClick={() => onClose(false)}>
          Cancel
        </button>
        <button className="btn small primary" disabled={!dirty} onClick={() => void save({ ui }).then((ok) => ok && onClose(true))}>
          <Save size={12} /> Save
        </button>
      </div>
    </div>,
    document.body,
  );
}
