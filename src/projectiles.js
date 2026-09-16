// Room-owned inventory and flights. Clients simulate terrain collisions; the
// room orders every launch/impact/pickup and persists the accepted result.
const MAX_SNOWBALLS = 100, MAX_PINECONES = 100;
const CHECKPOINT_PERSIST_MS = 5000;
const vector = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) < 10000);
const direction = p => p.map(n => n / Math.hypot(...p));
const validOrbit = o => o === null || (o && vector(o.normal) && Math.abs(Math.hypot(...o.normal) - 1) < 0.01 &&
  Number.isFinite(o.radialSpeed) && Math.abs(o.radialSpeed) <= 21 &&
  Number.isFinite(o.tangentSpeed) && o.tangentSpeed >= 3 && o.tangentSpeed <= 21 &&
  Number.isFinite(o.decayPerRadian) && o.decayPerRadian > 0 && o.decayPerRadian < 1);

export class ProjectileWorld {
  constructor(room) {
    this.room = room;
    this.data = { revision: 0, pinecones: null, projectiles: [] };
    this.queue = Promise.resolve();
    this.announcedAuthority = null;
    this.checkpointsDirty = false;
    this.checkpointTimer = null;
  }

  async load() {
    const storage = this.room.state.storage;
    const saved = await storage.get('projectileWorld');
    if (saved) {
      this.data = { revision: saved.revision, pinecones: saved.pinecones, projectiles: saved.projectiles || [] };
      if (saved.version === 2) {
        const chunks = await storage.get([0, 1, 2, 3].map(i => `projectileFlights${i}`));
        this.data.projectiles = [0, 1, 2, 3].flatMap(i => chunks.get(`projectileFlights${i}`) || []);
      }
    } else {
      // Preserve usable records from the previous format, assigning IDs once.
      const cones = await storage.get('pinecones');
      if (Array.isArray(cones)) this.data.pinecones = cones.slice(0, MAX_PINECONES).map(c =>
        c && vector(c.position) && Math.hypot(...c.position) > 1 ? { position: c.position, direction: direction(c.position), available: true, holder: null } : null);
      if (this.data.pinecones?.some(c => !c)) this.data.pinecones = null;
      const flights = await storage.get('orbiting');
      for (const p of Array.isArray(flights) ? flights : []) {
        if (!p || !['snowball', 'pinecone'].includes(p.kind) || !vector(p.position) || !vector(p.velocity) ||
            !p.orbit || !validOrbit(p.orbit) || !Number.isSafeInteger(p.launchTime)) continue;
        const cone = p.kind === 'pinecone' && this.data.pinecones?.[p.cone];
        if (p.kind === 'pinecone' && (!cone || !cone.available)) continue;
        if (p.kind === 'snowball' && this.data.projectiles.filter(p => p.kind === 'snowball').length >= MAX_SNOWBALLS) continue;
        if (cone) cone.available = false;
        this.data.projectiles.push({ id: crypto.randomUUID(), owner: p.owner || null, kind: p.kind, cone: cone ? p.cone : null,
          position: p.position, velocity: p.velocity, orbit: p.orbit, skyOrbit: true, launchTime: p.launchTime, step: 0, bounce: null });
      }
    }
    // A held item is not a flight. Release abandoned hands after a server wake.
    for (const c of this.data.pinecones || []) if (c.holder) { c.holder = null; c.available = true; }
    await this.persist();
  }

