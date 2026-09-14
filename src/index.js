const MAX_PEERS = 100;
const MAX_MESSAGE_SIZE = 16384;
const TURN_TTL = 3600;
const TURN_REFRESH_MS = 50 * 60 * 1000;
const ROOM_IDLE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ORIGINS = new Set(["https://campout.team", "https://fernandogracias.github.io"]);
const encoder = new TextEncoder();

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Set();
    this.peers = new Map();
    this.room = null;
    this.state.blockConcurrencyWhile(async () => {
      this.room = await this.state.storage.get("room") || null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/internal/create" && request.method === "POST") {
      return this.state.blockConcurrencyWhile(async () => {
        if (this.room) return new Response("Room already exists", { status: 409 });
        this.room = { seed: crypto.getRandomValues(new Uint32Array(1))[0] % 999999 };
        await this.state.storage.put("room", this.room);
        await this.state.storage.setAlarm(Date.now() + ROOM_IDLE_MS);
        return Response.json(this.room);
      });
    }
    if (url.pathname === "/internal/exists") {
      return new Response(null, { status: this.room ? 200 : 404 });
    }
    if (!this.room) return new Response("Room does not exist", { status: 404 });
    if (!/^\/api\/room\/[a-f0-9]{12}$/.test(url.pathname)) return new Response("Not found", { status: 404 });
    if (request.method !== "GET" || request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    if (this.connections.size >= MAX_PEERS) return new Response("Room full", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server, request.headers.get("CF-Connecting-IP"));
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    await this.state.blockConcurrencyWhile(async () => {
      if (this.connections.size) {
        await this.state.storage.setAlarm(Date.now() + ROOM_IDLE_MS);
        return;
      }
      await this.state.storage.deleteAll();
      this.room = null;
    });
  }

  handleSession(ws, ip) {
    ws.accept();
    const peer = {
      ws, ip, id: crypto.randomUUID(), joined: false, ready: false,
      credentials: [], refreshAt: 0, lastMessage: Date.now(),
      messages: 600, bytes: 1048576, budgetAt: Date.now(), queue: Promise.resolve(),
    };
    this.connections.add(peer);
    peer.deadline = setTimeout(() => this.closePeer(peer, 1008, "Join timed out"), 15000);
    ws.addEventListener("message", event => {
      if (!this.connections.has(peer)) return;
      const now = Date.now();
      const elapsed = (now - peer.budgetAt) / 1000;
      peer.messages = Math.min(600, peer.messages + elapsed * 60) - 1;
      peer.bytes = Math.min(1048576, peer.bytes + elapsed * 131072);
      peer.budgetAt = now;
      if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE_SIZE) {
        this.closePeer(peer, 1008, "Invalid message size");
        return;
      }
      const size = encoder.encode(event.data).length;
      peer.bytes -= size;
      if (size > MAX_MESSAGE_SIZE || peer.messages < 0 || peer.bytes < 0) {
        this.closePeer(peer, 1008, "Signaling limit exceeded");
        return;
      }
      let msg;
      try { msg = JSON.parse(event.data); }
      catch { this.closePeer(peer, 1008, "Invalid JSON"); return; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.type !== "string") {
        this.closePeer(peer, 1008, "Invalid message");
        return;
      }
      peer.lastMessage = now;
      peer.queue = peer.queue.then(async () => {
        if (this.connections.has(peer)) await this.handleMessage(peer, msg);
      }).catch(error => {
        console.error("Room message failed", error.name, error.message);
        this.closePeer(peer, 1011, "Multiplayer service error");
      });
    });
    ws.addEventListener("close", () => this.removePeer(peer));
    ws.addEventListener("error", () => this.closePeer(peer, 1011, "Socket error"));
    return peer;
  }

  async handleMessage(peer, msg) {
    if (msg.type === "join") {
      if (peer.joined || !this.room) return this.closePeer(peer, 1008, "Invalid join");
      if (typeof msg.name !== "string" || msg.name.length > 32 ||
          typeof msg.color !== "string" || !/^[a-f0-9]{6}$/.test(msg.color) ||
          typeof msg.tentColor !== "string" || !/^[a-f0-9]{6}$/.test(msg.tentColor) ||
          !["aframe", "dome", "cabin", "tunnel"].includes(msg.tentStyle)) {
        return this.closePeer(peer, 1008, "Invalid player details");
      }
      peer.joined = true;
      Object.assign(peer, { name: msg.name, color: msg.color, tentStyle: msg.tentStyle, tentColor: msg.tentColor });
      this.peers.set(peer.id, peer);
      const credentials = await this.issueCredentials(peer);
      if (!credentials || !this.connections.has(peer)) return;
      clearTimeout(peer.deadline);
      peer.deadline = setTimeout(() => this.closePeer(peer, 1008, "Ready timed out"), 30000);
      this.send(peer, { type: "room-info", id: peer.id, seed: this.room.seed, serverTime: Date.now(), ...credentials });
      return;
    }
    if (!peer.joined || this.peers.get(peer.id) !== peer) return this.closePeer(peer, 1008, "Join required");
    if (msg.type === "ready") {
      if (peer.ready || !peer.refreshAt) return this.closePeer(peer, 1008, "Invalid ready");
      peer.ready = true;
      clearTimeout(peer.deadline);
      peer.idleTimer = setInterval(() => {
        if (Date.now() - peer.lastMessage > 120000) this.closePeer(peer, 1008, "Connection idle");
      }, 30000);
      this.send(peer, { type: "ready" });
      for (const other of this.peers.values()) {
        if (other !== peer && other.ready) {
          this.send(other, this.peerInfo(peer));
          this.send(peer, this.peerInfo(other));
        }
      }
      return;
    }
    if (!peer.ready) return this.closePeer(peer, 1008, "Ready required");
    if (msg.type === "ping") return this.send(peer, { type: "pong" });
    if (msg.type === "leave") return this.closePeer(peer, 1000, "Left room");
    if (msg.type === "turn-refresh") {
      if (Date.now() < peer.refreshAt) return this.closePeer(peer, 1008, "TURN renewal not due");
      const credentials = await this.issueCredentials(peer);
      if (credentials) this.send(peer, { type: "turn-creds", ...credentials });
      return;
    }
    if (!["offer", "answer", "ice-candidate", "restart-request"].includes(msg.type)) {
      return this.closePeer(peer, 1008, "Unknown message type");
    }
    if (typeof msg.target !== "string" || msg.target === peer.id) return this.closePeer(peer, 1008, "Invalid target");
    const target = this.peers.get(msg.target);
    if (!target || !target.ready) return;
    if (msg.type === "restart-request") {
      this.send(target, { type: msg.type, from: peer.id });
      return;
    }
    if (msg.type === "offer" || msg.type === "answer") {
      if (!msg.sdp || typeof msg.sdp !== "object" || msg.sdp.type !== msg.type ||
          typeof msg.sdp.sdp !== "string" || !msg.sdp.sdp) {
        return this.closePeer(peer, 1008, "Invalid session description");
      }
      this.send(target, { type: msg.type, from: peer.id, sdp: { type: msg.sdp.type, sdp: msg.sdp.sdp } });
      return;
    }
    const c = msg.candidate;
    if (!c || typeof c !== "object" || typeof c.candidate !== "string" || c.candidate.length > 2048 ||
        !(c.sdpMid === null || typeof c.sdpMid === "string" && c.sdpMid.length <= 256) ||
        !(c.sdpMLineIndex === null || Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex <= 65535) ||
        !(c.usernameFragment == null || typeof c.usernameFragment === "string" && c.usernameFragment.length <= 256)) {
      return this.closePeer(peer, 1008, "Invalid ICE candidate");
    }
    this.send(target, { type: "ice-candidate", from: peer.id, candidate: {
      candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex,
      usernameFragment: c.usernameFragment ?? null,
    } });
  }

  async issueCredentials(peer) {
    const { success } = await this.env.TURN_RATE_LIMITER.limit({ key: peer.ip });
    if (!success) {
      this.closePeer(peer, 1008, "TURN limit reached; wait a minute and reload");
      return null;
    }
    if (!this.connections.has(peer)) return null;
    const issuedAt = Date.now();
    const resp = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.env.TURN_KEY_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`TURN issuance failed: HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data.iceServers) || !data.iceServers.some(s => typeof s.username === "string" && typeof s.credential === "string")) {
      throw new Error("Invalid TURN provider response");
    }
    const expiresAt = issuedAt + TURN_TTL * 1000;
    const credentials = { iceServers: data.iceServers, expiresAt };
    if (!this.connections.has(peer)) {
      await this.revokeCredentials([credentials]);
      return null;
    }
    peer.credentials = peer.credentials.filter(c => c.expiresAt > issuedAt);
    peer.credentials.push(credentials);
    peer.refreshAt = issuedAt + TURN_REFRESH_MS;
    return { ...credentials, refreshAfterMs: Math.max(0, peer.refreshAt - Date.now()) };
  }

  async revokeCredentials(credentials) {
    const usernames = new Set(credentials.filter(c => c.expiresAt > Date.now()).flatMap(c =>
      c.iceServers.filter(s => typeof s.username === "string").map(s => s.username)));
    await Promise.all([...usernames].map(async username => {
      const resp = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/${encodeURIComponent(username)}/revoke`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.env.TURN_KEY_SECRET}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`TURN revocation failed: HTTP ${resp.status}`);
    }));
  }

  peerInfo(peer) {
    return { type: "peer-joined", id: peer.id, name: peer.name, color: peer.color, tentStyle: peer.tentStyle, tentColor: peer.tentColor };
  }

  send(peer, message) {
    if (this.connections.has(peer) && peer.ws.readyState === 1) peer.ws.send(JSON.stringify(message));
  }

  closePeer(peer, code, reason) {
    this.removePeer(peer);
    if (peer.ws.readyState === 1) peer.ws.close(code, reason);
  }

  removePeer(peer) {
    if (!this.connections.delete(peer)) return;
    clearTimeout(peer.deadline);
    clearInterval(peer.idleTimer);
    if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id);
    if (peer.ready) {
      for (const other of this.peers.values()) {
        if (other.ready) this.send(other, { type: "peer-left", id: peer.id });
      }
    }
    if (peer.credentials.length) this.state.waitUntil(this.revokeCredentials(peer.credentials));
    if (!this.connections.size) this.state.waitUntil(this.state.storage.setAlarm(Date.now() + ROOM_IDLE_MS));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (!ALLOWED_ORIGINS.has(origin)) return new Response("Forbidden", { status: 403 });
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) return new Response("Client address required", { status: 403, headers });
    if (url.pathname === "/api/create") {
      if (request.method !== "POST") return new Response("POST required", { status: 405, headers });
      const { success } = await env.CREATE_RATE_LIMITER.limit({ key: ip });
      if (!success) return new Response("Room creation limit reached", { status: 429, headers });
      const roomId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const resp = await stub.fetch(new Request("https://room/internal/create", { method: "POST" }));
      if (!resp.ok) return new Response("Room creation failed", { status: resp.status, headers });
      const { seed } = await resp.json();
      return Response.json({ roomId, seed }, { headers });
    }
    if (/^\/api\/room\/[a-f0-9]{12}$/.test(url.pathname)) {
      if (request.method !== "GET" || request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket required", { status: 426, headers });
      }
      const { success } = await env.JOIN_RATE_LIMITER.limit({ key: ip });
      if (!success) return new Response("Room join limit reached", { status: 429, headers });
      const roomId = url.pathname.split("/")[3];
      return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
    }
    if (/^\/api\/room\/[a-f0-9]{12}\/exists$/.test(url.pathname)) {
      if (request.method !== "GET") return new Response("GET required", { status: 405, headers });
      const roomId = url.pathname.split("/")[3];
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const resp = await stub.fetch(new Request("https://room/internal/exists"));
      return new Response(null, { status: resp.ok ? 200 : 404, headers });
    }
    return new Response("Not found", { status: 404, headers });
  },
};
