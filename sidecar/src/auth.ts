import os from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import type { KeyStore } from './keystore.js';
import { validateApiKeyFormat } from './keystore.js';
import { OLLAMA_URL_RE, normalizeOllamaUrl, type Provider } from './settings.js';

export const API_BASE_URL = 'https://api.anthropic.com';

export interface ModelEntry {
  id: string;
  displayName: string;
  createdAt: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

export type VerifyOutcome =
  | { ok: true; models: ModelEntry[]; checkedAt: number }
  | {
      ok: false;
      kind: 'missing-key' | 'bad-format' | 'invalid-key' | 'permission' | 'rate-limited' | 'network' | 'billing' | 'api-error';
      message: string;
      checkedAt: number;
    };

/** Store flag holding the cached model list for each provider. */
export function modelsFlagKey(provider: Provider): string {
  return provider === 'ollama' ? 'models:ollama' : 'models';
}

/** Only tests may point the client at a local fake server. */
function baseUrl(): string {
  const override = process.env.VOID_WORKSHOP_TEST_API_BASE;
  if (override && process.env.VITEST) return override;
  return API_BASE_URL;
}

/**
 * Verify the stored key by listing models (a free, read-only endpoint) and return the models the
 * key's organization can use. This is the model discovery mechanism: no model ids are hardcoded.
 */
export async function verifyKeyAndListModels(keys: KeyStore): Promise<VerifyOutcome> {
  const checkedAt = Date.now();
  let found;
  try {
    found = await keys.read();
  } catch (err) {
    return { ok: false, kind: 'missing-key', message: (err as Error).message, checkedAt };
  }
  if (!found) return { ok: false, kind: 'missing-key', message: 'No API key is configured. Add one in Settings → API key.', checkedAt };
  try {
    validateApiKeyFormat(found.key);
  } catch (err) {
    return { ok: false, kind: 'bad-format', message: (err as Error).message, checkedAt };
  }
  // Explicit apiKey and baseURL: never fall back to ANTHROPIC_* environment variables or profiles.
  const client = new Anthropic({ apiKey: found.key, authToken: null, baseURL: baseUrl(), maxRetries: 0, timeout: 20_000 });
  try {
    const models: ModelEntry[] = [];
    for await (const m of client.models.list({ limit: 100 })) {
      const raw = m as unknown as { id: string; display_name?: string; created_at?: string; max_input_tokens?: number; max_tokens?: number };
      models.push({
        id: raw.id,
        displayName: raw.display_name ?? raw.id,
        createdAt: raw.created_at ?? null,
        maxInputTokens: raw.max_input_tokens ?? null,
        maxOutputTokens: raw.max_tokens ?? null,
      });
      if (models.length >= 200) break;
    }
    return { ok: true, models, checkedAt };
  } catch (err) {
    return { ok: false, ...classifyApiError(err), checkedAt };
  }
}

/**
 * List the models installed in the local Ollama server. No key is involved; the URL is
 * loopback-only (enforced by the settings schema and re-checked here).
 */
export async function listOllamaModels(ollamaUrl: string, fetchFn: typeof fetch = fetch): Promise<VerifyOutcome> {
  const checkedAt = Date.now();
  if (!OLLAMA_URL_RE.test(ollamaUrl)) {
    return { ok: false, kind: 'bad-format', message: 'Ollama must run on this machine (http://127.0.0.1:PORT).', checkedAt };
  }
  const base = normalizeOllamaUrl(ollamaUrl);
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    return { ok: false, kind: 'network', message: `Could not reach Ollama at ${base}. Start it with \`ollama serve\` (or its systemd service).`, checkedAt };
  }
  if (!res.ok) return { ok: false, kind: 'api-error', message: `Ollama answered ${res.status} for /api/tags.`, checkedAt };
  try {
    const body = (await res.json()) as { models?: { name?: string; model?: string; modified_at?: string; details?: { parameter_size?: string } }[] };
    const models: ModelEntry[] = [];
    for (const m of body.models ?? []) {
      const id = m.model ?? m.name;
      if (!id || id.length > 120) continue;
      const size = m.details?.parameter_size;
      models.push({
        id,
        displayName: size ? `${m.name ?? id} (${size})` : (m.name ?? id),
        createdAt: m.modified_at ?? null,
        maxInputTokens: null,
        maxOutputTokens: null,
      });
      if (models.length >= 200) break;
    }
    if (models.length === 0) {
      return { ok: false, kind: 'api-error', message: 'Ollama has no models installed. Pull one first, e.g. `ollama pull qwen3-coder`.', checkedAt };
    }
    return { ok: true, models, checkedAt };
  } catch {
    return { ok: false, kind: 'api-error', message: 'Ollama returned an unexpected model list.', checkedAt };
  }
}

