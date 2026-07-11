//! Deterministic ID derivation per `planning/collab/crypto-spec.md` §ID
//! Construction.
//!
//! Where possible IDs are content-addressed so retries and dedup work without
//! persisting random nonces.
//!
//! This module owns the *derivation* functions only; the typed newtypes they
//! return live in `crate::review::ids`. Don't confuse this with that module
//! — same name, different layer.

#![allow(dead_code)]

use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::review::crypto::canonical::{CanonError, to_canonical_bytes};
use crate::review::ids::{ContentHash, EventId, FileId, RoomId, SnapshotId};
use crate::review::model::{EventMeta, ReviewEventBody};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors returned by the ID-derivation helpers.
#[derive(Debug)]
pub enum IdError {
    /// Canonical-JSON encoding of an event payload failed. The inner string
    /// is the underlying `CanonError`'s `Display` form so callers don't have
    /// to depend on `crypto::canonical::CanonError` directly.
    Canonical(String),
}

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Canonical(msg) => write!(f, "canonical JSON: {msg}"),
        }
    }
}

impl std::error::Error for IdError {}

impl From<CanonError> for IdError {
    fn from(e: CanonError) -> Self {
        Self::Canonical(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/// base64url-no-pad — the only encoding allowed by `crypto-spec.md` for IDs,
/// hashes, signatures, nonces and ciphertext.
fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Build a typed newtype from a base64url string by going through `serde`.
///
/// The newtypes in `crate::review::ids` are tuple structs with a private
/// field, so we mint them the same way wire payloads do — via deserialization
/// from a JSON string. This keeps the crypto module from needing to import
/// any constructors and matches the round-trip path used by `review::store`.
fn id_from_string<T: for<'de> Deserialize<'de>>(s: String) -> T {
    serde_json::from_value(serde_json::Value::String(s))
        .expect("base64url string deserializes into typed id newtype")
}

/// Extract the underlying base64url string of a typed id newtype.
///
/// Like `id_from_string`, this avoids needing to expose private fields.
fn id_to_string<T: Serialize>(id: &T) -> String {
    match serde_json::to_value(id).expect("typed id newtype serializes") {
        serde_json::Value::String(s) => s,
        _ => panic!("typed id newtype must serialize to a JSON string"),
    }
}

// ---------------------------------------------------------------------------
// Primitive derivations
// ---------------------------------------------------------------------------

/// `RoomId = base64url(first 16 bytes of SHA-256("attn room v2" || roomSecret))`
///
/// Spec: `crypto-spec.md` §Identity And Key Hierarchy and §ID Construction.
pub fn derive_room_id(room_secret: &[u8; 32]) -> RoomId {
    let mut hasher = Sha256::new();
    hasher.update(b"attn room v2");
    hasher.update(room_secret);
    let digest = hasher.finalize();
    id_from_string(b64url(&digest[..16]))
}

/// `FileId = base64url(first 16 bytes of SHA-256("attn file v2" || roomSecret`
/// `|| displayPath || firstSnapshotHash))`
///
/// NOTE: the prefix is `"attn file v2"` per `amendments.md` §Inconsistencies
/// Fixed — NOT `"attn file"` (which appears in the older `data-model.md`
/// draft). `roomSecret` is mixed in so the FileId is unguessable to anyone
/// outside the room even if they later learn the display path.
///
/// Spec: `crypto-spec.md` §ID Construction → `FileId`.
pub fn derive_file_id(
    room_secret: &[u8; 32],
    display_path: &str,
    first_snapshot_hash: &ContentHash,
) -> FileId {
    let mut hasher = Sha256::new();
    hasher.update(b"attn file v2");
    hasher.update(room_secret);
    hasher.update(display_path.as_bytes());
    hasher.update(id_to_string(first_snapshot_hash).as_bytes());
    let digest = hasher.finalize();
    id_from_string(b64url(&digest[..16]))
}

/// Stable identity for the single synthetic manifest document in a room.
/// It is deliberately independent of manifest content so republishing a
/// different scope or entry set advances one linear snapshot history.
///
/// `FileId = base64url(SHA-256("attn workspace manifest v1" || roomSecret)[:16])`
pub fn derive_workspace_manifest_file_id(room_secret: &[u8; 32]) -> FileId {
    let mut hasher = Sha256::new();
    hasher.update(b"attn workspace manifest v1");
    hasher.update(room_secret);
    let digest = hasher.finalize();
    id_from_string(b64url(&digest[..16]))
}

/// `SnapshotId = base64url(first 16 bytes of SHA-256("snapshot v2" || roomId`
/// `|| fileId || baseHash || createdAt-as-string))`
///
/// `createdAt-as-string` is the decimal ASCII form of the millisecond
/// timestamp so the hash is deterministic regardless of integer width
/// (matches the spec wording "createdAt-as-string").
///
/// Spec: `crypto-spec.md` §ID Construction → `SnapshotId`.
pub fn derive_snapshot_id(
    room_id: &RoomId,
    file_id: &FileId,
    base_hash: &ContentHash,
    created_at_ms: i64,
) -> SnapshotId {
    let mut hasher = Sha256::new();
    hasher.update(b"snapshot v2");
    hasher.update(id_to_string(room_id).as_bytes());
    hasher.update(id_to_string(file_id).as_bytes());
    hasher.update(id_to_string(base_hash).as_bytes());
    hasher.update(created_at_ms.to_string().as_bytes());
    let digest = hasher.finalize();
    id_from_string(b64url(&digest[..16]))
}

/// `EventId = base64url(SHA-256(canonicalJSON({meta-without-eventId, body})))`
///
/// `parentEventIds` is sorted ASCII-ascending before serialization so
/// reordering doesn't change the ID. `snapshotId` is omitted entirely if
/// absent (never serialized as `null`). The wire-shape `EventMeta` carries
/// `eventId` because the relay/peers index by it, but the bytes hashed here
/// MUST NOT contain it — otherwise the ID would depend on itself.
///
/// Spec: `crypto-spec.md` §ID Construction → `EventId`.
pub fn derive_event_id(meta: &EventMeta, body: &ReviewEventBody) -> Result<EventId, IdError> {
    let signable = SignablePayload::from_event(meta, body);
    let bytes = to_canonical_bytes(&signable)?;
    let digest = Sha256::digest(&bytes);
    Ok(id_from_string(b64url(&digest)))
}

/// `EnvelopeId = base64url(first 16 bytes of SHA-256("envelope v2" || roomId`
/// `|| eventId))`
///
/// Use this form for envelopes wrapping a single `ReviewEvent`
/// (`kind: "event"`). The eventId is already deterministic and unique,
/// so no separate nonce is needed.
///
/// Spec: `crypto-spec.md` §ID Construction → `EnvelopeId`.
pub fn derive_envelope_id_for_event(room_id: &RoomId, event_id: &EventId) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"envelope v2");
    hasher.update(id_to_string(room_id).as_bytes());
    hasher.update(id_to_string(event_id).as_bytes());
    let digest = hasher.finalize();
    b64url(&digest[..16])
}

/// `EnvelopeId = base64url(first 16 bytes of SHA-256("envelope v2" || roomId`
/// `|| deviceId || clientNonce))`
///
/// Use this form for `kind: "signal"` and `kind: "snapshot_blob"` envelopes.
/// `clientNonce` is a 16-byte random value persisted in the outbox before any
/// send attempt; retries reuse the same nonce so the relay can dedup.
///
/// Spec: `crypto-spec.md` §ID Construction → `EnvelopeId`.
pub fn derive_envelope_id_with_nonce(
    room_id: &RoomId,
    device_id: &str,
    client_nonce: &[u8; 16],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"envelope v2");
    hasher.update(id_to_string(room_id).as_bytes());
    hasher.update(device_id.as_bytes());
    hasher.update(client_nonce);
    let digest = hasher.finalize();
    b64url(&digest[..16])
}

