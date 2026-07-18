//! Inbound envelope pipeline: decrypt + verify + dedupe + import.
//!
//! Transport-agnostic crypto + persistence layer that turns a received
//! `MailboxEnvelope` into a durable, verified `ReviewEvent` (for `kind=event`)
//! or recovered plaintext bytes (for `kind=signal` / `kind=snapshot_blob`).
//!
//! Called by both:
//!   - the mailbox WS client (attn-nnj.6.3) — each incoming `envelope` frame
//!     hits `import_event_envelope` / `import_snapshot_envelope` / `import_signal_envelope`,
//!   - the WebRTC DataChannel transport (Phase 4) — same entrypoints; the WS
//!     and DC paths converge here so dedup/verify lives in exactly one place.
//!
//! Spec:
//!   - `planning/collab/crypto-spec.md` §Envelope Encryption (AEAD) +
//!     §Signatures (the round-trip this module closes the loop on),
//!   - `planning/collab/data-model.md` §Sync Cursors And ACKs (dedup by
//!     EventId — `ReviewStore::append_event` returns `false` for re-imports).
//!
//! Layering: this module does NOT know what `kind` an envelope is — the caller
//! dispatches on `envelope.kind` and calls the matching method. That keeps the
//! WS/DC layers thin (`match frame.kind { Event => import_event_envelope, .. }`)
//! and keeps the AEAD key selection localized to the pipeline (which owns the
//! three subkeys).
//!
//! What this module does NOT do:
//!   - WebSocket reception itself (lives in 6.3),
//!   - R2-spillover snapshot fetch — when ciphertext is a `BlobRef` instead of
//!     inline bytes, the caller fetches from R2 and calls back with the
//!     resolved blob (lives in 5.8),
//!   - emitting `ReviewUpdate::EventImported` — `ReviewManager` does that after
//!     calling `import_event_envelope` (keeps the manager-owned `update_tx`
//!     out of this layer's API surface).

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::review::crypto::aead::{self, AeadError, AeadNonce, EnvelopeAad};
use crate::review::crypto::signing::DeviceVerifyingKey;
use crate::review::envelope::{DisassembleInput, EnvelopeError, disassemble_event_envelope};
use crate::review::ids::{DeviceId, RoomId};
use crate::review::model::{
    Capability, DeviceClient, EnvelopeKind, MailboxEnvelope, ParticipantKind, ReviewEvent,
    ReviewEventBody,
};
use crate::review::store::ReviewStore;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors returned by the inbound pipeline.
///
/// `UnknownSigner` is a soft error: the caller (mailbox WS client or WebRTC
/// transport) should refresh its device-key cache (via `GET /devices` for
/// mailbox; via a `device_directory_update` envelope for WebRTC) and retry the
/// import once before surfacing to the user. Persistent `UnknownSigner` after a
/// refresh indicates a genuine key-distribution failure.
///
/// `Envelope` collapses every cryptographic failure (wrong key, AEAD MAC
/// failure, signature failure, EventId mismatch) into the underlying
/// `EnvelopeError`. That matches the spec's "the relay never needs to know
/// which input was wrong" stance — distinguishing between, say, "wrong eventKey"
/// and "tampered ciphertext" risks turning timing differences into a side
/// channel for an attacker.
#[derive(Debug, thiserror::Error)]
pub enum InboundError {
    /// AEAD-open, signature-verify, or EventId-recompute failed.
    #[error("envelope decrypt/verify failed: {0}")]
    Envelope(#[from] EnvelopeError),
    /// `auth.signingKeyId` is not in the device-keys cache. Caller should
    /// refresh the cache (mailbox: `GET /devices`; WebRTC: peer key exchange)
    /// and retry the import once.
    #[error("unknown signer: signingKeyId not in device cache")]
    UnknownSigner { signing_key_id: String },
    /// Snapshot or signal envelope decrypt failed (AEAD MAC or nonce/ciphertext
    /// base64url decode). Snapshot/signal envelopes don't carry an Ed25519
    /// signature inside the plaintext — they are confidentiality-only —
    /// so failures route through this variant instead of `Envelope`.
    #[error("blob decrypt failed: {0}")]
    Aead(#[from] AeadError),
    /// `nonce` field of the envelope failed base64url decoding or had wrong length.
    #[error("envelope nonce decode failed: {0}")]
    InvalidNonce(String),
    /// `ciphertext` field of the envelope failed base64url decoding.
    #[error("envelope ciphertext decode failed: {0}")]
    InvalidCiphertext(String),
    /// `store.append_event` failed (disk full, permission denied, corrupt JSONL).
    /// Wrapped as a `String` because `anyhow::Error` does not implement `Error`
    /// in a way that composes cleanly with `thiserror`.
    #[error("store: {0}")]
    Store(String),
    /// Caller asked the pipeline to process an envelope whose `kind` does not
    /// match the entrypoint (e.g. handed a `kind=event` envelope to
    /// `import_snapshot_envelope`). Distinguishing this from a malformed AAD
    /// gives much better diagnostics — a kind/method mismatch is a programmer
    /// error in the caller, not a relay-side tampering attempt.
    #[error("envelope kind mismatch: expected {expected:?}, got {actual:?}")]
    KindMismatch {
        expected: EnvelopeKind,
        actual: EnvelopeKind,
    },
    /// The signer is registered, but its role does not grant this event body,
    /// or its ParticipantJoined self-attestation conflicts with the immutable
    /// registration record.
    #[error("event is not authorized for the registered participant/device")]
    UnauthorizedEvent,
    /// Signal envelope's cleartext `target.deviceId` does not match the
    /// receiver's local `deviceId`. Per `planning/collab/security-review.md`
    /// §H2 (v2 mitigation): `target.deviceId` is not AAD-bound, so a malicious
    /// relay could redirect a signal envelope to the wrong peer to leak room
    /// topology or ICE candidates to non-target participants. The inbound
    /// dispatcher enforces equality (or `target == None` for true broadcast)
    /// before exposing the recovered plaintext upstream; rejection happens
    /// AFTER AEAD-open (the MAC still proves room-membership of the sender),
    /// but BEFORE the SDP/ICE bytes reach the WebRTC state machine.
    ///
    /// A v3 amendment may bind `target` directly into the AAD for
    /// `kind="signal"`, which would convert this into a `AeadError::Decrypt`
    /// at MAC time. Until then, this is the server-trust-style mitigation.
    #[error("signal target deviceId mismatch: expected {expected}, got {actual:?} (anti-redirect)")]
    TargetDeviceMismatch {
        expected: String,
        actual: Option<String>,
    },
    /// Protocol-v3 signal omitted or failed its registered-device proof.
    #[error("signal registered-device proof failed: {0}")]
    SignalDeviceProof(String),
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/// Outcome of importing an event envelope.
///
/// `newly_imported` distinguishes the "imported now" path (caller emits
/// `ReviewUpdate::EventImported`, advances the cursor, etc.) from the "already
/// have it" dedup path (caller just advances the cursor; the event surfaces
/// nothing new to the frontend). Both paths return the decoded event so the
/// caller can recompute anchor resolutions or refresh derived state if it wants
/// to — dedup is a sync-level optimization, not a logical "drop".
#[derive(Debug, Clone)]
pub struct ImportOutcome {
    /// The verified, decrypted `ReviewEvent`.
    pub event: ReviewEvent,
    /// `true` if the event was newly appended to `events.jsonl`;
    /// `false` if `store.append_event` returned `Ok(false)` (already present).
    pub newly_imported: bool,
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/// Shared, async-friendly verifying-key cache. Keyed by `signingKeyId`
/// (= `base64url(SHA-256(publicSigningKey))` per crypto-spec.md §Signatures).
///
/// Pulled out as a type alias so callers (notably `ReviewManager`) can hand
/// the same `Arc<RwLock<...>>` to both the inbound pipeline and any code that
/// adds keys from device-directory updates without juggling two clones.
pub type VerifyingKeyCache = Arc<RwLock<HashMap<String, DeviceVerifyingKey>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantTier {
    Comment,
    Suggest,
}

#[derive(Debug, Clone)]
pub struct RegisteredDeviceAuthorization {
    pub participant_id: crate::review::ids::ParticipantId,
    pub device_id: DeviceId,
    pub public_encryption_key: String,
    pub public_signing_key: String,
    pub client: DeviceClient,
    pub kind: ParticipantKind,
    /// Verified relay-directory grant. `None` is legacy v2 and defaults to
    /// suggest for backward compatibility (including agents).
    pub grant_tier: Option<GrantTier>,
    /// Exact owner proof paired with `grant_tier`; retained so refreshes
    /// cannot silently replace an immutable v3 authorization.
    pub grant_signature: Option<String>,
    pub attested: bool,
}

impl RegisteredDeviceAuthorization {
    pub fn validates_attestation(&self, event: &ReviewEvent) -> bool {
        let ReviewEventBody::ParticipantJoined {
            participant,
            device,
        } = &event.body
        else {
            return false;
        };
        participant.participant_id == event.meta.author_id
            && participant.participant_id == self.participant_id
            && participant.kind == self.kind
            && participant.public_signing_key == self.public_signing_key
            && exact_capabilities(&participant.capabilities, self.kind, self.grant_tier)
            && device.device_id == event.meta.device_id
            && device.device_id == self.device_id
            && device.participant_id == self.participant_id
            && device.public_encryption_key == self.public_encryption_key
            && device.public_signing_key == self.public_signing_key
            && device.client == self.client
    }
}

pub type AuthorizationCache = Arc<RwLock<HashMap<String, RegisteredDeviceAuthorization>>>;

/// Inbound envelope processing pipeline.
///
/// Owns:
///   - `store` — durable event log. `append_event` does dedup-by-EventId.
///   - `keys` — verifying-key cache used to validate `auth.signingKeyId`.
///   - `event_key`, `snapshot_key`, `signaling_key` — the three per-room AEAD
///     subkeys derived from `rootKey` (see `crypto::kdf::derive_room_keys`).
///     One pipeline instance is bound to one room — these keys are room-scoped.
///
/// The pipeline does NOT spawn its own task and does NOT hold any transport
/// state. Each method is an isolated `async fn` that does CPU-bound crypto
/// (under `tokio::task::block_in_place` is the caller's choice — for our event
/// sizes the work is sub-millisecond and we keep it inline) and a disk write.
pub struct InboundPipeline {
    store: Arc<ReviewStore>,
    keys: VerifyingKeyCache,
    authorizations: AuthorizationCache,
    /// AEAD key for `kind=event` envelopes. 32 bytes.
    event_key: [u8; 32],
    /// AEAD key for `kind=snapshot_blob` envelopes. 32 bytes.
    snapshot_key: [u8; 32],
    /// AEAD key for `kind=signal` envelopes. 32 bytes.
    signaling_key: [u8; 32],
}

impl InboundPipeline {
    /// Decrypt, verify, authorize, and policy-check a complete event batch
    /// without mutating device attestation state or the event store. Callers
    /// use this before any external registration or durable append.
    pub async fn preflight_event_envelopes<F>(
        &self,
        envelopes: &[MailboxEnvelope],
        allow: F,
    ) -> Result<Vec<ReviewEvent>, InboundError>
    where
        F: Fn(usize, &ReviewEvent) -> bool,
    {
        let keys = self.keys.read().await.clone();
        let mut authorizations = self.authorizations.read().await.clone();
        let mut events = Vec::with_capacity(envelopes.len());
        for (index, envelope) in envelopes.iter().enumerate() {
            if envelope.kind != EnvelopeKind::Event {
                return Err(InboundError::KindMismatch {
                    expected: EnvelopeKind::Event,
                    actual: envelope.kind,
                });
            }
            let event = match disassemble_event_envelope(DisassembleInput {
                envelope,
                event_key: self.event_key,
                verifying_keys: &keys,
            }) {
                Ok(event) => event,
                Err(EnvelopeError::UnknownSigner(keyid)) => {
                    return Err(InboundError::UnknownSigner {
                        signing_key_id: keyid,
                    });
                }
                Err(error) => return Err(InboundError::Envelope(error)),
            };
            authorize_event(&event, &mut authorizations)?;
            if !allow(index, &event) {
                return Err(InboundError::UnauthorizedEvent);
            }
            events.push(event);
        }
        Ok(events)
    }

    /// Commit an already-preflighted batch. Authorization state is staged for
    /// the whole batch before the first append, preventing a partial
    /// attestation from becoming observable when a later event is invalid.
    pub async fn commit_preflighted_events(
        &self,
        room_id: &RoomId,
        events: &[ReviewEvent],
    ) -> Result<Vec<ImportOutcome>, InboundError> {
        let mut guard = self.authorizations.write().await;
        let mut staged = guard.clone();
        for event in events {
            authorize_event(event, &mut staged)?;
        }
        let mut outcomes = Vec::with_capacity(events.len());
        for event in events {
            let newly_imported = self
                .store
                .append_event(room_id, event)
                .map_err(|error| InboundError::Store(error.to_string()))?;
            outcomes.push(ImportOutcome {
                event: event.clone(),
                newly_imported,
            });
        }
        *guard = staged;
        Ok(outcomes)
    }

    /// Construct a new pipeline. The three AEAD keys must be derived from the
    /// same `rootKey` via `crypto::kdf::derive_room_keys` so the kind/key
    /// mapping (see crypto-spec.md data-classification table) is consistent.
    pub fn new(
        store: Arc<ReviewStore>,
        keys: VerifyingKeyCache,
        authorizations: AuthorizationCache,
        event_key: [u8; 32],
        snapshot_key: [u8; 32],
        signaling_key: [u8; 32],
    ) -> Self {
        Self {
            store,
            keys,
            authorizations,
            event_key,
            snapshot_key,
            signaling_key,
        }
    }

    /// Register a verifying key for a `signingKeyId`. Called by `ReviewManager`
    /// when:
    ///   - `GET /devices` returns the room directory at admission time,
    ///   - a `ParticipantJoined` event lands and the new device's key is in
    ///     the event's body (lookup by device_id then store the key).
    ///
    /// Overwrites any existing entry — callers should re-MAC and rebuild the
    /// cache after device-key rotation rather than relying on insert semantics.
    pub async fn add_verifying_key(&self, signing_key_id: String, key: DeviceVerifyingKey) {
        let mut guard = self.keys.write().await;
        guard.insert(signing_key_id, key);
    }

    /// Process one inbound `kind=event` envelope.
    ///
    /// Pipeline:
    ///   1. Snapshot the verifying-key cache (so we hold no read lock across
    ///      the AEAD/signing work; the cache rarely changes mid-import but we
    ///      want to keep contention zero).
    ///   2. Call `disassemble_event_envelope` — AEAD-open + sig-verify +
    ///      EventId recompute (each layer's failure mode is a typed variant).
    ///   3. On `EnvelopeError::UnknownSigner` → surface as
    ///      `InboundError::UnknownSigner` so the caller knows to refresh.
    ///   4. `store.append_event` returns `Ok(true)` for newly written,
    ///      `Ok(false)` for an already-seen EventId. Either way we return the
    ///      decoded event in `ImportOutcome.event`.
    pub async fn import_event_envelope(
        &self,
        room_id: &RoomId,
        envelope: &MailboxEnvelope,
    ) -> Result<ImportOutcome, InboundError> {
        self.import_event_envelope_if(room_id, envelope, |_| true)
            .await
    }

    /// Import through the full crypto/authorization pipeline while applying
    /// one caller policy immediately before persistence. Durable-share
    /// offline intake uses this to admit only its frozen attestation followed
    /// by comments; checking after `import_event_envelope` would be too late
    /// because the event log append has already happened.
    pub async fn import_event_envelope_if<F>(
        &self,
        room_id: &RoomId,
        envelope: &MailboxEnvelope,
        allow: F,
    ) -> Result<ImportOutcome, InboundError>
    where
        F: FnOnce(&ReviewEvent) -> bool,
    {
        if envelope.kind != EnvelopeKind::Event {
            return Err(InboundError::KindMismatch {
                expected: EnvelopeKind::Event,
                actual: envelope.kind,
            });
        }

        // Snapshot the cache. Cloning DeviceVerifyingKey is cheap (it's a wrapper
        // around ed25519_dalek::VerifyingKey, which is Copy under the hood).
        // Holding the read guard across `disassemble_event_envelope` would block
        // any concurrent `add_verifying_key` for the duration of the AEAD/sig
        // work — bounded but pointless.
        let keys_snapshot = self.keys.read().await.clone();

        let event = match disassemble_event_envelope(DisassembleInput {
            envelope,
            event_key: self.event_key,
            verifying_keys: &keys_snapshot,
        }) {
            Ok(ev) => ev,
            Err(EnvelopeError::UnknownSigner(keyid)) => {
                return Err(InboundError::UnknownSigner {
                    signing_key_id: keyid,
                });
            }
            Err(other) => return Err(InboundError::Envelope(other)),
        };

        let mut authorizations = self.authorizations.write().await;
        authorize_event(&event, &mut authorizations)?;
        if !allow(&event) {
            return Err(InboundError::UnauthorizedEvent);
        }

        let newly_imported = self
            .store
            .append_event(room_id, &event)
            .map_err(|e| InboundError::Store(e.to_string()))?;

        Ok(ImportOutcome {
            event,
            newly_imported,
        })
    }

    /// Process one inbound `kind=snapshot_blob` envelope. Returns
    /// `(envelopeId, plaintext_bytes)` — the caller correlates the
    /// `envelopeId` with the corresponding `SnapshotCreated` event (which
    /// carries the `snapshotId`/`fileId`) and persists the bytes to the
    /// snapshot store.
    ///
    /// Why `envelopeId` instead of `snapshotId`: per crypto-spec.md, the
    /// `snapshot_blob` envelope's plaintext is the snapshot bytes themselves
    /// (or a `BlobRef` for R2 spillover) — there is no in-band metadata
    /// carrying a `snapshotId`. The wire-level identity for the blob is the
    /// envelope's `envelopeId`, which is what the `SnapshotCreated` event
    /// references via `encryptedBlobRef.envelopeId` (or by being co-published
    /// in the same batch with the same `clientNonce`).
    ///
    /// Returns the raw plaintext bytes — for inline snapshots these are the
    /// snapshot bytes; for R2 spillover the plaintext is a canonical-JSON
    /// `BlobRef` that the caller resolves separately (the mailbox WS client
    /// fetches + opens the R2 body; see `ws.rs::handle_snapshot_blob`).
    ///
    /// Inline snapshot bytes are persisted here via
    /// `ReviewStore::save_snapshot_blob` (keyed by `envelopeId`) so every
    /// transport that shares this pipeline — mailbox WS and the WebRTC
    /// DataChannel — feeds the same blob store the manager's
    /// `SnapshotCreated` rehydration reads from. R2 `BlobRef` plaintexts are
    /// NOT persisted (they're an indirection, not the bytes); the resolving
    /// caller persists the fetched bytes instead.
    pub async fn import_snapshot_envelope(
        &self,
        room_id: &RoomId,
        envelope: &MailboxEnvelope,
    ) -> Result<(String, Vec<u8>), InboundError> {
        if envelope.kind != EnvelopeKind::SnapshotBlob {
            return Err(InboundError::KindMismatch {
                expected: EnvelopeKind::SnapshotBlob,
                actual: envelope.kind,
            });
        }
        let plaintext = self.open_blob(envelope, &self.snapshot_key)?;
        // Transparent gzip (see review::compression): inflate before the
        // R2-ref sniff and before persisting, so the store always holds
        // logical plaintext bytes matching the signed BlobRef hash.
        let plaintext = match crate::review::compression::decompress_if_needed(
            &plaintext,
            crate::review::compression::MAX_DECOMPRESSED_SNAPSHOT_BYTES,
        ) {
            Ok(inflated) => inflated.into_owned(),
            Err(reason) => return Err(InboundError::Store(format!("snapshot inflate: {reason}"))),
        };
        let is_r2_ref = matches!(
            serde_json::from_slice::<crate::review::model::BlobRef>(&plaintext),
            Ok(blob_ref) if blob_ref.storage == crate::review::model::BlobStorage::R2
        );
        if !is_r2_ref {
            self.store
                .save_snapshot_blob(room_id, &envelope.envelope_id, &plaintext)
                .map_err(|e| InboundError::Store(format!("save snapshot blob: {e}")))?;
        }
        Ok((envelope.envelope_id.clone(), plaintext))
    }

    /// Open an R2 spillover object body (`nonce || ciphertext || tag` under
    /// `snapshotKey`, AAD bound to the wrapper envelope — see
    /// `envelope::seal_snapshot_r2_body`). The caller fetched `sealed_body`
    /// from R2 via the relay's presigned download URL; `wrapper` is the
    /// `kind=snapshot_blob` envelope whose plaintext was the `BlobRef`.
    pub fn open_r2_snapshot_body(
        &self,
        wrapper: &MailboxEnvelope,
        sealed_body: &[u8],
    ) -> Result<Vec<u8>, InboundError> {
        use crate::review::envelope::{EnvelopeError, open_snapshot_r2_body};
        open_snapshot_r2_body(&self.snapshot_key, sealed_body, wrapper).map_err(|e| match e {
            EnvelopeError::Aead(err) => InboundError::Aead(err),
            EnvelopeError::InvalidNonce(s) => InboundError::InvalidNonce(s),
            other => InboundError::Envelope(other),
        })
    }

    /// Process one inbound `kind=signal` envelope. Returns the recovered
    /// plaintext — the WebRTC layer (Phase 4) decodes it as SDP/ICE/etc.
    ///
    /// Like snapshot blobs, signal envelopes are confidentiality-only at this
    /// layer — there is no embedded Ed25519 signature to verify. The WebRTC
    /// layer either trusts the relay's `authorId`/`deviceId` headers (which
    /// are AAD-bound, so the relay cannot lie about them without invalidating
    /// the MAC), or layers its own DTLS fingerprint check on top.
    ///
    /// `expected_target_device_id`: the local device id. Per
    /// `planning/collab/security-review.md` §H2 (v2 mitigation), this method
    /// enforces `envelope.target.deviceId == expected_target_device_id` (or
    /// `envelope.target == None` for a true broadcast). `target.deviceId` is
    /// NOT bound into the AAD by spec, so a malicious relay can otherwise
    /// redirect a signal envelope to a peer that wasn't supposed to receive
    /// it — all room members hold `signalingKey` and can decrypt, but only
    /// the intended target should consume the inner SDP/ICE. The check fires
    /// AFTER `EnvelopeKind::Signal` dispatch and BEFORE AEAD-open, so an
    /// attacker-redirected envelope is rejected without paying the AEAD cost
    /// or surfacing plaintext upstream.
    pub async fn import_signal_envelope(
        &self,
        _room_id: &RoomId,
        envelope: &MailboxEnvelope,
        expected_target_device_id: &DeviceId,
    ) -> Result<Vec<u8>, InboundError> {
        if envelope.kind != EnvelopeKind::Signal {
            return Err(InboundError::KindMismatch {
                expected: EnvelopeKind::Signal,
                actual: envelope.kind,
            });
        }

        // H2 anti-redirect: only accept envelopes addressed to this device
        // (or true broadcasts with target=None). Broadcasts remain allowed
        // because the relay-spec wire format supports them and the WebRTC
        // state machine handles "advertise presence" via target-less signals;
        // anything with target=Some(other_device_id) is treated as a relay
        // redirect attempt regardless of whether the inner payload would
        // ultimately be rejected by the WebRTC layer's `from`-check.
        match envelope.target.as_ref() {
            None => { /* broadcast — allowed */ }
            Some(t) if &t.device_id == expected_target_device_id => { /* ok */ }
            Some(t) => {
                return Err(InboundError::TargetDeviceMismatch {
                    expected: id_to_string(expected_target_device_id),
                    actual: Some(id_to_string(&t.device_id)),
                });
            }
        }

        self.open_blob(envelope, &self.signaling_key)
    }

    /// Verify a v3 signal proof against the immutable authenticated directory
    /// before any SDP/ICE or collaboration plaintext is dispatched.
    pub async fn verify_signal_device_proof_v3(
        &self,
        room_id: &RoomId,
        envelope: &MailboxEnvelope,
    ) -> Result<(), InboundError> {
        let generation = envelope
            .signal_generation
            .ok_or_else(|| InboundError::SignalDeviceProof("missing signalGeneration".into()))?;
        let signature = envelope
            .device_signature
            .as_deref()
            .ok_or_else(|| InboundError::SignalDeviceProof("missing deviceSignature".into()))?;
        let authorizations = self.authorizations.read().await;
        let authorization = authorizations
            .values()
            .find(|record| {
                record.device_id == envelope.device_id
                    && record.participant_id == envelope.author_id
            })
            .ok_or_else(|| {
                InboundError::SignalDeviceProof(
                    "signer is absent from authenticated directory".into(),
                )
            })?;
        let raw = URL_SAFE_NO_PAD
            .decode(authorization.public_signing_key.as_bytes())
            .map_err(|error| InboundError::SignalDeviceProof(format!("directory key: {error}")))?;
        let bytes: [u8; 32] = raw.try_into().map_err(|raw: Vec<u8>| {
            InboundError::SignalDeviceProof(format!(
                "directory key must be 32 bytes, got {}",
                raw.len()
            ))
        })?;
        let key = DeviceVerifyingKey::from_bytes(&bytes)
            .map_err(|error| InboundError::SignalDeviceProof(format!("directory key: {error}")))?;
        let target = envelope
            .target
            .as_ref()
            .map(|target| id_to_string(&target.device_id));
        crate::review::crypto::device_proof::verify_device_signal_proof_v3(
            &key,
            signature,
            room_id.as_str(),
            &envelope.envelope_id,
            &id_to_string(&envelope.author_id),
            &id_to_string(&envelope.device_id),
            target.as_deref(),
            generation,
            envelope.created_at,
            envelope.expires_at,
            &envelope.nonce,
            &envelope.ciphertext,
            envelope.ciphertext_bytes,
        )
        .map_err(InboundError::SignalDeviceProof)
    }

    /// Shared AEAD-open path for `snapshot_blob` and `signal` envelopes.
    ///
    /// Both envelope shapes are confidentiality-only: the plaintext is opaque
    /// bytes (snapshot blob, SDP, ICE candidate, etc.) rather than a signed
    /// `ReviewEvent`, so the pipeline stops at AEAD-open. The AAD is rebuilt
    /// from the same cleartext envelope fields the relay sees — any tampering
    /// with `envelopeId`, `kind`, `authorId`, `deviceId`, or `createdAt`
    /// invalidates the MAC and surfaces as `AeadError::Decrypt`.
    fn open_blob(
        &self,
        envelope: &MailboxEnvelope,
        key: &[u8; 32],
    ) -> Result<Vec<u8>, InboundError> {
        let aad = EnvelopeAad {
            v: envelope.v,
            room_id: envelope.room_id.as_str().to_string(),
            envelope_id: envelope.envelope_id.clone(),
            kind: envelope_kind_wire(&envelope.kind).to_string(),
            author_id: id_to_string(&envelope.author_id),
            device_id: id_to_string(&envelope.device_id),
            created_at: envelope.created_at as i64,
        };

        let nonce_bytes = URL_SAFE_NO_PAD
            .decode(envelope.nonce.as_bytes())
            .map_err(|e| InboundError::InvalidNonce(e.to_string()))?;
        let nonce: AeadNonce = nonce_bytes.as_slice().try_into().map_err(|_| {
            InboundError::InvalidNonce(format!("expected 24 bytes, got {}", nonce_bytes.len()))
        })?;
        let ciphertext = URL_SAFE_NO_PAD
            .decode(envelope.ciphertext.as_bytes())
            .map_err(|e| InboundError::InvalidCiphertext(e.to_string()))?;

        let plaintext = aead::open(key, &nonce, &ciphertext, &aad)?;
        Ok(plaintext)
    }
}

fn authorize_event(
    event: &ReviewEvent,
    authorizations: &mut HashMap<String, RegisteredDeviceAuthorization>,
) -> Result<(), InboundError> {
    let Some(registered) = authorizations.get_mut(&event.auth.signing_key_id) else {
        return Err(InboundError::UnauthorizedEvent);
    };
    if registered.participant_id != event.meta.author_id
        || registered.device_id != event.meta.device_id
    {
        return Err(InboundError::UnauthorizedEvent);
    }

    match &event.body {
        ReviewEventBody::ParticipantJoined { .. } => {
            if !registered.validates_attestation(event) {
                return Err(InboundError::UnauthorizedEvent);
            }
            registered.attested = true;
            Ok(())
        }
        ReviewEventBody::RoomCreated {
            room_id,
            created_by,
            ..
        } if registered.kind == ParticipantKind::Owner
            && room_id == &event.meta.room_id
            && created_by == &event.meta.author_id =>
        {
            Ok(())
        }
        _ if registered.kind != ParticipantKind::Owner && !registered.attested => {
            Err(InboundError::UnauthorizedEvent)
        }
        ReviewEventBody::CommentCreated { .. } => Ok(()),
        ReviewEventBody::SuggestionCreated { .. }
            if registered.grant_tier.unwrap_or(GrantTier::Suggest) == GrantTier::Suggest =>
        {
            Ok(())
        }
        ReviewEventBody::CommentResolved { resolved_by, .. }
            if registered.kind != ParticipantKind::Agent
                && resolved_by == &event.meta.author_id =>
        {
            Ok(())
        }
        ReviewEventBody::PresenceUpdated {
            participant_id,
            device_id,
            ..
        } if participant_id == &event.meta.author_id && device_id == &event.meta.device_id => {
            Ok(())
        }
        ReviewEventBody::SnapshotCreated { .. }
        | ReviewEventBody::SnapshotSuperseded { .. }
        | ReviewEventBody::SuggestionAccepted { .. }
        | ReviewEventBody::SuggestionRejected { .. }
        | ReviewEventBody::SessionEnded { .. }
            if registered.kind == ParticipantKind::Owner =>
        {
            Ok(())
        }
        ReviewEventBody::AnchorManuallyResolved { resolved_by, .. }
            if registered.kind == ParticipantKind::Owner
                && resolved_by == &event.meta.author_id =>
        {
            Ok(())
        }
        _ => Err(InboundError::UnauthorizedEvent),
    }
}

fn exact_capabilities(
    actual: &[Capability],
    kind: ParticipantKind,
    grant_tier: Option<GrantTier>,
) -> bool {
    let expected: &[Capability] = match (kind, grant_tier) {
        (ParticipantKind::Reviewer, Some(GrantTier::Comment)) => &[
            Capability::ReadSnapshot,
            Capability::WriteComment,
            Capability::ResolveComment,
        ],
        (ParticipantKind::Agent, Some(GrantTier::Comment)) => {
            &[Capability::ReadSnapshot, Capability::WriteComment]
        }
        (ParticipantKind::Owner, _) => &[
            Capability::RoomAdmin,
            Capability::ReadSnapshot,
            Capability::WriteComment,
            Capability::WriteSuggestion,
            Capability::ResolveComment,
            Capability::AcceptSuggestion,
            Capability::PublishSnapshot,
        ],
        (ParticipantKind::Reviewer, _) => &[
            Capability::ReadSnapshot,
            Capability::WriteComment,
            Capability::WriteSuggestion,
            Capability::ResolveComment,
        ],
        (ParticipantKind::Agent, _) => &[
            Capability::ReadSnapshot,
            Capability::WriteComment,
            Capability::WriteSuggestion,
        ],
    };
    actual.len() == expected.len() && expected.iter().all(|cap| actual.contains(cap))
}

// ---------------------------------------------------------------------------
// Helpers — mirror those in envelope.rs (kept private so the wire-string
// representation stays in lock-step with the AAD construction there).
// ---------------------------------------------------------------------------

/// Wire string for an `EnvelopeKind` — must match `#[serde(rename_all = "snake_case")]`
/// on `model::EnvelopeKind`. Duplicated from envelope.rs deliberately: AAD
/// reconstruction is byte-sensitive and a stray rename in one place must not
/// silently desync the other. The test `aad_kind_wire_strings_match_serde`
/// guards against drift.
fn envelope_kind_wire(kind: &EnvelopeKind) -> &'static str {
    match kind {
        EnvelopeKind::Event => "event",
        EnvelopeKind::SnapshotBlob => "snapshot_blob",
        EnvelopeKind::Signal => "signal",
    }
}

/// Round-trip a typed id newtype to its inner string. Same helper as
/// envelope.rs::id_string — kept private here so the inbound module is a
/// self-contained translation unit.
fn id_to_string<T: serde::Serialize>(id: &T) -> String {
    match serde_json::to_value(id).expect("typed id serializes as JSON string") {
        serde_json::Value::String(s) => s,
        other => panic!("typed id must serialize as JSON string, got {other:?}"),
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
    use tempfile::TempDir;

    use crate::review::crypto::kdf::derive_room_keys;
    use crate::review::crypto::signing::DeviceSigningKey;
    use crate::review::envelope::{AssembleInput, assemble_event_envelope};
    use crate::review::ids::{ContentHash, DeviceId, FileId, ParticipantId, SnapshotId};
    use crate::review::model::{Anchor, EnvelopeKind, PositionAnchor, ReviewEventBody};

    // -----------------------------------------------------------------
    // Test fixtures — mirror envelope.rs so a future schema change
    // doesn't have to be replayed across two test modules.
    // -----------------------------------------------------------------

    /// Pinned 32-byte room secret; matches envelope.rs and the
    /// `envelope.json` corpus so a stray cross-test divergence is loud.
    const TEST_ROOM_SECRET: [u8; 32] = [0x11u8; 32];
    const TEST_SIGNING_SEED: [u8; 32] = [0x22u8; 32];

    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("typed id deserializes")
    }

    fn fresh_store() -> (TempDir, Arc<ReviewStore>) {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        (tmp, store)
    }

    fn test_authorizations(key_id: String, public_signing_key: String) -> AuthorizationCache {
        let record = RegisteredDeviceAuthorization {
            participant_id: id("p-author-01"),
            device_id: id("d-device-01"),
            public_encryption_key: public_signing_key.clone(),
            public_signing_key,
            client: DeviceClient::AttnNative,
            kind: ParticipantKind::Reviewer,
            grant_tier: None,
            grant_signature: None,
            attested: true,
        };
        Arc::new(RwLock::new(HashMap::from([(key_id, record)])))
    }

    /// Build a pipeline + the verifying-keys cache pre-populated with the
    /// signer's pubkey. Returns (pipeline, store, signing-seed, room_id, tmp).
    fn fresh_pipeline_with_signer() -> (
        InboundPipeline,
        Arc<ReviewStore>,
        DeviceSigningKey,
        RoomId,
        TempDir,
    ) {
        let (tmp, store) = fresh_store();
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let snapshot_key = *keys.snapshot_key.as_bytes();
        let signaling_key = *keys.signaling_key.as_bytes();

        let signer = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let signer_keyid = signer.verifying_key().signing_key_id_base64url();
        let mut map: HashMap<String, DeviceVerifyingKey> = HashMap::new();
        map.insert(signer_keyid.clone(), signer.verifying_key());
        let cache: VerifyingKeyCache = Arc::new(RwLock::new(map));
        let public_signing_key = URL_SAFE_NO_PAD.encode(signer.verifying_key().to_bytes());
        let authorizations = test_authorizations(signer_keyid, public_signing_key);

        let room_id: RoomId = id("hjCfgOvsatNOUedgxhZpyw");
        let pipeline = InboundPipeline::new(
            store.clone(),
            cache,
            authorizations,
            event_key,
            snapshot_key,
            signaling_key,
        );
        (pipeline, store, signer, room_id, tmp)
    }

    /// Mint a fresh kind=event envelope from the canonical fixture body.
    /// The signing key is moved in (`DeviceSigningKey` is not Clone), so
    /// callers that want to reuse the seed for vk lookup must re-derive
    /// from `TEST_SIGNING_SEED`.
    fn mint_event_envelope(
        event_key: [u8; 32],
        signing_key: DeviceSigningKey,
        room_id: &RoomId,
    ) -> MailboxEnvelope {
        mint_event_envelope_with_body(
            event_key,
            signing_key,
            room_id,
            ReviewEventBody::CommentCreated {
                thread_id: "thread-1".to_string(),
                anchor: Anchor {
                    v: 2,
                    file_id: id::<FileId>("f-file-01"),
                    snapshot_id: id::<SnapshotId>("eQ7pDCC-mekpz-we7gDYag"),
                    base_hash: id::<ContentHash>("fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y"),
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
        )
    }

    fn mint_event_envelope_with_body(
        event_key: [u8; 32],
        signing_key: DeviceSigningKey,
        room_id: &RoomId,
        body: ReviewEventBody,
    ) -> MailboxEnvelope {
        let input = AssembleInput {
            event_key,
            signing_key,
            room_id: room_id.clone(),
            author_id: id::<ParticipantId>("p-author-01"),
            device_id: id::<DeviceId>("d-device-01"),
            created_at_ms: 1_700_000_000_000,
            expires_at_ms: 1_700_000_000_000 + 7 * 24 * 60 * 60 * 1000,
            parent_event_ids: vec![],
            snapshot_id: None,
            body,
            kind: EnvelopeKind::Event,
            client_nonce: None,
        };
        assemble_event_envelope(input).expect("assemble envelope")
    }

    /// Mint a fresh blob envelope (snapshot_blob or signal) directly via the
    /// AEAD layer — bypasses `assemble_event_envelope` because those envelopes
    /// don't have a signed-event plaintext. Mirrors what the production
    /// snapshot/signal assemblers will eventually do (issues 5.x / 7.x).
    ///
    /// `target_device_id`: cleartext routing tag the relay would see. `None`
    /// is the broadcast / target-less form (currently the only shape callers
    /// in this module need for non-signal kinds); `Some(d)` is needed for the
    /// H2 anti-redirect tests below where we mint a signal envelope addressed
    /// to a specific (or attacker-spoofed) device.
    fn mint_blob_envelope(
        key: &[u8; 32],
        room_id: &RoomId,
        kind: EnvelopeKind,
        plaintext: &[u8],
        client_nonce: [u8; 16],
        target_device_id: Option<DeviceId>,
    ) -> MailboxEnvelope {
        use crate::review::crypto::ids::derive_envelope_id_with_nonce;
        use crate::review::model::EnvelopeTarget;

        let author_id: ParticipantId = id("p-author-01");
        let device_id: DeviceId = id("d-device-01");
        let created_at_ms: u64 = 1_700_000_000_000;
        let envelope_id = derive_envelope_id_with_nonce(
            room_id,
            id_to_string(&device_id).as_str(),
            &client_nonce,
        );

        let aad = EnvelopeAad {
            v: 2,
            room_id: room_id.as_str().to_string(),
            envelope_id: envelope_id.clone(),
            kind: envelope_kind_wire(&kind).to_string(),
            author_id: id_to_string(&author_id),
            device_id: id_to_string(&device_id),
            created_at: created_at_ms as i64,
        };

        let (aead_nonce, ciphertext) = aead::seal(key, plaintext, &aad).expect("seal blob");
        MailboxEnvelope {
            v: 2,
            room_id: room_id.clone(),
            envelope_id,
            server_seq: None,
            author_id,
            device_id,
            created_at: created_at_ms,
            expires_at: created_at_ms + 7 * 24 * 60 * 60 * 1000,
            kind,
            target: target_device_id.map(|d| EnvelopeTarget { device_id: d }),
            nonce: URL_SAFE_NO_PAD.encode(aead_nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(&ciphertext),
            ciphertext_bytes: ciphertext.len() as u64,
            signal_generation: None,
            device_signature: None,
        }
    }

    // -----------------------------------------------------------------
    // 1. Happy-path event import: assemble -> import -> newly_imported=true
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn import_event_envelope_happy_path_marks_newly_imported() {
        let (pipeline, _store, signer, room_id, _tmp) = fresh_pipeline_with_signer();
        pipeline
            .authorizations
            .write()
            .await
            .values_mut()
            .next()
            .expect("authorization")
            .grant_tier = Some(GrantTier::Comment);
        let envelope = mint_event_envelope(pipeline.event_key, signer, &room_id);

        let outcome = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect("import succeeds");

        assert!(
            outcome.newly_imported,
            "first import of a fresh envelope must be newly_imported=true"
        );
        // The recovered event must carry the expected meta + body shape.
        match &outcome.event.body {
            ReviewEventBody::CommentCreated {
                thread_id, body, ..
            } => {
                assert_eq!(thread_id, "thread-1");
                assert_eq!(body, "hello");
            }
            other => panic!("expected CommentCreated, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn caller_policy_rejects_before_event_log_append() {
        let (pipeline, store, signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let envelope = mint_event_envelope(pipeline.event_key, signer, &room_id);
        let error = pipeline
            .import_event_envelope_if(&room_id, &envelope, |_| false)
            .await
            .expect_err("caller policy must reject");
        assert!(matches!(error, InboundError::UnauthorizedEvent));
        assert_eq!(store.iter_events(&room_id).expect("events").count(), 0);
    }

    #[tokio::test]
    async fn tier_comment_rejects_suggestion_before_persistence() {
        let (pipeline, store, signer, room_id, _tmp) = fresh_pipeline_with_signer();
        pipeline
            .authorizations
            .write()
            .await
            .values_mut()
            .next()
            .expect("authorization")
            .grant_tier = Some(GrantTier::Comment);
        let envelope = mint_event_envelope_with_body(
            pipeline.event_key,
            signer,
            &room_id,
            ReviewEventBody::SuggestionCreated {
                suggestion_id: "suggestion-out-of-tier".to_string(),
                anchor: Anchor {
                    v: 2,
                    file_id: id::<FileId>("f-file-01"),
                    snapshot_id: id::<SnapshotId>("eQ7pDCC-mekpz-we7gDYag"),
                    base_hash: id::<ContentHash>("fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y"),
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
                operation: crate::review::model::SuggestionOperation::Replace {
                    expected_text: "old".to_string(),
                    replacement: "new".to_string(),
                },
                note: None,
            },
        );
        let error = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect_err("comment tier cannot import suggestion");
        assert!(matches!(error, InboundError::UnauthorizedEvent));
        assert_eq!(store.iter_events(&room_id).expect("events").count(), 0);
    }

    #[tokio::test]
    async fn reviewer_cannot_import_owner_only_snapshot_event() {
        let (pipeline, store, signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let envelope = mint_event_envelope_with_body(
            pipeline.event_key,
            signer,
            &room_id,
            ReviewEventBody::SnapshotCreated {
                file_id: id("f-file-01"),
                snapshot_id: id("eQ7pDCC-mekpz-we7gDYag"),
                owner_display_path: Some("secret.md".into()),
                parent_snapshot_id: None,
                base_hash: id("fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y"),
                encrypted_blob_ref: None,
                inline_snapshot: None,
            },
        );

        let error = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect_err("reviewer snapshot must be rejected before persistence");
        assert!(matches!(error, InboundError::UnauthorizedEvent));
        assert_eq!(store.iter_events(&room_id).expect("events").count(), 0);
    }

    // -----------------------------------------------------------------
    // 2. Dedup: re-importing the same envelope -> newly_imported=false
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn import_event_envelope_dedups_by_event_id_on_reimport() {
        let (pipeline, _store, signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let envelope = mint_event_envelope(pipeline.event_key, signer, &room_id);

        let first = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect("first import");
        assert!(first.newly_imported);

        let second = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect("second import");
        assert!(
            !second.newly_imported,
            "re-importing the same envelope must dedup via store.append_event"
        );
        // Body must still round-trip — dedup does not change the recovered event.
        assert_eq!(first.event, second.event);
    }

    // -----------------------------------------------------------------
    // 3. Tampered ciphertext -> InboundError::Envelope(AeadError::Decrypt)
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn import_event_envelope_tampered_ciphertext_fails() {
        let (pipeline, _store, signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let mut envelope = mint_event_envelope(pipeline.event_key, signer, &room_id);
        let mut bytes = URL_SAFE_NO_PAD
            .decode(envelope.ciphertext.as_bytes())
            .unwrap();
        bytes[0] ^= 0x01;
        envelope.ciphertext = URL_SAFE_NO_PAD.encode(&bytes);

        let err = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect_err("tampered ciphertext must not import");

        // Poly1305 detects the flipped byte; AeadError::Decrypt is opaque on
        // purpose (see aead.rs). Surfaced as InboundError::Envelope so the
        // caller distinguishes "bad signer" from "bad bytes".
        match err {
            InboundError::Envelope(EnvelopeError::Aead(AeadError::Decrypt)) => {}
            other => panic!("expected Envelope(Aead(Decrypt)), got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // 4. Unknown signer -> typed InboundError::UnknownSigner so the
    //    caller knows to refresh the device cache and retry.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn import_event_envelope_with_unknown_signer_surfaces_unknown_signer() {
        let (tmp, store) = fresh_store();
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let snapshot_key = *keys.snapshot_key.as_bytes();
        let signaling_key = *keys.signaling_key.as_bytes();

        // Deliberately leave the verifying-keys cache empty so the assembler's
        // signingKeyId is not in the map.
        let empty: VerifyingKeyCache = Arc::new(RwLock::new(HashMap::new()));
        let pipeline = InboundPipeline::new(
            store,
            empty,
            Arc::new(RwLock::new(HashMap::new())),
            event_key,
            snapshot_key,
            signaling_key,
        );

        let room_id: RoomId = id("hjCfgOvsatNOUedgxhZpyw");
        let signer = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let expected_keyid = signer.verifying_key().signing_key_id_base64url();
        let envelope = mint_event_envelope(event_key, signer, &room_id);

        let err = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect_err("unknown signer must short-circuit");
        match err {
            InboundError::UnknownSigner { signing_key_id } => {
                assert_eq!(
                    signing_key_id, expected_keyid,
                    "UnknownSigner must carry the assembler's signingKeyId so the caller can refresh that exact entry"
                );
            }
            other => panic!("expected UnknownSigner, got {other:?}"),
        }
        // Keep `tmp` alive until after the assertion so the store dir survives.
        drop(tmp);
    }

    // -----------------------------------------------------------------
    // 5. add_verifying_key resolves a prior UnknownSigner (the retry path).
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn add_verifying_key_unblocks_a_previously_unknown_signer() {
        let (tmp, store) = fresh_store();
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let snapshot_key = *keys.snapshot_key.as_bytes();
        let signaling_key = *keys.signaling_key.as_bytes();

        let empty: VerifyingKeyCache = Arc::new(RwLock::new(HashMap::new()));
        let signer_for_auth = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let auth_key_id = signer_for_auth.verifying_key().signing_key_id_base64url();
        let auth_public = URL_SAFE_NO_PAD.encode(signer_for_auth.verifying_key().to_bytes());
        let pipeline = InboundPipeline::new(
            store,
            empty,
            test_authorizations(auth_key_id, auth_public),
            event_key,
            snapshot_key,
            signaling_key,
        );

        let room_id: RoomId = id("hjCfgOvsatNOUedgxhZpyw");
        let signer = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let vk = signer.verifying_key();
        let keyid = vk.signing_key_id_base64url();
        let envelope = mint_event_envelope(event_key, signer, &room_id);

        // First try: empty cache -> UnknownSigner.
        let err = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect_err("first import must fail");
        assert!(matches!(err, InboundError::UnknownSigner { .. }));

        // Caller refreshes its device cache and re-tries -> success.
        pipeline.add_verifying_key(keyid, vk).await;
        let outcome = pipeline
            .import_event_envelope(&room_id, &envelope)
            .await
            .expect("retry after add_verifying_key succeeds");
        assert!(
            outcome.newly_imported,
            "retry must be the first successful import — store.append_event has not seen this EventId yet"
        );
        drop(tmp);
    }

    // -----------------------------------------------------------------
    // 6. Snapshot blob round-trip — decrypts under snapshotKey.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn import_snapshot_envelope_decrypts_under_snapshot_key() {
        let (pipeline, _store, _signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let snapshot_bytes = b"snapshot bytes: # hello world\n\nlorem ipsum...";
        let envelope = mint_blob_envelope(
            &pipeline.snapshot_key,
            &room_id,
            EnvelopeKind::SnapshotBlob,
            snapshot_bytes,
            [0x77u8; 16],
            None,
        );

        let (envelope_id, plaintext) = pipeline
            .import_snapshot_envelope(&room_id, &envelope)
            .await
            .expect("snapshot decrypt");
        assert_eq!(envelope_id, envelope.envelope_id);
        assert_eq!(plaintext, snapshot_bytes);

        // Inline snapshot bytes are persisted to the blob store so the
        // manager's SnapshotCreated rehydration can find them.
        let stored = _store
            .load_snapshot_blob(&room_id, &envelope_id)
            .expect("load blob")
            .expect("blob persisted");
        assert_eq!(stored, snapshot_bytes);
    }

    #[tokio::test]
    async fn import_snapshot_envelope_does_not_persist_r2_blob_refs() {
        // An R2 BlobRef plaintext is an indirection, not the bytes — the
        // resolving caller (ws.rs) persists the fetched bytes instead.
        let (pipeline, _store, _signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let blob_ref = crate::review::model::BlobRef {
            storage: crate::review::model::BlobStorage::R2,
            blob_id: "blob-1".to_string(),
            byte_length: 4096,
            content_hash: serde_json::from_value(serde_json::Value::String("hash-1".to_string()))
                .expect("typed hash"),
        };
        let ref_bytes = serde_json::to_vec(&blob_ref).expect("serialize blob ref");
        let envelope = mint_blob_envelope(
            &pipeline.snapshot_key,
            &room_id,
            EnvelopeKind::SnapshotBlob,
            &ref_bytes,
            [0x78u8; 16],
            None,
        );

        let (envelope_id, plaintext) = pipeline
            .import_snapshot_envelope(&room_id, &envelope)
            .await
            .expect("snapshot decrypt");
        assert_eq!(plaintext, ref_bytes);
        assert_eq!(
            _store
                .load_snapshot_blob(&room_id, &envelope_id)
                .expect("load blob"),
            None,
            "R2 BlobRef plaintext must not be persisted as snapshot bytes"
        );
    }

    // -----------------------------------------------------------------
    // 7. Snapshot blob sealed under the WRONG key (event_key) must fail
    //    — proves the kind/key dispatch table is actually enforced.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn import_snapshot_envelope_under_wrong_key_fails() {
        let (pipeline, _store, _signer, room_id, _tmp) = fresh_pipeline_with_signer();
        // Seal a snapshot_blob envelope under EVENT_KEY (wrong!) — the AEAD
        // open in import_snapshot_envelope uses SNAPSHOT_KEY, so MAC must fail.
        let envelope = mint_blob_envelope(
            &pipeline.event_key,
            &room_id,
            EnvelopeKind::SnapshotBlob,
            b"will not decrypt",
            [0x77u8; 16],
            None,
        );

        let err = pipeline
            .import_snapshot_envelope(&room_id, &envelope)
            .await
            .expect_err("snapshot envelope sealed under wrong key must not open");
        assert!(
            matches!(err, InboundError::Aead(AeadError::Decrypt)),
            "expected Aead(Decrypt), got {err:?}"
        );
    }

    // -----------------------------------------------------------------
    // 8. Signal envelope round-trip — decrypts under signalingKey.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn import_signal_envelope_decrypts_under_signaling_key() {
        let (pipeline, _store, _signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let sdp_offer = br#"{"type":"offer","sdp":"v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n"}"#;
        // Build with target=None (broadcast) — the permissive case for the
        // H2 target check; covered separately in the targeted-self test.
        let envelope = mint_blob_envelope(
            &pipeline.signaling_key,
            &room_id,
            EnvelopeKind::Signal,
            sdp_offer,
            [0x88u8; 16],
            None,
        );

        let local_device: DeviceId = id("d-self");
        let plaintext = pipeline
            .import_signal_envelope(&room_id, &envelope, &local_device)
            .await
            .expect("signal decrypt");
        assert_eq!(plaintext, sdp_offer);
    }

    // -----------------------------------------------------------------
    // 9. Kind dispatch: handing the wrong envelope kind to a method
    //    must surface as `KindMismatch` — protects against a buggy
    //    caller routing on a hand-rolled `if/else` instead of the
    //    `envelope.kind` enum.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn import_methods_reject_kind_mismatch() {
        let (pipeline, _store, signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let event_envelope = mint_event_envelope(pipeline.event_key, signer, &room_id);

        // Event envelope handed to the snapshot path -> KindMismatch.
        let err = pipeline
            .import_snapshot_envelope(&room_id, &event_envelope)
            .await
            .expect_err("event envelope on snapshot path must reject");
        match err {
            InboundError::KindMismatch { expected, actual } => {
                assert_eq!(expected, EnvelopeKind::SnapshotBlob);
                assert_eq!(actual, EnvelopeKind::Event);
            }
            other => panic!("expected KindMismatch, got {other:?}"),
        }

        // Event envelope handed to the signal path -> KindMismatch.
        // The KindMismatch check fires before the H2 target check, so the
        // dummy local DeviceId here is irrelevant — we exercise the dispatch
        // guard, not the target enforcement.
        let local_device: DeviceId = id("d-self");
        let err = pipeline
            .import_signal_envelope(&room_id, &event_envelope, &local_device)
            .await
            .expect_err("event envelope on signal path must reject");
        assert!(matches!(err, InboundError::KindMismatch { .. }));

        // Snapshot envelope handed to the event path -> KindMismatch.
        let snapshot_envelope = mint_blob_envelope(
            &pipeline.snapshot_key,
            &room_id,
            EnvelopeKind::SnapshotBlob,
            b"snap",
            [0x99u8; 16],
            None,
        );
        let err = pipeline
            .import_event_envelope(&room_id, &snapshot_envelope)
            .await
            .expect_err("snapshot envelope on event path must reject");
        assert!(matches!(err, InboundError::KindMismatch { .. }));
    }

    // -----------------------------------------------------------------
    // 10. Drift guard: wire-kind strings used in AAD reconstruction MUST
    //     match serde's `rename_all = "snake_case"` for EnvelopeKind. If
    //     the model adds a new kind or renames an existing one, this
    //     fires loud — better than a silent decrypt failure in prod.
    // -----------------------------------------------------------------

    #[test]
    fn aad_kind_wire_strings_match_serde() {
        for kind in [
            EnvelopeKind::Event,
            EnvelopeKind::SnapshotBlob,
            EnvelopeKind::Signal,
        ] {
            let via_serde = serde_json::to_value(kind).unwrap();
            let via_local = serde_json::Value::String(envelope_kind_wire(&kind).to_string());
            assert_eq!(
                via_serde, via_local,
                "envelope_kind_wire and serde diverge for {kind:?} — AAD reconstruction would fail to decrypt prod envelopes"
            );
        }
    }

    // -----------------------------------------------------------------
    // 11. Corpus replay: every non-pending `kind=event` vector in
    //     planning/collab/test-vectors/envelope.json must round-trip
    //     through the inbound pipeline end-to-end. This proves the
    //     pipeline interops with the canonical fixtures the TS/WASM
    //     client also consumes — a divergence in either side fails
    //     loudly without needing to wire a full integration test.
    // -----------------------------------------------------------------

    const ENVELOPE_CORPUS: &str =
        include_str!("../../../planning/collab/test-vectors/envelope.json");

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
    }

    #[derive(Deserialize)]
    struct CorpusSigningKey {
        public: String,
    }

    #[derive(Deserialize)]
    struct CorpusExpected {
        envelope: Value,
        ciphertext: String,
    }

    #[tokio::test]
    async fn corpus_replay_event_vectors_round_trip_through_pipeline() {
        let corpus: CorpusFile =
            serde_json::from_str(ENVELOPE_CORPUS).expect("envelope.json parses");

        let mut imported = 0usize;
        for v in &corpus.vectors {
            // Skip placeholder vectors emitted by sibling work-in-progress
            // issues — the assertion at the end of the loop catches any
            // future regression where every event vector ends up pending.
            if v.expected.ciphertext.starts_with("__PENDING") {
                continue;
            }
            // We only exercise event-kind envelopes here; the snapshot/signal
            // sides of the corpus are covered by tests 6 + 8 above using
            // hand-minted envelopes (the corpus does not pin a snapshot_blob
            // vector today — that lands with issue 5.x).
            let kind = v
                .expected
                .envelope
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("");
            if kind != "event" {
                continue;
            }

            // Decode the secret + derive room keys. The vectors all share
            // roomSecret = 0x11*32 (rule pinned in envelope.json _schema)
            // but we re-derive per vector to stay honest if that ever changes.
            let secret_bytes = URL_SAFE_NO_PAD
                .decode(v.inputs.room_secret.as_bytes())
                .unwrap_or_else(|e| panic!("[{}] roomSecret decode: {e}", v.name));
            let secret: [u8; 32] = secret_bytes
                .as_slice()
                .try_into()
                .unwrap_or_else(|_| panic!("[{}] roomSecret must be 32 bytes", v.name));
            let room_keys = derive_room_keys(&secret);

            // Build a fresh store + pipeline per vector — dedup is per-store,
            // and we want the "newly imported" path to fire for every vector.
            let tmp = TempDir::new().expect("tempdir");
            let store =
                Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
            let vk_bytes: [u8; 32] = URL_SAFE_NO_PAD
                .decode(v.inputs.signing_key.public.as_bytes())
                .unwrap()
                .as_slice()
                .try_into()
                .unwrap_or_else(|_| panic!("[{}] signingKey.public must be 32 bytes", v.name));
            let vk = DeviceVerifyingKey::from_bytes(&vk_bytes).unwrap();
            let keyid = vk.signing_key_id_base64url();
            let mut map: HashMap<String, DeviceVerifyingKey> = HashMap::new();
            map.insert(keyid.clone(), vk);
            let cache: VerifyingKeyCache = Arc::new(RwLock::new(map));
            let authorizations = test_authorizations(keyid, URL_SAFE_NO_PAD.encode(vk_bytes));
            let pipeline = InboundPipeline::new(
                store,
                cache,
                authorizations,
                *room_keys.event_key.as_bytes(),
                *room_keys.snapshot_key.as_bytes(),
                *room_keys.signaling_key.as_bytes(),
            );

            // Decode the corpus envelope as a MailboxEnvelope (camelCase
            // serde matches the JSON on disk).
            let envelope: MailboxEnvelope = serde_json::from_value(v.expected.envelope.clone())
                .unwrap_or_else(|e| panic!("[{}] envelope deserialize: {e}", v.name));
            let room_id = envelope.room_id.clone();

            // First import: must succeed and be newly_imported.
            let first = pipeline
                .import_event_envelope(&room_id, &envelope)
                .await
                .unwrap_or_else(|e| panic!("[{}] import failed: {e:?}", v.name));
            assert!(
                first.newly_imported,
                "[{}] first import must be newly_imported",
                v.name
            );

            // Second import of the same envelope: dedup -> newly_imported=false.
            let second = pipeline
                .import_event_envelope(&room_id, &envelope)
                .await
                .unwrap_or_else(|e| panic!("[{}] dedup import failed: {e:?}", v.name));
            assert!(
                !second.newly_imported,
                "[{}] re-import must dedup via store.append_event",
                v.name
            );
            assert_eq!(
                first.event, second.event,
                "[{}] dedup must still return the same recovered event",
                v.name
            );

            imported += 1;
            drop(tmp);
        }

        assert!(
            imported >= 1,
            "expected at least 1 non-pending event vector from envelope.json corpus, got {imported}"
        );
    }

    // -----------------------------------------------------------------
    // H2 (attn-nnj.7.9): target.deviceId enforcement on signal import.
    //
    // The signal envelope's `target.deviceId` is NOT bound into AEAD AAD
    // by spec, so a relay can rewrite it without invalidating the MAC.
    // `import_signal_envelope` therefore enforces equality with the local
    // device id (or accepts the broadcast / target=None form) BEFORE
    // AEAD-open, and surfaces a relay-redirect attempt as
    // `InboundError::TargetDeviceMismatch`.
    //
    // Tests cover the three branches of the target check:
    //   12. target=Some(self)  → accept (targeted-to-us).
    //   13. target=Some(other) → reject with TargetDeviceMismatch (relay redirect).
    //   14. target=None        → accept (true broadcast).
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn h2_signal_envelope_with_matching_target_is_accepted() {
        let (pipeline, _store, _signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let sdp_offer = br#"{"type":"offer","sdp":"v=0\r\n"}"#;
        let local_device: DeviceId = id("d-local-self");
        // Envelope addressed TO local_device — the normal targeted path.
        let envelope = mint_blob_envelope(
            &pipeline.signaling_key,
            &room_id,
            EnvelopeKind::Signal,
            sdp_offer,
            [0xA1u8; 16],
            Some(local_device.clone()),
        );

        let plaintext = pipeline
            .import_signal_envelope(&room_id, &envelope, &local_device)
            .await
            .expect("signal envelope addressed to self must import");
        assert_eq!(plaintext, sdp_offer);
    }

    #[tokio::test]
    async fn h2_signal_envelope_with_wrong_target_is_rejected_as_relay_redirect() {
        let (pipeline, _store, _signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let sdp_offer = br#"{"type":"offer","sdp":"v=0\r\n"}"#;
        let local_device: DeviceId = id("d-local-self");
        let attacker_redirect_target: DeviceId = id("d-some-other-peer");
        // Build a signal envelope sealed correctly under signalingKey but
        // addressed to a different device — mimics what a malicious relay
        // does when it rewrites `target.deviceId` to fan out to non-targets.
        // Because target is NOT AAD-bound, AEAD-open would still succeed —
        // the check must fire BEFORE we touch the ciphertext.
        let envelope = mint_blob_envelope(
            &pipeline.signaling_key,
            &room_id,
            EnvelopeKind::Signal,
            sdp_offer,
            [0xA2u8; 16],
            Some(attacker_redirect_target.clone()),
        );

        let err = pipeline
            .import_signal_envelope(&room_id, &envelope, &local_device)
            .await
            .expect_err("relay-redirected signal envelope must be rejected");
        match err {
            InboundError::TargetDeviceMismatch { expected, actual } => {
                assert_eq!(
                    expected,
                    id_to_string(&local_device),
                    "TargetDeviceMismatch must carry the expected (local) deviceId"
                );
                assert_eq!(
                    actual,
                    Some(id_to_string(&attacker_redirect_target)),
                    "TargetDeviceMismatch must carry the relay-supplied (wrong) deviceId"
                );
            }
            other => panic!("expected TargetDeviceMismatch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn h2_signal_envelope_broadcast_target_none_is_accepted() {
        let (pipeline, _store, _signer, room_id, _tmp) = fresh_pipeline_with_signer();
        let payload = br#"{"type":"presence_ad"}"#;
        let local_device: DeviceId = id("d-local-self");
        // True broadcast — relay-spec wire format permits target=None, and
        // the WebRTC state machine uses it for "advertise presence" style
        // signals. The H2 check must NOT block broadcasts; that would
        // break the negotiate-without-knowing-the-peer-yet flow.
        let envelope = mint_blob_envelope(
            &pipeline.signaling_key,
            &room_id,
            EnvelopeKind::Signal,
            payload,
            [0xA3u8; 16],
            None,
        );
        assert!(
            envelope.target.is_none(),
            "test precondition: broadcast envelope must have target=None"
        );

        let plaintext = pipeline
            .import_signal_envelope(&room_id, &envelope, &local_device)
            .await
            .expect("broadcast signal envelope must import regardless of local deviceId");
        assert_eq!(plaintext, payload);
    }
}
