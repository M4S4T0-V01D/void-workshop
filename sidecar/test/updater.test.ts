import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UPDATE_PRODUCT, Updater, compareVersions, githubSource, relaySource, verifyRelease, type Release } from '../src/updater.js';

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

const source = () => relaySource('https://relay.test', { 'x-void-channel': 'c'.repeat(32), authorization: 'Bearer t' });

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
    expect(await unpaired.check()).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/update repository.*pair a phone/) });
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

  describe('GitHub releases source', () => {
    const API = 'https://api.github.com/repos/octo/fork';
    /** A fake api.github.com with a releases list and asset downloads. */
    function github(releases: unknown[], files: Record<string, Buffer | string>) {
      const seen: { url: string; headers: Record<string, string> }[] = [];
      const fetchFn = (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ url, headers });
        if (url === `${API}/releases?per_page=30`) return new Response(JSON.stringify(releases), { status: 200 });
        const id = /\/releases\/assets\/(\w+)$/.exec(url)?.[1];
        const body = id ? files[id] : undefined;
        if (body === undefined || headers.Accept !== 'application/octet-stream') return new Response('no', { status: 404 });
        return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 });
      }) as unknown as typeof fetch;
      return { fetchFn, seen };
    }
    const rel = (tag: string, extra: object = {}) => ({
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [
        { name: 'latest.json', url: `${API}/releases/assets/${tag.replace(/\W/g, '_')}_m`, size: 1 },
        { name: `void-workshop-${tag.replace('workshop-v', '')}.tar.gz`, url: `${API}/releases/assets/${tag.replace(/\W/g, '_')}_p`, size: 1 },
      ],
      ...extra,
    });

    it('installs the newest workshop release, skipping drafts, prereleases and Portal tags', async () => {
      const pkg = makePackage('0.3.0');
      const sha = createHash('sha256').update(pkg).digest('hex');
      const { fetchFn, seen } = github(
        [
          rel('workshop-v0.9.0', { draft: true }),
          rel('workshop-v0.8.0', { prerelease: true }),
          rel('portal-v2.0.0'),
          rel('workshop-v0.3.0'),
          rel('workshop-v0.2.0'),
        ],
        { workshop_v0_3_0_m: JSON.stringify(signed({ version: '0.3.0', sha256: sha, size: pkg.length })), workshop_v0_3_0_p: pkg },
      );
      const u = new Updater({ current: '0.2.0', publicKey: PUB, dir: tmp(), source: () => githubSource('octo/fork', async () => null), fetch: fetchFn });
      expect(await u.check()).toMatchObject({ status: 'available', source: 'github.com/octo/fork', release: { version: '0.3.0' } });
      const { dir: tree } = await u.prepare();
      expect(fs.existsSync(path.join(tree, 'RELEASE'))).toBe(true);
      // Not signed in: no Authorization header anywhere.
      expect(seen.every((s) => !s.headers.Authorization)).toBe(true);
    });

    it('still requires the pinned signature', async () => {
      const { fetchFn } = github([rel('workshop-v0.3.0')], { workshop_v0_3_0_m: JSON.stringify(signed({ version: '0.3.0' }, other.privateKey)) });
      const u = new Updater({ current: '0.2.0', publicKey: PUB, dir: tmp(), source: () => githubSource('octo/fork', async () => null), fetch: fetchFn });
      await expect(u.check()).rejects.toThrow(/signature/);
    });

    it('sends the GitHub token for private forks and reports missing releases', async () => {
      const { fetchFn, seen } = github([rel('portal-v1.0.0')], {});
      const u = new Updater({ current: '0.2.0', publicKey: PUB, dir: tmp(), source: () => githubSource('octo/fork', async () => 'ghp_x'), fetch: fetchFn });
      expect(await u.check()).toMatchObject({ status: 'unavailable', source: 'github.com/octo/fork', reason: expect.stringMatching(/No desktop release/) });
      expect(seen[0]?.headers.Authorization).toBe('Bearer ghp_x');
    });

    it('rejects bad repository names and asset URLs off api.github.com', async () => {
      expect(() => githubSource('../etc', async () => null)).toThrow(/Not a GitHub repository/);
      expect(() => githubSource('octo/fork/extra', async () => null)).toThrow();
      const evil = { ...rel('workshop-v0.3.0'), assets: [{ name: 'latest.json', url: 'https://evil.test/x', size: 1 }] };
      const { fetchFn } = github([evil], {});
      const u = new Updater({ current: '0.2.0', publicKey: PUB, dir: tmp(), source: () => githubSource('octo/fork', async () => 'ghp_x'), fetch: fetchFn });
      await expect(u.check()).rejects.toThrow(/has no latest.json/);
    });
  });
});