/// `ContentHash = base64url(SHA-256(markdownBytesUtf8))`
///
/// The caller is responsible for canonicalizing the bytes per
/// `crypto-spec.md` §ContentHash: no BOM, LF line endings, trailing-newline
/// policy preserved as authored. We do NOT re-canonicalize here — that would
/// produce a different hash than `data-model.md` `SnapshotNode.baseHash`,
/// which is the SHA-256 of the bytes the user actually wrote.
pub fn content_hash(canonical_bytes: &[u8]) -> ContentHash {
    let digest = Sha256::digest(canonical_bytes);
    id_from_string(b64url(&digest))
}

// ---------------------------------------------------------------------------
// Signable payload (internal — never appears on the wire)
// ---------------------------------------------------------------------------

/// The exact shape that goes into `canonicalJSON({meta, body})` for EventId
/// derivation. `meta` here is `EventMeta` MINUS `eventId`, with
/// `parentEventIds` already sorted. Splitting this out keeps `derive_event_id`
/// itself a thin shell over `canonical::to_canonical_bytes`, and makes the
/// "what bytes do we sign?" question greppable.
///
/// The same bytes feed the Ed25519 signature step (attn-nnj.1.6) — if that
/// implementation lands later, prefer to share this struct rather than
/// duplicating the field shape.
#[derive(Debug, Serialize)]
struct SignablePayload<'a> {
    meta: SignableMeta<'a>,
    body: &'a ReviewEventBody,
}

