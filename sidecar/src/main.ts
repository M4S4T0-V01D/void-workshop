import readline from 'node:readline';
import { assertNotRoot, ensureAppDirs, resolveAppPaths } from './config.js';
import { log } from './log.js';
import { redactValue } from './redact.js';
import { Server, errorPayload } from './server.js';

/**
 * Sidecar entry point. Protocol: one JSON object per line.
 *   in : {"id": number, "method": string, "params": object}
 *   out: {"id": number, "result": any} | {"id": number, "error": {"code","message"}}
 *        {"event": string, "payload": any}
 * stdout carries only protocol lines; diagnostics go to the redacted log file.
 */

const MAX_LINE = 4 * 1024 * 1024;

function send(obj: unknown): void {
  if (!process.stdout.writable) return;
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(): Promise<void> {
  assertNotRoot();
  const paths = resolveAppPaths();
  ensureAppDirs(paths);
  log.open(paths.logDir);
  log.info('sidecar starting');

  const server = new Server(paths, (event, payload) => send({ event, payload: redactValue(payload) }));
  server.startBackground();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`sidecar shutting down (${why})`);
    try {
      await server.shutdown();
    } catch (err) {
      log.error('shutdown error', err);
    }
    process.exit(0);
  };

  rl.on('line', (line) => {
    if (line.length > MAX_LINE) {
      send({ id: null, error: { code: 'too-large', message: 'Request too large' } });
      return;
    }
    let msg: { id?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: 'parse', message: 'Invalid JSON' } });
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : null;
    if (typeof msg.method !== 'string') {
      send({ id, error: { code: 'invalid', message: 'Missing method' } });
      return;
    }
    const method = msg.method;
    // Method names only: parameters can contain prompts or (for auth.setKey) the key itself.
    log.info(`rpc ${method}`);
    server
      .handle(method, msg.params)
      .then((result) => send({ id, result: redactValue(result) }))
      .catch((err) => {
        const payload = errorPayload(err);
        if (payload.code === 'internal') log.error(`rpc ${method} failed`, err);
        send({ id, error: payload });
      });
  });
  rl.on('close', () => void shutdown('stdin closed'));
  // The desktop shell went away: stop quietly instead of crashing on the next write.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') void shutdown('stdout closed');
    else log.error('stdout error', err);
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => log.error('uncaught exception', err));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));

  send({ event: 'sidecar.ready', payload: { methods: server.methodNames } });
}

main().catch((err) => {
  process.stderr.write(`void-workshop sidecar failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
