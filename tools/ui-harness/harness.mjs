// UI test harness: serves the built frontend (dist/) to a headless browser and bridges Tauri IPC
// to the REAL sidecar over its normal stdio protocol. The method allow-list is read from the Rust
// shell (src-tauri/src/policy.rs) so the harness enforces exactly what the desktop app enforces.
// Data and config live in temporary directories; only the API key source is shared with the app.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function allowList() {
  const src = fs.readFileSync(path.join(ROOT, 'src-tauri/src/policy.rs'), 'utf8');
  const block = src.slice(src.indexOf('ALLOWED_METHODS'), src.indexOf('];', src.indexOf('ALLOWED_METHODS')));
  return new Set([...block.matchAll(/"([a-zA-Z.]+)"/g)].map((m) => m[1]));
}

function sidecarEnv(extra) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CARGO_HOME', 'RUSTUP_HOME'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

export async function startHarness({ pickDir = null, keyBackend, keyFile, seed } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-ui-'));
  // Optional: prepare the data directory (e.g. a demo database) before the sidecar opens it.
  if (seed) await seed(path.join(tmp, 'data'));
  const realKeyFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'void-workshop', 'credentials', 'anthropic-api-key');
  const env = sidecarEnv({
    VOID_WORKSHOP_DATA_DIR: path.join(tmp, 'data'),
    VOID_WORKSHOP_CONFIG_DIR: path.join(tmp, 'config'),
    VOID_WORKSHOP_KEY_FILE: keyFile ?? realKeyFile,
    ...(keyBackend ? { VOID_WORKSHOP_KEY_BACKEND: keyBackend } : {}),
  });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'sidecar/dist/main.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const allowed = allowList();
  const pending = new Map();
  const clients = new Set();
  let nextId = 1;
  const broadcast = (name, payload) => {
    const data = `data: ${JSON.stringify({ name, payload })}\n\n`;
    for (const res of clients) res.write(data);
  };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event) return broadcast('sidecar-event', { event: msg.event, payload: msg.payload });
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
  });
  child.on('exit', (code) => broadcast('sidecar-exit', { code }));

  const callSidecar = (method, params) =>
    new Promise((resolve, reject) => {
      if (!allowed.has(method)) return reject({ code: 'rejected', message: 'Request rejected: method is not allowed' });
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
    });

  const state = { pickDir };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/__harness/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/__harness/invoke' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { cmd, args } = JSON.parse(body);
      const reply = (ok, value) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok, value } : { ok, error: value }));
      };
      try {
        if (cmd === 'sidecar_call') return reply(true, await callSidecar(args.method, args.params));
        if (cmd === 'pick_project_dir') return reply(true, state.pickDir);
        if (cmd === 'startup_error') return reply(true, null);
        if (cmd === 'sidecar_restart') return reply(true, null);
        return reply(false, { code: 'unknown-command', message: cmd });
      } catch (err) {
        return reply(false, err);
      }
    }
    const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(ROOT, 'dist', rel);
    if (!file.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  return {
    url,
    tmp,
    state,
    callSidecar,
    async stop() {
      for (const c of clients) c.end();
      server.close();
      child.stdin.end();
      await new Promise((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 8000);
        child.on('exit', () => {
          clearTimeout(t);
          r();
        });
      });
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Injected into the page before the app loads: emulates window.__TAURI_INTERNALS__ over HTTP/SSE. */
export const SHIM = `(() => {
  const callbacks = new Map();
  const listeners = new Map();
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) { listeners.set(event, (listeners.get(event) || []).filter((l) => l.id !== id)); },
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(p) { return p; },
    async invoke(cmd, args) {
      if (cmd === 'plugin:event|listen') {
        const id = next++;
        listeners.set(args.event, [...(listeners.get(args.event) || []), { id, handler: args.handler }]);
        return id;
      }
      if (cmd === 'plugin:event|unlisten') return null;
      const res = await fetch('/__harness/invoke', { method: 'POST', body: JSON.stringify({ cmd, args }) });
      const body = await res.json();
      if (body.ok) return body.value;
      throw body.error;
    },
  };
  const es = new EventSource('/__harness/events');
  es.onmessage = (m) => {
    const { name, payload } = JSON.parse(m.data);
    for (const l of listeners.get(name) || []) {
      const cb = callbacks.get(l.handler);
      if (cb) cb({ event: name, id: l.id, payload });
    }
  };
})();`;
