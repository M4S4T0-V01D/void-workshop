import { describe, expect, it } from 'vitest';
import { clip, redactText, redactValue } from '../src/redact.js';

describe('secret redaction', () => {
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ_-xyz';

  it('removes Anthropic API keys, OAuth tokens and admin keys', () => {
    expect(redactText(`key is ${key} ok`)).toBe('key is sk-ant-[REDACTED] ok');
    expect(redactText('sk-ant-oat01-ZZZZZZZZZZZZZZZZZZZZZZZZ')).not.toContain('ZZZZ');
    expect(redactText('sk-ant-admin01-ZZZZZZZZZZZZZZZZZZZZZZZZ')).not.toContain('ZZZZ');
  });

  it('removes auth headers and key=value secrets', () => {
    expect(redactText('x-api-key: abc123secret')).toBe('x-api-key: [REDACTED]');
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactText('API_KEY="hunter2hunter2"')).not.toContain('hunter2');
    expect(redactText('password=correcthorse')).not.toContain('correcthorse');
  });

  it('removes common third-party tokens and private keys', () => {
    expect(redactText('ghp_' + 'a'.repeat(36))).toBe('[REDACTED_GITHUB_TOKEN]');
    expect(redactText('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED_AWS_KEY]');
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactText(`x ${pem} y`)).toBe('x [REDACTED_PRIVATE_KEY] y');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Run npm test in src/; tokens used: 1200 input, 300 output.';
    expect(redactText(text)).toBe(text);
  });

  it('deep-redacts objects and secret-named fields', () => {
    const out = redactValue({ apiKey: 'plain', nested: { list: [`token ${key}`] }, tokens: 5, model: 'm' });
    expect(out.apiKey).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('abcdefghijklmnop');
    expect(out.tokens).toBe(5);
    expect(out.model).toBe('m');
  });

  it('clips long text keeping head and tail', () => {
    const long = 'a'.repeat(100) + 'MIDDLE' + 'b'.repeat(100);
    const c = clip(long, 50);
    expect(c.startsWith('a')).toBe(true);
    expect(c.endsWith('b')).toBe(true);
    expect(c).toContain('omitted');
  });
});
