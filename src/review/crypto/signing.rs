//! Ed25519 signing + verification, plus `signingKeyId` helpers.
//!
//! See `planning/collab/crypto-spec.md` §Signatures + §Canonical Bytes for
//! Signature + §Signing-Key Publication.
//!
//! Wire contract enforced here:
//! - `signedBytes` is `canonicalJSON({ meta: <EventMeta WITHOUT eventId>, body })`.
//!   `eventId` is OMITTED before signing because it is itself derived from these
//!   same bytes (chicken/egg with `attn-nnj.1.8` / `EventId`).
//! - `parentEventIds` is sorted ASCII-ascending before serialization so the
//!   signature is invariant under reordering.
//! - `auth` is NEVER part of the signed bytes (it carries the signature).
//! - `signingKeyId` = `base64url(SHA-256(publicSigningKey))` (no-pad).
//!
//! Ed25519 signing per RFC 8032 is fully deterministic, so a given
//! (signingKey, meta, body) triple yields a fixed signature byte-for-byte.
//! This is what makes the cross-implementation corpus in
//! `planning/collab/test-vectors/event-signature.json` meaningful.

#![allow(dead_code)]

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::review::crypto::canonical::{CanonError, to_canonical_bytes};
use crate::review::ids::{DeviceId, EventId, ParticipantId, RoomId, SnapshotId};
use crate::review::model::{EventAuth, EventMeta, ReviewEventBody};

/// Errors returned by the signing/verification helpers.
#[derive(Debug)]
pub enum SignError {
    /// `ed25519-dalek` rejected a key, signature, or verification attempt.
    /// The inner string is the upstream display (which intentionally avoids
    /// leaking key material).
    Ed25519(String),
    /// Canonical JSON serialization failed while preparing the signed bytes.
    Canonical(CanonError),
    /// `getrandom` failed while drawing entropy for keypair generation.
    Random(String),
    /// The `signingKeyId` in an `EventAuth` did not equal
    /// `base64url(SHA-256(publicSigningKey))` of the supplied verifying key.
    /// Catches key-rotation / key-swap attempts (crypto-spec.md §Signatures
    /// step 2).
    SigningKeyIdMismatch { expected: String, actual: String },
    /// The supplied base64url string did not decode to the expected length.
    InvalidSignatureEncoding(String),
}

impl fmt::Display for SignError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ed25519(msg) => write!(f, "ed25519: {msg}"),
            Self::Canonical(e) => write!(f, "canonical JSON: {e}"),
            Self::Random(msg) => write!(f, "rng: {msg}"),
            Self::SigningKeyIdMismatch { expected, actual } => write!(
                f,
                "signingKeyId mismatch: expected {expected}, got {actual}"
            ),
            Self::InvalidSignatureEncoding(msg) => write!(f, "invalid signature encoding: {msg}"),
        }
    }
}

impl std::error::Error for SignError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Canonical(e) => Some(e),
            _ => None,
        }
    }
}

impl From<CanonError> for SignError {
    fn from(e: CanonError) -> Self {
        Self::Canonical(e)
    }
}

// ---------------------------------------------------------------------------
// Key wrappers
// ---------------------------------------------------------------------------

/// Ed25519 signing key owned by one device. Wraps `ed25519_dalek::SigningKey`
/// so callers don't depend on the upstream type directly — that lets us swap
/// crates (or fold in zeroization) later without a wide refactor.
pub struct DeviceSigningKey(SigningKey);

impl DeviceSigningKey {
    /// Generate a fresh signing key from OS entropy.
    pub fn generate() -> Result<Self, SignError> {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).map_err(|e| SignError::Random(e.to_string()))?;
        Ok(Self(SigningKey::from_bytes(&seed)))
    }

    /// Construct from a 32-byte Ed25519 seed (the canonical private form
    /// used in the test-vector corpus and on disk).
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self, SignError> {
        Ok(Self(SigningKey::from_bytes(bytes)))
    }

    /// Return the 32-byte seed. Callers persist this (encrypted) in the
    /// device identity file.
    pub fn to_bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    /// Derive the matching verifying key.
    pub fn verifying_key(&self) -> DeviceVerifyingKey {
        DeviceVerifyingKey(self.0.verifying_key())
    }

    /// Sign already-domain-separated canonical protocol bytes.
    pub fn sign_protocol_bytes(&self, bytes: &[u8]) -> [u8; 64] {
        self.0.sign(bytes).to_bytes()
    }
}

