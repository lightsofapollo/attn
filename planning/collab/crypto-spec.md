# attn Collaboration v2 — Crypto Spec

This document pins the cryptographic primitives used by both the native client and the (future) browser client. The `data-model.md` and `relay-spec.md` reference these names; this document defines them.

The goal is that two independent implementations of attn produce byte-identical signatures, ciphertexts (modulo random nonces), and IDs, so events authored on one client verify on another.

## Primitives

| Use | Algorithm | Notes |
|---|---|---|
| Hash | SHA-256 | Everywhere |
| KDF | HKDF-SHA-256 | Salt = empty (32 zero bytes), `info` per derivation |
| AEAD | XChaCha20-Poly1305 | Random 24-byte nonce per envelope, no counter coordination needed across devices |
| Signature | Ed25519 | RFC 8032 |
| Random | OS CSPRNG | `getrandom` (Rust), `crypto.getRandomValues` (browser) |
| Canonical JSON | RFC 8785 (JCS) | For everything signed |
| ID encoding | base64url-no-pad | Everywhere bytes are stringified |

### Rust crates

- `sha2` — SHA-256
- `hkdf` — HKDF
- `chacha20poly1305` — XChaCha20-Poly1305 (`XChaCha20Poly1305` type)
- `ed25519-dalek` v2 — Ed25519 sign/verify
- `x25519-dalek` — only if device key exchange becomes useful for direct E2E messages between peers; not required for the room-key model
- `serde_json` + a JCS canonicalizer (write thin helper; the corpus is small)
- `base64` with the `URL_SAFE_NO_PAD` engine
- `getrandom`

### Browser

- `crypto.subtle.digest("SHA-256", ...)`
- `crypto.subtle.deriveKey(...)` for HKDF
- XChaCha20-Poly1305 is **not** in WebCrypto; use `@noble/ciphers/chacha` (audited, no deps).
- Ed25519 is browser-native via `crypto.subtle.sign({ name: "Ed25519" }, ...)` on modern browsers; fall back to `@noble/curves/ed25519` if browser support is gated.
- `crypto.getRandomValues`
- Canonical JSON: small in-house helper.

## Key Derivation

All keys descend from a single 32-byte `roomSecret` chosen by the room creator.

```text
roomSecret  := 32 random bytes (CSPRNG)
roomId      := base64url(first 16 bytes of SHA-256("attn room v2" || roomSecret))
rootKey     := HKDF-SHA-256(IKM=roomSecret, salt=empty, info="attn room root v2",          L=32)
eventKey    := HKDF-SHA-256(IKM=rootKey,    salt=empty, info="attn event encryption v2",   L=32)
snapshotKey := HKDF-SHA-256(IKM=rootKey,    salt=empty, info="attn snapshot encryption v2",L=32)
signalingKey:= HKDF-SHA-256(IKM=rootKey,    salt=empty, info="attn signaling encryption v2", L=32)
admissionKey:= HKDF-SHA-256(IKM=rootKey,    salt=empty, info="attn relay admission v2",    L=32)
```

`L=32` means the output is 32 bytes.

`info` strings are byte-exact (UTF-8, no trailing newline). Two implementations must match these strings character-for-character.

Note: only `roomSecret` is shared by URL. All other keys are derived, never transmitted.

## Invite URLs

Native:

```text
attn://review/<roomId>#key=<base64url(roomSecret)>
```

Browser:

```text
https://attn.dev/review/<roomId>#key=<base64url(roomSecret)>
```

The fragment (`#key=...`) is never sent over the network by browsers and is not seen by the relay. On open:

1. Parse the fragment.
2. **Immediately** call `history.replaceState(null, "", location.pathname + location.search)` to strip the fragment from the visible URL bar (browser) or the in-process equivalent (native).
3. Hold `roomSecret` only in memory. Derive `rootKey`, then derive `eventKey`/`snapshotKey`/`signalingKey`/`admissionKey` and zero `roomSecret` if the language allows.

## Envelope Encryption (AEAD)

Every encrypted payload is produced with XChaCha20-Poly1305 using a fresh random 24-byte nonce per envelope.

```text
nonce       := 24 random bytes
ciphertext  := XChaCha20Poly1305-Seal(key, nonce, plaintext, aad)
```

Where:

