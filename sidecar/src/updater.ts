/**
 * Signed desktop updates. A release is a tarball of the install tree plus a manifest {product, version,
 * sha256, size, notes, date} signed with Ed25519 by scripts/release.sh. The app pins the public key
 * (updateKey.ts), checks the signature, refuses anything not newer than itself, checks the tarball's size and
 * SHA-256 while downloading, and only then unpacks it for the restart helper to install.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const UPDATE_PRODUCT = 'void-workshop-desktop';
/** Larger than any real package (about 20 MB); stops a runaway download. */
export const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface Release {
  product: string;
  version: string;
  sha256: string;
  size: number;
  notes: string;
  date: string;
}

/** latest.json as published: the manifest's exact bytes (base64) and their signature (base64). */
export interface SignedManifest {
  manifest: string;
  signature: string;
}

/** Where updates come from: the relay, with a paired phone's channel credentials (the same check as the phone's own updates). */
export interface UpdateSource {
  baseUrl: string;
  headers: Record<string, string>;
}

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/** -1, 0 or 1 like a comparator; only plain x.y.z versions are valid. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Check the signature with the pinned key and the manifest's fields. Throws on anything off. */
export function verifyRelease(doc: unknown, publicKeyPem: string | null): Release {
  if (!publicKeyPem) throw new Error('This build has no update key, so it cannot check updates. Install new versions from source.');
  const d = doc as Partial<SignedManifest> | null;
  if (!d || typeof d.manifest !== 'string' || typeof d.signature !== 'string') throw new Error('The update manifest is malformed.');
  const body = Buffer.from(d.manifest, 'base64');
  const sig = Buffer.from(d.signature, 'base64');
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The pinned update key is not an Ed25519 key.');
  if (sig.length !== 64 || !verify(null, body, key, sig)) throw new Error('The update signature does not match the pinned key: refusing it.');

  let r: Partial<Release>;
  try {
    r = JSON.parse(body.toString('utf8')) as Partial<Release>;
  } catch {
    throw new Error('The signed manifest is not JSON.');
  }
  if (r.product !== UPDATE_PRODUCT) throw new Error('The signed manifest is for another product.');
  if (typeof r.version !== 'string' || !VERSION.test(r.version)) throw new Error('The signed manifest has no valid version.');
  if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) throw new Error('The signed manifest has no valid SHA-256.');
  if (typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size <= 0 || r.size > MAX_PACKAGE_BYTES)
    throw new Error('The signed manifest has no valid size.');
  return {
    product: r.product,
    version: r.version,
    sha256: r.sha256,
    size: r.size,
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 4000) : '',
    date: typeof r.date === 'string' ? r.date.slice(0, 40) : '',
  };
}

export type CheckResult =
  | { status: 'unavailable'; current: string; reason: string }
  | { status: 'current'; current: string; latest: string }
  | { status: 'available'; current: string; release: Release };

type FetchFn = typeof fetch;

export class Updater {
  constructor(
    private readonly opts: {
      current: string;
      publicKey: string | null;
      /** Where packages are unpacked; one folder per version. */
      dir: string;
      source: () => UpdateSource | null;
      fetch?: FetchFn;
    },
  ) {}

  private get fetch(): FetchFn {
    return this.opts.fetch ?? fetch;
  }

  async check(): Promise<CheckResult> {
    const current = this.opts.current;
    if (!this.opts.publicKey) return { status: 'unavailable', current, reason: 'This build has no update key; install new versions from source.' };
    const src = this.opts.source();
    if (!src) return { status: 'unavailable', current, reason: 'Updates come through the VOID Portal relay: pair a phone first (Settings → VOID Portal).' };
    const res = await this.fetch(`${src.baseUrl}/v1/update/desktop/latest.json`, { headers: src.headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return { status: 'unavailable', current, reason: 'No desktop release has been published yet.' };
    if (!res.ok) throw new Error(`The update server answered ${res.status}.`);
    const text = await res.text();
    if (text.length > MAX_MANIFEST_BYTES) throw new Error('The update manifest is too large.');
    const release = verifyRelease(JSON.parse(text), this.opts.publicKey);
    return compareVersions(release.version, current) > 0 ? { status: 'available', current, release } : { status: 'current', current, latest: release.version };
  }

  /**
   * Download, check and unpack the newest release. Returns the unpacked folder (holding scripts/install.sh).
   * The manifest is fetched and verified again here, so nothing the window passes in is trusted.
   */
  async prepare(): Promise<{ release: Release; dir: string }> {
    const result = await this.check();
    if (result.status === 'unavailable') throw new Error(result.reason);
    if (result.status === 'current') throw new Error(`VOID Workshop ${result.current} is already the newest version.`);
    const { release } = result;
    const src = this.opts.source()!;

    fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.opts.dir, 0o700);
    // Earlier downloads are of no further use.
    for (const old of fs.readdirSync(this.opts.dir)) fs.rmSync(path.join(this.opts.dir, old), { recursive: true, force: true });
    const work = path.join(this.opts.dir, release.version);
    fs.mkdirSync(work, { mode: 0o700 });
    const tarball = path.join(work, 'package.tar.gz');

    const res = await this.fetch(`${src.baseUrl}/v1/update/desktop/${release.version}.tar.gz`, {
      headers: src.headers,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok || !res.body) throw new Error(`The update download failed (${res.status}).`);
    const hash = createHash('sha256');
    let size = 0;
    const out = fs.openSync(tarball, 'wx', 0o600);
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > release.size) throw new Error('The update download is larger than the signed size.');
        hash.update(chunk);
        fs.writeSync(out, chunk);
      }
    } finally {
      fs.closeSync(out);
    }
    if (size !== release.size) throw new Error('The update download is shorter than the signed size.');
    if (hash.digest('hex') !== release.sha256) {
      fs.rmSync(work, { recursive: true, force: true });
      throw new Error('The update download does not match the signed SHA-256: refusing it.');
    }

    const tree = path.join(work, 'tree');
    fs.mkdirSync(tree, { mode: 0o700 });
    await promisify(execFile)('tar', ['-xzf', tarball, '-C', tree, '--no-same-owner'], { timeout: 120_000 });
    checkTree(tree, release.version);
    fs.rmSync(tarball, { force: true });
    return { release, dir: tree };
  }
}

/** The unpacked package must be the release it claims to be, with what install.sh needs. */
export function checkTree(tree: string, version: string): void {
  let marker = '';
  try {
    marker = fs.readFileSync(path.join(tree, 'RELEASE'), 'utf8').trim();
  } catch {
    /* checked below */
  }
  if (marker !== version) throw new Error('The update package is not the release its manifest names.');
  for (const f of ['scripts/install.sh', 'src-tauri/target/release/void-workshop', 'sidecar/dist/main.js', 'sidecar/package-lock.json']) {
    const st = fs.lstatSync(path.join(tree, f), { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`The update package is missing ${f}.`);
  }
}
