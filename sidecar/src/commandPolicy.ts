import os from 'node:os';
import path from 'node:path';
import { isWithin, homeSecretPaths } from './paths.js';

/**
 * Policy for shell commands proposed by the model (or typed into the runner).
 *
 * Every command still needs explicit user approval; this module decides which commands are
 * refused outright and labels the rest so the approval dialog can say what a command does.
 * It is a guard rail, not a sandbox: the bubblewrap sandbox and the approval prompt are the
 * other layers.
 *
 * With full access (no sandbox, like Claude Code) only the hard refusals stay: disk destruction,
 * credential stores and secrets, VOID Workshop's own safeguards. The rest splits in two: routine
 * things (background jobs, other folders, git config and remotes, global installs, long or oddly
 * quoted commands) just run, noted in `warnings`; risky ones (force-push, history rewrites,
 * discarding work, deleting outside the project, uploads, sudo…) become `askReasons`, so they are
 * shown to the user even in Auto mode.
 */

export type CommandCategory =
  'read-only' | 'modifies-files' | 'installs-dependencies' | 'network' | 'git-state' | 'project-script' | 'process-control' | 'publishes' | 'unknown';

export interface CommandAssessment {
  command: string;
  blocked: boolean;
  /** Why the command is refused (empty unless blocked). */
  blockReasons: string[];
  /** Why the command must be shown to the user even in Auto mode (full access turns most refusals into these). */
  askReasons: string[];
  categories: CommandCategory[];
  /** Things the user should look at before approving. */
  warnings: string[];
  /** Parsed simple commands (argv per pipeline stage). */
  segments: string[][];
}

