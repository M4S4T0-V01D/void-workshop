import crypto from 'node:crypto';

/**
 * VOID Portal end-to-end encryption (see remote/PROTOCOL.md). Both ends derive everything from a
 * 32-byte pairing secret that travels once, in the QR code, from the PC screen to the phone camera.
 * The relay sees only the channel id, a token it stores as a hash, and sealed frames.
 */

export interface PairKeys {
  /** Durable Object name on the relay (hex, 128 bits). */
  channelId: string;
  /** Bearer token for the relay (base64url, 256 bits). */
  token: string;
  hostToPhone: Buffer;
  phoneToHost: Buffer;
}

export type Direction = 'h2p' | 'p2h';

const SALT = 'void-remote-v1';

export function deriveKeys(secret: Buffer): PairKeys {
  if (secret.length !== 32) throw new Error('The pairing secret must be 32 bytes.');
  const okm = (info: string, len: number) => Buffer.from(crypto.hkdfSync('sha256', secret, SALT, info, len));
  return {
    channelId: okm('channel', 16).toString('hex'),
    token: okm('token', 32).toString('base64url'),
    hostToPhone: okm('host->phone', 32),
    phoneToHost: okm('phone->host', 32),
  };
}

/** AES-256-GCM; output is base64url(nonce ‖ ciphertext ‖ tag). The AAD binds the channel and direction. */
export function seal(keys: PairKeys, dir: Direction, payload: unknown): string {
  const key = dir === 'h2p' ? keys.hostToPhone : keys.phoneToHost;
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${keys.channelId}:${dir}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64url');
}

/** Throws when the frame was not sealed with this channel's key for that direction. */
export function open(keys: PairKeys, dir: Direction, frame: string): unknown {
  const raw = Buffer.from(frame, 'base64url');
  if (raw.length < 12 + 16) throw new Error('Frame too short');
  const key = dir === 'h2p' ? keys.hostToPhone : keys.phoneToHost;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${keys.channelId}:${dir}`));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const pt = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/** No relay is built in: each user deploys their own (remote/relay) and enters it in Settings. */
export const DEFAULT_RELAY = '';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('Bad pairing secret');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * The link the QR code carries. Normally it is short and all upper case,
 * VOIDPORTAL://P/<secret, base32>/<relay host>, which QR stores in its compact alphanumeric mode: a much
 * coarser code that phone cameras read easily off a monitor (host names are case-insensitive). A relay
 * host that does not fit that alphabet needs the long form
 * voidportal://pair?v=1&r=<relay>&s=<secret, base64url>&n=<pc name>.
 */
export function pairingLink(relayUrl: string, secret: Buffer, pcName: string): string {
  const host = /^wss:\/\/([a-z0-9.-]+(?::\d+)?)$/i.exec(relayUrl);
  if (host) return `VOIDPORTAL://P/${base32(secret)}/${host[1]!.toUpperCase()}`;
  const q = new URLSearchParams({ v: '1', r: relayUrl, s: secret.toString('base64url'), n: pcName });
  return `voidportal://pair?${q.toString()}`;
}

export function parsePairingLink(link: string): { relayUrl: string; secret: Buffer; pcName: string } {
  const short = /^voidportal:\/\/p\/([A-Z2-7]{52})\/([a-z0-9.-]+(?::\d+)?)$/i.exec(link.trim());
  if (short) return { relayUrl: `wss://${short[2]!.toLowerCase()}`, secret: unbase32(short[1]!), pcName: 'PC' };
  const u = new URL(link);
  if (u.protocol !== 'voidportal:' || u.searchParams.get('v') !== '1') throw new Error('Not a VOID Portal pairing link');
  const secret = Buffer.from(u.searchParams.get('s') ?? '', 'base64url');
  if (secret.length !== 32) throw new Error('Bad pairing secret');
  return { relayUrl: u.searchParams.get('r') ?? '', secret, pcName: u.searchParams.get('n') ?? 'PC' };
}
