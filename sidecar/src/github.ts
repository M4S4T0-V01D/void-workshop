import { KeyFormatError, KeyStore, type KeyBackend, type SecretSpec } from './keystore.js';
import { git } from './git.js';
import { log } from './log.js';

/**
 * GitHub for the window's GitHub panel: "Sign in with GitHub" through the device flow of the user's own
 * OAuth App (or a pasted token), and a few read calls plus comments. The token stays in the keyring and
 * never reaches the window or the agent; the agent keeps using `gh` with the user's own login.
 */

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_WEB = 'https://github.com';
/** repo: private repositories, issues, PRs and comments; read:org: organization repos; workflow: Actions runs. */
export const GITHUB_SCOPES = 'repo read:org workflow';

export function validateGithubToken(raw: string): string {
  const t = raw.replace(/[\s\u200b-\u200d\u2060\ufeff]+/g, '').replace(/^(["'`])(.*)\1$/, '$2');
  if (!t) throw new KeyFormatError('The token is empty.');
  if (!/^(gh[pousr]_[A-Za-z0-9]{20,250}|github_pat_[A-Za-z0-9_]{20,250})$/.test(t))
    throw new KeyFormatError('That is not a GitHub token: they start with ghp_, gho_ or github_pat_.');
  return t;
}

export const GITHUB_SECRET: SecretSpec = { account: 'github-token', label: 'VOID Workshop: GitHub token', validate: validateGithubToken };

export class ServiceError extends Error {
  constructor(
    public readonly code: 'not-signed-in' | 'auth' | 'not-found' | 'rate-limited' | 'network' | 'api' | 'no-repo' | 'no-client-id',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface GithubStatus {
  configured: boolean;
  login: string | null;
  name: string | null;
  scopes: string[];
  fingerprint: string | null;
  backend: KeyBackend | null;
  problem: string | null;
  /** A device-flow sign-in is waiting for the user. */
  pending: DeviceCode | null;
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface GithubRepo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  htmlUrl: string;
  openIssues: number;
}

export type ListKind = 'pulls' | 'issues' | 'runs' | 'releases';

export interface ListEntry {
  id: number;
  number: number | null;
  title: string;
  state: string;
  author: string | null;
  updatedAt: string;
  htmlUrl: string;
  /** Short extra info: labels, branch, conclusion, tag. */
  detail: string | null;
  draft?: boolean;
}

export interface ItemComment {
  id: number;
  author: string | null;
  body: string;
  createdAt: string;
  /** Review comments on a diff line carry the file they are about. */
  path?: string | null;
}

export interface ItemFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface GithubItem {
  kind: 'pull' | 'issue';
  number: number;
  title: string;
  state: string;
  author: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  labels: string[];
  comments: ItemComment[];
  /** Pull requests only. */
  head?: string;
  base?: string;
  draft?: boolean;
  merged?: boolean;
  files?: ItemFile[];
}

const MAX_PATCH = 200_000;
const MAX_BODY = 100_000;
const clipText = (s: string | null | undefined, n: number) => {
  const t = s ?? '';
  return t.length > n ? `${t.slice(0, n)}\n\n… (cut off; open it on GitHub for the rest)` : t;
};

/** owner/name of a GitHub remote URL (https, ssh or scp-style), or null. */
export function parseGithubRemote(url: string): { owner: string; name: string } | null {
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

/** The GitHub repository a project pushes to: origin first, then any other GitHub remote. */
export async function projectGithubRemote(root: string): Promise<{ owner: string; name: string } | null> {
  const r = await git(root, ['remote', '-v'], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  const remotes = r.stdout
    .split('\n')
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 2 && p[2] !== '(push)')
    .map(([name, url]) => ({ name: name!, repo: parseGithubRemote(url!) }))
    .filter((x) => x.repo);
  return (remotes.find((x) => x.name === 'origin') ?? remotes[0])?.repo ?? null;
}

type Fetch = typeof fetch;

export class GithubService {
  readonly keys: KeyStore;
  private pending: (DeviceCode & { cancel: () => void }) | null = null;
  private identity: { fingerprint: string; login: string; name: string | null; scopes: string[] } | null = null;

  constructor(
    keyFile: string,
    private readonly onChange: (status: GithubStatus, error?: string) => void,
    private readonly fetchFn: Fetch = (...a) => fetch(...a),
    keyMode?: 'auto' | KeyBackend,
  ) {
    this.keys = new KeyStore(keyFile, keyMode, GITHUB_SECRET);
  }

  /** The stored token, or null; for update downloads from a private fork's releases. */
  async tokenOrNull(): Promise<string | null> {
    return (await this.keys.read())?.key ?? null;
  }

  private async token(): Promise<string> {
    const found = await this.keys.read();
    if (!found) throw new ServiceError('not-signed-in', 'Sign in with GitHub first (Settings → Accounts).');
    return found.key;
  }

  async status(): Promise<GithubStatus> {
    const k = await this.keys.status();
    const pending = this.pending ? { userCode: this.pending.userCode, verificationUri: this.pending.verificationUri, expiresAt: this.pending.expiresAt } : null;
    const base: GithubStatus = {
      configured: k.configured,
      login: null,
      name: null,
      scopes: [],
      fingerprint: k.fingerprint,
      backend: k.backend,
      problem: k.problem,
      pending,
    };
    if (!k.configured) return base;
    if (this.identity?.fingerprint === k.fingerprint) return { ...base, ...this.identity, fingerprint: k.fingerprint };
    try {
      const res = await this.request('GET', '/user');
      const user = (await res.json()) as { login: string; name: string | null };
      const scopes = (res.headers.get('x-oauth-scopes') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      this.identity = { fingerprint: k.fingerprint!, login: user.login, name: user.name, scopes };
      return { ...base, login: user.login, name: user.name, scopes };
    } catch (err) {
      return { ...base, problem: (err as Error).message };
    }
  }

  async setToken(raw: string): Promise<GithubStatus> {
    validateGithubToken(raw);
    await this.keys.store(raw, (await this.keys.secretServiceAvailable()) ? 'secret-service' : 'file');
    this.identity = null;
    const s = await this.status();
    if (s.problem) {
      await this.keys.remove();
      throw new ServiceError('auth', s.problem);
    }
    return s;
  }

  async logout(): Promise<GithubStatus> {
    this.cancelLogin();
    await this.keys.remove();
    this.identity = null;
    return this.status();
  }

  cancelLogin(): boolean {
    if (!this.pending) return false;
    this.pending.cancel();
    this.pending = null;
    return true;
  }

  /** Start the device flow: the user enters the code on github.com while this polls for the token. */
  async startLogin(clientId: string): Promise<DeviceCode> {
    if (!clientId) throw new ServiceError('no-client-id', 'Enter the client ID of your GitHub OAuth App first (Settings → Accounts → GitHub).');
    this.cancelLogin();
    const res = await this.post(`${GITHUB_WEB}/login/device/code`, { client_id: clientId, scope: GITHUB_SCOPES });
    const body = (await res.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.device_code || !body.user_code) {
      const why =
        body.error === 'device_flow_disabled'
          ? 'Device flow is off for this OAuth App: turn on "Enable Device Flow" in its settings on GitHub.'
          : body.error_description || body.error || `HTTP ${res.status}`;
      throw new ServiceError('api', `GitHub did not start the sign-in: ${why}`);
    }
    const verificationUri = body.verification_uri?.startsWith(`${GITHUB_WEB}/`) ? body.verification_uri : `${GITHUB_WEB}/login/device`;
    let cancelled = false;
    const code: DeviceCode = { userCode: body.user_code, verificationUri, expiresAt: Date.now() + (body.expires_in ?? 900) * 1000 };
    this.pending = { ...code, cancel: () => (cancelled = true) };
    const mine = this.pending;
    void this.poll(clientId, body.device_code, Math.max(5, body.interval ?? 5), code.expiresAt, () => cancelled).then(
      async (token) => {
        if (this.pending === mine) this.pending = null;
        if (!token) return this.onChange(await this.status(), cancelled ? undefined : 'The sign-in code expired. Start again.');
        try {
          this.onChange(await this.setToken(token));
        } catch (err) {
          this.onChange(await this.status(), (err as Error).message);
        }
      },
      async (err: Error) => {
        if (this.pending === mine) this.pending = null;
        log.warn('github sign-in failed', { error: err.message });
        this.onChange(await this.status(), err.message);
      },
    );
    return code;
  }

  private async poll(clientId: string, deviceCode: string, intervalSec: number, expiresAt: number, cancelled: () => boolean): Promise<string | null> {
    let wait = intervalSec;
    while (Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      if (cancelled()) return null;
      const res = await this.post(`${GITHUB_WEB}/login/oauth/access_token`, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      const b = (await res.json()) as { access_token?: string; error?: string; error_description?: string; interval?: number };
      if (b.access_token) return b.access_token;
      if (b.error === 'authorization_pending') continue;
      if (b.error === 'slow_down') {
        wait = Math.max(wait + 5, b.interval ?? 0);
        continue;
      }
      if (b.error === 'expired_token') return null;
      if (b.error === 'access_denied') throw new ServiceError('auth', 'The sign-in was cancelled on GitHub.');
      throw new ServiceError('api', `GitHub sign-in failed: ${b.error_description || b.error || `HTTP ${res.status}`}`);
    }
    return null;
  }

  private async post(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'void-workshop' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ServiceError('network', `Could not reach GitHub: ${(err as Error).message}`);
    }
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const token = await this.token();
    let res: Response;
    try {
      res = await this.fetchFn(`${GITHUB_API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'void-workshop',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ServiceError('network', `Could not reach GitHub: ${(err as Error).message}`);
    }
    if (res.ok) return res;
    if (res.status === 401) throw new ServiceError('auth', 'GitHub no longer accepts the token. Sign in again.');
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0')
      throw new ServiceError('rate-limited', 'GitHub rate limit reached; try again in a while.');
    if (res.status === 404) throw new ServiceError('not-found', 'Not found on GitHub (or the token cannot see it).');
    const msg = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
    throw new ServiceError('api', `GitHub: ${msg || `HTTP ${res.status}`}`);
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.request('GET', path)).json()) as T;
  }

  private async repoPath(root: string): Promise<string> {
    const r = await projectGithubRemote(root);
    if (!r) throw new ServiceError('no-repo', 'This project has no GitHub remote.');
    return `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
  }

  async repo(root: string): Promise<GithubRepo | null> {
    if (!(await projectGithubRemote(root))) return null;
    const r = await this.json<{
      owner: { login: string };
      name: string;
      full_name: string;
      private: boolean;
      default_branch: string;
      description: string | null;
      html_url: string;
      open_issues_count: number;
    }>(await this.repoPath(root));
    return {
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      description: r.description,
      htmlUrl: r.html_url,
      openIssues: r.open_issues_count,
    };
  }

  async list(root: string, kind: ListKind, state: 'open' | 'closed' | 'all'): Promise<ListEntry[]> {
    const base = await this.repoPath(root);
    type Gh = {
      id: number;
      number: number;
      title: string;
      state: string;
      user: { login: string } | null;
      updated_at: string;
      html_url: string;
      draft?: boolean;
      labels?: { name: string }[];
      pull_request?: unknown;
      head?: { ref: string };
    };
    if (kind === 'pulls' || kind === 'issues') {
      const items = await this.json<Gh[]>(`${base}/${kind}?state=${state}&per_page=50&sort=updated&direction=desc`);
      return items
        .filter((i) => kind === 'pulls' || !i.pull_request)
        .map((i) => ({
          id: i.id,
          number: i.number,
          title: i.title,
          state: i.state,
          author: i.user?.login ?? null,
          updatedAt: i.updated_at,
          htmlUrl: i.html_url,
          detail: kind === 'pulls' ? (i.head?.ref ?? null) : i.labels?.map((l) => l.name).join(', ') || null,
          draft: i.draft,
        }));
    }
    if (kind === 'runs') {
      const r = await this.json<{
        workflow_runs: {
          id: number;
          run_number: number;
          display_title: string;
          name: string;
          status: string;
          conclusion: string | null;
          actor: { login: string } | null;
          updated_at: string;
          html_url: string;
          head_branch: string;
        }[];
      }>(`${base}/actions/runs?per_page=30`);
      return r.workflow_runs.map((w) => ({
        id: w.id,
        number: w.run_number,
        title: w.display_title || w.name,
        state: w.conclusion ?? w.status,
        author: w.actor?.login ?? null,
        updatedAt: w.updated_at,
        htmlUrl: w.html_url,
        detail: `${w.name} · ${w.head_branch}`,
      }));
    }
    const rel = await this.json<
      {
        id: number;
        name: string | null;
        tag_name: string;
        draft: boolean;
        prerelease: boolean;
        author: { login: string } | null;
        published_at: string | null;
        created_at: string;
        html_url: string;
      }[]
    >(`${base}/releases?per_page=30`);
    return rel.map((r) => ({
      id: r.id,
      number: null,
      title: r.name || r.tag_name,
      state: r.draft ? 'draft' : r.prerelease ? 'prerelease' : 'published',
      author: r.author?.login ?? null,
      updatedAt: r.published_at ?? r.created_at,
      htmlUrl: r.html_url,
      detail: r.tag_name,
    }));
  }

  async item(root: string, number: number): Promise<GithubItem> {
    const base = await this.repoPath(root);
    type Comment = { id: number; user: { login: string } | null; body: string | null; created_at: string; path?: string };
    const issue = await this.json<{
      number: number;
      title: string;
      state: string;
      user: { login: string } | null;
      body: string | null;
      created_at: string;
      updated_at: string;
      html_url: string;
      labels: { name: string }[];
      pull_request?: unknown;
    }>(`${base}/issues/${number}`);
    const kindNow = issue.pull_request ? 'pull' : 'issue';
    const comments = await this.json<Comment[]>(`${base}/issues/${number}/comments?per_page=100`);
    const toComment = (c: Comment): ItemComment => ({
      id: c.id,
      author: c.user?.login ?? null,
      body: clipText(c.body, MAX_BODY),
      createdAt: c.created_at,
      path: c.path ?? null,
    });
    const item: GithubItem = {
      kind: kindNow,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login ?? null,
      body: clipText(issue.body, MAX_BODY),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      htmlUrl: issue.html_url,
      labels: issue.labels.map((l) => l.name),
      comments: comments.map(toComment),
    };
    if (kindNow === 'pull') {
      const [pr, files, reviews] = await Promise.all([
        this.json<{ head: { ref: string }; base: { ref: string }; draft: boolean; merged: boolean }>(`${base}/pulls/${number}`),
        this.json<{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]>(`${base}/pulls/${number}/files?per_page=100`),
        this.json<Comment[]>(`${base}/pulls/${number}/comments?per_page=100`),
      ]);
      item.kind = 'pull';
      item.head = pr.head.ref;
      item.base = pr.base.ref;
      item.draft = pr.draft;
      item.merged = pr.merged;
      item.files = files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ? clipText(f.patch, MAX_PATCH) : null,
      }));
      item.comments = [...item.comments, ...reviews.map(toComment)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return item;
  }

  async comment(root: string, number: number, body: string): Promise<ItemComment> {
    const base = await this.repoPath(root);
    const c = (await (await this.request('POST', `${base}/issues/${number}/comments`, { body })).json()) as {
      id: number;
      user: { login: string } | null;
      body: string;
      created_at: string;
    };
    return { id: c.id, author: c.user?.login ?? null, body: c.body, createdAt: c.created_at };
  }
}