export interface PolicyContext {
  root: string;
  extraRoots?: string[];
  home?: string;
  /** gh, git push, wrangler and release.sh are approvable ('publishes') instead of blocked. */
  allowPublish?: boolean;
  /** Full access: commands run unsandboxed and only hard refusals block; risky ones ask, routine ones run (implies allowPublish). */
  fullAccess?: boolean;
  /** Admin dev session (implies fullAccess): Workshop's own logs and database, and its source's env variable names, are fair game. */
  admin?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer: splits a shell string into simple commands (argv) separated by control operators.
// It understands quotes, escapes, comments and redirections well enough to analyse commands;
// constructs it cannot follow (substitutions, heredocs) are reported so they get flagged.
// ---------------------------------------------------------------------------------------------

export interface ParsedShell {
  segments: string[][];
  operators: string[];
  redirects: Array<{ op: string; target: string }>;
  hasSubstitution: boolean;
  hasHeredoc: boolean;
  hasBackground: boolean;
  unterminatedQuote: boolean;
}

export function parseShell(input: string): ParsedShell {
  const segments: string[][] = [];
  const operators: string[] = [];
  const redirects: Array<{ op: string; target: string }> = [];
  let current: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let hasSubstitution = false;
  let hasHeredoc = false;
  let hasBackground = false;
  let pendingRedirect: string | null = null;

  const pushWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else {
      current.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = (op: string) => {
    pushWord();
    if (current.length) segments.push(current);
    current = [];
    operators.push(op);
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const next = input[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
        word += next;
        i++;
      } else {
        if (c === '`' || (c === '$' && next === '(')) hasSubstitution = true;
        word += c;
      }
      continue;
    }
    if (c === '\\' && next !== undefined) {
      if (next !== '\n') word += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < input.length && input[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === '`' || (c === '$' && (next === '(' || next === '{'))) {
      hasSubstitution = true;
      word += c;
      inWord = true;
      continue;
    }
    if (c === '<' && next === '(') {
      hasSubstitution = true;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      continue;
    }
    if (c === '\n' || c === ';') {
      endSegment(';');
      continue;
    }
    if (c === '&' && next === '&') {
      endSegment('&&');
      i++;
      continue;
    }
    if (c === '|' && next === '|') {
      endSegment('||');
      i++;
      continue;
    }
    if (c === '|') {
      endSegment(next === '&' ? '|&' : '|');
      if (next === '&') i++;
      continue;
    }
    if (c === '&' && next === '>') {
      pushWord();
      pendingRedirect = input[i + 2] === '>' ? '&>>' : '&>';
      i += input[i + 2] === '>' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      hasBackground = true;
      endSegment('&');
      continue;
    }
    if (c === '>' || c === '<') {
      // fd prefix like 2> : the digits are already in `word`
      let op = c;
      if (inWord && /^\d+$/.test(word)) {
        op = word + c;
        word = '';
        inWord = false;
      } else {
        pushWord();
      }
      if (next === c) {
        op += c;
        i++;
        if (c === '<') {
          hasHeredoc = true;
          if (input[i + 1] === '<') i++; // here-string <<<
        }
      }
      if (input[i + 1] === '&') {
        // 2>&1 style duplication: consume the fd number, not a file target
        op += '&';
        i++;
        let fd = '';
        while (i + 1 < input.length && /[\d-]/.test(input[i + 1]!)) fd += input[++i];
        redirects.push({ op, target: fd });
        continue;
      }
      if (input[i + 1] === '|') i++; // >|
      pendingRedirect = op;
      continue;
    }
    word += c;
    inWord = true;
  }
  pushWord();
  if (current.length) segments.push(current);
  return {
    segments,
    operators,
    redirects,
    hasSubstitution,
    hasHeredoc,
    hasBackground,
    unterminatedQuote: quote !== null,
  };
}

/** Split a runner command line into argv. Rejects anything that needs a shell. */
export function splitArgv(input: string): string[] {
  const parsed = parseShell(input);
  if (parsed.unterminatedQuote) throw new Error('Unterminated quote');
  if (parsed.segments.length !== 1 || parsed.operators.length || parsed.redirects.length || parsed.hasSubstitution) {
    throw new Error('Shell features (pipes, ;, &&, redirection, substitution) are not supported here. Enter a single command.');
  }
  const argv = parsed.segments[0]!;
  if (argv.some((a) => /[*?[\]{}~$]/.test(a))) {
    throw new Error('Globs, ~ and $variables are not expanded by the runner. Use literal arguments.');
  }
  return argv;
}

// ---------------------------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------------------------

const BLOCKED_PROGRAMS: Record<string, string> = {
  sudo: 'privilege escalation',
  su: 'privilege escalation',
  doas: 'privilege escalation',
  pkexec: 'privilege escalation',
  run0: 'privilege escalation',
  chroot: 'privilege escalation',
  setcap: 'privilege escalation',
  mkfs: 'filesystem destruction',
  fdisk: 'disk partitioning',
  sfdisk: 'disk partitioning',
  parted: 'disk partitioning',
  gdisk: 'disk partitioning',
  wipefs: 'filesystem destruction',
  shred: 'irreversible file destruction',
  mount: 'system modification',
  umount: 'system modification',
  modprobe: 'system modification',
  insmod: 'system modification',
  rmmod: 'system modification',
  systemctl: 'system service control',
  service: 'system service control',
  reboot: 'system power control',
  shutdown: 'system power control',
  poweroff: 'system power control',
  halt: 'system power control',
  pacman: 'system package manager',
  yay: 'system package manager',
  paru: 'system package manager',
  iptables: 'firewall modification',
  nft: 'firewall modification',
  ufw: 'firewall modification',
  crontab: 'persistence / scheduled execution',
  at: 'persistence / scheduled execution',
  useradd: 'account modification',
  usermod: 'account modification',
  userdel: 'account modification',
  passwd: 'account modification',
  chpasswd: 'account modification',
  chown: 'ownership change',
  ssh: 'remote shell / possible exfiltration',
  scp: 'remote copy / possible exfiltration',
  sftp: 'remote copy / possible exfiltration',
  ftp: 'remote copy / possible exfiltration',
  telnet: 'raw network connection',
  nc: 'raw network connection',
  ncat: 'raw network connection',
  netcat: 'raw network connection',
  socat: 'raw network connection',
  'secret-tool': 'credential store access',
  'kwallet-query': 'credential store access',
  kwalletcli: 'credential store access',
  busctl: 'D-Bus access (credential stores)',
  'dbus-send': 'D-Bus access (credential stores)',
  gdbus: 'D-Bus access (credential stores)',
  qdbus: 'D-Bus access (credential stores)',
  qdbus6: 'D-Bus access (credential stores)',
  keyctl: 'kernel keyring access',
  pass: 'password store access',
  gpg: 'key material access',
  gpg2: 'key material access',
  eval: 'dynamic code evaluation of a string',
  exec: 'replaces the shell process',
  nohup: 'detached process outlives the task',
  disown: 'detached process outlives the task',
  setsid: 'detached process outlives the task',
  screen: 'detached process outlives the task',
  tmux: 'detached process outlives the task',
  gh: 'GitHub CLI can publish or change remote state',
  claude: 'nested agent runtime',
};

/** Refused even with full access: disks, credential stores (the API key lives in one) and nested agents. */
const ALWAYS_BLOCKED = new Set([
  'mkfs',
  'fdisk',
  'sfdisk',
  'parted',
  'gdisk',
  'wipefs',
  'secret-tool',
  'kwallet-query',
  'kwalletcli',
  'busctl',
  'dbus-send',
  'gdbus',
  'qdbus',
  'qdbus6',
  'keyctl',
  'pass',
  'gpg',
  'gpg2',
  'claude',
]);

/** With full access these just run (noted in the warnings): ordinary in real work, not destructive. */
const ROUTINE_WITH_FULL_ACCESS = new Set(['nohup', 'disown', 'setsid', 'screen', 'tmux', 'exec']);
const ROUTINE_GIT_WITH_FULL_ACCESS = new Set(['config', 'worktree']);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'perl', 'ruby', 'node', 'deno', 'bun', 'php', 'lua']);

