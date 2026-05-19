//! HKDF-SHA-256 wrapper + room key derivation.
//!
//! See `planning/collab/crypto-spec.md` §Key Derivation for the canonical
//! info strings and the derivation graph (`roomSecret` -> `rootKey` -> 4
//! subkeys, plus `roomId` from a separate hashed prefix).
//!
//! The info strings below are byte-exact (UTF-8, no trailing newline) and
//! must match crypto-spec.md character-for-character — Rust and TypeScript
//! implementations interop on these strings, and the test-vector corpus at
//! `planning/collab/test-vectors/kdf.json` pins the derived bytes.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::review::ids::RoomId;

// ---------------------------------------------------------------------------
// Canonical info strings — keep in sync with planning/collab/crypto-spec.md
// §Key Derivation. ANY change here breaks two-implementation interop.
// ---------------------------------------------------------------------------

/// HKDF info for the room root key (`HKDF(roomSecret, info=..., L=32)`).
pub const INFO_ROOT: &[u8] = b"attn room root v2";
/// HKDF info for the event-encryption subkey (`HKDF(rootKey, info=..., L=32)`).
pub const INFO_EVENT: &[u8] = b"attn event encryption v2";
/// HKDF info for the snapshot-encryption subkey.
pub const INFO_SNAPSHOT: &[u8] = b"attn snapshot encryption v2";
/// HKDF info for the signaling-encryption subkey.
pub const INFO_SIGNALING: &[u8] = b"attn signaling encryption v2";
/// HKDF info for the relay-admission subkey (relay-binding token MACs).
pub const INFO_ADMISSION: &[u8] = b"attn relay admission v2";

/// Prefix hashed alongside `roomSecret` to derive the public `roomId`
/// (so the id is domain-separated from any HKDF output).
pub const ROOM_ID_PREFIX: &[u8] = b"attn room v2";

// ---------------------------------------------------------------------------
// DerivedKey — 32-byte symmetric key, zeroizes on drop
// ---------------------------------------------------------------------------

/// A 32-byte symmetric key produced by HKDF-SHA-256. Zeroizes its bytes on
/// drop so leaked stack frames / dropped clones cannot leave key material
/// behind in memory.
///
/// We deliberately do **not** implement `Debug` (avoid accidental logging)
/// or `PartialEq` (use `as_bytes()` + a constant-time comparator at the
/// call site if you need equality, e.g. when verifying MACs).
#[derive(Clone)]
pub struct DerivedKey([u8; 32]);

