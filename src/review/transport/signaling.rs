//! Encrypted WebRTC signaling envelopes.
//!
//! Carries SDP offers / answers, trickle ICE candidates, and
//! `request_snapshot` recovery prompts between peers via the relay's
//! `kind: "signal"` envelope channel. The relay stores + forwards the
//! encrypted blob but cannot see the SDP/ICE payload — it only sees the
//! cleartext routing tag (`target.deviceId`) and the envelope's standard
//! metadata.
//!
//! Spec:
//!   - `planning/collab/relay-spec.md` §Signaling
//!     (frame shape + target routing),
//!   - `planning/collab/crypto-spec.md` §Envelope Encryption (AEAD)
//!     (`signalingKey` is the dedicated subkey for `kind: "signal"`),
//!   - `planning/collab/amendments.md` §Phase 4
//!     (signalingKey is separately derived from rootKey via HKDF).
//!
//! ## Wire shape
//!
//! Plaintext = canonical-JSON of a [`SignalingPayload`]:
//!
//! ```json
//! { "kind": "offer",  "sdp": "v=0...",                "from": "<deviceId>" }
//! { "kind": "answer", "sdp": "v=0...",                "from": "<deviceId>" }
//! { "kind": "ice",    "candidates": ["candidate:..."], "from": "<deviceId>" }
//! { "kind": "request_snapshot", "fileId": "...", "sinceSnapshotId": "...", "from": "..." }
//! ```
//!
//! AAD = canonical-JSON of `{v:2, roomId, envelopeId, kind:"signal",
//! authorId, deviceId, createdAt}` — the same shape as every other envelope
//! kind so the receiver-side AAD reconstruction in
//! `transport::inbound::InboundPipeline::import_signal_envelope` works
//! unchanged.
//!
//! AEAD = XChaCha20-Poly1305 with a fresh 24-byte random nonce per envelope.
//!
//! `envelopeId = base64url(first 16 bytes of SHA-256("envelope v2" || roomId
//! || deviceId || clientNonce))` — the nonce-form per crypto-spec.md §ID
//! Construction. Retries reuse the same `clientNonce` so the relay can dedup
//! repeated offer/answer attempts.
//!
//! ## What this module owns
//!
//! - `SignalingPayload` enum (the inner plaintext shape).
//! - `assemble_signal_envelope` / `disassemble_signal_envelope` (the
//!   sealed-envelope round trip under `signalingKey`).
//!
//! ## What this module does NOT own
//!
//! - WebRTC peer-connection state machine (lives in attn-nnj.7.4).
//! - Outbound mailbox `POST /envelopes` (lives in `transport::mailbox`).
//! - WS receive + dispatch (lives in attn-nnj.6.3); inbound signal
//!   decryption already lives in `transport::inbound::InboundPipeline`.
//!   This module is the *symmetric* helper the assembler side uses to mint
//!   the envelopes that pipeline opens.

#![allow(dead_code)]

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

use crate::review::crypto::aead::{self, AeadNonce, EnvelopeAad};
use crate::review::crypto::canonical::{self, CanonError};
use crate::review::crypto::ids::derive_envelope_id_with_nonce;
use crate::review::envelope::EnvelopeError;
use crate::review::ids::{DeviceId, FileId, ParticipantId, RoomId, SnapshotId};
use crate::review::model::{EnvelopeKind, EnvelopeTarget, MailboxEnvelope};

// ---------------------------------------------------------------------------
// SignalingPayload — the inner plaintext shape
// ---------------------------------------------------------------------------

