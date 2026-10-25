// Smoke test for the relay: node test/smoke.mjs [ws://127.0.0.1:8787 | wss://void-relay…]
import crypto from 'node:crypto';

const base = process.argv[2] ?? 'ws://127.0.0.1:8787';
const secret = crypto.randomBytes(32);
const okm = (info, len) => Buffer.from(crypto.hkdfSync('sha256', secret, 'void-remote-v1', info, len));
const channel = okm('channel', 16).toString('hex');
const token = okm('token', 32).toString('base64url');
const url = (role) => `${base}/v1/channel/${channel}?role=${role}`;
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};

function connect(role, tok = token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url(role), { headers: { authorization: `Bearer ${tok}` } });
    const inbox = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const f = JSON.parse(e.data);
      inbox.push(f);
      for (const w of waiters.splice(0)) w();
    };
    ws.next = async (pred, ms = 5000) => {
      const end = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() > end) return null;
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    };
    ws.onopen = () => resolve(ws);
    ws.onerror = () => resolve(null);
    ws.onclose = (e) => (ws.closedWith = e.code);
  });
}

const health = await fetch(base.replace(/^ws/, 'http') + '/health').then((r) => r.text());
check('health endpoint answers', health.includes('VOID relay'));

check('a phone cannot open a channel the PC has not claimed', (await connect('phone')) === null);
const host = await connect('host');
check('the PC claims the channel', !!host);
check('the PC is told no phone is online', !!(await host.next((f) => f.t === 'peer' && f.role === 'phone' && f.online === false)));

host.send(JSON.stringify({ t: 'msg', d: 'sealed-notification-1', keep: true }));
host.send(JSON.stringify({ t: 'msg', d: 'not-kept' }));
await new Promise((r) => setTimeout(r, 300));
check('a wrong token is refused', (await connect('phone', crypto.randomBytes(32).toString('base64url'))) === null);

const phone = await connect('phone');
check('the phone connects with the derived token', !!phone);
check('the phone is told the PC is online', !!(await phone.next((f) => f.t === 'peer' && f.role === 'host' && f.online === true)));
const kept = await phone.next((f) => f.t === 'msg' && f.kept);
check('notifications sent while the phone was away are delivered', kept?.d === 'sealed-notification-1');
check('frames without keep are not stored', (await phone.next((f) => f.d === 'not-kept', 500)) === null);
check('the PC sees the phone come online', !!(await host.next((f) => f.t === 'peer' && f.role === 'phone' && f.online)));

const http = base.replace(/^ws/, 'http');
const upd = (headers) => fetch(`${http}/v1/update/latest.json`, { headers }).then((r) => r.status);
check('updates need a channel', (await upd({})) === 401);
check('updates refuse a wrong token', (await upd({ 'x-void-channel': channel, authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` })) === 403);
const ok = await upd({ 'x-void-channel': channel, authorization: `Bearer ${token}` });
check('a paired phone may read the release manifest', ok === 200 || ok === 404);
const desk = (path, headers) => fetch(`${http}/v1/update/desktop/${path}`, { headers }).then((r) => r.status);
check('desktop updates need a channel', (await desk('latest.json', {})) === 401);
const auth = { 'x-void-channel': channel, authorization: `Bearer ${token}` };
const dl = await desk('latest.json', auth);
check('the paired PC may read the desktop manifest', dl === 200 || dl === 404);
check('desktop packages need an x.y.z name', (await desk('../latest.json.tar.gz', auth)) === 404 && (await desk('0.2.x.tar.gz', auth)) === 404);

phone.send(JSON.stringify({ t: 'msg', d: 'call-1' }));
check('phone → PC frames are forwarded', (await host.next((f) => f.t === 'msg' && f.d === 'call-1'))?.d === 'call-1');
host.send(JSON.stringify({ t: 'msg', d: 'reply-1' }));
check('PC → phone frames are forwarded', (await phone.next((f) => f.t === 'msg' && f.d === 'reply-1'))?.d === 'reply-1');
phone.send('{"t":"ping"}');
check('pings get pongs', !!(await phone.next((f) => f.t === 'pong')));

host.close();
check('the phone hears when the PC goes offline', !!(await phone.next((f) => f.t === 'peer' && f.role === 'host' && f.online === false)));

const bad = await fetch(base.replace(/^ws/, 'http') + `/v1/channel/${channel}`, { method: 'DELETE', headers: { authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` } });
check('deleting needs the token', bad.status === 403);
const del = await fetch(base.replace(/^ws/, 'http') + `/v1/channel/${channel}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
check('unpairing deletes the channel', del.status === 204);
await new Promise((r) => setTimeout(r, 300));
check('connected phones are closed as unpaired', phone.closedWith === 4001);
check('the deleted channel no longer accepts the phone', (await connect('phone')) === null);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll relay checks passed');
process.exit(failed ? 1 : 0);
