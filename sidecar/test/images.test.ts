import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImageStore, UPLOADS } from '../src/images.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1000, 1)]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'void-images-'));

describe('image store', () => {
  it('saves copies under a clean name and never overwrites', () => {
    const base = tmp();
    const dest = path.join(tmp(), 'Downloads');
    const store = new ImageStore(base);
    const img = store.save('task-1', PNG)!;
    const a = store.saveCopy('task-1', img.imageId, dest, '../../etc/screen shot.jpg')!;
    expect(path.dirname(a)).toBe(dest);
    expect(path.basename(a)).toBe('screen_shot.png');
    const b = store.saveCopy('task-1', img.imageId, dest, 'screen shot.png')!;
    expect(path.basename(b)).toBe('screen_shot-1.png');
    expect(fs.readFileSync(b).equals(PNG)).toBe(true);
    expect(path.basename(store.saveCopy('task-1', img.imageId, dest, '...')!)).toBe('image.png');
    expect(store.saveCopy('task-1', 'missing', dest, 'x')).toBeNull();
  });

  it('drops the oldest tasks first once all images pass the size cap', () => {
    const base = tmp();
    const store = new ImageStore(base);
    for (const [i, id] of ['old', 'mid', 'new'].entries()) {
      store.save(id, PNG);
      const t = new Date(Date.now() - (3 - i) * 60_000);
      fs.utimesSync(path.join(base, id), t, t);
    }
    fs.mkdirSync(path.join(base, UPLOADS));
    fs.writeFileSync(path.join(base, UPLOADS, 'pending.png'), PNG);
    store.prune(Date.now(), PNG.length * 3 + 10);
    expect(fs.readdirSync(base).sort()).toEqual(['mid', 'new', UPLOADS]);
    expect(store.totalBytes()).toBe(PNG.length * 3);
  });
});
