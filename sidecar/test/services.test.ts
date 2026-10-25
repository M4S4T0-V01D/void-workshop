import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GithubService, parseGithubRemote, ServiceError, validateGithubToken } from '../src/github.js';
import { CloudflareService, validateCloudflareToken } from '../src/cloudflare.js';
import { tempDir, tempRepo } from './helpers.js';

const GH_TOKEN = 'ghp_' + 'a'.repeat(36);
const CF_TOKEN = 'cf' + 'B'.repeat(38);

type Route = (url: string, init?: RequestInit) => Response | undefined;
interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: string | null;
}

/** A fetch that answers from routes and records every call; unknown URLs get a 599 so tests fail loudly. */
function fakeFetch(...routes: Route[]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization'), body: typeof init?.body === 'string' ? init.body : null });
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    return new Response(`no route for ${url}`, { status: 599 });
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const on =
  (match: string | RegExp, res: () => Response): Route =>
  (url) =>
    (typeof match === 'string' ? url.endsWith(match) : match.test(url)) ? res() : undefined;
const cf = (result: unknown) => json({ success: true, errors: [], result });

const keyFile = (name: string) => path.join(tempDir('vw-svc-'), 'credentials', name);

function ghRepo(): string {
  const dir = tempRepo();
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo/hello.git'], { cwd: dir });
  return dir;
}

describe('token formats', () => {
  it('accepts GitHub tokens and rejects others', () => {
    expect(validateGithubToken(` "${GH_TOKEN}"\n`)).toBe(GH_TOKEN);
    expect(validateGithubToken('github_pat_' + 'x'.repeat(40))).toBe('github_pat_' + 'x'.repeat(40));
    expect(() => validateGithubToken('')).toThrow(/empty/);
    expect(() => validateGithubToken('sk-ant-api03-' + 'x'.repeat(40))).toThrow(/not a GitHub token/);
  });

  it('accepts Cloudflare API tokens and rejects the Global API Key', () => {
    expect(validateCloudflareToken(`CLOUDFLARE_API_TOKEN=${CF_TOKEN}`)).toBe(CF_TOKEN);
    expect(() => validateCloudflareToken('0123456789abcdef0123456789abcdef01234')).toThrow(/Global API Key/);
    expect(() => validateCloudflareToken('short')).toThrow(/not a Cloudflare API token/);
  });

  it('parses GitHub remotes', () => {
    expect(parseGithubRemote('git@github.com:octo/hello.git')).toEqual({ owner: 'octo', name: 'hello' });
    expect(parseGithubRemote('https://github.com/octo/hello')).toEqual({ owner: 'octo', name: 'hello' });
    expect(parseGithubRemote('ssh://git@github.com/octo/hello.js.git')).toEqual({ owner: 'octo', name: 'hello.js' });
    expect(parseGithubRemote('https://gitlab.com/octo/hello.git')).toBeNull();
    expect(parseGithubRemote('https://github.com.evil.example/octo/hello')).toBeNull();
  });
});

describe('GithubService', () => {
  const user = on('/user', () => json({ login: 'octocat', name: 'The Octocat' }, 200, { 'x-oauth-scopes': 'repo, workflow' }));

  it('stores a token, reads identity and scopes, and caches them', async () => {
    const f = fakeFetch(user);
    const file = keyFile('github-token');
    const gh = new GithubService(file, () => {}, f.fn, 'file');
    expect((await gh.status()).configured).toBe(false);
    const s = await gh.setToken(GH_TOKEN);
    expect(s).toMatchObject({ configured: true, login: 'octocat', name: 'The Octocat', scopes: ['repo', 'workflow'], backend: 'file', problem: null });
    expect(f.calls[0]).toMatchObject({ url: 'https://api.github.com/user', auth: `Bearer ${GH_TOKEN}` });
    await gh.status();
    expect(f.calls).toHaveLength(1);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect((await gh.logout()).configured).toBe(false);
  });

  it('removes a token GitHub rejects', async () => {
    const f = fakeFetch(on('/user', () => json({ message: 'Bad credentials' }, 401)));
    const gh = new GithubService(keyFile('github-token'), () => {}, f.fn, 'file');
    await expect(gh.setToken(GH_TOKEN)).rejects.toMatchObject({ code: 'auth' });
    expect((await gh.status()).configured).toBe(false);
  });

  it('needs a client ID and explains a disabled device flow', async () => {
    const f = fakeFetch(on('/login/device/code', () => json({ error: 'device_flow_disabled' }, 400)));
    const gh = new GithubService(keyFile('github-token'), () => {}, f.fn, 'file');
    await expect(gh.startLogin('')).rejects.toMatchObject({ code: 'no-client-id' });
    await expect(gh.startLogin('Ov23liTEST')).rejects.toThrow(/Enable Device Flow/);
    expect(f.calls[0]!.url).toBe('https://github.com/login/device/code');
    expect(f.calls[0]!.body).toContain('client_id=Ov23liTEST');
  });

  it('starts a device login, keeps the verification page on github.com, and cancels', async () => {
    const f = fakeFetch(
      on('/login/device/code', () =>
        json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://evil.example/login', expires_in: 900, interval: 5 }),
      ),
    );
    const changes: unknown[] = [];
    const gh = new GithubService(keyFile('github-token'), (s, e) => changes.push([s, e]), f.fn, 'file');
    const code = await gh.startLogin('Ov23liTEST');
    expect(code).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    expect((await gh.status()).pending?.userCode).toBe('ABCD-1234');
    expect(gh.cancelLogin()).toBe(true);
    expect((await gh.status()).pending).toBeNull();
  });

  it('maps HTTP errors', async () => {
    const f = fakeFetch(
      user,
      on(/\/repos\/octo\/hello\/pulls\?/, () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })),
      on(/\/repos\/octo\/hello\/issues\/7$/, () => json({ message: 'Not Found' }, 404)),
    );
    const gh = new GithubService(keyFile('github-token'), () => {}, f.fn, 'file');
    await gh.setToken(GH_TOKEN);
    const root = ghRepo();
    await expect(gh.list(root, 'pulls', 'open')).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(gh.item(root, 7)).rejects.toMatchObject({ code: 'not-found' });
    await expect(gh.list(tempRepo(), 'pulls', 'open')).rejects.toMatchObject({ code: 'no-repo' });
    expect(await gh.repo(tempRepo())).toBeNull();
  });

  it('lists issues without pull requests and posts comments', async () => {
    const issue = (n: number, extra: object = {}) => ({
      id: n * 10,
      number: n,
      title: `Issue ${n}`,
      state: 'open',
      user: { login: 'octocat' },
      updated_at: '2026-10-01T00:00:00Z',
      html_url: `https://github.com/octo/hello/issues/${n}`,
      labels: [{ name: 'bug' }],
      ...extra,
    });
    const f = fakeFetch(
      user,
      on(/\/issues\?state=open/, () => json([issue(1), issue(2, { pull_request: {} })])),
      on(/\/issues\/1\/comments$/, () => json({ id: 99, user: { login: 'octocat' }, body: 'hi', created_at: '2026-10-02T00:00:00Z' }, 201)),
    );
    const gh = new GithubService(keyFile('github-token'), () => {}, f.fn, 'file');
    await gh.setToken(GH_TOKEN);
    const root = ghRepo();
    const list = await gh.list(root, 'issues', 'open');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 1, title: 'Issue 1', author: 'octocat', detail: 'bug' });
    const c = await gh.comment(root, 1, 'hi');
    expect(c).toMatchObject({ id: 99, author: 'octocat', body: 'hi' });
    const post = f.calls.find((x) => x.method === 'POST')!;
    expect(post.url).toBe('https://api.github.com/repos/octo/hello/issues/1/comments');
    expect(JSON.parse(post.body!)).toEqual({ body: 'hi' });
  });

  it('refuses to work without a token', async () => {
    const gh = new GithubService(keyFile('github-token'), () => {}, fakeFetch().fn, 'file');
    await expect(gh.list(ghRepo(), 'pulls', 'open')).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('CloudflareService', () => {
  const accounts = on('/accounts?per_page=50', () => cf([{ id: 'acc1', name: 'Me' }]));

  it('stores a token and lists accounts even when verify fails', async () => {
    const f = fakeFetch(
      on('/user/tokens/verify', () => json({ success: false, errors: [{ code: 1000, message: 'nope' }] }, 401)),
      accounts,
    );
    const c = new CloudflareService(keyFile('cloudflare-api-token'), f.fn, 'file');
    const s = await c.setToken(CF_TOKEN);
    expect(s).toMatchObject({ configured: true, accounts: [{ id: 'acc1', name: 'Me' }], tokenStatus: 'active', backend: 'file', problem: null });
    expect(f.calls.every((x) => x.auth === `Bearer ${CF_TOKEN}`)).toBe(true);
  });

  it('removes a token Cloudflare rejects', async () => {
    const f = fakeFetch(on(/\/accounts/, () => json({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }, 401)));
    const c = new CloudflareService(keyFile('cloudflare-api-token'), f.fn, 'file');
    await expect(c.setToken(CF_TOKEN)).rejects.toThrow(/Invalid access token/);
    expect((await c.status()).configured).toBe(false);
  });

  it('keeps sections independent when the token lacks a permission', async () => {
    const f = fakeFetch(
      on('/user/tokens/verify', () => cf({ status: 'active' })),
      accounts,
      on('/workers/scripts', () => cf([{ id: 'api', modified_on: '2026-10-01T00:00:00Z' }])),
      on('/pages/projects', () => json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403)),
      on('/r2/buckets', () => cf({ buckets: [{ name: 'assets', creation_date: '2026-01-01T00:00:00Z', location: 'WEUR' }] })),
      on('/d1/database?per_page=100', () => cf([{ uuid: 'u1', name: 'db', created_at: '2026-01-01T00:00:00Z', num_tables: 3 }])),
      on('/storage/kv/namespaces?per_page=100', () => cf([{ id: 'k1', title: 'CACHE' }])),
    );
    const c = new CloudflareService(keyFile('cloudflare-api-token'), f.fn, 'file');
    await c.setToken(CF_TOKEN);
    const r = await c.resources('acc1');
    expect(r.workers.items[0]).toMatchObject({ name: 'api', url: 'https://dash.cloudflare.com/acc1/workers/services/view/api/production' });
    expect(r.pages).toEqual({ items: [], error: expect.stringMatching(/no permission/) });
    expect(r.r2.items[0]).toMatchObject({ name: 'assets', detail: 'WEUR' });
    expect(r.d1.items[0]).toMatchObject({ name: 'db', detail: '3 tables' });
    expect(r.kv.items[0]).toMatchObject({ id: 'k1', name: 'CACHE' });
  });

  it('reads a multipart Worker script and its deployments', async () => {
    const form = new FormData();
    form.append('index.js', new Blob(['export default { fetch() { return new Response("hi"); } };'], { type: 'application/javascript+module' }), 'index.js');
    form.append('logo.png', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'logo.png');
    const f = fakeFetch(
      on('/user/tokens/verify', () => cf({ status: 'active' })),
      accounts,
      on('/workers/scripts/api', () => new Response(form)),
      on('/workers/scripts/api/deployments', () =>
        cf({
          deployments: [
            {
              id: 'd1',
              created_on: '2026-10-01T00:00:00Z',
              source: 'wrangler',
              annotations: { 'workers/message': 'ship it' },
              versions: [{ version_id: 'abcdef1234567890', percentage: 100 }],
            },
          ],
        }),
      ),
    );
    const c = new CloudflareService(keyFile('cloudflare-api-token'), f.fn, 'file');
    await c.setToken(CF_TOKEN);
    const w = await c.worker('acc1', 'api');
    expect(w.modules).toHaveLength(2);
    expect(w.modules[0]).toMatchObject({ name: 'index.js', content: expect.stringContaining('fetch()') });
    expect(w.modules[1]).toMatchObject({ name: 'logo.png', contentType: 'image/png', content: null, size: 4 });
    expect(w.deployments[0]).toMatchObject({ id: 'd1', source: 'wrangler', message: 'ship it', versions: ['abcdef12 (100%)'] });
    await expect(c.worker('acc1', '../secrets')).rejects.toMatchObject({ code: 'not-found' });
  });
});
