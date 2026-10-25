import { useEffect, useMemo, useRef, useState } from 'react';
import { Dices, Paintbrush, Download, Trash2, Upload } from 'lucide-react';
import type { EditorSettings, Settings, SyntaxColors, Theme } from '../../types';
import { DEFAULT_EDITOR } from '../EditorArea';
import {
  BUILTIN_THEMES,
  COLOR_KEYS,
  SYNTAX_KEYS,
  allThemes,
  applyTheme,
  contrastWarnings,
  findTheme,
  parseThemeJson,
  randomSyntax,
  slug,
  syntaxColors,
  uniqueId,
} from '../../themes';
import { Callout } from '../common';
import { DEFAULT_UI, randomTheme } from '../../appearance';
import { LANGUAGES, resolveLanguage, t, tn, useLanguage } from '../../i18n';

export function AppearanceSection({
  settings,
  save,
  toast,
  onEditUi,
}: {
  settings: Settings;
  save: (p: Partial<Settings>) => Promise<void>;
  toast: (t: 'info' | 'warn' | 'error', m: string) => void;
  onEditUi: () => void;
}) {
  const themes = allThemes(settings.customThemes);
  const active = findTheme(settings.themeId, settings.customThemes);
  const [draft, setDraft] = useState<Theme>(() => ({ ...active, colors: { ...active.colors } }));
  const [importText, setImportText] = useState('');
  const isBuiltin = BUILTIN_THEMES.some((x) => x.id === draft.id);
  const language = useLanguage();
  // The warnings are translated texts, so they are rebuilt when the language changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const warnings = useMemo(() => contrastWarnings(draft), [draft, language]);
  const systemLanguage = LANGUAGES.find((l) => l.code === resolveLanguage(null))!;

  // live preview while editing
  useEffect(() => {
    applyTheme(draft);
  }, [draft]);
  // Restore the saved theme when the editor unmounts (e.g. the dialog closes mid-edit).
  const saved = useRef(settings);
  saved.current = settings;
  useEffect(() => () => applyTheme(findTheme(saved.current.themeId, saved.current.customThemes)), []);

  const choose = (theme: Theme) => {
    setDraft({ ...theme, colors: { ...theme.colors } });
    void save({ themeId: theme.id });
  };

  const saveCustom = () => {
    const ids = themes.map((x) => x.id);
    const name = draft.name.trim() || t('My theme');
    // Built-in and random (not yet saved) themes become a new custom theme; a custom one is updated in place.
    const isNew = !settings.customThemes.some((x) => x.id === draft.id);
    const theme: Theme = isNew ? { ...draft, name: isBuiltin ? t('{name} (custom)', { name }) : name, id: uniqueId(slug(name), ids) } : { ...draft, name };
    const custom = settings.customThemes.filter((x) => x.id !== theme.id).concat(theme);
    if (custom.length > 20) return toast('warn', t('You can keep up to 20 custom themes.'));
    void save({ customThemes: custom, themeId: theme.id }).then(() => setDraft(theme));
    toast('info', t('Saved theme "{name}".', { name: theme.name }));
  };

  const deleteCustom = () => {
    const custom = settings.customThemes.filter((x) => x.id !== draft.id);
    void save({ customThemes: custom, themeId: 'void' });
    setDraft({ ...BUILTIN_THEMES[0]!, colors: { ...BUILTIN_THEMES[0]!.colors } });
  };

  const doImport = () => {
    try {
      const theme = parseThemeJson(
        importText,
        themes.map((x) => x.id),
      );
      void save({ customThemes: [...settings.customThemes, theme], themeId: theme.id });
      setDraft(theme);
      setImportText('');
      toast('info', t('Imported theme "{name}".', { name: theme.name }));
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const editor = settings.editor ?? DEFAULT_EDITOR;
  const saveEditor = (patch: Partial<EditorSettings>) => void save({ editor: { ...editor, ...patch } });

  const exportJson = JSON.stringify({ name: draft.name, mode: draft.mode, colors: draft.colors, ...(draft.syntax && { syntax: draft.syntax }) }, null, 2);
  const syntax = syntaxColors(draft);
  const setSyntax = (key: keyof SyntaxColors, v: string) => setDraft({ ...draft, syntax: { ...draft.syntax, [key]: v } });
  const matchTheme = () => {
    const { syntax: _, ...rest } = draft;
    setDraft(rest);
  };

  return (
    <>
      <h4>{t('Language')}</h4>
      <p>{t('The language of the window. The agent answers in whatever language you write to it.')}</p>
      <select className="select" style={{ maxWidth: 320 }} value={settings.language} onChange={(e) => void save({ language: e.target.value })}>
        <option value="">{t('Same as the system ({language})', { language: systemLanguage.name })}</option>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.tag}>
            {l.name}
          </option>
        ))}
      </select>

      <h4>{t('Theme')}</h4>
      <div className="theme-grid">
        {themes.map((theme) => (
          <button
            key={theme.id}
            className={`theme-card ${settings.themeId === theme.id ? 'active' : ''}`}
            onClick={() => choose(theme)}
            style={{ background: theme.colors.panel, color: theme.colors.text }}
          >
            <div className="swatches">
              {[theme.colors.bg, theme.colors.panelAlt, theme.colors.accent, theme.colors.accent2, theme.colors.success, theme.colors.danger].map((c, i) => (
                <span key={i} style={{ background: c }} />
              ))}
            </div>
            <span style={{ fontSize: 12 }}>{t.name}</span>
          </button>
        ))}
      </div>

      <h4>{t('Layout & visual editor')}</h4>
      <p>
        {t(
          'Resize panels by dragging their edges, hide them from the Layout menu in the top bar (Ctrl+B, Ctrl+Alt+B, Ctrl+J), or open the visual editor to click any part of the window and restyle it, change the text size and fonts, add your own CSS, and save named layouts.',
        )}
      </p>
      <div className="row wrap">
        <button className="btn primary" onClick={onEditUi}>
          <Paintbrush size={14} /> {t('Open the visual editor')}
        </button>
        <button
          className="btn"
          onClick={() =>
            void save({ ui: DEFAULT_UI }).then(() => toast('info', t('Layout, text and element styles are back to the defaults. Saved layouts are kept.')))
          }
        >
          {t('Reset layout & styles')}
        </button>
      </div>

      <h4>{t('Editor')}</h4>
      <p>{t('Files you open from the tree get a tab next to the conversation. Ctrl+S saves, Ctrl+F searches, Ctrl+Z undoes.')}</p>
      <div className="row wrap">
        <label className="field" style={{ maxWidth: 140 }}>
          <span>{t('Font size')}</span>
          <select className="select" value={editor.fontSize} onChange={(e) => saveEditor({ fontSize: Number(e.target.value) })}>
            {[10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ maxWidth: 140 }}>
          <span>{t('Tab size')}</span>
          <select className="select" value={editor.tabSize} onChange={(e) => saveEditor({ tabSize: Number(e.target.value) })}>
            {[2, 4, 8].map((n) => (
              <option key={n} value={n}>
                {tn(n, '{n} space', '{n} spaces')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={editor.wordWrap} onChange={(e) => saveEditor({ wordWrap: e.target.checked })} />
        <span>{t('Wrap long lines')}</span>
      </label>

      <h4>{t('Customise')}</h4>
      <p>{t('Edit any colour; the window previews changes live. Saving a built-in theme creates a copy you can share.')}</p>
      <div className="row">
        <input className="input" style={{ maxWidth: 260 }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <select className="select" style={{ maxWidth: 140 }} value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Theme['mode'] })}>
          <option value="dark">{t('Dark')}</option>
          <option value="light">{t('Light')}</option>
        </select>
      </div>
      <div className="color-grid">
        {COLOR_KEYS.map(({ key, label }) => (
          <label key={key} className="color-field">
            <input type="color" value={draft.colors[key]} onChange={(e) => setDraft({ ...draft, colors: { ...draft.colors, [key]: e.target.value } })} />
            <span>{t(label)}</span>
            <code className="muted">{draft.colors[key]}</code>
          </label>
        ))}
      </div>
      {warnings.map((w) => (
        <Callout key={w} tone="warn">
          {w}
        </Callout>
      ))}
      <h4>{t('Syntax highlighting')}</h4>
      <p>
        {t(
          "The code editor's colours come from the theme. Randomize picks new ones that grow out of its accents and stay readable on its background; save the theme to keep them.",
        )}
      </p>
      <SyntaxPreview />
      <div className="color-grid">
        {SYNTAX_KEYS.map(({ key, label }) => (
          <label key={key} className="color-field">
            <input type="color" value={syntax[key]} onChange={(e) => setSyntax(key, e.target.value)} />
            <span>{t(label)}</span>
            <code className="muted">{draft.syntax?.[key] ? syntax[key] : t('theme')}</code>
          </label>
        ))}
      </div>
      <div className="row wrap">
        <button className="btn" onClick={() => setDraft({ ...draft, syntax: randomSyntax(draft) })} title={t('New token colours based on this theme')}>
          <Dices size={14} /> {t('Randomize syntax colours')}
        </button>
        <button className="btn" onClick={matchTheme} disabled={!draft.syntax} title={t('Derive every token colour from the theme again')}>
          {t('Match theme')}
        </button>
      </div>

      <div className="row wrap">
        <button className="btn primary" onClick={saveCustom}>
          {isBuiltin ? t('Save as new theme') : t('Save theme')}
        </button>
        <button className="btn" onClick={() => setDraft(randomTheme())} title={t('A random readable theme; name it and save it to keep it')}>
          <Dices size={14} /> {t('Random')}
        </button>
        <button className="btn" onClick={() => setDraft({ ...active, colors: { ...active.colors } })}>
          {t('Revert')}
        </button>
        {!isBuiltin && settings.customThemes.some((x) => x.id === draft.id) && (
          <button className="btn danger" onClick={deleteCustom}>
            <Trash2 size={14} /> {t('Delete theme')}
          </button>
        )}
        <button
          className="btn"
          onClick={() => void navigator.clipboard.writeText(exportJson).then(() => toast('info', t('Theme JSON copied to the clipboard.')))}
        >
          <Download size={14} /> {t('Copy theme JSON')}
        </button>
      </div>
      <label className="field">
        {t('Import a theme (paste JSON shared by someone else)')}
        <textarea
          className="textarea mono"
          rows={4}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder='{"name": "…", "mode": "dark", "colors": { "bg": "#…", … }}'
        />
      </label>
      <div>
        <button className="btn" disabled={!importText.trim()} onClick={doImport}>
          <Upload size={14} /> {t('Import')}
        </button>
      </div>
    </>
  );
}

