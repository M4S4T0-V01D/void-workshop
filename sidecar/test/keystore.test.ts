import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { KeyFormatError, KeyStore, keyFingerprint, validateApiKeyFormat } from '../src/keystore.js';
import { FAKE_KEY, testPaths } from './helpers.js';

describe('API key format', () => {
  it('accepts Console API keys', () => {
    expect(validateApiKeyFormat(`  ${FAKE_KEY}\n`)).toBe(FAKE_KEY);
  });

  it('rejects subscription OAuth tokens, admin keys and junk', () => {
    expect(() => validateApiKeyFormat('sk-ant-oat01-' + 'x'.repeat(60))).toThrow(/subscription OAuth/);
    expect(() => validateApiKeyFormat('sk-ant-admin01-' + 'x'.repeat(60))).toThrow(/Admin/);
    expect(() => validateApiKeyFormat('sk-ant-sid01-' + 'x'.repeat(60))).toThrow(/session cookie/);
    expect(() => validateApiKeyFormat('hello')).toThrow(KeyFormatError);
    expect(() => validateApiKeyFormat('')).toThrow();
  });

  it('repairs copy/paste damage', () => {
    const half = FAKE_KEY.length >> 1;
    expect(validateApiKeyFormat(`\u200b${FAKE_KEY}\u00a0`)).toBe(FAKE_KEY);
    expect(validateApiKeyFormat(`"${FAKE_KEY}"`)).toBe(FAKE_KEY);
    expect(validateApiKeyFormat(`export ANTHROPIC_API_KEY=${FAKE_KEY}`)).toBe(FAKE_KEY);
    expect(validateApiKeyFormat(`x-api-key: ${FAKE_KEY}`)).toBe(FAKE_KEY);
    expect(validateApiKeyFormat(`${FAKE_KEY.slice(0, half)}\n${FAKE_KEY.slice(half)}`)).toBe(FAKE_KEY);
  });

  it('accepts other Console key generations', () => {
    const k = 'sk-ant-api04-' + 'Q'.repeat(90) + '-AbCdEfAA';
    expect(validateApiKeyFormat(k)).toBe(k);
  });

  it('accepts personal (identity-backed) Console keys', () => {
    const k = 'sk-ant-usr-1v-' + 'Q'.repeat(88) + '-AbCdEfAA';
    expect(validateApiKeyFormat(k)).toBe(k);
  });

  it('says what is wrong instead of a generic rejection', () => {
    expect(() => validateApiKeyFormat('sk-or-v1-' + 'a'.repeat(64))).toThrow(/OpenRouter/);
    expect(() => validateApiKeyFormat('sk-proj-' + 'a'.repeat(64))).toThrow(/OpenAI/);
    expect(() => validateApiKeyFormat('sk-ant-api03-abc')).toThrow(/cut off/);
    expect(() => validateApiKeyFormat(FAKE_KEY + '…')).toThrow(/characters/);
  });

  it('fingerprints without revealing the key', () => {
    const fp = keyFingerprint(FAKE_KEY);
    expect(fp).toHaveLength(10);
    expect(FAKE_KEY).not.toContain(fp);
  });
});

describe('file backend (headless)', () => {
  it('reports a missing key', async () => {
    const paths = testPaths();
    const ks = new KeyStore(paths.keyFile, 'file');
    expect(await ks.status()).toMatchObject({ configured: false, backend: null });
    expect(await ks.read()).toBeNull();
  });

  it('stores with 0600 permissions in a 0700 directory and never returns the key in status', async () => {
    const paths = testPaths();
    const ks = new KeyStore(paths.keyFile, 'file');
    const status = await ks.store(FAKE_KEY, 'file');
    expect(status).toMatchObject({ configured: true, backend: 'file', formatOk: true });
    expect(JSON.stringify(status)).not.toContain(FAKE_KEY.slice(14, 40));
    expect(fs.statSync(paths.keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(paths.keyFile)).mode & 0o777).toBe(0o700);
    expect((await ks.read())?.key).toBe(FAKE_KEY);
    await ks.remove();
    expect(fs.existsSync(paths.keyFile)).toBe(false);
  });

  it('refuses a key file readable by others', async () => {
    const paths = testPaths();
    fs.mkdirSync(path.dirname(paths.keyFile), { recursive: true });
    fs.writeFileSync(paths.keyFile, FAKE_KEY, { mode: 0o644 });
    fs.chmodSync(paths.keyFile, 0o644);
    const ks = new KeyStore(paths.keyFile, 'file');
    await expect(ks.read()).rejects.toThrow(/600/);
    expect((await ks.status()).configured).toBe(false);
  });

  it('refuses to store a non-Console key', async () => {
    const ks = new KeyStore(testPaths().keyFile, 'file');
    await expect(ks.store('sk-ant-oat01-' + 'x'.repeat(60), 'file')).rejects.toThrow(/OAuth/);
  });
});

describe('apiKeyHelper script', () => {
  const run = (env: Record<string, string>) =>
    spawnSync('sh', [testPaths().keyHelper], { env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', ...env }, encoding: 'utf8' });

  it('prints only the key from the file backend', () => {
    const paths = testPaths();
    fs.mkdirSync(path.dirname(paths.keyFile), { recursive: true });
    fs.writeFileSync(paths.keyFile, FAKE_KEY, { mode: 0o600 });
    const r = run({ VOID_WORKSHOP_KEY_BACKEND: 'file', VOID_WORKSHOP_KEY_FILE: paths.keyFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(FAKE_KEY);
    expect(r.stderr).toBe('');
  });

  it('fails without printing anything when no key exists', () => {
    const paths = testPaths();
    const r = run({ VOID_WORKSHOP_KEY_BACKEND: 'file', VOID_WORKSHOP_KEY_FILE: paths.keyFile });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('refuses world-readable key files', () => {
    const paths = testPaths();
    fs.mkdirSync(path.dirname(paths.keyFile), { recursive: true });
    fs.writeFileSync(paths.keyFile, FAKE_KEY);
    fs.chmodSync(paths.keyFile, 0o644);
    const r = run({ VOID_WORKSHOP_KEY_BACKEND: 'file', VOID_WORKSHOP_KEY_FILE: paths.keyFile });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('is executable', () => {
    expect(() => execFileSync('test', ['-x', testPaths().keyHelper])).not.toThrow();
  });
});