const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'find',
  'fd',
  'tree',
  'pwd',
  'echo',
  'printf',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'cmp',
  'jq',
  'yq',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'date',
  'uname',
  'whoami',
  'id',
  'true',
  'false',
  'test',
  '[',
  'sha256sum',
  'md5sum',
  'sha1sum',
  'nl',
  'column',
  'awk',
  'sed',
  'xxd',
  'hexdump',
  'od',
  'strings',
  'tac',
  'rev',
  'seq',
  'env',
  'printenv',
  'nproc',
  'free',
  'uptime',
  'ps',
  'lsof',
  'cd',
]);

const FILE_MODIFIERS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'mkdir',
  'touch',
  'chmod',
  'ln',
  'tee',
  'truncate',
  'patch',
  'install',
  'unzip',
  'tar',
  'rsync',
  'dd',
]);

const PROCESS_CONTROL = new Set(['kill', 'pkill', 'killall', 'renice', 'nice', 'timeout']);

const NETWORK_PROGRAMS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'aria2c', 'ping', 'dig', 'nslookup', 'host']);

const WRAPPERS = new Set(['command', 'builtin', 'time', 'nice', 'ionice', 'stdbuf', 'env', 'xargs', 'timeout', 'unbuffer']);

const PACKAGE_MANAGERS: Record<string, { install: Set<string>; publish: Set<string>; run: Set<string> }> = {
  npm: {
    install: new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'uninstall', 'remove', 'rm', 'link', 'dedupe', 'prune']),
    publish: new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'adduser', 'login', 'logout', 'token']),
    run: new Set(['run', 'run-script', 'test', 't', 'start', 'exec', 'x', 'build']),
  },
  pnpm: {
    install: new Set(['install', 'i', 'add', 'update', 'up', 'remove', 'rm', 'link', 'prune']),
    publish: new Set(['publish', 'login', 'logout']),
    run: new Set(['run', 'test', 't', 'start', 'exec', 'dlx', 'build']),
  },
  yarn: {
    install: new Set(['install', 'add', 'upgrade', 'remove', 'up', 'link']),
    publish: new Set(['publish', 'npm', 'login', 'logout']),
    run: new Set(['run', 'test', 'start', 'exec', 'dlx', 'build']),
  },
  bun: { install: new Set(['install', 'i', 'add', 'remove', 'update', 'link']), publish: new Set(['publish']), run: new Set(['run', 'test', 'x', 'build']) },
  cargo: {
    install: new Set(['add', 'install', 'update', 'remove', 'uninstall', 'fetch']),
    publish: new Set(['publish', 'yank', 'login', 'logout', 'owner']),
    run: new Set(['build', 'test', 'run', 'check', 'clippy', 'fmt', 'bench', 'doc', 'clean', 'nextest']),
  },
  pip: { install: new Set(['install', 'uninstall', 'download']), publish: new Set([]), run: new Set([]) },
  pip3: { install: new Set(['install', 'uninstall', 'download']), publish: new Set([]), run: new Set([]) },
  uv: { install: new Set(['add', 'remove', 'sync', 'lock', 'pip']), publish: new Set(['publish']), run: new Set(['run']) },
  poetry: { install: new Set(['add', 'remove', 'install', 'update', 'lock']), publish: new Set(['publish']), run: new Set(['run']) },
  go: { install: new Set(['get', 'install', 'mod']), publish: new Set([]), run: new Set(['build', 'test', 'run', 'vet', 'fmt', 'generate']) },
  gem: { install: new Set(['install', 'uninstall', 'update']), publish: new Set(['push', 'yank', 'owner', 'signin']), run: new Set([]) },
  bundle: { install: new Set(['install', 'update', 'add', 'remove']), publish: new Set([]), run: new Set(['exec']) },
  composer: { install: new Set(['install', 'require', 'update', 'remove']), publish: new Set([]), run: new Set(['run', 'run-script', 'test']) },
  dotnet: { install: new Set(['add', 'restore', 'tool']), publish: new Set(['nuget']), run: new Set(['build', 'test', 'run', 'format']) },
  twine: { install: new Set([]), publish: new Set(['upload', 'register']), run: new Set([]) },
};

const SCRIPT_RUNNERS = new Set([
  'make',
  'cmake',
  'ninja',
  'meson',
  'gradle',
  './gradlew',
  'mvn',
  'pytest',
  'tsc',
  'vite',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  'ruff',
  'black',
  'mypy',
  'npx',
  'pnpx',
  'bunx',
  'rustfmt',
  'clippy-driver',
  'just',
  'tox',
  'nox',
  'deno',
  'node',
  'python',
  'python3',
]);

