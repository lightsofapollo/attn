//! Envelope assemble / disassemble pipeline.
//!
//! This is the integration capstone for the crypto chain (attn-nnj.1.3 through
//! 1.8). It stitches together canonical JSON, deterministic ID derivation,
//! Ed25519 signing, and XChaCha20-Poly1305 AEAD into the single round trip
//! described by `planning/collab/crypto-spec.md` §Implementation Order step 7
//! and §Envelope Encryption (AEAD):
//!
//! ```text
//! assemble(body, meta-without-eventId, eventKey, signingKey):
//!   1. derive EventId from canonicalJSON({meta-no-eventId, body})
//!   2. stamp meta.event_id = derived EventId
//!   3. sign canonicalJSON({meta-no-eventId, body}) under the signing key
//!   4. derive EnvelopeId  (event-form for kind=event, nonce-form otherwise)
//!   5. canonical-JSON the full ReviewEvent {meta, body, auth}
//!   6. AEAD-seal that plaintext under (key, fresh nonce) with the AAD
//!      bound to (v, roomId, envelopeId, kind, authorId, deviceId, createdAt)
//!   7. assemble MailboxEnvelope
//!
//! disassemble(envelope, expected eventKey, verifying-key map):
//!   1. rebuild the same EnvelopeAad from the cleartext envelope fields
//!   2. AEAD-open ciphertext under (key, nonce, aad) -> plaintext
//!   3. parse plaintext into ReviewEvent {meta, body, auth}
//!   4. look up the verifying key for auth.signingKeyId
//!   5. verify Ed25519 signature against canonicalJSON({meta-no-eventId, body})
//!   6. recompute EventId; assert == meta.event_id
//! ```
//!
//! The helpers in this module are deliberately thin shells over the building
//! blocks in `crate::review::crypto::{canonical, kdf, aead, signing, ids}`.
//! They never introduce new crypto — just orchestration + error mapping — so
//! every failure mode is provably reachable through the existing primitives.
//!
//! These helpers are intended to be reused by `review::manager::ReviewManager`
//! (attn-nnj.2.8) and the relay transport layer (Phase 3b).

#![allow(dead_code)]

use std::collections::HashMap;
use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::review::crypto::aead::{self, AeadError, AeadNonce, EnvelopeAad};
use crate::review::crypto::canonical::{self, CanonError};
use crate::review::crypto::ids::{
    IdError, derive_envelope_id_for_event, derive_envelope_id_with_nonce, derive_event_id,
};
use crate::review::crypto::signing::{
    DeviceSigningKey, DeviceVerifyingKey, SignError, sign_event, verify_event,
};
use crate::review::ids::{DeviceId, EventId, ParticipantId, RoomId, SnapshotId};
use crate::review::model::{
    EnvelopeKind, EventAuth, EventMeta, MailboxEnvelope, ReviewEvent, ReviewEventBody,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors returned by `assemble_event_envelope` / `disassemble_event_envelope`.
///
/// Each variant maps 1:1 to a step in the pipeline so failures are
/// diagnosable without inspecting backtraces. AEAD failures intentionally
/// collapse the reason (wrong key, wrong nonce, wrong AAD, tampered bytes)
/// into a single variant — `aead::AeadError::Decrypt` already does this so
/// the relay never leaks which input was bad.
#[derive(Debug)]
pub enum EnvelopeError {
    /// Canonical-JSON encoding of the event, AAD, or plaintext failed.
    Canonical(String),
    /// Ed25519 signature creation/verification failed, or the `signingKeyId`
    /// did not match the verifying key derived from the public bytes.
    Signature(SignError),
    /// AEAD seal/open failed (collapsed reason — see `AeadError::Decrypt`).
    Aead(AeadError),
    /// `derive_event_id` failed (almost always a canonical-JSON failure under
    /// the hood — bubble up cleanly).
    Id(IdError),
    /// `auth.signingKeyId` referenced a device we don't have a verifying key
    /// for. Carries the offending keyId so the caller can log/fetch it.
    UnknownSigner(String),
    /// The plaintext recovered from AEAD failed to parse as a `ReviewEvent`.
    /// Distinguished from a canonical-JSON error so the relay knows the bytes
    /// decrypted cleanly but were structurally wrong.
    InvalidPlaintext(String),
    /// Recomputed EventId did not match the EventId carried in `meta`. Means
    /// the event was tampered with after being signed and the signature
    /// verification was somehow bypassed — should be impossible in normal
    /// operation, surfaced as a hard error.
    EventIdMismatch { expected: EventId, actual: EventId },
    /// The envelope's cleartext nonce string failed base64url decoding or had
    /// the wrong length (must be exactly 24 bytes for XChaCha20).
    InvalidNonce(String),
    /// The envelope's cleartext ciphertext string failed base64url decoding.
    InvalidCiphertext(String),
}

impl fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Canonical(msg) => write!(f, "canonical JSON: {msg}"),
            Self::Signature(e) => write!(f, "signature: {e}"),
            Self::Aead(e) => write!(f, "aead: {e}"),
            Self::Id(e) => write!(f, "event id derivation: {e}"),
            Self::UnknownSigner(keyid) => {
                write!(f, "unknown signer: no verifying key for keyId {keyid}")
            }
            Self::InvalidPlaintext(msg) => write!(f, "plaintext not a ReviewEvent: {msg}"),
            Self::EventIdMismatch { expected, actual } => write!(
                f,
                "event id mismatch: expected {expected:?}, recomputed {actual:?}"
            ),
            Self::InvalidNonce(msg) => write!(f, "envelope nonce decode failed: {msg}"),
            Self::InvalidCiphertext(msg) => write!(f, "envelope ciphertext decode failed: {msg}"),
        }
    }
}

impl std::error::Error for EnvelopeError {}

impl From<CanonError> for EnvelopeError {
    fn from(e: CanonError) -> Self {
        Self::Canonical(e.to_string())
    }
}

impl From<SignError> for EnvelopeError {
    fn from(e: SignError) -> Self {
        Self::Signature(e)
    }
}

impl From<AeadError> for EnvelopeError {
    fn from(e: AeadError) -> Self {
        Self::Aead(e)
    }
}