- `key` = `eventKey` for `kind: "event"` and `kind: "signal"`; `snapshotKey` for `kind: "snapshot_blob"`.
- `plaintext` = canonical JSON of the `ReviewEvent` (or signaling payload, or snapshot bytes) — see Canonical JSON below.
- `aad` (associated data) = canonical JSON of:
  ```ts
  {
    v: 2,
    roomId: "...",
    envelopeId: "...",
    kind: "event" | "signal" | "snapshot_blob",
    authorId: "...",
    deviceId: "...",
    createdAt: <int>
  }
  ```
  Binding the metadata into AAD prevents the relay from re-routing an envelope's ciphertext under a different "kind" or "author" tag.

On the wire, the envelope stores `nonce`, `ciphertext`, and the AAD fields in cleartext (the relay needs them for routing). The decryption side reconstructs the same AAD JSON and passes it to `Open`.

### Nonce Discipline

- XChaCha20's 24-byte nonce space (192 bits) is large enough that random nonces are safe without coordination. Birthday-collision risk is negligible up to ~2^48 envelopes per key.
- **Never** reuse a nonce with the same key.
- For `snapshot_blob` with R2 spillover, the AEAD encrypts the *blob bytes themselves* (not the BlobRef). The envelope in the DO carries only the `BlobRef` (also encrypted, separately, with `eventKey` since it's metadata-shaped) — pin the convention:
  - R2 object body = `nonce || ciphertext || tag` of the snapshot bytes under `snapshotKey`.
  - DO envelope ciphertext = AEAD-encrypt of the canonical-JSON BlobRef under `eventKey`.
  - The relay sees neither.

## Hashcash Proof-of-Work

Every write to the relay carries an `Attn-PoW` header containing a hashcash token. PoW raises the cost of casual abuse (URL scraping, mailbox flooding) without making legitimate writes painful.

Applies to: `POST /devices`, `POST /envelopes`, `POST /acks` (with or without delete), `DELETE /v2/rooms/:roomId`. Does **not** apply to GETs or WebSocket frames (rate limits handle those).

No exemption for any client kind — native daemon, browser, agent CLI, local or remote all mint PoW.

### Token Format

```text
attn-pow:v2:<difficulty>:<expiresAt>:<resource>:<rand>:<counter>
```

Field encoding (colon-separated, no internal colons allowed in any field):

- `v2` — literal protocol version.
- `difficulty` — decimal integer leading-zero-bit count required (default 16).
- `expiresAt` — unix milliseconds when the token stops being valid (at most `now + 5 minutes` at creation).
- `resource` — `<roomId>:<deviceId>:<requestPathHash>` where `requestPathHash = base64url(first 8 bytes of SHA-256(HTTP-METHOD || " " || URL-PATH))`. Binds the token to a single request shape.
- `rand` — `base64url(16 random bytes)`. Per-token nonce that the relay tracks for replay protection.
- `counter` — decimal counter the client increments until `SHA-256(token)` meets the difficulty.

### Hash Function

```text
hash = SHA-256(utf8(token-string))
```

The token is valid iff `hash` has at least `difficulty` leading zero bits (counted from the high bit of byte 0).

### Difficulty

Pinned at **16 bits** (median ~65k SHA-256 attempts; ~50ms on a modern x86 core, ~250ms on a Raspberry Pi 4, ~150ms in a browser Web Worker). Per-room override via `policy.powBits` at room creation (server-clamped to `[12, 24]`).

### Server Validation

The relay verifies, in order:

1. Token parses; all six fields present; no extra colons inside any field.
2. `v` equals `v2`.
3. `difficulty >= max(policy.powBits, 12)`.
4. `expiresAt > now` and `expiresAt <= now + 10 minutes` (clock skew tolerance).
5. `resource` matches the actual `(roomId, deviceId, requestPathHash)` derived from the request.
6. `SHA-256(token)` has `difficulty` leading zero bits.
7. Token not present in the per-room recently-seen set (replay protection, see below).

Any failure → `400 ATTN_POW_INVALID`. No retry hint — the client must mint a new token.

### Replay Protection

The DO stores accepted tokens under `meta:pow_seen:<expiresAt>:<sha256(token)>` so a hibernated DO doesn't forget across naps. A periodic alarm prunes entries 10 minutes after `expiresAt`.

### Client Implementation

```text
mint(roomId, deviceId, method, path, difficulty):
  resource = roomId + ":" + deviceId + ":" + base64url(sha256(method + " " + path)[:8])
  rand = base64url(random 16 bytes)
  expiresAt = now + 5 minutes
  counter = 0
  loop:
    token = "attn-pow:v2:" + difficulty + ":" + expiresAt + ":" + resource + ":" + rand + ":" + counter
    if leading_zero_bits(sha256(token)) >= difficulty:
      return token
    counter += 1
```

Both Rust and TS implementations:

- Mint PoW off the UI thread (Rust: `tokio::task::spawn_blocking`; TS browser: Web Worker).
- Maintain a small pool of fresh tokens per `(method, path)` so a burst of writes (e.g., an agent submitting 20 findings) doesn't pay the 50ms cost serially. Pre-mint while idle.
- Discard tokens that are within 30 seconds of `expiresAt` to avoid request-time-of-flight expiry.
- Tokens are non-interchangeable: a PoW for `POST /envelopes` is rejected on `POST /acks`.

### Test Vectors

Add to `planning/collab/test-vectors/pow.json`:

- Fixed `resource`, fixed `rand`, fixed `expiresAt`, fixed difficulty (16) → expected `counter` that meets difficulty, expected SHA-256 hash, expected full token string.
- One vector per (method, path) pair the relay accepts, to lock the `requestPathHash` derivation.

## Signatures

Every `ReviewEvent` is signed by the device that authored it.

```text
signedBytes := canonicalJSON(eventMeta || eventBody)
signature   := Ed25519-Sign(deviceSigningKey, signedBytes)
```

Then:

```ts
event.auth = {
  signature: base64url(signature),
  signingKeyId: base64url(SHA-256(devicePublicSigningKey))
};
```

On import:

1. Look up the device record (from `GET /v2/rooms/:roomId/devices` cache) by `(authorId, deviceId)`.
2. Verify `signingKeyId == SHA-256(device.publicSigningKey)`. Reject on mismatch — this catches a key-rotation/swap attempt.
3. Verify the signature against `device.publicSigningKey`.
4. Reject the event if signature fails.
5. Importantly: signature verification happens **after** AEAD decryption (the signature is over plaintext).

### Canonical Bytes for Signature

The signed string is the canonical JSON of:

```ts
{
  meta: {
    v: 2,
    eventId: "...",
    roomId: "...",
    authorId: "...",
    deviceId: "...",
    createdAt: <int>,
    parentEventIds: ["..."],
    snapshotId: "..." | null
  },
  body: { /* ReviewEventBody */ }
}
```

`auth` is **never** part of the signed bytes (it contains the signature itself).

## Canonical JSON (RFC 8785 JCS)

For any field that is signed, hashed-into-an-ID, or used as AEAD AAD:

- Object keys sorted ASCII-ascending (`a < A` per ASCII, but in practice all our keys are lowercase or camelCase ASCII).
- No insignificant whitespace.
- UTF-8 encoded, no BOM.
- Strings escaped per JSON spec, with `\u` escapes only for control characters and `"` and `\`.
- Numbers serialized per ECMA-404 + IEEE 754 round-trip rules. We avoid non-integer numbers in signed payloads to sidestep float-format drift — timestamps are integers (milliseconds), counts are integers.
- `null` is `null`; absent fields are *omitted*, not serialized as `null`. (This must be consistent: don't emit `"snapshotId": null` if the field is absent; just don't emit the key.)

Ship a small library function in both the Rust and TS clients. Add a corpus of test vectors so two implementations stay in sync.

## ID Construction

All IDs are deterministic where possible — this lets retries and dedupe work without persisting random nonces.

### `EventId`

Content-addressed, self-validating.

```text
EventId = base64url(SHA-256(canonicalJSON({
  meta: {
    v, roomId, authorId, deviceId, createdAt,
    parentEventIds,  // sorted
    snapshotId      // omit if absent
  },
  body
})))
```

Note: `eventId` is itself part of `meta` on the wire, but it is **not** part of the bytes used to derive itself. Compute `eventId` from the body+meta-without-eventId, then write it into `meta.eventId` for transmission.

`parentEventIds` is sorted ASCII-ascending before hashing so reordering doesn't change the ID.

### `EnvelopeId`

Deterministic from a client nonce so retries are safe.

```text
EnvelopeId = base64url(first 16 bytes of SHA-256(
  "envelope v2" || roomId || deviceId || clientNonce
))
```

`clientNonce` is a 16-byte random value generated once per envelope and *persisted in the outbox before any send attempt*. Retries reuse the same `clientNonce`, producing the same `EnvelopeId`, which the relay deduplicates.

For envelopes that wrap a single `ReviewEvent`, an even simpler rule is acceptable:

```text
EnvelopeId = base64url(first 16 bytes of SHA-256("envelope v2" || roomId || eventId))
```

This is also deterministic and removes the need for a separate `clientNonce` for event envelopes. Use this form for `kind: "event"`. Use the `clientNonce` form for `kind: "signal"` and `kind: "snapshot_blob"`.

### `SnapshotId`

```text
SnapshotId = base64url(first 16 bytes of SHA-256(
  "snapshot v2" || roomId || fileId || baseHash || createdAt-as-string
))
```

### `FileId`

Already specified in `data-model.md`:

```text
FileId = base64url(first 16 bytes of SHA-256(
  "attn file v2" || roomSecret || displayPath || firstSnapshotHash
))
```

Note: `roomSecret` is used here intentionally — the FileId is unguessable by anyone who doesn't have room access, even if they later learn the displayPath. This matters for cross-room privacy.

### `ContentHash`

Canonical UTF-8 markdown bytes, SHA-256.

```text
ContentHash = base64url(SHA-256(markdownBytesUtf8))
```

Where `markdownBytesUtf8` is the bytes as they would be written to disk: no BOM, normalized line endings to LF, trailing-newline policy preserved as authored. **Do not** re-serialize through ProseMirror before hashing — hash the bytes the user (or the apply flow) actually wrote.

### `DeviceId` and `ParticipantId`

Client-chosen. Convention:

```text
DeviceId      = base64url(16 random bytes) generated once per install, persisted in ~/.attn/identity.json
ParticipantId = base64url(16 random bytes) generated once per participant (often same as DeviceId for single-device users)
```

These are *not* hashed from public keys. A device can rotate its signing key (in theory) without changing its DeviceId — but `POST /devices` rejects key changes for the life of the room (TOFU within room). Inter-room key rotation is fine.

## Signing-Key Publication (Bootstrap)

This is the open question from the audit. The decision:

### Owner

1. Owner generates `roomSecret` and an Ed25519 keypair.
2. Owner calls `POST /v2/rooms/:roomId` with `ownerSigningKey = devicePublicSigningKey`. The relay stores it as `ownerSigningKeyId`.
3. Owner calls `POST /v2/rooms/:roomId/devices` with `kind: "owner"`. The relay verifies `publicSigningKey == ownerSigningKey` stored at creation. If mismatch → `403 ATTN_OWNER_KEY_MISMATCH`.
4. Owner emits a `RoomCreated` event signed with the device's signing key. The event body includes the same public key:
   ```ts
   {
     type: "room_created",
     ownerPublicSigningKey: "<base64url>",
     policy: { ... }
   }
   ```
5. From this point on, anyone importing events validates that `RoomCreated.ownerPublicSigningKey` matches the signing key on the event's `auth`, and *also* matches the relay's `ownerSigningKeyId` (fetched from `GET /devices`).

Two independent checks (server-stored owner key + event-attested owner key) defeat a pre-publication impersonation attempt: a malicious peer cannot register `kind: "owner"` without matching `ownerSigningKey`, and even if the relay were compromised, the in-event attestation provides offline-verifiable proof.

### Reviewer / Agent

1. Reviewer parses the invite, derives keys.
2. Reviewer generates an Ed25519 keypair, an X25519 keypair (for future direct device-to-device E2E; not required today).
3. Reviewer calls `POST /devices` with `kind: "reviewer"` (or `"agent"`). The `selfSignature` proves the caller controls the private key.
4. Reviewer emits a `ParticipantJoined` event:
   ```ts
   {
     type: "participant_joined",
     participantId: "...",
     deviceId: "...",
     publicSigningKey: "...",
     publicEncryptionKey: "...",
     displayName: "...",
     kind: "reviewer" | "agent"
   }
   ```
   signed by the new keypair.
5. Other participants, on import:
   - Verify the `ParticipantJoined` event's signature against the embedded `publicSigningKey`.
   - Verify that the embedded `publicSigningKey` matches the relay's `GET /devices` entry for this `(participantId, deviceId)`.
   - If consistent, trust this key for all subsequent events from this device. (TOFU within the room.)
   - If a later event arrives signed by a *different* key for the same `(participantId, deviceId)`, reject it — `POST /devices` already enforces this on the server, but verify client-side too.

The first `ParticipantJoined` event is the trust anchor for that device. The relay's enforcement of immutable `(participantId, deviceId) → publicSigningKey` binding plus client-side TOFU plus the in-event self-attestation gives three layers, any one of which catches a tampering attempt.

### Pre-Publication Race

What if a malicious peer with the URL races to register `kind: "owner"` before the legitimate owner does?

- They cannot, because `POST /devices` with `kind: "owner"` requires the public key to match the `ownerSigningKey` from `POST /v2/rooms/:roomId`. Only the real owner could have submitted that creation request (they're the one who knows their own private key).
- What if they race the *room creation* (since admission only requires `roomSecret`)? They could create the room with their own key as `ownerSigningKey`. **This is the worst case.** Mitigations:
  - Room creation is the first thing the legitimate owner does on share. The URL only exists after `roomSecret` is generated client-side; the attacker would need to leak the URL *and* race the creation HTTP call. In normal flows (share button → URL displayed) this race window is microseconds.
  - For high-stakes use, the share UI can wait for `POST /v2/rooms/:roomId` to return `201` before revealing the URL. Document this as best practice.

### Out-of-Band Verification

For paranoid users, the UI exposes a "verify owner key" affordance: display `SHA-256(ownerSigningKey)` truncated to 12 hex chars. Owner reads it to reviewer out-of-band (Signal, phone). Reviewer's UI verifies the same value. This is optional but should exist.

## What Is Signed vs. Encrypted

| Artifact | Encrypted | Signed |
|---|---|---|
| `ReviewEvent` body | Yes (eventKey, AEAD with AAD = meta) | Yes (event signature in `auth`) |
| Snapshot bytes (large, R2) | Yes (snapshotKey, AEAD) | Indirectly (referenced by signed `SnapshotCreated` event) |
| Snapshot bytes (inline) | Yes (eventKey if inline in `SnapshotCreated`, AAD-bound) | Via the event signature |
| Signaling payload (offer/answer/ICE) | Yes (signalingKey, AEAD) | No (ephemeral; the AEAD MAC binds it to the envelope's AAD which includes authorId/deviceId) |
| Admission HMAC | n/a (it *is* the auth) | n/a |
| Owner-only request signature (`Attn-Owner-Signature`) | n/a | Yes (Ed25519 over canonicalRequest, verified against `ownerSigningKey`) |

## Forward Compatibility

- `v: 2` is wired into every derived `info` string. A future `v: 3` will derive distinct keys from the same `roomSecret`, so v2 ciphertexts will not validate under v3 keys (and vice versa). This is intentional.
- Algorithm agility is deferred. A future spec may add `algSuite` to the room policy; today there is exactly one suite.
- Two-version coexistence within one room is **not supported**. The first device sets the version; later devices must speak the same one.

## Test Vectors (to ship in the repo)

`planning/collab/test-vectors/` should contain:

1. `kdf.json` — fixed `roomSecret` → expected `roomId`, `rootKey`, `eventKey`, `snapshotKey`, `signalingKey`, `admissionKey`.
2. `canonical-json.jsonl` — pairs of `{ input, canonical }` covering: nested objects, unicode strings, numbers, arrays, omitted-null vs explicit-null cases, empty objects/arrays.
3. `event-signature.json` — fixed event meta+body, fixed signing key → expected signature.
4. `event-id.json` — fixed event meta+body → expected EventId.
5. `aead.json` — fixed key, fixed plaintext, fixed nonce → expected ciphertext. (Decryption side runs with these to confirm interop.)
6. `envelope.json` — full round-trip: event → canonical → sign → AEAD-encrypt → envelope JSON.
7. `pow.json` — fixed resource+rand+expiresAt → expected counter, hash, full token string. One vector per `(method, path)` the relay accepts.

Both the Rust and TS test suites must pass against this corpus.

## Implementation Order

1. Implement and test canonical JSON in both Rust and TS against the corpus.
2. Implement KDF wrapper; test against `kdf.json`.
3. Implement AEAD wrapper; test against `aead.json`.
4. Implement Ed25519 sign/verify wrapper; test against `event-signature.json`.
5. Implement hashcash mint + verify; test against `pow.json`. Make the miner cancellable and Web-Worker-able (TS) / `spawn_blocking`-able (Rust) from day one.
6. Implement EventId/EnvelopeId/SnapshotId/FileId helpers; test against `*-id.json`.
7. Implement the envelope assemble/disassemble path end-to-end; test against `envelope.json`.
8. Only then start using the primitives from `manager.rs` and the frontend store.

The corpus must exist before the implementation, not after. Otherwise the two clients will diverge subtly and signature verification will mystery-fail in production.
