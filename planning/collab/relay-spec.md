# attn Collaboration v2 — Relay Spec

This document is the contract for the Cloudflare relay (Worker + Durable Object + optional R2). The companion `data-model.md` defines the *client* data model. This document defines what the *server* sees, stores, and serves.

The server is an encrypted-envelope router with bounded storage and presence/signaling for WebRTC. It performs no markdown parsing, no merge, no decryption.

## Goals

- Route encrypted envelopes between participants of the same room.
- Carry WebRTC signaling between participants.
- Hold a bounded encrypted mailbox so async reviewers and offline owners stay in sync.
- Enforce hard caps so no room can become a hot DO or a hosting bill.
- Never see plaintext.

## Non-Goals

- Long-term storage. Rooms expire.
- Cross-room features. One DO per room.
- TURN. STUN only.
- Server-side decryption, indexing, or AI processing.
- Per-keystroke sync.

## Threat Model

The server is honest-but-curious. It may:

- count and time requests
- see source IPs
- see room ids, peer ids, device ids, envelope ids, envelope sizes
- see the SDP/ICE *frame envelope* (size, count, timing) but never plaintext SDP/ICE

The server must not:

- store, log, or echo any decrypted payload (it never has one)
- log any client-asserted plaintext metadata that is meant to stay end-to-end (`displayName`, `displayPath`, comment bodies, suggestion text — none of which transit the relay outside ciphertext anyway)

## Identity, Keys, and Admission

The relay does not issue identities. All identities are derived client-side from `roomSecret`.

### Admission Key

```text
admissionKey = hkdf-sha256(rootKey, info="attn relay admission v2", salt=empty)
```

Every authenticated request includes:

```http
Attn-Admission: v2.<base64url(hmac-sha256(admissionKey, canonicalRequest))>
```

`canonicalRequest` is:

```text
HTTP-METHOD || "\n" ||
URL-PATH    || "\n" ||
CANONICAL-QUERY || "\n" ||
SHA256(request-body)
```

The server:

- recomputes the HMAC using `admissionKey` derived from `roomId` lookup
- rejects on mismatch with `401 ATTN_ADMISSION_INVALID`

Note: `admissionKey` is per-room, derived from `roomSecret`, and the server only stores `roomId` (not `admissionKey` itself — it derives at request time from a server-side per-room secret? No: the server **cannot** derive `admissionKey` without `roomSecret`. Therefore the server stores `admissionKey` *publicly visible* by definition, and admission HMAC only proves the caller knows `admissionKey`. Equivalent to URL-as-bearer-token. **Decision required**: either accept this (admission HMAC is bookkeeping, not security beyond URL secrecy) and document the threat model accordingly, or move to per-device tokens issued at room creation. See `crypto-spec.md` §Admission.)

### Owner Distinction

`POST /v2/rooms/:roomId` (room creation) includes the owner's public signing key in the body. The DO stores this as `ownerSigningKeyId`. All privileged ops (`POST /acks`, `DELETE /v2/rooms/:roomId`) require an additional `Attn-Owner-Signature` header carrying an Ed25519 signature over the same `canonicalRequest`, verifiable against `ownerSigningKeyId`.

This is the **only** server-side distinction between owner and reviewer.

## Wire Conventions

- All bodies are JSON with `Content-Type: application/json; charset=utf-8`.
- All opaque byte fields are **base64url without padding**.
- All timestamps are unix milliseconds, integer, server-stamped where present in responses; client-asserted timestamps in `MailboxEnvelope.createdAt` are not trusted for TTL.
- Errors are:
  ```json
  { "error": { "code": "ATTN_ROOM_STORAGE_FULL", "message": "...", "retryAfterMs": 30000 } }
  ```
- Status codes: `400` malformed, `401` admission failed, `403` owner sig required/wrong, `404` no room or stale cursor with no recoverable position, `410` cursor too old (resync required), `413` body too large, `429` rate limited, `507` room storage cap reached.

## HTTP API

### `GET /health`

```json
{
  "status": "ok",
  "build": "<commit-sha>",
  "ts": 1736012345678
}
```

No auth.

### `POST /v2/rooms/:roomId`

Create or rejoin a room. Idempotent on `roomId`.

Request:

