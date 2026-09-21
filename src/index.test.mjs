import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { Room } from './index.js';

const origin = 'https://fernandogracias.github.io';
const details = { type: 'join', name: 'Camper', color: 'cc5522', tentColor: 'cc5522', tentStyle: 'aframe' };

class Socket {
  listeners = new Map();
  messages = [];
  closed = null;
  readyState = 1;
  accept() {}
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  send(message) { this.messages.push(JSON.parse(message)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; }
  receive(message) { this.raw(JSON.stringify(message)); }
  raw(data) { this.listeners.get('message')({ data }); }
}

async function fixture(t, exists = true) {
  const stored = new Map(exists ? [['room', { seed: 123 }]] : []);
  const pending = [];
  let initialized;
  const state = {
    storage: {
      get: async key => stored.get(key),
      put: async (key, value) => stored.set(key, value),
      setAlarm: async () => {},
      deleteAll: async () => stored.clear(),
    },
    blockConcurrencyWhile: fn => initialized = fn(),
    waitUntil: promise => pending.push(promise),
  };
  const issued = [];
  const revoked = [];
  const env = {
    TURN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    JOIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    TURN_KEY_ID: 'test-key', TURN_KEY_SECRET: 'test-secret',
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    if (url.endsWith('/revoke')) {
      revoked.push(url);
      return new Response(null, { status: 204 });
    }
    assert.equal(JSON.parse(init.body).ttl, 3600);
    const username = 'credential-' + issued.length;
    issued.push(username);
    return Response.json({ iceServers: [{ urls: 'turn:turn.cloudflare.com:3478', username, credential: 'temporary' }] });
  });
  const room = new Room(state, env);
  await initialized;
  env.ROOMS = { idFromName: name => name, get: () => ({ fetch: request => room.fetch(request) }) };
  async function connect(ready = true) {
    const ws = new Socket();
    const peer = room.handleSession(ws, '192.0.2.1');
    if (ready) {
      ws.receive(details);
      await peer.queue;
      ws.receive({ type: 'ready' });
      await peer.queue;
    }
    return { ws, peer };
  }
  t.after(async () => {
    for (const peer of [...room.connections]) room.removePeer(peer);
    await Promise.all(pending);
  });
  return { room, env, connect, issued, revoked, pending, stored };
}

function request(path, options = {}) {
  return new Request('https://example.test' + path, {
    ...options,
    headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', ...options.headers },
  });
}

test('credentials require a valid room and an actual join', async t => {
  const { room, connect, issued } = await fixture(t, false);
  assert.equal((await room.fetch(request('/api/room/0123456789ab', { headers: { Upgrade: 'websocket' } }))).status, 404);
  const { ws, peer } = await connect(false);
  assert.equal(issued.length, 0);
  ws.receive(details);
  await peer.queue;
  assert.equal(issued.length, 0);
  assert.equal(ws.closed.code, 1008);
});

test('room creation persists a server-selected seed and prevents overwrites', async t => {
  const { room, env, stored } = await fixture(t, false);
  const resp = await worker.fetch(request('/api/create', { method: 'POST' }), env);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.match(data.roomId, /^[a-f0-9]{12}$/);
  assert.equal(stored.get('room').seed, data.seed);
  assert.equal(stored.get('room').ownerToken, data.ownerToken);
  assert.equal(stored.get('room').environment.winter, false);
  assert.equal((await room.fetch(new Request('https://room/internal/create', { method: 'POST' }))).status, 409);
});

test('legacy credential endpoint and metadata routes are unavailable', async t => {
  const { env, issued } = await fixture(t);
  for (const path of ['/turn-creds', '/api/turn-creds', '/api/room/0123456789ab/turn-creds', '/api/room/0123456789ab/info', '/room/0123456789ab', '/api/room/0123456789ab/extra', '/internal/create']) {
    assert.equal((await worker.fetch(request(path), env)).status, 404, path);
  }
  assert.equal(issued.length, 0);
});

