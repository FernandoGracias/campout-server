// The room owns ballots, roles, rounds, checkpoints and shared creations.
// Terrain/line-of-sight are simulated by browsers, like projectile collisions;
// identity, timing, range, beam angle and score changes are validated here.
import { ghostNight, ghostPosition, makeGhosts } from './ghost-game.js';
const MODES = new Set(['tag', 'freeze-tag', 'hide-seek', 'sledding', 'race', 'christmas', 'halloween', 'snowman', 'flashlight-tag', 'ghost-catching']);
const TEAM_MODES = new Set(['freeze-tag', 'flashlight-tag']);
const ACTIVITIES = new Set(['christmas', 'halloween', 'snowman']);
const DECORATIONS = {
  christmas: ['lights', 'ornament', 'wreath', 'christmas-tree'],
  halloween: ['pumpkin', 'lantern', 'ghost', 'web'],
};
const vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const unit = v => vector(v) && Math.abs(Math.hypot(...v) - 1) < 0.01;
const point = v => vector(v) && Math.hypot(...v) >= 17 && Math.hypot(...v) <= 28;
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
const normal = v => v.map(n => n / Math.hypot(...v));
const surfaceDistance = (a, b) => distance(normal(a), normal(b)) * 20;
const polar = (lat, lon) => [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
function validAnchors(anchors, position, kind) {
  return ['lights', 'web'].includes(kind) && Array.isArray(anchors) && anchors.length >= 2 && anchors.length <= (kind === 'web' ? 8 : 2) &&
    anchors.every(a => a && point(a.point) && distance(a.point, position) <= 6 &&
      (a.foot === null || point(a.foot) && distance(a.foot, a.point) <= 2.5 && distance(a.foot, position) <= 6)) &&
    distance(anchors[0].point, anchors[1].point) >= 0.5 &&
    anchors.every((a, i) => anchors.slice(i + 1).every(b => distance(a.point, b.point) >= 0.12 && distance(a.point, b.point) <= 6.5));
}
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const subtract = (a, b) => a.map((n, i) => n - b[i]);
function lightEndpoints(object) {
  if (object.anchors) return object.anchors.map(a => a.point);
  const n = normal(object.position);
  const q = 1 + n[1] < Number.EPSILON ? [0, 0, 1, 0] : normal([n[2], 0, -n[0], 1 + n[1]]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return [-0.9, 0.9].map(x => {
    const v = [x, 1.7, 0], uv = cross(q, v), uuv = cross(q, uv);
    return v.map((value, i) => object.position[i] + value + 2 * (q[3] * uv[i] + uuv[i]));
  });
}
function duplicateLightSpan(candidate, creations) {
  const [a, b] = lightEndpoints(candidate), delta = subtract(b, a), length = Math.hypot(...delta);
  return creations.some(object => {
    if (object.kind !== 'lights') return false;
    const [c, d] = lightEndpoints(object);
    if (distance(a, c) < 0.35 && distance(b, d) < 0.35 || distance(a, d) < 0.35 && distance(b, c) < 0.35) return true;
    const vector = subtract(d, c), oldLength = Math.hypot(...vector);
    if (oldLength < 0.01 || length < 0.01) return false;
    const axis = vector.map(n => n / oldLength);
    if (Math.abs(dot(delta, axis) / length) < 0.96) return false;
    const ac = subtract(a, c), bc = subtract(b, c), start = dot(ac, axis), end = dot(bc, axis);
    if (Math.hypot(...ac.map((n, i) => n - start * axis[i])) > 0.35 || Math.hypot(...bc.map((n, i) => n - end * axis[i])) > 0.35) return false;
    return Math.min(oldLength, Math.max(start, end)) - Math.max(0, Math.min(start, end)) > Math.min(oldLength, length) * 0.4;
  });
}

// Matches world.js's existing circumnavigating river, including its meanders.
// Finish by crossing the main lake back to the river mouth, not over land.
export function iceRaceCourse() {
  const path = [];
  for (let i = 0; i <= 500; i++) {
    const t = i / 500;
    const lat = 0.8 - 0.6 * t + Math.sin(t * Math.PI * 6) * 0.2 + Math.sin(t * Math.PI * 14) * 0.08 + Math.sin(t * Math.PI * 3) * 0.12;
    const lon = 1.2 + Math.PI * 2 * t + Math.cos(t * Math.PI * 5) * 0.15 + Math.cos(t * Math.PI * 11) * 0.05 + Math.cos(t * Math.PI * 2.5) * 0.1;
    const p = polar(lat, lon);
    path.push(p);
  }
  const end = path.at(-1), start = path[0];
  const steps = Math.ceil(distance(end, start) * 20 / 1.65);
  for (let i = 1; i <= steps; i++) path.push(normal(end.map((n, k) => n + (start[k] - n) * i / steps)));
  // Twelve fixed flag sites, spaced by distance along the waterway. Choose
  // existing river samples rather than interpolating across its bends. The
  // thirteenth entry is the return to the shared start/finish flag after a lap.
  const lengths = [0];
  for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + distance(path[i - 1], path[i]) * 20);
  const course = [start];
  let index = 1;
  for (let checkpoint = 1; checkpoint < 12; checkpoint++) {
    const target = lengths.at(-1) * checkpoint / 12;
    while (lengths[index] < target) index++;
    course.push(path[target - lengths[index - 1] < lengths[index] - target ? index - 1 : index]);
  }
  course.push([...start]);
  return course;
}

function validCourse(course, mode) {
  if (!Array.isArray(course) || course.length < 3 || course.length > 96 || !course.every(unit)) return false;
  let length = 0;
  for (let i = 1; i < course.length; i++) {
    const gap = distance(course[i - 1], course[i]) * 20;
    if (gap < 0.35 || gap > 6) return false;
    length += gap;
  }
  return length >= (mode === 'sledding' ? 6 : 15) && length < 250;
}

export class MinigameWorld {
  constructor(room) {
    this.room = room;
    this.queue = Promise.resolve();
    this.timer = null;
    this.poses = new Map();
    this.ghostCaptures = new Map();
    this.data = { revision: 0, epoch: 0, mode: null, phase: 'idle', vote: null,
      roster: {}, scores: { red: 0, blue: 0 }, creations: [], course: [], ghosts: [], round: 0 };
  }
  async load() {
    const saved = await this.room.state.storage.get('minigameCreations');
    if (Array.isArray(saved)) this.data.creations = saved.slice(0, 100).filter(o =>
      o && typeof o.id === 'string' && point(o.position) &&
      [...Object.values(DECORATIONS).flat(), 'snowman'].includes(o.kind));
  }
  run(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  players() { return [...this.room.peers.values()].filter(p => p.ready && p.minigameActive); }
  send(peer, message) { this.room.send(peer, message); }
  snapshot(peer) { this.send(peer, { type: 'minigame-state', state: this.data, serverTime: Date.now() }); }
  publish(message = '') {
    this.data.revision++;
    for (const peer of this.room.peers.values()) if (peer.ready) {
      this.send(peer, { type: 'minigame-state', state: this.data, message, serverTime: Date.now() });
    }
    this.schedule();
  }
  reject(peer, message) { this.send(peer, { type: 'minigame-notice', message }); }
  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    const deadlines = [this.data.vote?.expiresAt,
      this.data.vote?.mode === 'ghost-catching' ? ghostNight(this.room.room.environment).sunrise : null,
      this.data.phase === 'countdown' || this.data.phase === 'hiding' ? this.data.startsAt : null,
      this.data.mode && !ACTIVITIES.has(this.data.mode) ? this.data.endsAt : null].filter(Number.isFinite);
    if (!deadlines.length) return;
    this.timer = setTimeout(() => {
      this.room.state.waitUntil(this.run(() => this.tick()).catch(error => console.error('Minigame timer failed', error)));
    }, Math.max(25, Math.min(...deadlines) - Date.now()));
  }
  tick() {
    const s = this.data, now = Date.now();
    if (s.vote && now >= s.vote.expiresAt) { s.vote = null; this.publish('Minigame vote expired.'); }
    const night = ghostNight(this.room.room.environment, now);
    if (s.vote?.mode === 'ghost-catching' && !night.night) { s.vote = null; this.publish('Ghost catching is only available at night (18:00–06:00).'); }
    if (!s.mode) return;
    if (s.mode === 'ghost-catching' && !night.night) return this.end(`Dawn! Ghost catching ended. Red ${s.scores.red} · Blue ${s.scores.blue}.`);
    if (['countdown', 'hiding'].includes(s.phase) && now >= s.startsAt) {
      s.phase = s.mode === 'hide-seek' ? 'seeking' : 'playing';
      s.endsAt = ['race', 'sledding'].includes(s.mode) ? now + 180000 : s.mode === 'hide-seek' ? now + 180000 : s.mode === 'ghost-catching' ? night.sunrise : null;
      this.publish(s.mode === 'hide-seek' ? 'Ready or not — the seeker is coming!' : 'Go!');
    }
    if (s.endsAt && now >= s.endsAt) {
      if (s.phase === 'results') {
        if (s.mode === 'hide-seek') this.newRound();
        else this.end();
      } else if (s.mode === 'hide-seek') {
        for (const [id, p] of Object.entries(s.roster)) if (id !== s.it && !p.found && !p.spectator) p.score++;
        s.phase = 'results'; s.endsAt = now + 8000;
        this.publish('Time is up. Unfound hiders each earn a point.');
      } else if (['race', 'sledding'].includes(s.mode)) this.finishRace('Time is up.');
    }
    this.schedule();
  }
  end(message = 'Back to camping.') {
    this.ghostCaptures.clear();
    this.releaseCreations();
    Object.assign(this.data, { mode: null, phase: 'idle', roster: {}, course: [], vote: null,
      it: null, iceRace: false, ghosts: [], startsAt: null, endsAt: null, epoch: this.data.epoch + 1 });
    this.publish(message);
  }
  releaseCreations(holder = null) {
    let changed = false;
    for (const object of this.data.creations) if (object.holder && (!holder || object.holder === holder)) {
      object.holder = null; changed = true;
    }
    if (changed) this.room.state.waitUntil(this.room.state.storage.put('minigameCreations', this.data.creations.map(o => ({ ...o, holder: null }))));
  }
  environmentChanged() {
    const s = this.data, winter = this.room.room.environment?.winter === true;
    if ((s.mode === 'sledding' || s.mode === 'snowman') && !winter || s.mode === 'race' && winter !== s.iceRace) this.end('The season changed. Back to camping.');
    if (s.mode === 'ghost-catching') {
      const night = ghostNight(this.room.room.environment);
      if (!night.night) return this.end(`Daylight! Ghost catching ended. Red ${s.scores.red} · Blue ${s.scores.blue}.`);
      s.endsAt = night.sunrise; this.publish();
    }
    if (s.vote?.mode === 'ghost-catching') this.tick();
  }
  member(peer, spectator = false) {
    const counts = { red: 0, blue: 0 };
    for (const p of Object.values(this.data.roster)) counts[p.team]++;
    const preferred = peer.minigameTeam === 'blue' ? 'blue' : 'red';
    const team = counts.red === counts.blue ? preferred : counts.red < counts.blue ? 'red' : 'blue';
    return { name: peer.name, team, frozen: false, found: false, spectator, score: 0, checkpoint: 0, finish: null, safeUntil: 0 };
  }
  start(mode, course) {
    if (mode === 'ghost-catching' && !ghostNight(this.room.room.environment).night) {
      this.data.vote = null; return this.publish('Ghost catching is only available at night (18:00–06:00).');
    }
    this.ghostCaptures.clear();
    this.releaseCreations();
    const s = this.data;
    const iceRace = mode === 'race' && this.room.room.environment?.winter === true;
    Object.assign(s, { mode, vote: null, scores: { red: 0, blue: 0 }, roster: {}, it: null,
      course: iceRace ? iceRaceCourse() : course || [], ghosts: mode === 'ghost-catching' ? makeGhosts(Date.now() + 5000) : [], iceRace, round: 0, epoch: s.epoch + 1 });
    for (const peer of this.players()) s.roster[peer.id] = this.member(peer);
    this.newRound();
  }
  newRound() {
    const s = this.data;
    s.round++;
    for (const p of Object.values(s.roster)) Object.assign(p, { frozen: false, found: false, spectator: false, checkpoint: 0, finish: null, safeUntil: 0 });
    const ids = Object.keys(s.roster).sort();
    if (s.mode === 'tag' || s.mode === 'hide-seek') s.it = ids[(s.round - 1) % ids.length];
    s.phase = ACTIVITIES.has(s.mode) ? 'playing' : s.mode === 'hide-seek' ? 'hiding' : 'countdown';
    s.startsAt = Date.now() + (s.mode === 'hide-seek' ? 30000 : 5000);
    s.endsAt = s.mode === 'ghost-catching' ? ghostNight(this.room.room.environment).sunrise : null;
    this.publish(s.phase === 'hiding' ? 'Hide! The seeker has 30 seconds to count.' : `Round ${s.round}${s.phase === 'countdown' ? ' starts in 5 seconds.' : ' started.'}`);
  }
  evaluateVote() {
    const vote = this.data.vote;
    if (!vote) return;
    const ids = this.players().map(p => p.id);
    vote.yes = vote.yes.filter(id => ids.includes(id));
    vote.eligible = ids;
    if (vote.yes.length <= ids.length / 2) return;
    if (vote.mode === 'camping') return this.end();
    if (ids.length < 2 && !ACTIVITIES.has(vote.mode) && !['race', 'sledding', 'ghost-catching'].includes(vote.mode)) {
      this.data.vote = null;
      return this.publish('This game needs at least two campers.');
    }
    this.start(vote.mode, vote.course);
  }
  async disconnect(peer) {
    this.releaseGhostCapture(peer.id);
    this.releaseCreations(peer.id);
    peer.minigameActive = false;
    this.poses.delete(peer.id);
    const s = this.data;
    delete s.roster[peer.id];
    if (!this.players().length) return this.end();
    this.evaluateVote();
    if (s.mode && !ACTIVITIES.has(s.mode) && !['race', 'sledding', 'ghost-catching'].includes(s.mode)) {
      if (Object.keys(s.roster).length < 2 || TEAM_MODES.has(s.mode) &&
          !['red', 'blue'].every(team => Object.values(s.roster).some(p => p.team === team))) return this.end('Not enough campers to continue.');
      if (s.it === peer.id) {
        s.it = Object.keys(s.roster).sort()[0];
        if (s.mode === 'hide-seek') this.newRound();
      }
      this.checkRound();
    }
    if (['race', 'sledding'].includes(s.mode) && s.phase === 'playing') this.checkFinish();
    this.publish();
  }
  async handle(peer, msg) {
    this.tick();
    const s = this.data, now = Date.now();
    if (msg.type === 'minigame-sync') {
      if (msg.active === true && !peer.minigameActive) {
        peer.minigameActive = true;
        peer.minigameTeam = ['red', 'blue'].includes(msg.team) ? msg.team : 'red';
        if (s.mode) s.roster[peer.id] = this.member(peer, ['race', 'sledding', 'hide-seek'].includes(s.mode));
        if (s.vote) s.vote.eligible = this.players().map(p => p.id);
        this.publish();
      }
      this.snapshot(peer);
      return;
    }
    if (!peer.minigameActive) return;
    if (msg.type === 'minigame-pose') return this.pose(peer, msg);
    if (!Number.isFinite(peer.minigameBudgetAt)) { peer.minigameBudgetAt = now; peer.minigameBudget = 12; }
    peer.minigameBudget = Math.min(12, peer.minigameBudget + (now - peer.minigameBudgetAt) / 1000 * 6);
    peer.minigameBudgetAt = now;
    if (peer.minigameBudget < 1) return;
    peer.minigameBudget--;
    if (msg.type === 'minigame-vote') {
      if (!MODES.has(msg.mode) && msg.mode !== 'camping') return;
      if (msg.mode === s.mode || msg.mode === 'camping' && !s.mode) return;
      if (s.vote && s.vote.mode !== msg.mode) return this.reject(peer, 'Finish the current vote first. Select its menu entry to vote yes.');
      if (msg.mode === 'ghost-catching' && !ghostNight(this.room.room.environment).night) return this.reject(peer, 'Ghost catching is only available at night (18:00–06:00).');
      if (msg.mode === 'sledding' || msg.mode === 'snowman') {
        if (!this.room.room.environment?.winter) return this.reject(peer, 'This activity needs winter. The world creator can enable it.');
      }
      if (!s.vote) {
        if (['race', 'sledding'].includes(msg.mode) && !(msg.mode === 'race' && this.room.room.environment?.winter) && !validCourse(msg.course, msg.mode)) {
          return this.reject(peer, 'No clear course here. Move to open ground and try again.');
        }
        s.vote = { mode: msg.mode, yes: [], eligible: this.players().map(p => p.id), expiresAt: now + 30000,
          course: ['race', 'sledding'].includes(msg.mode) && validCourse(msg.course, msg.mode) ? msg.course : [] };
      }
      if (!s.vote.yes.includes(peer.id)) s.vote.yes.push(peer.id);
      this.evaluateVote();
      this.publish(s.vote ? `${peer.name} voted. Open Mini Games to join the vote.` : '');
      return;
    }
    if (msg.epoch !== s.epoch || !s.mode || !s.roster[peer.id] || s.roster[peer.id].spectator) return;
    if (msg.type === 'minigame-contact') return this.contact(peer, msg.target);
    if (msg.type === 'minigame-build') return this.build(peer, msg);
    if (msg.type === 'minigame-ghost-vacuum') return this.vacuumGhost(peer, msg.target);
  }
  pose(peer, msg) {
    const now = Date.now(), old = this.poses.get(peer.id), s = this.data;
    if (!point(msg.position) || !unit(msg.heading) || old && now - old.at < 70) return;
    const member = s.roster[peer.id];
    // Countdown placement is the only permitted race teleport. Otherwise bound
    // displacement even after dropped packets, rather than accepting lap skips.
    const placing = s.phase === 'countdown' && ['race', 'sledding'].includes(s.mode);
    if (old && !placing && surfaceDistance(old.position, msg.position) > Math.min(30, (now - old.at) / 1000 * 12 + 0.8)) return;
    if (old && member && (member.frozen || member.found || s.mode === 'hide-seek' && s.it === peer.id && s.phase === 'hiding') &&
        surfaceDistance(old.position, msg.position) > 0.4) return;
    const pose = { position: [...msg.position], heading: [...msg.heading], at: now,
      flashlight: msg.flashlight === true, ice: msg.ice === true, skates: msg.skates === true, snow: msg.snow === true, sledding: msg.sledding === true, vacuum: msg.vacuum === true };
    this.poses.set(peer.id, pose);
    if (!pose.vacuum) this.releaseGhostCapture(peer.id);
    if (!member || member.spectator) return;
    if (['race', 'sledding'].includes(s.mode) && s.phase === 'playing' && member.finish === null) {
      if (s.mode === 'sledding' && (!pose.sledding || !pose.skates)) return;
      if (s.iceRace && (!pose.ice || !pose.skates)) {
        if (!member.offTrack) {
          member.offTrack = true;
          this.send(peer, { type: 'minigame-correction', epoch: s.epoch, position: s.course[Math.max(0, member.checkpoint - 1)], message: 'Stay on the ice with your skates on.' });
          this.poses.delete(peer.id);
        }
        return;
      }
      member.offTrack = false;
      const target = s.course[member.checkpoint];
      if (target && surfaceDistance(pose.position, target) <= (s.iceRace ? 1.3 : 1.5)) {
        member.checkpoint++;
        if (member.checkpoint === s.course.length) {
          member.finish = now - s.startsAt;
          this.publish(`${member.name} finished in ${(member.finish / 1000).toFixed(1)}s.`);
          this.checkFinish();
        } else this.publish();
      }
    }
    // Grow one claimed snowball from actual reported travel, not button presses.
    const ball = s.creations.find(o => o.kind === 'snowman' && o.holder === peer.id && !o.complete);
    if (s.mode === 'snowman' && ball && old && pose.snow && now - old.at < 1000) {
      ball.growth = Math.min(1, (ball.growth || 0) + surfaceDistance(old.position, pose.position) / 8);
      ball.position = normal(pose.position.map((n, i) => n + pose.heading[i] * 0.85)).map(n => n * Math.hypot(...pose.position));
      if (now - (ball.lastMotionAt || 0) >= 100) {
        ball.lastMotionAt = now;
        const event = { type: 'minigame-snowball', epoch: s.epoch, revision: ++s.revision, serverTime: now,
          id: ball.id, stage: ball.stage, holder: ball.holder, position: [...ball.position], growth: ball.growth };
        for (const other of this.room.peers.values()) if (other.ready) this.send(other, event);
      }
    }
  }
  contact(peer, targetId) {
    const s = this.data, now = Date.now();
    if (!['playing', 'seeking'].includes(s.phase) || typeof targetId !== 'string' || targetId === peer.id) return;
    const actor = s.roster[peer.id], target = s.roster[targetId];
    const a = this.poses.get(peer.id), b = this.poses.get(targetId);
    if (!actor || !target || actor.spectator || target.spectator || actor.frozen || actor.found || !a || !b ||
        now - a.at > 1500 || now - b.at > 1500 || target.safeUntil > now) return;
    const dist = surfaceDistance(a.position, b.position);
    const beam = s.mode === 'flashlight-tag' && actor.team !== target.team;
    if (beam) {
      if (!a.flashlight || dist > 9 || dist < 0.05) return;
      const toward = normal(b.position.map((n, i) => n - a.position[i]));
      if (toward.reduce((sum, n, i) => sum + n * a.heading[i], 0) < Math.cos(Math.PI * 0.1)) return;
    } else if (dist > 1.2) return;
    if (s.mode === 'tag' && s.it === peer.id) {
      s.it = targetId; target.safeUntil = now + 1800; actor.safeUntil = now + 1800;
      this.publish(`${target.name} is it!`);
    } else if (TEAM_MODES.has(s.mode)) {
      if (actor.team === target.team) {
        if (!target.frozen) return;
        target.frozen = false; target.safeUntil = now + 1500;
      } else {
        if (target.frozen) return;
        target.frozen = true;
      }
      this.publish(`${target.name} ${target.frozen ? 'is frozen!' : 'was thawed.'}`);
      this.checkRound();
    } else if (s.mode === 'hide-seek' && s.it === peer.id && !target.found) {
      target.found = true; actor.score++;
      this.publish(`${target.name} was found.`);
      this.checkRound();
    }
  }
  releaseGhostCapture(id, except = null) {
    for (const [ghost, capture] of this.ghostCaptures) if (capture.owner === id && ghost !== except) this.ghostCaptures.delete(ghost);
  }
  vacuumGhost(peer, targetId) {
    const s = this.data, now = Date.now();
    this.releaseGhostCapture(peer.id, targetId);
    const ghost = s.ghosts.find(g => g.id === targetId), pose = this.poses.get(peer.id), member = s.roster[peer.id];
    if (s.mode !== 'ghost-catching' || s.phase !== 'playing' || !ghostNight(this.room.room.environment, now).night ||
        !ghost || ghost.hiddenUntil > now || !pose?.vacuum || now - pose.at > 600 || !member || member.spectator) {
      this.releaseGhostCapture(peer.id); return;
    }
    const origin = pose.position.map((n, i) => n + normal(pose.position)[i] * 0.8);
    const toward = subtract(ghostPosition(ghost, now), origin), range = Math.hypot(...toward);
    if (range > 10 || range < 0.1 || dot(normal(toward), pose.heading) < 0.96) { this.releaseGhostCapture(peer.id); return; }
    let capture = this.ghostCaptures.get(targetId);
    if (capture && capture.owner !== peer.id && now - capture.last < 450) return;
    if (!capture || capture.owner !== peer.id || now - capture.last > 450) {
      capture = { owner: peer.id, since: now, last: now }; this.ghostCaptures.set(targetId, capture);
    }
    capture.last = now;
    if (now - capture.since < 1200) return;
    ghost.hiddenUntil = now + 12000;
    this.ghostCaptures.delete(targetId);
    s.scores[member.team]++; member.score++;
    this.publish(`${member.name} caught a ghost! ${member.team === 'red' ? 'Red' : 'Blue'} +1.`);
  }
  checkRound() {
    const s = this.data;
    if (TEAM_MODES.has(s.mode) && s.phase === 'playing') {
      for (const team of ['red', 'blue']) {
        const members = Object.values(s.roster).filter(p => p.team === team);
        if (members.length && members.every(p => p.frozen)) {
          const winner = team === 'red' ? 'blue' : 'red';
          s.scores[team]--; s.scores[winner]++;
          this.publish(`${winner === 'red' ? 'Red' : 'Blue'} wins the round: +1. ${team === 'red' ? 'Red' : 'Blue'}: −1.`);
          this.newRound();
          return;
        }
      }
    } else if (s.mode === 'hide-seek' && s.phase === 'seeking' &&
      Object.entries(s.roster).filter(([id, p]) => id !== s.it && !p.spectator).every(([, p]) => p.found)) {
      s.phase = 'results'; s.endsAt = Date.now() + 8000;
      this.publish('Everyone was found! The next camper will seek.');
    }
  }
  checkFinish() {
    if (Object.values(this.data.roster).filter(p => !p.spectator).every(p => p.finish !== null)) this.finishRace();
  }
  finishRace(prefix = '') {
    const s = this.data;
    const winner = Object.values(s.roster).filter(p => p.finish !== null).sort((a, b) => a.finish - b.finish)[0];
    s.phase = 'results'; s.endsAt = Date.now() + 12000;
    this.publish(`${prefix} ${winner ? `${winner.name} wins in ${(winner.finish / 1000).toFixed(1)}s!` : 'No finishers this round.'} Results are in Mini Games.`.trim());
  }
  async build(peer, msg) {
    const s = this.data, pose = this.poses.get(peer.id);
    if (!ACTIVITIES.has(s.mode) || !pose || Date.now() - pose.at > 1500) return;
    if (msg.action === 'remove') {
      const object = s.creations.find(o => o.id === msg.id);
      if (!object || object.owner !== peer.id && !peer.canEditWorld || surfaceDistance(pose.position, object.base || object.position) > 2) return;
      s.creations = s.creations.filter(o => o !== object);
    } else if (s.mode === 'snowman') {
      if (!this.room.room.environment?.winter || !pose.snow) return this.reject(peer, 'Build snowmen on snowy ground.');
      let ball = s.creations.find(o => o.kind === 'snowman' && o.holder === peer.id && !o.complete);
      if (ball) {
        if (ball.growth < 1) return this.reject(peer, 'Keep rolling to grow this snowball.');
        if (ball.base && surfaceDistance(pose.position, ball.base) > 2) return this.reject(peer, 'Roll back to the snowman to stack this ball.');
        if (!ball.base) ball.base = [...ball.position];
        if (ball.stage < 2) { ball.stage++; ball.growth = 0; }
        else { ball.complete = true; ball.holder = null; ball.position = [...ball.base]; }
      } else {
        const abandoned = s.creations.find(o => o.kind === 'snowman' && !o.complete && !o.holder && surfaceDistance(pose.position, o.position) < 2);
        if (abandoned) {
          abandoned.holder = peer.id;
          this.publish();
          return;
        }
        if (s.creations.length >= 100) return this.reject(peer, 'The world has 100 creations. Remove one to make room.');
        ball = { id: crypto.randomUUID(), kind: 'snowman', owner: peer.id, holder: peer.id, position: [...pose.position], stage: 0, growth: 0, complete: false };
        s.creations.push(ball);
      }
    } else {
      if (!DECORATIONS[s.mode]?.includes(msg.kind) || !point(msg.position) || surfaceDistance(pose.position, msg.position) > 2) return;
      if (msg.anchors !== undefined && !validAnchors(msg.anchors, msg.position, msg.kind)) return;
      if (msg.kind === 'lights' && duplicateLightSpan(msg, s.creations)) return this.reject(peer, 'There are already lights on that span. Choose another connection.');
      if (s.creations.length >= 100) return this.reject(peer, 'The world has 100 creations. Remove one to make room.');
      s.creations.push({ id: crypto.randomUUID(), kind: msg.kind, owner: peer.id, position: [...msg.position],
        ...(msg.anchors ? { anchors: msg.anchors.map(a => ({ point: [...a.point], foot: a.foot === null ? null : [...a.foot] })) } : {}) });
    }
    await this.room.state.storage.put('minigameCreations', s.creations.map(o => ({ ...o, holder: null })));
    this.publish();
  }
}
