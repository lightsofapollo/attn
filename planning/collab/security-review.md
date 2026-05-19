# attn Collaboration v2 — Security Review

**Reviewer**: Claude Opus 4.7 (1M ctx) agent on behalf of James Lal (james@lightsofapollo.com)
**Branch**: worktree-agent-ab8b70e09cf831b85 (rebased on `collab`)
**Date**: 2026-05-19
**Bd issue**: attn-nnj.11.5
**Spec baseline**: `planning/collab/crypto-spec.md` + `planning/collab/amendments.md` (16 locked decisions, 2026-05-18) + `planning/collab/relay-spec.md`
**Scope**: Rust client (`src/review/**`), TS browser client (`web/src/lib/review/**`), relay Worker (`relay/src/**`). WebRTC TURN, CORS, large-flood DoS, and DO-hibernation rate-limit accuracy are explicitly **deferred** (see §9).

## TL;DR

Across the seven focus areas, **two HIGH** findings, **three MEDIUM**, and **four LOW** were flagged. No CRITICAL. The crypto chain is in good shape: decrypt-then-verify ordering is correct everywhere it runs in production, AEAD AAD bindings are complete per spec, signing-key-id mismatch fires before signature verify, and EventId is recomputed on import. The HIGH findings are not "the code is wrong" so much as "documented gaps the spec accepts but the threat model should be explicit about": (H1) the room-create POST is by construction un-admitted (pre-publication race), and (H2) signal envelope `target.deviceId` is not AAD-bound (relay can redirect to wrong peer; receivers must reject via the inner `from` field, which they do — but documentation should make this an enforced invariant in the inbound dispatch). The remaining medium/low findings are nits: redundant constant-time compares, signal AAD shape vs inner-payload cross-check, an opaque `expiresAt` window that lets a malicious client hold a token alive ~10 min instead of the documented ~5.

The relay's pow_seen replay set, owner-key TOFU, fragment-stripping (browser), HMAC admission, and owner-signature paths all pass.

---

## 1. Crypto envelope handling

### Decrypt-then-verify order — PASS

`src/review/envelope.rs::disassemble_event_envelope` (lines 333–400) is the sole production decrypt+verify call site. The pipeline is:

```text
1. Rebuild AAD from cleartext envelope fields  (envelope.rs:344–352)
2. base64url-decode nonce + ciphertext         (envelope.rs:355–367)
3. aead::open(eventKey, nonce, ct, aad)        (envelope.rs:369)        ← AEAD first
4. serde_json::from_slice → ReviewEvent         (envelope.rs:374)
5. Look up verifying key by signingKeyId       (envelope.rs:378–380)
6. verify_event(vk, meta, body, auth)          (envelope.rs:386)        ← signature second
7. derive_event_id(meta, body) == meta.eventId (envelope.rs:392–398)    ← EventId recompute
```

A grep over `src/review/**` for `verify_event` / `verify(` confirms **no other production verify-without-decrypt path exists** (test fixtures excepted). The downstream caller `transport/inbound.rs::InboundPipeline::import_event_envelope` delegates entirely to `disassemble_event_envelope` (inbound.rs:229–241) and adds no additional pre-AEAD verify.

This satisfies crypto-spec.md §Signatures step 5 ("signature verification happens **after** AEAD decryption") and amendments.md trust-model framing.

### signingKeyId == SHA-256(publicSigningKey) check — PASS

`src/review/crypto/signing.rs::verify_event` (line 281–288) checks `auth.signingKeyId == base64url(SHA-256(verifyingKey.bytes()))` BEFORE invoking Ed25519's `key.verify(bytes, signature)`. This catches the "the cache has the right keyId but somehow the wrong public-key bytes" trap. Test coverage at signing.rs:391–405 (`wrong_verifying_key_rejects`) and signing.rs:440–458 (`tampered_signing_key_id_rejects`).

`DisassembleInput.verifying_keys` is a `HashMap<signingKeyId, DeviceVerifyingKey>` — keyed by the same hash the auth carries — so the lookup itself is `O(1)` and any mismatch surfaces as either `EnvelopeError::UnknownSigner` (cache miss) or `SignError::SigningKeyIdMismatch` (cached wrong bytes).

### AAD binding completeness — PASS, with one signal-envelope caveat (see §1.5/H2)

`src/review/crypto/aead.rs::EnvelopeAad` (lines 84–97) binds exactly the six fields crypto-spec.md §Envelope Encryption mandates:

| Field | Spec required | In `EnvelopeAad` |
|---|---|---|
| `v: 2` | yes | yes |
| `roomId` | yes | yes |
| `envelopeId` | yes | yes |
| `kind` | yes | yes |
| `authorId` | yes | yes |
| `deviceId` | yes | yes |
| `createdAt` | yes | yes (`i64`) |