/// One WebRTC signaling message.
///
/// Tagged by `kind` so a stream of decrypted signaling payloads can be
/// dispatched without an out-of-band discriminator. `from` is the sending
/// device's id — receivers cross-check it against the envelope's cleartext
/// `deviceId` (which the AAD pins) and refuse mismatches as a defense
/// against a relay that tries to spoof origin.
///
/// `request_snapshot` is the Phase 4 recovery path (per
/// `amendments.md` §Phase 4): when a reviewer's WS cursor falls off the
/// retention window in live mode, they ask their peer for the snapshot
/// directly over WebRTC instead of resyncing from the relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SignalingPayload {
    /// WebRTC SDP offer from the dialing peer.
    Offer { sdp: String, from: DeviceId },
    /// WebRTC SDP answer from the answering peer.
    Answer { sdp: String, from: DeviceId },
    /// One or more trickle-ICE candidates.
    ///
    /// Bundled as `Vec<String>` (rather than one envelope per candidate) so a
    /// burst of candidates from the same gathering round amortizes the
    /// per-envelope AEAD overhead.
    Ice {
        candidates: Vec<String>,
        from: DeviceId,
    },
    /// Peer-to-peer snapshot fetch (recovery for live mode when the relay's
    /// retention window has scrolled past the reviewer's cursor — owner
    /// responds with a fresh `SnapshotCreated` event over the DataChannel).
    RequestSnapshot {
        file_id: FileId,
        #[serde(skip_serializing_if = "Option::is_none")]
        since_snapshot_id: Option<SnapshotId>,
        from: DeviceId,
    },
    /// Live co-typing traffic (prosemirror-collab steps). `payload` is the
    /// exact JSON string the sender's webview emitted — a submission (any
    /// client → owner) or an authoritative broadcast (owner → all). The
    /// daemon NEVER parses it: the prosemirror-collab authority lives in the
    /// owner's webview, so Rust is a pure encrypted step-pipe. Carried over
    /// the ephemeral, FIFO-capped `signal` channel so high-frequency steps
    /// never bloat the durable event log.
    Collab { from: DeviceId, payload: String },
}

impl SignalingPayload {
    /// AAD-bound outer device id must match this inner sender before routing.
    pub fn from(&self) -> &DeviceId {
        match self {
            Self::Offer { from, .. }
            | Self::Answer { from, .. }
            | Self::Ice { from, .. }
            | Self::RequestSnapshot { from, .. }
            | Self::Collab { from, .. } => from,
        }
    }

    pub fn is_webrtc_control(&self) -> bool {
        matches!(
            self,
            Self::Offer { .. } | Self::Answer { .. } | Self::Ice { .. }
        )
    }
}

// ---------------------------------------------------------------------------
// Assemble / disassemble
// ---------------------------------------------------------------------------