// git subcommands
const GIT_READ_ONLY = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'describe',
  'shortlog',
  'grep',
  'cat-file',
  'whatchanged',
  'help',
  'version',
  'merge-base',
  'name-rev',
  'check-ignore',
  'count-objects',
]);
const GIT_NETWORK = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'submodule']);
const GIT_BLOCKED: Record<string, string> = {
  push: 'pushes to a remote (use your own terminal for pushes)',
  'filter-branch': 'rewrites history',
  'filter-repo': 'rewrites history',
  rebase: 'rewrites history',
  'update-ref': 'edits refs directly',
  replace: 'rewrites object references',
  reflog: 'can expire recovery history',
  gc: 'can prune recoverable objects',
  prune: 'deletes unreachable objects',
  'send-email': 'sends data over the network',
  'request-pull': 'publishes to a remote',
  credential: 'credential helper access',
  'credential-store': 'credential helper access',
  'credential-cache': 'credential helper access',
  daemon: 'serves the repository over the network',
  'http-backend': 'serves the repository over the network',
  worktree: 'can remove worktrees and their changes',
  config: 'can change hooks, credentials or safety settings',
};

function setsSpecialBits(mode: string): boolean {
  if (/^[0-7]{4,5}$/.test(mode)) return (Number(mode[mode.length - 4]) & 6) !== 0;
  return /^[ugoa]*[+=][rwxXt]*s/.test(mode) || /,[ugoa]*[+=][rwxXt]*s/.test(mode);
}

function isFlag(arg: string, ...flags: string[]): boolean {
  return flags.some((f) =>
    f.startsWith('--')
      ? arg === f || arg.startsWith(f + '=')
      : arg === f || (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(f.slice(1))),
  );
}

function gitSubcommand(argv: string[]): { sub: string; args: string[] } {
  let i = 1;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  return { sub: argv[i] ?? '', args: argv.slice(i + 1) };
}

/** Strip leading VAR=value assignments and wrapper programs to find the real program. */
function unwrap(argv: string[]): string[] {
  let args = argv.slice();
  for (let guard = 0; guard < 8 && args.length; guard++) {
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!)) args = args.slice(1);
    const prog = path.basename(args[0] ?? '');
    if (!WRAPPERS.has(prog)) break;
    args = args.slice(1);
    // skip wrapper options and numeric arguments (timeout 10, nice -n 5)
    while (args.length && (args[0]!.startsWith('-') || /^\d+[smhd]?$/.test(args[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!))) {
      const opt = args[0]!;
      args = args.slice(1);
      if ((opt === '-n' || opt === '-u' || opt === '-s' || opt === '-k' || opt === '-I' || opt === '-d') && args.length) args = args.slice(1);
    }
  }
  return args;
}

const AGENT_ENV_RE = /\bANTHROPIC_[A-Z_]*\b|\bCLAUDE_CODE_[A-Z_]*\b|\bCLAUDE_CONFIG_DIR\b|apiKeyHelper/;
const WORKSHOP_DATA_RE = /void-workshop\/(credentials|agent-runtime|workshop\.db)|\.config\/void-workshop|\.local\/share\/void-workshop/;
/**
 * What an admin dev session still refuses of the two above: Workshop's credentials, config and agent runtime folder.
 * The variable names themselves are fine there (the agent works on the code that sets them; the key never is one).
 */
const ADMIN_RAW_OVERRIDES = new Map<RegExp, RegExp | null>([
  [AGENT_ENV_RE, null],
  [WORKSHOP_DATA_RE, /void-workshop\/(credentials|agent-runtime)|\.config\/void-workshop/],
]);