impl From<IdError> for EnvelopeError {
    fn from(e: IdError) -> Self {
        Self::Id(e)
    }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// All the information needed to assemble a single encrypted envelope.
///
/// `event_key` is the 32-byte AEAD key chosen by the caller:
/// - `eventKey` for `EnvelopeKind::Event`,
/// - `signalingKey` for `EnvelopeKind::Signal`,
/// - `snapshotKey` for `EnvelopeKind::SnapshotBlob`.
///
/// See `planning/collab/crypto-spec.md` §Envelope Encryption (AEAD) and the
/// data-classification table at the end of the same doc for the rationale.
pub struct AssembleInput {
    /// AEAD key (32 bytes) appropriate for `kind`.
    pub event_key: [u8; 32],
    /// Device signing key for the author. Drives both `auth.signature` and
    /// `auth.signingKeyId`.
    pub signing_key: DeviceSigningKey,
    pub room_id: RoomId,
    pub author_id: ParticipantId,
    pub device_id: DeviceId,
    /// Unix milliseconds; baked into both `meta.created_at` and the envelope's
    /// AAD `created_at`. Single source of truth so the AAD-binding cannot be
    /// silently desynced from the signed bytes.
    pub created_at_ms: u64,
    /// When the relay may garbage-collect the envelope (unix ms). Surfaced on
    /// the envelope only; never signed into the event itself.
    pub expires_at_ms: u64,
    pub parent_event_ids: Vec<EventId>,
    pub snapshot_id: Option<SnapshotId>,
    pub body: ReviewEventBody,
    /// Envelope kind. Drives the AEAD key (caller-supplied) and the
    /// EnvelopeId derivation flavor.
    pub kind: EnvelopeKind,
    /// 16-byte client nonce. Required for `kind=signal` / `kind=snapshot_blob`
    /// (EnvelopeId derives from `(roomId, deviceId, clientNonce)`); ignored
    /// for `kind=event` (which uses the simpler EventId-based EnvelopeId).
    pub client_nonce: Option<[u8; 16]>,
}

/// Caller hook for deterministic AEAD nonces. Production code must pass
/// `None` so `aead::seal` draws a fresh random 24-byte nonce per call —
/// reusing a nonce under the same key is catastrophic for XChaCha20-Poly1305.
/// Tests and the test-vector regenerator pass `Some(nonce)` so the resulting
/// ciphertext bytes are reproducible across runs.
pub type AeadNonceOverride = Option<AeadNonce>;

/// All the information needed to open a single encrypted envelope.
pub struct DisassembleInput<'a> {
    pub envelope: &'a MailboxEnvelope,
    pub event_key: [u8; 32],
    /// `signingKeyId` -> verifying key. Caller is responsible for keeping the
    /// map populated from `ParticipantJoined` events as they are imported.
    pub verifying_keys: &'a HashMap<String, DeviceVerifyingKey>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Assemble a single encrypted envelope from a `ReviewEventBody` plus the
/// caller's identity / key material. The returned envelope is ready to ship
/// to the relay — it carries the encrypted body, the AAD-bound metadata, and
/// a fresh random AEAD nonce.
///
/// See module-level docs for the full step ordering. The body is hashed
/// first (to derive EventId), then signed, then encrypted; each layer
/// commits to the bytes underneath it via either a content-derived ID, a
/// detached Ed25519 signature, or a Poly1305 MAC.
pub fn assemble_event_envelope(input: AssembleInput) -> Result<MailboxEnvelope, EnvelopeError> {
    assemble_event_envelope_with_nonce(input, None)
}

/// Variant of [`assemble_event_envelope`] that lets the caller pin the AEAD
/// nonce. Intended for tests and corpus regeneration only — production code
/// must use [`assemble_event_envelope`] so each envelope gets a fresh random
/// nonce (reusing a nonce under the same key breaks XChaCha20-Poly1305).
pub fn assemble_event_envelope_with_nonce(
    input: AssembleInput,
    nonce_override: AeadNonceOverride,
) -> Result<MailboxEnvelope, EnvelopeError> {
    let AssembleInput {
        event_key,
        signing_key,
        room_id,
        author_id,
        device_id,
        created_at_ms,
        expires_at_ms,
        parent_event_ids,
        snapshot_id,
        body,
        kind,
        client_nonce,
    } = input;

    // ---- 1. Stage the meta with a placeholder eventId. derive_event_id
    //         ignores meta.event_id so the placeholder never escapes — but
    //         EventMeta requires the field at construction time.
    let mut meta = EventMeta {
        v: 2,
        event_id: placeholder_event_id(),
        room_id: room_id.clone(),
        author_id: author_id.clone(),
        device_id: device_id.clone(),
        created_at: created_at_ms,
        parent_event_ids,
        snapshot_id,
    };

    // ---- 2. Derive the EventId from the canonical bytes (without eventId)
    //         and stamp it into the meta. From here on, `meta.event_id` is
    //         the real, content-addressed id.
    let event_id = derive_event_id(&meta, &body)?;
    meta.event_id = event_id.clone();

    // ---- 3. Sign canonicalJSON({meta-without-eventId, body}). The signing
    //         module re-derives the canonical bytes — it does NOT consume
    //         the EventId. This is the same bytes the EventId was derived
    //         from, so the signature commits to the exact same byte string.
    let auth: EventAuth = sign_event(&signing_key, &meta, &body)?;

    // ---- 4. Derive the EnvelopeId. Kind dictates the flavor.
    let envelope_id = envelope_id_for(&kind, &room_id, &event_id, &device_id, &client_nonce)?;

    // ---- 5. Build the full ReviewEvent and canonicalize it for AEAD plaintext.
    //         Canonical JSON (not just any JSON) so two implementations agree
    //         on the bytes that get encrypted.
    let event = ReviewEvent {
        meta: meta.clone(),
        body,
        auth,
    };
    let plaintext = canonical::to_canonical_bytes(&event)?;

    // ---- 6. Build the AAD from the same cleartext fields the envelope will
    //         expose to the relay. Keeping these in lock-step is what makes
    //         AAD binding meaningful — see EnvelopeAad doc.
    let aad = EnvelopeAad {
        v: 2,
        room_id: room_id.as_str().to_string(),
        envelope_id: envelope_id.clone(),
        kind: envelope_kind_wire(&kind).to_string(),
        author_id: id_string(&author_id),
        device_id: id_string(&device_id),
        created_at: created_at_ms as i64,
    };

    // ---- 7. AEAD-seal. The optional nonce override is for tests/corpus
    //         regeneration only — production paths always use `aead::seal`,
    //         which draws a fresh random nonce.
    let (aead_nonce, ciphertext) = match nonce_override {
        None => aead::seal(&event_key, &plaintext, &aad)?,
        Some(nonce) => {
            let ct = aead::seal_with_nonce(&event_key, &nonce, &plaintext, &aad)?;
            (nonce, ct)
        }
    };

    let envelope = MailboxEnvelope {
        v: 2,
        room_id,
        envelope_id,
        server_seq: None,
        author_id,
        device_id,
        created_at: created_at_ms,
        expires_at: expires_at_ms,
        kind,
        // Event/snapshot envelopes never set a target — the relay broadcasts
        // them. Signaling envelopes go through
        // `transport::signaling::assemble_signal_envelope`, which populates
        // `target` directly.
        target: None,
        nonce: URL_SAFE_NO_PAD.encode(aead_nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(&ciphertext),
        ciphertext_bytes: ciphertext.len() as u64,
    };

    Ok(envelope)
}

/// Open a single encrypted envelope. Returns the recovered `ReviewEvent` on
/// success; any cryptographic failure short-circuits with a typed error so
/// the caller can decide whether to drop, retry, or surface to the user.
pub fn disassemble_event_envelope(input: DisassembleInput) -> Result<ReviewEvent, EnvelopeError> {
    let DisassembleInput {
        envelope,
        event_key,
        verifying_keys,
    } = input;

    // ---- 1. Reconstruct AAD from the cleartext envelope fields. If the
    //         relay tampered with any of these the MAC will fail.
    let aad = EnvelopeAad {
        v: envelope.v,
        room_id: envelope.room_id.as_str().to_string(),
        envelope_id: envelope.envelope_id.clone(),
        kind: envelope_kind_wire(&envelope.kind).to_string(),
        author_id: id_string(&envelope.author_id),
        device_id: id_string(&envelope.device_id),
        created_at: envelope.created_at as i64,
    };

    // ---- 2. Decode the nonce + ciphertext from base64url-no-pad.
    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(envelope.nonce.as_bytes())
        .map_err(|e| EnvelopeError::InvalidNonce(e.to_string()))?;
    let nonce: AeadNonce = nonce_bytes.as_slice().try_into().map_err(|_| {
        EnvelopeError::InvalidNonce(format!("expected 24 bytes, got {}", nonce_bytes.len()))
    })?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(envelope.ciphertext.as_bytes())
        .map_err(|e| EnvelopeError::InvalidCiphertext(e.to_string()))?;

    // ---- 3. AEAD-open. AeadError::Decrypt collapses every failure mode.
    let plaintext = aead::open(&event_key, &nonce, &ciphertext, &aad)?;

    // ---- 4. Parse the plaintext into a `ReviewEvent`. Distinguish JSON
    //         shape failures from canonical-JSON failures so the caller
    //         knows the bytes did decrypt but were structurally invalid.
    let event: ReviewEvent = serde_json::from_slice(&plaintext)
        .map_err(|e| EnvelopeError::InvalidPlaintext(e.to_string()))?;

    // ---- 5. Look up the verifying key by signingKeyId.
    let verifying_key = verifying_keys
        .get(&event.auth.signing_key_id)
        .ok_or_else(|| EnvelopeError::UnknownSigner(event.auth.signing_key_id.clone()))?;

    // ---- 6. Verify the Ed25519 signature. signing::verify_event also
    //         re-checks the signingKeyId binding, so a key-swap attempt
    //         where the map happens to contain a wrong key (matching keyId
    //         but different bytes) is caught.
    verify_event(verifying_key, &event.meta, &event.body, &event.auth)?;

    // ---- 7. Recompute the EventId from the recovered (meta, body) and
    //         assert it matches what was signed. This closes the loop on
    //         content-addressability — a recipient that does this check
    //         cannot be tricked into trusting an event with a forged id.
    let recomputed = derive_event_id(&event.meta, &event.body)?;
    if recomputed != event.meta.event_id {
        return Err(EnvelopeError::EventIdMismatch {
            expected: event.meta.event_id.clone(),
            actual: recomputed,
        });
    }

    Ok(event)
}

// ---------------------------------------------------------------------------
// Snapshot blob envelopes (kind: "snapshot_blob")
// ---------------------------------------------------------------------------

/// Assemble a `kind: "snapshot_blob"` envelope around opaque snapshot bytes.
///
/// Per `crypto-spec.md` §Nonce Discipline and `relay-spec.md` §R2 spillover,
/// snapshot blobs are confidentiality-only: the plaintext is the snapshot
/// bytes themselves (canonical-JSON `SnapshotPlaintext`) for the inline
/// mailbox lane, or a canonical-JSON `BlobRef` for the R2 spillover lane.
/// There is no embedded `ReviewEvent` / Ed25519 signature — authenticity
/// comes indirectly from the signed `SnapshotCreated` event that references
/// the blob via `encryptedBlobRef`.
///
/// `client_nonce` persists across retries so the relay dedups repeated send
/// attempts (same EnvelopeId derivation as `kind: "signal"`). The AEAD key
/// is the room's `snapshotKey` — `InboundPipeline::import_snapshot_envelope`
/// opens with the same key.
// Same rationale as assemble_signal_envelope: each argument is a distinct
// crypto/wire input; a params struct buys no clarity.
#[allow(clippy::too_many_arguments)]
pub fn assemble_snapshot_blob_envelope(
    plaintext: &[u8],
    snapshot_key: &[u8; 32],
    room_id: &RoomId,
    author_id: &ParticipantId,
    device_id: &DeviceId,
    client_nonce: &[u8; 16],
    created_at_ms: i64,
    expires_at_ms: i64,
) -> Result<MailboxEnvelope, EnvelopeError> {
    let envelope_id =
        derive_envelope_id_with_nonce(room_id, id_string(device_id).as_str(), client_nonce);

    let aad = EnvelopeAad {
        v: 2,
        room_id: room_id.as_str().to_string(),
        envelope_id: envelope_id.clone(),
        kind: envelope_kind_wire(&EnvelopeKind::SnapshotBlob).to_string(),
        author_id: id_string(author_id),
        device_id: id_string(device_id),
        created_at: created_at_ms,
    };

    let (aead_nonce, ciphertext) = aead::seal(snapshot_key, plaintext, &aad)?;

    Ok(MailboxEnvelope {
        v: 2,
        room_id: room_id.clone(),
        envelope_id,
        server_seq: None,
        author_id: author_id.clone(),
        device_id: device_id.clone(),
        created_at: created_at_ms as u64,
        expires_at: expires_at_ms as u64,
        kind: EnvelopeKind::SnapshotBlob,
        target: None,
        nonce: URL_SAFE_NO_PAD.encode(aead_nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(&ciphertext),
        ciphertext_bytes: ciphertext.len() as u64,
    })
}

/// Rebuild the `EnvelopeAad` from a wire envelope's cleartext header — the
/// same construction `disassemble_event_envelope` and the inbound pipeline
/// use. Public so the R2 blob body seal/open can bind the spilled bytes to
/// their wrapper envelope.
pub fn envelope_aad(envelope: &MailboxEnvelope) -> EnvelopeAad {
    EnvelopeAad {
        v: envelope.v,
        room_id: envelope.room_id.as_str().to_string(),
        envelope_id: envelope.envelope_id.clone(),
        kind: envelope_kind_wire(&envelope.kind).to_string(),
        author_id: id_string(&envelope.author_id),
        device_id: id_string(&envelope.device_id),
        created_at: envelope.created_at as i64,
    }
}

/// Seal the R2 spillover object body for a snapshot blob.
///
/// Per `crypto-spec.md` §Nonce Discipline: the R2 object body is
/// `nonce || ciphertext+tag` of the snapshot bytes under `snapshotKey`. The
/// AAD is the wrapper envelope's header (the small `kind=snapshot_blob`
/// envelope whose plaintext is the `BlobRef`), so the spilled bytes are
/// cryptographically bound to exactly one envelope — R2 (or the relay)
/// cannot swap blob bodies between envelopes without failing the MAC.
pub fn seal_snapshot_r2_body(
    snapshot_key: &[u8; 32],
    plaintext: &[u8],
    wrapper: &MailboxEnvelope,
) -> Result<Vec<u8>, EnvelopeError> {
    let aad = envelope_aad(wrapper);
    let (nonce, ciphertext) = aead::seal(snapshot_key, plaintext, &aad)?;
    let mut body = Vec::with_capacity(nonce.len() + ciphertext.len());
    body.extend_from_slice(&nonce);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/// Open an R2 spillover object body produced by [`seal_snapshot_r2_body`].
pub fn open_snapshot_r2_body(
    snapshot_key: &[u8; 32],
    body: &[u8],
    wrapper: &MailboxEnvelope,
) -> Result<Vec<u8>, EnvelopeError> {
    const NONCE_LEN: usize = 24;
    if body.len() < NONCE_LEN {
        return Err(EnvelopeError::InvalidNonce(format!(
            "R2 blob body too short for nonce: {} bytes",
            body.len()
        )));
    }
    let (nonce_bytes, ciphertext) = body.split_at(NONCE_LEN);
    let nonce: AeadNonce = nonce_bytes
        .try_into()
        .expect("split_at(NONCE_LEN) yields exactly NONCE_LEN bytes");
    let aad = envelope_aad(wrapper);
    Ok(aead::open(snapshot_key, &nonce, ciphertext, &aad)?)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wire string for an `EnvelopeKind` — matches `#[serde(rename_all = "snake_case")]`
/// on `model::EnvelopeKind`. Held centrally so AAD construction and envelope
/// serialization agree byte-for-byte.
fn envelope_kind_wire(kind: &EnvelopeKind) -> &'static str {
    match kind {
        EnvelopeKind::Event => "event",
        EnvelopeKind::SnapshotBlob => "snapshot_blob",
        EnvelopeKind::Signal => "signal",
    }
}

/// Round-trip a typed id newtype to its inner string. Mirrors the helper in
/// `crypto::ids` to avoid exposing the private tuple-struct field.
fn id_string<T: serde::Serialize>(id: &T) -> String {
    match serde_json::to_value(id).expect("typed id serializes as JSON string") {
        serde_json::Value::String(s) => s,
        other => panic!("typed id must serialize as JSON string, got {other:?}"),
    }
}

/// Manufacture a placeholder EventId so `EventMeta` can be built before we
/// know the real id. `derive_event_id` ignores `meta.event_id`, so this
/// placeholder is overwritten with the content-addressed id before the meta
/// escapes this module.
fn placeholder_event_id() -> EventId {
    serde_json::from_value(serde_json::Value::String(
        "envelope-assemble-placeholder".to_string(),
    ))
    .expect("EventId deserializes from any non-empty string")
}

/// Pick the right EnvelopeId derivation for a given kind. See
/// `crypto-spec.md` §EnvelopeId — `event` uses the simpler EventId-based
/// form; `signal` and `snapshot_blob` use the clientNonce-based form so
/// retries with the same persisted nonce dedup at the relay.
fn envelope_id_for(
    kind: &EnvelopeKind,
    room_id: &RoomId,
    event_id: &EventId,
    device_id: &DeviceId,
    client_nonce: &Option<[u8; 16]>,
) -> Result<String, EnvelopeError> {
    match kind {
        EnvelopeKind::Event => Ok(derive_envelope_id_for_event(room_id, event_id)),
        EnvelopeKind::Signal | EnvelopeKind::SnapshotBlob => {
            let nonce = client_nonce.as_ref().ok_or_else(|| {
                EnvelopeError::InvalidPlaintext(format!(
                    "envelope kind {} requires a clientNonce",
                    envelope_kind_wire(kind)
                ))
            })?;
            Ok(derive_envelope_id_with_nonce(
                room_id,
                id_string(device_id).as_str(),
                nonce,
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;

    use crate::review::crypto::kdf::derive_room_keys;
    use crate::review::ids::{ContentHash, FileId};
    use crate::review::model::{
        Anchor, EnvelopeKind, EventMeta, PositionAnchor, ReviewEventBody, SuggestionOperation,
    };

    // -----------------------------------------------------------------
    // Test fixtures
    // -----------------------------------------------------------------

    /// Pinned room secret used across all envelope tests. Matches the
    /// canonical 0x11*32 value used by `envelope.json` so the corpus
    /// vectors exercise the same derivation path as the unit tests.
    const TEST_ROOM_SECRET: [u8; 32] = [0x11u8; 32];

    /// Pinned Ed25519 seed used across tests. Distinct from the
    /// `signing::tests::FIXED_SEED` so a stray cross-import does not
    /// silently make both modules pass with the same key.
    const TEST_SIGNING_SEED: [u8; 32] = [0x22u8; 32];

    /// Second Ed25519 seed for cross-signer tests.
    const OTHER_SIGNING_SEED: [u8; 32] = [0x33u8; 32];

    fn typed<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("typed id deserializes")
    }

    /// Build a known-good AssembleInput with a CommentCreated body.
    fn assemble_input_comment(
        event_key: [u8; 32],
        signing_key: DeviceSigningKey,
        kind: EnvelopeKind,
        client_nonce: Option<[u8; 16]>,
    ) -> AssembleInput {
        AssembleInput {
            event_key,
            signing_key,
            room_id: typed::<RoomId>("hjCfgOvsatNOUedgxhZpyw"),
            author_id: typed::<ParticipantId>("p-author-01"),
            device_id: typed::<DeviceId>("d-device-01"),
            created_at_ms: 1_700_000_000_000,
            expires_at_ms: 1_700_000_000_000 + 7 * 24 * 60 * 60 * 1000,
            parent_event_ids: vec![],
            snapshot_id: None,
            body: ReviewEventBody::CommentCreated {
                thread_id: "thread-1".to_string(),
                anchor: Anchor {
                    v: 2,
                    file_id: typed::<FileId>("f-file-01"),
                    snapshot_id: typed::<SnapshotId>("eQ7pDCC-mekpz-we7gDYag"),
                    base_hash: typed::<ContentHash>("fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y"),
                    position: PositionAnchor {
                        byte_range: [0, 9],
                        line_range: [1, 1],
                        pm_range: None,
                    },
                    quote: None,
                    block: None,
                    context: None,
                    structure: None,
                },
                body: "hello".to_string(),
            },
            kind,
            client_nonce,
        }
    }

    /// Same fixture but with a SuggestionCreated body — exercises a different
    /// `ReviewEventBody` variant through the same pipeline.
    fn assemble_input_suggestion(
        event_key: [u8; 32],
        signing_key: DeviceSigningKey,
    ) -> AssembleInput {
        AssembleInput {
            event_key,
            signing_key,
            room_id: typed::<RoomId>("hjCfgOvsatNOUedgxhZpyw"),
            author_id: typed::<ParticipantId>("p-author-02"),
            device_id: typed::<DeviceId>("d-device-02"),
            created_at_ms: 1_700_000_001_500,
            expires_at_ms: 1_700_000_001_500 + 7 * 24 * 60 * 60 * 1000,
            parent_event_ids: vec![],
            snapshot_id: Some(typed::<SnapshotId>("snap-suggest-1")),
            body: ReviewEventBody::SuggestionCreated {
                suggestion_id: "sug-1".to_string(),
                anchor: Anchor {
                    v: 2,
                    file_id: typed::<FileId>("f-file-02"),
                    snapshot_id: typed::<SnapshotId>("snap-suggest-1"),
                    base_hash: typed::<ContentHash>("base-hash-2"),
                    position: PositionAnchor {
                        byte_range: [10, 14],
                        line_range: [3, 3],
                        pm_range: None,
                    },
                    quote: None,
                    block: None,
                    context: None,
                    structure: None,
                },
                operation: SuggestionOperation::Replace {
                    expected_text: "foo".to_string(),
                    replacement: "bar".to_string(),
                },
                note: Some("typo".to_string()),
            },
            kind: EnvelopeKind::Event,
            client_nonce: None,
        }
    }

    /// Map containing only the test signing key's verifying key, keyed by
    /// the same signingKeyId the assembler will embed in `EventAuth`.
    fn verifying_keys_for(seed: &[u8; 32]) -> HashMap<String, DeviceVerifyingKey> {
        let sk = DeviceSigningKey::from_bytes(seed).expect("seed -> sk");
        let vk = sk.verifying_key();
        let key_id = vk.signing_key_id_base64url();
        let mut map = HashMap::new();
        map.insert(key_id, vk);
        map
    }

    // -----------------------------------------------------------------
    // 1. Happy-path round-trip with CommentCreated
    // -----------------------------------------------------------------

    #[test]
    fn round_trip_comment_created_recovers_original_event() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();

        let input = assemble_input_comment(event_key, sk, EnvelopeKind::Event, None);
        // Snapshot the body we expect back BEFORE we move `input` into the
        // assembler — `ReviewEventBody` is `Clone` so this is cheap.
        let expected_body = input.body.clone();

        let envelope = assemble_event_envelope(input).expect("assemble");

        let vks = verifying_keys_for(&TEST_SIGNING_SEED);
        let recovered = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key,
            verifying_keys: &vks,
        })
        .expect("disassemble");

        assert_eq!(recovered.body, expected_body);
        assert_eq!(
            recovered.meta.author_id,
            typed::<ParticipantId>("p-author-01")
        );
        assert_eq!(recovered.meta.device_id, typed::<DeviceId>("d-device-01"));
        assert_eq!(recovered.meta.room_id, envelope.room_id);
        assert_eq!(recovered.meta.created_at, envelope.created_at);
        assert_eq!(envelope.kind, EnvelopeKind::Event);
        // Sanity: ciphertext is not empty and Poly1305 tag is included
        // (16 bytes appended per RustCrypto convention).
        assert!(envelope.ciphertext_bytes >= 16);
    }

    // -----------------------------------------------------------------
    // 2. Happy-path round-trip with SuggestionCreated
    // -----------------------------------------------------------------

    #[test]
    fn round_trip_suggestion_created_recovers_original_event() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();

        let input = assemble_input_suggestion(event_key, sk);
        let expected_body = input.body.clone();
        let expected_snapshot_id = input.snapshot_id.clone();

        let envelope = assemble_event_envelope(input).expect("assemble");
        let vks = verifying_keys_for(&TEST_SIGNING_SEED);
        let recovered = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key,
            verifying_keys: &vks,
        })
        .expect("disassemble");

        assert_eq!(recovered.body, expected_body);
        assert_eq!(recovered.meta.snapshot_id, expected_snapshot_id);
        // EventId must be stamped (placeholder must have been overwritten).
        assert_ne!(
            recovered.meta.event_id,
            super::placeholder_event_id(),
            "meta.event_id must be the derived content-addressed id, not the placeholder"
        );
    }

    // -----------------------------------------------------------------
    // 3. Wrong eventKey on open -> fails
    // -----------------------------------------------------------------

    #[test]
    fn wrong_event_key_fails_to_open() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let input = assemble_input_comment(event_key, sk, EnvelopeKind::Event, None);
        let envelope = assemble_event_envelope(input).unwrap();

        let mut bad_key = event_key;
        bad_key[0] ^= 0xFF;

        let vks = verifying_keys_for(&TEST_SIGNING_SEED);
        let err = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key: bad_key,
            verifying_keys: &vks,
        })
        .expect_err("open must fail under a wrong key");
        assert!(
            matches!(err, EnvelopeError::Aead(AeadError::Decrypt)),
            "expected Aead(Decrypt), got {err:?}"
        );
    }

    // -----------------------------------------------------------------
    // 4. Tampered ciphertext byte -> fails (AAD-binding catches it)
    // -----------------------------------------------------------------

    #[test]
    fn tampered_ciphertext_byte_fails_to_open() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let input = assemble_input_comment(event_key, sk, EnvelopeKind::Event, None);
        let mut envelope = assemble_event_envelope(input).unwrap();

        // Decode, flip a byte in the body (not the trailing 16-byte tag),
        // re-encode. Poly1305 must catch this.
        let mut bytes = URL_SAFE_NO_PAD
            .decode(envelope.ciphertext.as_bytes())
            .unwrap();
        // Pick a byte well before the trailing tag.
        bytes[0] ^= 0x01;
        envelope.ciphertext = URL_SAFE_NO_PAD.encode(&bytes);

        let vks = verifying_keys_for(&TEST_SIGNING_SEED);
        let err = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key,
            verifying_keys: &vks,
        })
        .expect_err("open must fail when the ciphertext is tampered");
        assert!(
            matches!(err, EnvelopeError::Aead(AeadError::Decrypt)),
            "expected Aead(Decrypt), got {err:?}"
        );
    }

    // -----------------------------------------------------------------
    // 5. AAD envelopeId mutation -> fails (no re-routing under a new id)
    // -----------------------------------------------------------------

    #[test]
    fn aad_envelope_id_mutation_fails_to_open() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let input = assemble_input_comment(event_key, sk, EnvelopeKind::Event, None);
        let mut envelope = assemble_event_envelope(input).unwrap();

        // Pretend a malicious relay rewrote the envelopeId before forwarding.
        envelope.envelope_id = "AAAAAAAAAAAAAAAAAAAAAA".to_string();

        let vks = verifying_keys_for(&TEST_SIGNING_SEED);
        let err = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key,
            verifying_keys: &vks,
        })
        .expect_err("AAD envelopeId mutation must not be openable");
        assert!(
            matches!(err, EnvelopeError::Aead(AeadError::Decrypt)),
            "expected Aead(Decrypt), got {err:?}"
        );
    }

    // -----------------------------------------------------------------
    // 6. AAD authorId mutation -> fails (no impersonation)
    // -----------------------------------------------------------------

    #[test]
    fn aad_author_id_mutation_fails_to_open() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let input = assemble_input_comment(event_key, sk, EnvelopeKind::Event, None);
        let mut envelope = assemble_event_envelope(input).unwrap();

        // Pretend a relay (or another participant) rewrote the authorId in
        // the envelope's cleartext header to impersonate someone else.
        envelope.author_id = typed::<ParticipantId>("mallory");

        let vks = verifying_keys_for(&TEST_SIGNING_SEED);
        let err = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key,
            verifying_keys: &vks,
        })
        .expect_err("AAD authorId mutation must not be openable");
        assert!(
            matches!(err, EnvelopeError::Aead(AeadError::Decrypt)),
            "expected Aead(Decrypt), got {err:?}"
        );
    }

    // -----------------------------------------------------------------
    // 7. Missing verifying-key in the map -> clear UnknownSigner error
    // -----------------------------------------------------------------

    #[test]
    fn missing_verifying_key_fails_with_unknown_signer() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let input = assemble_input_comment(event_key, sk, EnvelopeKind::Event, None);
        let envelope = assemble_event_envelope(input).unwrap();

        // Empty map — the disassembler should know nothing about the signer.
        let empty: HashMap<String, DeviceVerifyingKey> = HashMap::new();
        let err = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key,
            verifying_keys: &empty,
        })
        .expect_err("open must reject unknown signers");
        match err {
            EnvelopeError::UnknownSigner(keyid) => {
                // The keyId reported should be the assembler's signingKeyId.
                let expected = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED)
                    .unwrap()
                    .verifying_key()
                    .signing_key_id_base64url();
                assert_eq!(keyid, expected);
            }
            other => panic!("expected UnknownSigner, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // 8. Wrong signing key signs same body -> signature verify fails
    // -----------------------------------------------------------------

    #[test]
    fn wrong_signing_key_yields_signature_failure_on_verify() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();

        // Assemble with sk1 — so the envelope carries sk1's signingKeyId
        // and signature.
        let sk1 = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let input = assemble_input_comment(event_key, sk1, EnvelopeKind::Event, None);
        let envelope = assemble_event_envelope(input).unwrap();

        // The map carries sk2's verifying key but is INDEXED under sk1's
        // signingKeyId — simulating a malicious participant who tried to
        // swap their public key into the directory.
        let sk1_keyid = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED)
            .unwrap()
            .verifying_key()
            .signing_key_id_base64url();
        let sk2 = DeviceSigningKey::from_bytes(&OTHER_SIGNING_SEED).unwrap();
        let vk2 = sk2.verifying_key();
        let mut bad_map = HashMap::new();
        bad_map.insert(sk1_keyid, vk2);

        let err = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key,
            verifying_keys: &bad_map,
        })
        .expect_err("open must reject a verifying key whose bytes do not match the signingKeyId");
        // The signing module catches this as a SigningKeyIdMismatch — it
        // re-derives the keyId from the verifying key bytes and refuses to
        // even reach the Ed25519 verify step.
        match err {
            EnvelopeError::Signature(SignError::SigningKeyIdMismatch { .. }) => {}
            other => panic!("expected Signature(SigningKeyIdMismatch), got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // 9. EventId determinism: same inputs -> same EnvelopeId (dedup safety)
    // -----------------------------------------------------------------

    #[test]
    fn deterministic_event_envelope_id_for_dedup() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk1 = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let sk2 = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let a = assemble_event_envelope(assemble_input_comment(
            event_key,
            sk1,
            EnvelopeKind::Event,
            None,
        ))
        .unwrap();
        let b = assemble_event_envelope(assemble_input_comment(
            event_key,
            sk2,
            EnvelopeKind::Event,
            None,
        ))
        .unwrap();
        assert_eq!(
            a.envelope_id, b.envelope_id,
            "kind=event EnvelopeId must derive from (roomId, eventId) — identical inputs must dedup at the relay"
        );
        // The ciphertexts differ — fresh random nonce per envelope.
        assert_ne!(
            a.ciphertext, b.ciphertext,
            "random AEAD nonces must yield different ciphertexts even for identical inputs"
        );
    }

    // -----------------------------------------------------------------
    // 10. EnvelopeId determinism for kind=signal w/ same clientNonce
    // -----------------------------------------------------------------

    #[test]
    fn deterministic_signal_envelope_id_with_pinned_nonce() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let signaling_key = *keys.signaling_key.as_bytes();
        let nonce = [0x42u8; 16];

        let sk1 = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let sk2 = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let a = assemble_event_envelope(assemble_input_comment(
            signaling_key,
            sk1,
            EnvelopeKind::Signal,
            Some(nonce),
        ))
        .unwrap();
        let b = assemble_event_envelope(assemble_input_comment(
            signaling_key,
            sk2,
            EnvelopeKind::Signal,
            Some(nonce),
        ))
        .unwrap();
        assert_eq!(
            a.envelope_id, b.envelope_id,
            "kind=signal envelopes with the same clientNonce must dedup (retry safety)"
        );
    }

    // -----------------------------------------------------------------
    // 11. Cross-key isolation: snapshotKey envelope can NOT be opened
    //     under eventKey, and vice versa.
    // -----------------------------------------------------------------

    #[test]
    fn cross_key_isolation_event_vs_snapshot() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let snapshot_key = *keys.snapshot_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();

        // Seal a snapshot_blob-kind envelope under snapshotKey.
        let input = AssembleInput {
            kind: EnvelopeKind::SnapshotBlob,
            client_nonce: Some([0x77u8; 16]),
            ..assemble_input_comment(
                snapshot_key,
                sk,
                EnvelopeKind::SnapshotBlob,
                Some([0x77u8; 16]),
            )
        };
        let envelope = assemble_event_envelope(input).unwrap();

        // Try to open it under eventKey — must fail (key mismatch).
        let vks = verifying_keys_for(&TEST_SIGNING_SEED);
        let err = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key, // WRONG: this envelope was sealed under snapshotKey.
            verifying_keys: &vks,
        })
        .expect_err("snapshot envelope must NOT open under eventKey");
        assert!(matches!(err, EnvelopeError::Aead(AeadError::Decrypt)));

        // And the round-trip works under the correct key.
        let ok = disassemble_event_envelope(DisassembleInput {
            envelope: &envelope,
            event_key: snapshot_key,
            verifying_keys: &vks,
        })
        .expect("snapshot envelope opens under snapshotKey");
        assert_eq!(ok.meta.room_id, envelope.room_id);
    }

    // -----------------------------------------------------------------
    // 11b. Snapshot blob envelopes + R2 spillover body.
    // -----------------------------------------------------------------

    #[test]
    fn snapshot_blob_envelope_round_trips_raw_bytes() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let snapshot_key = *keys.snapshot_key.as_bytes();
        let plaintext = br##"{"markdown":"# hi\n","anchorIndex":{}}"##;

        let envelope = assemble_snapshot_blob_envelope(
            plaintext,
            &snapshot_key,
            &typed::<RoomId>("hjCfgOvsatNOUedgxhZpyw"),
            &typed::<ParticipantId>("p-author-01"),
            &typed::<DeviceId>("d-device-01"),
            &[0x44u8; 16],
            1_700_000_000_000,
            1_700_000_000_000 + 86_400_000,
        )
        .expect("assemble snapshot blob envelope");

        assert_eq!(envelope.kind, EnvelopeKind::SnapshotBlob);
        assert_eq!(
            envelope.ciphertext_bytes,
            (plaintext.len() + 16) as u64,
            "ciphertext = plaintext + 16-byte Poly1305 tag"
        );

        // Open exactly the way InboundPipeline::open_blob does.
        let aad = envelope_aad(&envelope);
        let nonce_bytes = URL_SAFE_NO_PAD.decode(envelope.nonce.as_bytes()).unwrap();
        let nonce: AeadNonce = nonce_bytes.as_slice().try_into().unwrap();
        let ciphertext = URL_SAFE_NO_PAD
            .decode(envelope.ciphertext.as_bytes())
            .unwrap();
        let recovered = aead::open(&snapshot_key, &nonce, &ciphertext, &aad)
            .expect("snapshot blob opens under snapshotKey");
        assert_eq!(recovered, plaintext);

        // Wrong key (eventKey) must fail.
        let err = aead::open(keys.event_key.as_bytes(), &nonce, &ciphertext, &aad)
            .expect_err("snapshot blob must not open under eventKey");
        assert!(matches!(err, AeadError::Decrypt));
    }

    #[test]
    fn snapshot_blob_envelope_id_is_client_nonce_stable() {
        // Retries that persist the clientNonce must mint the same EnvelopeId
        // so the relay dedups them — mirrors the kind=signal guarantee.
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let snapshot_key = *keys.snapshot_key.as_bytes();
        let mk = || {
            assemble_snapshot_blob_envelope(
                b"same bytes",
                &snapshot_key,
                &typed::<RoomId>("hjCfgOvsatNOUedgxhZpyw"),
                &typed::<ParticipantId>("p-author-01"),
                &typed::<DeviceId>("d-device-01"),
                &[0x55u8; 16],
                1_700_000_000_000,
                1_700_000_000_000 + 86_400_000,
            )
            .expect("assemble")
        };
        assert_eq!(mk().envelope_id, mk().envelope_id);
    }

    #[test]
    fn r2_blob_body_round_trips_and_binds_to_wrapper() {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let snapshot_key = *keys.snapshot_key.as_bytes();
        let snapshot_bytes = vec![0xABu8; 4096];

        // Wrapper envelope: plaintext would be the canonical-JSON BlobRef;
        // its content is irrelevant to the body binding.
        let wrapper = assemble_snapshot_blob_envelope(
            br#"{"storage":"r2"}"#,
            &snapshot_key,
            &typed::<RoomId>("hjCfgOvsatNOUedgxhZpyw"),
            &typed::<ParticipantId>("p-author-01"),
            &typed::<DeviceId>("d-device-01"),
            &[0x66u8; 16],
            1_700_000_000_000,
            1_700_000_000_000 + 86_400_000,
        )
        .expect("assemble wrapper");

        let body = seal_snapshot_r2_body(&snapshot_key, &snapshot_bytes, &wrapper)
            .expect("seal R2 body");
        assert_eq!(
            body.len(),
            24 + snapshot_bytes.len() + 16,
            "body = 24-byte nonce || ciphertext || 16-byte tag"
        );

        let recovered =
            open_snapshot_r2_body(&snapshot_key, &body, &wrapper).expect("open R2 body");
        assert_eq!(recovered, snapshot_bytes);

        // A different wrapper envelope (different clientNonce → different
        // envelopeId → different AAD) must NOT open this body: blob bodies
        // cannot be swapped between envelopes.
        let other_wrapper = assemble_snapshot_blob_envelope(
            br#"{"storage":"r2"}"#,
            &snapshot_key,
            &typed::<RoomId>("hjCfgOvsatNOUedgxhZpyw"),
            &typed::<ParticipantId>("p-author-01"),
            &typed::<DeviceId>("d-device-01"),
            &[0x77u8; 16],
            1_700_000_000_000,
            1_700_000_000_000 + 86_400_000,
        )
        .expect("assemble other wrapper");
        let err = open_snapshot_r2_body(&snapshot_key, &body, &other_wrapper)
            .expect_err("body must be bound to its wrapper envelope");
        assert!(matches!(err, EnvelopeError::Aead(AeadError::Decrypt)));

        // Truncated body (shorter than the nonce) is a typed error, not a panic.
        let err = open_snapshot_r2_body(&snapshot_key, &body[..10], &wrapper)
            .expect_err("truncated body must error");
        assert!(matches!(err, EnvelopeError::InvalidNonce(_)));
    }

    // -----------------------------------------------------------------
    // 12. Corpus replay: every non-pending vector in envelope.json
    //     must round-trip end-to-end.
    // -----------------------------------------------------------------

    /// The corpus is shared with the (future) TS/WASM client.
    /// See `planning/collab/test-vectors/envelope.json`.
    const ENVELOPE_CORPUS: &str = include_str!("../../planning/collab/test-vectors/envelope.json");

    #[derive(Deserialize)]
    struct CorpusFile {
        #[allow(dead_code)]
        version: u32,
        vectors: Vec<CorpusVector>,
    }

    #[derive(Deserialize)]
    struct CorpusVector {
        name: String,
        inputs: CorpusInputs,
        expected: CorpusExpected,
    }

    #[derive(Deserialize)]
    struct CorpusInputs {
        #[serde(rename = "roomSecret")]
        room_secret: String,
        #[serde(rename = "signingKey")]
        signing_key: CorpusSigningKey,
        event: CorpusEvent,
        #[serde(default, rename = "clientNonce")]
        client_nonce: Option<String>,
        #[serde(rename = "aeadNonce")]
        aead_nonce: String,
        #[serde(rename = "createdAt")]
        created_at: u64,
    }

    #[derive(Deserialize)]
    struct CorpusSigningKey {
        private: String,
        public: String,
    }

    #[derive(Deserialize)]
    struct CorpusEvent {
        meta: Value,
        body: Value,
    }

    #[derive(Deserialize)]
    struct CorpusExpected {
        #[serde(rename = "eventId")]
        event_id: String,
        #[serde(rename = "envelopeId")]
        envelope_id: String,
        signature: String,
        #[serde(rename = "aadJson")]
        aad_json: String,
        ciphertext: String,
        envelope: Value,
    }

    fn b64_to_bytes(s: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD
            .decode(s.as_bytes())
            .unwrap_or_else(|e| panic!("base64url decode failed for {s:?}: {e}"))
    }

    fn b64_to_32(s: &str) -> [u8; 32] {
        b64_to_bytes(s)
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| panic!("expected 32 bytes from {s:?}"))
    }

    fn b64_to_24(s: &str) -> [u8; 24] {
        b64_to_bytes(s)
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| panic!("expected 24 bytes from {s:?}"))
    }

    fn b64_to_16(s: &str) -> [u8; 16] {
        b64_to_bytes(s)
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| panic!("expected 16 bytes from {s:?}"))
    }

    /// The corpus meta is the canonical wire form WITHOUT `eventId`. Our
    /// `EventMeta` struct requires the field, so synthesize a placeholder
    /// (the derivation ignores it anyway).
    fn meta_from_corpus(meta: &Value) -> EventMeta {
        let mut obj = meta.as_object().expect("meta is an object").clone();
        obj.entry("eventId")
            .or_insert_with(|| Value::String("corpus-placeholder".to_string()));
        serde_json::from_value(Value::Object(obj)).expect("EventMeta deserializes from corpus")
    }

    fn body_from_corpus(body: &Value) -> ReviewEventBody {
        serde_json::from_value(body.clone()).expect("ReviewEventBody deserializes from corpus")
    }

    fn envelope_kind_from_corpus(envelope_json: &Value) -> EnvelopeKind {
        let kind = envelope_json
            .get("kind")
            .and_then(Value::as_str)
            .expect("envelope.kind present in corpus");
        match kind {
            "event" => EnvelopeKind::Event,
            "signal" => EnvelopeKind::Signal,
            "snapshot_blob" => EnvelopeKind::SnapshotBlob,
            other => panic!("unknown corpus envelope kind: {other}"),
        }
    }

    #[test]
    fn corpus_replay_round_trip_all_vectors() {
        let corpus: CorpusFile =
            serde_json::from_str(ENVELOPE_CORPUS).expect("envelope.json parses");
        assert!(
            corpus.vectors.len() >= 2,
            "expected >= 2 corpus vectors, got {}",
            corpus.vectors.len()
        );

        let mut checked = 0usize;
        for v in &corpus.vectors {
            // Tolerate __PENDING__ during parallel work — once this issue
            // lands and the regenerator has run, no vector should be pending
            // and the assertion below catches any future regression.
            if v.expected.signature.starts_with("__PENDING")
                || v.expected.ciphertext.starts_with("__PENDING")
                || v.expected.aad_json.starts_with("__PENDING")
            {
                continue;
            }

            let secret = b64_to_32(&v.inputs.room_secret);
            let keys = derive_room_keys(&secret);

            // Pick the AEAD key based on envelope kind, matching the rule in
            // the crypto-spec data-classification table:
            //   event -> eventKey, signal -> signalingKey, snapshot_blob -> snapshotKey.
            let envelope_kind = envelope_kind_from_corpus(&v.expected.envelope);
            let key_bytes = match envelope_kind {
                EnvelopeKind::Event => *keys.event_key.as_bytes(),
                EnvelopeKind::Signal => *keys.signaling_key.as_bytes(),
                EnvelopeKind::SnapshotBlob => *keys.snapshot_key.as_bytes(),
            };

            let signing_key =
                DeviceSigningKey::from_bytes(&b64_to_32(&v.inputs.signing_key.private))
                    .expect("corpus signing key");
            // Double-check the corpus's pinned public matches the seed.
            assert_eq!(
                signing_key.verifying_key().to_bytes(),
                b64_to_32(&v.inputs.signing_key.public),
                "[{}] corpus public key inconsistent with seed",
                v.name
            );

            let meta = meta_from_corpus(&v.inputs.event.meta);
            let body = body_from_corpus(&v.inputs.event.body);
            let aead_nonce = b64_to_24(&v.inputs.aead_nonce);
            let client_nonce = v.inputs.client_nonce.as_deref().map(b64_to_16);

            let input = AssembleInput {
                event_key: key_bytes,
                signing_key,
                room_id: meta.room_id.clone(),
                author_id: meta.author_id.clone(),
                device_id: meta.device_id.clone(),
                created_at_ms: v.inputs.created_at,
                expires_at_ms: v.inputs.created_at + 7 * 24 * 60 * 60 * 1000,
                parent_event_ids: meta.parent_event_ids.clone(),
                snapshot_id: meta.snapshot_id.clone(),
                body,
                kind: envelope_kind,
                client_nonce,
            };
            let envelope = assemble_event_envelope_with_nonce(input, Some(aead_nonce))
                .unwrap_or_else(|e| panic!("[{}] assemble failed: {e}", v.name));

            // EnvelopeId must match the pinned value (closes the loop on the
            // EnvelopeId derivation rule per kind).
            assert_eq!(
                envelope.envelope_id, v.expected.envelope_id,
                "[{}] envelopeId mismatch",
                v.name
            );

            // Ciphertext must match exactly — proves AEAD seal is byte-stable
            // across runs and matches whatever the corpus pins.
            assert_eq!(
                envelope.ciphertext, v.expected.ciphertext,
                "[{}] ciphertext mismatch",
                v.name
            );

            // Round-trip: open under the same key and recover the event.
            let signer_keyid =
                DeviceSigningKey::from_bytes(&b64_to_32(&v.inputs.signing_key.private))
                    .unwrap()
                    .verifying_key()
                    .signing_key_id_base64url();
            let mut vks = HashMap::new();
            vks.insert(
                signer_keyid,
                DeviceVerifyingKey::from_bytes(&b64_to_32(&v.inputs.signing_key.public)).unwrap(),
            );
            let recovered = disassemble_event_envelope(DisassembleInput {
                envelope: &envelope,
                event_key: key_bytes,
                verifying_keys: &vks,
            })
            .unwrap_or_else(|e| panic!("[{}] disassemble failed: {e}", v.name));

            assert_eq!(
                id_string(&recovered.meta.event_id),
                v.expected.event_id,
                "[{}] recovered EventId mismatch",
                v.name
            );
            assert_eq!(
                recovered.auth.signature, v.expected.signature,
                "[{}] signature mismatch",
                v.name
            );

            checked += 1;
        }

        assert!(
            checked >= 2,
            "expected to replay at least 2 non-pending envelope vectors, got {checked}"
        );
    }

    // -----------------------------------------------------------------
    // Corpus regenerator
    // -----------------------------------------------------------------

    /// One-shot regenerator for `planning/collab/test-vectors/envelope.json`.
    /// Normally a no-op; set `ATTN_REGEN_ENVELOPE_VECTORS=1` to write a fresh
    /// corpus to disk using the current impl. The vectors are deterministic
    /// (fixed roomSecret + fixed signing seed + fixed aeadNonce + fixed body)
    /// so re-running without code changes produces byte-identical output.
    ///
    /// Procedure:
    ///   1. ATTN_REGEN_ENVELOPE_VECTORS=1 cargo test review::envelope::tests::regen_corpus
    ///   2. Inspect the diff on planning/collab/test-vectors/envelope.json.
    ///   3. Re-run `cargo test review::envelope` to confirm corpus_replay
    ///      passes against the regenerated corpus.
    #[test]
    fn regen_corpus() {
        if std::env::var("ATTN_REGEN_ENVELOPE_VECTORS").ok().as_deref() != Some("1") {
            return;
        }

        // Fixed inputs — must NOT change without bumping the corpus version
        // and updating every downstream test-vector consumer (TS, WASM).
        let room_secret = [0x11u8; 32];
        // Two distinct signing seeds — vector 1 and vector 2 use different
        // authors so a stray cross-vector copy-paste fails loudly.
        let seed_1 = [0x22u8; 32];
        let seed_2 = [0x33u8; 32];
        // Fixed AEAD nonces — pinned in the corpus so ciphertext is stable.
        let aead_nonce_1 = [0x10u8; 24];
        let aead_nonce_2 = [0x20u8; 24];
        let client_nonce_signal = [0x42u8; 16];

        let keys = derive_room_keys(&room_secret);

        struct VectorInput {
            name: &'static str,
            seed: [u8; 32],
            event_meta: Value,
            event_body: Value,
            aead_nonce: [u8; 24],
            client_nonce: Option<[u8; 16]>,
            kind: EnvelopeKind,
            key_bytes: [u8; 32],
            created_at_ms: u64,
            key_kind_label: &'static str,
        }

        let v1 = VectorInput {
            name: "kind=event round-trip with simple comment_created body (envelopeId uses event-form)",
            seed: seed_1,
            event_meta: serde_json::json!({
                "v": 2,
                "roomId": "hjCfgOvsatNOUedgxhZpyw",
                "authorId": "p-author-01",
                "deviceId": "d-device-01",
                "createdAt": 1700000000000u64,
                "parentEventIds": [],
            }),
            event_body: serde_json::json!({
                "type": "comment_created",
                "threadId": "thread-1",
                "anchor": {
                    "v": 2,
                    "fileId": "f-file-01",
                    "snapshotId": "eQ7pDCC-mekpz-we7gDYag",
                    "baseHash": "fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y",
                    "position": {
                        "byteRange": [0, 9],
                        "lineRange": [1, 1],
                    },
                },
                "body": "hello",
            }),
            aead_nonce: aead_nonce_1,
            client_nonce: None,
            kind: EnvelopeKind::Event,
            key_bytes: *keys.event_key.as_bytes(),
            created_at_ms: 1_700_000_000_000,
            key_kind_label: "eventKey",
        };

        let v2 = VectorInput {
            name: "kind=signal envelope (envelopeId uses clientNonce-form, fixed 0x42*16 nonce)",
            seed: seed_2,
            event_meta: serde_json::json!({
                "v": 2,
                "roomId": "hjCfgOvsatNOUedgxhZpyw",
                "authorId": "p-author-01",
                "deviceId": "d-device-01",
                "createdAt": 1700000002000u64,
                "parentEventIds": [],
            }),
            event_body: serde_json::json!({
                "type": "presence_updated",
                "participantId": "p-author-01",
                "deviceId": "d-device-01",
                "online": true,
            }),
            aead_nonce: aead_nonce_2,
            client_nonce: Some(client_nonce_signal),
            kind: EnvelopeKind::Signal,
            key_bytes: *keys.signaling_key.as_bytes(),
            created_at_ms: 1_700_000_002_000,
            key_kind_label: "signalingKey",
        };

        // Vector 3: kind=snapshot_blob — exercises the third envelope kind
        // (snapshotKey + clientNonce-form envelopeId, distinct from signal).
        let seed_3 = [0x44u8; 32];
        let aead_nonce_3 = [0x30u8; 24];
        let client_nonce_snapshot = [0x55u8; 16];
        let v3 = VectorInput {
            name: "kind=snapshot_blob envelope (envelopeId uses clientNonce-form, snapshotKey)",
            seed: seed_3,
            event_meta: serde_json::json!({
                "v": 2,
                "roomId": "hjCfgOvsatNOUedgxhZpyw",
                "authorId": "p-author-01",
                "deviceId": "d-device-01",
                "createdAt": 1700000003000u64,
                "parentEventIds": [],
            }),
            event_body: serde_json::json!({
                "type": "snapshot_created",
                "fileId": "f-file-01",
                "snapshotId": "eQ7pDCC-mekpz-we7gDYag",
                "baseHash": "fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y",
            }),
            aead_nonce: aead_nonce_3,
            client_nonce: Some(client_nonce_snapshot),
            kind: EnvelopeKind::SnapshotBlob,
            key_bytes: *keys.snapshot_key.as_bytes(),
            created_at_ms: 1_700_000_003_000,
            key_kind_label: "snapshotKey",
        };

        // Vector 4: second kind=signal with a distinct signing seed + nonce +
        // body shape. Locks the signal path under two independent inputs so
        // a stray cross-vector copy-paste in the signaling pipe fails loudly.
        let seed_4 = [0x66u8; 32];
        let aead_nonce_4 = [0x77u8; 24];
        let client_nonce_signal_4 = [0x88u8; 16];
        let v4 = VectorInput {
            name: "kind=signal envelope (second signal vector, distinct seed + cursor in body)",
            seed: seed_4,
            event_meta: serde_json::json!({
                "v": 2,
                "roomId": "hjCfgOvsatNOUedgxhZpyw",
                "authorId": "p-author-01",
                "deviceId": "d-device-01",
                "createdAt": 1700000004000u64,
                "parentEventIds": [],
            }),
            event_body: serde_json::json!({
                "type": "presence_updated",
                "participantId": "p-author-01",
                "deviceId": "d-device-01",
                "online": true,
                "cursor": {
                    "byteRange": [42, 42],
                    "lineRange": [3, 3]
                }
            }),
            aead_nonce: aead_nonce_4,
            client_nonce: Some(client_nonce_signal_4),
            kind: EnvelopeKind::Signal,
            key_bytes: *keys.signaling_key.as_bytes(),
            created_at_ms: 1_700_000_004_000,
            key_kind_label: "signalingKey",
        };

        let inputs = [v1, v2, v3, v4];
        let vectors: Vec<Value> = inputs
            .iter()
            .map(|v| {
                let meta = meta_from_corpus(&v.event_meta);
                let body = body_from_corpus(&v.event_body);
                let sk = DeviceSigningKey::from_bytes(&v.seed).unwrap();
                let public = sk.verifying_key().to_bytes();

                let input = AssembleInput {
                    event_key: v.key_bytes,
                    signing_key: DeviceSigningKey::from_bytes(&v.seed).unwrap(),
                    room_id: meta.room_id.clone(),
                    author_id: meta.author_id.clone(),
                    device_id: meta.device_id.clone(),
                    created_at_ms: v.created_at_ms,
                    expires_at_ms: v.created_at_ms + 7 * 24 * 60 * 60 * 1000,
                    parent_event_ids: meta.parent_event_ids.clone(),
                    snapshot_id: meta.snapshot_id.clone(),
                    body: body.clone(),
                    kind: v.kind,
                    client_nonce: v.client_nonce,
                };
                let envelope =
                    assemble_event_envelope_with_nonce(input, Some(v.aead_nonce)).unwrap();

                // Reproduce the signature out-of-band so we can pin it.
                let sk_for_sig = DeviceSigningKey::from_bytes(&v.seed).unwrap();
                let mut signed_meta = meta.clone();
                let event_id = derive_event_id(&signed_meta, &body).unwrap();
                signed_meta.event_id = event_id.clone();
                let auth = sign_event(&sk_for_sig, &signed_meta, &body).unwrap();

                // AAD JSON view — the canonical-JSON bytes of the EnvelopeAad.
                let aad = EnvelopeAad {
                    v: 2,
                    room_id: signed_meta.room_id.as_str().to_string(),
                    envelope_id: envelope.envelope_id.clone(),
                    kind: envelope_kind_wire(&v.kind).to_string(),
                    author_id: id_string(&signed_meta.author_id),
                    device_id: id_string(&signed_meta.device_id),
                    created_at: v.created_at_ms as i64,
                };
                let aad_bytes = canonical::to_canonical_bytes(&aad).unwrap();
                let aad_json = String::from_utf8(aad_bytes).unwrap();

                let client_nonce_b64 = v.client_nonce.map(|n| URL_SAFE_NO_PAD.encode(n));
                let mut keys_obj = serde_json::Map::new();
                keys_obj.insert(
                    v.key_kind_label.to_string(),
                    Value::String(URL_SAFE_NO_PAD.encode(v.key_bytes)),
                );

                serde_json::json!({
                    "name": v.name,
                    "inputs": {
                        "roomSecret": URL_SAFE_NO_PAD.encode(room_secret),
                        "keys": keys_obj,
                        "signingKey": {
                            "private": URL_SAFE_NO_PAD.encode(v.seed),
                            "public": URL_SAFE_NO_PAD.encode(public),
                        },
                        "event": {
                            "meta": v.event_meta,
                            "body": v.event_body,
                        },
                        "clientNonce": client_nonce_b64,
                        "aeadNonce": URL_SAFE_NO_PAD.encode(v.aead_nonce),
                        "createdAt": v.created_at_ms,
                    },
                    "expected": {
                        "eventId": id_string(&event_id),
                        "envelopeId": envelope.envelope_id,
                        "signature": auth.signature,
                        "aadJson": aad_json,
                        "ciphertext": envelope.ciphertext,
                        "envelope": {
                            "v": envelope.v,
                            "envelopeId": envelope.envelope_id,
                            "roomId": envelope.room_id,
                            "kind": envelope_kind_wire(&v.kind),
                            "authorId": envelope.author_id,
                            "deviceId": envelope.device_id,
                            "createdAt": envelope.created_at,
                            "expiresAt": envelope.expires_at,
                            "nonce": envelope.nonce,
                            "ciphertext": envelope.ciphertext,
                            "ciphertextBytes": envelope.ciphertext_bytes,
                        },
                    },
                })
            })
            .collect();

        let out = serde_json::json!({
            "_schema": {
                "spec": "planning/collab/crypto-spec.md#envelope-encryption-aead",
                "purpose": "End-to-end round-trip: event -> canonicalJSON -> Ed25519 sign -> AEAD seal -> envelope JSON. Each vector pins every intermediate step so a divergence in any layer is caught by a single test.",
                "format": {
                    "version": "Integer corpus version.",
                    "vectors[].name": "Human label.",
                    "vectors[].inputs.roomSecret": "base64url-no-pad of the 32-byte room secret feeding KDF.",
                    "vectors[].inputs.keys": "Object with one of eventKey/signalingKey/snapshotKey (base64url) — provided for cross-impl convenience; derived from roomSecret.",
                    "vectors[].inputs.signingKey": "{private, public} both base64url-no-pad.",
                    "vectors[].inputs.event": "{meta (no eventId), body}.",
                    "vectors[].inputs.clientNonce": "base64url-no-pad of 16 random bytes used for EnvelopeId derivation (null for event-shaped envelopes that use the simpler SHA-256(\"envelope v2\" || roomId || eventId) form).",
                    "vectors[].inputs.aeadNonce": "base64url-no-pad of the 24-byte XChaCha20 nonce. Pinned to keep ciphertext deterministic.",
                    "vectors[].inputs.createdAt": "Integer ms timestamp baked into both event meta and envelope AAD.",
                    "vectors[].expected.eventId": "Computed from canonical event bytes.",
                    "vectors[].expected.envelopeId": "Per kind: event-kind uses simpler form; signal/snapshot use clientNonce form.",
                    "vectors[].expected.signature": "base64url-no-pad of the Ed25519 signature over canonical event bytes.",
                    "vectors[].expected.aadJson": "UTF-8 canonical JSON of the AAD object.",
                    "vectors[].expected.ciphertext": "base64url-no-pad of XChaCha20-Poly1305 output.",
                    "vectors[].expected.envelope": "Full envelope JSON as it would appear in the relay's DO storage AND in `POST /v2/rooms/:roomId/envelopes` request body."
                },
                "rules": [
                    "Vectors share the canonical roomSecret = 0x11*32 (roomId = hjCfgOvsatNOUedgxhZpyw) and authorId/deviceId labels with event-id.json so the cross-vector inputs match.",
                    "EnvelopeId for kind=event uses `SHA-256(\"envelope v2\" || roomId || eventId)[:16]`.",
                    "EnvelopeId for kind=signal/snapshot_blob uses `SHA-256(\"envelope v2\" || roomId || deviceId || clientNonce)[:16]`.",
                    "When a vector pins a clientNonce, retries MUST reuse the same nonce so the relay can dedup.",
                    "AEAD key selection: kind=event uses eventKey, kind=signal uses signalingKey, kind=snapshot_blob uses snapshotKey."
                ],
                "filledBy": "attn-nnj.1.9 (full envelope round-trip)"
            },
            "version": 1,
            "vectors": vectors,
        });

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("planning/collab/test-vectors/envelope.json");
        let pretty = serde_json::to_string_pretty(&out).unwrap();
        std::fs::write(&path, pretty + "\n").expect("write envelope.json");
        eprintln!("wrote {}", path.display());
    }
}
