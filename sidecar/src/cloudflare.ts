import { KeyFormatError, KeyStore, type KeyBackend, type SecretSpec } from './keystore.js';
import { ServiceError } from './github.js';

/**
 * Cloudflare for the window's Cloudflare panel: a pasted API token (Cloudflare has no sign-in flow for
 * third-party apps) and read calls for Workers, Pages, R2, D1 and KV. The token stays in the keyring and
 * never reaches the window or the agent; the agent keeps using `wrangler` with the user's own login.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** Where the user creates a token ("Read all resources" template is enough for the panel). */
export const CLOUDFLARE_TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';

export function validateCloudflareToken(raw: string): string {
  const t = raw
    .replace(/[\s\u200b-\u200d\u2060\ufeff]+/g, '')
    .replace(/^(?:export)?(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)[=:]/i, '')
    .replace(/^(["'`])(.*)\1$/, '$2');
  if (!t) throw new KeyFormatError('The token is empty.');
  if (/^[a-f0-9]{37}$/.test(t)) throw new KeyFormatError('That looks like the Global API Key. Create a scoped API token instead (My Profile → API Tokens).');
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(t)) throw new KeyFormatError('That is not a Cloudflare API token. Copy it again from My Profile → API Tokens.');
  return t;
}

export const CLOUDFLARE_SECRET: SecretSpec = {
  account: 'cloudflare-api-token',
  label: 'VOID Workshop: Cloudflare API token',
  validate: validateCloudflareToken,
};

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareStatus {
  configured: boolean;
  accounts: CloudflareAccount[];
  tokenStatus: string | null;
  expiresOn: string | null;
  fingerprint: string | null;
  backend: KeyBackend | null;
  problem: string | null;
}

/** One section of the panel; a token without that permission gets an error for it, not for the whole panel. */
export type Section<T> = { items: T[]; error: null } | { items: []; error: string };

export interface CfResource {
  id: string;
  name: string;
  /** Short extra info: last change, location, size, latest deployment. */
  detail: string | null;
  updatedAt: string | null;
  url: string | null;
}

export interface CloudflareResources {
  accountId: string;
  workers: Section<CfResource>;
  pages: Section<CfResource>;
  r2: Section<CfResource>;
  d1: Section<CfResource>;
  kv: Section<CfResource>;
}

export interface WorkerModule {
  name: string;
  contentType: string;
  content: string | null;
  size: number;
}

export interface WorkerDetail {
  accountId: string;
  name: string;
  modules: WorkerModule[];
  deployments: { id: string; createdOn: string; source: string | null; message: string | null; versions: string[] }[];
}

const MAX_MODULE = 1024 * 1024;
const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const dash = (accountId: string, rest: string) => `https://dash.cloudflare.com/${accountId}/${rest}`;

type Fetch = typeof fetch;
interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

export class CloudflareService {
  readonly keys: KeyStore;
  private cached: { fingerprint: string; status: CloudflareStatus } | null = null;

  constructor(
    keyFile: string,
    private readonly fetchFn: Fetch = (...a) => fetch(...a),
    keyMode?: 'auto' | KeyBackend,
  ) {
    this.keys = new KeyStore(keyFile, keyMode, CLOUDFLARE_SECRET);
  }

  async status(): Promise<CloudflareStatus> {
    const k = await this.keys.status();
    const base: CloudflareStatus = {
      configured: k.configured,
      accounts: [],
      tokenStatus: null,
      expiresOn: null,
      fingerprint: k.fingerprint,
      backend: k.backend,
      problem: k.problem,
    };
    if (!k.configured) return base;
    if (this.cached?.fingerprint === k.fingerprint) return this.cached.status;
    try {
      // Account-owned tokens fail /user/tokens/verify; listing accounts works for both kinds.
      const verify = await this.get<{ status: string; expires_on?: string }>('/user/tokens/verify').catch(() => null);
      const accounts = await this.get<{ id: string; name: string }[]>('/accounts?per_page=50');
      const status = {
        ...base,
        accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
        tokenStatus: verify?.status ?? 'active',
        expiresOn: verify?.expires_on ?? null,
      };
      this.cached = { fingerprint: k.fingerprint!, status };
      return status;
    } catch (err) {
      return { ...base, problem: (err as Error).message };
    }
  }

  async setToken(raw: string): Promise<CloudflareStatus> {
    validateCloudflareToken(raw);
    await this.keys.store(raw, (await this.keys.secretServiceAvailable()) ? 'secret-service' : 'file');
    this.cached = null;
    const s = await this.status();
    if (s.problem) {
      await this.keys.remove();
      throw new ServiceError('auth', s.problem);
    }
    return s;
  }

  async logout(): Promise<CloudflareStatus> {
    await this.keys.remove();
    this.cached = null;
    return this.status();
  }

  private async request(path: string): Promise<Response> {
    const found = await this.keys.read();
    if (!found) throw new ServiceError('not-signed-in', 'Add a Cloudflare API token first (Settings → Accounts).');
    let res: Response;
    try {
      res = await this.fetchFn(`${CLOUDFLARE_API}${path}`, {
        headers: { Authorization: `Bearer ${found.key}`, 'User-Agent': 'void-workshop' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ServiceError('network', `Could not reach Cloudflare: ${(err as Error).message}`);
    }
    if (res.ok) return res;
    const env = (await res.json().catch(() => null)) as Envelope<unknown> | null;
    const msg = env?.errors?.map((e) => e.message).join('; ');
    if (res.status === 401) throw new ServiceError('auth', `Cloudflare does not accept the token${msg ? ` (${msg})` : ''}.`);
    if (res.status === 403) throw new ServiceError('auth', `The token has no permission for this${msg ? ` (${msg})` : ''}.`);
    if (res.status === 404) throw new ServiceError('not-found', 'Not found on Cloudflare.');
    if (res.status === 429) throw new ServiceError('rate-limited', 'Cloudflare rate limit reached; try again in a while.');
    throw new ServiceError('api', `Cloudflare: ${msg || `HTTP ${res.status}`}`);
  }

  private async get<T>(path: string): Promise<T> {
    const env = (await (await this.request(path)).json()) as Envelope<T>;
    if (!env.success) throw new ServiceError('api', `Cloudflare: ${env.errors?.map((e) => e.message).join('; ') || 'request failed'}`);
    return env.result;
  }

  private async section<T>(load: () => Promise<T[]>, map: (x: T) => CfResource): Promise<Section<CfResource>> {
    try {
      return { items: (await load()).map(map), error: null };
    } catch (err) {
      return { items: [], error: (err as Error).message };
    }
  }

  async resources(accountId: string): Promise<CloudflareResources> {
    const a = `/accounts/${encodeURIComponent(accountId)}`;
    const [workers, pages, r2, d1, kv] = await Promise.all([
      this.section(
        () => this.get<{ id: string; modified_on: string; usage_model?: string }[]>(`${a}/workers/scripts`),
        (w) => ({ id: w.id, name: w.id, detail: null, updatedAt: w.modified_on, url: dash(accountId, `workers/services/view/${w.id}/production`) }),
      ),
      this.section(
        () =>
          this.get<
            {
              name: string;
              subdomain: string;
              production_branch?: string;
              latest_deployment?: { created_on: string; latest_stage?: { status: string } } | null;
            }[]
          >(`${a}/pages/projects`),
        (p) => ({
          id: p.name,
          name: p.name,
          detail: [p.subdomain, p.latest_deployment?.latest_stage?.status].filter(Boolean).join(' · ') || null,
          updatedAt: p.latest_deployment?.created_on ?? null,
          url: dash(accountId, `pages/view/${p.name}`),
        }),
      ),
      this.section(
        async () => (await this.get<{ buckets: { name: string; creation_date: string; location?: string }[] }>(`${a}/r2/buckets`)).buckets,
        (b) => ({ id: b.name, name: b.name, detail: b.location ?? null, updatedAt: b.creation_date, url: dash(accountId, `r2/default/buckets/${b.name}`) }),
      ),
      this.section(
        () => this.get<{ uuid: string; name: string; created_at: string; file_size?: number; num_tables?: number }[]>(`${a}/d1/database?per_page=100`),
        (d) => ({
          id: d.uuid,
          name: d.name,
          detail:
            [d.num_tables != null ? `${d.num_tables} tables` : null, d.file_size != null ? `${Math.round(d.file_size / 1024)} KB` : null]
              .filter(Boolean)
              .join(' · ') || null,
          updatedAt: d.created_at,
          url: dash(accountId, `workers/d1/databases/${d.uuid}`),
        }),
      ),
      this.section(
        () => this.get<{ id: string; title: string }[]>(`${a}/storage/kv/namespaces?per_page=100`),
        (n) => ({ id: n.id, name: n.title, detail: null, updatedAt: null, url: dash(accountId, `workers/kv/namespaces/${n.id}`) }),
      ),
    ]);
    return { accountId, workers, pages, r2, d1, kv };
  }

  /** A Worker's deployed modules (read-only) and its recent deployments. */
  async worker(accountId: string, name: string): Promise<WorkerDetail> {
    if (!NAME.test(name)) throw new ServiceError('not-found', 'Not a Worker name.');
    const a = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${name}`;
    const res = await this.request(a);
    const modules: WorkerModule[] = [];
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('multipart/form-data')) {
      const form = await res.formData();
      for (const [field, value] of form.entries()) {
        if (typeof value === 'string') {
          modules.push({ name: field, contentType: 'text/plain', content: value.slice(0, MAX_MODULE), size: value.length });
          continue;
        }
        const ct = value.type || 'application/octet-stream';
        const textual = /javascript|typescript|json|text|wasm-text|python/.test(ct) || /\.(m?js|cjs|ts|json|txt|py|map)$/.test(value.name || field);
        modules.push({
          name: value.name || field,
          contentType: ct,
          content: textual && value.size <= MAX_MODULE ? await value.text() : null,
          size: value.size,
        });
      }
    } else {
      const text = await res.text();
      modules.push({ name: 'worker.js', contentType: 'application/javascript', content: text.slice(0, MAX_MODULE), size: text.length });
    }
    const deps = await this.get<{
      deployments: {
        id: string;
        created_on: string;
        source?: string;
        annotations?: Record<string, string>;
        versions?: { version_id: string; percentage: number }[];
      }[];
    }>(`${a}/deployments`).catch(() => ({ deployments: [] }));
    return {
      accountId,
      name,
      modules,
      deployments: deps.deployments.slice(0, 20).map((d) => ({
        id: d.id,
        createdOn: d.created_on,
        source: d.source ?? null,
        message: d.annotations?.['workers/message'] ?? null,
        versions: (d.versions ?? []).map((v) => `${v.version_id.slice(0, 8)} (${v.percentage}%)`),
      })),
    };
  }
}
