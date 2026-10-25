import { call } from './api';

/** The window reads kept images in big pieces (the phone uses 256 KB ones to fit a relay frame). */
export const WINDOW_CHUNK_BYTES = 4 * 1024 * 1024;
/** Object URLs kept for images already shown, so switching tasks or scrolling back does not fetch them again. */
const MAX_CACHED = 60;

const cache = new Map<string, Promise<string>>();

export function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchImage(taskId: string, imageId: string): Promise<string> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let mediaType: string | undefined;
  for (;;) {
    const c = await call<{ mediaType: string; bytes: number; data: string; done: boolean }>('task.image', { taskId, imageId, offset, length: WINDOW_CHUNK_BYTES });
    mediaType = c.mediaType;
    const part = base64Bytes(c.data);
    parts.push(part);
    offset += part.length;
    if (c.done || !part.length) break;
  }
  return URL.createObjectURL(new Blob(parts as BlobPart[], { type: mediaType ?? 'image/png' }));
}

/** An object URL for a kept image. The cache owns it: callers must not revoke it. */
export function loadImage(taskId: string, imageId: string): Promise<string> {
  const key = `${taskId}/${imageId}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes last.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = fetchImage(taskId, imageId);
  cache.set(key, p);
  // A failed fetch is not remembered, so the next look tries again.
  p.catch(() => cache.get(key) === p && cache.delete(key));
  while (cache.size > MAX_CACHED) {
    const [oldKey, old] = cache.entries().next().value!;
    cache.delete(oldKey);
    old.then((u) => URL.revokeObjectURL(u), () => undefined);
  }
  return p;
}

/** For tests. */
export function clearImageCache(): void {
  for (const p of cache.values()) p.then((u) => URL.revokeObjectURL(u), () => undefined);
  cache.clear();
}
