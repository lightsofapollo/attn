//! Typed newtype wrappers for identifiers and content hashes used across the
//! review domain. Prevents accidental mixing of room/file/snapshot/event ids.
//!
//! Spec: `planning/collab/data-model.md` §Rust Architecture Changes
//! §Typed IDs And Hashes.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Stable identifier for a review room (group of participants reviewing a
/// shared document set).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RoomId(String);

impl RoomId {
    /// Wrap a pre-derived id string (e.g. from `crypto::kdf::derive_room_id`).
    /// Crate-private to keep all id construction routed through the typed
    /// derivation helpers in `crypto::`.
    pub(crate) fn new(id: String) -> Self {
        Self(id)
    }

    /// Borrow the underlying base64url-no-pad string representation.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable identifier for a shared document within a room. Decoupled from
/// the on-disk path so renames don't break references.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FileId(String);

/// Identifier for a snapshot — an immutable point-in-time content version
/// of a `FileId` used as an anchor base.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SnapshotId(String);

/// Identifier for a single review event (comment/suggestion/snapshot/etc).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EventId(String);

/// Identifier for a physical device (one user may have many devices).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DeviceId(String);

impl DeviceId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Identifier for a logical participant (one human/agent in a room).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ParticipantId(String);

/// Hash of canonical UTF-8 bytes of file content. Recomputed on every
/// snapshot creation and working-copy save.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContentHash(String);
