#!/usr/bin/env node
// Builds the GitHub Pages site in docs/ from site/template.html and the strings in site/i18n/<code>.json:
// English at the root, every other language in docs/<code>/, each with hreflang alternates, its own
// canonical URL, Open Graph locale and JSON-LD language, plus a sitemap listing them all.
//   node site/build.mjs           write docs/
//   node site/build.mjs --check   fail if docs/ is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..', 'docs');
const BASE = 'https://m4s4t0-v01d.github.io/void-workshop/';

// The 13 languages most used on the internet. `code` is the folder and the i18n file name.
const LANGS = [
  { code: 'en', hreflang: 'en', og: 'en_US', name: 'English' },
  { code: 'zh', hreflang: 'zh-Hans', og: 'zh_CN', name: '简体中文' },
  { code: 'es', hreflang: 'es', og: 'es_ES', name: 'Español' },
  { code: 'ar', hreflang: 'ar', og: 'ar_AR', name: 'العربية', rtl: true },
  { code: 'pt', hreflang: 'pt', og: 'pt_BR', name: 'Português' },
  { code: 'fr', hreflang: 'fr', og: 'fr_FR', name: 'Français' },
  { code: 'ja', hreflang: 'ja', og: 'ja_JP', name: '日本語' },
  { code: 'ru', hreflang: 'ru', og: 'ru_RU', name: 'Русский' },
  { code: 'de', hreflang: 'de', og: 'de_DE', name: 'Deutsch' },
  { code: 'id', hreflang: 'id', og: 'id_ID', name: 'Bahasa Indonesia' },
  { code: 'ko', hreflang: 'ko', og: 'ko_KR', name: '한국어' },
  { code: 'tr', hreflang: 'tr', og: 'tr_TR', name: 'Türkçe' },
  { code: 'hi', hreflang: 'hi', og: 'hi_IN', name: 'हिन्दी' },
];
const url = (l) => (l.code === 'en' ? BASE : `${BASE}${l.code}/`);

const template = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
const strings = Object.fromEntries(LANGS.map((l) => [l.code, JSON.parse(fs.readFileSync(path.join(here, 'i18n', `${l.code}.json`), 'utf8'))]));
const en = strings.en;

// Every language needs every key, and the same markup as English (tags, code and links), only the words differ.
const problems = [];
const tags = (s) => (s.match(/<[^>]+>/g) ?? []).join('');
const codes = (s) => (s.match(/<code>.*?<\/code>/g) ?? []).join('|');
for (const l of LANGS) {
  const s = strings[l.code];
  for (const k of Object.keys(en)) {
    if (typeof s[k] !== 'string') problems.push(`${l.code}: missing ${k}`);
    else if (tags(s[k]) !== tags(en[k])) problems.push(`${l.code}.${k}: markup differs from English`);
    else if (codes(s[k]) !== codes(en[k])) problems.push(`${l.code}.${k}: <code> content differs from English`);
  }
  for (const k of Object.keys(s)) if (!(k in en)) problems.push(`${l.code}: unknown key ${k}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const attr = (s) => s.replace(/<[^>]+>/g, '').replace(/"/g, '&quot;');
const ind = (n, lines) => lines.map((x) => ' '.repeat(n) + x).join('\n');

// Sends a first visit to the English page on to the browser's language; a language picked in the menu wins.
const redirect = `    <script>
      (function () {
        var langs = ${JSON.stringify(LANGS.map((l) => l.code))};
        var alias = { in: 'id', ms: 'id' };
        var pick;
        try {
          pick = localStorage.getItem('vw-lang');
        } catch (e) {}
        if (!pick) {
          var prefs = navigator.languages || [navigator.language];
          for (var i = 0; i < prefs.length && !pick; i++) {
            var base = String(prefs[i] || '').toLowerCase().split('-')[0];
            base = alias[base] || base;
            if (langs.indexOf(base) >= 0) pick = base;
          }
        }
        if (pick && pick !== 'en' && langs.indexOf(pick) >= 0) location.replace(pick + '/' + location.hash);
      })();
    </script>`;

function page(l) {
  const s = strings[l.code];
  const root = l.code === 'en' ? '' : '../';
  const vars = {
    lang: l.hreflang,
    dir: l.rtl ? 'rtl' : 'ltr',
    root,
    url: url(l),
    ogLocale: l.og,
    langName: l.name,
    alternates: ind(4, [
      ...LANGS.map((o) => `<link rel="alternate" hreflang="${o.hreflang}" href="${url(o)}" />`),
      `<link rel="alternate" hreflang="x-default" href="${BASE}" />`,
    ]),
    ogAlternates: ind(
      4,
      LANGS.filter((o) => o !== l).map((o) => `<meta property="og:locale:alternate" content="${o.og}" />`),
    ),
    langMenu: ind(
      12,
      LANGS.map((o) => {
        const href = o.code === 'en' ? root || './' : `${root}${o.code}/`;
        const cur = o === l ? ' aria-current="page"' : '';
        return `<a href="${href}" hreflang="${o.hreflang}" lang="${o.hreflang}" data-lang="${o.code}"${cur}>${o.name}<span>${o.code.toUpperCase()}</span></a>`;
      }),
    ),
    redirect: l.code === 'en' ? redirect : '',
  };
  const out = template.replace(/\{\{(?:(attr|json):)?(\w+)\}\}/g, (m, kind, key) => {
    const v = key in vars ? vars[key] : s[key];
    if (v === undefined) throw new Error(`template key ${key} has no value`);
    return kind === 'attr' ? attr(v) : kind === 'json' ? JSON.stringify(v) : v;
  });
  return out.replace(/\n{2,}(\s*<link rel="icon")/, '\n$1');
}

const today = new Date().toISOString().slice(0, 10);
const files = { 'index.html': page(LANGS[0]) };
for (const l of LANGS.slice(1)) files[`${l.code}/index.html`] = page(l);
const alt = ind(
  4,
  [...LANGS.map((o) => `<xhtml:link rel="alternate" hreflang="${o.hreflang}" href="${url(o)}" />`), `<xhtml:link rel="alternate" hreflang="x-default" href="${BASE}" />`],
);
files['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${LANGS.map((l) => `  <url>\n    <loc>${url(l)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${l.code === 'en' ? '1.0' : '0.9'}</priority>\n${alt}\n  </url>`).join('\n')}
</urlset>
`;

const check = process.argv.includes('--check');
// lastmod changes daily, so --check ignores it.
const same = (a, b) => a.replace(/<lastmod>.*?<\/lastmod>/g, '') === b.replace(/<lastmod>.*?<\/lastmod>/g, '');
const stale = [];
for (const [rel, content] of Object.entries(files)) {
  const file = path.join(docs, rel);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old !== null && same(old, content)) continue;
  if (check) stale.push(rel);
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}
if (check && stale.length) {
  console.error(`docs/ is out of date (run node site/build.mjs): ${stale.join(', ')}`);
  process.exit(1);
}
console.log(check ? 'docs/ is up to date' : `built ${LANGS.length} languages into docs/`);
