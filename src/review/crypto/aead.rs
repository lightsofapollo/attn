//! XChaCha20-Poly1305 AEAD wrapper with AAD-bound metadata.
//!
//! Spec: `planning/collab/crypto-spec.md` §Envelope Encryption (AEAD).
//!
//! Why this lives here:
//! - The relay needs `roomId`, `envelopeId`, `kind`, `authorId`, `deviceId`,
//!   `createdAt` in cleartext to route envelopes. Binding those fields into
//!   the AEAD AAD prevents the relay (or any MITM) from re-routing a ciphertext
//!   under a different `kind` or `authorId` tag — the MAC would fail.
//! - AAD bytes MUST be produced by the canonical JSON helper from attn-nnj.1.3
//!   so a Rust sender and a future TS/WASM receiver produce the same byte
//!   sequence and the MAC verifies.
//! - XChaCha20-Poly1305 (192-bit nonce) is chosen over ChaCha20-Poly1305
//!   (96-bit nonce) so a random nonce per envelope is collision-safe without
//!   needing cross-device coordination.
//! - On decrypt failure we collapse all reasons (wrong key, wrong nonce,
//!   wrong AAD, tampered ciphertext) into a single error variant. The relay
//!   never needs to distinguish them, and merging them avoids accidentally
//!   leaking which input was wrong via timing or error-string differences.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::XChaCha20Poly1305;
use getrandom::getrandom;
use serde::{Deserialize, Serialize};

use crate::review::crypto::canonical::{self, CanonError};

/// 24-byte XChaCha20 nonce (192 bits — large enough that random nonces are
/// collision-safe without coordination across devices).
pub type AeadNonce = [u8; 24];

/// Errors returned by the AEAD wrapper.
///
/// `Decrypt` is intentionally opaque — we never distinguish "wrong key" from
/// "wrong nonce" from "wrong AAD" from "tampered ciphertext". The relay does
/// not need to know which input was wrong, and collapsing the reasons avoids
/// accidental side-channel leakage via error strings.
#[derive(Debug)]
pub enum AeadError {
    /// Sealing failed. In practice this only fires on internal RustCrypto
    /// errors (e.g. an unsupported buffer shape) — we treat it as a hard error.
    Encrypt,
    /// Decryption failed for one of: wrong key, wrong nonce, wrong AAD, or a
    /// tampered ciphertext. The reason is intentionally not exposed.
    Decrypt,
    /// The AAD struct could not be reduced to canonical-JSON bytes.
    Canonical(String),
    /// `getrandom` could not produce a fresh nonce.
    Random(String),
}

impl std::fmt::Display for AeadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Encrypt => write!(f, "aead encrypt failed"),
            Self::Decrypt => write!(
                f,
                "aead decrypt failed (key/nonce/AAD mismatch or tampered ciphertext)"
            ),
            Self::Canonical(msg) => write!(f, "canonical JSON for AAD: {msg}"),
            Self::Random(msg) => write!(f, "rng failure: {msg}"),
        }
    }
}

impl std::error::Error for AeadError {}

impl From<CanonError> for AeadError {
    fn from(e: CanonError) -> Self {
        Self::Canonical(e.to_string())
    }
}

/// AAD-binding metadata baked into every envelope.
///
/// Per `crypto-spec.md` §Envelope Encryption: the relay sees these fields in
/// cleartext for routing, and the decryption side reconstructs this exact
/// struct (and re-canonicalises it) to verify the MAC. Any tampering with the
/// routing metadata — including swapping `kind` to redirect an event into the
/// signal pipe — invalidates the MAC.
///
/// `v` is pinned to 2 for the v2 protocol; bump only on a breaking change to
/// the AAD shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeAad {
    /// Protocol version. Always `2` for the v2 collab spec.
    pub v: u32,
    pub room_id: String,
    pub envelope_id: String,
    /// One of `"event"`, `"signal"`, or `"snapshot_blob"`.
    pub kind: String,
    pub author_id: String,
    pub device_id: String,
    /// Unix epoch milliseconds.
    pub created_at: i64,
}

/// Produce a fresh random 24-byte XChaCha20 nonce.
///
/// Per spec: never reuse a nonce with the same key. The 192-bit nonce space
/// makes random selection collision-safe without coordination.
pub fn random_nonce() -> Result<AeadNonce, AeadError> {
    let mut nonce = [0u8; 24];
    getrandom(&mut nonce).map_err(|e| AeadError::Random(e.to_string()))?;
    Ok(nonce)
}