// Raw-text patterns that are refused wherever they appear.
const RAW_BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, 'fork bomb'],
  [/\/dev\/(sd[a-z]|nvme\d|mmcblk\d|vd[a-z]|hd[a-z]|mapper\/)/, 'raw block device access'],
  [/\/proc\/[^\s/]+\/(environ|mem|maps|cmdline)\b/, 'reads another process\u2019s memory or environment'],
  [/\/etc\/(shadow|gshadow|sudoers)/, 'system credential file'],
  [AGENT_ENV_RE, 'touches the agent\u2019s credentials or safeguards'],
  [/\.claude\/settings|\.claude\.json|\.credentials\.json/, 'touches agent runtime settings or credentials'],
  [WORKSHOP_DATA_RE, 'touches VOID Workshop\u2019s own data or credentials'],
  [/\bkey-helper\.sh\b/, 'touches the API key helper'],
  [/\b(id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/, 'SSH private key'],
  [/(^|[\s"'=/])~?\/?\.(ssh|gnupg|aws|azure|kube|password-store|mozilla|netrc|git-credentials|docker\/config\.json)(\/|\b)/, 'credentials directory'],
  [/\.config\/(gh|gcloud|anthropic|google-chrome|chromium|BraveSoftware)\b/, 'application credentials or browser profile'],
  [/\.local\/share\/(keyrings|kwalletd)/, 'desktop keyring'],
  [/\bbase64\s+(-d|--decode)\b[^|]*\|\s*(sh|bash|zsh|python3?|perl|node)\b/, 'decodes and executes hidden code'],
];

/**
 * Commands that publish or change remote state. With `allowPublish` they always ask (even in Auto mode) and
 * run outside the sandbox, since they need the user's GitHub / Cloudflare logins. These patterns are the
 * sandbox exclusions; `publishCommand` only accepts commands written so that they match them.
 */
export const PUBLISH_SANDBOX_EXCLUSIONS = [
  'gh',
  'gh *',
  'git push',
  'git push *',
  'wrangler *',
  'npx wrangler *',
  'pnpx wrangler *',
  'bunx wrangler *',
  '*release.sh',
  '*release.sh *',
];

const GH_BLOCKED_TOPICS: Record<string, string> = {
  'ssh-key': 'manages account SSH keys',
  'gpg-key': 'manages account GPG keys',
  extension: 'installs GitHub CLI extensions (third-party code)',
  codespace: 'opens remote shells',
  alias: 'defines command aliases',
  config: 'changes GitHub CLI configuration',
};
const GH_BLOCKED_ACTIONS = new Set(['delete', 'delete-asset', 'archive', 'unarchive', 'rename', 'transfer']);
const WRANGLER_BLOCKED = new Set(['delete', 'login', 'logout']);

/** Null when argv is not a publishing command; otherwise why it is refused (empty string = approvable). */
function publishCommand(raw: string, args: string[]): string | null {
  const prog = path.basename(raw);
  if (prog === 'gh') {
    const [topic = '', action = ''] = args.filter((a) => !a.startsWith('-'));
    if (topic === 'auth')
      return action === 'status' && !args.some((a) => isFlag(a, '-t', '--show-token')) ? '' : 'gh auth can print or change your GitHub login';
    if (GH_BLOCKED_TOPICS[topic]) return `gh ${topic}: ${GH_BLOCKED_TOPICS[topic]}`;
    if (GH_BLOCKED_ACTIONS.has(action)) return `gh ${topic} ${action} deletes or moves things on GitHub (do it on github.com)`;
    if (topic === 'api') {
      const m = args.findIndex((a) => a === '-X' || a === '--method');
      if (m >= 0 && /^DELETE$/i.test(args[m + 1] ?? '')) return 'gh api DELETE request';
    }
    return '';
  }
  if (prog === 'git' && args[0] === 'push') {
    const pargs = args.slice(1);
    if (pargs.some((a) => isFlag(a, '-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '-d', '--delete', '--prune')))
      return 'git push: force, mirror, prune and delete pushes stay blocked';
    if (pargs.some((a) => a.startsWith('+') || a.startsWith(':') || /^[^-][^:]*:\+/.test(a))) return 'git push: force or delete refspec';
    return '';
  }
  const viaRunner = ['npx', 'pnpx', 'bunx'].includes(prog) && args[0] === 'wrangler';
  if (prog === 'wrangler' || viaRunner) {
    const wargs = viaRunner ? args.slice(1) : args;
    const bad = wargs.find((a) => WRANGLER_BLOCKED.has(a));
    return bad ? `wrangler ${bad}: deletes Cloudflare resources or changes the login` : '';
  }
  if (prog === 'release.sh' && raw.includes('/')) return '';
  return null;
}

export function assessCommand(command: string, ctx: PolicyContext): CommandAssessment {
  const home = ctx.home ?? os.homedir();
  const roots = [ctx.root, ...(ctx.extraRoots ?? [])];
  const blockReasons: string[] = [];
  const askReasons: string[] = [];
  const warnings: string[] = [];
  const categories = new Set<CommandCategory>();
  const admin = !!ctx.admin;
  const full = !!ctx.fullAccess || admin;
  // Hard refusals push to blockReasons directly. With full access, the risky ones ask instead (refuse) and the routine
  // ones (background jobs, other folders, git config, global installs…) just run, noted in the warnings (routine).
  const refuse = (why: string) => (full ? askReasons : blockReasons).push(why);
  const routine = (why: string) => (full ? warnings : blockReasons).push(why);
  const result = (): CommandAssessment => ({
    command,
    blocked: blockReasons.length > 0,
    blockReasons: [...new Set(blockReasons)],
    askReasons: [...new Set(askReasons)],
    categories: categories.size ? [...categories] : ['unknown'],
    // Shown first in the approval dialog (desktop and VOID Portal): why this one wasn't run automatically.
    warnings: [...new Set([...askReasons, ...warnings])],
    segments: parsed.segments,
  });

  const parsed = parseShell(command);
  if (typeof command !== 'string' || !command.trim()) {
    blockReasons.push('empty command');
    return result();
  }
  if (command.length > 8000) routine('command is too long to review safely');
  if (parsed.unterminatedQuote) routine('unterminated quote (the policy may have misread it)');
  for (const [re, why] of RAW_BLOCK_PATTERNS) {
    const pattern = admin && ADMIN_RAW_OVERRIDES.has(re) ? ADMIN_RAW_OVERRIDES.get(re) : re;
    if (pattern?.test(command)) blockReasons.push(why);
  }
  if (parsed.hasBackground) routine('runs a background process that would outlive the task');
  if (parsed.hasSubstitution) warnings.push('uses command substitution: the inner command runs too, review it carefully');
  if (parsed.hasHeredoc) warnings.push('uses a heredoc/here-string: inline content is passed to the command');

  const resolvePathArg = (arg: string): string | null => {
    if (!arg || arg.startsWith('-')) return null;
    if (/^[a-z]+:\/\//i.test(arg)) return null;
    let p = arg;
    if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
    else if (p.startsWith('$HOME')) p = path.join(home, p.slice(5));
    if (!path.isAbsolute(p)) {
      if (!p.includes('/') && !p.startsWith('.')) return null;
      p = path.resolve(ctx.root, p);
    }
    return path.normalize(p);
  };
  const outsideRoots = (p: string) => !roots.some((r) => isWithin(p, r));
  const isSafeSystemTarget = (p: string) => p === '/dev/null' || p === '/dev/stdout' || p === '/dev/stderr';

  for (const { op, target } of parsed.redirects) {
    if (op.includes('&') && /^\d*-?$/.test(target)) continue; // fd duplication
    if (op.startsWith('<') || op.endsWith('<')) {
      const p = resolvePathArg(target);
      if (p && outsideRoots(p) && !isSafeSystemTarget(p)) warnings.push(`reads ${target} from outside the project`);
      continue;
    }
    categories.add('modifies-files');
    const p = resolvePathArg(target.includes('/') || target.startsWith('~') ? target : `./${target}`);
    if (p && outsideRoots(p) && !isSafeSystemTarget(p)) routine(`writes to ${target}, outside the project`);
    if (target.includes('$')) warnings.push(`redirect target uses a variable (${target})`);
  }

  parsed.operators.forEach((op, idx) => {
    if (op === '|' || op === '|&') {
      const nextSeg = parsed.segments[idx + 1];
      const prog = nextSeg ? path.basename(unwrap(nextSeg)[0] ?? '') : '';
      if (INTERPRETERS.has(prog)) refuse(`pipes data into an interpreter (${prog})`);
    }
  });

  for (const seg of parsed.segments) {
    const argv = unwrap(seg);
    if (!argv.length) continue;
    const raw = argv[0]!;
    const prog = path.basename(raw);
    const args = argv.slice(1);

    if (raw.includes('$')) warnings.push(`program name comes from a variable (${raw})`);
    if (/^mkfs/.test(prog)) blockReasons.push('filesystem destruction');
    const publishRefusal = ctx.allowPublish || full ? publishCommand(raw, args) : null;
    if (publishRefusal !== null) {
      if (publishRefusal) {
        refuse(publishRefusal);
        if (!full) continue;
      }
      categories.add('publishes');
      categories.add('network');
      warnings.push(`publishes or changes remote state (GitHub, git remote or Cloudflare): runs ${full ? '' : 'outside the sandbox '}with your logins`);
      // Sandboxed, it runs through a sandbox exclusion, so it must be exactly the approved command (and match the exclusion).
      const extraRedirects = parsed.redirects.some(({ op, target }) => !(op.includes('&') && /^\d*-?$/.test(target)));
      if (!full && (parsed.segments.length !== 1 || extraRedirects || parsed.hasSubstitution || parsed.hasHeredoc || seg[0] !== raw)) {
        blockReasons.push(`run ${prog} on its own: no &&, ;, pipes, redirection, substitution, VAR= or wrapper prefixes`);
      }
      const script = prog === 'release.sh' ? resolvePathArg(raw) : null;
      if (script && outsideRoots(script)) refuse(`runs a release script outside the project (${raw})`);
      continue;
    }
    const blocked = BLOCKED_PROGRAMS[prog];
    if (blocked) {
      if (ALWAYS_BLOCKED.has(prog)) blockReasons.push(`${prog}: ${blocked}`);
      else if (ROUTINE_WITH_FULL_ACCESS.has(prog)) routine(`${prog}: ${blocked}`);
      else refuse(`${prog}: ${blocked}`);
      continue;
    }
    if (prog === 'cd') {
      const target = args.find((a) => !a.startsWith('-'));
      const p = target ? resolvePathArg(target.includes('/') || target.startsWith('~') ? target : `./${target}`) : home;
      if (!p || outsideRoots(p)) routine(`changes directory outside the project (${target ?? '~'})`);
      continue;
    }
    if (prog === 'source' || prog === '.') {
      warnings.push('sources a script into the shell');
      categories.add('project-script');
    }

    // Absolute/home paths outside the project used as arguments
    const pathArgs = args.map(resolvePathArg).filter((p): p is string => !!p);
    const outside = pathArgs.filter((p) => outsideRoots(p) && !isSafeSystemTarget(p));
    for (const p of pathArgs) {
      if (homeSecretPaths(home, admin).some((s) => isWithin(p, s))) blockReasons.push(`references a protected location (${p.replace(home, '~')})`);
    }

    if (SHELLS.has(prog) || (INTERPRETERS.has(prog) && args.some((a) => a === '-c' || a === '-e' || a === '--eval'))) {
      if (args.some((a) => a === '-c' || a === '-e' || a === '--eval')) {
        warnings.push(`runs inline ${prog} code: the policy cannot inspect it, read it carefully`);
      }
      categories.add('project-script');
      if (outside.length) warnings.push(`runs a script outside the project (${outside.join(', ')})`);
      continue;
    }

    if (prog === 'git') {
      const { sub, args: gargs } = gitSubcommand(argv);
      if (GIT_BLOCKED[sub]) {
        const why = sub === 'push' && ctx.allowPublish ? 'write it as a plain `git push ...` (no git options before push)' : GIT_BLOCKED[sub];
        if (ROUTINE_GIT_WITH_FULL_ACCESS.has(sub)) routine(`git ${sub}: ${why}`);
        else refuse(`git ${sub}: ${why}`);
        continue;
      }
      if (sub === 'reset' && gargs.some((a) => isFlag(a, '--hard', '--merge', '--keep'))) refuse('git reset --hard discards work');
      if (sub === 'clean') refuse('git clean deletes untracked files');
      if (sub === 'checkout' && (gargs.includes('--') || gargs.includes('.') || gargs.some((a) => isFlag(a, '-f', '--force'))))
        refuse('git checkout can discard uncommitted changes');
      if (sub === 'restore') refuse('git restore discards uncommitted changes');
      if (sub === 'switch' && gargs.some((a) => isFlag(a, '--discard-changes', '-f', '--force'))) refuse('discards uncommitted changes');
      if (sub === 'stash' && ['drop', 'clear'].includes(gargs[0] ?? '')) refuse('git stash drop/clear deletes saved work');
      if (sub === 'branch' && gargs.some((a) => isFlag(a, '-D', '--delete', '-d', '-M', '-m', '--force', '-f')))
        refuse('deletes, renames or force-moves branches');
      if (sub === 'tag' && gargs.some((a) => isFlag(a, '-d', '--delete', '-f', '--force'))) refuse('deletes or moves tags');
      if (sub === 'commit' && gargs.some((a) => a === '--amend' || a.startsWith('--fixup') || a.startsWith('--squash'))) refuse('rewrites an existing commit');
      if (sub === 'remote' && gargs.length && !['-v', 'show', 'get-url'].includes(gargs[0]!)) routine('changes remotes');
      if (sub === 'clone' && outside.length) routine('clones outside the project');
      if (GIT_READ_ONLY.has(sub) || (sub === 'branch' && gargs.every((a) => a.startsWith('-'))) || (sub === 'stash' && gargs[0] === 'list')) {
        categories.add('read-only');
      } else if (GIT_NETWORK.has(sub)) {
        categories.add('network');
        categories.add('git-state');
      } else {
        categories.add('git-state');
        if (sub === 'commit') warnings.push('creates a commit');
      }
      continue;
    }

    const pm = PACKAGE_MANAGERS[prog];
    if (pm) {
      const sub = args.find((a) => !a.startsWith('-')) ?? '';
      if (pm.publish.has(sub)) {
        refuse(`${prog} ${sub}: publishes or changes registry/account state`);
        continue;
      }
      if (
        args.some((a) => a === '-g' || a === '--global' || a === '--location=global' || a === '--user' || a === '--system' || a === '--break-system-packages')
      ) {
        routine('installs packages globally / outside the project');
        continue;
      }
      if ((prog === 'cargo' || prog === 'go') && sub === 'install') {
        routine(`${prog} install installs binaries outside the project`);
        continue;
      }
      if (pm.install.has(sub)) {
        categories.add('installs-dependencies');
        categories.add('network');
        categories.add('modifies-files');
        warnings.push('installs dependencies: package install scripts run with your user permissions');
      } else if (pm.run.has(sub) || sub === '') {
        categories.add('project-script');
        if (prog === 'cargo' && sub === 'clean') categories.add('modifies-files');
      } else {
        categories.add('project-script');
      }
      continue;
    }

    if (NETWORK_PROGRAMS.has(prog)) {
      categories.add('network');
      const uploads = args.some((a) =>
        isFlag(
          a,
          '-d',
          '--data',
          '--data-binary',
          '--data-raw',
          '--data-urlencode',
          '-F',
          '--form',
          '-T',
          '--upload-file',
          '--post-data',
          '--post-file',
          '--body-file',
          '--json',
        ),
      );
      const method = args.findIndex((a) => a === '-X' || a === '--request' || a === '--method');
      const writesOut = args.some((a) => isFlag(a, '-o', '--output', '-O', '--remote-name', '--output-document'));
      if (uploads || (method >= 0 && !/^(GET|HEAD)$/i.test(args[method + 1] ?? ''))) refuse(`${prog} sends data to a remote server (possible exfiltration)`);
      if (writesOut) categories.add('modifies-files');
      continue;
    }

    if (prog === 'rm' || prog === 'rmdir') {
      categories.add('modifies-files');
      const recursive = args.some((a) => isFlag(a, '-r', '-R', '--recursive'));
      const targets = args.filter((a) => !a.startsWith('-'));
      if (args.includes('--no-preserve-root')) blockReasons.push('rm --no-preserve-root');
      if (!targets.length) warnings.push('rm without a target');
      for (const t of targets) {
        const p = resolvePathArg(t.includes('/') || t.startsWith('~') || t.startsWith('$') ? t : `./${t}`);
        if (p && outsideRoots(p)) refuse(`deletes ${t}, outside the project`);
        if (p && (p === '/' || p === home)) blockReasons.push(`deletes ${t === '/' ? 'the whole filesystem' : 'your home directory'}`);
        if (recursive) {
          if (/[*?[\]{}$`~]/.test(t) || t === '.' || t === './' || t === '..' || (p && roots.includes(p))) {
            refuse(`unrestricted recursive deletion (${t})`);
          }
        }
      }
      if (recursive) warnings.push('recursive deletion: check every target');
      continue;
    }

    if (prog === 'find') {
      if (
        args.some(
          (a) => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir' || a === '-fprint' || a === '-fprintf' || a === '-fls',
        )
      ) {
        refuse('find with -delete/-exec runs or deletes on every match; use a reviewed command per file');
      } else categories.add('read-only');
      if (outside.length) warnings.push(`reads outside the project (${outside.join(', ')})`);
      continue;
    }

    if (prog === 'sed' && args.some((a) => isFlag(a, '-i', '--in-place'))) {
      categories.add('modifies-files');
    } else if (prog === 'chmod') {
      categories.add('modifies-files');
      if (args.some(setsSpecialBits)) blockReasons.push('sets setuid/setgid bits');
      if (args.some((a) => isFlag(a, '-R', '--recursive'))) warnings.push('recursive permission change');
    } else if (prog === 'dd') {
      categories.add('modifies-files');
      if (args.some((a) => a.startsWith('of=') && outsideRoots(resolvePathArg(a.slice(3)) ?? ctx.root))) refuse('dd writes outside the project');
    } else if (FILE_MODIFIERS.has(prog)) {
      categories.add('modifies-files');
    } else if (PROCESS_CONTROL.has(prog)) {
      categories.add('process-control');
      const targets = args.filter((a) => a !== '--');
      if (prog === 'kill' && targets.length > 1 && targets[targets.length - 1] === '-1') blockReasons.push('signals every process you own');
      if ((prog === 'pkill' || prog === 'killall') && args.some((a) => /^(node|void|tauri|claude|bwrap|socat|kwin|plasma|Xwayland)/i.test(a))) {
        blockReasons.push('would kill VOID Workshop or desktop processes');
      }
    } else if (READ_ONLY_PROGRAMS.has(prog)) {
      categories.add('read-only');
      if (prog === 'env' || prog === 'printenv') warnings.push('prints environment variables');
      if (prog === 'awk' && args.some((a) => /system\s*\(|>\s*"/.test(a))) {
        categories.add('modifies-files');
        warnings.push('awk program runs commands or writes files');
      }
    } else if (SCRIPT_RUNNERS.has(prog) || raw.startsWith('./') || raw.startsWith('../')) {
      categories.add('project-script');
      if (prog === 'npx' || prog === 'pnpx' || prog === 'bunx') {
        categories.add('network');
        warnings.push(`${prog} may download and run a package that is not in the project`);
      }
    } else {
      categories.add('unknown');
    }

    if (outside.length) {
      const verb = categories.has('modifies-files') ? 'touches' : 'reads';
      if (categories.has('modifies-files') && (FILE_MODIFIERS.has(prog) || prog === 'sed')) {
        // For cp/mv/ln/tee etc. the destination is usually last; any outside path is suspicious.
        refuse(`${prog} ${verb} paths outside the project (${outside.join(', ')})`);
      } else {
        warnings.push(`${verb} paths outside the project (${outside.join(', ')})`);
      }
    }
  }

  if (categories.size > 1) categories.delete('read-only');
  return result();
}
