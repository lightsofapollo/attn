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

Protocol identifiers are nonempty base64url-without-padding strings. `roomId`
and `envelopeId` are at most 128 characters; `participantId` and `deviceId` are
at most 64. A fresh unsafe request-body identifier is rejected with the generic
`400 ATTN_IDENTIFIER_INVALID` before quota, per-device rate, PoW-replay, or
content-storage mutation. An unsafe blob URL is admitted only as an exact
legacy compatibility path after the normal edge IP/anti-enumeration checks and
capability or admission authentication. PoW v2 canonical bytes are unchanged.

All fresh/new-layout writes encode client identifiers before composing a
durable or R2 key. An authenticated exact legacy blob re-presign may update its
existing raw `blob_resv:` row and `rooms/` object so already-stored ciphertext
remains available; it cannot create a new unsafe identity. The storage segment
codec is `base64url(UTF8(JSON.stringify(id)))`; decoding requires fatal UTF-8,
a nonempty JSON string, and a canonical encode round-trip. JSON escaping
preserves exact UTF-16 strings, including lone surrogates, and therefore keeps
NFC/NFD and U+FFFD/lone-surrogate identifiers distinct.

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

### Additive v3 scoped admission

V3 rooms use `/v3/rooms/:roomId` and store `protocolVersion=3` plus separate
32-byte `readAdmissionKey` and `writeAdmissionKey` verifier secrets. First
create supplies `v: 3`, `ownerSigningKey`, both admission keys, and policy.
Existing v2 routes, bodies, stored rooms, and `v2.MAC` verification are
unchanged. Accessing a stored room through the other version's route fails
`409 ATTN_PROTOCOL_VERSION_MISMATCH`.

```http
Attn-Admission: v3.read.<base64url HMAC>
Attn-Admission: v3.write.<base64url HMAC>
```

Both MACs cover the existing canonical request bytes. Endpoint requirements:

| Operation | Required v3 capability |
|---|---|
| `GET /devices` | read |
| Cap-less blob download presign | read |
| Anonymous viewer WebSocket upgrade (`viewer_id`) | read |
| Registered-device WebSocket upgrade (`device_id`) | read + write |
| Room rejoin `POST` | write |
| `POST /devices`, `/envelopes`, `/acks`, `/blobs` | write |
| `DELETE /rooms/:roomId` | write |

Blob upload/download capabilities minted for v3 contain `protocolVersion: 3`
inside the signed cap payload and emit `/v3/...` URLs. The Worker verifies that
field against the requested route, so rewriting a valid cap between `/v2` and
`/v3` fails. V2 cap payloads omit the field and retain their existing bytes and
`/v2/...` URLs.

A syntactically and cryptographically valid read proof used on a write route
returns `403 ATTN_WRITE_CAPABILITY_REQUIRED`. Missing, malformed, wrong-key,
or wrong-scope proofs return `401 ATTN_ADMISSION_INVALID`. V3 anonymous viewer
WebSockets use `Sec-WebSocket-Protocol: attn.v3, read-hmac.<base64url HMAC>`.
Registered v3 device sockets use the exact ordered form
`attn.v3, read-hmac.<base64url HMAC>, write-hmac.<base64url HMAC>`; both MACs
cover the same canonical GET request. This prevents a view bearer from opening
a socket under a public device id learned from the readable directory.

V3 read-only bearers connect without weakening device registration through:

`wss://relay/v3/rooms/:roomId/socket?viewer_id=<base64url(16 random bytes)>`

Exactly one of `viewer_id` or `device_id` is required. Viewer sockets use an
`attn.v3, read-hmac.<base64url HMAC>` admission proof, but are not device
or participant records: they receive `hello`, non-signal replay, and fresh
non-signal envelopes only. They never receive signaling or presence, never
appear in `onlineDeviceIds`, and do not consume `maxPeers`. A separate
`HARD_MAX_VIEWER_SOCKETS` cap bounds anonymous readers per room; overflow
closes with 4003. `POST /devices` and every other mutation still require the
write capability.

### Owner Distinction

`POST /v2/rooms/:roomId` (room creation) includes the owner's public signing key in the body. The DO stores this as `ownerSigningKeyId`. The first-create POST itself also requires an `Attn-Owner-Signature` Ed25519 sig over canonicalRequest, verified against the pubkey in the body (self-rooting) — this is the security-review §H1 mitigation that prevents a leaked-URL race attacker from registering as owner. All subsequent privileged ops (`POST /acks` with delete, `DELETE /v2/rooms/:roomId`) require the same header verified against the stored `ownerSigningKeyId`.

This is the **only** server-side distinction between owner and reviewer.

### Proof of Work

Every **write** request carries an `Attn-PoW` header containing a hashcash token:

```http
Attn-PoW: attn-pow:v2:<difficulty>:<expiresAt>:<roomId>:<deviceId>:<requestPathHash>:<rand>:<counter>
```

