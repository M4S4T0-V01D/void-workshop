import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/** Directory names that hold credentials or browser/password data. Never part of a project root. */
const SENSITIVE_DIR_NAMES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  '.mozilla',
  'kwalletd',
  'keyrings',
  '.pki',
  'google-chrome',
  'chromium',
  'BraveSoftware',
  'gcloud',
]);

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|dist$|defaults$).+$/i,
  /^.*\.env$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|age)$/i,
  /^credentials(\.json|\.ya?ml|\.toml)?$/i,
  /^\.credentials\.json$/i,
  /^(\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.htpasswd|\.pgpass|\.my\.cnf)$/i,
  /^secrets?(\.[a-z0-9]+)+$/i,
  /^service[-_]?account.*\.json$/i,
  /^.*\.tfstate(\.backup)?$/i,
  /^known_hosts$/i,
  /^authorized_keys$/i,
];

/** Paths (relative to $HOME) that are always off limits, even inside an approved root. */
const HOME_SECRET_PATHS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  '.mozilla',
  '.netrc',
  '.git-credentials',
  '.claude',
  '.claude.json',
  '.config/anthropic',
  '.config/gcloud',
  '.config/gh',
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/void-workshop',
  '.local/share/keyrings',
  '.local/share/kwalletd',
  '.local/share/void-workshop',
];

const FORBIDDEN_ROOTS = [
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/usr',
  '/var',
  '/tmp',
  '/home',
];

/**
 * In an admin dev session Workshop's own data (logs, database, images) opens up for debugging; the agent
 * runtime folder (Claude plan sign-in) and the config folder (keys, pairings, the admin password) stay closed.
 */
const ADMIN_OPEN = '.local/share/void-workshop';
const ADMIN_STILL_SECRET = '.local/share/void-workshop/agent-runtime';

export function homeSecretPaths(home = os.homedir(), admin = false): string[] {
  const list = admin ? HOME_SECRET_PATHS.map((p) => (p === ADMIN_OPEN ? ADMIN_STILL_SECRET : p)) : HOME_SECRET_PATHS;
  return list.map((p) => path.join(home, p));
}

/** Returns a reason string when the path looks like a secret, otherwise null. Purely lexical. */
export function sensitiveReason(p: string, home = os.homedir(), admin = false): string | null {
  const norm = path.resolve(p);
  for (const secret of homeSecretPaths(home, admin)) {
    if (norm === secret || norm.startsWith(secret + path.sep)) return `protected location (${secret.replace(home, '~')})`;
  }
  const parts = norm.split(path.sep).filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    if (SENSITIVE_DIR_NAMES.has(part)) return `inside a credentials directory (${part})`;
  }
  const base = parts[parts.length - 1] ?? '';
  if (SENSITIVE_DIR_NAMES.has(base)) return `credentials directory (${base})`;
  for (const re of SENSITIVE_FILE_PATTERNS) if (re.test(base)) return `sensitive file name (${base})`;
  return null;
}

