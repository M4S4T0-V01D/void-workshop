// Translation status of the window. Run with `npm run i18n`:
//   npm run i18n                  how many texts each language is missing, and stale entries
//   npm run i18n -- missing de    the texts German is missing, as JSON to translate and merge into de.json
//   npm run i18n -- prune         removes entries no longer used from every language file
import fs from 'node:fs';
import path from 'node:path';
import { extractKeys } from '../src/i18n/extract.ts';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const localeDir = path.join(src, 'i18n', 'locales');

const files: Record<string, string> = {};
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && !p.startsWith(path.join(src, 'i18n')))
      files[path.relative(root, p)] = fs.readFileSync(p, 'utf8');
  }
})(src);

const { keys, raw } = extractKeys(files);
const [command, code] = process.argv.slice(2);
const locales = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'));
const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));

if (command === 'missing') {
  const have = code && fs.existsSync(path.join(localeDir, `${code}.json`)) ? read(`${code}.json`) : {};
  const out: Record<string, string> = {};
  for (const k of keys.keys()) if (!have[k]) out[k] = '';
  console.log(JSON.stringify(out, null, 2));
} else if (command === 'prune') {
  for (const file of locales) {
    const data = read(file);
    const kept = Object.fromEntries(Object.entries(data).filter(([k]) => keys.has(k)));
    fs.writeFileSync(path.join(localeDir, file), JSON.stringify(kept, null, 2) + '\n');
    console.log(`${file}: removed ${Object.keys(data).length - Object.keys(kept).length}`);
  }
} else {
  console.log(`${keys.size} texts`);
  for (const file of locales) {
    const data = read(file);
    const missing = [...keys.keys()].filter((k) => !data[k]).length;
    const stale = Object.keys(data).filter((k) => !keys.has(k)).length;
    console.log(`${file.padEnd(8)} missing ${missing}, stale ${stale}`);
  }
  if (raw.length) console.log(`\nText outside t():\n${raw.join('\n')}`);
}