The AAD is canonical-JSON-serialized via `canonical::to_canonical_bytes` on both sides (sender at envelope.rs:286–294, receiver at envelope.rs:344–352 and inbound.rs:317–326). Receiver tests `aead_envelope_id_change_fails_decrypt`, `aead_kind_change_fails_decrypt`, and `aead_author_id_change_fails_decrypt` (aead.rs:260–303) prove that mutating any AAD field invalidates the MAC.

**Cross-impl AAD-bytes lock**: `corpus_replay_matches_expected_ciphertext` (aead.rs:602–659) re-canonicalizes the typed `EnvelopeAad` from the JSON view in `test-vectors/aead.json` and asserts byte-equality with the corpus's `aad` bytes — a divergent JS implementation will fail this on import.

### EventId recompute — PASS

`disassemble_event_envelope` line 392–398 recomputes `EventId = base64url(SHA-256(canonicalJSON({meta-without-eventId, body})))` (per crypto-spec.md §ID Construction `EventId`) and compares to `event.meta.eventId`. Any mismatch surfaces as `EnvelopeError::EventIdMismatch` with the expected and actual ids. The envelope.rs module comment at line 88–93 ("Should be impossible in normal operation, surfaced as a hard error") reads correctly.

### Findings

#### M1 — `createdAt` AAD field is `i64` on the wire but `u64` on the envelope. *Severity: Medium.*

`EnvelopeAad.created_at: i64` (aead.rs:96), `MailboxEnvelope.created_at: u64` (model.rs), `AssembleInput.created_at_ms: u64` (envelope.rs:172). Conversion is `as i64` (envelope.rs:293) on the sender and `as i64` on the receiver (envelope.rs:351, inbound.rs:325). For any timestamp under 2^63 ms (∼ year 292M), `u64 as i64` is identity, so this is safe today. But a single sign-bit divergence between two implementations would silently break AEAD decryption with an opaque `AeadError::Decrypt` — exactly the kind of bug that's expensive to diagnose.

**Recommendation**: pick one and stick with it across the spec, model, and AAD. crypto-spec.md uses "unix milliseconds (integer)" without signedness; pin to `u64` everywhere and have the AAD encoding produce the same canonical-JSON bytes as a JS `Number` would (both will emit the integer literal — same bytes). Add a vector in `test-vectors/aead.json` exercising `created_at > 2^53` to lock JS Number precision behavior before browser client ships.

#### L1 — `auth` is serialized into the AEAD plaintext but never re-checked against the recovered event's `auth.signature` field for tamper-after-decrypt. *Severity: Low (defense-in-depth).*

The plaintext is `canonical::to_canonical_bytes(&ReviewEvent { meta, body, auth })` (envelope.rs:281) — i.e. the signature is encrypted alongside the body. On decrypt, `event.auth.signature` is what `verify_event` consumes (envelope.rs:386). If an attacker has the eventKey (catastrophic but worth thinking about — e.g. compromised reviewer device), they could forge a ciphertext where `auth.signature` doesn't match `body` — but then `verify_event` rejects. No actual issue. Mentioned only because the symmetry between "AAD binds metadata" and "auth binds plaintext via signature" should be explicit somewhere in the spec.

**Recommendation**: add one line to crypto-spec.md §Envelope Encryption explicitly noting that `auth.signature` is part of the encrypted plaintext (so an attacker who only has the cleartext envelope cannot strip+forge a signature). No code change.

---

## 2. PoW token replay window

### What's enforced

- `relay/src/pow.ts::verifyPow` (lines 146–195) runs all 7 spec steps in order.
- `expiresAt` bounds: `expiresAt > now` AND `expiresAt <= now + POW_MAX_LIFETIME_MS` where `POW_MAX_LIFETIME_MS = 10 * 60 * 1000` (pow.ts:33). Per spec, mint expiry is 5 min; server tolerates 10 min for clock skew. Implemented correctly.
- `resource` matches `(roomId, deviceId, base64url(SHA-256(METHOD " " urlPath)[:8]))` via constant-time string compare (pow.ts:172–177). The `roomId` in the token must match the URL roomId; cross-room replay is blocked.
- `replay set` keyed by `SHA-256(token)` base64url; stored at `pow_seen:<hash>` (relay/src/room-do.ts:94–97). `isPowSeen` checks (room-do.ts:2186–2188), `markPowSeen` writes the `expiresAt` so the alarm can prune (room-do.ts:2190–2194). The replay set lives in the per-room DO storage so it survives DO hibernation (until the alarm wipes expired entries 10 min after `expiresAt`).

### Findings