impl DerivedKey {
    /// Borrow the 32-byte key material. Callers must not retain copies past
    /// the lifetime of the `DerivedKey` if they want zeroization guarantees.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Drop for DerivedKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

// ---------------------------------------------------------------------------
// RoomKeys — bundle of derived subkeys for a single room
// ---------------------------------------------------------------------------

/// Bundle of room keys derived from a single 32-byte `roomSecret`.
///
/// Field order mirrors `planning/collab/crypto-spec.md` §Key Derivation:
/// `rootKey` is derived from `roomSecret`; the four downstream keys are each
/// derived from `rootKey` with a distinct info string.
pub struct RoomKeys {
    /// `HKDF(roomSecret, info="attn room root v2", L=32)`. Used only to
    /// derive the four subkeys; never used directly for AEAD/signing.
    pub root_key: DerivedKey,
    /// `HKDF(rootKey, info="attn event encryption v2", L=32)`. AEAD key for
    /// all signed-and-encrypted review events.
    pub event_key: DerivedKey,
    /// `HKDF(rootKey, info="attn snapshot encryption v2", L=32)`. AEAD key
    /// for snapshot blob bodies.
    pub snapshot_key: DerivedKey,
    /// `HKDF(rootKey, info="attn signaling encryption v2", L=32)`. AEAD key
    /// for WebRTC signaling envelopes relayed through the broker.
    pub signaling_key: DerivedKey,
    /// `HKDF(rootKey, info="attn relay admission v2", L=32)`. Symmetric
    /// secret used to MAC relay-admission tokens.
    pub admission_key: DerivedKey,
}

// ---------------------------------------------------------------------------
// HKDF wrapper
// ---------------------------------------------------------------------------

/// Generic HKDF-SHA-256 expansion to a 32-byte key. Empty salt (per
/// crypto-spec.md), `info` binds the output to a domain so that two
/// expansions with the same IKM but different infos produce uncorrelated
/// outputs.
///
/// `ikm` can be any length (typically 32 bytes — a CSPRNG room secret or
/// the 32-byte `rootKey`). Panics only if the underlying `hkdf` crate
/// rejects a 32-byte output length, which is unreachable for SHA-256
/// (the max for SHA-256 is 255*32 = 8160 bytes).
pub fn hkdf_expand_32(ikm: &[u8], info: &[u8]) -> DerivedKey {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut out = [0u8; 32];
    hk.expand(info, &mut out)
        .expect("HKDF-SHA-256 expand to 32 bytes is always valid");
    DerivedKey(out)
}

// ---------------------------------------------------------------------------
// Room key bundle derivation
// ---------------------------------------------------------------------------

/// Derive the full room key bundle from a 32-byte `roomSecret`.
///
/// Per `planning/collab/crypto-spec.md` §Key Derivation:
/// ```text
/// rootKey      := HKDF(roomSecret, info="attn room root v2",          L=32)
/// eventKey     := HKDF(rootKey,    info="attn event encryption v2",   L=32)
/// snapshotKey  := HKDF(rootKey,    info="attn snapshot encryption v2",L=32)
/// signalingKey := HKDF(rootKey,    info="attn signaling encryption v2",L=32)
/// admissionKey := HKDF(rootKey,    info="attn relay admission v2",    L=32)
/// ```
///
/// `roomSecret` is the only key material shared via the invite URL; every
/// other key in `RoomKeys` is derived on each device and never transmitted.
pub fn derive_room_keys(room_secret: &[u8; 32]) -> RoomKeys {
    let root_key = hkdf_expand_32(room_secret, INFO_ROOT);
    let root_bytes = root_key.as_bytes();
    let event_key = hkdf_expand_32(root_bytes, INFO_EVENT);
    let snapshot_key = hkdf_expand_32(root_bytes, INFO_SNAPSHOT);
    let signaling_key = hkdf_expand_32(root_bytes, INFO_SIGNALING);
    let admission_key = hkdf_expand_32(root_bytes, INFO_ADMISSION);

    RoomKeys {
        root_key,
        event_key,
        snapshot_key,
        signaling_key,
        admission_key,
    }
}

// ---------------------------------------------------------------------------
// Room id derivation
// ---------------------------------------------------------------------------

/// Derive the public `roomId` from a 32-byte `roomSecret`.
///
/// Per crypto-spec.md:
/// `roomId = base64url(first 16 bytes of SHA-256("attn room v2" || roomSecret))`
///
/// This is *not* an HKDF output — the room id is intentionally derivable
/// from `roomSecret` alone (so anyone with the invite URL can compute it)
/// while being domain-separated from any key by the `"attn room v2"` prefix.
pub fn derive_room_id(room_secret: &[u8; 32]) -> RoomId {
    let mut hasher = Sha256::new();
    hasher.update(ROOM_ID_PREFIX);
    hasher.update(room_secret);
    let digest = hasher.finalize();
    let id = URL_SAFE_NO_PAD.encode(&digest[..16]);
    RoomId::new(id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// Snapshot expected derivations for the all-zero 32-byte room secret.
    /// These are produced by the impl itself once and then frozen — any
    /// future change to the info strings, HKDF library, or base64 alphabet
    /// will fail this test loudly. Kept in lockstep with the matching
    /// vector in `planning/collab/test-vectors/kdf.json`.
    const ZERO_SECRET: [u8; 32] = [0u8; 32];

    // The expected values below were generated by running this very impl
    // on `ZERO_SECRET` (see the `print_zero_vector_for_corpus` helper at
    // the bottom of this module — gated behind `--ignored` so it doesn't
    // run in `cargo test`). They are then mirrored into kdf.json.
    const ZERO_ROOM_ID_B64: &str = "5Ow3qk07D4SvamUBfLrYuQ";
    const ZERO_ROOT_KEY_B64: &str = "CuyvxuusiDS8b3B1SrFgNFrLKQNm80Qb1yo_0OoPalo";
    const ZERO_EVENT_KEY_B64: &str = "qUDk0Dai7VDPJoTPdTlciQudWM46N63rDRMVe-Icqk8";
    const ZERO_SNAPSHOT_KEY_B64: &str = "2Gh2KNkDpiOZqscEQE0yi-0oLJP2h-ucrb1rtWLNiBw";
    const ZERO_SIGNALING_KEY_B64: &str = "tcDfnQQ3AaYdaJFa8rK-oEl9BWhB3oVgKAOs6sD-0dg";
    const ZERO_ADMISSION_KEY_B64: &str = "Nq_BjjgvAdbTtTrOVFWCbE0ZxwrMBIkKtXQcmf02Wlo";

    fn b64(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    #[test]
    fn derive_room_keys_zero_secret_matches_pinned_bytes() {
        let keys = derive_room_keys(&ZERO_SECRET);
        assert_eq!(b64(keys.root_key.as_bytes()), ZERO_ROOT_KEY_B64);
        assert_eq!(b64(keys.event_key.as_bytes()), ZERO_EVENT_KEY_B64);
        assert_eq!(b64(keys.snapshot_key.as_bytes()), ZERO_SNAPSHOT_KEY_B64);
        assert_eq!(
            b64(keys.signaling_key.as_bytes()),
            ZERO_SIGNALING_KEY_B64
        );
        assert_eq!(
            b64(keys.admission_key.as_bytes()),
            ZERO_ADMISSION_KEY_B64
        );
    }

    #[test]
    fn derive_room_id_is_deterministic() {
        let a = derive_room_id(&ZERO_SECRET);
        let b = derive_room_id(&ZERO_SECRET);
        assert_eq!(a, b);
        // And it matches the pinned base64url from the test-vector corpus.
        assert_eq!(a.as_str(), ZERO_ROOM_ID_B64);
    }

    #[test]
    fn distinct_secrets_yield_distinct_room_ids() {
        let s1 = [0u8; 32];
        let mut s2 = [0u8; 32];
        s2[0] = 1;
        assert_ne!(derive_room_id(&s1), derive_room_id(&s2));
    }

    #[test]
    fn subkeys_are_all_distinct() {
        // Sanity check that the info strings actually domain-separate.
        // If two infos collide, HKDF would produce identical output.
        let keys = derive_room_keys(&ZERO_SECRET);
        let bytes = [
            *keys.root_key.as_bytes(),
            *keys.event_key.as_bytes(),
            *keys.snapshot_key.as_bytes(),
            *keys.signaling_key.as_bytes(),
            *keys.admission_key.as_bytes(),
        ];
        for i in 0..bytes.len() {
            for j in (i + 1)..bytes.len() {
                assert_ne!(
                    bytes[i], bytes[j],
                    "subkeys at index {i} and {j} collided — info strings broken?"
                );
            }
        }
    }

    #[test]
    fn hkdf_expand_distinct_infos_distinct_outputs() {
        let ikm = [42u8; 32];
        let a = hkdf_expand_32(&ikm, b"info-a");
        let b = hkdf_expand_32(&ikm, b"info-b");
        assert_ne!(a.as_bytes(), b.as_bytes());
        // Same info -> same output (HKDF is deterministic).
        let a2 = hkdf_expand_32(&ikm, b"info-a");
        assert_eq!(a.as_bytes(), a2.as_bytes());
    }

    #[test]
    fn derived_key_zeroizes_on_drop() {
        // Place the key on the heap so its bytes live in a stable allocation
        // that survives the `Drop` impl returning (the allocator does not
        // immediately scribble freed memory in test builds). We capture a
        // raw pointer into the heap allocation, drop the Box (which runs
        // `DerivedKey::drop` -> `zeroize`), then deallocate manually after
        // reading the bytes back through the pointer.
        //
        // SAFETY: we never re-enter Rust ownership of the dropped box; we
        // only read the raw bytes once (Zeroize::zeroize uses volatile
        // writes that the compiler is forbidden from eliding) and then
        // hand the allocation back to the global allocator via Box::from_raw.
        use std::alloc::{Layout, dealloc};

        let boxed: Box<DerivedKey> =
            Box::new(hkdf_expand_32(b"zeroize-test-ikm", b"zeroize-test-info"));
        let original = *boxed.as_bytes();
        assert!(
            original.iter().any(|&b| b != 0),
            "expected non-trivial key bytes before drop"
        );
        let raw: *mut DerivedKey = Box::into_raw(boxed);
        let bytes_ptr: *const u8 = unsafe { (*raw).as_bytes().as_ptr() };

        // Run the destructor in-place WITHOUT freeing the allocation, so we
        // can still read through `bytes_ptr` afterwards. This is the standard
        // zeroize-verification pattern.
        unsafe { std::ptr::drop_in_place(raw) };

        let after = unsafe { std::slice::from_raw_parts(bytes_ptr, 32) };
        assert!(
            after.iter().all(|&b| b == 0),
            "DerivedKey did not zeroize on drop"
        );

        // Now hand the (already-dropped) backing memory back to the allocator
        // to avoid leaking it in the test process.
        unsafe { dealloc(raw as *mut u8, Layout::new::<DerivedKey>()) };
    }

    // -----------------------------------------------------------------
    // Test-vector corpus replay
    // -----------------------------------------------------------------

    #[derive(Debug, Deserialize)]
    struct Corpus {
        version: u32,
        vectors: Vec<Vector>,
    }

    #[derive(Debug, Deserialize)]
    struct Vector {
        name: String,
        #[serde(rename = "roomSecret")]
        room_secret: String,
        expected: Expected,
    }

    #[derive(Debug, Deserialize)]
    struct Expected {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "rootKey")]
        root_key: String,
        #[serde(rename = "eventKey")]
        event_key: String,
        #[serde(rename = "snapshotKey")]
        snapshot_key: String,
        #[serde(rename = "signalingKey")]
        signaling_key: String,
        #[serde(rename = "admissionKey")]
        admission_key: String,
    }

    const CORPUS_JSON: &str =
        include_str!("../../../planning/collab/test-vectors/kdf.json");

    fn decode_secret(s: &str) -> [u8; 32] {
        let bytes = URL_SAFE_NO_PAD
            .decode(s)
            .expect("test vector roomSecret is valid base64url-no-pad");
        let mut out = [0u8; 32];
        assert_eq!(
            bytes.len(),
            32,
            "test vector roomSecret must decode to exactly 32 bytes, got {}",
            bytes.len()
        );
        out.copy_from_slice(&bytes);
        out
    }

    fn room_id_string(secret: &[u8; 32]) -> String {
        let mut h = Sha256::new();
        h.update(ROOM_ID_PREFIX);
        h.update(secret);
        let d = h.finalize();
        URL_SAFE_NO_PAD.encode(&d[..16])
    }

    #[test]
    fn corpus_replay_matches_impl() {
        let corpus: Corpus = serde_json::from_str(CORPUS_JSON)
            .expect("kdf.json is well-formed JSON matching the Corpus schema");
        assert_eq!(corpus.version, 1, "corpus schema version drift");
        assert!(
            !corpus.vectors.is_empty(),
            "corpus must have at least one vector"
        );
        for v in &corpus.vectors {
            let secret = decode_secret(&v.room_secret);
            let keys = derive_room_keys(&secret);

            assert_eq!(
                room_id_string(&secret),
                v.expected.room_id,
                "roomId mismatch on vector '{}'",
                v.name
            );
            assert_eq!(
                b64(keys.root_key.as_bytes()),
                v.expected.root_key,
                "rootKey mismatch on vector '{}'",
                v.name
            );
            assert_eq!(
                b64(keys.event_key.as_bytes()),
                v.expected.event_key,
                "eventKey mismatch on vector '{}'",
                v.name
            );
            assert_eq!(
                b64(keys.snapshot_key.as_bytes()),
                v.expected.snapshot_key,
                "snapshotKey mismatch on vector '{}'",
                v.name
            );
            assert_eq!(
                b64(keys.signaling_key.as_bytes()),
                v.expected.signaling_key,
                "signalingKey mismatch on vector '{}'",
                v.name
            );
            assert_eq!(
                b64(keys.admission_key.as_bytes()),
                v.expected.admission_key,
                "admissionKey mismatch on vector '{}'",
                v.name
            );
        }
    }

    /// Helper: re-prints the bytes for the two corpus vectors. Run with
    /// `cargo test -- --ignored print_corpus_vectors --nocapture` if you
    /// need to regenerate kdf.json (e.g. after a spec change).
    #[test]
    #[ignore]
    fn print_corpus_vectors() {
        for (name, secret) in [
            ("all-zero", [0u8; 32]),
            ("counting-bytes", {
                let mut s = [0u8; 32];
                for (i, b) in s.iter_mut().enumerate() {
                    *b = i as u8;
                }
                s
            }),
        ] {
            let keys = derive_room_keys(&secret);
            println!("\n--- vector: {name} ---");
            println!("roomSecret    = {}", b64(&secret));
            println!("roomId        = {}", room_id_string(&secret));
            println!("rootKey       = {}", b64(keys.root_key.as_bytes()));
            println!("eventKey      = {}", b64(keys.event_key.as_bytes()));
            println!("snapshotKey   = {}", b64(keys.snapshot_key.as_bytes()));
            println!("signalingKey  = {}", b64(keys.signaling_key.as_bytes()));
            println!("admissionKey  = {}", b64(keys.admission_key.as_bytes()));
        }
    }
}