```json
{
  "v": 2,
  "policy": {
    "mode": "live" | "async" | "hybrid",
    "maxPeers": 8,
    "maxSnapshotBytes": 5242880,
    "maxEventBytes": 262144,
    "maxEvents": 500,
    "expiresAt": 1736617145678,
    "deleteEventsAfterOwnerAck": true,
    "allowBrowser": false,
    "allowRemoteAgents": false
  },
  "ownerSigningKey": "<base64url Ed25519 public key>"
}
```

Behavior:

- If the room does not exist, create the DO, persist the policy and `ownerSigningKey`. Caps in the policy are clamped to the server's hard maxima (defined below). Return `201`.
- If the room exists, ignore the body and return the stored policy as `200`. **Do not** allow policy mutation after creation; that would let a stolen URL extend a room's TTL.
- Requires admission HMAC.

Response:

```json
{
  "roomId": "...",
  "createdAt": 1736012345678,
  "expiresAt": 1736617145678,
  "policy": { /* server-clamped values */ },
  "ownerSigningKeyId": "<base64url SHA-256 of ownerSigningKey>",
  "serverSeq": 0
}
```

### `POST /v2/rooms/:roomId/devices`

Publish the caller's device public keys. Devices are advisory metadata; the server stores them and serves them via the peer list so peers can verify event signatures.

Request:

```json
{
  "deviceId": "<client-chosen string, max 64 chars>",
  "participantId": "<client-chosen string, max 64 chars>",
  "publicSigningKey": "<base64url Ed25519>",
  "publicEncryptionKey": "<base64url X25519>",
  "client": "attn-native" | "attn-browser" | "agent-cli",
  "kind": "owner" | "reviewer" | "agent",
  "selfSignature": "<base64url Ed25519 signature over the canonical body without selfSignature>"
}
```

Behavior:

- Verify `selfSignature` against `publicSigningKey`. Reject `400 ATTN_DEVICE_SELF_SIG_INVALID` on failure.
- If `kind == "owner"`, the `publicSigningKey` must equal `ownerSigningKey` stored at creation. Reject `403 ATTN_OWNER_KEY_MISMATCH` otherwise. This is what makes "owner" cryptographically meaningful.
- Upsert by `(participantId, deviceId)`. Reject `409 ATTN_DEVICE_KEY_CHANGED` if an existing record has a different `publicSigningKey` for the same `(participantId, deviceId)` — the trust-on-first-use binding is immutable for the life of the room.
- Requires admission HMAC.

Response: `204 No Content`.

### `GET /v2/rooms/:roomId/devices`

Returns the peer list with published keys.

```json
{
  "devices": [
    {
      "deviceId": "...",
      "participantId": "...",
      "publicSigningKey": "...",
      "publicEncryptionKey": "...",
      "client": "attn-native",
      "kind": "owner",
      "registeredAt": 1736012345678
    }
  ]
}
```

Requires admission HMAC. Returned in registration order.

### `POST /v2/rooms/:roomId/envelopes`

Upload one or more encrypted envelopes.

Request:

```json
{
  "envelopes": [
    {
      "envelopeId": "<client-chosen, must be deterministic; see crypto-spec.md>",
      "authorId": "<participantId>",
      "deviceId": "<deviceId>",
      "kind": "event" | "snapshot_blob" | "signal",
      "target": null | { "deviceId": "..." },
      "createdAt": 1736012345678,
      "expiresAt": 1736617145678,
      "nonce": "<base64url>",
      "ciphertext": "<base64url>",
      "ciphertextBytes": 4321
    }
  ]
}
```

Behavior:

- Requires admission HMAC.
- Per-envelope checks:
  - `ciphertextBytes` must equal `len(ciphertext bytes after base64url decode)`. Reject `400 ATTN_CIPHERTEXT_LENGTH_MISMATCH`.
  - `ciphertextBytes` must be ≤ `policy.maxEventBytes` for `kind == "event" | "signal"`, ≤ `policy.maxSnapshotBytes` for `kind == "snapshot_blob"`. Reject `413 ATTN_ENVELOPE_TOO_LARGE`.
  - `authorId` and `deviceId` must reference a published device record (call `POST /devices` first). Reject `400 ATTN_DEVICE_UNREGISTERED`.
