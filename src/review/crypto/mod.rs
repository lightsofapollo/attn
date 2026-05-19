//! Room key derivation, envelope encryption/decryption, and signing /
//! verification primitives for the review domain.
//!
//! Spec: `planning/collab/crypto-spec.md` and `planning/collab/data-model.md`
//! §Encrypted Envelopes / §Key Model. Primitives land incrementally across
//! attn-nnj.1.x; this module re-exports the building blocks for downstream
//! consumers (review::ids, review::transport, etc.).

#![allow(dead_code)]

pub mod aead;
pub mod canonical;
pub mod ids;
pub mod kdf;
pub mod pow;
pub mod signing;

// Re-export the canonical-JSON primitives at the `crypto::` level so future
// signers / AEAD callers (attn-nnj.1.5+) can `use crate::review::crypto::*`.
// Marked allow(unused_imports) because no other module consumes these yet.
#[allow(unused_imports)]
pub use canonical::{CanonError, canonicalize_value, to_canonical_bytes, to_canonical_string};
