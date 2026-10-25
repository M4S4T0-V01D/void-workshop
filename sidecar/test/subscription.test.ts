import { describe, expect, it } from 'vitest';
import { bundledClaudeExecutable, isLoginUrl, subscriptionModels } from '../src/subscription.js';

describe('subscription helpers', () => {
  it('accepts only Claude OAuth sign-in links', () => {
    expect(isLoginUrl('https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y')).toBe(true);
    expect(isLoginUrl('https://claude.ai/oauth/authorize?code=true')).toBe(true);
    for (const bad of [
      'http://claude.com/cai/oauth/authorize?x',
      'https://claude.com.evil.example/oauth/authorize?x',
      'https://evil.example/claude.com/oauth/authorize?x',
      'https://claude.com/settings',
      'https://claude.com/oauth/authorize?a b',
      'javascript:alert(1)//https://claude.com/oauth/authorize?',
    ])
      expect(isLoginUrl(bad), bad).toBe(false);
  });

  it('turns the runtime model list into model ids without duplicates', () => {
    const out = subscriptionModels([
      { value: 'default', resolvedModel: 'claude-a', displayName: 'Default (recommended)', description: '' },
      { value: 'a', resolvedModel: 'claude-a', displayName: 'A', description: '' },
      { value: 'claude-b', displayName: 'B', description: '' },
      { value: '', displayName: 'empty', description: '' },
    ]);
    expect(out.map((m) => [m.id, m.displayName])).toEqual([
      ['claude-a', 'Default (recommended)'],
      ['claude-b', 'B'],
    ]);
  });

  it('finds the runtime binary shipped with the Agent SDK', () => {
    expect(bundledClaudeExecutable()).toMatch(/claude-agent-sdk-linux-[a-z0-9-]+\/claude$/);
  });
});