- Per-room running totals (envelope count, bytes) updated atomically.
- If `running.envelopeCount + new > policy.maxEvents`, reject the *whole batch* `507 ATTN_ROOM_EVENT_CAP`.
- If `running.bytes + sum > policy.maxRoomBytes`, reject the *whole batch* `507 ATTN_ROOM_STORAGE_FULL`. (Hard cap, not policy-overridable.)
- Idempotency: if `envelopeId` already exists in the room, treat as success without storing a second copy. Response `serverSeq` for the duplicate is the previously assigned value.
- `kind == "signal"` envelopes are short-lived. They are forwarded over the WebSocket to the target device (or broadcast if `target == null`) and **also** stored if the target is offline. Signal envelopes have their own sub-cap: `maxSignalEnvelopes = 64` per `(authorId, target.deviceId)` pair, FIFO-evicted.
- `kind == "snapshot_blob"` with `ciphertextBytes > 1 MiB`: see R2 spillover below.

Response:

```json
{
  "accepted": [
    { "envelopeId": "...", "serverSeq": 42 }
  ]
}
```

`serverSeq` is monotonically increasing across the *room* and assigned at insert time.

### `GET /v2/rooms/:roomId/envelopes?after=<serverSeq>&limit=<n>`

Long-poll for new envelopes after a cursor.

Behavior:

- Requires admission HMAC.
- `limit` defaults to 100, max 500.
- If `after` is ≥ current `serverSeq`, the server holds the connection open for up to 25 seconds and returns when new envelopes arrive or on timeout.
- If `after < oldestRetainedSeq` (the cursor refers to an envelope already TTL-deleted), respond `410 ATTN_CURSOR_TOO_OLD` with:
  ```json
  { "error": { "code": "ATTN_CURSOR_TOO_OLD", "resyncFromSeq": <oldestRetainedSeq> } }
  ```
  Clients respond by discarding their cursor and requesting a snapshot from a peer (or, in async mode, by re-pulling from `resyncFromSeq` and accepting that some history is gone forever).
- Response:
  ```json
  {
    "envelopes": [ /* same shape as upload */ ],
    "nextCursor": 142,
    "hasMore": false
  }
  ```

Pulls do not filter by `kind`. Clients ignore envelopes they don't care about.

### `POST /v2/rooms/:roomId/acks`

Acknowledge delivery; optionally request deletion.

Request:

```json
{
  "ackedEnvelopeIds": ["...", "..."],
  "deviceId": "..."
}
```

Headers:

- `Attn-Admission` required.
- `Attn-Owner-Signature` required **if and only if** `policy.deleteEventsAfterOwnerAck == true` and the client wants envelopes deleted. Without it, ACK is recorded but envelopes are retained until TTL.

Behavior:

- Mark envelopes as ACKed by `deviceId`. Multiple devices may ACK independently.
- If owner signature present and policy allows deletion:
  - Delete envelopes ACKed by *any* owner device. (Owner has multiple devices; once the owner has the bits anywhere, the server may drop them. Cross-device replication is the owner's problem — see `amendments.md` §Multi-device.)
- Idempotent. Acking a non-existent or already-deleted envelope is `204`.

Response: `204 No Content`.

### `DELETE /v2/rooms/:roomId`

End the room immediately.

- Requires admission HMAC + `Attn-Owner-Signature`.
- Deletes the DO state, the WebSocket clients are disconnected with close code `4001`, R2 blobs for this room are scheduled for deletion (best-effort, may lag).
- Response `204`.

### `POST /v2/rooms/:roomId/blobs` (R2 spillover)

Used when `kind == "snapshot_blob"` and `ciphertextBytes > 1 MiB`.

Request:

```json
{
  "envelopeId": "...",
  "authorId": "...",
  "deviceId": "...",
  "ciphertextBytes": 3145728
}
```

Server response:

```json
{
  "uploadUrl": "https://<r2-presigned>",
  "method": "PUT",
  "headers": { "Content-Type": "application/octet-stream" },
  "expiresAt": 1736012945678,
  "blobKey": "rooms/<roomId>/blobs/<envelopeId>"
}
```

Client uploads the raw ciphertext bytes directly to R2 via the presigned URL.

After successful upload, the client `POST /envelopes` with the **same** `envelopeId` and a small payload:

```json
{
  "envelopes": [
    {
      "envelopeId": "...",
      "kind": "snapshot_blob",
      ...
      "ciphertext": "<base64url BlobRef serialization>",
      "ciphertextBytes": <small>
    }
  ]
}
```

i.e. the *envelope row* in the DO holds an encrypted `BlobRef` pointing to R2; the bulk bytes live in R2.

Reads use a presigned `GET` URL fetched via `GET /v2/rooms/:roomId/blobs/:envelopeId`.

## WebSocket Protocol

URL: `wss://relay/v2/rooms/:roomId/socket?device_id=:deviceId`

Subprotocol: `attn.v2`

Admission HMAC is passed via `Sec-WebSocket-Protocol` as a second protocol value: `attn.v2, hmac.<base64url HMAC>`. (Browsers don't allow custom headers on WS handshake.)

All frames are JSON text frames. Binary frames are reserved.

### Server → Client Frames

```ts
type ServerFrame =
  | {
      type: "hello";
      serverSeq: number;
      policy: RoomPolicy;
      devices: DeviceRecord[];
      missedSignalEnvelopeIds: string[];
    }
  | {
      type: "envelope";
      envelope: MailboxEnvelope;
      serverSeq: number;
    }
  | {
      type: "presence";
      event: "join" | "leave";
      deviceId: string;
      participantId: string;
    }
  | {
      type: "policy_changed";
      policy: RoomPolicy;
    }
  | {
      type: "ping";
      ts: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };
```

### Client → Server Frames

```ts
type ClientFrame =
  | {
      type: "subscribe";
      after: number;
    }
  | {
      type: "pong";
      ts: number;
    };
```

### Close Codes

- `1000` normal close
- `4000` admission HMAC invalid
- `4001` room deleted
- `4002` room expired
- `4003` rate limit on socket (too many frames/sec)
- `4004` peer cap reached for kind (e.g., trying to connect a 9th peer when cap is 8)

### Flow

1. Client opens WS, sends `subscribe { after: lastSeenServerSeq }`.
2. Server sends `hello`, then any backfill envelopes (still subject to `410` semantics — if `after` is too old, server sends `error { code: "ATTN_CURSOR_TOO_OLD" }` and closes `4001`-style).
3. Server pushes `envelope` and `presence` frames as they happen.
4. Server sends `ping` every 30s; if no `pong` within 60s, close `1001`.
5. The DO uses WebSocket Hibernation: when no traffic for 60s, the DO hibernates, and frames are resumed transparently on the next event.

### Signaling

WebRTC signaling rides on the `envelope` frame with `kind: "signal"`. Signal envelopes are E2E-encrypted with `signalingKey`. The relay only sees the encrypted blob plus the `target.deviceId` routing tag.

Client behavior:

- Owner publishes their device. Reviewer publishes theirs. Both join the WS.
- Reviewer wants to dial owner: client constructs an offer-bearing envelope:
  ```text
  cleartext = canonical({ kind: "offer", sdp, ice: [], from: deviceId })
  ciphertext = AEAD-encrypt(signalingKey, nonce, cleartext)
  envelope = { kind: "signal", target: { deviceId: <ownerDeviceId> }, ciphertext, ... }
  ```
  uploads via `POST /envelopes`, server forwards to owner's WS.
- Trickle ICE: more signal envelopes with `kind: "ice"` and an array of candidates.
- Owner replies with `kind: "answer"`.
- Connection established → DataChannel takes over → no more signal envelopes for that pair.

The server does not parse signal envelopes. It only routes by `target.deviceId`.

## Durable Object Design

One DO per room. Naming: `env.RELAY_ROOMS.idFromName(roomId)`.

### Storage Layout (using DO Storage API + optional SQLite-backed DO)

Keys (lexicographic ordering matters for range scans):

```text
meta:policy                     -> RoomPolicy JSON
meta:owner_signing_key          -> base64url Ed25519 pubkey
meta:created_at                 -> u64 ms
meta:expires_at                 -> u64 ms
meta:server_seq                 -> u64 monotonic counter
meta:bytes_used                 -> u64
meta:envelope_count             -> u64
meta:oldest_retained_seq        -> u64 (advances on TTL deletes)

device:<deviceId>               -> DeviceRecord JSON
device_order:<registeredAt>:<deviceId> -> "" (secondary index for ordered list)

env:<paddedServerSeq>:<envelopeId> -> Envelope JSON
env_idx:<envelopeId>            -> paddedServerSeq (for dedupe lookup)
env_by_target:<deviceId>:<paddedServerSeq>:<envelopeId> -> "" (signal routing aid)

ack:<deviceId>:<envelopeId>     -> u64 ackedAt
ack_owner:<envelopeId>          -> "" (presence indicates owner-acked)

rate:<deviceId>:<windowStartMin> -> u32 count
```

`paddedServerSeq` is `serverSeq.toString().padStart(20, '0')` to keep lexicographic ordering correct.

### serverSeq Allocation

```ts
const next = (await this.state.storage.get("meta:server_seq")) ?? 0;
const assigned = next + 1;
await this.state.storage.put({
  "meta:server_seq": assigned,
  [`env:${pad(assigned)}:${envelopeId}`]: envelope,
  [`env_idx:${envelopeId}`]: pad(assigned),
});
return assigned;
```

The `put` is atomic across keys within a single DO event, so `server_seq` can never go backward and envelopes can never be stored without an index entry.

### Alarms (TTL + Idle Cleanup)

- On room creation, set an alarm at `expiresAt`.
- On each envelope insert, optionally also set a per-day "sweep" alarm to advance `oldest_retained_seq` and drop expired signal envelopes.
- On alarm firing at `expiresAt`: send `4002 room expired` close to all WS clients, delete all storage, schedule R2 blob deletion via a queue or a simple `list + delete` against the `rooms/<roomId>/` prefix.

### Hibernation Tags

Each accepted WebSocket gets `state.acceptWebSocket(ws, [deviceId, participantId])`. The hibernation handler reads the tags to route incoming envelopes without de-serializing peer maps.

## Caps (Server Hard Maxima)

These clamp anything in `policy`:

| Cap | Hard Max | Notes |
|---|---|---|
| `maxPeers` | 8 | Enforced on WS connect |
| `maxSnapshotBytes` | 5 MiB | Per `snapshot_blob` envelope |
| `maxEventBytes` | 256 KiB | Per `event` or `signal` envelope |
| `maxEvents` | 500 | Across all kinds in the room |
| `maxRoomBytes` | 25 MiB | Sum of all envelope ciphertext bytes (DO+R2) |
| `maxSignalEnvelopes` | 64 | Per `(authorId, targetDeviceId)` pair, FIFO-evicted |
| `expiresAt - createdAt` | 7 days (`hybrid`/`async`), 4 hours (`live`) | Server clamps |
| Per-device request rate | 120/min | Sliding 60s window, counted per HTTP and WS frame |
| Per-IP request rate (Worker edge) | 600/min | Pre-DO, prevents enumeration of room URLs |

Rate limit responses: `429` with `retryAfterMs` header AND in the JSON error body.

## R2 Integration

- Bucket: one bucket, prefix per room: `rooms/<roomId>/blobs/<envelopeId>`.
- Upload via presigned PUT URL (15-minute TTL).
- Read via presigned GET URL (5-minute TTL), fetched per access.
- Lifecycle rule on the bucket: auto-delete objects older than 30 days as a safety net (in case the DO alarm deletion is missed). Should never fire in practice.
- Byte accounting: the DO tracks total room bytes by counting *envelope* `ciphertextBytes`, which for R2-spilled envelopes is the small BlobRef wrapper. The *actual* R2 bytes are tracked separately in `meta:bytes_used_r2`. Both must stay under `maxRoomBytes` combined.

## Anti-Abuse

- The URL is the bearer token. Anyone who learns the URL gets admission.
- Worker-edge rate limit on `roomId` enumeration: any caller hitting > 30 distinct unknown rooms in 5 minutes is `429`'d at the edge.
- All `POST /envelopes` traffic counted toward per-device rate; the per-device key is `deviceId` from the request body (trusted only within a single room's blast radius).
- Proof-of-work: **not in v2**. If abuse becomes real, add `Attn-PoW: <hashcash>` requirement to `POST /devices` and `POST /envelopes` keyed off `roomId`.
- IP logging: source IPs are logged for 24h for abuse mitigation, then dropped. Document this publicly.

## Schema Versioning

- Every request and envelope carries `v`.
- Server rejects `v != 2` with `400 ATTN_VERSION_UNSUPPORTED` on HTTP.
- Envelopes with unknown `v` *inside* `MailboxEnvelope` are accepted (server is content-agnostic) but counted against caps as usual.
- Future major versions get a new path prefix (`/v3/...`).

## Observability

Per-room metrics emitted (Workers Analytics or similar):

- `attn.room.envelopes.count` (gauge)
- `attn.room.bytes.used` (gauge)
- `attn.room.devices.count` (gauge)
- `attn.room.requests.rate` (counter, tagged by endpoint)
- `attn.room.errors` (counter, tagged by code)
- `attn.relay.r2.bytes` (counter, tagged by op=put/get/delete)

Logs:

- Structured JSON, no ciphertext, no `nonce`, no envelopeId in the message body (only as a tag for correlation).
- Fields allowed: `ts`, `roomId`, `deviceId`, `kind`, `serverSeq`, `bytes`, `code`, `latencyMs`.
- IP retained 24h then dropped.

Alerts:

- Any room exceeding 80% of `maxRoomBytes` for > 1h → operator notification.
- Per-room rate > 10x cap (suggests abuse).
- DO error rate > 1% over 5m.

## Browser Considerations

When `policy.allowBrowser == true`:

- CORS: `Access-Control-Allow-Origin: https://attn.dev` (and configured staging origins).
- `Access-Control-Allow-Headers: Content-Type, Attn-Admission, Attn-Owner-Signature`.
- WS subprotocol negotiation as described above (HMAC piggybacks on `Sec-WebSocket-Protocol`).
- `Origin` header is checked on WS upgrade; non-allowlisted origins get `403`.

When `false`, no CORS headers are emitted (native client doesn't need them).

## Deployment

### wrangler.toml (sketch)

```toml
name = "attn-relay"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "RELAY_ROOMS"
class_name = "RoomDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDO"]

[[r2_buckets]]
binding = "RELAY_BLOBS"
bucket_name = "attn-relay-blobs"

[vars]
HARD_MAX_PEERS = "8"
HARD_MAX_ROOM_BYTES = "26214400"
HARD_MAX_EVENT_BYTES = "262144"
HARD_MAX_SNAPSHOT_BYTES = "5242880"
HARD_MAX_EVENTS = "500"
ALLOWED_BROWSER_ORIGINS = "https://attn.dev"

[env.staging.vars]
ALLOWED_BROWSER_ORIGINS = "https://staging.attn.dev,http://localhost:5173"
```

No secrets are required by the relay. (Admission keys are derived from `roomSecret` which only clients hold.)

### Repo Layout

```text
relay/
  src/
    index.ts            # Worker entry, routes
    room-do.ts          # Durable Object class
    admission.ts        # HMAC verification
    schema.ts           # zod or io-ts request/response validators
    rate-limit.ts       # Per-device + per-IP limiters
    r2.ts               # Presigned URL helpers
  test/
    unit/
    integration/        # Miniflare-based
    conformance/        # Run against deployed staging
  wrangler.toml
  package.json
  README.md
```

### Local Dev

`wrangler dev --local` with Miniflare for DO + R2 simulation. The Rust client should support `ATTN_RELAY_URL=http://localhost:8787` env var.

### CI

- Unit tests: pure logic in `admission.ts`, `rate-limit.ts`, `schema.ts`.
- Integration tests: Miniflare boot, full endpoint coverage, including 410-cursor-too-old and 507-storage-cap paths.
- Conformance tests: exported as a JSON corpus that the Rust transport client replays against staging on every CI run.

## Test Plan

Minimum acceptance suite before any production deploy:

1. **Room lifecycle** — create, register devices, upload, pull, ack, delete.
2. **Cursor handling** — pull with `after=0`, pull with current `after`, pull after TTL deletion → `410`.
3. **Caps** — fill to `maxEvents`, fill to `maxRoomBytes`, exceed `maxEventBytes` → correct error codes.
4. **Owner auth** — non-owner ACK with delete-flag policy → `403`; owner ACK with delete → envelopes gone.
5. **Multi-device** — two devices for same participant, both ACK, deletion only fires per spec.
6. **Signaling** — round-trip a signal envelope through two open WS clients; verify offline target gets it via mailbox on reconnect.
7. **R2 spillover** — upload a 3 MiB encrypted snapshot via presigned URL, verify it's served back.
8. **TTL** — set `expiresAt` 60s in future, verify alarm fires, WS closes `4002`, GETs return `404`.
9. **Hibernation** — open WS, wait 90s, send frame from peer, verify delivery (DO transparently re-hydrates).
10. **Rate limit** — 121 requests/min from one device → `429` on the 121st.

## Open Questions for Spec Sign-Off

- **Admission key vs URL-as-bearer**: keep current design (URL is the secret, HMAC is bookkeeping) or move to device-token issuance at room creation? Affects threat model documentation more than code.
- **`POST /envelopes` batch size**: pin a max (suggest 32) so a single request can't dominate the DO event loop.
- **Long-poll vs WS-only**: current design supports both. Drop long-poll for v2 to simplify, or keep for clients that can't hold WS?
- **R2 lifecycle TTL**: 30-day safety net is generous. Tighten to 14d?