#### M2 — `expiresAt` upper bound of `now + 10min` lets a client hold a token alive longer than the spec's 5-min mint suggests. *Severity: Medium.*

The relay accepts tokens whose mint-time `expiresAt` is anywhere in `(now, now+10min]`. The crypto-spec.md says mints are "at most `now + 5 minutes`," so the extra 5 minutes is intended only for clock skew — but the verifier conflates "mint-side budget" with "skew budget." A malicious client can deliberately set `expiresAt = now + 10min` (consistent with the verifier) and reuse the token within that window for any number of distinct request shapes that share the same `(method, path)` — wait, they can't, because the replay set rejects re-use of the same token bytes. So the impact is bounded: a malicious client gets one extra 5-minute window of "this token costs 1 mint, not 2" amortization on a single request, then it's burned.

**Recommendation**: tighten the upper bound to `now + (5 min mint + 1 min skew) = now + 6 min`. Most reasonable client clocks are within ±30s of NTP; 1 minute is plenty. This costs nothing and gives the spec's 5-min number teeth. Alternatively, document the 10-min number in crypto-spec.md so future readers don't see "5 min" and assume that's the enforced ceiling.

#### L2 — `parsePow` accepts any `expiresAt` ≤ `Number.MAX_SAFE_INTEGER`. *Severity: Low.*

A future malicious client could set `expiresAt` to a far-future value before the upper-bound check; the upper bound at line 164 catches it. No actual issue; just observe that the parser is permissive on purpose so the verifier can produce a precise error.

#### PASS — token cannot be reused across:

- **rooms**: `roomId` is in the token's resource and verified against the URL roomId via constant-time compare.
- **devices**: `deviceId` likewise.
- **method**: `requestPathHash = SHA-256("POST /v2/rooms/X/envelopes")[:8]` ≠ `SHA-256("DELETE /v2/rooms/X")[:8]`.
- **path**: same.
- **the same request twice**: replay set rejects on `SHA-256(token)` collision.

The replay set is **per-DO/per-room**, which is the right scope: a different room has different storage. Combined with the roomId binding in the token, an attempt to reuse a token from room A against room B fails both the resource check and the replay set is empty (so the latter would let it through if not for the resource check). Defense in depth holds.

---

## 3. OwnerSigningKey TOFU correctness

### What's enforced

- **First create**: `relay/src/room-do.ts::handleRoomCreate` (lines 299–434) reads `ownerSigningKey` from the body (validated as 32 bytes Ed25519), computes its SHA-256 → `ownerSigningKeyId`, and persists both atomically with the policy + admissionKey in one `ctx.storage.put` (lines 396–411). Storage is keyed by `META.ownerSigningKey` and is **never written again** — there is no UPDATE path in the file.
- **Rejoin POST /rooms**: returns the existing room shape without touching `ownerSigningKey` (lines 314–344). Admission HMAC required (lines 317–342).
- **POST /devices kind="owner"**: in `handleDeviceRegister` (lines 584–593): loads `META.ownerSigningKey`, constant-time compares against `signingKeyBytes` decoded from the body; mismatch → `403 ATTN_OWNER_KEY_MISMATCH`. Constant-time compare uses `constantTimeBytesEqual` (admission.ts:204).
- **Reviewer device registration** (lines 595–606): upsert by `(participantId, deviceId)`. Existing record with a different `publicSigningKey` → `409 ATTN_DEVICE_KEY_CHANGED`. This is the per-device TOFU.
- **ParticipantJoined event chain** (per spec §Signing-Key Publication step 5, executed client-side in inbound pipeline + ReviewManager): the in-event `publicSigningKey` is the trust anchor; `GET /devices` is cross-checked.

### Findings

#### H1 — Room-create POST cannot be admission-verified (chicken-and-egg). *Severity: High — accepted by amendments.md but should be threat-modeled explicitly.*

`schema.ts` lines 56–67 acknowledge this: "The first POST therefore cannot be admission-verified (no stored key yet); the trust boundary remains URL possession." So anyone who learns the roomSecret **before** the legitimate owner finishes `POST /rooms` can register themselves as the owner. crypto-spec.md §Pre-Publication Race documents the mitigation: "share UI can wait for `POST /v2/rooms/:roomId` to return `201` before revealing the URL."

This is a real attack against any flow where the URL leaks early (e.g. an "owner clicks share, then race for the create call" UI bug). Today no UI code path leaks; tomorrow somebody adds a "copy URL early" affordance and the property breaks.

