import type { AnthropicAuth, InitData } from './types';

export const AUTH_NAME: Record<AnthropicAuth, string> = { 'api-key': 'API key', subscription: 'Claude plan' };

const other = (a: AnthropicAuth): AnthropicAuth => (a === 'api-key' ? 'subscription' : 'api-key');

/** Why an Anthropic auth method cannot be used right now (mirrors the sidecar's check), or null. */
export function authProblem(init: InitData, auth: AnthropicAuth, now = Date.now()): string | null {
  if (auth === 'subscription') {
    if (!init.subscription?.signedIn) return 'Not signed in to a Claude plan.';
    if (init.planLimited && init.planLimited.until > now) return init.planLimited.message;
    return null;
  }
  if (!init.auth.configured) return 'No API key configured.';
  if (!init.auth.formatOk) return init.auth.problem ?? 'The stored API key is not valid.';
  if (init.billingBlocked) return 'API requests are stopped after a billing error.';
  return null;
}

/**
 * The Anthropic auth the next request would use: the chosen one, or the other when the chosen one is
 * unavailable and fallback is on. `auth` is null when neither works; `problem` explains the chosen one.
 */
export function effectiveAuth(init: InitData, now = Date.now()): { auth: AnthropicAuth | null; switched: boolean; problem: string | null } {
  const chosen = init.settings.anthropicAuth;
  const problem = authProblem(init, chosen, now);
  if (!problem) return { auth: chosen, switched: false, problem: null };
  if (init.settings.authFallback && !authProblem(init, other(chosen), now)) return { auth: other(chosen), switched: true, problem };
  return { auth: null, switched: false, problem };
}