/// Seal `plaintext` under `key` with a fresh random nonce, binding the
/// canonical-JSON form of `aad` into the MAC.
///
/// Returns `(nonce, ciphertext)` where ciphertext includes the 16-byte
/// Poly1305 tag appended (per RustCrypto convention).
pub fn seal(
    key: &[u8; 32],
    plaintext: &[u8],
    aad: &EnvelopeAad,
) -> Result<(AeadNonce, Vec<u8>), AeadError> {
    let nonce = random_nonce()?;
    let ciphertext = seal_with_nonce(key, &nonce, plaintext, aad)?;
    Ok((nonce, ciphertext))
}

/// Seal with a caller-provided nonce. Intended for tests and deterministic
/// vector regeneration — production code paths must use [`seal`] so the nonce
/// stays fresh per envelope.
pub fn seal_with_nonce(
    key: &[u8; 32],
    nonce: &AeadNonce,
    plaintext: &[u8],
    aad: &EnvelopeAad,
) -> Result<Vec<u8>, AeadError> {
    let aad_bytes = canonical::to_canonical_bytes(aad)?;
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .encrypt(
            nonce.into(),
            Payload {
                msg: plaintext,
                aad: &aad_bytes,
            },
        )
        .map_err(|_| AeadError::Encrypt)
}