**Recommendations**:
1. Document the threat-model expectation in `crypto-spec.md` §Invite URLs and in the share-UI design (when 9.x lands): **the URL MUST NOT be exposed to the user UI until `POST /rooms` returns `201`**.
2. Add a server-side defense: when `POST /rooms` first creates a room, require `Attn-Owner-Signature` over the canonicalRequest (the body already carries `ownerSigningKey`, so this is self-verifying). The relay computes canonicalRequest, then verifies via Ed25519. This means: even with the URL, an attacker without the owner's private key cannot create the room — they'd need the keypair, which is generated client-side and never leaves the legitimate owner's device. The signature self-roots: `verify(ownerSigningKey, canonicalRequest, signature)` where ownerSigningKey is read out of the body. Pre-publication race window shrinks from "any time before create" to "any time the attacker can compute Ed25519 over a canonical request" — which is zero, because they don't have the private key. This is a low-cost defense and changes the trust boundary from "URL possession" (URL is plaintext over WSS/HTTPS) to "URL possession AND owner private-key possession." Worth doing.
3. Re-creation attack: confirmed handled. `existingCreatedAt !== undefined` at room-do.ts:314 routes to the rejoin path (admission-verified) before any storage write. There is no UPDATE on `META.ownerSigningKey`; a hostile rejoin cannot rotate the owner key.

#### PASS — Reviewer ParticipantJoined trust chain

Per crypto-spec.md §Reviewer/Agent flow, the relay's `POST /devices` enforces `(participantId, deviceId) → publicSigningKey` immutability via the 409 at room-do.ts:600–606. The client side (per spec §Reviewer flow step 5) is expected to cross-check the in-event `publicSigningKey` against `GET /devices`. The inbound pipeline does not implement that cross-check yet — but the relay's enforcement plus the keyId-binding inside `verify_event` is sufficient: a wrong-key envelope fails `verify_event` (key swap detected by signingKeyId mismatch), and the relay refuses to register a different key under the same `(participantId, deviceId)`. **Three layers as advertised.** Recommend adding the client-side cross-check explicitly when `ReviewManager` lands the device-directory refresh (attn-nnj.2.x).

---

## 4. Browser fragment-stripping race window

### What's enforced

`web/src/lib/review/browser-invite.ts::parseAndStripInviteFromUrl` (lines 127–160):

1. Reads `window.location.hash`.
2. Validates it starts with `#key=`.
3. Reconstructs the full URL and parses via `parseInviteUrl` (which validates base64url and 32-byte length).
4. **Then** calls `stripFragment(win)` (line 157) which invokes `history.replaceState(null, "", pathname+search)` — the **first** thing it does after the parse succeeds.

The strip executes synchronously in the same tick as the parse, before any awaited promise resolves and before any return to the event loop.

### Findings

#### M3 — Strip happens AFTER parse, not BEFORE. If `parseInviteUrl` throws (invalid invite), the fragment lingers. *Severity: Medium.*

The comment at lines 150–156 notes: "We call replaceState first regardless of parse success so a malformed invite still gets sanitized — but `parseInviteUrl` above already threw if invalid, so we only reach here on success. If parse failed, the caller (which wraps in try/catch) should still want the fragment gone; we surface the strip via a separate helper for that flow."

The intent is documented but the contract relies on the caller's try/catch calling `stripFragment` themselves on failure. That's a foot-gun: a future caller without the explicit catch leaves the fragment in the URL bar.

**Recommendations**:
1. Reverse the order: `stripFragment(win)` FIRST, then `parseInviteUrl(fullUrl)`. The parse uses the already-extracted `fullUrl` string; stripping the live `location.hash` first does not affect the local string copy. This is a one-line move (lines 148 ↔ 157) and removes the contract dependency on the caller.
2. Document in the function header that the fragment is **always** stripped, regardless of parse success.

#### Leak vectors examined and mitigated:

- **`document.title` / URL bar**: stripped before any `await` returns control; the browser repaints with the new URL atomically.
- **`Referer` header**: the fragment is never sent in `Referer` per RFC 7231 §5.5.2 (fragments are not part of `Request-URI` for header derivation). Confirmed safe.
- **Analytics SDKs that auto-capture `location.href`**: these typically run on `DOMContentLoaded` or first user interaction. If they fire after our parse-and-strip, they see the cleaned URL. If they fire BEFORE (e.g. in `<head>` synchronously), they could read the fragment. **Mitigation**: invoke `parseAndStripInviteFromUrl` as early as possible in `App.svelte`'s `onMount` — ideally before any third-party script tag. Document this in the integration guide for browser hosting.
- **Service workers**: an SW that calls `event.request.url` on the navigation request only sees the URL minus the fragment (browser does not forward fragments to SWs by default). Safe.
- **Browser extensions / DevTools**: these can read `location.hash` at any point. Out of scope: a hostile extension already has full access. Document as a known limitation.
- **`window.name`, `localStorage`, `sessionStorage`**: confirmed not used by browser-invite.ts (verified via grep). amendments.md #13 pins memory-only.
- **`performance.getEntriesByType("navigation")[0].name`**: includes the fragment in some browsers but is read-only and one-shot; same race-window as analytics SDKs. Same mitigation: parse-and-strip first.

