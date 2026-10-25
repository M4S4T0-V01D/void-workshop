import ts from 'typescript';

/** A text to translate: the English key, and for tn() keys the English singular too. */
export interface Key {
  key: string;
  one?: string;
  where: string;
}

/** Code is never translated; neither is JSX text that is only a name, a unit or a label quoted from an English page. */
const CODE_TAGS = new Set(['code', 'kbd', 'pre', 'samp']);
const RAW_OK = new Set([
  'VOID Workshop',
  'VOID Portal',
  'GitHub',
  'Cloudflare',
  'Claude',
  'Ollama',
  'px',
  'KB',
  'MB',
  'Paste this into Claude Code',
  'Enable Device Flow',
  'Client ID',
  'Read all resources',
]);

/**
 * Finds the interface texts in the window's sources: the literal first argument of t(), tx() and msg(), and the
 * plural (third) argument of tn(). Also reports JSX text left outside t(), which would never be translated.
 */
export function extractKeys(files: Record<string, string>): { keys: Map<string, Key>; raw: string[] } {
  const keys = new Map<string, Key>();
  const raw: string[] = [];
  for (const [file, src] of Object.entries(files)) {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = (node: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const literal = (node: ts.Node | undefined) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (name === 't' || name === 'tx' || name === 'msg') {
          const key = literal(node.arguments[0]);
          if (key !== null && !keys.has(key)) keys.set(key, { key, where: where(node) });
        } else if (name === 'tn') {
          const one = literal(node.arguments[1]);
          const key = literal(node.arguments[2]);
          if (key !== null) keys.set(key, { key, one: one ?? undefined, where: where(node) });
        }
      } else if (ts.isJsxText(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim();
        const tag = ts.isJsxElement(node.parent) ? node.parent.openingElement.tagName.getText() : '';
        if (/[A-Za-z]{2,}/.test(text) && !RAW_OK.has(text) && !CODE_TAGS.has(tag)) raw.push(`${where(node)} ${JSON.stringify(text)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { keys, raw };
}

/** The {placeholders} of a text, sorted. */
export const placeholders = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