impl fmt::Debug for DeviceSigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never expose the secret seed via Debug.
        f.debug_struct("DeviceSigningKey").finish_non_exhaustive()
    }
}

/// Ed25519 verifying key for one device. Cheap to clone.
#[derive(Clone)]
pub struct DeviceVerifyingKey(VerifyingKey);

impl DeviceVerifyingKey {
    /// Construct from a 32-byte compressed Edwards-y encoding. Rejects
    /// non-canonical encodings via `ed25519-dalek`'s validation.
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self, SignError> {
        VerifyingKey::from_bytes(bytes)
            .map(Self)
            .map_err(|e| SignError::Ed25519(e.to_string()))
    }

    /// Return the 32-byte compressed Edwards-y encoding.
    pub fn to_bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    /// Verify already-domain-separated canonical protocol bytes.
    pub fn verify_protocol_bytes(
        &self,
        bytes: &[u8],
        signature: &[u8; 64],
    ) -> Result<(), SignError> {
        self.0
            .verify(bytes, &Signature::from_bytes(signature))
            .map_err(|error| SignError::Ed25519(error.to_string()))
    }

    /// `signingKeyId` per crypto-spec.md §Signatures —
    /// `base64url(SHA-256(publicSigningKey))`, no padding.
    pub fn signing_key_id_base64url(&self) -> String {
        let digest = Sha256::digest(self.0.as_bytes());
        URL_SAFE_NO_PAD.encode(digest)
    }
}

impl fmt::Debug for DeviceVerifyingKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Public keys are not secret, but printing the keyId is more useful.
        f.debug_tuple("DeviceVerifyingKey")
            .field(&self.signing_key_id_base64url())
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Canonical signed bytes
// ---------------------------------------------------------------------------

/// Intermediate shape used to compute `signedBytes`. Mirrors `EventMeta` but
/// drops `eventId` (omitted from signed bytes) and sorts `parentEventIds`.
///
/// All other fields preserve `EventMeta`'s on-wire camelCase encoding so the
/// canonical-JSON output matches what a JS/WASM verifier would produce by
/// stripping `eventId` from the same EventMeta.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignableMeta<'a> {
    v: u32,
    room_id: &'a RoomId,
    author_id: &'a ParticipantId,
    device_id: &'a DeviceId,
    created_at: u64,
    /// Always emitted (possibly as `[]`) — `parentEventIds` is structural; an
    /// empty list and an absent field are NOT the same in this protocol.
    parent_event_ids: Vec<EventId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot_id: Option<&'a SnapshotId>,
}

#[derive(Serialize)]
struct SignableEvent<'a> {
    body: &'a ReviewEventBody,
    meta: SignableMeta<'a>,
    // NOTE: key order in this struct does NOT influence the canonical
    // output — `to_canonical_bytes` re-sorts every object's keys ASCII-
    // ascending. We list `body` first here just to mirror the on-wire
    // ordering humans see in `crypto-spec.md`; the canonicalizer will
    // emit `{"body":...,"meta":...}` because 'b' < 'm'.
}

/// Build the canonical signed bytes per crypto-spec.md §Canonical Bytes for
/// Signature:
///   `canonicalJSON({ meta: <EventMeta minus eventId>, body })`
///
/// Useful on its own for test vectors and cross-implementation debugging
/// (you can diff the bytes before getting to the signature step).
///
/// Note: `parentEventIds` is sorted ASCII-ascending before serialization, so
/// reordering the parents at the caller does not change the signed bytes.
pub fn canonical_signed_bytes(
    meta: &EventMeta,
    body: &ReviewEventBody,
) -> Result<Vec<u8>, SignError> {
    let mut parents = meta.parent_event_ids.clone();
    // EventIds are base64url strings; byte-order == ASCII-ascending order.
    parents.sort_by_key(sort_key);

    let signable = SignableEvent {
        body,
        meta: SignableMeta {
            v: meta.v,
            room_id: &meta.room_id,
            author_id: &meta.author_id,
            device_id: &meta.device_id,
            created_at: meta.created_at,
            parent_event_ids: parents,
            snapshot_id: meta.snapshot_id.as_ref(),
        },
    };

    Ok(to_canonical_bytes(&signable)?)
}