impl<'a> SignablePayload<'a> {
    fn from_event(meta: &'a EventMeta, body: &'a ReviewEventBody) -> Self {
        Self {
            meta: SignableMeta::from(meta),
            body,
        }
    }
}

/// `EventMeta` without `eventId`. `parentEventIds` is owned (not borrowed)
/// because we need to sort it; everything else is borrowed from the source
/// meta to avoid copying owned `String`s.
///
/// Field order in the struct doesn't matter for canonical JSON output
/// (keys are re-sorted ASCII-ascending by the canonicalizer), but matching
/// the spec ordering makes the code easier to read alongside
/// `crypto-spec.md` §EventId.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignableMeta<'a> {
    v: u32,
    #[serde(rename = "roomId")]
    room_id: &'a crate::review::ids::RoomId,
    #[serde(rename = "authorId")]
    author_id: &'a crate::review::ids::ParticipantId,
    #[serde(rename = "deviceId")]
    device_id: &'a crate::review::ids::DeviceId,
    created_at: u64,
    /// Sorted copy of `meta.parent_event_ids`. The wire form preserves
    /// author-supplied order so causality is human-debuggable, but the bytes
    /// we hash MUST be order-invariant or two devices in agreement on the
    /// causal graph would compute different EventIds.
    parent_event_ids: Vec<EventId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot_id: Option<&'a SnapshotId>,
}

