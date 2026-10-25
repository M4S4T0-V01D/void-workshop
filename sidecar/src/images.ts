import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Images the agent looked at (screenshots and the like), copied when it saw them: /tmp files get reused. */

const MEDIA: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const EXT_MEDIA: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Read in pieces so one reply fits a relay frame (1 MiB, after base64 and encryption). */
export const IMAGE_CHUNK_BYTES = 256 * 1024;
const KEEP_DAYS = 30;
/** All kept images together stay under this; the oldest tasks' pictures go first. */
export const MAX_STORE_BYTES = 1024 * 1024 * 1024;
/** Where pictures from the phone wait until a message takes them. */
export const UPLOADS = 'uploads';
/** One upload has to fit a relay frame (1 MiB): base64 in the call, then base64 again once sealed. */
export const MAX_UPLOAD_BYTES = 512 * 1024;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export interface SavedImage {
  imageId: string;
  mediaType: string;
  bytes: number;
}

export interface ImageChunk {
  mediaType: string;
  bytes: number;
  offset: number;
  /** Base64 of bytes [offset, offset + chunk). */
  data: string;
  done: boolean;
}

/** The media type for an image path, or null when it is not one we show. */
export function imageMediaType(file: string): string | null {
  return EXT_MEDIA[path.extname(file).slice(1).toLowerCase()] ?? null;
}

/** Media type from the first bytes, so a mislabelled file is still shown correctly (or not at all). */
function sniff(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export class ImageStore {
  constructor(private readonly baseDir: string) {}

  private dir(taskId: string): string {
    if (!ID.test(taskId)) throw new Error('bad task id');
    return path.join(this.baseDir, taskId);
  }

  private find(taskId: string, imageId: string): { file: string; mediaType: string } | null {
    if (!ID.test(imageId)) return null;
    for (const [mediaType, ext] of Object.entries(MEDIA)) {
      const file = path.join(this.dir(taskId), `${imageId}.${ext}`);
      if (fs.existsSync(file)) return { file, mediaType };
    }
    return null;
  }

  save(taskId: string, data: Buffer): SavedImage | null {
    const mediaType = sniff(data);
    if (!mediaType || data.length > MAX_IMAGE_BYTES) return null;
    const imageId = crypto.randomUUID();
    const dir = this.dir(taskId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${imageId}.${MEDIA[mediaType]}`), data, { mode: 0o600 });
    return { imageId, mediaType, bytes: data.length };
  }

  /** Copy an image file as it is now; null when it is missing, too big or not an image. */
  saveFile(taskId: string, file: string): SavedImage | null {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
      return this.save(taskId, fs.readFileSync(file));
    } catch {
      return null;
    }
  }

  /** Move an image saved under another id (the phone's uploads) to a task; null when it is gone. */
  adopt(fromId: string, taskId: string, imageId: string): SavedImage | null {
    const found = this.find(fromId, imageId);
    if (!found) return null;
    const dir = this.dir(taskId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.renameSync(found.file, path.join(dir, path.basename(found.file)));
    return { imageId, mediaType: found.mediaType, bytes: fs.statSync(path.join(dir, path.basename(found.file))).size };
  }

  has(taskId: string, imageId: string): boolean {
    return !!this.find(taskId, imageId);
  }

  /** A whole image as base64, for sending it to the model. */
  base64(taskId: string, imageId: string): { mediaType: string; data: string } | null {
    const found = this.find(taskId, imageId);
    return found ? { mediaType: found.mediaType, data: fs.readFileSync(found.file).toString('base64') } : null;
  }

  read(taskId: string, imageId: string, offset = 0, length = IMAGE_CHUNK_BYTES): ImageChunk | null {
    const found = this.find(taskId, imageId);
    if (!found) return null;
    const bytes = fs.statSync(found.file).size;
    const start = Math.max(0, Math.min(Math.floor(offset), bytes));
    const len = Math.max(0, Math.min(Math.floor(length), bytes - start));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(found.file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    return { mediaType: found.mediaType, bytes, offset: start, data: buf.toString('base64'), done: start + len >= bytes };
  }

  /**
   * Copy a kept image into `destDir` under a cleaned-up version of `name`, never overwriting a file there.
   * Returns the new file's path, or null when the image is gone.
   */
  saveCopy(taskId: string, imageId: string, destDir: string, name: string): string | null {
    const found = this.find(taskId, imageId);
    if (!found) return null;
    const ext = MEDIA[found.mediaType]!;
    const stem =
      path
        .basename(name)
        .replace(/\.[A-Za-z0-9]{1,5}$/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^[._]+/, '')
        .slice(0, 80) || 'image';
    fs.mkdirSync(destDir, { recursive: true });
    for (let i = 0; i < 1000; i++) {
      const file = path.join(destDir, `${stem}${i ? `-${i}` : ''}.${ext}`);
      try {
        fs.copyFileSync(found.file, file, fs.constants.COPYFILE_EXCL);
        return file;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error('Too many files with that name');
  }

  /** Total bytes of all kept images. */
  totalBytes(): number {
    let total = 0;
    for (const dir of safeList(this.baseDir)) {
      for (const f of safeList(path.join(this.baseDir, dir))) {
        try {
          total += fs.statSync(path.join(this.baseDir, dir, f)).size;
        } catch {
          /* gone */
        }
      }
    }
    return total;
  }

  /** Drop task folders untouched for a month, then the oldest ones while all images together pass `maxBytes`. */
  prune(now = Date.now(), maxBytes = MAX_STORE_BYTES): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.baseDir);
    } catch {
      return;
    }
    // Pictures shared from the phone but never sent go after a day.
    try {
      for (const f of fs.readdirSync(path.join(this.baseDir, UPLOADS))) {
        const file = path.join(this.baseDir, UPLOADS, f);
        if (now - fs.statSync(file).mtimeMs > 86_400_000) fs.rmSync(file, { force: true });
      }
    } catch {
      /* no uploads yet */
    }
    for (const name of names) {
      const dir = path.join(this.baseDir, name);
      try {
        if (now - fs.statSync(dir).mtimeMs > KEEP_DAYS * 86_400_000) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
    }
    let total = this.totalBytes();
    if (total <= maxBytes) return;
    const byAge = safeList(this.baseDir)
      .filter((n) => n !== UPLOADS)
      .map((n) => {
        const dir = path.join(this.baseDir, n);
        try {
          const size = safeList(dir).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
          return { dir, size, mtime: fs.statSync(dir).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null)
      .sort((a, b) => a.mtime - b.mtime);
    for (const d of byAge) {
      if (total <= maxBytes) break;
      fs.rmSync(d.dir, { recursive: true, force: true });
      total -= d.size;
    }
  }
}