/// Open a ciphertext produced by [`seal`] / [`seal_with_nonce`]. The caller
/// reconstructs the same `EnvelopeAad` from the wire envelope (the relay
/// surfaces those fields in cleartext for routing) so this side can re-derive
/// the canonical-JSON bytes that were MAC'd in.
///
/// Any failure — wrong key, wrong nonce, tampered ciphertext, mutated AAD —
/// returns [`AeadError::Decrypt`]. We do not distinguish reasons.
pub fn open(
    key: &[u8; 32],
    nonce: &AeadNonce,
    ciphertext: &[u8],
    aad: &EnvelopeAad,
) -> Result<Vec<u8>, AeadError> {
    let aad_bytes = canonical::to_canonical_bytes(aad)?;
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(
            nonce.into(),
            Payload {
                msg: ciphertext,
                aad: &aad_bytes,
            },
        )
        .map_err(|_| AeadError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use serde::Deserialize;

    fn sample_aad() -> EnvelopeAad {
        EnvelopeAad {
            v: 2,
            room_id: "room-abc".into(),
            envelope_id: "env-001".into(),
            kind: "event".into(),
            author_id: "alice".into(),
            device_id: "dev-1".into(),
            created_at: 1_736_012_345_678,
        }
    }

    fn sample_key() -> [u8; 32] {
        // Deterministic test key — never used outside this test module.
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    fn sample_nonce() -> AeadNonce {
        // Deterministic test nonce — never used outside this test module.
        let mut n = [0u8; 24];
        for (i, b) in n.iter_mut().enumerate() {
            *b = 0x10 + i as u8;
        }
        n
    }

    #[test]
    fn roundtrip_returns_original_plaintext() {
        let key = sample_key();
        let plaintext = b"hello world, this is a review event payload";
        let aad = sample_aad();
        let (nonce, ct) = seal(&key, plaintext, &aad).unwrap();
        let pt = open(&key, &nonce, &ct, &aad).unwrap();
        assert_eq!(pt, plaintext);
        // Ciphertext is plaintext length + 16-byte Poly1305 tag.
        assert_eq!(ct.len(), plaintext.len() + 16);
    }

    #[test]
    fn wrong_key_fails_decrypt() {
        let key = sample_key();
        let mut bad_key = key;
        bad_key[0] ^= 0xFF;
        let aad = sample_aad();
        let (nonce, ct) = seal(&key, b"payload", &aad).unwrap();
        assert!(matches!(
            open(&bad_key, &nonce, &ct, &aad),
            Err(AeadError::Decrypt)
        ));
    }

    #[test]
    fn wrong_nonce_fails_decrypt() {
        let key = sample_key();
        let aad = sample_aad();
        let (nonce, ct) = seal(&key, b"payload", &aad).unwrap();
        let mut bad_nonce = nonce;
        bad_nonce[0] ^= 0x01;
        assert!(matches!(
            open(&key, &bad_nonce, &ct, &aad),
            Err(AeadError::Decrypt)
        ));
    }

    #[test]
    fn tampered_ciphertext_fails_decrypt() {
        let key = sample_key();
        let aad = sample_aad();
        let (nonce, mut ct) = seal(&key, b"payload", &aad).unwrap();
        // Flip a byte in the body (not the tag) — Poly1305 must catch it.
        ct[0] ^= 0x01;
        assert!(matches!(
            open(&key, &nonce, &ct, &aad),
            Err(AeadError::Decrypt)
        ));
    }

    #[test]
    fn aad_envelope_id_change_fails_decrypt() {
        // The AAD-binding invariant: a relay (or attacker) cannot pretend a
        // ciphertext belongs to a different envelopeId.
        let key = sample_key();
        let aad = sample_aad();
        let (nonce, ct) = seal(&key, b"payload", &aad).unwrap();
        let mut bad_aad = aad.clone();
        bad_aad.envelope_id = "env-002".into();
        assert!(matches!(
            open(&key, &nonce, &ct, &bad_aad),
            Err(AeadError::Decrypt)
        ));
    }

    #[test]
    fn aad_kind_change_fails_decrypt() {
        // Proves the relay cannot re-route a `kind:"event"` ciphertext under
        // the `kind:"signal"` tag — the kind field is MAC-bound.
        let key = sample_key();
        let aad = sample_aad();
        let (nonce, ct) = seal(&key, b"payload", &aad).unwrap();
        let mut bad_aad = aad.clone();
        bad_aad.kind = "signal".into();
        assert!(matches!(
            open(&key, &nonce, &ct, &bad_aad),
            Err(AeadError::Decrypt)
        ));
    }

    #[test]
    fn aad_author_id_change_fails_decrypt() {
        // Same invariant for authorId — relay cannot relabel an envelope's
        // author after it has been sealed.
        let key = sample_key();
        let aad = sample_aad();
        let (nonce, ct) = seal(&key, b"payload", &aad).unwrap();
        let mut bad_aad = aad.clone();
        bad_aad.author_id = "mallory".into();
        assert!(matches!(
            open(&key, &nonce, &ct, &bad_aad),
            Err(AeadError::Decrypt)
        ));
    }

    #[test]
    fn two_seals_with_same_inputs_use_different_nonces() {
        // Random-nonce invariant: even identical (key, plaintext, AAD) tuples
        // must produce different nonces and therefore different ciphertexts.
        let key = sample_key();
        let aad = sample_aad();
        let (n1, c1) = seal(&key, b"payload", &aad).unwrap();
        let (n2, c2) = seal(&key, b"payload", &aad).unwrap();
        assert_ne!(n1, n2, "random nonces must differ between seals");
        assert_ne!(c1, c2, "different nonces must yield different ciphertexts");
    }

    #[test]
    fn seal_with_nonce_is_deterministic() {
        // Fixed (key, nonce, plaintext, aad) must produce a fixed ciphertext —
        // this is what the cross-impl corpus relies on.
        let key = sample_key();
        let nonce = sample_nonce();
        let aad = sample_aad();
        let c1 = seal_with_nonce(&key, &nonce, b"payload", &aad).unwrap();
        let c2 = seal_with_nonce(&key, &nonce, b"payload", &aad).unwrap();
        assert_eq!(c1, c2);
        // And it roundtrips.
        let pt = open(&key, &nonce, &c1, &aad).unwrap();
        assert_eq!(pt, b"payload");
    }

    #[test]
    fn random_nonce_returns_nonzero_value() {
        // Cheap sanity check on the RNG path — astronomically unlikely to
        // produce all-zero output, so if we ever see it the wiring is broken.
        let n = random_nonce().unwrap();
        assert_ne!(n, [0u8; 24]);
    }

    // ---- cross-implementation corpus replay -----------------------------

    /// Compile-time-embedded corpus shared with the (future) TS/WASM client.
    /// See `planning/collab/test-vectors/aead.json`.
    const CORPUS: &str =
        include_str!("../../../planning/collab/test-vectors/aead.json");

    #[derive(Deserialize)]
    struct CorpusFile {
        #[allow(dead_code)]
        version: u32,
        vectors: Vec<CorpusVector>,
    }

    #[derive(Deserialize)]
    struct CorpusVector {
        name: String,
        #[allow(dead_code)]
        #[serde(rename = "keyKind")]
        key_kind: Option<String>,
        key: String,
        nonce: String,
        plaintext: String,
        /// base64url-no-pad of the canonical-JSON AAD bytes that were MAC'd in.
        aad: String,
        expected: CorpusExpected,
    }

    #[derive(Deserialize)]
    struct CorpusExpected {
        ciphertext: String,
        /// UTF-8 JSON view of `aad` — parsed into our `EnvelopeAad` struct so
        /// we exercise the full canonical-JSON path during replay.
        #[serde(rename = "aadAsJson")]
        aad_as_json: serde_json::Value,
    }

    fn b64(s: &str) -> Vec<u8> {
        B64.decode(s)
            .unwrap_or_else(|e| panic!("corpus base64url decode failed for {s:?}: {e}"))
    }

    /// One-shot regenerator for `planning/collab/test-vectors/aead.json`.
    /// Normally a no-op; set `ATTN_REGEN_AEAD_VECTORS=1` to write a fresh
    /// corpus to disk using the current impl. The vectors are deterministic
    /// (fixed key + fixed nonce + fixed AAD + fixed plaintext) so re-running
    /// without code changes produces byte-identical output.
    ///
    /// Procedure:
    ///   1. ATTN_REGEN_AEAD_VECTORS=1 cargo test review::crypto::aead::tests::regen_corpus
    ///   2. Inspect the diff on planning/collab/test-vectors/aead.json.
    ///   3. Re-run `cargo test review::crypto::aead` to confirm the replay
    ///      test passes against the regenerated corpus.
    #[test]
    fn regen_corpus() {
        if std::env::var("ATTN_REGEN_AEAD_VECTORS").ok().as_deref() != Some("1") {
            return;
        }

        struct VectorInput {
            name: &'static str,
            key_kind: &'static str,
            key: [u8; 32],
            nonce: AeadNonce,
            plaintext: Vec<u8>,
            aad: EnvelopeAad,
        }

        // Vector 1: tiny event envelope (eventKey).
        // Key bytes 0x00..0x1F (deterministic, easy to spot-check across impls).
        let mut k1 = [0u8; 32];
        for (i, b) in k1.iter_mut().enumerate() {
            *b = i as u8;
        }
        let mut n1 = [0u8; 24];
        for (i, b) in n1.iter_mut().enumerate() {
            *b = 0x10 + i as u8;
        }
        let v1 = VectorInput {
            name: "tiny event encrypted with eventKey",
            key_kind: "eventKey",
            key: k1,
            nonce: n1,
            plaintext: br#"{"hello":"world"}"#.to_vec(),
            aad: EnvelopeAad {
                v: 2,
                room_id: "room-aaaa".into(),
                envelope_id: "env-0001".into(),
                kind: "event".into(),
                author_id: "alice".into(),
                device_id: "dev-1".into(),
                created_at: 1_736_012_345_678,
            },
        };

        // Vector 2: snapshot blob (snapshotKey) with non-ASCII plaintext +
        // a different envelope kind. Exercises the AAD `kind` field and a
        // multi-byte UTF-8 plaintext.
        let mut k2 = [0u8; 32];
        for (i, b) in k2.iter_mut().enumerate() {
            *b = 0xA0 ^ (i as u8);
        }
        let mut n2 = [0u8; 24];
        for (i, b) in n2.iter_mut().enumerate() {
            *b = 0xF0 ^ (i as u8);
        }
        let v2 = VectorInput {
            name: "snapshot blob encrypted with snapshotKey",
            key_kind: "snapshotKey",
            key: k2,
            nonce: n2,
            plaintext: "snapshot bytes 🚀 — non-ASCII + emoji".as_bytes().to_vec(),
            aad: EnvelopeAad {
                v: 2,
                room_id: "room-bbbb".into(),
                envelope_id: "env-0002".into(),
                kind: "snapshot_blob".into(),
                author_id: "bob".into(),
                device_id: "dev-2".into(),
                created_at: 1_736_099_999_000,
            },
        };

        let inputs = [v1, v2];
        let vectors: Vec<serde_json::Value> = inputs
            .iter()
            .map(|v| {
                let aad_bytes = canonical::to_canonical_bytes(&v.aad).unwrap();
                let ct =
                    seal_with_nonce(&v.key, &v.nonce, &v.plaintext, &v.aad).unwrap();
                serde_json::json!({
                    "name": v.name,
                    "keyKind": v.key_kind,
                    "key": B64.encode(v.key),
                    "nonce": B64.encode(v.nonce),
                    "plaintext": B64.encode(&v.plaintext),
                    "aad": B64.encode(&aad_bytes),
                    "expected": {
                        "ciphertext": B64.encode(&ct),
                        "aadAsJson": serde_json::to_value(&v.aad).unwrap(),
                    },
                })
            })
            .collect();

        let out = serde_json::json!({
            "_schema": {
                "spec": "planning/collab/crypto-spec.md#envelope-encryption-aead",
                "purpose": "Pin XChaCha20-Poly1305 seal/open with explicit AAD so two implementations interoperate.",
                "format": {
                    "version": "Integer corpus version.",
                    "vectors[].name": "Human label.",
                    "vectors[].key": "base64url-no-pad of the 32-byte AEAD key (either eventKey or snapshotKey, see `keyKind`).",
                    "vectors[].keyKind": "Which logical key this represents: \"eventKey\" | \"snapshotKey\" | \"signalingKey\".",
                    "vectors[].nonce": "base64url-no-pad of the 24-byte XChaCha20 nonce.",
                    "vectors[].plaintext": "base64url-no-pad of the plaintext bytes (typically canonical JSON of a ReviewEvent or snapshot bytes).",
                    "vectors[].aad": "base64url-no-pad of the associated-data bytes (canonical JSON of envelope metadata block — see spec).",
                    "vectors[].expected.ciphertext": "base64url-no-pad of the AEAD output (ciphertext || 16-byte Poly1305 tag, per RustCrypto convention).",
                    "vectors[].expected.aadAsJson": "Convenience: the JSON view of `aad` (camelCase keys) for human inspection and for reconstructing the typed AAD in tests."
                },
                "filledBy": "attn-nnj.1.5 (AEAD wrapper)"
            },
            "version": 1,
            "vectors": vectors,
        });

        // CARGO_MANIFEST_DIR points at the crate root; planning/ lives there.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("planning/collab/test-vectors/aead.json");
        let pretty = serde_json::to_string_pretty(&out).unwrap();
        std::fs::write(&path, pretty + "\n").expect("write aead.json");
        eprintln!("wrote {}", path.display());
    }

    #[test]
    fn corpus_replay_matches_expected_ciphertext() {
        let file: CorpusFile = serde_json::from_str(CORPUS)
            .expect("aead.json corpus must parse");
        assert!(
            file.vectors.len() >= 2,
            "expected >= 2 corpus vectors, got {}",
            file.vectors.len()
        );

        for v in &file.vectors {
            // Reconstruct the typed AAD from the human-readable JSON view —
            // this is the same path a receiver would take: read the relay's
            // cleartext metadata, re-canonicalise it, then call open().
            let aad: EnvelopeAad = serde_json::from_value(v.expected.aad_as_json.clone())
                .unwrap_or_else(|e| {
                    panic!("vector {:?}: aadAsJson does not parse as EnvelopeAad: {e}", v.name)
                });

            // 1. Our canonical-JSON of the typed AAD must equal the raw `aad`
            //    bytes in the corpus. If this fails, canonical JSON has
            //    diverged from spec — fix attn-nnj.1.3, not this test.
            let our_aad_bytes = canonical::to_canonical_bytes(&aad).unwrap();
            let expected_aad_bytes = b64(&v.aad);
            assert_eq!(
                our_aad_bytes, expected_aad_bytes,
                "vector {:?}: AAD canonical bytes diverge from corpus",
                v.name
            );

            // 2. Sealing with the fixed key + nonce must produce the exact
            //    expected ciphertext. This is the cross-impl interop guarantee.
            let key: [u8; 32] = b64(&v.key)
                .try_into()
                .unwrap_or_else(|_| panic!("vector {:?}: key is not 32 bytes", v.name));
            let nonce: AeadNonce = b64(&v.nonce)
                .try_into()
                .unwrap_or_else(|_| panic!("vector {:?}: nonce is not 24 bytes", v.name));
            let plaintext = b64(&v.plaintext);
            let expected_ct = b64(&v.expected.ciphertext);

            let actual_ct = seal_with_nonce(&key, &nonce, &plaintext, &aad).unwrap();
            assert_eq!(
                actual_ct, expected_ct,
                "vector {:?}: ciphertext diverges from corpus",
                v.name
            );

            // 3. And our open() must roundtrip the corpus ciphertext back to
            //    the original plaintext — proves the other direction too.
            let recovered = open(&key, &nonce, &expected_ct, &aad).unwrap();
            assert_eq!(
                recovered, plaintext,
                "vector {:?}: open() did not recover corpus plaintext",
                v.name
            );
        }
    }
}