test('cross-origin and missing-origin requests are rejected', async t => {
  const { env } = await fixture(t);
  assert.equal((await worker.fetch(request('/api/create', { method: 'POST', headers: { Origin: 'https://evil.test' } }), env)).status, 403);
  assert.equal((await worker.fetch(new Request('https://example.test/api/create', { method: 'POST' }), env)).status, 403);
  const preflight = await worker.fetch(request('/api/create', { method: 'OPTIONS' }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(preflight.headers.get('Cache-Control'), 'no-store');
});

test('room creation, connection attempts and credential minting each enforce IP limits', async t => {
  const { env, connect, issued } = await fixture(t);
  for (const name of ['CREATE_RATE_LIMITER', 'JOIN_RATE_LIMITER', 'TURN_RATE_LIMITER']) {
    env[name].limit = async ({ key }) => { assert.equal(key, '192.0.2.1'); return { success: false }; };
  }
  assert.equal((await worker.fetch(request('/api/create', { method: 'POST' }), env)).status, 429);
  assert.equal((await worker.fetch(request('/api/room/0123456789ab', { headers: { Upgrade: 'websocket' } }), env)).status, 429);
  const { ws, peer } = await connect(false);
  ws.receive(details);
  await peer.queue;
  assert.equal(ws.closed.code, 1008);
  assert.equal(issued.length, 0);
});

test('pending sockets count toward the room cap', async t => {
  const { room, connect, issued } = await fixture(t);
  for (let i = 0; i < 100; i++) await connect(false);
  assert.equal((await room.fetch(request('/api/room/0123456789ab', { headers: { Upgrade: 'websocket' } }))).status, 503);
  assert.equal(issued.length, 0);
});

test('server identity and seed ignore client claims; credentials are private to their socket', async t => {
  const { connect, room, issued } = await fixture(t);
  const a = await connect();
  const b = await connect(false);
  b.ws.receive({ ...details, id: a.peer.id, seed: 999 });
  await b.peer.queue;
  assert.notEqual(a.peer.id, b.peer.id);
  assert.equal(room.peers.get(a.peer.id), a.peer);
  assert.equal(b.ws.messages[0].seed, 123);
  assert.equal(a.ws.messages.some(m => m.type === 'peer-joined'), false);
  b.ws.receive({ type: 'ready' });
  await b.peer.queue;
  const announcement = a.ws.messages.find(m => m.type === 'peer-joined');
  assert.equal(announcement.id, b.peer.id);
  assert.equal(JSON.stringify(announcement).includes(issued[1]), false);
});

test('duplicate joins cannot create phantom peers or mint more credentials', async t => {
  const { connect, room, issued, pending, revoked } = await fixture(t);
  const { ws, peer } = await connect();
  ws.receive({ ...details, id: 'different' });
  await peer.queue;
  await Promise.all(pending);
  assert.equal(issued.length, 1);
  assert.equal(room.peers.size, 0);
  assert.equal(room.connections.size, 0);
  assert.equal(revoked.length, 1);
});

for (const type of ['offer', 'answer']) {
  test(`${type} preserves the description and uses the sender socket identity`, async t => {
    const { connect } = await fixture(t);
    const a = await connect();
    const b = await connect();
    b.ws.messages.length = 0;
    const sdp = { type, sdp: 'v=0\r\ns=-\r\nt=0 0\r\n' };
    a.ws.receive({ type, target: b.peer.id, from: 'forged', sdp: { ...sdp, extra: 'discard' } });
    await a.peer.queue;
    assert.deepEqual(b.ws.messages, [{ type, from: a.peer.id, sdp }]);
  });
}

test('ICE candidates are sanitized without breaking WebRTC fields', async t => {
  const { connect } = await fixture(t);
  const a = await connect();
  const b = await connect();
  b.ws.messages.length = 0;
  const candidate = { candidate: 'candidate:1 1 UDP 1 192.0.2.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag' };
  a.ws.receive({ type: 'ice-candidate', target: b.peer.id, candidate: { ...candidate, extra: 'discard' } });
  await a.peer.queue;
  assert.deepEqual(b.ws.messages, [{ type: 'ice-candidate', from: a.peer.id, candidate }]);
});

for (const sdp of [null, '', 'v=0\r\n', {}, { type: 'offer', sdp: '' }, { type: 'answer', sdp: 'v=0\r\n' }, { type: 'offer', sdp: 123 }]) {
  test(`invalid offer rejected: ${JSON.stringify(sdp)}`, async t => {
    const { connect } = await fixture(t);
    const a = await connect();
    const b = await connect();
    a.ws.receive({ type: 'offer', target: b.peer.id, sdp });
    await a.peer.queue;
    assert.equal(a.ws.closed.code, 1008);
    assert.equal(b.ws.messages.some(m => m.type === 'offer'), false);
  });
}

for (const raw of ['null', '[]', '{', '42', '"join"', '{"type":42}', 'x'.repeat(16385), '"' + '界'.repeat(6000) + '"', new ArrayBuffer(1)]) {
  test(`malformed or oversized messages are rejected (${typeof raw}, ${raw.length ?? raw.byteLength})`, async t => {
    const { connect, issued } = await fixture(t);
    const { ws, peer } = await connect(false);
    ws.raw(raw);
    await peer.queue;
    assert.equal(ws.closed.code, 1008);
    assert.equal(issued.length, 0);
  });
}

test('unjoined and unready clients cannot relay or refresh', async t => {
  const { connect, issued } = await fixture(t);
  for (const type of ['offer', 'ice-candidate', 'turn-refresh', 'ready']) {
    const { ws, peer } = await connect(false);
    ws.receive({ type, target: 'other' });
    await peer.queue;
    assert.equal(ws.closed.code, 1008);
  }
  assert.equal(issued.length, 0);
  const { ws, peer } = await connect(false);
  ws.receive(details);
  await peer.queue;
  ws.receive({ type: 'turn-refresh' });
  await peer.queue;
  assert.equal(ws.closed.code, 1008);
  assert.equal(issued.length, 1);
});

test('message flooding disconnects the sender and revokes credentials', async t => {
  const { connect, room, pending, revoked } = await fixture(t);
  const { ws, peer } = await connect();
  for (let i = 0; i < 700; i++) ws.receive({ type: 'ping' });
  await peer.queue;
  await Promise.all(pending);
  assert.equal(ws.closed.code, 1008);
  assert.equal(room.connections.size, 0);
  assert.equal(revoked.length, 1);
});

test('renewal before its scheduled time does not mint credentials', async t => {
  const { connect, issued } = await fixture(t);
  const { ws, peer } = await connect();
  ws.receive({ type: 'turn-refresh' });
  await peer.queue;
  assert.equal(issued.length, 1);
  assert.equal(ws.closed.code, 1008);
});

test('renewal after 50 minutes works and concurrent requests cannot multiply credentials', async t => {
  const { connect, issued } = await fixture(t);
  const { ws, peer } = await connect();
  t.mock.method(Date, 'now', () => peer.credentials[0].expiresAt - 600000 + 1);
  ws.receive({ type: 'turn-refresh' });
  await peer.queue;
  assert.equal(issued.length, 2);
  assert.equal(ws.messages.at(-1).type, 'turn-creds');
  assert.equal(ws.closed, null);
  ws.receive({ type: 'turn-refresh' });
  ws.receive({ type: 'turn-refresh' });
  await peer.queue;
  assert.equal(issued.length, 2);
  assert.equal(ws.closed.code, 1008);
});

test('disconnect during issuance revokes the result instead of delivering it', async t => {
  const { connect, room } = await fixture(t);
  let release;
  let started;
  const waiting = new Promise(resolve => started = resolve);
  const revocations = [];
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/revoke')) { revocations.push(url); return new Response(null, { status: 204 }); }
    started();
    return new Promise(resolve => release = resolve);
  });
  const { ws, peer } = await connect(false);
  ws.receive(details);
  await waiting;
  room.removePeer(peer);
  release(Response.json({ iceServers: [{ urls: 'turn:test', username: 'late', credential: 'secret' }] }));
  await peer.queue;
  assert.equal(ws.messages.length, 0);
  assert.equal(revocations.length, 1);
});

