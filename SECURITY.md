# Anonymous multiplayer controls

Campout remains anonymous and uses direct-first WebRTC. These controls constrain
credential issuance and signaling abuse; they do not inspect encrypted TURN
traffic or impose a hard Cloudflare bandwidth/spending cap.

## Admission and credentials

- `POST /api/create` creates persistent room state and a cryptographically random
  12-character hexadecimal invitation code. The server selects the world seed.
- `GET /api/room/{code}` upgrades to a WebSocket only for a created room. There is
  no public room-info endpoint or standalone credential endpoint.
- Each socket must send one `join` with player appearance details. The server
  assigns its peer ID and issues credentials to that socket only, in `room-info`.
- The client installs the credentials, then sends `ready`. Only ready peers are
  announced or allowed to exchange signaling messages.
- Credentials last one hour. `turn-refresh` is permitted after 50 minutes on the
  same joined, ready socket. The client updates all peer connections and performs
  coordinated ICE restarts, while retaining `iceTransportPolicy: 'all'`.
- Disconnect cleanup requests revocation of all unexpired credentials issued to
  that socket. Credentials issued during a disconnect race are also revoked.
  Provider errors are surfaced in Worker logs; revocation is not a guaranteed
  instantaneous bandwidth cutoff. Abrupt Worker termination can bypass cleanup,
  in which case credential expiry remains the backstop.

Room membership does not authenticate a person: an automated client can still
create a room and keep a socket open. The additional controls below apply without
accounts or social login.

## Limits

| Resource | Limit |
| --- | --- |
| Room creation | 5/minute/IP |
| WebSocket connection attempts | 20/minute/IP |
| TURN issuance, including renewal | 5/minute/IP |
| Sockets per room, including unjoined sockets | 100 |
| Time to join | 15 seconds |
| Time to become ready after receiving credentials | 30 seconds |
| Silent ready connection | Closed after 120 seconds, checked every 30 seconds |
| Signaling message | 16 KiB UTF-8 |
| Per-socket signaling | 600-message burst, replenished at 60/second |
| Per-socket signaling bytes | 1 MiB burst, replenished at 128 KiB/second |
| Incoming game message, checked by each browser | 1,024 characters; 120-message burst, replenished at 60/second |

Cloudflare rate-limiting bindings are per-location and eventually consistent.
Shared-IP users share these limits. HTTP origin checks reduce cross-site browser
use but are not authentication: scripts can spoof the allowed origin.

Unoccupied rooms are deleted by a Durable Object alarm. Newly created rooms have
a 24-hour deadline; the last departure resets that deadline. An alarm firing
while the room is occupied postpones cleanup for another 24 hours.

## Validation and recovery

Only joined, ready sockets may signal ready peers in the same room. Relayed
identity always comes from the socket's server-assigned ID. Offer/answer objects
retain the WebRTC description format, with extra fields stripped. ICE candidates
and player appearance are bounded and validated. Duplicate joins, unknown message
types, malformed JSON, oversized messages, and flooding close the sender.

The browser serializes incoming negotiation operations, bounds queued ICE
candidates, rejects invalid game updates, and bounds outbound data-channel
buffering. Invalid SDP from one peer is isolated to that peer. Failed ICE can
request a restart from the deterministically selected initiator.

Socket loss stops renewal and disconnects multiplayer. The UI asks the player to
reload; automatic room rejoin is not implemented. A sleeping/backgrounded device
that cannot send heartbeats can therefore lose membership.

## Verification and deployment

```sh
npm test
node --test ../campout/networking.test.mjs
npx wrangler deploy --dry-run
```

The v110 client and this Worker must be released together. The old v109 handshake,
six-character rooms, `/create`, `/room/*`, and `/turn-creds` are incompatible with
the new protocol. Existing rooms are not migrated; testers should reload and
create fresh rooms. `wrangler.toml` includes all three rate-limiting bindings.
The existing `TURN_KEY_SECRET` Worker secret is still required and remains
server-side.

Browser integration was also checked using the real client, a local Workers
runtime, and Cloudflare relay credentials: direct and forced-relay connections,
remote player creation, accelerated renewal with different credentials, and peer
departure. Provider issuance/revocation calls in that local runtime were mocked;
actual Cloudflare relay transport was exercised. This does not replace a
post-deployment two-device test or a real hour-long session test.

## Minigame protocol

The ready handshake advertises `minigameProtocol: 1`. Minigame messages require
the same joined, ready socket as signaling, plus world-entry registration.
Votes use socket identities and current in-world membership, deduplicate votes,
require a strict majority and expire after 30 seconds. Cross-game actions carry
the current epoch. The room serializes transitions and computes scores itself.
Pose updates are finite/range-checked, limited to one per 70 ms and bounded for
travel speed. Other minigame commands have an additional 12-command burst budget
replenished at 6/second, inside the existing socket limits.

Contacts require fresh nearby poses and the correct role/team. Flashlight hits
also require the flashlight to be on and aimed at the target. Browsers check
terrain/prop occlusion; as with projectiles, a modified browser can falsify its
local simulation. This does not introduce server-side world geometry or account
authentication. Race progress advances only through ordered checkpoints. The ice
lap is generated by the server from the existing river's formula; client-built
land/sled courses have bounded point counts, coordinates, gaps and total length.

Creation kinds, placement range and count (100 per room) are bounded. Deletion
requires proximity plus creator identity or the world ownership token already
validated on join. Creation data persists separately from the transient round;
no client can supply a score, role, arbitrary creation ID or room state snapshot.