/// Mint a `kind: "signal"` envelope carrying `payload`, sealed under
/// `signaling_key` with AAD bound to the envelope's cleartext header.
///
/// `target_device_id`:
///   - `Some(d)` for the 1:1 negotiate-with-this-peer path (offers/answers,
///     directed ICE bursts, request_snapshot to a specific owner device);
///   - `None` for a broadcast (rarely useful for signal, but supported per
///     the relay-spec wire format — e.g. an owner that wants to advertise
///     "I'm here, send me your offer").
///
/// `client_nonce` is a 16-byte client-chosen nonce that persists across
/// retries so the relay can dedup repeated send attempts of the same
/// negotiation step. Callers should generate it once when persisting the
/// outgoing signal to disk and reuse it on every retry of the same logical
/// message (see crypto-spec.md §ID Construction → `EnvelopeId`).
///
/// Returns a fully-populated [`MailboxEnvelope`] ready for the outbox; the
/// caller is responsible for the actual relay POST (lives in
/// `transport::mailbox`).
// Each argument is a distinct crypto/wire input (keys, ids, nonce, timestamps);
// bundling them into a params struct buys no clarity and churns every call site.
#[allow(clippy::too_many_arguments)]
pub fn assemble_signal_envelope(
    payload: SignalingPayload,
    signaling_key: &[u8; 32],
    room_id: &RoomId,
    author_id: &ParticipantId,
    device_id: &DeviceId,
    target_device_id: Option<&DeviceId>,
    client_nonce: &[u8; 16],
    created_at_ms: i64,
    expires_at_ms: i64,
) -> Result<MailboxEnvelope, EnvelopeError> {
    // ---- 1. Canonical-JSON the inner plaintext. Canonical (not just any
    //         JSON) so a Rust sender and a future TS/WASM receiver agree on
    //         the bytes that get sealed.
    let plaintext = canonical::to_canonical_bytes(&payload).map_err(canon_to_envelope_err)?;

    // ---- 2. Derive the EnvelopeId. Per crypto-spec.md §ID Construction,
    //         signal/snapshot envelopes use the (roomId, deviceId,
    //         clientNonce) form — retries with the same clientNonce produce
    //         the same EnvelopeId so the relay dedups them.
    let envelope_id =
        derive_envelope_id_with_nonce(room_id, id_to_string(device_id).as_str(), client_nonce);

    // ---- 3. Build the AAD from the same cleartext envelope fields the
    //         relay will expose. Any tampering with envelopeId / kind /
    //         authorId / deviceId / createdAt invalidates the MAC.
    //
    //         Note: target_device_id is NOT part of the AAD (matching the
    //         crypto-spec.md §Envelope Encryption AAD shape). Receivers
    //         cross-check the AEAD-protected `from` field against the
    //         AAD-bound outer device id after decrypt.
    let aad = EnvelopeAad {
        v: 2,
        room_id: room_id.as_str().to_string(),
        envelope_id: envelope_id.clone(),
        kind: SIGNAL_KIND_WIRE.to_string(),
        author_id: id_to_string(author_id),
        device_id: id_to_string(device_id),
        created_at: created_at_ms,
    };

    // ---- 4. AEAD-seal under signalingKey with a fresh random 24-byte
    //         nonce. Production callers MUST NOT pin the nonce — the
    //         caller-supplied clientNonce only feeds EnvelopeId, never the
    //         AEAD nonce.
    let (aead_nonce, ciphertext) = aead::seal(signaling_key, &plaintext, &aad)?;

    let target = target_device_id.map(|d| EnvelopeTarget {
        device_id: d.clone(),
    });

    Ok(MailboxEnvelope {
        v: 2,
        room_id: room_id.clone(),
        envelope_id,
        server_seq: None,
        author_id: author_id.clone(),
        device_id: device_id.clone(),
        created_at: created_at_ms as u64,
        expires_at: expires_at_ms as u64,
        kind: EnvelopeKind::Signal,
        target,
        nonce: URL_SAFE_NO_PAD.encode(aead_nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(&ciphertext),
        ciphertext_bytes: ciphertext.len() as u64,
    })
}

/// Open a `kind: "signal"` envelope sealed by `assemble_signal_envelope`.
///
/// Reconstructs the AAD from the envelope's cleartext header, AEAD-opens
/// under `signaling_key`, and parses the recovered plaintext as a
/// [`SignalingPayload`].
///
/// Fails with [`EnvelopeError::Aead`] for any cryptographic mismatch (wrong
/// key, tampered ciphertext, AAD mutation including envelopeId rewrite) and
/// [`EnvelopeError::InvalidPlaintext`] if the bytes decrypted cleanly but did
/// not match the [`SignalingPayload`] shape (e.g. unknown `kind` tag).
pub fn disassemble_signal_envelope(
    envelope: &MailboxEnvelope,
    signaling_key: &[u8; 32],
) -> Result<SignalingPayload, EnvelopeError> {
    if envelope.kind != EnvelopeKind::Signal {
        return Err(EnvelopeError::InvalidPlaintext(format!(
            "expected kind=signal, got kind={:?}",
            envelope.kind
        )));
    }

    // Rebuild AAD from the cleartext envelope header — same shape the
    // assembler used, byte-for-byte.
    let aad = EnvelopeAad {
        v: envelope.v,
        room_id: envelope.room_id.as_str().to_string(),
        envelope_id: envelope.envelope_id.clone(),
        kind: SIGNAL_KIND_WIRE.to_string(),
        author_id: id_to_string(&envelope.author_id),
        device_id: id_to_string(&envelope.device_id),
        created_at: envelope.created_at as i64,
    };

    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(envelope.nonce.as_bytes())
        .map_err(|e| EnvelopeError::InvalidNonce(e.to_string()))?;
    let nonce: AeadNonce = nonce_bytes.as_slice().try_into().map_err(|_| {
        EnvelopeError::InvalidNonce(format!("expected 24 bytes, got {}", nonce_bytes.len()))
    })?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(envelope.ciphertext.as_bytes())
        .map_err(|e| EnvelopeError::InvalidCiphertext(e.to_string()))?;

    let plaintext = aead::open(signaling_key, &nonce, &ciphertext, &aad)?;

    serde_json::from_slice::<SignalingPayload>(&plaintext)
        .map_err(|e| EnvelopeError::InvalidPlaintext(e.to_string()))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wire string for `EnvelopeKind::Signal` — pinned as a constant so the AAD
/// reconstruction matches serde's `rename_all = "snake_case"` on
/// `model::EnvelopeKind` byte-for-byte. Mirrors `envelope::envelope_kind_wire`
/// and `inbound::envelope_kind_wire` (they all need to agree; the test
/// `aad_kind_wire_string_matches_serde` guards the drift).
const SIGNAL_KIND_WIRE: &str = "signal";

/// Round-trip a typed id newtype to its inner string via serde. Mirrors
/// `envelope::id_string` / `inbound::id_to_string` — kept private here so the
/// signaling module is a self-contained translation unit.
fn id_to_string<T: serde::Serialize>(id: &T) -> String {
    match serde_json::to_value(id).expect("typed id serializes as JSON string") {
        serde_json::Value::String(s) => s,
        other => panic!("typed id must serialize as JSON string, got {other:?}"),
    }
}

/// Bridge canonical-JSON errors into the shared `EnvelopeError` channel.
/// `EnvelopeError` already has a `From<CanonError>` impl, but the canonical
/// helper returns `CanonError` and we want a sharp call-site that the
/// compiler can't silently route through an unrelated `From`.
fn canon_to_envelope_err(e: CanonError) -> EnvelopeError {
    EnvelopeError::from(e)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;

    use crate::review::crypto::aead::AeadError;
    use crate::review::crypto::kdf::derive_room_keys;

    /// Pinned room secret — matches the value baked into the envelope.json
    /// corpus + envelope.rs tests so a stray cross-module divergence
    /// (different roomSecret → different signalingKey) is loud.
    const TEST_ROOM_SECRET: [u8; 32] = [0x11u8; 32];

    /// Construct a typed newtype id from a string through serde. Mirrors
    /// the helper used in `model.rs` / `envelope.rs` tests so signaling
    /// fixtures stay in lockstep.
    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("typed id deserializes")
    }

    /// Standard authoring identity used by every test fixture.
    fn fixture_ids() -> (RoomId, ParticipantId, DeviceId, DeviceId) {
        (
            id::<RoomId>("hjCfgOvsatNOUedgxhZpyw"),
            id::<ParticipantId>("p-author-01"),
            id::<DeviceId>("d-device-01"),
            id::<DeviceId>("d-device-target"),
        )
    }

    fn signaling_key() -> [u8; 32] {
        *derive_room_keys(&TEST_ROOM_SECRET).signaling_key.as_bytes()
    }

    const FIXED_TS_MS: i64 = 1_700_000_002_000;
    const EXPIRES_MS: i64 = FIXED_TS_MS + 7 * 24 * 60 * 60 * 1000;

    // -----------------------------------------------------------------
    // 1. Round-trip Offer: assemble → disassemble → equal.
    // -----------------------------------------------------------------

    #[test]
    fn round_trip_offer_targeted() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();
        let payload = SignalingPayload::Offer {
            sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n".to_string(),
            from: dev.clone(),
        };

        let envelope = assemble_signal_envelope(
            payload.clone(),
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x42u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .expect("assemble offer");

        // Targeted: envelope.target must be Some({deviceId: target}).
        assert_eq!(envelope.kind, EnvelopeKind::Signal);
        assert_eq!(
            envelope.target.as_ref().map(|t| &t.device_id),
            Some(&target),
            "targeted offer must populate envelope.target.deviceId"
        );

        let recovered = disassemble_signal_envelope(&envelope, &key).expect("disassemble offer");
        assert_eq!(recovered, payload);
    }

    // -----------------------------------------------------------------
    // 1b. Round-trip Collab — the live co-typing step-pipe. Broadcast
    //     (target=None, owner→all) and the opaque payload survives intact.
    // -----------------------------------------------------------------

    #[test]
    fn round_trip_collab_broadcast() {
        let (room, author, dev, _target) = fixture_ids();
        let key = signaling_key();
        // The daemon treats this as opaque; here it's a representative
        // CollabBroadcast JSON the owner's webview would emit.
        let payload = SignalingPayload::Collab {
            from: dev.clone(),
            payload: r#"{"kind":"broadcast","broadcast":{"startVersion":0,"steps":[{"stepType":"replace","from":1,"to":1,"slice":{"content":[{"type":"text","text":"X"}]}}],"clientIDs":["owner"]}}"#.to_string(),
        };

        let envelope = assemble_signal_envelope(
            payload.clone(),
            &key,
            &room,
            &author,
            &dev,
            None, // broadcast — every participant receives it
            &[0x77u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .expect("assemble collab broadcast");

        assert_eq!(envelope.kind, EnvelopeKind::Signal);
        assert!(
            envelope.target.is_none(),
            "broadcast collab must have no target"
        );

        let recovered = disassemble_signal_envelope(&envelope, &key).expect("disassemble collab");
        assert_eq!(
            recovered, payload,
            "collab payload must survive the round-trip byte-for-byte"
        );
    }

    // -----------------------------------------------------------------
    // 2. Round-trip Answer.
    // -----------------------------------------------------------------

    #[test]
    fn round_trip_answer() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();
        let payload = SignalingPayload::Answer {
            sdp: "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n".to_string(),
            from: dev.clone(),
        };

        let envelope = assemble_signal_envelope(
            payload.clone(),
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x43u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();

        let recovered = disassemble_signal_envelope(&envelope, &key).unwrap();
        assert_eq!(recovered, payload);
    }

    // -----------------------------------------------------------------
    // 3. Round-trip Ice with multiple candidates.
    // -----------------------------------------------------------------

    #[test]
    fn round_trip_ice_with_multiple_candidates() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();
        let payload = SignalingPayload::Ice {
            candidates: vec![
                "candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host".to_string(),
                "candidate:2 1 UDP 2122252543 192.0.2.2 54322 typ host".to_string(),
                "candidate:3 1 UDP 1686052607 198.51.100.7 53000 typ srflx raddr 192.0.2.1 rport 54321"
                    .to_string(),
            ],
            from: dev.clone(),
        };

        let envelope = assemble_signal_envelope(
            payload.clone(),
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x44u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();
        let recovered = disassemble_signal_envelope(&envelope, &key).unwrap();
        assert_eq!(recovered, payload);
    }

    // -----------------------------------------------------------------
    // 4. Round-trip RequestSnapshot (with + without sinceSnapshotId).
    // -----------------------------------------------------------------

    #[test]
    fn round_trip_request_snapshot_with_and_without_since() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();

        // With sinceSnapshotId — the resync-from-cursor case.
        let with_since = SignalingPayload::RequestSnapshot {
            file_id: id::<FileId>("f-file-01"),
            since_snapshot_id: Some(id::<SnapshotId>("eQ7pDCC-mekpz-we7gDYag")),
            from: dev.clone(),
        };
        let envelope = assemble_signal_envelope(
            with_since.clone(),
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x45u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();
        let recovered = disassemble_signal_envelope(&envelope, &key).unwrap();
        assert_eq!(recovered, with_since);

        // Without sinceSnapshotId — cold-start "send me the latest" case.
        // The None branch must round-trip through canonical-JSON (omit, not null).
        let without_since = SignalingPayload::RequestSnapshot {
            file_id: id::<FileId>("f-file-02"),
            since_snapshot_id: None,
            from: dev.clone(),
        };
        let envelope = assemble_signal_envelope(
            without_since.clone(),
            &key,
            &room,
            &author,
            &dev,
            None, // also test the broadcast path here
            &[0x46u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();
        assert!(
            envelope.target.is_none(),
            "broadcast request_snapshot must omit envelope.target"
        );
        let recovered = disassemble_signal_envelope(&envelope, &key).unwrap();
        assert_eq!(recovered, without_since);
    }

    // -----------------------------------------------------------------
    // 5. Wrong signalingKey → decrypt fails.
    //    Proves that a participant who lacks roomSecret (and therefore
    //    signalingKey) cannot recover SDP/ICE even if they can read the
    //    envelope off the wire.
    // -----------------------------------------------------------------

    #[test]
    fn wrong_signaling_key_fails_to_decrypt() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();
        let payload = SignalingPayload::Offer {
            sdp: "v=0\r\n".to_string(),
            from: dev.clone(),
        };
        let envelope = assemble_signal_envelope(
            payload,
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x47u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();

        let mut bad_key = key;
        bad_key[0] ^= 0xFF;

        let err = disassemble_signal_envelope(&envelope, &bad_key)
            .expect_err("wrong key must fail decrypt");
        assert!(
            matches!(err, EnvelopeError::Aead(AeadError::Decrypt)),
            "expected Aead(Decrypt) under wrong signalingKey, got {err:?}"
        );
    }

    // -----------------------------------------------------------------
    // 6. Tampered ciphertext → decrypt fails.
    //    Poly1305 catches a single-byte flip in the body even though the
    //    nonce, AAD, and key are all correct.
    // -----------------------------------------------------------------

    #[test]
    fn tampered_ciphertext_fails_to_decrypt() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();
        let payload = SignalingPayload::Answer {
            sdp: "v=0\r\n".to_string(),
            from: dev.clone(),
        };
        let mut envelope = assemble_signal_envelope(
            payload,
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x48u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();

        let mut bytes = URL_SAFE_NO_PAD
            .decode(envelope.ciphertext.as_bytes())
            .unwrap();
        // Flip a body byte well before the trailing 16-byte tag.
        bytes[0] ^= 0x01;
        envelope.ciphertext = URL_SAFE_NO_PAD.encode(&bytes);

        let err = disassemble_signal_envelope(&envelope, &key)
            .expect_err("tampered ciphertext must fail decrypt");
        assert!(
            matches!(err, EnvelopeError::Aead(AeadError::Decrypt)),
            "expected Aead(Decrypt) for tampered ciphertext, got {err:?}"
        );
    }

    // -----------------------------------------------------------------
    // 7. AAD envelopeId mutation → decrypt fails.
    //    Closes the AAD-binding loop for the signaling path: a relay
    //    cannot rewrite an envelope under a different envelopeId tag
    //    without invalidating the MAC.
    // -----------------------------------------------------------------

    #[test]
    fn aad_envelope_id_mutation_fails_to_decrypt() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();
        let payload = SignalingPayload::Offer {
            sdp: "v=0\r\n".to_string(),
            from: dev.clone(),
        };
        let mut envelope = assemble_signal_envelope(
            payload,
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x49u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();

        // Rewriting only the cleartext envelopeId leaves nonce/ciphertext
        // intact — but the reconstructed AAD will diverge from the sealed
        // AAD, so Poly1305 must reject.
        envelope.envelope_id = "AAAAAAAAAAAAAAAAAAAAAA".to_string();

        let err = disassemble_signal_envelope(&envelope, &key)
            .expect_err("envelopeId mutation must fail AAD-bound decrypt");
        assert!(
            matches!(err, EnvelopeError::Aead(AeadError::Decrypt)),
            "expected Aead(Decrypt) for envelopeId mutation, got {err:?}"
        );
    }

    // -----------------------------------------------------------------
    // 8. EnvelopeId determinism: same clientNonce → same envelopeId.
    //    This is the retry-safety guarantee: a sender that persists its
    //    clientNonce can retry the exact same logical signal step and the
    //    relay will dedup via envelopeId.
    // -----------------------------------------------------------------

    #[test]
    fn same_client_nonce_yields_same_envelope_id() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();
        let nonce = [0x55u8; 16];

        let payload = SignalingPayload::Ice {
            candidates: vec!["candidate:1 1 UDP 1 192.0.2.1 1 typ host".to_string()],
            from: dev.clone(),
        };

        let a = assemble_signal_envelope(
            payload.clone(),
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &nonce,
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();
        let b = assemble_signal_envelope(
            payload,
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &nonce,
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();

        assert_eq!(
            a.envelope_id, b.envelope_id,
            "same (room, device, clientNonce) must dedup at the relay"
        );
        // But the ciphertexts MUST still differ — fresh random AEAD nonce
        // per envelope, even for identical inputs. Reusing the AEAD nonce
        // under the same key would break XChaCha20-Poly1305.
        assert_ne!(
            a.ciphertext, b.ciphertext,
            "AEAD nonce must be fresh per envelope even when clientNonce is pinned"
        );
        assert_ne!(
            a.nonce, b.nonce,
            "envelope.nonce (AEAD nonce) must be fresh per call"
        );
    }

    // -----------------------------------------------------------------
    // 9. EnvelopeId determinism: different clientNonce → different envelopeId.
    //    Negative half of test 8 — proves the EnvelopeId actually depends
    //    on clientNonce (and not, e.g., on the AEAD nonce by accident).
    // -----------------------------------------------------------------

    #[test]
    fn different_client_nonce_yields_different_envelope_id() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();

        let payload = SignalingPayload::Offer {
            sdp: "v=0\r\n".to_string(),
            from: dev.clone(),
        };

        let a = assemble_signal_envelope(
            payload.clone(),
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x11u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();
        let b = assemble_signal_envelope(
            payload,
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0x22u8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();

        assert_ne!(
            a.envelope_id, b.envelope_id,
            "different clientNonce must produce different EnvelopeIds"
        );
    }

    // -----------------------------------------------------------------
    // 10. Drift guard: the SIGNAL_KIND_WIRE constant used to rebuild AAD
    //     must match what serde emits for `EnvelopeKind::Signal`. A stray
    //     rename in the model module would otherwise silently break decrypt
    //     in production — this test makes that loud at compile/test time.
    // -----------------------------------------------------------------

    #[test]
    fn aad_kind_wire_string_matches_serde() {
        let via_serde = serde_json::to_value(EnvelopeKind::Signal).unwrap();
        let via_local = Value::String(SIGNAL_KIND_WIRE.to_string());
        assert_eq!(
            via_serde, via_local,
            "SIGNAL_KIND_WIRE diverges from serde's encoding of EnvelopeKind::Signal — AAD reconstruction would fail"
        );
    }

    // -----------------------------------------------------------------
    // 11. Cross-shape rejection: handing a non-signal envelope to the
    //     signal disassembler must reject (InvalidPlaintext with the
    //     observed kind) rather than try-and-fail at AEAD.
    // -----------------------------------------------------------------

    #[test]
    fn disassemble_rejects_non_signal_envelope_kind() {
        let (room, author, dev, target) = fixture_ids();
        let key = signaling_key();
        let payload = SignalingPayload::Offer {
            sdp: "v=0\r\n".to_string(),
            from: dev.clone(),
        };
        let mut envelope = assemble_signal_envelope(
            payload,
            &key,
            &room,
            &author,
            &dev,
            Some(&target),
            &[0xAAu8; 16],
            FIXED_TS_MS,
            EXPIRES_MS,
        )
        .unwrap();

        // Pretend somebody handed us an event-kind envelope. The
        // disassembler should reject upfront on kind, not try AEAD-open
        // (the AAD's `kind` field would diverge anyway, but the explicit
        // kind check gives a much sharper diagnostic).
        envelope.kind = EnvelopeKind::Event;
        let err =
            disassemble_signal_envelope(&envelope, &key).expect_err("non-signal kind must reject");
        match err {
            EnvelopeError::InvalidPlaintext(msg) => {
                assert!(
                    msg.contains("kind=Event"),
                    "expected kind diagnostic in message, got {msg:?}"
                );
            }
            other => panic!("expected InvalidPlaintext, got {other:?}"),
        }
    }
}