test('close cleanup is idempotent and only removes the owning connection', async t => {
  const { connect, room, pending, revoked } = await fixture(t);
  const a = await connect();
  const b = await connect();
  room.removePeer(a.peer);
  room.removePeer(a.peer);
  await Promise.all(pending);
  assert.equal(room.peers.get(b.peer.id), b.peer);
  assert.equal(b.ws.messages.filter(m => m.type === 'peer-left').length, 1);
  assert.equal(revoked.length, 1);
});

test('idle room alarm deletes unused rooms but preserves occupied rooms', async t => {
  const { room, connect, stored } = await fixture(t);
  const { peer } = await connect();
  await room.alarm();
  assert.equal(stored.has('room'), true);
  room.removePeer(peer);
  await room.alarm();
  assert.equal(stored.size, 0);
  assert.equal(room.room, null);
});

test('join and ready deadlines release capacity and revoke unused credentials', async t => {
  const { connect, room, pending, revoked } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const unjoined = await connect(false);
  t.mock.timers.tick(15001);
  assert.equal(unjoined.ws.closed.code, 1008);
  assert.equal(room.connections.size, 0);
  const unready = await connect(false);
  unready.ws.receive(details);
  await unready.peer.queue;
  t.mock.timers.tick(30001);
  await Promise.all(pending);
  assert.equal(unready.ws.closed.code, 1008);
  assert.equal(room.peers.size, 0);
  assert.equal(revoked.length, 1);
});

test('heartbeat maintains membership and silence expires it', async t => {
  const { connect, room } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { ws, peer } = await connect();
  t.mock.timers.tick(90000);
  ws.receive({ type: 'ping' });
  await peer.queue;
  assert.equal(ws.messages.at(-1).type, 'pong');
  t.mock.timers.tick(90000);
  assert.equal(ws.closed, null);
  t.mock.timers.tick(60000);
  assert.equal(ws.closed.code, 1008);
  assert.equal(room.connections.size, 0);
});

test('unknown room peers cannot be targeted', async t => {
  const { connect } = await fixture(t);
  const { ws, peer } = await connect();
  const before = ws.messages.length;
  ws.receive({ type: 'offer', target: crypto.randomUUID(), sdp: { type: 'offer', sdp: 'v=0\r\n' } });
  await peer.queue;
  assert.equal(ws.messages.length, before);
  assert.equal(ws.closed, null);
});

test('provider errors fail closed without returning upstream bodies or secrets', async t => {
  const { connect, room } = await fixture(t);
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('private provider error', { status: 503 }));
  const { ws, peer } = await connect(false);
  ws.receive(details);
  await peer.queue;
  assert.equal(ws.closed.code, 1011);
  assert.equal(ws.messages.length, 0);
  assert.equal(ws.closed.reason.includes('private'), false);
  assert.equal(room.connections.size, 0);
});
