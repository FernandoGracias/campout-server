export class Room {
  constructor(state, env) {
    this.state = state;
    this.peers = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/info")) {
      const peerList = [];
      for (const [id, peer] of this.peers) {
        peerList.push({ id, name: peer.name, color: peer.color });
      }
      return Response.json({ peers: peerList });
    }

    return new Response("Not found", { status: 404 });
  }

  handleSession(ws) {
    ws.accept();
    let peerId = null;

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "join": {
          peerId = msg.id;
          this.peers.set(peerId, { ws, name: msg.name, color: msg.color, tentStyle: msg.tentStyle, tentColor: msg.tentColor });
          for (const [id, peer] of this.peers) {
            if (id !== peerId) {
              peer.ws.send(JSON.stringify({ type: "peer-joined", id: peerId, name: msg.name, color: msg.color, tentStyle: msg.tentStyle, tentColor: msg.tentColor }));
              ws.send(JSON.stringify({ type: "peer-joined", id, name: peer.name, color: peer.color, tentStyle: peer.tentStyle, tentColor: peer.tentColor }));
            }
          }
          break;
        }

        case "offer":
        case "answer":
        case "ice-candidate": {
          const target = this.peers.get(msg.target);
          if (target) {
            target.ws.send(JSON.stringify({ ...msg, from: peerId }));
          }
          break;
        }

        case "leave": {
          this.removePeer(peerId);
          peerId = null;
          break;
        }
      }
    });

    ws.addEventListener("close", () => {
      if (peerId) this.removePeer(peerId);
    });

    ws.addEventListener("error", () => {
      if (peerId) this.removePeer(peerId);
    });
  }

  removePeer(id) {
    this.peers.delete(id);
    for (const [, peer] of this.peers) {
      peer.ws.send(JSON.stringify({ type: "peer-left", id }));
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const path = url.pathname;

    if (path === "/create") {
      const roomId = Math.random().toString(36).substring(2, 8);
      const seed = Math.floor(Math.random() * 999999);
      return Response.json({ roomId, seed }, { headers: corsHeaders });
    }

    const match = path.match(/^\/room\/([a-z0-9]+)/);
    if (match) {
      const roomId = match[1];
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);

      if (url.pathname.endsWith("/info")) {
        const resp = await stub.fetch(request);
        return new Response(resp.body, { status: resp.status, headers: { ...Object.fromEntries(resp.headers), ...corsHeaders } });
      }

      if (request.headers.get("Upgrade") === "websocket") {
        return stub.fetch(request);
      }
    }

    return new Response("Campout Signaling Server", { headers: corsHeaders });
  },
};
