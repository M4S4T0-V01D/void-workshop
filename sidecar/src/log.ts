import fs from 'node:fs';
import path from 'node:path';
import { redactText } from './redact.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** The size is checked again after this many lines, so a sidecar that runs for weeks still rotates. */
const CHECK_EVERY = 500;

export class Logger {
  private file: string | null = null;
  private sinceCheck = 0;

  constructor(private readonly maxBytes = MAX_LOG_BYTES) {}

  open(logDir: string): void {
    this.file = path.join(logDir, 'sidecar.log');
    this.rotate();
  }

  /** Keep one older log next to the current one. */
  private rotate(): void {
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.maxBytes) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
    } catch {
      /* rotation is best effort */
    }
  }

  write(level: 'info' | 'warn' | 'error', message: string, extra?: unknown): void {
    const detail = extra === undefined ? '' : ` ${safeStringify(extra)}`;
    const line = redactText(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${detail}`) + '\n';
    if (this.file) {
      if (++this.sinceCheck >= CHECK_EVERY) {
        this.sinceCheck = 0;
        this.rotate();
      }
      try {
        fs.appendFileSync(this.file, line, { mode: 0o600 });
        return;
      } catch {
        /* fall through to stderr */
      }
    }
    process.stderr.write(line);
  }

  info(m: string, e?: unknown) {
    this.write('info', m, e);
  }
  warn(m: string, e?: unknown) {
    this.write('warn', m, e);
  }
  error(m: string, e?: unknown) {
    this.write('error', m, e);
  }
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v).slice(0, 4000);
  } catch {
    return String(v);
  }
}

export const log = new Logger();
