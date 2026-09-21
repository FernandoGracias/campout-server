import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MinigameWorld, iceRaceCourse } from './minigames.js';
import { ghostNight } from './ghost-game.js';

function fixture(t, count = 2, winter = false) {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const stored = new Map(), messages = [], pending = [];
  const room = {
    room: { environment: { winter } }, peers: new Map(),
    state: { storage: { get: async key => stored.get(key), put: async (key, value) => stored.set(key, structuredClone(value)) }, waitUntil: p => pending.push(p) },
    send: (peer, message) => messages.push({ peer: peer.id, ...structuredClone(message) }),
  };
  const game = new MinigameWorld(room);
  const peers = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Camper ${i}`, ready: true, minigameActive: true, minigameTeam: i % 2 ? 'blue' : 'red' }));
  for (const peer of peers) room.peers.set(peer.id, peer);
  t.after(async () => { clearTimeout(game.timer); await Promise.all(pending); });
  const advance = ms => { now += ms; game.tick(); };
  const send = (i, msg) => game.run(() => game.handle(peers[i], { epoch: game.data.epoch, ...msg }));
  const pose = (i, angle = i * 0.03, extra = {}) => send(i, { type: 'minigame-pose',
    position: [Math.sin(angle) * 20, Math.cos(angle) * 20, 0], heading: [1, 0, 0], ...extra });
  return { game, peers, room, stored, messages, advance, send, pose };
}

test('strict majority counts each connected camper once and expires without changing modes', async t => {
  const f = fixture(t, 3);
  await f.send(0, { type: 'minigame-vote', mode: 'tag' });
  await f.send(0, { type: 'minigame-vote', mode: 'tag' });
  assert.equal(f.game.data.vote.yes.length, 1);
  assert.equal(f.game.data.mode, null);
  await f.send(1, { type: 'minigame-vote', mode: 'tag' });
  assert.equal(f.game.data.mode, 'tag');
  await f.send(0, { type: 'minigame-vote', mode: 'camping' });
  f.advance(30001);
  assert.equal(f.game.data.vote, null);
  assert.equal(f.game.data.mode, 'tag');
  await f.send(0, { type: 'minigame-vote', mode: 'camping' });
  await f.send(2, { type: 'minigame-vote', mode: 'camping' });
  assert.equal(f.game.data.mode, null);
});

test('tag transfers only from IT at contact range and blocks immediate tag-backs and stale epochs', async t => {
  const f = fixture(t, 3);
  f.game.start('tag'); f.advance(5000);
  await f.pose(0); await f.pose(1); await f.pose(2, 1);
  await f.send(1, { type: 'minigame-contact', target: 'p0' });
  assert.equal(f.game.data.it, 'p0');
  await f.send(0, { type: 'minigame-contact', target: 'p2' });
  assert.equal(f.game.data.it, 'p0');
  await f.send(0, { type: 'minigame-contact', target: 'p1', epoch: -1 });
  assert.equal(f.game.data.it, 'p0');
  await f.send(0, { type: 'minigame-contact', target: 'p1' });
  assert.equal(f.game.data.it, 'p1');
  await f.send(1, { type: 'minigame-contact', target: 'p0' });
  assert.equal(f.game.data.it, 'p1');
  f.advance(1900); await f.pose(0); await f.pose(1);
  await f.send(1, { type: 'minigame-contact', target: 'p0' });
  assert.equal(f.game.data.it, 'p0');
});

test('freeze tag rescues teammates and awards exactly +1 / -1 when a whole team freezes', async t => {
  const f = fixture(t, 4);
  f.game.start('freeze-tag'); f.advance(5000);
  for (let i = 0; i < 4; i++) await f.pose(i, i * 0.01);
  assert.equal(f.game.data.roster.p0.team, f.game.data.roster.p2.team);
  await f.send(1, { type: 'minigame-contact', target: 'p0' });
  assert.equal(f.game.data.roster.p0.frozen, true);
  await f.send(0, { type: 'minigame-contact', target: 'p1' });
  assert.equal(f.game.data.roster.p1.frozen, false);
  await f.send(2, { type: 'minigame-contact', target: 'p0' });
  assert.equal(f.game.data.roster.p0.frozen, false);
  f.advance(1600);
  for (let i = 0; i < 4; i++) await f.pose(i, i * 0.01);
  await f.send(1, { type: 'minigame-contact', target: 'p0' });
  await f.send(1, { type: 'minigame-contact', target: 'p2' });
  assert.deepEqual(f.game.data.scores, { red: -1, blue: 1 });
  assert.equal(f.game.data.round, 2);
  assert.equal(f.game.data.phase, 'countdown');
  assert.ok(Object.values(f.game.data.roster).every(p => !p.frozen));
  await f.send(1, { type: 'minigame-contact', target: 'p0' });
  assert.deepEqual(f.game.data.scores, { red: -1, blue: 1 });
});

test('flashlight tag requires a lit beam aimed at the opponent', async t => {
  const f = fixture(t);
  f.game.start('flashlight-tag'); f.advance(5000);
  await f.pose(0, 0); await f.pose(1, 0.2);
  await f.send(0, { type: 'minigame-contact', target: 'p1' });
  assert.equal(f.game.data.round, 1);
  f.advance(100);
  await f.pose(0, 0, { flashlight: true, heading: [-1, 0, 0] });
  await f.send(0, { type: 'minigame-contact', target: 'p1' });
  assert.equal(f.game.data.round, 1);
  f.advance(100);
  await f.pose(0, 0, { flashlight: true });
  await f.send(0, { type: 'minigame-contact', target: 'p1' });
  assert.equal(f.game.data.round, 2);
  assert.deepEqual(f.game.data.scores, { red: 1, blue: -1 });
});

test('hide and seek protects hiding time, finds by contact and rotates seekers', async t => {
  const f = fixture(t);
  f.game.start('hide-seek');
  await f.pose(0); await f.pose(1);
  await f.send(0, { type: 'minigame-contact', target: 'p1' });
  assert.equal(f.game.data.roster.p1.found, false);
  f.advance(30000); await f.pose(0); await f.pose(1);
  await f.send(0, { type: 'minigame-contact', target: 'p1' });
  assert.equal(f.game.data.roster.p1.found, true);
  assert.equal(f.game.data.roster.p0.score, 1);
  assert.equal(f.game.data.phase, 'results');
  f.advance(8000);
  assert.equal(f.game.data.it, 'p1');
  assert.equal(f.game.data.phase, 'hiding');
  assert.equal(f.game.data.roster.p1.found, false);
});

test('winter race closes a full globe lap on the river and lake and rejects skipped checkpoints', async t => {
  const f = fixture(t, 1, true), course = iceRaceCourse();
  assert.equal(course.length, 13); // Twelve fixed sites; start is also finish.
  assert.deepEqual(course[0].map(n => Math.round(n * 1e8)), course.at(-1).map(n => Math.round(n * 1e8)));
  let longitude = 0;
  for (let i = 1; i < course.length; i++) {
    const gap = Math.hypot(...course[i].map((n, k) => n - course[i - 1][k])) * 20;
    assert.ok(gap > 5 && gap < 18, `widely spaced checkpoints: ${gap}`);
    let delta = Math.atan2(course[i][2], course[i][0]) - Math.atan2(course[i - 1][2], course[i - 1][0]);
    if (delta < -Math.PI) delta += Math.PI * 2;
    if (delta > Math.PI) delta -= Math.PI * 2;
    longitude += delta;
  }
  assert.ok(Math.abs(longitude - Math.PI * 2) < 1e-6);
  await f.send(0, { type: 'minigame-vote', mode: 'race', course: [] });
  assert.equal(f.game.data.iceRace, true);
  f.advance(5000);
  const report = p => f.send(0, { type: 'minigame-pose', position: p.map(n => n * 20), heading: [1, 0, 0], ice: true, skates: true });
  await report(course[10]);
  assert.equal(f.game.data.roster.p0.checkpoint, 0);
  f.game.poses.clear();
  const originalCourse = structuredClone(f.game.data.course);
  for (let i = 0; i < course.length; i++) {
    f.advance(3000); await report(course[i]);
    assert.equal(f.game.data.roster.p0.checkpoint, i + 1);
    for (let repeat = 0; repeat < 5; repeat++) { f.advance(100); await report(course[i]); }
    assert.equal(f.game.data.roster.p0.checkpoint, i + 1, 'Standing on a crossed flag cannot advance again');
    assert.deepEqual(f.game.data.course, originalCourse, 'Progress never creates or moves checkpoints');
  }
  assert.equal(f.game.data.roster.p0.checkpoint, course.length);
  assert.ok(f.game.data.roster.p0.finish > 0);
  assert.equal(f.game.data.phase, 'results');
});

test('winter race rejects land shortcuts and joining campers spectate the current race', async t => {
  const f = fixture(t, 2, true);
  f.game.start('race'); f.advance(5000);
  await f.pose(0, 0, { ice: false });
  assert.ok(f.messages.some(m => m.type === 'minigame-correction'));
  const late = { id: 'late', name: 'Late', ready: true };
  f.room.peers.set(late.id, late);
  await f.game.handle(late, { type: 'minigame-sync', active: true });
  assert.equal(f.game.data.roster.late.spectator, true);
  f.room.room.environment.winter = false;
  f.game.environmentChanged();
  assert.equal(f.game.data.mode, null);
});

test('sled checkpoints pause on dismount and resume only with sled and skate mode enabled', async t => {
  const f = fixture(t, 1, true);
  const course = [0, 0.1, 0.2, 0.3].map(a => [Math.sin(a), Math.cos(a), 0]);
  f.game.start('sledding', course); f.advance(5000);
  await f.pose(0, 0, { skates: true, sledding: false });
  assert.equal(f.game.data.roster.p0.checkpoint, 0);
  f.advance(100); await f.pose(0, 0, { skates: false, sledding: true });
  assert.equal(f.game.data.roster.p0.checkpoint, 0);
  f.advance(100); await f.pose(0, 0, { skates: true, sledding: true });
  assert.equal(f.game.data.roster.p0.checkpoint, 1);
  f.advance(1000); await f.pose(0, 0.1, { skates: false, sledding: false });
  assert.equal(f.game.data.roster.p0.checkpoint, 1);
  f.advance(100); await f.pose(0, 0.1, { skates: true, sledding: true });
  assert.equal(f.game.data.roster.p0.checkpoint, 2);
});

test('creations are bounded, persistent and cannot be deleted remotely or by another camper', async t => {
  const f = fixture(t);
  f.game.start('christmas'); await f.pose(0); await f.pose(1);
  await f.send(0, { type: 'minigame-build', kind: 'script', position: [0, 20, 0] });
  assert.equal(f.game.data.creations.length, 0);
  await f.send(0, { type: 'minigame-build', kind: 'lights', position: [0, 20, 0] });
  assert.equal(f.game.data.creations.length, 1);
  const id = f.game.data.creations[0].id;
  await f.send(1, { type: 'minigame-build', action: 'remove', id });
  assert.equal(f.game.data.creations.length, 1);
  f.game.end();
  const restored = new MinigameWorld(f.room);
  await restored.load();
  assert.equal(restored.data.creations[0].id, id);
  f.game.start('christmas'); await f.pose(0);
  await f.send(0, { type: 'minigame-build', action: 'remove', id });
  assert.equal(f.game.data.creations.length, 0);
});

test('snowballs need travel to grow, stay anchored after stacking, and are reclaimable after leaving', async t => {
  const f = fixture(t, 1, true);
  f.game.start('snowman'); await f.pose(0, 0, { snow: true });
  await f.send(0, { type: 'minigame-build', action: 'snowball' });
  const ball = f.game.data.creations[0];
  await f.send(0, { type: 'minigame-build', action: 'snowball' });
  assert.equal(ball.stage, 0);
  for (let i = 1; i <= 25; i++) { f.advance(100); await f.pose(0, i * 0.02, { snow: true }); }
  assert.equal(ball.growth, 1);
  await f.send(0, { type: 'minigame-build', action: 'snowball' });
  assert.equal(ball.stage, 1);
  const base = [...ball.base];
  f.advance(100); await f.pose(0, 0.52, { snow: true });
  assert.deepEqual(ball.base, base);
  f.game.end();
  assert.equal(ball.holder, null);
  f.game.start('snowman');
  await f.send(0, { type: 'minigame-build', action: 'snowball' });
  assert.equal(f.game.data.creations.length, 1);
  assert.equal(ball.holder, 'p0');
});

test('rolling snowballs publish compact motion deltas at pose cadence, not full room snapshots', async t => {
  const f = fixture(t, 1, true);
  f.game.start('snowman'); await f.pose(0, 0, { snow: true });
  await f.send(0, { type: 'minigame-build', action: 'snowball' });
  const start = f.messages.length;
  for (let i = 1; i <= 5; i++) { f.advance(120); await f.pose(0, i * 0.015, { snow: true }); }
  const updates = f.messages.slice(start);
  assert.equal(updates.filter(m => m.type === 'minigame-state').length, 0);
  const deltas = updates.filter(m => m.type === 'minigame-snowball');
  assert.equal(deltas.length, 5);
  assert.equal(deltas[0].id, f.game.data.creations[0].id);
  assert.ok(deltas[4].growth > deltas[0].growth);
  assert.ok(deltas.every(m => m.epoch === f.game.data.epoch && m.stage === 0 && m.holder === 'p0'));
});

test('hanging decoration anchors are bounded, sanitized and preserved by room storage', async t => {
  const f = fixture(t, 1);
  f.game.start('christmas'); await f.pose(0, 0);
  const anchors = [{ point: [-2, 21.5, 0], foot: null, ignored: 'strip me' }, { point: [2, 21.5, 0], foot: null }];
  await f.send(0, { type: 'minigame-build', kind: 'lights', position: [0, 20, 0], anchors });
  const object = f.game.data.creations[0];
  assert.deepEqual(object.anchors, anchors.map(({ point, foot }) => ({ point, foot })));
  const restored = new MinigameWorld(f.room); await restored.load();
  assert.deepEqual(restored.data.creations[0].anchors, object.anchors);
  for (const bad of [[], [anchors[0]], [...anchors, anchors[0]], [{ point: [40, 20, 0], foot: null }, anchors[1]],
    [{ point: [0, 21, 0], foot: [0, 17, 0] }, anchors[1]], [{ point: [0, 21, null], foot: null }, anchors[1]]]) {
    await f.send(0, { type: 'minigame-build', kind: 'lights', position: [0, 20, 0], anchors: bad });
    assert.equal(f.game.data.creations.length, 1);
  }
  await f.send(0, { type: 'minigame-build', kind: 'ornament', position: [0, 20, 0], anchors });
  assert.equal(f.game.data.creations.length, 1);
});

test('webs preserve a bounded set of real attachment corners instead of requiring only two endpoints', async t => {
  const f = fixture(t, 1);
  f.game.start('halloween'); await f.pose(0, 0);
  const anchors = [[-1, 21.5, 0], [1, 21.5, 0], [0, 20, 0]].map(point => ({ point, foot: null }));
  await f.send(0, { type: 'minigame-build', kind: 'web', position: [0, 20, 0], anchors });
  assert.deepEqual(f.game.data.creations[0].anchors, anchors);
  for (const invalid of [Array.from({ length: 9 }, (_, i) => ({ point: [i / 4 - 1, 21, 0], foot: null })),
    [...anchors, anchors[0]], [...anchors, { point: [0, 27, 0], foot: null }]]) {
    await f.send(0, { type: 'minigame-build', kind: 'web', position: [0, 20, 0], anchors: invalid });
    assert.equal(f.game.data.creations.length, 1);
  }
});

test('repeated and overlapping light spans are rejected while adjacent connections are allowed', async t => {
  const f = fixture(t, 1);
  f.game.start('christmas'); await f.pose(0, 0);
  const place = (a, b) => f.send(0, { type: 'minigame-build', kind: 'lights', position: [0, 20, 0],
    anchors: [{ point: [a, 21.7, 0], foot: null }, { point: [b, 21.7, 0], foot: null }] });
  await place(-1, 1);
  await place(-1, 1); await place(1, -1); await place(-0.5, 1.5);
  assert.equal(f.game.data.creations.length, 1);
  await place(1, 3);
  assert.equal(f.game.data.creations.length, 2);
  assert.ok(f.messages.some(m => m.type === 'minigame-notice' && m.message.includes('already lights')));
});

test('legacy freestanding strips also prevent duplicate placement on their recovered post tops', async t => {
  const f = fixture(t, 1);
  f.game.start('christmas'); await f.pose(0, 0);
  await f.send(0, { type: 'minigame-build', kind: 'lights', position: [0, 20, 0] });
  await f.send(0, { type: 'minigame-build', kind: 'lights', position: [0, 20, 0],
    anchors: [{ point: [-0.9, 21.7, 0], foot: null }, { point: [0.9, 21.7, 0], foot: null }] });
  assert.equal(f.game.data.creations.length, 1);
});

test('departure reassigns IT, removes ballots and ends a game without enough campers', async t => {
  const f = fixture(t, 3);
  f.game.start('tag');
  await f.game.disconnect(f.peers[0]);
  assert.equal(f.game.data.it, 'p1');
  await f.game.disconnect(f.peers[1]);
  assert.equal(f.game.data.mode, null);
});

test('ghost catching is night-only and ends at dawn without changing room time', async t => {
  const f = fixture(t, 1);
  f.room.room.environment = { hour: 12, at: Date.now(), rate: 0.04, paused: true };
  await f.send(0, { type: 'minigame-vote', mode: 'ghost-catching' });
  assert.equal(f.game.data.mode, null);
  assert.ok(f.messages.some(m => m.type === 'minigame-notice' && m.message.includes('only available at night')));
  f.room.room.environment.hour = 23;
  await f.send(0, { type: 'minigame-vote', mode: 'ghost-catching' });
  assert.equal(f.game.data.mode, 'ghost-catching');
  assert.equal(f.game.data.ghosts.length, 18);
  assert.equal(f.room.room.environment.hour, 23);
  f.advance(5000);
  assert.equal(f.game.data.phase, 'playing');
  f.room.room.environment = { hour: 5.99, at: Date.now(), rate: 0.04, paused: false };
  f.game.environmentChanged();
  f.advance(300);
  assert.equal(f.game.data.mode, null);
  assert.equal(f.game.data.ghosts.length, 0);
  assert.equal(ghostNight({ hour: 18, at: Date.now(), paused: true }).night, true);
  assert.equal(ghostNight({ hour: 6, at: Date.now(), paused: true }).night, false);
});

test('suction requires sustained in-range aim and awards one team point per captured ghost', async t => {
  const f = fixture(t, 2);
  f.room.room.environment = { hour: 23, at: Date.now(), rate: 0.04, paused: true };
  f.game.start('ghost-catching'); f.advance(5000);
  const ghost = f.game.data.ghosts[0];
  Object.assign(ghost, { at: Date.now(), latitude: 0, phase: 0, speed: 0 });
  await f.pose(0, Math.PI / 2, { vacuum: false });
  await f.send(0, { type: 'minigame-ghost-vacuum', target: ghost.id });
  assert.equal(f.game.ghostCaptures.size, 0);
  for (let i = 0; i < 7; i++) {
    f.advance(200); await f.pose(0, Math.PI / 2, { vacuum: true });
    await f.send(0, { type: 'minigame-ghost-vacuum', target: ghost.id });
    await f.pose(1, Math.PI / 2, { vacuum: true });
    await f.send(1, { type: 'minigame-ghost-vacuum', target: ghost.id });
    if (i < 6) assert.equal(f.game.data.scores.red, 0);
  }
  assert.equal(f.game.data.scores.red, 1);
  assert.equal(f.game.data.scores.blue, 0);
  assert.ok(ghost.hiddenUntil > Date.now());
  f.advance(200); await f.pose(1, Math.PI / 2, { vacuum: true });
  await f.send(1, { type: 'minigame-ghost-vacuum', target: ghost.id });
  assert.deepEqual(f.game.data.scores, { red: 1, blue: 0 });
});

test('ghost suction rejects range/aim/stale-epoch violations and interruption resets progress', async t => {
  const f = fixture(t, 1);
  f.room.room.environment = { hour: 23, at: Date.now(), rate: 0.04, paused: true };
  f.game.start('ghost-catching'); f.advance(5000);
  const ghost = f.game.data.ghosts[0];
  Object.assign(ghost, { at: Date.now(), latitude: 0, phase: 0, speed: 0 });
  await f.pose(0, 0, { vacuum: true });
  await f.send(0, { type: 'minigame-ghost-vacuum', target: ghost.id });
  assert.equal(f.game.ghostCaptures.size, 0);
  f.game.poses.clear(); f.advance(200);
  await f.pose(0, Math.PI / 2, { vacuum: true, heading: [-1, 0, 0] });
  await f.send(0, { type: 'minigame-ghost-vacuum', target: ghost.id });
  assert.equal(f.game.ghostCaptures.size, 0);
  f.advance(200); await f.pose(0, Math.PI / 2, { vacuum: true });
  await f.send(0, { type: 'minigame-ghost-vacuum', target: ghost.id, epoch: -1 });
  assert.equal(f.game.ghostCaptures.size, 0);
  await f.send(0, { type: 'minigame-ghost-vacuum', target: ghost.id });
  assert.equal(f.game.ghostCaptures.size, 1);
  f.advance(600); await f.pose(0, Math.PI / 2, { vacuum: false });
  assert.equal(f.game.ghostCaptures.size, 0);
  f.advance(200); await f.pose(0, Math.PI / 2, { vacuum: true });
  await f.send(0, { type: 'minigame-ghost-vacuum', target: ghost.id });
  f.advance(700);
  await f.send(0, { type: 'minigame-ghost-vacuum', target: ghost.id });
  assert.equal(f.game.ghostCaptures.size, 0, 'stale pose cannot continue capture');
  assert.equal(f.game.data.scores.red, 0);
});