  run(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  async persist() {
    // Atomic multi-key write; 100 cones plus 100 detailed flights of each kind
    // must not exceed Durable Objects' per-value size limit in a single blob.
    const entries = { projectileWorld: { version: 2, revision: this.data.revision, pinecones: this.data.pinecones } };
    for (let i = 0; i < 4; i++) entries[`projectileFlights${i}`] = this.data.projectiles.slice(i * 50, (i + 1) * 50);
    await this.room.state.storage.put(entries);
    // Immediate world-event saves also include every checkpoint received so
    // far, so a pending checkpoint-only write is now redundant.
    this.checkpointsDirty = false;
    if (this.checkpointTimer !== null) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
  }
  scheduleCheckpointPersist() {
    this.checkpointsDirty = true;
    if (this.checkpointTimer !== null) return;
    // A fixed, non-sliding window: incoming batches update memory immediately
    // but cannot keep postponing durability by resetting this deadline.
    const timer = setTimeout(() => {
      this.room.state.waitUntil(this.run(async () => {
        // An immediate save may have superseded this timer while its callback
        // waited behind another room mutation in the serialized queue.
        if (this.checkpointTimer !== timer) return;
        this.checkpointTimer = null;
        if (this.checkpointsDirty) await this.persist();
      }).catch(error => {
        console.error('Projectile checkpoint persistence failed', error);
        if (this.checkpointsDirty) this.scheduleCheckpointPersist();
      }));
    }, CHECKPOINT_PERSIST_MS);
    this.checkpointTimer = timer;
  }
  authority() {
    return [...this.room.peers.values()].filter(p => p.ready && p.projectileActive &&
      Date.now() - p.projectileSeenAt < 15000).map(p => p.id).sort()[0] || null;
  }
  announceAuthority() {
    const authority = this.authority();
    if (authority === this.announcedAuthority) return;
    this.announcedAuthority = authority;
    this.broadcast({ type: 'projectile-authority', authority });
  }
  broadcast(message) {
    const event = { ...message, revision: this.data.revision, serverTime: Date.now() };
    for (const peer of this.room.peers.values()) if (peer.ready) this.room.send(peer, event);
  }
  snapshot(peer, clientTime = null) {
    this.room.send(peer, { type: 'projectile-state', ...this.data, authority: this.authority(), serverTime: Date.now(), clientTime });
  }
  async settleBounces() {
    const landed = this.data.projectiles.filter(p => p.bounce && p.bounce.startedAt + 450 <= Date.now());
    if (!landed.length) return;
    for (const p of landed) {
      const c = this.data.pinecones?.[p.cone];
      if (c) Object.assign(c, { position: p.bounce.to, direction: direction(p.bounce.to), available: true, holder: null, burningUntil: p.burningUntil || 0 });
    }
    const ids = new Set(landed.map(p => p.id));
    this.data.projectiles = this.data.projectiles.filter(p => !ids.has(p.id));
    this.data.revision++;
    await this.persist();
    for (const p of landed) this.broadcast({ type: 'projectile-land', id: p.id, cone: p.cone, position: p.bounce.to, burningUntil: p.burningUntil || 0 });
  }

  async handle(peer, msg) {
    await this.settleBounces();
    if (msg.type === 'projectile-heartbeat') {
      peer.projectileActive = msg.active === true; peer.projectileSeenAt = Date.now();
      this.announceAuthority();
      return;
    }
    if (msg.type === 'projectile-sync') {
      if (!this.data.pinecones && Array.isArray(msg.pinecones) && msg.pinecones.length > 0 &&
          msg.pinecones.length <= MAX_PINECONES && msg.pinecones.every(p => vector(p) && Math.hypot(...p) > 1)) {
        this.data.pinecones = msg.pinecones.map(position => ({ position, direction: direction(position), available: true, holder: null }));
        this.data.revision++;
        await this.persist();
        this.broadcast({ type: 'projectile-state', ...this.data, authority: this.authority() });
      }
      peer.projectileActive = msg.active === true; peer.projectileSeenAt = Date.now();
      this.snapshot(peer, Number.isSafeInteger(msg.clientTime) ? msg.clientTime : null);
      this.announceAuthority();
      return;
    }
    if (msg.type === 'pinecone-pickup') {
      const c = Number.isSafeInteger(msg.cone) && this.data.pinecones?.[msg.cone];
      if (!c || !c.available || this.data.pinecones.some(cone => cone.holder === peer.id)) {
        this.snapshot(peer); return;
      }
      c.available = false; c.holder = peer.id;
      this.data.revision++;
      await this.persist();
      this.broadcast({ type: 'pinecone-picked-up', cone: msg.cone, holder: peer.id, burningUntil: c.burningUntil || 0 });
      return;
    }
    if (msg.type === 'pinecone-release') {
      const c = Number.isSafeInteger(msg.cone) && this.data.pinecones?.[msg.cone];
      if (!c || c.holder !== peer.id) return;
      c.holder = null; c.available = true;
      this.data.revision++;
      await this.persist();
      this.broadcast({ type: 'projectile-land', id: null, cone: msg.cone, position: c.position, burningUntil: c.burningUntil || 0 });
      return;
    }
    if (msg.type === 'pinecone-ignite') {
      const c = Number.isSafeInteger(msg.cone) && this.data.pinecones?.[msg.cone];
      if (!c || c.holder !== peer.id || c.burningUntil > Date.now()) return;
      c.burningUntil = Date.now() + 30000;
      this.data.revision++;
      await this.persist();
      this.broadcast({ type: 'pinecone-ignited', cone: msg.cone, holder: peer.id, burningUntil: c.burningUntil });
      return;
    }
    if (msg.type === 'projectile-throw') {
      const d = msg.data;
      if (!d || typeof d.id !== 'string' || !/^[a-f0-9-]{36}$/.test(d.id) ||
          !['snowball', 'pinecone'].includes(d.kind) || !vector(d.position) || !vector(d.velocity) ||
          Math.hypot(...d.position) < 19 || Math.hypot(...d.position) > 30 ||
          Math.hypot(...d.velocity) < 2.99 || Math.hypot(...d.velocity) > 20.01 ||
          typeof d.skyOrbit !== 'boolean' || !validOrbit(d.orbit ?? null) ||
          d.skyOrbit !== !!d.orbit) {
        if (typeof d?.id === 'string') this.room.send(peer, { type: 'projectile-rejected', id: d.id });
        this.snapshot(peer); return;
      }
      if (this.data.projectiles.some(p => p.id === d.id)) { this.snapshot(peer); return; }
      const c = Number.isSafeInteger(d.cone) && this.data.pinecones?.[d.cone];
      if (d.kind === 'pinecone' && (!c || c.holder !== peer.id || this.data.projectiles.some(p => p.kind === 'pinecone' && p.cone === d.cone))) {
        this.room.send(peer, { type: 'projectile-rejected', id: d.id }); this.snapshot(peer); return;
      }
      const p = { id: d.id, owner: peer.id, kind: d.kind, cone: d.kind === 'pinecone' ? d.cone : null,
        burningUntil: d.kind === 'pinecone' ? c.burningUntil || 0 : 0,
        position: d.position, velocity: d.velocity, skyOrbit: d.skyOrbit, orbit: d.orbit ?? null,
        launchTime: Date.now(), step: 0, bounce: null };
      if (c && d.kind === 'pinecone') { c.holder = null; c.available = false; }
      this.data.projectiles.push(p);
      const removed = [];
      while (this.data.projectiles.filter(p => p.kind === 'snowball').length > MAX_SNOWBALLS) {
        const index = this.data.projectiles.findIndex(p => p.kind === 'snowball');
        removed.push(this.data.projectiles.splice(index, 1)[0].id);
      }
      this.data.revision++;
      await this.persist();
      // Include the sender: this is the authoritative launch timestamp and cap.
      this.broadcast({ type: 'projectile-throw', data: p, removed });
      return;
    }
    if (msg.type === 'projectile-checkpoint') {
      if (peer.id !== this.authority() || !Array.isArray(msg.projectiles) || msg.projectiles.length > 10) return;
      let changed = false;
      for (const d of msg.projectiles) {
        if (!d || typeof d.id !== 'string') continue;
        const p = this.data.projectiles.find(p => p.id === d.id);
        if (!p || p.bounce || !Number.isSafeInteger(d.step) || d.step <= p.step ||
            d.step > Math.floor((Date.now() - p.launchTime) * 0.06) + 3 ||
            !vector(d.position) || !vector(d.velocity) || !validOrbit(d.orbit ?? null) || !!d.orbit !== p.skyOrbit) continue;
        Object.assign(p, { position: d.position, velocity: d.velocity, orbit: d.orbit ?? null, step: d.step });
        changed = true;
      }
      if (changed) this.scheduleCheckpointPersist();
      return;
    }
    if (msg.type === 'projectile-impact') {
      if (peer.id !== this.authority() && msg.victim !== peer.id) return;
      const p = this.data.projectiles.find(p => p.id === msg.id);
      if (!p || p.bounce || !vector(msg.position) || !Number.isSafeInteger(msg.step) || msg.step < 1 ||
          msg.step > Math.floor((Date.now() - p.launchTime) * 0.06) + 3) return;
      if (p.kind === 'pinecone' && (!vector(msg.landing) || Math.hypot(...msg.landing) < 19 || Math.hypot(...msg.landing) > 30)) return;
      const bounce = p.kind === 'pinecone' ? { from: msg.position, to: msg.landing, startedAt: p.launchTime + msg.step * 1000 / 60 } : null;
      if (p.kind === 'pinecone' && msg.extinguish === true) {
        p.burningUntil = 0;
        if (this.data.pinecones?.[p.cone]) this.data.pinecones[p.cone].burningUntil = 0;
      }
      if (bounce) Object.assign(p, { bounce, step: msg.step, position: msg.position });
      else this.data.projectiles = this.data.projectiles.filter(other => other.id !== p.id);
      this.data.revision++;
      await this.persist();
      const occurredAt = p.launchTime + msg.step * 1000 / 60;
      const recent = Date.now() - occurredAt < 1000;
      this.broadcast({ type: 'projectile-impact', id: p.id, owner: p.owner, kind: p.kind, cone: p.cone,
        position: msg.position, bounce, occurredAt, burningUntil: p.burningUntil || 0,
        victim: recent && this.room.peers.has(msg.victim) ? msg.victim : null,
        tentOwner: recent && typeof msg.tentOwner === 'string' ? msg.tentOwner : null, step: msg.step });
      if (bounce) {
        await this.settleBounces();
        setTimeout(() => this.room.state.waitUntil(this.run(() => this.settleBounces())), 460);
      }
    }
  }

  async disconnect(peer) {
    const released = [];
    for (const [cone, c] of (this.data.pinecones || []).entries()) if (c.holder === peer.id) {
      c.holder = null; c.available = true; released.push({ cone, position: c.position, burningUntil: c.burningUntil || 0 });
    }
    if (released.length) {
      this.data.revision++; await this.persist();
      for (const c of released) this.broadcast({ type: 'projectile-land', id: null, ...c });
    } else if (!this.room.connections.size && this.checkpointsDirty) {
      // Save the latest flight state before the last connection leaves.
      await this.persist();
    }
    // Flight ownership is scoring metadata, never a lifetime dependency.
    this.announceAuthority();
  }
}
