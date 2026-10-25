import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UPDATE_PRODUCT, Updater, compareVersions, verifyRelease, type Release } from '../src/updater.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');

function signed(fields: Partial<Release>, key = privateKey) {
  const body = Buffer.from(JSON.stringify({ product: UPDATE_PRODUCT, version: '9.0.0', sha256: 'a'.repeat(64), size: 10, notes: 'n', date: 'd', ...fields }));
  return { manifest: body.toString('base64'), signature: sign(null, body, key).toString('base64') };
}

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-upd-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A package like scripts/release.sh makes. */
function makePackage(version: string, marker = version): Buffer {
  const tree = tmp();
  for (const f of ['scripts/install.sh', 'src-tauri/target/release/void-workshop', 'sidecar/dist/main.js', 'sidecar/package-lock.json']) {
    fs.mkdirSync(path.dirname(path.join(tree, f)), { recursive: true });
    fs.writeFileSync(path.join(tree, f), 'x');
  }
  fs.writeFileSync(path.join(tree, 'RELEASE'), `${marker}\n`);
  const out = path.join(tmp(), 'p.tar.gz');
  execFileSync('tar', ['-C', tree, '-czf', out, '.']);
  return fs.readFileSync(out);
}

function server(latest: unknown, pkg: Buffer | null) {
  const seen: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push(`${url} ${(init?.headers as Record<string, string>)['x-void-channel']}`);
    if (url.endsWith('/latest.json')) return new Response(JSON.stringify(latest), { status: 200 });
    return pkg ? new Response(new Uint8Array(pkg), { status: 200 }) : new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

const source = () => ({ baseUrl: 'https://relay.test', headers: { 'x-void-channel': 'c'.repeat(32), authorization: 'Bearer t' } });

describe('desktop updates', () => {
  it('compares x.y.z versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBe(-1);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow();
  });

  it('accepts only manifests signed by the pinned key', () => {
    expect(verifyRelease(signed({}), PUB).version).toBe('9.0.0');
    expect(() => verifyRelease(signed({}, other.privateKey), PUB)).toThrow(/signature/);
    expect(() => verifyRelease(signed({}), null)).toThrow(/no update key/);
    // Changing one byte of the signed body breaks it.
    const doc = signed({});
    const body = Buffer.from(doc.manifest, 'base64').toString().replace('9.0.0', '9.0.1');
    expect(() => verifyRelease({ ...doc, manifest: Buffer.from(body).toString('base64') }, PUB)).toThrow(/signature/);
    expect(() => verifyRelease(signed({ product: 'void-portal' }), PUB)).toThrow(/another product/);
    expect(() => verifyRelease(signed({ sha256: 'xyz' }), PUB)).toThrow(/SHA-256/);
    expect(() => verifyRelease({ manifest: 1 }, PUB)).toThrow(/malformed/);
  });

  it('offers only newer versions', async () => {
    const mk = (v: string) => new Updater({ current: '0.2.0', publicKey: PUB, dir: tmp(), source, fetch: server(signed({ version: v }), null).fetchFn });
    expect((await mk('0.3.0').check()).status).toBe('available');
    expect((await mk('0.2.0').check()).status).toBe('current');
    expect((await mk('0.1.9').check()).status).toBe('current');
    const unpaired = new Updater({ current: '0.2.0', publicKey: PUB, dir: tmp(), source: () => null });
    expect(await unpaired.check()).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/pair a phone/) });
  });

  it('downloads, checks and unpacks a signed package', async () => {
    const pkg = makePackage('0.3.0');
    const sha = createHash('sha256').update(pkg).digest('hex');
    const { fetchFn, seen } = server(signed({ version: '0.3.0', sha256: sha, size: pkg.length }), pkg);
    const dir = tmp();
    const u = new Updater({ current: '0.2.0', publicKey: PUB, dir, source, fetch: fetchFn });
    const { release, dir: tree } = await u.prepare();
    expect(release.version).toBe('0.3.0');
    expect(fs.existsSync(path.join(tree, 'scripts/install.sh'))).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(seen[1]).toBe(`https://relay.test/v1/update/desktop/0.3.0.tar.gz ${'c'.repeat(32)}`);
  });

  it('refuses a package whose hash, size or marker does not match the signed manifest', async () => {
    const pkg = makePackage('0.3.0');
    const sha = createHash('sha256').update(pkg).digest('hex');
    const run = (fields: Partial<Release>, body = pkg) =>
      new Updater({ current: '0.2.0', publicKey: PUB, dir: tmp(), source, fetch: server(signed({ version: '0.3.0', ...fields }), body).fetchFn }).prepare();
    await expect(run({ sha256: 'b'.repeat(64), size: pkg.length })).rejects.toThrow(/SHA-256/);
    await expect(run({ sha256: sha, size: pkg.length - 1 })).rejects.toThrow(/larger/);
    await expect(run({ sha256: sha, size: pkg.length + 1 })).rejects.toThrow(/shorter/);
    const wrong = makePackage('0.3.0', '0.2.5');
    await expect(run({ sha256: createHash('sha256').update(wrong).digest('hex'), size: wrong.length }, wrong)).rejects.toThrow(/not the release/);
  });
});