/** A few lines of TypeScript coloured with the live `--syn-*` variables. */
function SyntaxPreview() {
  const k = (kind: keyof SyntaxColors | 'text', text: string) => (
    <span style={{ color: kind === 'text' ? 'var(--text)' : `var(--syn-${kind})`, fontStyle: kind === 'comment' ? 'italic' : undefined }}>{text}</span>
  );
  const lines = [
    [k('comment', '// Pick a star and say hello')],
    [k('meta', '@sealed')],
    [k('keyword', 'export class '), k('type', 'Orbit'), k('operator', ' {')],
    [k('text', '  '), k('property', 'radius'), k('operator', ': '), k('type', 'number'), k('operator', ' = '), k('number', '42'), k('operator', ';')],
    [k('text', '  '), k('function', 'greet'), k('operator', '('), k('text', 'name'), k('operator', ') {')],
    [
      k('keyword', '    return '),
      k('string', '`Hello, ${name}!`'),
      k('operator', ' + '),
      k('text', 'this'),
      k('operator', '.'),
      k('property', 'radius'),
      k('operator', ';'),
    ],
    [k('operator', '  }')],
    [k('operator', '}')],
    [k('tag', '<Star'), k('attribute', ' glow'), k('operator', '='), k('string', '"bright"'), k('tag', ' />')],
  ];
  return (
    <pre className="syntax-preview" aria-label={t('Syntax colour preview')}>
      {lines.map((l, i) => (
        <div key={i}>
          {l.map((part, j) => (
            <span key={j}>{part}</span>
          ))}
        </div>
      ))}
    </pre>
  );
}
