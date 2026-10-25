import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyKeyAndListModels } from '../src/auth.js';
import { KeyStore } from '../src/keystore.js';
import { FAKE_KEY, testPaths, writeKeyFile } from './helpers.js';

let server: http.Server | null = null;

async function fakeApi(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  delete process.env.VOID_WORKSHOP_TEST_API_BASE;
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

function keys(withKey = true) {
  const paths = testPaths();
  if (withKey) writeKeyFile(paths);
  return new KeyStore(paths.keyFile, 'file');
}

describe('key verification and model discovery', () => {
  it('reports a missing key without any network request', async () => {
    let hits = 0;
    process.env.VOID_WORKSHOP_TEST_API_BASE = await fakeApi((_q, s) => {
      hits++;
      s.end('{}');
    });
    const res = await verifyKeyAndListModels(keys(false));
    expect(res).toMatchObject({ ok: false, kind: 'missing-key' });
    expect(hits).toBe(0);
  });

  it('sends the key only as x-api-key and lists models', async () => {
    let seen: http.IncomingHttpHeaders = {};
    process.env.VOID_WORKSHOP_TEST_API_BASE = await fakeApi((req, res) => {
      seen = req.headers;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            { type: 'model', id: 'claude-test-1', display_name: 'Claude Test', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 1000, max_tokens: 100 },
          ],
          has_more: false,
          first_id: 'claude-test-1',
          last_id: 'claude-test-1',
        }),
      );
    });
    const res = await verifyKeyAndListModels(keys());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.models[0]).toMatchObject({ id: 'claude-test-1', displayName: 'Claude Test', maxOutputTokens: 100 });
    expect(seen['x-api-key']).toBe(FAKE_KEY);
    expect(seen.authorization).toBeUndefined();
  });

  it.each([
    [401, 'invalid-key'],
    [403, 'permission'],
    [429, 'rate-limited'],
    [500, 'api-error'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    process.env.VOID_WORKSHOP_TEST_API_BASE = await fakeApi((_q, res) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'error', error: { type: 'x', message: 'nope' } }));
    });
    const res = await verifyKeyAndListModels(keys());
    expect(res).toMatchObject({ ok: false, kind });
  });

  it('recognises an exhausted credit balance', async () => {
    process.env.VOID_WORKSHOP_TEST_API_BASE = await fakeApi((_q, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }),
      );
    });
    const res = await verifyKeyAndListModels(keys());
    expect(res).toMatchObject({ ok: false, kind: 'billing' });
  });

  it('explains a personal key that has no workspace', async () => {
    process.env.VOID_WORKSHOP_TEST_API_BASE = await fakeApi((_q, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-workspace-id header is required for this key.' } }));
    });
    const res = await verifyKeyAndListModels(keys());
    expect(res).toMatchObject({ ok: false, kind: 'permission', message: expect.stringMatching(/choose a workspace/) });
  });

  it('reports network failures', async () => {
    process.env.VOID_WORKSHOP_TEST_API_BASE = 'http://127.0.0.1:9';
    const res = await verifyKeyAndListModels(keys());
    expect(res).toMatchObject({ ok: false, kind: 'network' });
  });

  it('never echoes the key in error messages', async () => {
    process.env.VOID_WORKSHOP_TEST_API_BASE = await fakeApi((_q, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${FAKE_KEY}` } }));
    });
    const res = await verifyKeyAndListModels(keys());
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY);
  });
});