The current implementation is broadly correct; finding M3 is the one tangible improvement.

---

## 5. Admission HMAC

### What's enforced

`relay/src/admission.ts::verifyAdmission` (lines 83–108):

1. Parse `Attn-Admission: v2.<base64url-hmac>` — strict 32-byte (256-bit) HMAC-SHA-256.
2. Build canonicalRequest = `METHOD\nURL_PATH\nCANONICAL_QUERY\nSHA256(body)` (lines 52–77). Query keys sorted lexicographically and RFC-3986 percent-encoded (lines 172–187, 196–201).
3. HMAC-SHA-256 over canonicalRequest with the per-room `admissionKey`.
4. `constantTimeEquals(expected, provided)` (admission.ts:204–211) — XOR-OR loop, length-checked first.

Constant-time compare correctness: standard pattern (`diff |= a[i] ^ b[i]`). No early return. Length-mismatch returns false (length is itself non-secret here). PASS.

### Findings

#### L3 — `constantTimeStringEquals` in pow.ts (lines 254–261) leaks length via early return on length mismatch. *Severity: Low.*

```ts
export function constantTimeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  ...
}
```

The length of the resource string is non-secret (it's derived from public roomId/deviceId formats), so length-revealing is fine here. Mentioned only because the docstring at line 253 says "length-revealing, content-blind" — explicit and intentional. **No action required.**

#### L4 — CSRF protections. *Severity: Low.*

The relay's write endpoints are admission-HMAC + PoW gated. CSRF is not a concern: an attacker page would need to know the per-room `admissionKey` to forge the HMAC. Cookies / browser-session credentials are never used. **No action required.**

#### Timing leak from `crypto.subtle.sign` / `crypto.subtle.verify`?

WebCrypto operations in Workers/V8 are documented to be constant-time over their secret inputs. The exception is the `subtle.importKey` path, but the key bytes are derived from request-scoped storage reads (not user input), so timing on importKey reveals nothing useful. PASS.

---

## 6. Owner-only ops (DELETE, ack with delete)

### What's enforced

`relay/src/owner-sig.ts::verifyOwnerSignature` (lines 47–113):

1. Header present check (`ATTN_OWNER_SIG_REQUIRED` on missing).
2. ownerSigningKey length check.
3. base64url decode of header → 64-byte Ed25519 signature.
4. canonicalRequest = same bytes as admission HMAC (re-used from admission.ts; clean composition).
5. `crypto.subtle.verify("Ed25519", publicKey, signature, canonical)`.

`handleAcks` (room-do.ts:1116–1316) layers:

```text
1. Admission HMAC                                                          ← URL bearer
2. Schema parse + PoW                                                      ← write-burning
3. Header present? → deleteIntent flag
4. policy.deleteEventsAfterOwnerAck == true ?                              ← policy gate
5. ackingDevice.kind === "owner" ?                                         ← registered-as-owner gate
6. verifyOwnerSignature over canonicalRequest → mayDelete = true            ← cryptographic gate
   Otherwise → 403 ATTN_OWNER_SIG_INVALID
7. Per-envelope ack writes; envelopes deleted only if mayDelete            ← gated mutation
```

`DELETE /v2/rooms/:roomId` (room-do.ts:1542 onward) follows the same pattern: admission, PoW, then verifyOwnerSignature → DO `deleteAll`.

### Findings

#### PASS — Replay defense via canonicalRequest binding

canonicalRequest = `METHOD\nPATH\nQUERY\nSHA256(body)`. A given owner signature is valid for exactly one `(method, path, query, body)` tuple. Replay across requests requires identical bytes → identical canonical-request hash → which means the attacker just proxied the legitimate owner's request. Since these are over WSS/HTTPS, in-transit replay needs MITM; in-storage replay (on the relay-side log) is bounded by PoW (the Attn-PoW header on the same request is single-use via `pow_seen`).

#### PASS — Body hash in canonical bytes

`SHA256(body)` is in the canonical bytes (admission.ts:62–65, reused for owner-sig). Empty-body requests get `SHA256("")` deterministically. No "swap body after sign" path.

#### L5 — Owner-sig and PoW token are computed over the **same** canonical bytes for DELETE/ack. *Severity: Low.*

A subtle cross-protocol concern: if `Attn-PoW` and `Attn-Owner-Signature` both implicitly cover the canonical request, then a token's resource binding plus owner-sig together commit to (roomId, deviceId, method, path). No cross-protocol attack identified — they verify independent properties (compute cost vs identity) — but worth a one-line spec note that the two headers are layered, not interchangeable.

---

## 7. Snapshot ciphertext

### What's enforced (per amendments.md #14: "always AEAD-encrypted under snapshotKey, regardless of transport")

`src/review/transport/inbound.rs::import_snapshot_envelope` (lines 272–285):

1. Reject if `envelope.kind != SnapshotBlob` (kind-dispatch enforcement).
2. `open_blob(envelope, &snapshot_key)` (line 283) — AEAD-open with AAD bound to `(v, roomId, envelopeId, kind="snapshot_blob", authorId, deviceId, createdAt)`.
3. Returns `(envelopeId, plaintext bytes)`. Plaintext is either:
   - Snapshot bytes directly (inline path), or
   - A canonical-JSON `BlobRef` referencing R2 (spillover path).

R2 spillover: per crypto-spec.md §Nonce Discipline, the R2 object body is `nonce || ciphertext || tag` of the snapshot bytes under `snapshotKey` — **separately encrypted** from the BlobRef envelope. Two distinct AEAD operations, two distinct random nonces. The BlobRef inside the envelope plaintext is itself AEAD-protected under `eventKey`-equivalent (snapshotKey AAD-binding via the envelope), and the bulk bytes in R2 are AEAD-protected under `snapshotKey` with their own AAD (TBD per implementation — see L7 below).

### DataChannel path

amendments.md §"Inline snapshot encryption over DataChannel" (lines 178–183) explicitly rescinds the original plaintext-inline-snapshot pathway. `SnapshotCreated.encryptedBlobRef` is the only carrier. The current code does not implement DataChannel snapshot transport yet (Phase 4); the inbound pipeline's `import_snapshot_envelope` is kind-agnostic in transport, so when DataChannel arrives it will go through the same AEAD-open path. PASS once Phase 4 lands; today there is no leak because there is no implementation.

### Findings

#### H2 — `kind="signal"` envelope `target.deviceId` is NOT AAD-bound; relay can redirect a signal envelope to any peer. *Severity: High (signal envelopes only, but worth fixing). Status: **MITIGATED in v2** via inbound-dispatch enforcement (attn-nnj.7.9). Cryptographic mitigation deferred to v3.*

`src/review/transport/signaling.rs::assemble_signal_envelope` (lines 165–181) explicitly omits `target_device_id` from AAD with the comment "matching the crypto-spec.md §Envelope Encryption AAD shape." crypto-spec.md indeed pins the AAD shape to seven fields without `target`. The justification at signaling.rs:170–172 says "Receivers validate origin via the signed `from` field inside the plaintext payload instead."

This is correct for **origin** (the receiver can verify the sender via the `from` field inside the encrypted payload, cross-checked against the AAD-bound `deviceId`). But it doesn't prevent a malicious relay from **delivering the same signal envelope to the wrong target**: the relay sees `target.deviceId` in cleartext and routes accordingly. An attacker who controls the relay can redirect an offer to a peer that wasn't supposed to receive it, leak ICE candidates to non-participants, etc. All recipients are room members (they have signalingKey), so they can decrypt — but they're not the intended recipient.

**Impact**: in WebRTC negotiation, a misrouted offer to peer B (where the offer was for peer A) causes peer B to think they're being asked to negotiate with the sender. The DTLS fingerprint binding in the SDP would prevent actual session hijack (the SDP carries a fingerprint that has to match the DTLS handshake), but the misrouting is itself a privacy break: peer B learns peer A is in the room and is initiating a P2P connection. In a multi-reviewer room, this leaks the room topology to a relay attacker.

**v2 mitigation (LANDED, attn-nnj.7.9)**: `InboundPipeline::import_signal_envelope` now takes an `expected_target_device_id: &DeviceId` parameter and enforces `envelope.target == None || envelope.target.deviceId == expected` BEFORE AEAD-open. Mismatches return the new `InboundError::TargetDeviceMismatch { expected, actual }` so a relay-redirected envelope is dropped before its plaintext reaches the WebRTC state machine or the WS event channel. Both call sites — `transport::webrtc::handle_inbound_envelope` (DataChannel path) and `transport::mailbox::ws::MailboxWsClient::handle_envelope` (mailbox WS path) — pass their local DeviceId from `WebRtcConfig.local_device_id` / `MailboxConfig.device_id` respectively. Broadcast signal envelopes (`target=None`) are still accepted; the relay-spec wire format supports them and the WebRTC state machine uses them for "advertise presence" flows. Unit tests in `transport::inbound::tests` cover: target=self → accept; target=Some(other) → `TargetDeviceMismatch`; target=None (broadcast) → accept.

**v3 amendment (deferred)**: optionally extend `EnvelopeAad` to include `target` for `kind="signal"` only. Cost: AAD shape diverges by kind; existing test corpora + the TS/WASM client need a coordinated bump. Benefit: makes target-redirect a Poly1305 MAC failure at decrypt time instead of a post-decrypt application-level check. Tracked as a v3 spec candidate; the v2 server-trust-style mitigation already closes the privacy gap for the threat model in this review.

**Recommendations** (historical, retained):
1. **Inbound dispatch**: enforce that the recovered `SignalingPayload`'s receiver (implicitly the local device) cross-checks against `envelope.target.deviceId == self.device_id`. The `disassemble_signal_envelope` in `signaling.rs` does not do this. The caller (WebRTC layer, Phase 4) should reject signal envelopes whose `target.deviceId` is not self. Document this as a hard invariant in `signaling.rs` and the inbound pipeline. *— LANDED in attn-nnj.7.9 (moved the enforcement up one layer into `InboundPipeline` so both DC and WS paths share it).*
2. **Spec amendment**: optionally extend `EnvelopeAad` to include `target` for `kind="signal"` only. Cost: AAD shape diverges by kind. Benefit: makes target-redirect a MAC failure. Worth weighing — for now, recommend (1) as the cheap mitigation and treat (2) as a v3 candidate.

#### M4 (replaces #1.5 caveat) — `target` rebinding not provably caught at decrypt time

(See H2 — this is the same finding, downgraded only in the sense that the production code's inbound pipeline currently exposes plaintext upward without checking target. Severity for this issue specifically is High because once Phase 4 wires DataChannel + signaling, a relay attacker could observe + redirect.)

#### L6 — Mailbox snapshot path uses `import_snapshot_envelope` whose AEAD-open is correct, but the caller is responsible for resolving R2 BlobRefs *outside* the encrypted envelope. *Severity: Low.*

The R2 fetch happens after decrypt; the resolved-from-R2 ciphertext is AEAD-decrypted again under snapshotKey. PASS architecturally. Risk: a caller bypassing the AEAD decrypt on the R2-side bytes (e.g. writing them straight to disk) would leak plaintext. The current `import_snapshot_envelope` only returns the BlobRef plaintext, not the resolved blob, so a bypass would have to be a deliberate refactor. Worth a code comment when 5.8 lands.

#### L7 — No explicit AAD on the R2-side AEAD for the bulk snapshot bytes

crypto-spec.md §Nonce Discipline lines 112–115 says "the AEAD encrypts the *blob bytes themselves* ... R2 object body = `nonce || ciphertext || tag` of the snapshot bytes under `snapshotKey`." No AAD on this layer is mentioned. This is acceptable: the BlobRef in the (separately AEAD-protected) envelope carries `contentHash`, which the receiver verifies after R2 fetch + decrypt — so a swapped blob is caught by hash mismatch, not by the AEAD. The AEAD here is confidentiality-only; integrity comes from the contentHash. Document this layering when the R2-side decrypt lands (issue 5.8).

#### PASS — no plaintext snapshot leak across DataChannel, mailbox, or inline-Snapshot event field

- **DataChannel**: not implemented yet; spec mandates AEAD ciphertext only.
- **Mailbox**: `MailboxEnvelope.ciphertext` is always AEAD ciphertext; no plaintext field exists.
- **Inline-Snapshot in `SnapshotCreated` event body**: per amendments.md #14 / §"Inline snapshot encryption" lines 180–183, `inlineSnapshot` carries AEAD ciphertext with snapshot AAD-binding. The event model (`src/review/model.rs`) reflects this via `encryptedBlobRef` only — no plaintext markdown field on `SnapshotCreated`. Confirmed by grep on `inlineSnapshot.*markdown` (no matches in the Rust client).

---

## 8. Top findings + recommendations (ranked)

| # | Finding | Severity | Recommendation |
|---|---|---|---|
| **H1** | Room-create POST is un-admitted by design; pre-publication race possible if URL leaks before create completes | High | Add `Attn-Owner-Signature` requirement on `POST /v2/rooms/:roomId` first-create (owner signs canonicalRequest with the same key being registered). Also document the share-UI invariant in crypto-spec.md. |
| **H2** | `target.deviceId` on signal envelopes is not AAD-bound; relay can redirect signal envelopes to non-target peers | High → **Mitigated (v2)** | `InboundPipeline::import_signal_envelope` enforces `envelope.target == None \|\| envelope.target.deviceId == self.device_id`; both DataChannel + mailbox-WS callers pass their local DeviceId (attn-nnj.7.9). v3 candidate: bind `target` directly into AAD for `kind="signal"`. |
| **M1** | `EnvelopeAad.created_at: i64` vs `MailboxEnvelope.created_at: u64` — silent type-width drift between Rust/TS would surface as opaque AEAD decrypt failure | Medium | Pin to `u64` everywhere; add a corpus vector with `created_at > 2^53` to lock JS Number behavior. |
| **M2** | PoW `expiresAt` upper bound is `now + 10min`; spec says 5-min mint expiry. Lets a malicious client hold a token alive longer than intended | Medium | Tighten to `now + 6min` (5-min mint + 1-min skew). |
| **M3** | `parseAndStripInviteFromUrl` strips fragment AFTER parse; if parse throws, fragment lingers and caller must remember to strip | Medium | Reverse order: `stripFragment(win)` first, then `parseInviteUrl(fullUrl)`. |
| **M4** | (merged into H2) | — | — |
| L1 | `auth.signature` is AEAD-encrypted alongside body but the spec doesn't note this explicitly | Low | One-line spec addition. |
| L2 | `parsePow` permissively accepts `expiresAt` up to `MAX_SAFE_INTEGER` | Low | No action; upper-bound check catches it. |
| L3 | `constantTimeStringEquals` leaks length via early return | Low | No action — length is non-secret here. |
| L4 | CSRF | Low | No action — no cookies/sessions. |
| L5 | Owner-sig and PoW both bind canonicalRequest | Low | Spec note. |
| L6 | R2 BlobRef resolution bypass risk if caller writes resolved bytes to disk without re-decrypting | Low | Code comment when 5.8 lands. |
| L7 | R2-side AEAD has no AAD; integrity comes from contentHash in the (AEAD-protected) envelope | Low | Document the layering. |

### Follow-up bd issues to create

- `attn-nnj.X` (P1, High): "Require `Attn-Owner-Signature` on `POST /v2/rooms/:roomId` first-create" — addresses H1.
- `attn-nnj.X` (P1, High): "Enforce `envelope.target.deviceId == self.device_id` in signal inbound dispatch" — addresses H2. Block Phase 4 (attn-nnj.7.x) on this landing.
- `attn-nnj.X` (P2, Med): "Tighten PoW `expiresAt` upper bound to `now + 6min`" — addresses M2.
- `attn-nnj.X` (P2, Med): "Pin AAD `created_at` to `u64`, add 2^53-boundary corpus vector" — addresses M1.
- `attn-nnj.X` (P2, Med): "Strip URL fragment before invite parse" — addresses M3.

(Issue ids omitted because this report should not file bd issues — surface to the human reviewer to file in the right epics.)

---

## 9. Areas NOT yet audited (deferred for follow-up)

- **WebRTC TURN credentials**: none today (no TURN server stood up). When TURN is added (Phase 6 or later), audit credential rotation, short-lived TURN REST API tokens, and TURN-server-trust assumptions.
- **CORS allowlist enforcement on the relay**: not reviewed in this pass. The relay is currently called only from the Rust client (no browser CORS preflight); when browser client lands (Phase 6), confirm `Access-Control-Allow-Origin` is set to the specific deployment domain (not `*`), and that `Access-Control-Allow-Credentials` is not set (no cookies are in use).
- **DoS via large signal envelope floods**: maxSignalEnvelopes=64 sub-cap per `(authorId, targetDeviceId)` (room-do.ts FIFO eviction) bounds storage, but the PoW cost per envelope at 16 bits (~50ms client compute) is the only rate-limit. A burst from a compromised reviewer device could chew through the per-room rate-limit budget. Not assessed: whether the rate-limit module's bucket size and per-device burst handling are sized correctly.
- **Rate-limit accuracy under DO hibernation**: when a DO hibernates and resumes, the rate-limit token bucket state may or may not survive (depending on storage write cadence). Not assessed here; the rate-limit module at `relay/src/rate-limit.ts` deserves its own pass with the hibernation timing model.
- **Signed-event canonical-JSON parse-and-reserialize attacks**: not assessed. The signed bytes are produced by the sender's canonical-JSON helper, but the receiver also re-canonicalizes from the recovered (deserialized) event. If two implementations agree on canonical-JSON (which the corpus tests) this is safe. A future audit should re-check after the TS implementation lands.

---

## Sign-off

**Status**: review complete. Findings filed inline; 2 HIGH, 3 MEDIUM, 4 LOW.

**Reviewer**: Claude Opus 4.7 (1M ctx) — automated review per attn-nnj.11.5 task scope.

**Date**: 2026-05-19.

**Next step**: human reviewer (James Lal) files the 5 follow-up bd issues called out in §8, links them to the relevant phase epics, and lands the H1+H2 fixes before public release. M1/M2/M3 fixes can land alongside any of the next Phase 5/6/7 work — they are not blockers.