/** Real path of `p`, resolving symlinks in every existing component; missing tail components are appended lexically. */
export function realpathLoose(p: string): { real: string; exists: boolean } {
  if (p.includes('\0')) throw new PathError('Path contains a NUL byte');
  const abs = path.resolve(p);
  let existing = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      return { real: tail.length ? path.join(real, ...tail.reverse()) : real, exists: tail.length === 0 };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new PathError(`Cannot resolve ${abs}: ${code}`);
      const parent = path.dirname(existing);
      if (parent === existing) throw new PathError(`Cannot resolve ${abs}`);
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Validate a directory the user picked as a project root and return its canonical path. */
export function canonicalProjectRoot(input: string, home = os.homedir()): string {
  if (!input || typeof input !== 'string') throw new PathError('No project directory given');
  if (!path.isAbsolute(input)) throw new PathError('Project path must be absolute');
  const { real, exists } = realpathLoose(input);
  if (!exists) throw new PathError(`Project directory does not exist: ${input}`);
  if (!fs.statSync(real).isDirectory()) throw new PathError('Project path is not a directory');
  if (FORBIDDEN_ROOTS.includes(real)) throw new PathError(`Refusing to use system directory ${real} as a project`);
  const realHome = realpathLoose(home).real;
  if (real === realHome) throw new PathError('Refusing to use your entire home directory as a project. Pick a project folder.');
  if (isWithin(realHome, real)) throw new PathError('Project directory must not contain your home directory');
  const reason = sensitiveReason(real, realHome);
  if (reason) throw new PathError(`Refusing to open a protected location as a project: ${reason}`);
  return real;
}

export type PathOp = 'read' | 'write';

export interface PathDecision {
  allowed: boolean;
  /** Canonical absolute path (symlinks resolved). */
  real: string;
  exists: boolean;
  /** Present when the target is sensitive: allowed only with explicit approval. */
  sensitive: string | null;
  /** Outside every project root: only allowed with full access, and writes there always ask. */
  outside?: boolean;
  reason?: string;
}

/**
 * Path policy for one project session: the project root plus explicitly approved extra roots.
 * All checks run on canonical paths so `..`, symlinks and duplicate separators cannot escape.
 * With [fullAccess] paths outside the roots are allowed too (marked `outside`); protected
 * locations stay off limits either way ([admin] opens Workshop's own data folder only).
 */
export class PathPolicy {
  readonly root: string;
  readonly extraRoots: string[];
  private readonly home: string;

  constructor(
    root: string,
    extraRoots: string[] = [],
    home = os.homedir(),
    readonly fullAccess = false,
    /** Admin dev session: Workshop's own data folder is reachable (see homeSecretPaths). */
    readonly admin = false,
  ) {
    this.home = realpathLoose(home).real;
    this.root = canonicalProjectRoot(root, this.home);
    this.extraRoots = extraRoots.map((r) => canonicalProjectRoot(r, this.home));
  }

  get roots(): string[] {
    return [this.root, ...this.extraRoots];
  }

  /** Resolve a path the agent or UI supplied (absolute, or relative to the project root). */
  check(input: string, op: PathOp): PathDecision {
    if (typeof input !== 'string' || input.length === 0) {
      return { allowed: false, real: '', exists: false, sensitive: null, reason: 'Empty path' };
    }
    if (input.length > 4096) return { allowed: false, real: '', exists: false, sensitive: null, reason: 'Path too long' };
    let expanded = input;
    if (expanded === '~' || expanded.startsWith('~/')) expanded = path.join(this.home, expanded.slice(1));
    const abs = path.isAbsolute(expanded) ? expanded : path.join(this.root, expanded);
    let resolved: { real: string; exists: boolean };
    try {
      resolved = realpathLoose(abs);
    } catch (err) {
      return { allowed: false, real: abs, exists: false, sensitive: null, reason: (err as Error).message };
    }
    const { real, exists } = resolved;
    const within = this.roots.some((r) => isWithin(real, r));
    if (!within && !this.fullAccess) {
      return { allowed: false, real, exists, sensitive: null, reason: `Outside the selected project (${real})` };
    }
    const outside = !within;
    // Lexical check on the requested path as well as the canonical one: a symlink named `.env` pointing
    // at a harmless file is still treated as sensitive, and vice versa.
    const sensitive = sensitiveReason(real, this.home, this.admin) ?? sensitiveReason(abs, this.home, this.admin);
    if (sensitive && homeSecretPaths(this.home, this.admin).some((s) => isWithin(real, s))) {
      return { allowed: false, real, exists, sensitive, reason: `Protected location: ${sensitive}` };
    }
    if (op === 'write' && exists) {
      try {
        const st = fs.lstatSync(real);
        if (st.isFile() && st.nlink > 1) {
          return { allowed: true, real, exists, outside, sensitive: sensitive ?? 'file has multiple hard links (may alias a file outside the project)' };
        }
        if (st.isDirectory()) return { allowed: false, real, exists, sensitive, reason: 'Target is a directory' };
      } catch {
        /* treat as ordinary */
      }
    }
    return { allowed: true, real, exists, outside, sensitive };
  }

  /** Project-relative display path. */
  rel(real: string): string {
    for (const r of this.roots) {
      if (isWithin(real, r)) {
        const rel = path.relative(r, real) || '.';
        return r === this.root ? rel : `${path.basename(r)}:${rel}`;
      }
    }
    return real;
  }
}
