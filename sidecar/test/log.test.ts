import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/log.js';

describe('logger', () => {
  it('rotates while running, not only at start, and redacts keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-log-'));
    const log = new Logger(10_000);
    log.open(dir);
    for (let i = 0; i < 1200; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
    log.info('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(fs.existsSync(path.join(dir, 'sidecar.log.1'))).toBe(true);
    const current = fs.readFileSync(path.join(dir, 'sidecar.log'), 'utf8');
    expect(current.length).toBeLessThan(10_000 + 500 * 100);
    expect(current).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