impl<'a> From<&'a EventMeta> for SignableMeta<'a> {
    fn from(meta: &'a EventMeta) -> Self {
        // Clone-then-sort: the canonical encoding must be deterministic
        // regardless of the order callers happen to supply parents in.
        let mut parents = meta.parent_event_ids.clone();
        parents.sort_by_key(id_to_string);
        Self {
            v: meta.v,
            room_id: &meta.room_id,
            author_id: &meta.author_id,
            device_id: &meta.device_id,
            created_at: meta.created_at,
            parent_event_ids: parents,
            snapshot_id: meta.snapshot_id.as_ref(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::ids::{DeviceId, ParticipantId};
    use crate::review::model::{
        Anchor, EventMeta, PositionAnchor, ReviewEventBody, SuggestionOperation,
    };
    use serde::Deserialize;
    use serde_json::Value;

    // ---- typed-id helpers (mirror the model-test pattern) --------------

    fn typed_id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string()))
            .expect("typed id deserializes from string")
    }

    fn sample_room_id() -> RoomId {
        typed_id::<RoomId>("room-abc")
    }
    fn sample_file_id() -> FileId {
        typed_id::<FileId>("file-1")
    }
    fn sample_content_hash(label: &str) -> ContentHash {
        typed_id::<ContentHash>(label)
    }
    fn sample_event_id(label: &str) -> EventId {
        typed_id::<EventId>(label)
    }
    fn sample_snapshot_id(label: &str) -> SnapshotId {
        typed_id::<SnapshotId>(label)
    }

    fn sample_meta(parents: Vec<EventId>, snapshot: Option<SnapshotId>) -> EventMeta {
        EventMeta {
            v: 2,
            // This eventId is a placeholder — derive_event_id ignores it.
            event_id: sample_event_id("evt-placeholder"),
            room_id: sample_room_id(),
            author_id: typed_id::<ParticipantId>("p-1"),
            device_id: typed_id::<DeviceId>("d-1"),
            created_at: 1_700_000_000_000,
            parent_event_ids: parents,
            snapshot_id: snapshot,
        }
    }

    fn comment_body(text: &str) -> ReviewEventBody {
        ReviewEventBody::CommentCreated {
            thread_id: "thread-1".to_string(),
            anchor: Anchor {
                v: 2,
                file_id: sample_file_id(),
                snapshot_id: sample_snapshot_id("snap-1"),
                base_hash: sample_content_hash("hash-1"),
                position: PositionAnchor {
                    byte_range: [10, 20],
                    line_range: [1, 1],
                    pm_range: None,
                },
                quote: None,
                block: None,
                context: None,
                structure: None,
            },
            body: text.to_string(),
        }
    }

    // ---- roomId ---------------------------------------------------------

    #[test]
    fn derive_room_id_is_deterministic() {
        let secret = [7u8; 32];
        let a = derive_room_id(&secret);
        let b = derive_room_id(&secret);
        assert_eq!(a, b);
    }

    #[test]
    fn derive_room_id_changes_with_secret() {
        let id_a = derive_room_id(&[0u8; 32]);
        let id_b = derive_room_id(&[1u8; 32]);
        assert_ne!(id_a, id_b);
    }

    #[test]
    fn derive_room_id_uses_first_16_bytes_only() {
        // base64url of 16 bytes is 22 chars (no padding).
        let id = derive_room_id(&[0u8; 32]);
        let s = id_to_string(&id);
        assert_eq!(
            s.len(),
            22,
            "RoomId should be 22 base64url chars (16 bytes), got {} ({s})",
            s.len()
        );
    }

    // ---- fileId ---------------------------------------------------------

    #[test]
    fn derive_file_id_is_deterministic() {
        let secret = [3u8; 32];
        let h = sample_content_hash("hash-first");
        let a = derive_file_id(&secret, "docs/intro.md", &h);
        let b = derive_file_id(&secret, "docs/intro.md", &h);
        assert_eq!(a, b);
    }

    #[test]
    fn derive_file_id_changes_with_display_path() {
        let secret = [3u8; 32];
        let h = sample_content_hash("hash-first");
        let a = derive_file_id(&secret, "docs/intro.md", &h);
        let b = derive_file_id(&secret, "docs/other.md", &h);
        assert_ne!(a, b);
    }

    #[test]
    fn derive_file_id_changes_with_first_snapshot_hash() {
        let secret = [3u8; 32];
        let a = derive_file_id(&secret, "docs/x.md", &sample_content_hash("hash-a"));
        let b = derive_file_id(&secret, "docs/x.md", &sample_content_hash("hash-b"));
        assert_ne!(a, b);
    }

    #[test]
    fn derive_file_id_uses_v2_prefix_not_v1() {
        // Regression guard for amendments.md §Inconsistencies Fixed.
        // "attn file v2" must yield a different output than "attn file".
        let secret = [9u8; 32];
        let path = "docs/regression.md";
        let h = sample_content_hash("hash-r");

        let actual = derive_file_id(&secret, path, &h);

        let mut hasher = Sha256::new();
        hasher.update(b"attn file"); // OLD (rejected) prefix
        hasher.update(secret);
        hasher.update(path.as_bytes());
        hasher.update(id_to_string(&h).as_bytes());
        let bad: FileId = id_from_string(b64url(&hasher.finalize()[..16]));

        assert_ne!(
            id_to_string(&actual),
            id_to_string(&bad),
            "derive_file_id MUST use 'attn file v2' prefix (amendments.md fix)"
        );
    }

    #[test]
    fn workspace_manifest_file_id_is_domain_separated_and_stable() {
        let secret = [0x11; 32];
        let first = derive_workspace_manifest_file_id(&secret);
        let retry = derive_workspace_manifest_file_id(&secret);
        assert_eq!(first, retry);
        assert_eq!(first.as_str(), "B5oaDs7_sHZ73Vuoxibfjg");

        let ordinary = derive_file_id(&secret, "workspace-manifest", &content_hash(b"manifest"));
        assert_ne!(first, ordinary, "synthetic manifest uses its own domain");
        assert_ne!(first, derive_workspace_manifest_file_id(&[0x12; 32]));
    }

    // ---- snapshotId -----------------------------------------------------

    #[test]
    fn derive_snapshot_id_is_deterministic() {
        let room = sample_room_id();
        let file = sample_file_id();
        let h = sample_content_hash("hash-base");
        let a = derive_snapshot_id(&room, &file, &h, 1_700_000_000_000);
        let b = derive_snapshot_id(&room, &file, &h, 1_700_000_000_000);
        assert_eq!(a, b);
    }

    #[test]
    fn derive_snapshot_id_changes_with_timestamp() {
        let room = sample_room_id();
        let file = sample_file_id();
        let h = sample_content_hash("hash-base");
        let a = derive_snapshot_id(&room, &file, &h, 1_700_000_000_000);
        let b = derive_snapshot_id(&room, &file, &h, 1_700_000_000_001);
        assert_ne!(a, b);
    }

    // ---- eventId --------------------------------------------------------

    #[test]
    fn derive_event_id_is_deterministic() {
        let meta = sample_meta(vec![], None);
        let body = comment_body("hello");
        let a = derive_event_id(&meta, &body).unwrap();
        let b = derive_event_id(&meta, &body).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn derive_event_id_ignores_meta_event_id_field() {
        // Two metas identical EXCEPT for the placeholder eventId field
        // must yield the same eventId — otherwise we'd have a self-reference.
        let body = comment_body("hello");
        let mut meta_a = sample_meta(vec![], None);
        meta_a.event_id = sample_event_id("AAA");
        let mut meta_b = sample_meta(vec![], None);
        meta_b.event_id = sample_event_id("ZZZ");
        let id_a = derive_event_id(&meta_a, &body).unwrap();
        let id_b = derive_event_id(&meta_b, &body).unwrap();
        assert_eq!(id_a, id_b, "meta.eventId must NOT be in the hashed bytes");
    }

    #[test]
    fn derive_event_id_sorts_parent_event_ids() {
        // Author-supplied order varies; the hash must not.
        let body = comment_body("child");
        let parents_asc = vec![sample_event_id("aaa"), sample_event_id("bbb")];
        let parents_desc = vec![sample_event_id("bbb"), sample_event_id("aaa")];
        let meta_a = sample_meta(parents_asc, None);
        let meta_b = sample_meta(parents_desc, None);
        assert_eq!(
            derive_event_id(&meta_a, &body).unwrap(),
            derive_event_id(&meta_b, &body).unwrap(),
            "parentEventIds reordering must NOT change the event id"
        );
    }

    #[test]
    fn derive_event_id_differs_when_body_changes() {
        let meta = sample_meta(vec![], None);
        let a = derive_event_id(&meta, &comment_body("alpha")).unwrap();
        let b = derive_event_id(&meta, &comment_body("beta")).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn derive_event_id_omits_snapshot_id_when_absent() {
        // Building a meta with None vs Some must produce different IDs
        // (snapshotId is *omitted* when None, not coerced to null — but
        // including a value should still change the hash).
        let body = comment_body("x");
        let meta_none = sample_meta(vec![], None);
        let meta_some = sample_meta(vec![], Some(sample_snapshot_id("snap-1")));
        assert_ne!(
            derive_event_id(&meta_none, &body).unwrap(),
            derive_event_id(&meta_some, &body).unwrap()
        );
    }

    #[test]
    fn derive_event_id_canonical_bytes_have_no_event_id_key() {
        // Inspect the bytes that go into SHA-256 — they must serialize an
        // object with `meta` and `body` and `meta` must NOT contain
        // `eventId`. This is the load-bearing invariant for the entire
        // signing scheme.
        let meta = sample_meta(vec![], None);
        let body = comment_body("inspect");
        let signable = SignablePayload::from_event(&meta, &body);
        let bytes = to_canonical_bytes(&signable).unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        let meta_obj = json.get("meta").and_then(Value::as_object).unwrap();
        assert!(
            !meta_obj.contains_key("eventId"),
            "signable meta must NOT contain `eventId`: {}",
            String::from_utf8_lossy(&bytes)
        );
        assert!(meta_obj.contains_key("roomId"));
        assert!(meta_obj.contains_key("parentEventIds"));
    }

    // ---- envelopeId -----------------------------------------------------

    #[test]
    fn derive_envelope_id_for_event_is_deterministic() {
        let room = sample_room_id();
        let event = sample_event_id("evt-x");
        let a = derive_envelope_id_for_event(&room, &event);
        let b = derive_envelope_id_for_event(&room, &event);
        assert_eq!(a, b);
        assert_eq!(a.len(), 22, "envelope id is 16 bytes = 22 base64url chars");
    }

    #[test]
    fn derive_envelope_id_for_event_changes_with_event_id() {
        let room = sample_room_id();
        let a = derive_envelope_id_for_event(&room, &sample_event_id("evt-1"));
        let b = derive_envelope_id_for_event(&room, &sample_event_id("evt-2"));
        assert_ne!(a, b);
    }

    #[test]
    fn derive_envelope_id_with_nonce_is_deterministic() {
        let room = sample_room_id();
        let device = "device-1";
        let nonce = [5u8; 16];
        let a = derive_envelope_id_with_nonce(&room, device, &nonce);
        let b = derive_envelope_id_with_nonce(&room, device, &nonce);
        assert_eq!(a, b);
    }

    #[test]
    fn derive_envelope_id_with_nonce_changes_with_nonce() {
        let room = sample_room_id();
        let device = "device-1";
        let a = derive_envelope_id_with_nonce(&room, device, &[1u8; 16]);
        let b = derive_envelope_id_with_nonce(&room, device, &[2u8; 16]);
        assert_ne!(a, b);
    }

    // ---- contentHash ----------------------------------------------------

    #[test]
    fn content_hash_is_deterministic() {
        let bytes = b"# heading\n\nbody\n";
        assert_eq!(content_hash(bytes), content_hash(bytes));
    }

    #[test]
    fn content_hash_changes_with_bytes() {
        assert_ne!(content_hash(b"abc"), content_hash(b"abd"));
    }

    #[test]
    fn content_hash_does_not_strip_bom_or_normalize() {
        // The spec says canonicalization is the caller's job. We must NOT
        // silently strip a BOM or normalize line endings — otherwise two
        // different input byte sequences could collide.
        let with_bom: &[u8] = &[0xEF, 0xBB, 0xBF, b'a', b'b', b'c'];
        let without_bom: &[u8] = b"abc";
        assert_ne!(
            content_hash(with_bom),
            content_hash(without_bom),
            "content_hash must hash bytes as given (no BOM stripping)"
        );

        let crlf: &[u8] = b"a\r\nb";
        let lf: &[u8] = b"a\nb";
        assert_ne!(
            content_hash(crlf),
            content_hash(lf),
            "content_hash must hash bytes as given (no CRLF normalization)"
        );
    }

    #[test]
    fn content_hash_is_22_or_43_chars() {
        // SHA-256 = 32 bytes, base64url-no-pad = ceil(32 * 4 / 3) = 43.
        let h = content_hash(b"hello");
        let s = id_to_string(&h);
        assert_eq!(s.len(), 43, "expected 43-char base64url hash, got {s}");
    }

    // ---- helper ergonomics --------------------------------------------

    #[test]
    fn b64url_round_trip() {
        let data = [0u8, 1, 2, 3, 255];
        let s = b64url(&data);
        let back = URL_SAFE_NO_PAD.decode(s.as_bytes()).unwrap();
        assert_eq!(back, data);
        // No padding ever.
        assert!(!s.contains('='));
    }

    // ---- corpus replay --------------------------------------------------

    /// Cross-implementation corpus shared with the (future) browser/WASM
    /// client. Fixed inputs → fixed outputs; if Rust and TS diverge, this
    /// test catches it before signature verification mystery-fails in prod.
    const EVENT_ID_CORPUS: &str =
        include_str!("../../../planning/collab/test-vectors/event-id.json");

    const ENVELOPE_CORPUS: &str =
        include_str!("../../../planning/collab/test-vectors/envelope.json");

    /// Parse a JSON event meta (no `eventId`) into an `EventMeta`. The
    /// corpus uses the same camelCase wire schema as the Rust serde
    /// derives so we add a placeholder `eventId` and let serde do the rest.
    fn meta_from_corpus(meta: &Value) -> EventMeta {
        let mut obj = meta.as_object().expect("meta is an object").clone();
        // EventMeta.event_id is required by the Rust serde derive even
        // though it's NOT part of the bytes hashed. The whole point of
        // derive_event_id is that this value is irrelevant.
        obj.entry("eventId")
            .or_insert_with(|| Value::String("corpus-placeholder".to_string()));
        serde_json::from_value(Value::Object(obj)).expect("EventMeta deserializes from corpus")
    }

    fn body_from_corpus(body: &Value) -> ReviewEventBody {
        serde_json::from_value(body.clone()).expect("ReviewEventBody deserializes from corpus body")
    }

    #[test]
    fn event_id_corpus_replay() {
        let root: Value = serde_json::from_str(EVENT_ID_CORPUS).expect("event-id.json parses");
        let vectors = root
            .get("vectors")
            .and_then(Value::as_array)
            .expect("event-id.json has `vectors` array");
        assert!(vectors.len() >= 2, "expected >= 2 event-id vectors");
        let mut checked = 0usize;
        for (i, v) in vectors.iter().enumerate() {
            let name = v.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let event = v.get("event").expect("vector has event");
            let expected = v.get("expected").expect("vector has expected");

            let expected_id = expected
                .get("eventId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("vector {i} ({name}) missing expected.eventId"));
            if expected_id.starts_with("__PENDING") {
                continue; // Tolerate pending placeholders during multi-issue parallel work.
            }

            let meta_json = event.get("meta").expect("event has meta");
            // Reject any vector that snuck an `eventId` into the meta —
            // the whole point of this hash is that meta.eventId is excluded.
            assert!(
                meta_json.get("eventId").is_none(),
                "vector {i} ({name}): meta MUST NOT contain `eventId`"
            );

            let meta = meta_from_corpus(meta_json);
            let body = body_from_corpus(event.get("body").expect("event has body"));
            let actual = derive_event_id(&meta, &body).unwrap();
            let actual_str = id_to_string(&actual);
            assert_eq!(
                actual_str, expected_id,
                "vector {i} ({name}): eventId mismatch"
            );

            // If the corpus pins canonicalBytes too, double-check those.
            if let Some(canon) = expected.get("canonicalBytes").and_then(Value::as_str)
                && !canon.starts_with("__PENDING")
            {
                let signable = SignablePayload::from_event(&meta, &body);
                let bytes = to_canonical_bytes(&signable).unwrap();
                let actual_canon = String::from_utf8(bytes).expect("canonical bytes are utf-8");
                assert_eq!(
                    actual_canon, canon,
                    "vector {i} ({name}): canonicalBytes mismatch"
                );
            }

            checked += 1;
        }
        assert!(
            checked >= 2,
            "expected to replay at least 2 non-pending event-id vectors, got {checked}"
        );
    }

    #[test]
    fn envelope_corpus_replay() {
        // attn-nnj.1.8 owns only the ID-derivation slice of the envelope
        // corpus. The full round-trip (AEAD, signature) lands in 1.9. Here
        // we verify that for every vector with non-PENDING `eventId` and
        // `envelopeId` we can reproduce both from the inputs the corpus
        // pins. This is what makes the corpus a contract for the *id*
        // shapes specifically.
        let root: Value = serde_json::from_str(ENVELOPE_CORPUS).expect("envelope.json parses");
        let vectors = root
            .get("vectors")
            .and_then(Value::as_array)
            .expect("envelope.json has `vectors` array");
        assert!(vectors.len() >= 2, "expected >= 2 envelope vectors");

        let mut event_flavor = 0usize;
        let mut nonce_flavor = 0usize;
        for (i, v) in vectors.iter().enumerate() {
            let name = v.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let inputs = v.get("inputs").expect("vector has inputs");
            let expected = v.get("expected").expect("vector has expected");

            let expected_event_id = expected
                .get("eventId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("vector {i} ({name}) missing expected.eventId"));
            let expected_envelope_id = expected
                .get("envelopeId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("vector {i} ({name}) missing expected.envelopeId"));

            if expected_event_id.starts_with("__PENDING")
                || expected_envelope_id.starts_with("__PENDING")
            {
                continue;
            }

            let event = inputs.get("event").expect("inputs.event");
            let meta_json = event.get("meta").expect("event.meta");
            let body_json = event.get("body").expect("event.body");
            let room_id_str = meta_json
                .get("roomId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("vector {i} ({name}) missing meta.roomId"));
            let room_id: RoomId = typed_id(room_id_str);

            let meta = meta_from_corpus(meta_json);
            let body = body_from_corpus(body_json);
            let event_id = derive_event_id(&meta, &body).unwrap();
            assert_eq!(
                id_to_string(&event_id),
                expected_event_id,
                "vector {i} ({name}): eventId mismatch"
            );

            // EnvelopeId — choose the flavor based on whether clientNonce
            // is present (signal/snapshot) or absent (event).
            let envelope = expected.get("envelope").expect("expected.envelope");
            let kind = envelope
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("vector {i} ({name}) missing envelope.kind"));

            let actual_envelope_id = match kind {
                "event" => {
                    event_flavor += 1;
                    derive_envelope_id_for_event(&room_id, &event_id)
                }
                "signal" | "snapshot_blob" => {
                    nonce_flavor += 1;
                    let device_id = meta_json
                        .get("deviceId")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| panic!("vector {i} ({name}) missing meta.deviceId"));
                    let nonce_b64 = inputs
                        .get("clientNonce")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| {
                            panic!("vector {i} ({name}) needs clientNonce for kind {kind}")
                        });
                    let nonce_bytes =
                        URL_SAFE_NO_PAD
                            .decode(nonce_b64.as_bytes())
                            .unwrap_or_else(|_| {
                                panic!("vector {i} ({name}) clientNonce not base64url")
                            });
                    let nonce_arr: [u8; 16] =
                        nonce_bytes.as_slice().try_into().unwrap_or_else(|_| {
                            panic!("vector {i} ({name}) clientNonce must be 16 bytes")
                        });
                    derive_envelope_id_with_nonce(&room_id, device_id, &nonce_arr)
                }
                other => panic!("vector {i} ({name}) unknown envelope kind {other}"),
            };

            assert_eq!(
                actual_envelope_id, expected_envelope_id,
                "vector {i} ({name}): envelopeId mismatch"
            );
        }

        assert!(
            event_flavor >= 1,
            "expected >= 1 envelope vector with kind=event"
        );
        assert!(
            nonce_flavor >= 1,
            "expected >= 1 envelope vector with kind=signal|snapshot_blob (clientNonce flavor)"
        );
    }

    // ---- json shape sanity --------------------------------------------

    #[test]
    fn signable_payload_shape_is_meta_and_body() {
        // Compile-time-ish guard: the JSON we hash MUST be exactly
        // {"meta":{...},"body":{...}} — no extra fields. If a future
        // refactor adds a field to SignablePayload, this test catches it
        // before it silently invalidates every existing eventId.
        let meta = sample_meta(vec![], None);
        let body = comment_body("shape");
        let signable = SignablePayload::from_event(&meta, &body);
        let json: Value = serde_json::from_slice(&to_canonical_bytes(&signable).unwrap()).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["body", "meta"],
            "SignablePayload must serialize as exactly {{meta, body}}"
        );
    }

    // Tiny consistency test for the suggestion event body path — proves
    // derive_event_id works for non-comment variants too (defends against
    // accidental dependence on a specific tag value).
    #[test]
    fn derive_event_id_works_for_suggestion_body() {
        let meta = sample_meta(vec![], None);
        let body = ReviewEventBody::SuggestionCreated {
            suggestion_id: "sug-1".to_string(),
            anchor: Anchor {
                v: 2,
                file_id: sample_file_id(),
                snapshot_id: sample_snapshot_id("snap-1"),
                base_hash: sample_content_hash("hash-1"),
                position: PositionAnchor {
                    byte_range: [0, 4],
                    line_range: [1, 1],
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
            note: None,
        };
        let id = derive_event_id(&meta, &body).unwrap();
        assert_eq!(id_to_string(&id).len(), 43);
    }

    /// Helper: prints event-id vectors for parent-count edge cases (1, 3, 10).
    /// Run with:
    ///   cargo test review::crypto::ids::tests::print_event_id_parent_count_vectors \
    ///     -- --ignored --nocapture
    /// then copy the JSON into `planning/collab/test-vectors/event-id.json`.
    #[test]
    #[ignore]
    fn print_event_id_parent_count_vectors() {
        // Match the shared corpus inputs (roomId, author/device/snapshot).
        // RoomId comes from roomSecret = 0x11 * 32; see event-id.json header.
        let room_id_str = "hjCfgOvsatNOUedgxhZpyw";
        let author_str = "p-author-01";
        let device_str = "d-device-01";
        let snapshot_str = "eQ7pDCC-mekpz-we7gDYag";
        let base_hash_str = "fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y";

        for (label, parent_strs, created_at) in [
            ("1-parent", vec!["evt-only"], 1_700_000_010_000u64),
            (
                "3-parents (out of order)",
                vec!["evt-MMM", "evt-AAA", "evt-ZZZ"],
                1_700_000_020_000,
            ),
            (
                "10-parents (out of order)",
                vec![
                    "evt-09", "evt-01", "evt-08", "evt-02", "evt-07", "evt-03", "evt-06", "evt-04",
                    "evt-05", "evt-00",
                ],
                1_700_000_030_000,
            ),
        ] {
            let parents: Vec<EventId> =
                parent_strs.iter().map(|s| typed_id::<EventId>(s)).collect();
            let meta = EventMeta {
                v: 2,
                event_id: typed_id::<EventId>("placeholder-event-id"),
                room_id: typed_id::<RoomId>(room_id_str),
                author_id: typed_id::<ParticipantId>(author_str),
                device_id: typed_id::<DeviceId>(device_str),
                created_at,
                parent_event_ids: parents,
                snapshot_id: Some(typed_id::<SnapshotId>(snapshot_str)),
            };
            let body = ReviewEventBody::CommentCreated {
                thread_id: format!("thread-{label}"),
                anchor: Anchor {
                    v: 2,
                    file_id: typed_id::<FileId>("f-file-01"),
                    snapshot_id: typed_id::<SnapshotId>(snapshot_str),
                    base_hash: typed_id::<ContentHash>(base_hash_str),
                    position: PositionAnchor {
                        byte_range: [0, 5],
                        line_range: [1, 1],
                        pm_range: None,
                    },
                    quote: None,
                    block: None,
                    context: None,
                    structure: None,
                },
                body: format!("parent-count vector: {label}"),
            };
            let id = derive_event_id(&meta, &body).unwrap();
            let signable = SignablePayload::from_event(&meta, &body);
            let canon = String::from_utf8(to_canonical_bytes(&signable).unwrap()).unwrap();
            eprintln!("=== {label} ===");
            eprintln!("createdAt: {created_at}");
            eprintln!("threadId: thread-{label}");
            eprintln!("body: parent-count vector: {label}");
            eprintln!("canonicalBytes: {canon}");
            eprintln!("eventId: {}", id_to_string(&id));
            eprintln!();
        }
    }
}