export interface OllamaLoadedModel {
  name: string;
  /** Total memory the loaded model occupies (RAM + VRAM), in bytes. */
  sizeBytes: number;
  /** Part of sizeBytes held in GPU memory. */
  vramBytes: number;
  contextLength: number | null;
  expiresAt: string | null;
}

export interface OllamaStatus {
  reachable: boolean;
  models: OllamaLoadedModel[];
  /** Sum over loaded models. */
  totalBytes: number;
  vramBytes: number;
  system: { totalBytes: number; availableBytes: number };
  checkedAt: number;
}

/** What Ollama currently holds in memory (/api/ps), plus overall system RAM for context. */
export async function ollamaStatus(ollamaUrl: string, fetchFn: typeof fetch = fetch): Promise<OllamaStatus> {
  const system = { totalBytes: os.totalmem(), availableBytes: os.freemem() };
  const empty: OllamaStatus = { reachable: false, models: [], totalBytes: 0, vramBytes: 0, system, checkedAt: Date.now() };
  if (!OLLAMA_URL_RE.test(ollamaUrl)) return empty;
  try {
    const res = await fetchFn(`${normalizeOllamaUrl(ollamaUrl)}/api/ps`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return empty;
    const body = (await res.json()) as {
      models?: { name?: string; model?: string; size?: number; size_vram?: number; context_length?: number; expires_at?: string }[];
    };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const models = (body.models ?? []).slice(0, 20).map((m) => ({
      name: String(m.name ?? m.model ?? 'unknown').slice(0, 120),
      sizeBytes: num(m.size),
      vramBytes: num(m.size_vram),
      contextLength: num(m.context_length) || null,
      expiresAt: typeof m.expires_at === 'string' ? m.expires_at : null,
    }));
    return {
      reachable: true,
      models,
      totalBytes: models.reduce((a, m) => a + m.sizeBytes, 0),
      vramBytes: models.reduce((a, m) => a + m.vramBytes, 0),
      system,
      checkedAt: empty.checkedAt,
    };
  } catch {
    return empty;
  }
}

export function classifyApiError(err: unknown): {
  kind: Exclude<Extract<VerifyOutcome, { ok: false }>['kind'], 'missing-key' | 'bad-format'>;
  message: string;
} {
  // Personal keys created without a workspace cannot say which workspace a request acts in.
  if (err instanceof Anthropic.APIError && (err.status === 400 || err.status === 403) && /workspace/i.test(err.message || '')) {
    return {
      kind: 'permission',
      message: 'The key is not tied to a workspace. In the Console, create a new key and choose a workspace for it, then save that key here.',
    };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: 'invalid-key', message: 'The API rejected the key (401). It may be revoked, mistyped, or from a disabled workspace.' };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'permission', message: 'The key is not allowed to use this endpoint (403). Check the workspace permissions in the Console.' };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: 'rate-limited', message: 'Rate limited (429). Wait a moment and try again.' };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', message: 'Could not reach api.anthropic.com. Check your network connection.' };
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const body = (err.message || '').toLowerCase();
    if (status === 402 || /credit balance|billing|insufficient/.test(body)) {
      return {
        kind: 'billing',
        message: 'The organization has no usable credit. Check Billing in the Anthropic Console. VOID Workshop will not purchase credits.',
      };
    }
    return { kind: 'api-error', message: `API error ${status || ''}`.trim() };
  }
  return { kind: 'network', message: 'Request failed before reaching the API.' };
}