/// `EventId` is a newtype around `String`; to sort by inner bytes we need
/// access. Going through the serialized form is overkill — `EventId`
/// implements `Serialize` transparently, but the simplest path is to
/// canonicalize via JSON. Cheap and entirely string-driven.
fn sort_key(id: &EventId) -> Vec<u8> {
    // EventId serializes as a JSON string (`"..."`). Strip the quotes for
    // a stable bytewise comparison key. This avoids reaching into the
    // newtype's private field (which `ids.rs` deliberately doesn't expose).
    let json = serde_json::to_string(id).expect("EventId serializes as JSON string");
    // Trim leading/trailing quote chars produced by serde_json::to_string.
    json.trim_matches('"').as_bytes().to_vec()
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/// Sign a `(meta, body)` pair, returning the `EventAuth` (signature +
/// signingKeyId) the caller embeds on the event.
///
/// Implementation: build canonical signed bytes (with `eventId` omitted,
/// `parentEventIds` sorted), call `ed25519-dalek` (which uses RFC 8032
/// deterministic signing), base64url-no-pad encode both halves.
pub fn sign_event(
    key: &DeviceSigningKey,
    meta: &EventMeta,
    body: &ReviewEventBody,
) -> Result<EventAuth, SignError> {
    let bytes = canonical_signed_bytes(meta, body)?;
    let signature = key.0.sign(&bytes);
    Ok(EventAuth {
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        signing_key_id: key.verifying_key().signing_key_id_base64url(),
    })
}

/// Verify an event's signature against a verifying key.
///
/// Rejects if:
/// - `auth.signingKeyId` != `base64url(SHA-256(verifyingKey))` (key swap), OR
/// - the signature isn't valid base64url-no-pad of 64 bytes, OR
/// - the signature doesn't verify against `canonical_signed_bytes(meta, body)`.
pub fn verify_event(
    key: &DeviceVerifyingKey,
    meta: &EventMeta,
    body: &ReviewEventBody,
    auth: &EventAuth,
) -> Result<(), SignError> {
    // 1. signingKeyId binding (crypto-spec.md §Signatures step 2).
    let expected = key.signing_key_id_base64url();
    if auth.signing_key_id != expected {
        return Err(SignError::SigningKeyIdMismatch {
            expected,
            actual: auth.signing_key_id.clone(),
        });
    }

    // 2. Decode signature bytes.
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(&auth.signature)
        .map_err(|e| SignError::InvalidSignatureEncoding(e.to_string()))?;
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| {
        SignError::InvalidSignatureEncoding(format!("expected 64 bytes, got {}", sig_bytes.len()))
    })?;
    let signature = Signature::from_bytes(&sig_arr);

    // 3. Recompute canonical bytes + verify.
    let bytes = canonical_signed_bytes(meta, body)?;
    key.0
        .verify(&bytes, &signature)
        .map_err(|e| SignError::Ed25519(e.to_string()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use serde::Deserialize;
    use serde_json::Value;

    use crate::review::ids::{
        ContentHash, DeviceId, EventId, FileId, ParticipantId, RoomId, SnapshotId,
    };
    use crate::review::model::{Anchor, EventMeta, PositionAnchor, ReviewEventBody};

    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("id deserializes")
    }

    fn sample_meta() -> EventMeta {
        EventMeta {
            v: 2,
            event_id: id::<EventId>("evt-1"),
            room_id: id::<RoomId>("room-abc"),
            author_id: id::<ParticipantId>("p-1"),
            device_id: id::<DeviceId>("d-1"),
            created_at: 1_700_000_000_001,
            parent_event_ids: vec![],
            snapshot_id: None,
        }
    }

    fn sample_anchor() -> Anchor {
        Anchor {
            v: 2,
            file_id: id::<FileId>("file-1"),
            snapshot_id: id::<SnapshotId>("snap-1"),
            base_hash: id::<ContentHash>("hash-1"),
            position: PositionAnchor {
                byte_range: [0, 5],
                line_range: [1, 1],
                pm_range: None,
            },
            quote: None,
            block: None,
            context: None,
            structure: None,
            html: None,
        }
    }

    fn sample_body() -> ReviewEventBody {
        ReviewEventBody::CommentCreated {
            thread_id: "thr-1".to_string(),
            anchor: sample_anchor(),
            body: "hello".to_string(),
        }
    }

    /// Fixed 32-byte seed used by deterministic tests. Picked so the first
    /// byte is non-zero (sanity check for `from_bytes` round-trip).
    const FIXED_SEED: [u8; 32] = [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ];

    // ---- round-trip ------------------------------------------------------

    #[test]
    fn sign_then_verify_round_trip() {
        let sk = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let vk = sk.verifying_key();
        let meta = sample_meta();
        let body = sample_body();

        let auth = sign_event(&sk, &meta, &body).unwrap();
        verify_event(&vk, &meta, &body, &auth).expect("round-trip verify");
    }

    #[test]
    fn wrong_verifying_key_rejects() {
        let sk1 = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let other_seed = [0x11u8; 32];
        let sk2 = DeviceSigningKey::from_bytes(&other_seed).unwrap();
        let vk2 = sk2.verifying_key();

        let meta = sample_meta();
        let body = sample_body();
        let auth = sign_event(&sk1, &meta, &body).unwrap();

        // signingKeyId mismatch fires BEFORE we even reach the ed25519 verify,
        // because the auth carries sk1's keyId while we hand sk2's verifying key.
        let err = verify_event(&vk2, &meta, &body, &auth).unwrap_err();
        assert!(matches!(err, SignError::SigningKeyIdMismatch { .. }));
    }

    #[test]
    fn tampered_body_rejects() {
        let sk = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let vk = sk.verifying_key();
        let meta = sample_meta();
        let body = sample_body();
        let auth = sign_event(&sk, &meta, &body).unwrap();

        // Flip a character in the comment body — same shape, different bytes.
        let tampered = ReviewEventBody::CommentCreated {
            thread_id: "thr-1".to_string(),
            anchor: sample_anchor(),
            body: "hello!".to_string(),
        };
        let err = verify_event(&vk, &meta, &tampered, &auth).unwrap_err();
        assert!(matches!(err, SignError::Ed25519(_)), "got {err:?}");
    }

    #[test]
    fn tampered_meta_createdat_rejects() {
        let sk = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let vk = sk.verifying_key();
        let meta = sample_meta();
        let body = sample_body();
        let auth = sign_event(&sk, &meta, &body).unwrap();

        let mut bad_meta = meta.clone();
        bad_meta.created_at += 1;
        let err = verify_event(&vk, &bad_meta, &body, &auth).unwrap_err();
        assert!(matches!(err, SignError::Ed25519(_)), "got {err:?}");
    }

    #[test]
    fn tampered_signing_key_id_rejects() {
        let sk = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let vk = sk.verifying_key();
        let meta = sample_meta();
        let body = sample_body();
        let mut auth = sign_event(&sk, &meta, &body).unwrap();

        // Swap the keyId for another device's. Verify must reject without
        // even looking at the signature.
        auth.signing_key_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
        let err = verify_event(&vk, &meta, &body, &auth).unwrap_err();
        match err {
            SignError::SigningKeyIdMismatch { expected, actual } => {
                assert_eq!(expected, vk.signing_key_id_base64url());
                assert_eq!(actual, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            }
            other => panic!("expected SigningKeyIdMismatch, got {other:?}"),
        }
    }

    #[test]
    fn parent_event_ids_reordering_preserves_signature() {
        let sk = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let vk = sk.verifying_key();

        let mut meta_a = sample_meta();
        meta_a.parent_event_ids = vec![
            id::<EventId>("aaa"),
            id::<EventId>("bbb"),
            id::<EventId>("ccc"),
        ];
        let mut meta_b = sample_meta();
        meta_b.parent_event_ids = vec![
            id::<EventId>("ccc"),
            id::<EventId>("aaa"),
            id::<EventId>("bbb"),
        ];

        let body = sample_body();

        // Signed bytes are identical regardless of caller-side ordering.
        let bytes_a = canonical_signed_bytes(&meta_a, &body).unwrap();
        let bytes_b = canonical_signed_bytes(&meta_b, &body).unwrap();
        assert_eq!(
            bytes_a, bytes_b,
            "parentEventIds must be sorted before signing"
        );

        // And the signature on meta_a verifies against meta_b (since the
        // signed bytes are the same).
        let auth = sign_event(&sk, &meta_a, &body).unwrap();
        verify_event(&vk, &meta_b, &body, &auth)
            .expect("signature should verify regardless of parent order");
    }

    #[test]
    fn event_id_is_excluded_from_signed_bytes() {
        let sk = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let vk = sk.verifying_key();

        let mut meta_a = sample_meta();
        let mut meta_b = sample_meta();
        // Same key material, same everything except the (cosmetic, in this
        // context) eventId.
        meta_a.event_id = id::<EventId>("anything-1");
        meta_b.event_id = id::<EventId>("totally-different-id");

        let body = sample_body();

        let bytes_a = canonical_signed_bytes(&meta_a, &body).unwrap();
        let bytes_b = canonical_signed_bytes(&meta_b, &body).unwrap();
        assert_eq!(
            bytes_a, bytes_b,
            "eventId must be omitted from signed bytes (chicken/egg with EventId derivation)"
        );

        let auth = sign_event(&sk, &meta_a, &body).unwrap();
        // The signature should verify against meta_b too, because eventId is
        // not in the signed bytes.
        verify_event(&vk, &meta_b, &body, &auth).expect("eventId is not signed material");
    }

    #[test]
    fn signed_bytes_do_not_contain_event_id_or_auth_keys() {
        // Defense in depth: the canonical bytes must not contain the
        // `eventId`/`auth` keys under any circumstances.
        let meta = sample_meta();
        let body = sample_body();
        let bytes = canonical_signed_bytes(&meta, &body).unwrap();
        let s = std::str::from_utf8(&bytes).expect("utf8");
        assert!(!s.contains("\"eventId\""), "signed bytes leak eventId: {s}");
        assert!(!s.contains("\"auth\""), "signed bytes leak auth: {s}");
    }

    #[test]
    fn signing_key_id_matches_base64url_sha256_of_pubkey() {
        let sk = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let vk = sk.verifying_key();

        let pubkey = vk.to_bytes();
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(pubkey));
        assert_eq!(vk.signing_key_id_base64url(), expected);

        // And it round-trips through from_bytes.
        let vk2 = DeviceVerifyingKey::from_bytes(&pubkey).unwrap();
        assert_eq!(vk2.signing_key_id_base64url(), expected);
    }

    #[test]
    fn generate_produces_distinct_keys() {
        let a = DeviceSigningKey::generate().unwrap();
        let b = DeviceSigningKey::generate().unwrap();
        assert_ne!(
            a.to_bytes(),
            b.to_bytes(),
            "generate must use fresh entropy"
        );
    }

    #[test]
    fn deterministic_signing_same_inputs_same_signature() {
        // RFC 8032 makes Ed25519 deterministic — sign twice, get the same
        // bytes. This is what the cross-impl corpus relies on.
        let sk = DeviceSigningKey::from_bytes(&FIXED_SEED).unwrap();
        let meta = sample_meta();
        let body = sample_body();
        let a = sign_event(&sk, &meta, &body).unwrap();
        let b = sign_event(&sk, &meta, &body).unwrap();
        assert_eq!(a.signature, b.signature);
        assert_eq!(a.signing_key_id, b.signing_key_id);
    }

    // ---- corpus generator (run with --nocapture to refresh vectors) -----

    /// Prints the canonical signed bytes, signature, signing key id, and
    /// public key for the two vectors we want in the corpus. Run with:
    ///   cargo test review::crypto::signing::tests::print_corpus_vectors -- --nocapture --ignored
    /// then paste the values into `planning/collab/test-vectors/event-signature.json`.
    /// Kept #[ignore] so it doesn't run in the normal test pass.
    #[test]
    #[ignore]
    fn print_corpus_vectors() {
        // RFC 8032 test-vector seed #1 — well-known, lets reviewers cross-check
        // the (private, public) derivation against the RFC.
        let seed1: [u8; 32] = [
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec,
            0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03,
            0x1c, 0xae, 0x7f, 0x60,
        ];
        // Distinct seed — first byte differs so the derived public key is
        // visibly different.
        let seed2: [u8; 32] = [
            0x4c, 0xcd, 0x08, 0x9b, 0x28, 0xff, 0x96, 0xda, 0x9d, 0xb6, 0xc3, 0x46, 0xec, 0x11,
            0x4e, 0x0f, 0x5b, 0x8a, 0x31, 0x9f, 0x35, 0xab, 0xa6, 0x24, 0xda, 0x8c, 0xf6, 0xed,
            0x4f, 0xb8, 0xa6, 0xfb,
        ];

        // Vector 1: minimal CommentCreated, no parents, no snapshot.
        let meta1 = EventMeta {
            v: 2,
            event_id: id::<EventId>("placeholder-event-id-1"),
            room_id: id::<RoomId>("room-vec-1"),
            author_id: id::<ParticipantId>("p-vec-1"),
            device_id: id::<DeviceId>("d-vec-1"),
            created_at: 1_700_000_000_000,
            parent_event_ids: vec![],
            snapshot_id: None,
        };
        let body1 = ReviewEventBody::CommentCreated {
            thread_id: "thr-vec-1".to_string(),
            anchor: Anchor {
                v: 2,
                file_id: id::<FileId>("file-vec-1"),
                snapshot_id: id::<SnapshotId>("snap-vec-1"),
                base_hash: id::<ContentHash>("hash-vec-1"),
                position: PositionAnchor {
                    byte_range: [0, 5],
                    line_range: [1, 1],
                    pm_range: None,
                },
                quote: None,
                block: None,
                context: None,
                structure: None,
                html: None,
            },
            body: "hello".to_string(),
        };

        // Vector 2: SuggestionCreated with a snapshot, two parents listed
        // OUT OF ORDER so the corpus exercises the sort-before-signing rule.
        let meta2 = EventMeta {
            v: 2,
            event_id: id::<EventId>("placeholder-event-id-2"),
            room_id: id::<RoomId>("room-vec-2"),
            author_id: id::<ParticipantId>("p-vec-2"),
            device_id: id::<DeviceId>("d-vec-2"),
            created_at: 1_700_000_001_500,
            // Intentionally not pre-sorted ("z" before "a"); canonical_signed_bytes sorts.
            parent_event_ids: vec![id::<EventId>("evt-zzz"), id::<EventId>("evt-aaa")],
            snapshot_id: Some(id::<SnapshotId>("snap-vec-2")),
        };
        let body2 = ReviewEventBody::SuggestionCreated {
            suggestion_id: "sug-vec-2".to_string(),
            anchor: Anchor {
                v: 2,
                file_id: id::<FileId>("file-vec-2"),
                snapshot_id: id::<SnapshotId>("snap-vec-2"),
                base_hash: id::<ContentHash>("hash-vec-2"),
                position: PositionAnchor {
                    byte_range: [10, 14],
                    line_range: [3, 3],
                    pm_range: None,
                },
                quote: None,
                block: None,
                context: None,
                structure: None,
                html: None,
            },
            operation: crate::review::model::SuggestionOperation::Replace {
                expected_text: "foo".to_string(),
                replacement: "bar".to_string(),
            },
            note: Some("typo".to_string()),
        };

        // Vector 3: CommentResolved — exercises the resolved-by tagged variant.
        let seed3: [u8; 32] = [0x33u8; 32];
        let meta3 = EventMeta {
            v: 2,
            event_id: id::<EventId>("placeholder-event-id-3"),
            room_id: id::<RoomId>("room-vec-3"),
            author_id: id::<ParticipantId>("p-vec-3"),
            device_id: id::<DeviceId>("d-vec-3"),
            created_at: 1_700_000_002_000,
            parent_event_ids: vec![id::<EventId>("evt-parent-3")],
            snapshot_id: None,
        };
        let body3 = ReviewEventBody::CommentResolved {
            thread_id: "thr-vec-3".to_string(),
            resolved_by: id::<ParticipantId>("p-resolver-3"),
        };

        // Vector 4: PresenceUpdated (signal body shape) — exercises a body
        // with `online:true`, no anchor, no thread, optional cursor omitted.
        let seed4: [u8; 32] = [0x44u8; 32];
        let meta4 = EventMeta {
            v: 2,
            event_id: id::<EventId>("placeholder-event-id-4"),
            room_id: id::<RoomId>("room-vec-4"),
            author_id: id::<ParticipantId>("p-vec-4"),
            device_id: id::<DeviceId>("d-vec-4"),
            created_at: 1_700_000_003_000,
            parent_event_ids: vec![],
            snapshot_id: None,
        };
        let body4 = ReviewEventBody::PresenceUpdated {
            participant_id: id::<ParticipantId>("p-vec-4"),
            device_id: id::<DeviceId>("d-vec-4"),
            online: true,
            cursor: None,
        };

        // Vector 5: SuggestionAccepted — exercises content-hash field types
        // and the applied-revision string. Distinct body shape from v2.
        let seed5: [u8; 32] = [0x55u8; 32];
        let meta5 = EventMeta {
            v: 2,
            event_id: id::<EventId>("placeholder-event-id-5"),
            room_id: id::<RoomId>("room-vec-5"),
            author_id: id::<ParticipantId>("p-vec-5"),
            device_id: id::<DeviceId>("d-vec-5"),
            created_at: 1_700_000_004_500,
            parent_event_ids: vec![
                id::<EventId>("evt-mid-5"),
                id::<EventId>("evt-aaa-5"),
                id::<EventId>("evt-zzz-5"),
            ],
            snapshot_id: Some(id::<SnapshotId>("snap-vec-5")),
        };
        let body5 = ReviewEventBody::SuggestionAccepted {
            suggestion_id: "sug-vec-5".to_string(),
            applied_revision_id: "rev-vec-5".to_string(),
            resulting_hash: id::<ContentHash>("hash-after-apply-5"),
        };

        // Vector 6: CommentReopened — the resolve inverse (attn-bb6t.4).
        // Pinned alongside vector 3 so both halves of the resolve/reopen pair
        // have a locked canonical shape for the TS implementation.
        let seed6: [u8; 32] = [0x66u8; 32];
        let meta6 = EventMeta {
            v: 2,
            event_id: id::<EventId>("placeholder-event-id-6"),
            room_id: id::<RoomId>("room-vec-6"),
            author_id: id::<ParticipantId>("p-vec-6"),
            device_id: id::<DeviceId>("d-vec-6"),
            created_at: 1_700_000_005_000,
            parent_event_ids: vec![id::<EventId>("evt-parent-6")],
            snapshot_id: None,
        };
        let body6 = ReviewEventBody::CommentReopened {
            thread_id: "thr-vec-6".to_string(),
            reopened_by: id::<ParticipantId>("p-reopener-6"),
        };

        for (label, seed, meta, body) in [
            ("vec1", seed1, &meta1, &body1),
            ("vec2", seed2, &meta2, &body2),
            ("vec3", seed3, &meta3, &body3),
            ("vec4", seed4, &meta4, &body4),
            ("vec5", seed5, &meta5, &body5),
            ("vec6", seed6, &meta6, &body6),
        ] {
            let sk = DeviceSigningKey::from_bytes(&seed).unwrap();
            let vk = sk.verifying_key();
            let signed = canonical_signed_bytes(meta, body).unwrap();
            let auth = sign_event(&sk, meta, body).unwrap();
            eprintln!("=== {label} ===");
            eprintln!("private:    {}", URL_SAFE_NO_PAD.encode(seed));
            eprintln!("public:     {}", URL_SAFE_NO_PAD.encode(vk.to_bytes()));
            eprintln!("signingKeyId: {}", vk.signing_key_id_base64url());
            eprintln!(
                "canonicalSignedBytes: {}",
                std::str::from_utf8(&signed).unwrap()
            );
            eprintln!("signature:  {}", auth.signature);
            // Pretty-print the meta+body shape that goes into the JSON.
            let event_json = serde_json::to_string(&serde_json::json!({
                "meta": meta,
                "body": body,
            }))
            .unwrap();
            eprintln!("eventJson:  {event_json}");
            eprintln!();
        }
    }

    // ---- cross-implementation corpus replay -----------------------------

    /// Compile-time-embedded corpus shared with the (future) TS/WASM client.
    /// See `planning/collab/test-vectors/event-signature.json` for the schema.
    const CORPUS: &str = include_str!("../../../planning/collab/test-vectors/event-signature.json");

    #[derive(Deserialize)]
    struct CorpusFile {
        #[allow(dead_code)]
        version: u32,
        vectors: Vec<CorpusVector>,
    }

    #[derive(Deserialize)]
    struct CorpusVector {
        name: String,
        #[serde(rename = "signingKey")]
        signing_key: CorpusKey,
        event: CorpusEvent,
        expected: CorpusExpected,
    }

    #[derive(Deserialize)]
    struct CorpusKey {
        private: String,
        public: String,
    }

    #[derive(Deserialize)]
    struct CorpusEvent {
        meta: EventMeta,
        body: ReviewEventBody,
    }

    #[derive(Deserialize)]
    struct CorpusExpected {
        #[serde(rename = "canonicalSignedBytes")]
        canonical_signed_bytes: String,
        signature: String,
        #[serde(rename = "signingKeyId")]
        signing_key_id: String,
    }

    fn decode_seed(s: &str) -> [u8; 32] {
        let v = URL_SAFE_NO_PAD.decode(s).expect("seed decodes");
        v.as_slice().try_into().expect("seed is 32 bytes")
    }

    fn decode_pubkey(s: &str) -> [u8; 32] {
        let v = URL_SAFE_NO_PAD.decode(s).expect("pubkey decodes");
        v.as_slice().try_into().expect("pubkey is 32 bytes")
    }

    #[test]
    fn test_vector_corpus_round_trip() {
        let corpus: CorpusFile = serde_json::from_str(CORPUS).expect("corpus parses");
        assert!(
            corpus.vectors.len() >= 2,
            "expected >= 2 corpus vectors, got {}",
            corpus.vectors.len()
        );

        for v in &corpus.vectors {
            let seed = decode_seed(&v.signing_key.private);
            let sk = DeviceSigningKey::from_bytes(&seed).expect("seed -> sk");
            let vk = sk.verifying_key();

            // Public key in the vector must match the one derived from the
            // private seed. Locks the public-from-private derivation.
            assert_eq!(
                vk.to_bytes(),
                decode_pubkey(&v.signing_key.public),
                "[{}] vector public key does not match derivation from private seed",
                v.name
            );

            // signingKeyId matches the vector.
            assert_eq!(
                vk.signing_key_id_base64url(),
                v.expected.signing_key_id,
                "[{}] signingKeyId mismatch",
                v.name
            );

            // Canonical signed bytes match (UTF-8 string in the vector).
            let signed =
                canonical_signed_bytes(&v.event.meta, &v.event.body).expect("canonical bytes");
            assert_eq!(
                std::str::from_utf8(&signed).expect("utf8"),
                v.expected.canonical_signed_bytes,
                "[{}] canonical signed bytes mismatch",
                v.name
            );

            // Signature matches the vector (deterministic Ed25519).
            let auth = sign_event(&sk, &v.event.meta, &v.event.body).expect("sign");
            assert_eq!(
                auth.signature, v.expected.signature,
                "[{}] signature mismatch",
                v.name
            );
            assert_eq!(
                auth.signing_key_id, v.expected.signing_key_id,
                "[{}] auth.signingKeyId mismatch",
                v.name
            );

            // And the auth verifies (closes the loop).
            verify_event(&vk, &v.event.meta, &v.event.body, &auth)
                .unwrap_or_else(|e| panic!("[{}] verify failed: {e}", v.name));
        }
    }
}
