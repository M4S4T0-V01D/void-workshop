import { describe, expect, it } from 'vitest';
import { effectiveAuth } from './account';
import type { InitData } from './types';

const base = (over: Partial<InitData> = {}, settings: Partial<InitData['settings']> = {}): InitData =>
  ({
    settings: { anthropicAuth: 'subscription', authFallback: true, ...settings },
    auth: { configured: true, formatOk: true, backend: 'file', fingerprint: 'x', secretServiceAvailable: false, problem: null },
    subscription: { signedIn: true, email: 'a@b.c', subscriptionType: 'max', checkedAt: 1, problem: null },
    planLimited: null,
    billingBlocked: null,
    ...over,
  }) as InitData;

describe('effectiveAuth', () => {
  it('uses the chosen method when it works', () => {
    expect(effectiveAuth(base())).toEqual({ auth: 'subscription', switched: false, problem: null });
    expect(effectiveAuth(base({}, { anthropicAuth: 'api-key' })).auth).toBe('api-key');
  });

  it('falls back to the API key while the plan limit is active, and back once it resets', () => {
    const limited = base({ planLimited: { until: 2000, message: 'Plan limit' } });
    expect(effectiveAuth(limited, 1000)).toEqual({ auth: 'api-key', switched: true, problem: 'Plan limit' });
    expect(effectiveAuth(limited, 3000).auth).toBe('subscription');
  });

  it('falls back to the plan after a billing stop', () => {
    const r = effectiveAuth(base({ billingBlocked: { at: 1, message: 'no credit' } }, { anthropicAuth: 'api-key' }));
    expect(r).toMatchObject({ auth: 'subscription', switched: true });
  });

  it('does not switch when fallback is off or the other method is missing', () => {
    const limited = { planLimited: { until: Date.now() + 60_000, message: 'Plan limit' } };
    expect(effectiveAuth(base(limited, { authFallback: false })).auth).toBeNull();
    expect(effectiveAuth(base({ ...limited, auth: { ...base().auth, configured: false } })).auth).toBeNull();
    expect(effectiveAuth(base({ subscription: null }, { anthropicAuth: 'subscription', authFallback: false })).problem).toMatch(/Not signed in/);
  });
});