Applies to: `POST /devices`, `POST /envelopes`, `POST /acks`, `DELETE /v2/rooms/:roomId`. Does **not** apply to `GET` or to WebSocket frames.

Default difficulty is 16 leading zero bits (~50ms client cost). Per-room override via `policy.powBits` at room creation (server-clamped to `[12, 24]`). No exemption for local, remote, browser, or agent clients — all writes mint PoW.

Token format, hash algorithm, replay protection, and validation rules live in [`crypto-spec.md`](./crypto-spec.md) §Hashcash Proof-of-Work. Validation failures → `400 ATTN_POW_INVALID` (with no retry hint; the client mints a new token).

## Wire Conventions

- All bodies are JSON with `Content-Type: application/json; charset=utf-8`.
- All opaque byte fields are **base64url without padding**.
- All timestamps are unix milliseconds, integer, server-stamped where present in responses; client-asserted timestamps in `MailboxEnvelope.createdAt` are not trusted for TTL.
- Errors are:
  ```json
  { "error": { "code": "ATTN_ROOM_STORAGE_FULL", "message": "...", "retryAfterMs": 30000 } }
  ```
- Status codes: `400` malformed (incl. `ATTN_POW_INVALID`, `ATTN_BATCH_TOO_LARGE`, `ATTN_DEVICE_UNREGISTERED`), `401` admission failed, `403` owner sig required/wrong, `404` no room, `410` WS resync required (cursor too old — surfaced as a WS `error` frame), `413` body too large, `429` rate limited, `507` room storage / event cap reached.

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
    "expiresAt": 1736098745678,
    "idleTimeoutMs": 3600000,
    "longSession": false,
    "powBits": 16,
    "deleteEventsAfterOwnerAck": false,
    "allowBrowser": false,
    "allowRemoteAgents": false
  },
  "ownerSigningKey": "<base64url Ed25519 public key>"
}
```

Policy fields:

- `mode` — UI/intent hint only; the relay treats all modes identically post-decision-#1. Use `live` for real-time sessions, `async` for mailbox-only flows, `hybrid` for both. Frontend renders different connection-status badges per mode.
- `expiresAt` — wall-clock TTL. Clamped to `createdAt + 24h` unless `longSession == true`, in which case clamped to `createdAt + 7d`. Default if omitted: `createdAt + 24h`.
- `idleTimeoutMs` — room auto-closes this many ms after the last accepted envelope. Default 3600000 (1h). Min 60000 (1m), max equal to the wall-clock TTL.
- `longSession` — explicit opt-in to the 7-day max TTL for human review sessions. Default `false` (agentic short rooms).
- `powBits` — hashcash difficulty for writes against this room. Default 16. Server-clamped to `[12, 24]`. See `crypto-spec.md` §Hashcash.
- `deleteEventsAfterOwnerAck` — whether owner ACKs may trigger envelope deletion. **Default `false`** (per decision #3, prevents multi-device owner data loss). Single-device owners can opt in via UI.

Behavior:

- If the room does not exist, create the DO, persist the policy and `ownerSigningKey`. Policy values are clamped to the server's hard maxima. Return `201`.
- If the room exists, ignore the body and return the stored policy as `200`. **Do not** allow policy mutation after creation; that would let a stolen URL extend a room's TTL.
- **First-create only**: requires `Attn-Owner-Signature` — an Ed25519 signature over the same `canonicalRequest` shape used for admission, verified against the body's `ownerSigningKey`. This is the H1 mitigation from `planning/collab/security-review.md` §H1: without it, anyone with the share URL could win a race to register their own pubkey as the room owner. The signature is self-verifying (pubkey in body, signature over canonical bytes), so no server-side state is required to check it. Missing header → `403 ATTN_OWNER_SIG_REQUIRED`; signature/keypair mismatch → `403 ATTN_OWNER_SIG_INVALID`.
- **Rejoin**: requires admission HMAC. No new `Attn-Owner-Signature` is required — the room's owner identity was bound at first-create and is immutable. (Subsequent owner-privileged ops like `DELETE /v2/rooms/:roomId` independently require `Attn-Owner-Signature` verified against the stored `ownerSigningKey`.)
- (No PoW — room creation is the bootstrap step; PoW is required from `POST /devices` onward.)

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
- `deviceId` is room-wide unique because ACK and WebSocket routes identify a
  device without a participant tuple. Reject `409 ATTN_DEVICE_ID_CONFLICT` if
  another participant already owns it; multiple stored owners are corruption.
- Upsert by `(participantId, deviceId)`. Reject `409 ATTN_DEVICE_KEY_CHANGED` if an existing record has a different `publicSigningKey` for the same `(participantId, deviceId)` — the trust-on-first-use binding is immutable for the life of the room.
- Requires admission HMAC.

Response: `204 No Content`.

### `GET /v2/rooms/:roomId/devices`

Returns the peer list with published keys.

```json
{
  "policy": { /* current server-clamped room policy, including powBits */ },
  "devices": [
    {
      "deviceId": "...",
      "participantId": "...",
      "publicSigningKey": "...",
      "publicEncryptionKey": "...",
      "client": "attn-native",
      "kind": "owner",
      "selfSignature": "...",
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

- Requires admission HMAC + `Attn-PoW`.
- **Batch size cap: 32 envelopes per request.** Larger batches → `400 ATTN_BATCH_TOO_LARGE`. Single PoW token covers the whole batch (one token = one HTTP request).
- Per-envelope checks:
  - `ciphertextBytes` must equal `len(ciphertext bytes after base64url decode)`. Reject `400 ATTN_CIPHERTEXT_LENGTH_MISMATCH`.
  - `ciphertextBytes` must be ≤ `policy.maxEventBytes` for `kind == "event" | "signal"`, ≤ `policy.maxSnapshotBytes` for `kind == "snapshot_blob"`. Reject `413 ATTN_ENVELOPE_TOO_LARGE`.
  - `authorId` and `deviceId` must reference a published device record (call `POST /devices` first). Reject `400 ATTN_DEVICE_UNREGISTERED`.
- The first unique envelope's `(authorId, deviceId)` is authenticated before the relay writes its device-rate or PoW replay key. An unregistered first device returns `400 ATTN_DEVICE_UNREGISTERED` without durable mutation, including for a conflicting same-ID batch.
- Per-room running totals (envelope count, inline bytes, R2 bytes, and server sequence) must already exist as non-negative safe integers; missing, negative, or overflowed metadata is `500 ATTN_ROOM_CORRUPT`. Accepted count/byte/sequence additions are safe-integer checked and updated atomically.
- Every accepted envelope resets `meta:last_event_at = now` and reschedules the idle alarm to `now + policy.idleTimeoutMs`.
- If `running.envelopeCount + new > policy.maxEvents`, reject the *whole batch* `507 ATTN_ROOM_EVENT_CAP`.
- If `running.bytes + sum > policy.maxRoomBytes`, reject the *whole batch* `507 ATTN_ROOM_STORAGE_FULL`. (Hard cap, not policy-overridable.)
- Idempotency: if `envelopeId` already exists in the room, treat as success without storing a second copy. Response `serverSeq` for the duplicate is the previously assigned value.
- Within one request, field-identical repeats of an `envelopeId` are collapsed in first-occurrence order after normalizing omitted `target` to `null`. If the same `envelopeId` has different `authorId`, `deviceId`, `kind`, normalized `target`, `createdAt`, `expiresAt`, `nonce`, `ciphertext`, or `ciphertextBytes`, the relay still applies admission, the first unique envelope's device-rate debit, and PoW verification before returning `400 ATTN_ENVELOPE_ID_CONFLICT`; envelope payloads and accounting remain unchanged.
- `kind == "signal"` envelopes are short-lived. They are forwarded over the WebSocket to the target device (or broadcast if `target == null`) and **also** stored if the target is offline. Signal envelopes have their own sub-cap: `maxSignalEnvelopes = 64` per `(authorId, target.deviceId)` pair, FIFO-evicted. After first-device authentication and rate/PoW verification, only targets receiving a fresh signal are scanned, once per target; persisted-duplicate retries do not select an index scan. Exact target-index entries, payload storage keys, routing fields, victim accounting fields, and victim-key uniqueness are validated before content mutation, with corrupt state returning `500 ATTN_ROOM_CORRUPT`. Fresh payload/index insertion, all planned FIFO victim deletions, final count/byte totals, and the logical post-mutation cursor floor commit in one storage transaction with ≤128-key operations. The `env_idx` entry is retained as an idempotency tombstone, so retrying an evicted signal returns its original `serverSeq` without recharging it.
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

### ~~`GET /v2/rooms/:roomId/envelopes`~~ (removed)

Decision #5: WebSocket only. All envelope delivery — initial backfill and live push — flows through the WebSocket protocol (see below). The HTTP pull endpoint has been removed entirely; no long-poll, no polling fallback. Clients that cannot maintain a WebSocket connection cannot use the relay in v2.

Stale-cursor recovery (formerly `410 ATTN_CURSOR_TOO_OLD`) is now surfaced as a WebSocket `error` frame with `code: "ATTN_CURSOR_TOO_OLD"` and `resyncFromSeq` payload, followed by close `4005`. Clients respond by discarding their cursor and either requesting a snapshot from a peer (live) or re-subscribing from `resyncFromSeq` (async — accepts that pre-deleted history is gone).

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
- `Attn-PoW` required (write endpoint).
- `Attn-Owner-Signature` required **if and only if** `policy.deleteEventsAfterOwnerAck == true` and the client wants envelopes deleted. Without it, ACK is recorded but envelopes are retained until TTL. (Default policy is `false`, so most rooms never need this.)

Behavior:

- `deviceId` must resolve to a published device before the relay writes a per-device rate, PoW replay, or ACK key. Unknown devices return `400 ATTN_DEVICE_UNREGISTERED` without durable mutation.
- Mark envelopes as ACKed by `deviceId`. Multiple devices may ACK independently.
- If owner signature present and policy allows deletion:
  - Delete envelopes ACKed by *any* owner device. (Owner has multiple devices; once the owner has the bits anywhere, the server may drop them. Cross-device replication is the owner's problem — see `amendments.md` §Multi-device.)
- Payload/target-index deletion, exact `meta:envelope_count` and `meta:bytes_used` debits, ACK markers, and `meta:oldest_retained_seq` are committed in one storage transaction. The versioned index (or an exact legacy index during rollout) is retained as a cross-request idempotency tombstone, so a POST retry returns the original `serverSeq` without restoring or recharging the payload. After registered-device rate/PoW verification, an actual owner-deletion branch validates every current versioned or exact-legacy envelope key against its `EnvelopeRecord` and requires its sequence not to exceed `meta:server_seq`; corruption is `500 ATTN_ROOM_CORRUPT`. ACK-only and missing/invalid-PoW requests never trigger this payload scan. The cursor floor is computed against the merged logical post-delete payload set: it is the smallest retained `serverSeq`, or `meta:server_seq` when no payload remains.
- Idempotent. Acking a non-existent or already-deleted envelope is `204`.

Response: `204 No Content`.

### `DELETE /v2/rooms/:roomId`

End the room immediately.

- Requires admission HMAC + `Attn-PoW` + `Attn-Owner-Signature`.
- Deletes the DO state; WebSocket clients are disconnected with close code `4001`; R2 blobs for this room are scheduled for deletion (best-effort, may lag).
- Response `204`.

### `POST /v2/rooms/:roomId/blobs` (R2 spillover)

Used when `kind == "snapshot_blob"` and `ciphertextBytes > 1 MiB`. Requires admission HMAC + `Attn-PoW`.

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
  "blobKey": "rooms_v2/<enc(roomId)>/generations/<enc(leaseId)>/blobs/<enc(envelopeId)>"
}
```

Client uploads the raw ciphertext bytes via the capability URL. The cap binds
the active room generation and a one-time upload claim; RoomDO serializes the
R2 write against delete/expiry before marking the claim committed.

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

V3 registered URL: `wss://relay/v3/rooms/:roomId/socket?device_id=:deviceId`

V3 anonymous read URL: `wss://relay/v3/rooms/:roomId/socket?viewer_id=:viewerId`

Subprotocol: `attn.v2`

Admission HMAC is passed via `Sec-WebSocket-Protocol` as a second protocol value: `attn.v2, hmac.<base64url HMAC>`. (Browsers don't allow custom headers on WS handshake.)

V3 viewer subprotocols are exactly `attn.v3, read-hmac.<base64url HMAC>`.
V3 registered-device subprotocols are exactly
`attn.v3, read-hmac.<base64url HMAC>, write-hmac.<base64url HMAC>`.

All frames are JSON text frames. Binary frames are reserved.

### Server → Client Frames

```ts
type ServerFrame =
  | {
      type: "hello";
      serverSeq: number;
      policy: RoomPolicy;
      devices: DeviceRecord[];
      onlineDeviceIds: string[];
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
- `4002` room expired (hard-max or idle alarm)
- `4003` rate limit on socket (too many frames/sec)
- `4004` peer cap reached for kind (e.g., trying to connect a 9th peer when cap is 8)
- `4005` cursor too old — preceded by an `error { code: "ATTN_CURSOR_TOO_OLD", resyncFromSeq }` frame

### Flow

1. Client opens WS, sends `subscribe { after: lastSeenServerSeq }`.
2. Server sends `hello { serverSeq, policy, devices, onlineDeviceIds, missedSignalEnvelopeIds }`. `devices` is the immutable registered directory; `onlineDeviceIds` is the authoritative active-socket snapshot used to build the live WebRTC mesh without resurrecting departed registrations. If `after < meta:oldest_retained_seq`, instead sends `error { code: "ATTN_CURSOR_TOO_OLD", resyncFromSeq: <oldest_retained_seq> }` and closes `4005`. Client responds by discarding its cursor and either requesting a snapshot from a peer or re-subscribing from `resyncFromSeq`.
3. Server pushes `envelope` and `presence` frames as they happen. V3 anonymous viewers receive only non-signal `envelope` frames; presence and all signaling are suppressed. Each accepted envelope upload also resets the idle alarm.
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

One SQLite-backed quota coordinator per deployment. Naming:
`env.RELAY_QUOTAS.idFromName("quota:v1")`. It atomically admits first-create
generation leases across all rooms; room rejoin never contacts it.

### Storage Layout (using DO Storage API + optional SQLite-backed DO)

Keys (lexicographic ordering matters for range scans):

```text
meta:policy                     -> RoomPolicy JSON
meta:owner_signing_key          -> base64url Ed25519 pubkey
meta:created_at                 -> u64 ms
meta:expires_at                 -> u64 ms (clamped at creation; see Alarms)
meta:hard_max_at                -> u64 ms (createdAt + 24h or +7d if longSession)
meta:last_event_at              -> u64 ms (reset on every accepted envelope; drives idle alarm)
meta:server_seq                 -> u64 monotonic counter
meta:bytes_used                 -> u64
meta:bytes_used_r2              -> u64
meta:envelope_count             -> u64
meta:oldest_retained_seq        -> u64 (0 before deletion; then lowest retained seq, or server_seq if empty)
meta:quota_lease                -> { roomId, random leaseId, sourceBucket, reservedBytes }

device_v2:<enc(participantId)>:<enc(deviceId)> -> DeviceRecord JSON
device_order_v2:<registeredAt>:<seq>:<enc(participantId)>:<enc(deviceId)> -> ""

env_v2:<paddedServerSeq>:<enc(envelopeId)> -> Envelope JSON
env_idx_v2:<enc(envelopeId)>    -> paddedServerSeq (durable dedupe tombstone; retained after payload deletion)
env_by_target_v3:<enc(deviceId)>:<paddedServerSeq>:<enc(envelopeId)> -> ""
env_by_target_v2:<enc(deviceId)>:<paddedServerSeq>:<raw envelopeId> -> "" (legacy dual-read/delete)
env_by_target:<colon-free deviceId>:<paddedServerSeq>:<envelopeId> -> "" (legacy dual-read/delete only)

ack_v2:<enc(deviceId)>:<enc(envelopeId)> -> u64 ackedAt
ack_owner_v2:<enc(envelopeId)>  -> "" (presence indicates owner-acked)
blob_resv_v2:<enc(envelopeId)>  -> generation/upload reservation + objectKeyVersion

pow_seen:<expiresAt>:<sha256(token)> -> "" (replay protection, alarm-cleaned)

rate_v2:<enc(deviceId)>:<windowStartMin> -> u32 count
```

QuotaDO stores only HMAC-pseudonymized source identifiers and aggregate
capacity state:

```text
lease_v2:<enc(roomId)>          -> { roomId, leaseId, sourceBucket, reservedBytes, acquiredAt }
source:<sourceBucket>           -> { liveRooms, allocations: [{ at, bytes }] }
source_expiry_v2:<expiresAt>:<enc(roomId)>:<enc(leaseId)> -> source allocation expiry record
global:v1                       -> { liveRooms, reservedBytes }
```

Readers are versioned-first with exact legacy fallback for `device:`,
`device_order:`, `env:`, `env_idx:`, `blob_resv:`, `rate:`, `lease:`, and
`source_expiry:` rollout state. Historical `ack:`/`ack_owner:` rows are not
authorization, routing, deletion, or accounting inputs and are not consulted.
Stored record fields
must match the requested identifiers; ambiguous legacy delimiter parsing is
never identity authority. If exact legacy and v2 rows coexist they must agree
or the room fails closed as `ATTN_ROOM_CORRUPT`. Replay, cursor-floor, signal
FIFO, ACK deletion, quota alarms, and device ordering merge both layouts and
deduplicate logical records while treating ciphertext as opaque data; they do
not decrypt or interpret it.

The Worker deletes any client-supplied internal quota-source header, then
derives `sourceBucket = HMAC-SHA-256(QUOTA_IP_HASH_KEY,
canonical CF-Connecting-IP)`. Raw IPs never enter durable storage, and
`X-Forwarded-For` is never used for durable quota. If attribution, required
configuration, or the singleton is unavailable, a first-create fails closed
with `503 ATTN_QUOTA_UNAVAILABLE`; reads, deletes, and rejoin remain available.
Tests/local development may explicitly set
`QUOTA_ALLOW_UNATTRIBUTED_CREATES=true` to use a per-room development bucket;
deployed production and staging configuration must omit it.

### First-create reserved capacity

After schema validation, the self-rooted owner signature, and PoW validation —
but before room metadata persistence — RoomDO acquires a generation lease from
QuotaDO. The lease reserves exactly `HARD_MAX_ROOM_BYTES`, not the room's
current usage, so empty, pending, and full rooms have the same conservative
capacity cost. QuotaDO performs checks and counter writes in one durable
storage transaction:

- per source: at most 8 live rooms and 256 MiB allocated in a rolling 24h;
- global: at most 512 live rooms and 6.25 GiB reserved.

The 24h allocation record is ingress accounting and is not refunded on early
delete. Live-room and global reserved counters are released after ciphertext
cleanup. Acquire of the same `(roomId, leaseId)` is idempotent; a different
active generation conflicts. Release is idempotent, and includes both roomId
and a cryptographically random leaseId so a stale release cannot affect a room
recreated under the same roomId. Source live/byte denials return respectively
`429 ATTN_SOURCE_ROOM_QUOTA` and `429 ATTN_SOURCE_BYTE_QUOTA`; global exhaustion
returns `503 ATTN_RELAY_CAPACITY`; applicable responses include `Retry-After`.

Quota admission only measures opaque ciphertext capacity and allocation
metadata. It introduces no content-inspection path: document text, comments,
signals, and snapshots remain E2E encrypted and unreadable by relay services.

`paddedServerSeq` is `serverSeq.toString().padStart(20, '0')` to keep lexicographic ordering correct.

### serverSeq Allocation

```ts
const next = (await this.state.storage.get("meta:server_seq")) ?? 0;
const assigned = next + 1;
await this.state.storage.put({
  "meta:server_seq": assigned,
  [`env_v2:${pad(assigned)}:${enc(envelopeId)}`]: envelope,
  [`env_idx_v2:${enc(envelopeId)}`]: pad(assigned),
});
return assigned;
```

The `put` is atomic across keys within a single DO event, so `server_seq` can never go backward and envelopes can never be stored without an index entry.

### Alarms (TTL + Idle Cleanup)

Two alarms govern room lifetime. First to fire wins.

- **Hard-max alarm** (set once at room creation): fires at `meta:hard_max_at = createdAt + (longSession ? 7d : 24h)`. Captures the absolute wall-clock cap from `expiresAt` (clamped).
- **Idle alarm** (set on creation; reset on every accepted envelope): fires at `meta:last_event_at + policy.idleTimeoutMs` (default 1h). Captures abandoned rooms — e.g., the agent finished its review and nothing has happened for an hour.
- **PoW-prune alarm** (periodic, ~5min): deletes `pow_seen:*` entries with `expiresAt + 10min < now`.

On hard-max or idle alarm fire:

1. Send `4002 room expired` close frame to all WS clients.
2. Delete R2 ciphertext via bounded `list + delete` against both the encoded
   `rooms_v2/<enc(roomId)>/` and exact legacy `rooms/<roomId>/` prefixes.
3. Remove user content and metadata, retaining only a quota-release tombstone.
4. Idempotently release the generation reservation; retry by alarm if the quota coordinator is temporarily unavailable.
5. Delete the tombstone. The DO becomes dormant; subsequent requests to the same `roomId` see no policy and `404`.

Cloudflare's DO API supports only one alarm at a time. The implementation maintains the two logical alarms by always scheduling the alarm to whichever target time is earlier (`min(hard_max_at, last_event_at + idleTimeoutMs)`), and re-evaluating on every envelope insert. The PoW-prune sweep runs as part of the same alarm handler when it fires, then re-schedules.

### Hibernation Tags

Each accepted WebSocket gets namespaced injective tags
`["d2:" + enc(deviceId), "p2:" + enc(participantId)]`; raw identifiers remain
only in the hibernation attachment/frame metadata. Exact legacy socket lookup
uses stored device records rather than parsing delimiter-bearing tags.

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
| Envelopes per `POST /envelopes` | 32 | `400 ATTN_BATCH_TOO_LARGE` past this |
| Wall-clock TTL (default) | 24 hours | Server clamps `expiresAt` |
| Wall-clock TTL (`longSession=true`) | 7 days | For human review sessions; explicit opt-in |
| Idle timeout (default) | 1 hour | Auto-close after last envelope; configurable via `policy.idleTimeoutMs` |
| PoW difficulty | 16 leading zero bits (default) | `policy.powBits`, clamped `[12, 24]`. See crypto-spec.md. |
| Per-device request rate | 120/min | Sliding 60s window, counted per HTTP and WS frame |
| Per-IP request rate (Worker edge) | 600/min | Pre-DO, prevents enumeration of room URLs |
| Live rooms per source | 8 | Atomic QuotaDO first-create lease; rejoin excluded |
| Allocated bytes per source / rolling 24h | 256 MiB | 25 MiB per accepted generation; non-refundable on release |
| Global live rooms | 512 | Atomic across every RoomDO |
| Global reserved room bytes | 6.25 GiB | 25 MiB per live generation; tighter than live-count default |

Rate limit responses: `429` with `retryAfterMs` header AND in the JSON error body.

## R2 Integration

- Buckets: isolated production/staging buckets, encoded prefix per generation:
  `rooms_v2/<enc(roomId)>/generations/<enc(leaseId)>/blobs/<enc(envelopeId)>`.
- Blob capabilities sign `objectKeyVersion: 2` for new objects. Its absence is
  the exact legacy raw-key layout, allowing old ciphertext to be fetched and
  deleted without decrypting or copying it.
- Upload via generation-bound, one-time PUT capability (15-minute TTL).
- Read via presigned GET URL (5-minute TTL), fetched per access.
- Lifecycle rule on the bucket: auto-delete objects older than **7 days** (matches the max wall-clock room TTL with `longSession=true`; ~7× headroom for default 24h rooms). Safety net only — DO alarm-driven deletion is primary. If the DO alarm slips by more than ~6 hours on a room near its TTL ceiling, blobs may disappear before the room itself; mitigation: every WS connect runs `if now > meta:expires_at - 1h: cleanup_check()` to belt-and-braces the alarm.
- Byte accounting: the DO tracks total room bytes by counting *envelope* `ciphertextBytes`, which for R2-spilled envelopes is the small BlobRef wrapper. The *actual* R2 bytes are tracked separately in `meta:bytes_used_r2`. Both must stay under `maxRoomBytes` combined.

## Anti-Abuse

- **The URL is the bearer token.** Anyone who learns the URL gets admission. PoW is a friction layer on top, not a substitute.
- **Hashcash PoW on every write** — `POST /devices`, `POST /envelopes`, `POST /acks`, `POST /blobs`, `DELETE`. Default 16 leading zero bits (~50ms client cost; ~250ms on a Pi). Tokens bind `(roomId, deviceId, method, path)` and have 5-minute expiry. Per-room override via `policy.powBits` in `[12, 24]`. **No exemption** for local, daemon-driven, or browser clients — symmetric treatment defeats an attacker who can run the daemon binary. See [`crypto-spec.md`](./crypto-spec.md) §Hashcash Proof-of-Work for token format, verification, and replay protection.
- Worker-edge rate limit on `roomId` enumeration: any caller hitting > 30 distinct unknown rooms in 5 minutes is `429`'d at the edge.
- All `POST /envelopes` traffic counted toward per-device rate (120/min); the per-device key is `deviceId` from the request body (trusted only within a single room's blast radius).
- IP logging: source IPs are logged for 24h for abuse mitigation, then dropped. Document this publicly in the privacy notice.

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
- Fields allowed: `ts`, validated protocol `roomId`/`deviceId` (or a one-way
  correlation digest for legacy identifiers), `kind`, `serverSeq`, `bytes`,
  `code`, `latencyMs`. Unsafe raw identifiers are never logged or echoed.
- IP retained 24h then dropped.

Alerts:

- Any room exceeding 80% of `maxRoomBytes` for > 1h → operator notification.
- Per-room rate > 10x cap (suggests abuse).
- DO error rate > 1% over 5m.

## Browser Considerations

When `policy.allowBrowser == true`:

- CORS: `Access-Control-Allow-Origin: https://attn.sh` (and configured staging origins).
- `Access-Control-Allow-Headers: Content-Type, Attn-Admission, Attn-Owner-Signature, Attn-PoW`.
- WS subprotocol negotiation as described above (HMAC piggybacks on `Sec-WebSocket-Protocol`).
- The public edge `Origin` header is checked on WS upgrade; non-allowlisted or
  malformed origins get `403`. Accepted origins are canonical HTTP(S) origins
  exactly matching `ALLOWED_BROWSER_ORIGINS`.

Cloudflare may rewrite the standard `Origin` header while forwarding a
WebSocket upgrade from the Worker to RoomDO. The Worker therefore validates
and snapshots the edge value into the private `X-Attn-Edge-Origin` context
(`v1.native`, `v1.browser.<base64url UTF-8 canonical origin>`, or
`v1.invalid`) before `stub.fetch`. It unconditionally overwrites any
client-supplied value. RoomDO ignores the standard `Origin` header, fails
closed if the private context is missing or malformed, and treats
`v1.invalid` as a browser request so it cannot bypass `allowBrowser`. This
private header is never returned to a client.

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

[[durable_objects.bindings]]
name = "RELAY_QUOTAS"
class_name = "QuotaDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDO"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["QuotaDO"]

[[r2_buckets]]
binding = "RELAY_BLOBS"
bucket_name = "attn-relay-blobs"

[vars]
HARD_MAX_PEERS = "8"
HARD_MAX_ROOM_BYTES = "26214400"
HARD_MAX_EVENT_BYTES = "262144"
HARD_MAX_SNAPSHOT_BYTES = "5242880"
HARD_MAX_EVENTS = "500"
HARD_MAX_BATCH_ENVELOPES = "32"
HARD_MAX_TTL_MS = "86400000"          # 24h default
HARD_MAX_TTL_LONG_MS = "604800000"    # 7d for longSession rooms
DEFAULT_IDLE_TIMEOUT_MS = "3600000"   # 1h
DEFAULT_POW_BITS = "16"
MIN_POW_BITS = "12"
MAX_POW_BITS = "24"
ALLOWED_BROWSER_ORIGINS = "https://attn.sh"
QUOTA_MAX_LIVE_ROOMS_PER_SOURCE = "8"
QUOTA_MAX_ALLOCATED_BYTES_PER_SOURCE_24H = "268435456"
QUOTA_GLOBAL_MAX_LIVE_ROOMS = "512"
QUOTA_GLOBAL_MAX_RESERVED_BYTES = "6710886400"

[env.staging.vars]
ALLOWED_BROWSER_ORIGINS = "https://staging.attn.sh,http://localhost:5173"
```

`QUOTA_IP_HASH_KEY` is a required deployment secret (set independently for
production and staging) and must never be committed to `wrangler.toml`.
Admission keys are still derived from `roomSecret` and held only by clients;
the two operational HMAC secrets never grant access to document plaintext.

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

1. **Room lifecycle** — create, register devices, upload, subscribe via WS, ack, delete.
2. **WS backfill** — connect with `subscribe { after: 0 }` → receive all envelopes; connect with `after: lastSeen` → receive only newer; connect with `after: deletedSeq` → receive `error { code: ATTN_CURSOR_TOO_OLD, resyncFromSeq }` and close `4005`.
3. **Caps** — fill to `maxEvents`, fill to `maxRoomBytes`, exceed `maxEventBytes`, exceed batch cap (33 envelopes) → correct error codes.
4. **Owner auth** — non-owner ACK with delete-flag policy → `403`; owner ACK with delete → envelopes gone. Default policy (delete=false) → ACK accepted but envelopes retained.
5. **Multi-device** — two devices for same participant, both ACK, deletion only fires per spec.
6. **Signaling** — round-trip a signal envelope through two open WS clients; verify offline target gets it via stored mailbox on reconnect.
7. **R2 spillover** — upload a 3 MiB encrypted snapshot via presigned URL, verify it's served back.
8. **Hard-max TTL** — create room with `expiresAt = now + 60s`; verify alarm fires, WS closes `4002`, subsequent ops `404`.
9. **Idle timeout** — create room with `idleTimeoutMs = 30s`, send one envelope, wait 35s without activity; verify alarm fires.
10. **Hibernation** — open WS, wait 90s, send frame from peer, verify delivery (DO transparently re-hydrates).
11. **Rate limit** — 121 writes/min from one device → `429` on the 121st.
12. **PoW** — write without `Attn-PoW` → `400 ATTN_POW_INVALID`; write with expired token → `400`; write with token for different `(method, path)` → `400`; write with valid token → success; replay same token → `400`.
13. **PoW difficulty override** — room created with `powBits: 20`; write with 16-bit token → `400`; write with 20-bit token → success.
14. **longSession** — room created with `longSession: true, expiresAt: now + 5d` → accepted; `longSession: false, expiresAt: now + 2d` → clamped to `now + 24h`.

## Decisions Reference

All design decisions for this relay spec are tracked in [`amendments.md`](./amendments.md) §Decisions Locked. The values pinned here (PoW difficulty 16, batch cap 32, WS-only, 24h+idle-1h TTL model, R2 7-day safety net, `deleteEventsAfterOwnerAck` default false) come from there. No outstanding questions block implementation.
# Durable shares (v3)

`/v3/shares/:shareId` is a small long-lived indirection, separate from room
TTL and room storage. A share stores the immutable owner signing key and
read/write admission keys, an optional current room pointer, encrypted snapshot
references, and unresolved-file placeholders. `POST` creates or owner-touches
the record; every successful touch renews `expiresAt` to 90 days. Creation and
updates require `Attn-Owner-Signature` over the canonical request plus
`Attn-PoW`. `GET` requires exactly `v3.read.<MAC>`. `DELETE` requires the owner
signature and PoW and atomically deletes the pointer, placeholders, mailbox,
and renewal metadata. Public responses never return either stored admission
key. `epoch` is a non-decreasing safe integer; `currentRoomId: null` clears a
stale pointer. Manifests are capped at 64 snapshot refs, 64 placeholders, and
256 KiB encoded metadata.

`POST /v3/shares/:shareId/mailbox` accepts 1–32 opaque encrypted payloads with
`v3.write.<MAC>` and PoW. The DO assigns strictly increasing `seq` values and
caps retained data at 500 items / 25 MiB. `GET .../mailbox?after=N` requires
read admission and returns at most 100 items ordered by `seq`; payloads remain
opaque to the relay. Each payload carries an `envelopeId`; retries are
idempotent for 24 hours and return the original per-envelope sequence;
conflicting ciphertext under the same ID returns
`409 ATTN_ENVELOPE_ID_CONFLICT`. After durably importing a page,
the owner issues owner-signed, PoW-protected
`DELETE .../mailbox?through=<seq>` to reclaim exactly that prefix. Share
alarms delete all state once the owner-renewed 90-day expiry passes. Room v2/v3
endpoints and their shorter lifetimes are unchanged.
