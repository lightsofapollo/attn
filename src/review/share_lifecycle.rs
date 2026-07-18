//! Owner-side durable-share state and relay boundary.
//!
//! The durable local record, concrete authenticated HTTP client, and owner
//! orchestration live together so crash ordering is explicit. `ReviewManager`
//! remains the daemon authority and drives this interface from its existing
//! Tokio runtime; public-link resolution stays in the browser/native visitor
//! adapters.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest as _, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::review::bootstrap::{
    BOOTSTRAP_POW_DIFFICULTY, BOOTSTRAP_POW_TTL_MS, Bootstrapper, DeviceIdentity, InviteTierV3,
    admission_header_value_v3_with_query, build_invite_fragment_v3,
    owner_sig_header_value_with_query,
};
use crate::review::crypto::kdf::{
    ShareLinkTier, derive_room_id_v3, derive_room_key_tree_v3, derive_share_epoch_room_secret,
    derive_share_link_keys,
};
use crate::review::crypto::pow::TokenPool;
use crate::review::ids::RoomId;
use crate::review::share::{
    ShareBundleContext, ShareCapabilityBundle, build_browser_share_invite,
    build_native_share_invite, open_capability_bundle, seal_capability_bundle_with_nonce,
};

const RECORD_VERSION: u32 = 3;
const RECORD_FILENAME: &str = "share.json";
const EMPTY_MANIFEST_DIGEST: &str = "T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU";

#[derive(Debug, thiserror::Error)]
pub enum ShareLifecycleError {
    #[error("invalid durable share: {0}")]
    Invalid(String),
    #[error("durable share not found: {0}")]
    NotFound(String),
    #[error("durable share is revoked: {0}")]
    Revoked(String),
    #[error("durable share store: {0}")]
    Store(String),
    #[error("durable share relay: {0}")]
    Relay(String),
    #[error("ATTN_NOT_IMPLEMENTED: {0}")]
    NotImplemented(String),
}

/// A persisted share root secret. Debug output is always redacted and every
/// in-memory copy is zeroized when dropped.
#[derive(Clone, PartialEq, Eq)]
pub struct ShareSecret([u8; 32]);

impl ShareSecret {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for ShareSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ShareSecret([REDACTED])")
    }
}

impl Drop for ShareSecret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Tier-scoped public bearer from a durable-share URL. Kept distinct from
/// `ShareSecret` so no caller can accidentally treat a visitor capability as
/// the owner's epoch-derivation root.
#[derive(Clone, PartialEq, Eq)]
pub struct ShareLinkSecret([u8; 32]);

impl ShareLinkSecret {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for ShareLinkSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ShareLinkSecret([REDACTED])")
    }
}

impl Drop for ShareLinkSecret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl Serialize for ShareSecret {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded = Zeroizing::new(URL_SAFE_NO_PAD.encode(self.0));
        serializer.serialize_str(encoded.as_str())
    }
}

impl<'de> Deserialize<'de> for ShareSecret {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = Zeroizing::new(String::deserialize(deserializer)?);
        let decoded = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(encoded.as_bytes())
                .map_err(serde::de::Error::custom)?,
        );
        let canonical = Zeroizing::new(URL_SAFE_NO_PAD.encode(decoded.as_slice()));
        if canonical.as_str() != encoded.as_str() {
            return Err(serde::de::Error::custom(
                "share secret must be canonical base64url",
            ));
        }
        decoded
            .as_slice()
            .try_into()
            .map(Self)
            .map_err(|_| serde::de::Error::custom("share secret must decode to 32 bytes"))
    }
}

/// A JSON capability string whose heap allocation is zeroized on drop and
/// whose Debug output never exposes the value.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(Zeroizing<String>);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([REDACTED])")
    }
}

impl Serialize for SecretString {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.expose())
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self::new)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableShareState {
    Active,
    RevokePending,
    Revoked,
}

/// Crash-recoverable owner state. Revoked tombstones intentionally retain the
/// public share id/path but clear `share_secret`, preventing a later daemon
/// boot from accidentally renewing a remotely-revoked share.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableShareRecord {
    pub v: u32,
    pub share_id: String,
    pub share_secret: Option<ShareSecret>,
    pub owner_path: PathBuf,
    pub is_dir: bool,
    pub state: DurableShareState,
    pub epoch: u64,
    pub current_room_id: Option<RoomId>,
    #[serde(default)]
    pub epoch_rooms: BTreeMap<u64, RoomId>,
    #[serde(default)]
    pub drain_cursor: u64,
    /// Highest sequence durably imported into the local room. This can lead
    /// `drain_cursor` while the public pointer update is being retried.
    #[serde(default)]
    pub imported_cursor: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

impl fmt::Debug for DurableShareRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DurableShareRecord")
            .field("v", &self.v)
            .field("share_id", &self.share_id)
            .field(
                "share_secret",
                &self.share_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("owner_path", &self.owner_path)
            .field("is_dir", &self.is_dir)
            .field("state", &self.state)
            .field("epoch", &self.epoch)
            .field("current_room_id", &self.current_room_id)
            .field("epoch_rooms", &self.epoch_rooms)
            .field("drain_cursor", &self.drain_cursor)
            .field("imported_cursor", &self.imported_cursor)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl DurableShareRecord {
    pub fn new(
        share_id: String,
        share_secret: [u8; 32],
        owner_path: PathBuf,
        is_dir: bool,
    ) -> Result<Self, ShareLifecycleError> {
        validate_share_id(&share_id)?;
        let (canonical_path, actual_is_dir) = canonical_share_target(&owner_path)?;
        if canonical_path != owner_path {
            return Err(ShareLifecycleError::Invalid(
                "owner path must already be canonical".into(),
            ));
        }
        if actual_is_dir != is_dir {
            return Err(ShareLifecycleError::Invalid(
                "owner path kind does not match isDir".into(),
            ));
        }
        let record = Self {
            v: RECORD_VERSION,
            share_id,
            share_secret: Some(ShareSecret::new(share_secret)),
            owner_path: canonical_path,
            is_dir,
            state: DurableShareState::Active,
            epoch: 0,
            current_room_id: None,
            epoch_rooms: BTreeMap::new(),
            drain_cursor: 0,
            imported_cursor: 0,
            expires_at: None,
        };
        record.validate_invariants()?;
        Ok(record)
    }

    /// Return the current epoch's deterministic room. Public callers cannot
    /// pre-compute/insert a future mapping; only `transition_epoch` may mint
    /// the next epoch.
    pub fn room_for_epoch(&mut self, epoch: u64) -> Result<RoomId, ShareLifecycleError> {
        self.ensure_active("derive an epoch room")?;
        if epoch != self.epoch {
            return Err(ShareLifecycleError::Invalid(format!(
                "room_for_epoch accepts only current epoch {} (got {epoch})",
                self.epoch
            )));
        }
        let derived = self.derive_room_for_epoch(epoch)?;
        self.epoch_rooms.insert(epoch, derived.clone());
        Ok(derived)
    }

    /// Renewal and epoch creation are fenced as soon as revocation begins.
    pub fn ensure_renewable(&self) -> Result<(), ShareLifecycleError> {
        self.ensure_active("renew the share")
    }

    /// Advance exactly one epoch under an optimistic expected-epoch guard.
    /// The drain cursor may only move forward. This prevents two reconnect
    /// paths from independently skipping an epoch or rolling back an ACK.
    pub fn transition_epoch(
        &mut self,
        expected_epoch: u64,
        next_epoch: u64,
        drained_through: u64,
    ) -> Result<RoomId, ShareLifecycleError> {
        self.ensure_active("advance the share epoch")?;
        if self.epoch != expected_epoch || next_epoch != expected_epoch.saturating_add(1) {
            return Err(ShareLifecycleError::Invalid(format!(
                "epoch transition must be guarded and consecutive (stored={}, expected={expected_epoch}, next={next_epoch})",
                self.epoch
            )));
        }
        if expected_epoch == u64::MAX || drained_through < self.drain_cursor {
            return Err(ShareLifecycleError::Invalid(
                "epoch transition overflowed or rolled back the drain cursor".into(),
            ));
        }
        let room_id = self.derive_room_for_epoch(next_epoch)?;
        self.epoch_rooms.insert(next_epoch, room_id.clone());
        self.epoch = next_epoch;
        self.current_room_id = Some(room_id.clone());
        self.drain_cursor = drained_through;
        self.imported_cursor = self.imported_cursor.max(drained_through);
        self.validate_invariants()?;
        Ok(room_id)
    }

    pub fn revalidate_owner_target(&self) -> Result<(), ShareLifecycleError> {
        let (canonical, is_dir) = canonical_share_target(&self.owner_path)?;
        if canonical != self.owner_path || is_dir != self.is_dir {
            return Err(ShareLifecycleError::Invalid(
                "persisted owner target changed identity or kind".into(),
            ));
        }
        Ok(())
    }

    pub fn begin_revoke(&mut self) -> Result<(), ShareLifecycleError> {
        if self.state == DurableShareState::Revoked {
            return Err(ShareLifecycleError::Revoked(self.share_id.clone()));
        }
        self.state = DurableShareState::RevokePending;
        Ok(())
    }

    pub fn finish_revoke(&mut self) -> Result<(), ShareLifecycleError> {
        if self.state != DurableShareState::RevokePending {
            return Err(ShareLifecycleError::Invalid(
                "revoke can finish only after a persisted revoke-pending state".into(),
            ));
        }
        self.state = DurableShareState::Revoked;
        self.share_secret = None;
        self.current_room_id = None;
        self.epoch_rooms.clear();
        self.expires_at = None;
        Ok(())
    }

    fn ensure_active(&self, action: &str) -> Result<(), ShareLifecycleError> {
        match self.state {
            DurableShareState::Active => Ok(()),
            DurableShareState::RevokePending => Err(ShareLifecycleError::Invalid(format!(
                "cannot {action} while revocation is pending"
            ))),
            DurableShareState::Revoked => Err(ShareLifecycleError::Revoked(self.share_id.clone())),
        }
    }

    fn derive_room_for_epoch(&self, epoch: u64) -> Result<RoomId, ShareLifecycleError> {
        let secret = self.share_secret.as_ref().ok_or_else(|| {
            ShareLifecycleError::Invalid("active share is missing its secret".into())
        })?;
        let epoch_secret = derive_share_epoch_room_secret(secret.expose(), epoch);
        let derived = derive_room_id_v3(epoch_secret.as_bytes());
        if let Some(existing) = self.epoch_rooms.get(&epoch)
            && existing != &derived
        {
            return Err(ShareLifecycleError::Invalid(format!(
                "epoch {epoch} room mapping does not match the share secret"
            )));
        }
        Ok(derived)
    }

    fn validate_invariants(&self) -> Result<(), ShareLifecycleError> {
        if self.v != RECORD_VERSION {
            return Err(ShareLifecycleError::Invalid(format!(
                "unsupported durable share record version {}",
                self.v
            )));
        }
        validate_share_id(&self.share_id)?;
        if self.drain_cursor > self.imported_cursor {
            return Err(ShareLifecycleError::Invalid(
                "ACKable drain cursor exceeds the imported cursor".into(),
            ));
        }
        if !self.owner_path.is_absolute() || self.owner_path.to_str().is_none() {
            return Err(ShareLifecycleError::Invalid(
                "owner path must be absolute UTF-8".into(),
            ));
        }
        match self.state {
            DurableShareState::Active | DurableShareState::RevokePending => {
                if self.share_secret.is_none() {
                    return Err(ShareLifecycleError::Invalid(
                        "active/revoke-pending share is missing its owner secret".into(),
                    ));
                }
            }
            DurableShareState::Revoked => {
                if self.share_secret.is_some()
                    || self.current_room_id.is_some()
                    || !self.epoch_rooms.is_empty()
                    || self.expires_at.is_some()
                {
                    return Err(ShareLifecycleError::Invalid(
                        "revoked tombstone retained live capability state".into(),
                    ));
                }
            }
        }
        let secret = self.share_secret.as_ref();
        for (epoch, room_id) in &self.epoch_rooms {
            if *epoch > self.epoch {
                return Err(ShareLifecycleError::Invalid(
                    "epoch room map contains a future epoch".into(),
                ));
            }
            if let Some(secret) = secret {
                let epoch_secret = derive_share_epoch_room_secret(secret.expose(), *epoch);
                if derive_room_id_v3(epoch_secret.as_bytes()) != *room_id {
                    return Err(ShareLifecycleError::Invalid(format!(
                        "epoch {epoch} room mapping does not match owner secret"
                    )));
                }
            }
        }
        if let Some(current) = &self.current_room_id {
            let mapped = self.epoch_rooms.get(&self.epoch).ok_or_else(|| {
                ShareLifecycleError::Invalid(
                    "current room requires a mapping for the current epoch".into(),
                )
            })?;
            if mapped != current {
                return Err(ShareLifecycleError::Invalid(
                    "current room does not match current epoch mapping".into(),
                ));
            }
        }
        Ok(())
    }
}

/// Filesystem owner for `{runtime_dir}/shares/<shareId>/share.json`.
pub struct DurableShareStore {
    root: PathBuf,
}

impl DurableShareStore {
    pub fn open() -> Result<Self, ShareLifecycleError> {
        let root = crate::daemon::runtime_dir()
            .map_err(|error| ShareLifecycleError::Store(error.to_string()))?
            .join("shares");
        Self::open_at(root)
    }

    pub fn open_at(root: PathBuf) -> Result<Self, ShareLifecycleError> {
        ensure_secure_directory(&root)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn record_path(&self, share_id: &str) -> Result<PathBuf, ShareLifecycleError> {
        validate_share_id(share_id)?;
        Ok(self.root.join(share_id).join(RECORD_FILENAME))
    }

    pub fn save(&self, record: &DurableShareRecord) -> Result<(), ShareLifecycleError> {
        record.validate_invariants()?;
        verify_secure_directory(&self.root)?;
        let path = self.record_path(&record.share_id)?;
        let dir = path.parent().expect("share record has a parent");
        ensure_secure_directory(dir)?;
        sync_directory(&self.root)?;
        let bytes = Zeroizing::new(serde_json::to_vec_pretty(record).map_err(|error| {
            ShareLifecycleError::Store(format!("encode {}: {error}", path.display()))
        })?);
        write_private_atomic(dir, &path, bytes.as_slice())
    }

    pub fn load(&self, share_id: &str) -> Result<DurableShareRecord, ShareLifecycleError> {
        let path = self.record_path(share_id)?;
        verify_secure_directory(&self.root)?;
        verify_secure_directory(path.parent().expect("record parent"))?;
        verify_private_regular_file(&path)?;
        let bytes = Zeroizing::new(std::fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ShareLifecycleError::NotFound(share_id.to_string())
            } else {
                ShareLifecycleError::Store(format!("read {}: {error}", path.display()))
            }
        })?);
        let legacy_without_imported_cursor =
            serde_json::from_slice::<serde_json::Value>(bytes.as_slice())
                .ok()
                .and_then(|value| {
                    value
                        .as_object()
                        .map(|object| !object.contains_key("importedCursor"))
                })
                .unwrap_or(false);
        let mut record =
            serde_json::from_slice::<DurableShareRecord>(bytes.as_slice()).map_err(|error| {
                ShareLifecycleError::Store(format!("decode {}: {error}", path.display()))
            })?;
        if legacy_without_imported_cursor {
            record.imported_cursor = record.drain_cursor;
        }
        record.validate_invariants()?;
        if record.share_id != share_id {
            return Err(ShareLifecycleError::Invalid(
                "durable share record identity/version mismatch".into(),
            ));
        }
        Ok(record)
    }

    pub fn list(&self) -> Result<Vec<DurableShareRecord>, ShareLifecycleError> {
        verify_secure_directory(&self.root)?;
        let entries = std::fs::read_dir(&self.root).map_err(|error| {
            ShareLifecycleError::Store(format!("read {}: {error}", self.root.display()))
        })?;
        let mut records = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| ShareLifecycleError::Store(error.to_string()))?;
            if !entry
                .file_type()
                .map_err(|error| ShareLifecycleError::Store(error.to_string()))?
                .is_dir()
            {
                continue;
            }
            let Some(share_id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_share_id(&share_id).is_ok() {
                records.push(self.load(&share_id)?);
            }
        }
        records.sort_by(|left, right| left.share_id.cmp(&right.share_id));
        Ok(records)
    }

    pub fn resolve(&self, target: &str) -> Result<DurableShareRecord, ShareLifecycleError> {
        if validate_share_id(target).is_ok() {
            return self.load(target);
        }
        let (canonical, _) = canonical_share_target(Path::new(target))?;
        self.list()?
            .into_iter()
            .find(|record| record.owner_path == canonical)
            .ok_or_else(|| ShareLifecycleError::NotFound(target.to_string()))
    }

    pub fn begin_revoke(&self, target: &str) -> Result<DurableShareRecord, ShareLifecycleError> {
        let mut record = self.resolve(target)?;
        record.begin_revoke()?;
        self.save(&record)?;
        Ok(record)
    }

    pub fn finish_revoke(&self, share_id: &str) -> Result<DurableShareRecord, ShareLifecycleError> {
        let mut record = self.load(share_id)?;
        record.finish_revoke()?;
        self.save(&record)?;
        Ok(record)
    }
}

fn validate_share_id(share_id: &str) -> Result<(), ShareLifecycleError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(share_id)
        .map_err(|_| ShareLifecycleError::Invalid("shareId is not base64url".into()))?;
    if decoded.len() != 16 || URL_SAFE_NO_PAD.encode(decoded) != share_id {
        return Err(ShareLifecycleError::Invalid(
            "shareId must be canonical base64url for 16 bytes".into(),
        ));
    }
    Ok(())
}

pub fn canonical_share_target(path: &Path) -> Result<(PathBuf, bool), ShareLifecycleError> {
    if path.to_str().is_none() {
        return Err(ShareLifecycleError::Invalid(
            "share target must be valid UTF-8".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        ShareLifecycleError::Invalid(format!("inspect share target {}: {error}", path.display()))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(ShareLifecycleError::Invalid(
            "share target must not be a symbolic link".into(),
        ));
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        ShareLifecycleError::Invalid(format!("canonicalize {}: {error}", path.display()))
    })?;
    if canonical.to_str().is_none() {
        return Err(ShareLifecycleError::Invalid(
            "canonical share target must be valid UTF-8".into(),
        ));
    }
    if metadata.is_file() {
        let extension = canonical
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !matches_ignore_ascii_case(extension, &["md", "markdown", "html", "htm"]) {
            return Err(ShareLifecycleError::Invalid(
                "share target must be markdown, HTML, or a directory".into(),
            ));
        }
        return Ok((canonical, false));
    }
    if metadata.is_dir() {
        if !directory_contains_shareable_file(&canonical)? {
            return Err(ShareLifecycleError::Invalid(
                "share directory contains no markdown or HTML files".into(),
            ));
        }
        return Ok((canonical, true));
    }
    Err(ShareLifecycleError::Invalid(
        "share target must be a regular file or directory".into(),
    ))
}

fn matches_ignore_ascii_case(value: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn directory_contains_shareable_file(root: &Path) -> Result<bool, ShareLifecycleError> {
    let entries = std::fs::read_dir(root).map_err(|error| {
        ShareLifecycleError::Invalid(format!("read share directory {}: {error}", root.display()))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        let kind = entry
            .file_type()
            .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            if directory_contains_shareable_file(&path)? {
                return Ok(true);
            }
        } else if kind.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| {
                    matches_ignore_ascii_case(value, &["md", "markdown", "html", "htm"])
                })
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_secure_directory(path: &Path) -> Result<(), ShareLifecycleError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(ShareLifecycleError::Store(format!(
                    "{} must be a real directory, not a symlink",
                    path.display()
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path).map_err(|error| {
                ShareLifecycleError::Store(format!("create {}: {error}", path.display()))
            })?;
        }
        Err(error) => {
            return Err(ShareLifecycleError::Store(format!(
                "inspect {}: {error}",
                path.display()
            )));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                ShareLifecycleError::Store(format!("secure directory {}: {error}", path.display()))
            },
        )?;
    }
    verify_secure_directory(path)
}

fn verify_secure_directory(path: &Path) -> Result<(), ShareLifecycleError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        ShareLifecycleError::Store(format!("inspect {}: {error}", path.display()))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ShareLifecycleError::Store(format!(
            "{} is not a secure directory",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            return Err(ShareLifecycleError::Store(format!(
                "{} permissions are not 0700",
                path.display()
            )));
        }
    }
    Ok(())
}

fn verify_private_regular_file(path: &Path) -> Result<(), ShareLifecycleError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ShareLifecycleError::NotFound(path.display().to_string())
        } else {
            ShareLifecycleError::Store(format!("inspect {}: {error}", path.display()))
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ShareLifecycleError::Store(format!(
            "{} is not a private regular file",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err(ShareLifecycleError::Store(format!(
                "{} permissions are not 0600",
                path.display()
            )));
        }
    }
    Ok(())
}

struct TemporaryFileGuard(PathBuf);

impl Drop for TemporaryFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_private_atomic(
    directory: &Path,
    destination: &Path,
    bytes: &[u8],
) -> Result<(), ShareLifecycleError> {
    verify_secure_directory(directory)?;
    let mut random = [0u8; 8];
    getrandom::getrandom(&mut random)
        .map_err(|error| ShareLifecycleError::Store(format!("temp filename rng: {error}")))?;
    let temporary = directory.join(format!(
        ".{RECORD_FILENAME}.{}.tmp",
        URL_SAFE_NO_PAD.encode(random)
    ));
    random.zeroize();
    let guard = TemporaryFileGuard(temporary.clone());
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|error| {
        ShareLifecycleError::Store(format!("open {}: {error}", temporary.display()))
    })?;
    file.write_all(bytes).map_err(|error| {
        ShareLifecycleError::Store(format!("write {}: {error}", temporary.display()))
    })?;
    file.sync_all().map_err(|error| {
        ShareLifecycleError::Store(format!("sync {}: {error}", temporary.display()))
    })?;
    std::fs::rename(&temporary, destination).map_err(|error| {
        ShareLifecycleError::Store(format!(
            "rename {} to {}: {error}",
            temporary.display(),
            destination.display()
        ))
    })?;
    drop(guard);
    if let Some(parent) = destination.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ShareLifecycleError> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                ShareLifecycleError::Store(format!("sync {}: {error}", path.display()))
            })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

// -------------------------------------------------------------------------
// Typed relay seam. An HTTP implementation will supply canonical owner
// signatures, admission MACs, and PoW without leaking those details into the
// state machine.
// -------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareTier {
    View,
    Comment,
    Suggest,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareBundleMutation {
    pub bundle_id: String,
    pub tier: ShareTier,
    pub read_admission_key: SecretString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_admission_key: Option<SecretString>,
    pub sealed_bundle: String,
}

impl fmt::Debug for ShareBundleMutation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShareBundleMutation")
            .field("bundle_id", &self.bundle_id)
            .field("tier", &self.tier)
            .field("read_admission_key", &"[REDACTED]")
            .field(
                "write_admission_key",
                &self.write_admission_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("sealed_bundle", &self.sealed_bundle)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ShareBundleAccess {
    pub bundle_id: String,
    pub tier: ShareTier,
    pub read_admission_key: SecretString,
    pub write_admission_key: Option<SecretString>,
}

impl fmt::Debug for ShareBundleAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShareBundleAccess")
            .field("bundle_id", &self.bundle_id)
            .field("tier", &self.tier)
            .field("read_admission_key", &"[REDACTED]")
            .field(
                "write_admission_key",
                &self.write_admission_key.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedShareSnapshotRef {
    pub file_id: String,
    pub snapshot_id: String,
    pub ciphertext_bytes: u64,
    pub ciphertext_sha256: String,
    pub uploaded_at: u64,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareUpsertRequest {
    pub v: u8,
    pub owner_signing_key: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bundles: Vec<ShareBundleMutation>,
    pub epoch: u64,
    pub revision: u64,
    pub current_room_id: Option<String>,
    pub snapshots: Vec<ManagedShareSnapshotRef>,
    pub placeholders: Vec<serde_json::Value>,
    pub device_id: String,
}

impl fmt::Debug for ShareUpsertRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShareUpsertRequest")
            .field("v", &self.v)
            .field("owner_signing_key", &self.owner_signing_key)
            .field("bundles", &self.bundles)
            .field("epoch", &self.epoch)
            .field("revision", &self.revision)
            .field("current_room_id", &self.current_room_id)
            .field("snapshots", &self.snapshots)
            .field("placeholders", &self.placeholders)
            .field("device_id", &self.device_id)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareMailboxSummary {
    pub count: u64,
    pub bytes: u64,
    pub latest_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRelayRecord {
    pub v: u32,
    pub share_id: String,
    pub owner_signing_key: String,
    pub epoch: u64,
    pub revision: u64,
    pub current_room_id: Option<String>,
    pub snapshots: Vec<ManagedShareSnapshotRef>,
    pub placeholders: Vec<serde_json::Value>,
    pub manifest_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle: Option<SelectedShareBundle>,
    pub updated_at: u64,
    pub expires_at: u64,
    pub mailbox: ShareMailboxSummary,
    pub features: ShareFeatures,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareFeatures {
    pub push: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedShareBundle {
    pub bundle_id: String,
    pub tier: ShareTier,
    pub sealed_bundle: String,
}

/// Resolve a stable public bearer into the currently authenticated ordinary
/// v3 room invite. The returned URL contains only the tier-scoped room leaves
/// from the sealed bundle; the ShareDO admission and bundle keys are dropped.
///
/// Native Join then reuses its existing v3 directory/grant verification and
/// transport path. A missing current room remains a normal Join failure; the
/// retained-snapshot offline adapter is intentionally a separate concern.
pub async fn resolve_public_share_to_room_invite(
    relay_url: &str,
    share_id: &str,
    link_secret: &ShareLinkSecret,
) -> Result<String, ShareLifecycleError> {
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ShareLifecycleError::Relay(error.to_string()))?;
    let path = format!("/v3/shares/{share_id}");
    // Bundle id, bundle key, and read admission are expanded directly from the
    // tier-specific URL bearer and are identical regardless of which enum is
    // passed here. The tier itself is authenticated inside the selected relay
    // record and sealed bundle; it cannot be inferred by probing because it is
    // intentionally absent from the public URL.
    let probe = crate::review::crypto::kdf::expand_share_link_keys(
        link_secret.expose(),
        ShareLinkTier::View,
    );
    let response = http
        .get(format!("{}{}", relay_url.trim_end_matches('/'), path))
        .header("Attn-Share-Bundle", &probe.bundle_id)
        .header(
            "Attn-Admission",
            admission_header_value_v3_with_query(
                probe.read_admission_key.as_bytes(),
                "read",
                "GET",
                &path,
                &[],
                &[],
            ),
        )
        .send()
        .await
        .map_err(|error| ShareLifecycleError::Relay(error.to_string()))?;
    let record: ShareRelayRecord = HttpShareRelayClient::decode_json(response).await?;
    let selected_bundle = record.bundle.as_ref().ok_or_else(|| {
        ShareLifecycleError::Relay("share response omitted the selected bundle".into())
    })?;
    let tier = match selected_bundle.tier {
        ShareTier::View => ShareLinkTier::View,
        ShareTier::Comment => ShareLinkTier::Comment,
        ShareTier::Suggest => ShareLinkTier::Suggest,
    };
    let keys = crate::review::crypto::kdf::expand_share_link_keys(link_secret.expose(), tier);
    if selected_bundle.bundle_id != keys.bundle_id {
        return Err(ShareLifecycleError::Relay(
            "share response selected a mismatched bundle".into(),
        ));
    }
    let manifest_bytes = crate::review::crypto::canonical::to_canonical_bytes(&record.snapshots)
        .map_err(|error| ShareLifecycleError::Invalid(format!("share manifest: {error}")))?;
    let manifest_digest = URL_SAFE_NO_PAD.encode(Sha256::digest(&manifest_bytes));
    if manifest_digest != record.manifest_digest {
        return Err(ShareLifecycleError::Relay(
            "share manifest digest failed authentication".into(),
        ));
    }
    let opened = open_capability_bundle(
        keys.bundle_key.as_bytes(),
        &ShareBundleContext {
            bundle_id: &keys.bundle_id,
            share_id,
            epoch: record.epoch,
            revision: record.revision,
            manifest_digest: &record.manifest_digest,
            tier,
        },
        &selected_bundle.sealed_bundle,
    )
    .map_err(ShareLifecycleError::Invalid)?;
    let current_room = record
        .current_room_id
        .as_deref()
        .ok_or_else(|| ShareLifecycleError::NotFound("stable share has no active room".into()))?;
    if opened.room_id != current_room {
        return Err(ShareLifecycleError::Relay(
            "sealed bundle room does not match the active share pointer".into(),
        ));
    }
    let read: [u8; 32] = URL_SAFE_NO_PAD
        .decode(&opened.read_capability_key)
        .map_err(|_| ShareLifecycleError::Invalid("bundle read capability is invalid".into()))?
        .try_into()
        .map_err(|_| {
            ShareLifecycleError::Invalid("bundle read capability length is invalid".into())
        })?;
    let write = opened
        .write_admission_key
        .as_deref()
        .map(|value| {
            URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| {
                    ShareLifecycleError::Invalid("bundle write capability is invalid".into())
                })?
                .try_into()
                .map_err(|_| {
                    ShareLifecycleError::Invalid("bundle write capability length is invalid".into())
                })
        })
        .transpose()?;
    let grant = opened
        .grant_signature
        .as_deref()
        .map(|value| {
            URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| ShareLifecycleError::Invalid("bundle grant is invalid".into()))?
                .try_into()
                .map_err(|_| ShareLifecycleError::Invalid("bundle grant length is invalid".into()))
        })
        .transpose()?;
    let invite_tier = match tier {
        ShareLinkTier::View => InviteTierV3::View,
        ShareLinkTier::Comment => InviteTierV3::Comment,
        ShareLinkTier::Suggest => InviteTierV3::Suggest,
    };
    let fragment = build_invite_fragment_v3(invite_tier, &read, write.as_ref(), grant.as_ref())
        .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
    Ok(format!("attn://review/{current_room}{fragment}"))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareMailboxItem {
    pub seq: u64,
    pub envelope_id: String,
    pub bytes: u64,
    pub payload: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<ShareTier>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareMailboxPage {
    pub items: Vec<ShareMailboxItem>,
    pub next_after: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle: Option<SelectedShareBundle>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewSubmission {
    v: u8,
    envelope_id: String,
    #[serde(rename = "type")]
    submission_type: String,
    share_id: String,
    epoch: u64,
    room_id: String,
    tier: ShareTier,
    #[serde(default)]
    bundle_id: Option<String>,
    device_registration: ShareDeviceRegistration,
    envelopes: Vec<crate::review::model::MailboxEnvelope>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareDeviceRegistration {
    device_id: String,
    participant_id: String,
    public_signing_key: String,
    public_encryption_key: String,
    client: crate::review::model::DeviceClient,
    kind: crate::review::model::ParticipantKind,
    grant_tier: crate::review::transport::inbound::GrantTier,
    grant_signature: String,
    self_signature: String,
}

pub struct ManagedSnapshotCiphertext {
    pub snapshot_id: String,
    pub ciphertext_sha256: String,
    pub ciphertext: Zeroizing<Vec<u8>>,
}

impl fmt::Debug for ManagedSnapshotCiphertext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedSnapshotCiphertext")
            .field("snapshot_id", &self.snapshot_id)
            .field("ciphertext_sha256", &self.ciphertext_sha256)
            .field(
                "ciphertext",
                &format_args!("[{} bytes]", self.ciphertext.len()),
            )
            .finish()
    }
}

#[async_trait]
pub trait ShareRelayClient: Send + Sync {
    fn device_id(&self) -> &str;
    async fn fetch_share(
        &self,
        share_id: &str,
        access: &ShareBundleAccess,
    ) -> Result<ShareRelayRecord, ShareLifecycleError>;

    async fn create_or_renew(
        &self,
        share_id: &str,
        request: &ShareUpsertRequest,
    ) -> Result<ShareRelayRecord, ShareLifecycleError>;

    async fn fetch_mailbox(
        &self,
        share_id: &str,
        access: &ShareBundleAccess,
        after: u64,
        limit: u16,
    ) -> Result<ShareMailboxPage, ShareLifecycleError>;

    async fn ack_mailbox(&self, share_id: &str, through: u64) -> Result<(), ShareLifecycleError>;

    async fn revoke_share(&self, share_id: &str) -> Result<(), ShareLifecycleError>;

    async fn upload_snapshot(
        &self,
        share_id: &str,
        file_id: &str,
        snapshot_id: &str,
        ciphertext: &[u8],
    ) -> Result<ManagedShareSnapshotRef, ShareLifecycleError>;

    async fn fetch_snapshot(
        &self,
        share_id: &str,
        file_id: &str,
        access: &ShareBundleAccess,
    ) -> Result<ManagedSnapshotCiphertext, ShareLifecycleError>;
}

/// Concrete owner/share HTTP client. Canonical request bytes, scoped
/// admission HMACs, owner signatures, and PoW all reuse the room bootstrap
/// primitives so share endpoints cannot drift onto a second auth scheme.
pub struct HttpShareRelayClient {
    relay_url: String,
    http: reqwest::Client,
    signing_key: crate::review::crypto::signing::DeviceSigningKey,
    device_id: String,
}

impl HttpShareRelayClient {
    pub fn new(relay_url: String, identity: &DeviceIdentity) -> Result<Self, ShareLifecycleError> {
        let signing_key = identity
            .signing_key()
            .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|error| ShareLifecycleError::Relay(error.to_string()))?;
        Ok(Self {
            relay_url: relay_url.trim_end_matches('/').to_owned(),
            http,
            signing_key,
            device_id: identity.device_id.clone(),
        })
    }

    #[cfg(test)]
    fn with_http_client(
        relay_url: String,
        identity: &DeviceIdentity,
        http: reqwest::Client,
    ) -> Result<Self, ShareLifecycleError> {
        let mut client = Self::new(relay_url, identity)?;
        client.http = http;
        Ok(client)
    }

    async fn pow(
        &self,
        share_id: &str,
        method: &str,
        path: &str,
    ) -> Result<String, ShareLifecycleError> {
        TokenPool::new(
            share_id.to_owned(),
            self.device_id.clone(),
            BOOTSTRAP_POW_DIFFICULTY,
            BOOTSTRAP_POW_TTL_MS,
        )
        .take(method, path)
        .await
        .map_err(|error| ShareLifecycleError::Relay(format!("share PoW: {error}")))
    }

    async fn owner_response(
        &self,
        share_id: &str,
        method: reqwest::Method,
        path: &str,
        query: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<reqwest::Response, ShareLifecycleError> {
        let method_wire = method.as_str();
        let mut request = self
            .http
            .request(method.clone(), format!("{}{}", self.relay_url, path))
            .header(
                "Attn-Owner-Signature",
                owner_sig_header_value_with_query(
                    &self.signing_key,
                    method_wire,
                    path,
                    query,
                    &body,
                ),
            )
            .header("Attn-PoW", self.pow(share_id, method_wire, path).await?)
            .header("Attn-Device-Id", &self.device_id);
        if !query.is_empty() {
            request = request.query(query);
        }
        if !body.is_empty() {
            request = request
                .header(
                    reqwest::header::CONTENT_TYPE,
                    if method == reqwest::Method::PUT {
                        "application/octet-stream"
                    } else {
                        "application/json; charset=utf-8"
                    },
                )
                .body(body);
        }
        request
            .send()
            .await
            .map_err(|error| ShareLifecycleError::Relay(format!("{method_wire} {path}: {error}")))
    }

    async fn decode_json<T: serde::de::DeserializeOwned>(
        response: reqwest::Response,
    ) -> Result<T, ShareLifecycleError> {
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ShareLifecycleError::Relay(format!("read relay response: {error}")))?;
        if !status.is_success() {
            return Err(relay_failure(status.as_u16(), &bytes));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| ShareLifecycleError::Relay(format!("decode relay response: {error}")))
    }
}

#[derive(Deserialize)]
struct ShareRelayErrorBody {
    error: ShareRelayError,
}
#[derive(Deserialize)]
struct ShareRelayError {
    code: String,
    #[serde(default)]
    message: String,
}

fn relay_failure(status: u16, bytes: &[u8]) -> ShareLifecycleError {
    let parsed = serde_json::from_slice::<ShareRelayErrorBody>(bytes).ok();
    let code = parsed
        .as_ref()
        .map(|value| value.error.code.as_str())
        .unwrap_or("ATTN_UNKNOWN");
    let message = parsed
        .as_ref()
        .map(|value| value.error.message.as_str())
        .unwrap_or("relay rejected durable share request");
    if status == 404 {
        ShareLifecycleError::NotFound(format!("{code}: {message}"))
    } else {
        ShareLifecycleError::Relay(format!("http {status}: {code}: {message}"))
    }
}

#[async_trait]
impl ShareRelayClient for HttpShareRelayClient {
    fn device_id(&self) -> &str {
        &self.device_id
    }
    async fn fetch_share(
        &self,
        share_id: &str,
        access: &ShareBundleAccess,
    ) -> Result<ShareRelayRecord, ShareLifecycleError> {
        let path = format!("/v3/shares/{share_id}");
        let key = decode_key(access.read_admission_key.expose(), "share read admission")?;
        let response = self
            .http
            .get(format!("{}{}", self.relay_url, path))
            .header("Attn-Share-Bundle", &access.bundle_id)
            .header(
                "Attn-Admission",
                admission_header_value_v3_with_query(&key, "read", "GET", &path, &[], &[]),
            )
            .send()
            .await
            .map_err(|error| ShareLifecycleError::Relay(error.to_string()))?;
        let record: ShareRelayRecord = Self::decode_json(response).await?;
        if record.v != 3
            || record.share_id != share_id
            || record.bundle.as_ref().is_none_or(|bundle| {
                bundle.bundle_id != access.bundle_id || bundle.tier != access.tier
            })
        {
            return Err(ShareLifecycleError::Relay(
                "share GET returned a mismatched selected bundle".into(),
            ));
        }
        Ok(record)
    }

    async fn create_or_renew(
        &self,
        share_id: &str,
        request: &ShareUpsertRequest,
    ) -> Result<ShareRelayRecord, ShareLifecycleError> {
        let path = format!("/v3/shares/{share_id}");
        let body = serde_json::to_vec(request)
            .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        let response = self
            .owner_response(share_id, reqwest::Method::POST, &path, &[], body)
            .await?;
        Self::decode_json(response).await
    }

    async fn fetch_mailbox(
        &self,
        share_id: &str,
        access: &ShareBundleAccess,
        after: u64,
        limit: u16,
    ) -> Result<ShareMailboxPage, ShareLifecycleError> {
        let path = format!("/v3/shares/{share_id}/mailbox");
        let query = vec![
            ("after".into(), after.to_string()),
            ("limit".into(), limit.to_string()),
        ];
        let key = decode_key(access.read_admission_key.expose(), "share read admission")?;
        let response = self
            .http
            .get(format!("{}{}", self.relay_url, path))
            .query(&query)
            .header("Attn-Share-Bundle", &access.bundle_id)
            .header(
                "Attn-Admission",
                admission_header_value_v3_with_query(&key, "read", "GET", &path, &query, &[]),
            )
            .send()
            .await
            .map_err(|error| ShareLifecycleError::Relay(error.to_string()))?;
        let page: ShareMailboxPage = Self::decode_json(response).await?;
        if page
            .bundle
            .as_ref()
            .is_none_or(|bundle| bundle.bundle_id != access.bundle_id || bundle.tier != access.tier)
        {
            return Err(ShareLifecycleError::Relay(
                "mailbox GET returned a mismatched selected bundle".into(),
            ));
        }
        Ok(page)
    }

    async fn ack_mailbox(&self, share_id: &str, through: u64) -> Result<(), ShareLifecycleError> {
        let path = format!("/v3/shares/{share_id}/mailbox");
        let query = vec![("through".into(), through.to_string())];
        let response = self
            .owner_response(share_id, reqwest::Method::DELETE, &path, &query, vec![])
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            let status = response.status().as_u16();
            let bytes = response.bytes().await.unwrap_or_default();
            Err(relay_failure(status, &bytes))
        }
    }

    async fn revoke_share(&self, share_id: &str) -> Result<(), ShareLifecycleError> {
        let path = format!("/v3/shares/{share_id}");
        let response = self
            .owner_response(share_id, reqwest::Method::DELETE, &path, &[], vec![])
            .await?;
        if response.status().is_success() || response.status().as_u16() == 404 {
            Ok(())
        } else {
            let status = response.status().as_u16();
            let bytes = response.bytes().await.unwrap_or_default();
            Err(relay_failure(status, &bytes))
        }
    }

    async fn upload_snapshot(
        &self,
        share_id: &str,
        file_id: &str,
        snapshot_id: &str,
        ciphertext: &[u8],
    ) -> Result<ManagedShareSnapshotRef, ShareLifecycleError> {
        let path = format!("/v3/shares/{share_id}/snapshots/{file_id}/{snapshot_id}");
        let response = self
            .owner_response(
                share_id,
                reqwest::Method::PUT,
                &path,
                &[],
                ciphertext.to_vec(),
            )
            .await?;
        Self::decode_json(response).await
    }

    async fn fetch_snapshot(
        &self,
        share_id: &str,
        file_id: &str,
        access: &ShareBundleAccess,
    ) -> Result<ManagedSnapshotCiphertext, ShareLifecycleError> {
        let path = format!("/v3/shares/{share_id}/snapshots/{file_id}");
        let key = decode_key(access.read_admission_key.expose(), "share read admission")?;
        let response = self
            .http
            .get(format!("{}{}", self.relay_url, path))
            .header("Attn-Share-Bundle", &access.bundle_id)
            .header(
                "Attn-Admission",
                admission_header_value_v3_with_query(&key, "read", "GET", &path, &[], &[]),
            )
            .send()
            .await
            .map_err(|error| ShareLifecycleError::Relay(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let bytes = response.bytes().await.unwrap_or_default();
            return Err(relay_failure(status.as_u16(), &bytes));
        }
        let selected_bundle = response
            .headers()
            .get("Attn-Share-Bundle")
            .and_then(|value| value.to_str().ok());
        let selected_tier = response
            .headers()
            .get("Attn-Share-Tier")
            .and_then(|value| value.to_str().ok());
        let expected_tier = match access.tier {
            ShareTier::View => "view",
            ShareTier::Comment => "comment",
            ShareTier::Suggest => "suggest",
        };
        if selected_bundle != Some(access.bundle_id.as_str())
            || selected_tier != Some(expected_tier)
        {
            return Err(ShareLifecycleError::Relay(
                "snapshot GET returned a mismatched selected bundle".into(),
            ));
        }
        let snapshot_id = response
            .headers()
            .get("Attn-Snapshot-Id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let ciphertext_sha256 = response
            .headers()
            .get("Attn-Ciphertext-Sha256")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let ciphertext = Zeroizing::new(
            response
                .bytes()
                .await
                .map_err(|error| ShareLifecycleError::Relay(error.to_string()))?
                .to_vec(),
        );
        Ok(ManagedSnapshotCiphertext {
            snapshot_id,
            ciphertext_sha256,
            ciphertext,
        })
    }
}

fn decode_key(value: &str, label: &str) -> Result<[u8; 32], ShareLifecycleError> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| ShareLifecycleError::Invalid(format!("{label} is not base64url")))?,
    );
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| ShareLifecycleError::Invalid(format!("{label} must be 32 bytes")))
}

fn decode_signature(value: &str, label: &str) -> Result<[u8; 64], ShareLifecycleError> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| ShareLifecycleError::Invalid(format!("{label} is not base64url")))?,
    );
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| ShareLifecycleError::Invalid(format!("{label} must be 64 bytes")))
}

fn root_for(record: &DurableShareRecord) -> Result<&[u8; 32], ShareLifecycleError> {
    record
        .share_secret
        .as_ref()
        .map(ShareSecret::expose)
        .ok_or_else(|| ShareLifecycleError::Invalid("active share lost root".into()))
}

fn submission_bundle_id(root: &[u8; 32], tier: ShareTier) -> String {
    derive_share_link_keys(
        root,
        match tier {
            ShareTier::View => ShareLinkTier::View,
            ShareTier::Comment => ShareLinkTier::Comment,
            ShareTier::Suggest => ShareLinkTier::Suggest,
        },
    )
    .bundle_id
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableShareLinks {
    pub share_id: String,
    pub room_id: RoomId,
    pub owner_display_path: String,
    pub owner_signing_key: String,
    pub view_native: String,
    pub view_browser: String,
    pub comment_native: String,
    pub comment_browser: String,
    pub suggest_native: String,
    pub suggest_browser: String,
    pub expires_at: u64,
}

impl fmt::Debug for DurableShareLinks {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DurableShareLinks")
            .field("share_id", &self.share_id)
            .field("room_id", &self.room_id)
            .field("owner_display_path", &self.owner_display_path)
            .field("owner_signing_key", &self.owner_signing_key)
            .field("view_native", &"[REDACTED]")
            .field("view_browser", &"[REDACTED]")
            .field("comment_native", &"[REDACTED]")
            .field("comment_browser", &"[REDACTED]")
            .field("suggest_native", &"[REDACTED]")
            .field("suggest_browser", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl Drop for DurableShareLinks {
    fn drop(&mut self) {
        self.view_native.zeroize();
        self.view_browser.zeroize();
        self.comment_native.zeroize();
        self.comment_browser.zeroize();
        self.suggest_native.zeroize();
        self.suggest_browser.zeroize();
    }
}

pub struct DurableShareService {
    store: Arc<DurableShareStore>,
    review_store: Arc<crate::review::store::ReviewStore>,
    relay: Arc<dyn ShareRelayClient>,
    bootstrap: Arc<Bootstrapper>,
    operation_lock: tokio::sync::Mutex<()>,
    notifications: Option<Arc<crate::review::notifications::ReviewNotifications>>,
}

impl DurableShareService {
    pub fn new(
        store: Arc<DurableShareStore>,
        review_store: Arc<crate::review::store::ReviewStore>,
        relay: Arc<dyn ShareRelayClient>,
        bootstrap: Arc<Bootstrapper>,
    ) -> Self {
        Self {
            store,
            review_store,
            relay,
            bootstrap,
            operation_lock: tokio::sync::Mutex::new(()),
            notifications: None,
        }
    }

    pub fn with_notification_observer(
        mut self,
        notifications: Arc<crate::review::notifications::ReviewNotifications>,
    ) -> Self {
        self.notifications = Some(notifications);
        self
    }

    pub async fn create(&self, path: &Path) -> Result<DurableShareLinks, ShareLifecycleError> {
        let _operation = self.operation_lock.lock().await;
        self.create_locked(path).await
    }

    async fn create_locked(&self, path: &Path) -> Result<DurableShareLinks, ShareLifecycleError> {
        let (canonical, is_dir) = canonical_share_target(path)?;
        if self.store.list()?.iter().any(|record| {
            record.owner_path == canonical && record.state != DurableShareState::Revoked
        }) {
            return Err(ShareLifecycleError::Invalid(
                "owner target already has a durable share".into(),
            ));
        }
        let mut share_id_bytes = [0u8; 16];
        let mut share_secret = [0u8; 32];
        getrandom::getrandom(&mut share_id_bytes)
            .map_err(|error| ShareLifecycleError::Invalid(format!("share id rng: {error}")))?;
        getrandom::getrandom(&mut share_secret)
            .map_err(|error| ShareLifecycleError::Invalid(format!("share root rng: {error}")))?;
        let share_id = URL_SAFE_NO_PAD.encode(share_id_bytes);
        share_id_bytes.zeroize();
        let record = DurableShareRecord::new(share_id, share_secret, canonical, is_dir)?;
        share_secret.zeroize();
        // Intent first: a crash can only leave a locally recoverable active
        // record with no public pointer, never an untracked remote share.
        self.store.save(&record)?;

        self.complete_create(record).await
    }

    async fn complete_create(
        &self,
        mut record: DurableShareRecord,
    ) -> Result<DurableShareLinks, ShareLifecycleError> {
        let share_id = record.share_id.clone();
        let secret = record
            .share_secret
            .as_ref()
            .ok_or_else(|| ShareLifecycleError::Invalid("share intent lost its root".into()))?;
        let epoch_secret = derive_share_epoch_room_secret(secret.expose(), 0);
        let epoch = self
            .bootstrap
            .create_durable_epoch_room(record.owner_path.clone(), *epoch_secret.as_bytes())
            .await
            .map_err(bootstrap_failure)?;
        let access = bundle_access(secret.expose(), ShareLinkTier::View);
        let existing = self.relay.fetch_share(&share_id, &access).await;
        let initial = match existing {
            Ok(remote) => remote,
            Err(ShareLifecycleError::NotFound(_)) => {
                let empty_bundles = build_bundles(
                    secret.expose(),
                    &share_id,
                    0,
                    0,
                    EMPTY_MANIFEST_DIGEST,
                    &epoch,
                )?;
                let request = ShareUpsertRequest {
                    v: 3,
                    owner_signing_key: epoch.owner_signing_key.clone(),
                    bundles: empty_bundles,
                    epoch: 0,
                    revision: 0,
                    // Keep the public pointer dark until every retained
                    // snapshot is uploaded and the final sealed bundles bind
                    // the server-authoritative manifest.
                    current_room_id: None,
                    snapshots: vec![],
                    placeholders: vec![],
                    device_id: epoch.device_id.clone(),
                };
                self.relay.create_or_renew(&share_id, &request).await?
            }
            Err(error) => return Err(error),
        };

        let desired_snapshots = epoch
            .snapshots
            .iter()
            .map(|snapshot| (snapshot.file_id.as_str(), snapshot.snapshot_id.as_str()))
            .collect::<std::collections::HashSet<_>>();
        let manifest_is_exact = retained_manifest_is_exact(&initial.snapshots, &desired_snapshots);
        if initial.current_room_id.as_deref() == Some(epoch.room_id.as_str()) && manifest_is_exact {
            // Crash after the final remote pointer flip but before the local
            // active save. Only an exact current-source manifest may take the
            // no-op shortcut; offline edits/deletes must reconcile first.
            record.current_room_id = Some(epoch.room_id.clone());
            record.epoch_rooms.insert(0, epoch.room_id);
            record.expires_at = Some(initial.expires_at);
            self.store.save(&record)?;
            return links_for(&record, initial.expires_at, initial.owner_signing_key);
        }

        let snapshot_key = derive_room_key_tree_v3(epoch_secret.as_bytes())
            .read_keys
            .snapshot_key;
        // Uploads only stage ciphertext on the relay; nothing joiners can
        // observe changes until the single commit upsert below lands the
        // manifest, pointer, revision, and re-sealed bundles together. Files
        // absent from the committed manifest are removed by that same commit.
        let mut next_manifest: Vec<ManagedShareSnapshotRef> = Vec::new();
        for snapshot in &epoch.snapshots {
            if let Some(retained) = initial.snapshots.iter().find(|candidate| {
                candidate.file_id == snapshot.file_id.as_str()
                    && candidate.snapshot_id == snapshot.snapshot_id.as_str()
            }) {
                next_manifest.push(retained.clone());
                continue;
            }
            let sealed = seal_managed_snapshot(&share_id, 0, snapshot, snapshot_key.as_bytes())?;
            next_manifest.push(
                self.relay
                    .upload_snapshot(
                        &share_id,
                        snapshot.file_id.as_str(),
                        snapshot.snapshot_id.as_str(),
                        &sealed,
                    )
                    .await?,
            );
        }
        next_manifest.sort_by(|left, right| left.file_id.cmp(&right.file_id));
        let manifest_digest = manifest_digest_for(&next_manifest)?;
        let final_revision = initial.revision.checked_add(1).ok_or_else(|| {
            ShareLifecycleError::Invalid("share revision exhausted during create".into())
        })?;
        let synced_bundles = build_bundles(
            secret.expose(),
            &share_id,
            0,
            final_revision,
            &manifest_digest,
            &epoch,
        )?;
        let synced = ShareUpsertRequest {
            v: 3,
            owner_signing_key: epoch.owner_signing_key,
            bundles: synced_bundles,
            epoch: 0,
            revision: final_revision,
            current_room_id: Some(epoch.room_id.as_str().to_owned()),
            snapshots: next_manifest,
            placeholders: initial.placeholders.clone(),
            device_id: epoch.device_id,
        };
        let active = self.relay.create_or_renew(&share_id, &synced).await?;
        record.current_room_id = Some(epoch.room_id.clone());
        record.epoch_rooms.insert(0, epoch.room_id);
        record.expires_at = Some(active.expires_at);
        self.store.save(&record)?;
        links_for(&record, active.expires_at, active.owner_signing_key)
    }

    pub async fn renew(
        &self,
        target: Option<&str>,
    ) -> Result<Vec<DurableShareLinks>, ShareLifecycleError> {
        let _operation = self.operation_lock.lock().await;
        self.renew_locked(target).await
    }

    async fn renew_locked(
        &self,
        target: Option<&str>,
    ) -> Result<Vec<DurableShareLinks>, ShareLifecycleError> {
        let records = match target {
            Some(value) => vec![self.store.resolve(value)?],
            None => self.store.list()?,
        };
        let mut links = Vec::new();
        for mut record in records {
            match record.state {
                DurableShareState::Revoked => continue,
                DurableShareState::RevokePending => {
                    self.finish_pending_revoke(&record.share_id).await?;
                    continue;
                }
                DurableShareState::Active => {}
            }
            record.revalidate_owner_target()?;
            if record.current_room_id.is_none() {
                links.push(self.complete_create(record).await?);
                continue;
            }
            if record.drain_cursor > 0 {
                // Retry a crash after cursor persistence/pointer update but
                // before the prior prefix ACK, before taking a fresh summary.
                self.relay
                    .ack_mailbox(&record.share_id, record.drain_cursor)
                    .await?;
            }
            let secret = record
                .share_secret
                .as_ref()
                .ok_or_else(|| ShareLifecycleError::Invalid("active share lost root".into()))?;
            let epoch_secret = derive_share_epoch_room_secret(secret.expose(), record.epoch);
            let room_was_missing = self
                .bootstrap
                .touch_durable_epoch_room(*epoch_secret.as_bytes())
                .await
                .map_err(bootstrap_failure)?;
            if room_was_missing {
                self.republish_same_epoch(&mut record, *epoch_secret.as_bytes())
                    .await?;
            } else {
                let access = bundle_access(secret.expose(), ShareLinkTier::View);
                let remote = self.relay.fetch_share(&record.share_id, &access).await?;
                if remote.share_id != record.share_id
                    || remote.epoch != record.epoch
                    || remote.current_room_id.as_deref()
                        != record.current_room_id.as_ref().map(RoomId::as_str)
                {
                    return Err(ShareLifecycleError::Invalid(
                        "relay share routing does not match durable owner state".into(),
                    ));
                }
                let drained = self.drain_mailbox(&record, &remote).await?;
                if let Some(through) = drained {
                    record.imported_cursor = record.imported_cursor.max(through);
                    // Persist terminal handling before issuing the prefix ACK.
                    // A crash or transient DELETE failure retries the exact
                    // idempotent ACK on the next renewal; it never reclassifies
                    // a poison item or loses an imported valid submission.
                    record.drain_cursor = through;
                    self.store.save(&record)?;
                    self.relay.ack_mailbox(&record.share_id, through).await?;
                }
                if drained.is_none() && remote.mailbox.count > 0 {
                    return Err(ShareLifecycleError::Invalid(
                        "durable mailbox count could not be reconciled across tier selectors"
                            .into(),
                    ));
                }
                let touched = if drained.is_none() {
                    self.sync_latest_snapshots(&record, &remote, *epoch_secret.as_bytes())
                        .await?
                } else {
                    let request = ShareUpsertRequest {
                        v: 3,
                        owner_signing_key: remote.owner_signing_key.clone(),
                        bundles: vec![],
                        epoch: record.epoch,
                        revision: remote.revision,
                        current_room_id: remote.current_room_id.clone(),
                        snapshots: remote.snapshots.clone(),
                        placeholders: remote.placeholders.clone(),
                        device_id: self.relay.device_id().to_owned(),
                    };
                    self.relay
                        .create_or_renew(&record.share_id, &request)
                        .await?
                };
                record.expires_at = Some(touched.expires_at);
                self.store.save(&record)?;
            }
            let remote = self
                .relay
                .fetch_share(
                    &record.share_id,
                    &bundle_access(
                        record
                            .share_secret
                            .as_ref()
                            .expect("active checked")
                            .expose(),
                        ShareLinkTier::View,
                    ),
                )
                .await?;
            links.push(links_for(
                &record,
                record.expires_at.unwrap_or_default(),
                remote.owner_signing_key,
            )?);
        }
        Ok(links)
    }

    async fn sync_latest_snapshots(
        &self,
        record: &DurableShareRecord,
        remote: &ShareRelayRecord,
        epoch_secret: [u8; 32],
    ) -> Result<ShareRelayRecord, ShareLifecycleError> {
        let snapshot_key = derive_room_key_tree_v3(&epoch_secret)
            .read_keys
            .snapshot_key;
        let outcome = self
            .bootstrap
            .create_durable_epoch_room(record.owner_path.clone(), epoch_secret)
            .await
            .map_err(bootstrap_failure)?;
        // Build the desired manifest from retained refs plus freshly staged
        // uploads; the commit upsert below is the only observable mutation,
        // and it removes files by omitting them from the committed manifest.
        let mut next_manifest: Vec<ManagedShareSnapshotRef> = Vec::new();
        for snapshot in &outcome.snapshots {
            if let Some(retained) = remote.snapshots.iter().find(|candidate| {
                candidate.file_id == snapshot.file_id.as_str()
                    && candidate.snapshot_id == snapshot.snapshot_id.as_str()
            }) {
                next_manifest.push(retained.clone());
                continue;
            }
            let sealed = seal_managed_snapshot(
                &record.share_id,
                record.epoch,
                snapshot,
                snapshot_key.as_bytes(),
            )?;
            next_manifest.push(
                self.relay
                    .upload_snapshot(
                        &record.share_id,
                        snapshot.file_id.as_str(),
                        snapshot.snapshot_id.as_str(),
                        &sealed,
                    )
                    .await?,
            );
        }
        next_manifest.sort_by(|left, right| left.file_id.cmp(&right.file_id));
        let changed = next_manifest != remote.snapshots;
        let request = if changed {
            let manifest_digest = manifest_digest_for(&next_manifest)?;
            let revision = remote.revision.checked_add(1).ok_or_else(|| {
                ShareLifecycleError::Invalid("share revision exhausted during sync".into())
            })?;
            ShareUpsertRequest {
                v: 3,
                owner_signing_key: remote.owner_signing_key.clone(),
                bundles: build_bundles(
                    root_for(record)?,
                    &record.share_id,
                    record.epoch,
                    revision,
                    &manifest_digest,
                    &outcome,
                )?,
                epoch: record.epoch,
                revision,
                current_room_id: remote.current_room_id.clone(),
                snapshots: next_manifest,
                placeholders: remote.placeholders.clone(),
                device_id: outcome.device_id,
            }
        } else {
            // Nothing changed: a bare touch renews the pointer lifetime
            // without moving the committed projection.
            ShareUpsertRequest {
                v: 3,
                owner_signing_key: remote.owner_signing_key.clone(),
                bundles: vec![],
                epoch: record.epoch,
                revision: remote.revision,
                current_room_id: remote.current_room_id.clone(),
                snapshots: remote.snapshots.clone(),
                placeholders: remote.placeholders.clone(),
                device_id: outcome.device_id,
            }
        };
        self.relay.create_or_renew(&record.share_id, &request).await
    }

    async fn republish_same_epoch(
        &self,
        record: &mut DurableShareRecord,
        epoch_secret: [u8; 32],
    ) -> Result<(), ShareLifecycleError> {
        let outcome = self
            .bootstrap
            .create_durable_epoch_room(record.owner_path.clone(), epoch_secret)
            .await
            .map_err(bootstrap_failure)?;
        let secret = record
            .share_secret
            .as_ref()
            .ok_or_else(|| ShareLifecycleError::Invalid("active share lost root".into()))?;
        let access = bundle_access(secret.expose(), ShareLinkTier::View);
        let remote = self.relay.fetch_share(&record.share_id, &access).await?;
        let drained = self.drain_mailbox(record, &remote).await?;
        if let Some(through) = drained {
            record.imported_cursor = record.imported_cursor.max(through);
            record.drain_cursor = through;
            self.store.save(record)?;
            // Drain/ACK before changing a missing-room pointer. ShareDO
            // intentionally fences routing changes while retained mail
            // exists; terminal poison must not make that fence permanent.
            self.relay.ack_mailbox(&record.share_id, through).await?;
        }
        // Same epoch means retained snapshots and the already-published
        // sealed capability projection remain valid. Re-sealing introduces a
        // fresh nonce and would look like a projection change to ShareDO,
        // which is intentionally fenced while mail awaits ACK.
        let current = self.relay.fetch_share(&record.share_id, &access).await?;
        let request = ShareUpsertRequest {
            v: 3,
            owner_signing_key: remote.owner_signing_key,
            bundles: vec![],
            epoch: record.epoch,
            revision: current.revision,
            current_room_id: Some(outcome.room_id.as_str().to_owned()),
            snapshots: current.snapshots,
            placeholders: current.placeholders,
            device_id: outcome.device_id,
        };
        let live = self
            .relay
            .create_or_renew(&record.share_id, &request)
            .await?;
        record.current_room_id = Some(outcome.room_id.clone());
        record.epoch_rooms.insert(record.epoch, outcome.room_id);
        record.expires_at = Some(live.expires_at);
        self.store.save(record)?;
        Ok(())
    }

    pub async fn revoke(&self, target: &str) -> Result<(), ShareLifecycleError> {
        let _operation = self.operation_lock.lock().await;
        let pending = self.store.begin_revoke(target)?;
        self.finish_pending_revoke(&pending.share_id).await
    }

    async fn finish_pending_revoke(&self, share_id: &str) -> Result<(), ShareLifecycleError> {
        self.relay.revoke_share(share_id).await?;
        self.store.finish_revoke(share_id)?;
        Ok(())
    }

    async fn drain_mailbox(
        &self,
        record: &DurableShareRecord,
        remote: &ShareRelayRecord,
    ) -> Result<Option<u64>, ShareLifecycleError> {
        let root = record
            .share_secret
            .as_ref()
            .ok_or_else(|| ShareLifecycleError::Invalid("active share lost root".into()))?;
        let mut items = BTreeMap::<u64, ShareMailboxItem>::new();
        for tier in [ShareLinkTier::Comment, ShareLinkTier::Suggest] {
            let access = bundle_access(root.expose(), tier);
            let mut after = record.drain_cursor;
            loop {
                let page = self
                    .relay
                    .fetch_mailbox(&record.share_id, &access, after, 100)
                    .await?;
                if page.items.is_empty() {
                    break;
                }
                if page.next_after <= after {
                    return Err(ShareLifecycleError::Relay(
                        "mailbox page cursor did not advance".into(),
                    ));
                }
                for item in page.items {
                    if items.insert(item.seq, item).is_some() {
                        return Err(ShareLifecycleError::Invalid(
                            "mailbox returned duplicate sequence".into(),
                        ));
                    }
                }
                after = page.next_after;
            }
        }
        if items.is_empty() {
            return Ok(None);
        }
        if items.len() as u64 != remote.mailbox.count {
            return Err(ShareLifecycleError::Invalid(
                "durable mailbox paging did not cover every retained item".into(),
            ));
        }
        let mut expected = record.drain_cursor.saturating_add(1);
        for seq in items.keys().copied() {
            if seq != expected {
                return Err(ShareLifecycleError::Invalid(format!(
                    "durable mailbox is not contiguous at sequence {expected}"
                )));
            }
            expected = expected.saturating_add(1);
        }
        let epoch_secret = derive_share_epoch_room_secret(root.expose(), record.epoch);
        // Process every retained item as an independent authenticated unit.
        // Invalid routing, grants, ciphertext, signatures, and event policy
        // are terminal poison: advancing the prefix ACK quarantines them at
        // the owner boundary and lets later valid mail through. External
        // network/relay/storage failures remain errors, so the prefix is not
        // ACKed and the exact valid submission is retried idempotently.
        let mut handled_through = record.drain_cursor;
        for item in items.values() {
            match self
                .import_submission(record, remote, item, epoch_secret.as_bytes(), false)
                .await
            {
                Ok(()) => {}
                Err(ShareLifecycleError::Invalid(reason)) => {
                    tracing::warn!(
                        share_id = %record.share_id,
                        mailbox_seq = item.seq,
                        envelope_id = %item.envelope_id,
                        reason = %reason,
                        "terminally quarantining invalid durable mailbox submission"
                    );
                    handled_through = item.seq;
                    continue;
                }
                Err(error) => return Err(error),
            }
            match self
                .import_submission(record, remote, item, epoch_secret.as_bytes(), true)
                .await
            {
                Ok(()) => handled_through = item.seq,
                Err(ShareLifecycleError::Invalid(reason)) => {
                    tracing::warn!(
                        share_id = %record.share_id,
                        mailbox_seq = item.seq,
                        envelope_id = %item.envelope_id,
                        reason = %reason,
                        "terminally quarantining invalid durable mailbox submission"
                    );
                    handled_through = item.seq;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(Some(handled_through))
    }

    async fn import_submission(
        &self,
        record: &DurableShareRecord,
        remote: &ShareRelayRecord,
        item: &ShareMailboxItem,
        room_secret: &[u8; 32],
        commit: bool,
    ) -> Result<(), ShareLifecycleError> {
        use crate::review::transport::inbound::{
            AuthorizationCache, InboundPipeline, RegisteredDeviceAuthorization, VerifyingKeyCache,
        };
        use ed25519_dalek::Verifier as _;

        let submission: ReviewSubmission =
            serde_json::from_value(item.payload.clone()).map_err(|error| {
                ShareLifecycleError::Invalid(format!("review_submission shape: {error}"))
            })?;
        let room_id = record.current_room_id.as_ref().ok_or_else(|| {
            ShareLifecycleError::Invalid("mail arrived without current epoch room".into())
        })?;
        let expected_bundle_id = submission_bundle_id(root_for(record)?, submission.tier);
        if submission.v != 3
            || submission.submission_type != "review_submission"
            || submission.envelope_id != item.envelope_id
            || submission.share_id != record.share_id
            || submission.epoch != record.epoch
            || submission.room_id != room_id.as_str()
            || submission.bundle_id.as_deref() != Some(expected_bundle_id.as_str())
            || item.epoch != Some(record.epoch)
            || item.bundle_id.as_deref() != Some(expected_bundle_id.as_str())
            || item.tier != Some(submission.tier)
            || !matches!(submission.tier, ShareTier::Comment | ShareTier::Suggest)
            || submission.envelopes.len() < 2
            || submission.envelopes.len() > 8
        {
            return Err(ShareLifecycleError::Invalid(
                "review_submission routing/context mismatch".into(),
            ));
        }
        let registration = &submission.device_registration;
        let expected_grant = match submission.tier {
            ShareTier::Comment => crate::review::transport::inbound::GrantTier::Comment,
            ShareTier::Suggest => crate::review::transport::inbound::GrantTier::Suggest,
            ShareTier::View => unreachable!(),
        };
        if registration.grant_tier != expected_grant
            || registration.kind == crate::review::model::ParticipantKind::Owner
        {
            return Err(ShareLifecycleError::Invalid(
                "review_submission device grant mismatch".into(),
            ));
        }
        let public_key = decode_key(
            &registration.public_signing_key,
            "device public signing key",
        )?;
        let verifier = ed25519_dalek::VerifyingKey::from_bytes(&public_key)
            .map_err(|_| ShareLifecycleError::Invalid("device signing key invalid".into()))?;
        let self_signature =
            decode_signature(&registration.self_signature, "device self signature")?;
        let mut unsigned = serde_json::to_value(registration)
            .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        unsigned
            .as_object_mut()
            .expect("registration object")
            .remove("selfSignature");
        let canonical = crate::review::crypto::canonical::to_canonical_bytes(&unsigned)
            .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        verifier
            .verify(
                &canonical,
                &ed25519_dalek::Signature::from_bytes(&self_signature),
            )
            .map_err(|_| ShareLifecycleError::Invalid("device self signature invalid".into()))?;
        let owner_key = decode_key(&remote.owner_signing_key, "owner public signing key")?;
        let owner = ed25519_dalek::VerifyingKey::from_bytes(&owner_key)
            .map_err(|_| ShareLifecycleError::Invalid("owner signing key invalid".into()))?;
        let grant = decode_signature(&registration.grant_signature, "owner grant signature")?;
        let invite_tier = match submission.tier {
            ShareTier::Comment => crate::review::bootstrap::InviteTierV3::Comment,
            ShareTier::Suggest => crate::review::bootstrap::InviteTierV3::Suggest,
            ShareTier::View => unreachable!(),
        };
        owner
            .verify(
                &crate::review::bootstrap::canonical_device_grant_v3(room_id, invite_tier)
                    .map_err(bootstrap_failure)?,
                &ed25519_dalek::Signature::from_bytes(&grant),
            )
            .map_err(|_| ShareLifecycleError::Invalid("owner device grant invalid".into()))?;

        let tree = derive_room_key_tree_v3(room_secret);
        let typed_device: crate::review::ids::DeviceId =
            serde_json::from_value(serde_json::Value::String(registration.device_id.clone()))
                .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        let typed_participant: crate::review::ids::ParticipantId = serde_json::from_value(
            serde_json::Value::String(registration.participant_id.clone()),
        )
        .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        let device_key =
            crate::review::crypto::signing::DeviceVerifyingKey::from_bytes(&public_key)
                .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?;
        let key_id = device_key.signing_key_id_base64url();
        let keys: VerifyingKeyCache =
            Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::from([
                (key_id.clone(), device_key),
            ])));
        let authorizations: AuthorizationCache =
            Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::from([
                (
                    key_id,
                    RegisteredDeviceAuthorization {
                        participant_id: typed_participant.clone(),
                        device_id: typed_device.clone(),
                        public_encryption_key: registration.public_encryption_key.clone(),
                        public_signing_key: registration.public_signing_key.clone(),
                        client: registration.client,
                        kind: registration.kind,
                        grant_tier: Some(expected_grant),
                        grant_signature: Some(registration.grant_signature.clone()),
                        attested: false,
                    },
                ),
            ])));
        let pipeline = InboundPipeline::new(
            Arc::clone(&self.review_store),
            keys,
            authorizations,
            *tree.read_keys.event_key.as_bytes(),
            *tree.read_keys.snapshot_key.as_bytes(),
            *tree.read_keys.signaling_key.as_bytes(),
        );
        for envelope in &submission.envelopes {
            // V3 names the room/admission transport. Review event envelopes
            // retain the canonical v2 event/AAD schema used by live v3 rooms.
            if envelope.v != 2
                || envelope.room_id != *room_id
                || envelope.device_id != typed_device
                || envelope.author_id != typed_participant
            {
                return Err(ShareLifecycleError::Invalid(
                    "frozen envelope attribution mismatch".into(),
                ));
            }
        }
        let events = pipeline
            .preflight_event_envelopes(&submission.envelopes, |index, event| {
                match (&event.body, index) {
                    (crate::review::model::ReviewEventBody::ParticipantJoined { .. }, 0) => true,
                    (crate::review::model::ReviewEventBody::CommentCreated { .. }, value)
                        if value > 0 =>
                    {
                        true
                    }
                    _ => false,
                }
            })
            .await
            .map_err(|error| {
                ShareLifecycleError::Invalid(format!("review_submission envelope: {error}"))
            })?;
        if !commit {
            return Ok(());
        }
        self.bootstrap
            .register_frozen_device_v3(
                room_id,
                &serde_json::to_value(registration)
                    .map_err(|error| ShareLifecycleError::Invalid(error.to_string()))?,
                tree.write_admission_key.as_bytes(),
            )
            .await
            .map_err(frozen_registration_failure)?;
        let outcomes = pipeline
            .commit_preflighted_events(room_id, &events)
            .await
            .map_err(|error| match error {
                crate::review::transport::inbound::InboundError::Store(message) => {
                    ShareLifecycleError::Store(format!("review_submission commit: {message}"))
                }
                other => ShareLifecycleError::Invalid(format!("review_submission commit: {other}")),
            })?;
        if let Some(notifications) = self.notifications.as_ref() {
            for outcome in outcomes {
                if outcome.newly_imported
                    && matches!(
                        &outcome.event.body,
                        crate::review::model::ReviewEventBody::CommentCreated { .. }
                            | crate::review::model::ReviewEventBody::SuggestionCreated { .. }
                            | crate::review::model::ReviewEventBody::SuggestionAccepted { .. }
                            | crate::review::model::ReviewEventBody::SuggestionRejected { .. }
                    )
                {
                    let (kind, file_display) = crate::review::notifications::summary_for_event(
                        &self.review_store,
                        room_id,
                        &outcome.event.body,
                    );
                    notifications.enqueue(room_id.clone(), kind, file_display);
                }
            }
        }
        self.bootstrap
            .post_frozen_envelopes_v3(
                room_id,
                &registration.device_id,
                &submission.envelopes,
                tree.write_admission_key.as_bytes(),
            )
            .await
            .map_err(bootstrap_failure)?;
        Ok(())
    }
}

/// Digest of a locally assembled manifest, byte-for-byte what the relay
/// computes over the committed refs. Sealed bundles bind this value, so the
/// owner derives it from the refs it is about to commit — never from a
/// mid-flight relay read.
fn manifest_digest_for(
    snapshots: &[ManagedShareSnapshotRef],
) -> Result<String, ShareLifecycleError> {
    let mut sorted = snapshots.to_vec();
    sorted.sort_by(|left, right| left.file_id.cmp(&right.file_id));
    let bytes = crate::review::crypto::canonical::to_canonical_bytes(&sorted)
        .map_err(|error| ShareLifecycleError::Invalid(format!("share manifest: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)))
}

fn retained_manifest_is_exact(
    remote: &[ManagedShareSnapshotRef],
    desired: &std::collections::HashSet<(&str, &str)>,
) -> bool {
    remote.len() == desired.len()
        && remote.iter().all(|snapshot| {
            desired.contains(&(snapshot.file_id.as_str(), snapshot.snapshot_id.as_str()))
        })
}

fn bootstrap_failure(error: crate::review::bootstrap::BootstrapError) -> ShareLifecycleError {
    ShareLifecycleError::Relay(error.to_string())
}

fn frozen_registration_failure(
    error: crate::review::bootstrap::BootstrapError,
) -> ShareLifecycleError {
    use crate::review::bootstrap::BootstrapError;

    match error {
        BootstrapError::Relay {
            status,
            code,
            message,
        } if matches!(
            code.as_str(),
            "ATTN_DEVICE_ID_CONFLICT"
                | "ATTN_DEVICE_KEY_CHANGED"
                | "ATTN_DEVICE_RECORD_CHANGED"
                | "ATTN_ROOM_DEVICE_CAP"
        ) =>
        {
            ShareLifecycleError::Invalid(format!(
                "frozen device registration rejected: relay http {status}: {code}: {message}"
            ))
        }
        BootstrapError::InviteParse(message) | BootstrapError::InvalidShare(message) => {
            ShareLifecycleError::Invalid(format!("frozen device registration: {message}"))
        }
        other => bootstrap_failure(other),
    }
}

fn bundle_access(secret: &[u8; 32], tier: ShareLinkTier) -> ShareBundleAccess {
    let keys = derive_share_link_keys(secret, tier);
    ShareBundleAccess {
        bundle_id: keys.bundle_id,
        tier: share_tier(tier),
        read_admission_key: SecretString::new(
            URL_SAFE_NO_PAD.encode(keys.read_admission_key.as_bytes()),
        ),
        write_admission_key: keys
            .write_admission_key
            .map(|key| SecretString::new(URL_SAFE_NO_PAD.encode(key.as_bytes()))),
    }
}

fn share_tier(tier: ShareLinkTier) -> ShareTier {
    match tier {
        ShareLinkTier::View => ShareTier::View,
        ShareLinkTier::Comment => ShareTier::Comment,
        ShareLinkTier::Suggest => ShareTier::Suggest,
    }
}

fn build_bundles(
    root: &[u8; 32],
    share_id: &str,
    epoch: u64,
    revision: u64,
    manifest_digest: &str,
    room: &crate::review::bootstrap::DurableEpochRoomOutcome,
) -> Result<Vec<ShareBundleMutation>, ShareLifecycleError> {
    let mut bundles = Vec::new();
    for tier in [
        ShareLinkTier::View,
        ShareLinkTier::Comment,
        ShareLinkTier::Suggest,
    ] {
        let keys = derive_share_link_keys(root, tier);
        let grant = match tier {
            ShareLinkTier::View => None,
            ShareLinkTier::Comment => Some(room.comment_grant_signature),
            ShareLinkTier::Suggest => Some(room.suggest_grant_signature),
        };
        let bundle = ShareCapabilityBundle {
            v: 3,
            purpose: "attn share capability bundle v3".into(),
            bundle_id: keys.bundle_id.clone(),
            owner_signing_key: room.owner_signing_key.clone(),
            share_id: share_id.to_owned(),
            epoch,
            revision,
            manifest_digest: manifest_digest.to_owned(),
            tier,
            room_id: room.room_id.as_str().to_owned(),
            read_capability_key: URL_SAFE_NO_PAD.encode(room.read_capability_key.as_ref()),
            write_admission_key: (tier != ShareLinkTier::View)
                .then(|| URL_SAFE_NO_PAD.encode(room.write_admission_key.as_ref())),
            grant_signature: grant.map(|signature| URL_SAFE_NO_PAD.encode(signature)),
        };
        let mut nonce = [0u8; 24];
        getrandom::getrandom(&mut nonce)
            .map_err(|error| ShareLifecycleError::Invalid(format!("bundle nonce rng: {error}")))?;
        let sealed_bundle = seal_capability_bundle_with_nonce(
            keys.bundle_key.as_bytes(),
            &keys.bundle_id,
            &bundle,
            &nonce,
        )
        .map_err(ShareLifecycleError::Invalid)?;
        nonce.zeroize();
        bundles.push(ShareBundleMutation {
            bundle_id: keys.bundle_id,
            tier: share_tier(tier),
            read_admission_key: SecretString::new(
                URL_SAFE_NO_PAD.encode(keys.read_admission_key.as_bytes()),
            ),
            write_admission_key: keys
                .write_admission_key
                .map(|key| SecretString::new(URL_SAFE_NO_PAD.encode(key.as_bytes()))),
            sealed_bundle,
        });
    }
    Ok(bundles)
}

fn links_for(
    record: &DurableShareRecord,
    expires_at: u64,
    owner_signing_key: String,
) -> Result<DurableShareLinks, ShareLifecycleError> {
    let root = record
        .share_secret
        .as_ref()
        .ok_or_else(|| ShareLifecycleError::Invalid("active share is missing its root".into()))?;
    let view = derive_share_link_keys(root.expose(), ShareLinkTier::View);
    let comment = derive_share_link_keys(root.expose(), ShareLinkTier::Comment);
    let suggest = derive_share_link_keys(root.expose(), ShareLinkTier::Suggest);
    let native = |secret: &[u8; 32]| {
        build_native_share_invite(&record.share_id, secret).map_err(ShareLifecycleError::Invalid)
    };
    let browser = |secret: &[u8; 32]| {
        build_browser_share_invite("https://attn.sh", &record.share_id, secret)
            .map_err(ShareLifecycleError::Invalid)
    };
    Ok(DurableShareLinks {
        share_id: record.share_id.clone(),
        room_id: record.current_room_id.clone().ok_or_else(|| {
            ShareLifecycleError::Invalid("active share has no room pointer".into())
        })?,
        owner_display_path: record.owner_path.to_string_lossy().into_owned(),
        owner_signing_key,
        view_native: native(view.link_secret.as_bytes())?,
        view_browser: browser(view.link_secret.as_bytes())?,
        comment_native: native(comment.link_secret.as_bytes())?,
        comment_browser: browser(comment.link_secret.as_bytes())?,
        suggest_native: native(suggest.link_secret.as_bytes())?,
        suggest_browser: browser(suggest.link_secret.as_bytes())?,
        expires_at,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedSnapshotAad<'a> {
    v: u8,
    purpose: &'static str,
    share_id: &'a str,
    epoch: u64,
    file_id: &'a str,
    snapshot_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedSnapshotPlaintext<'a> {
    v: u8,
    file_id: &'a str,
    snapshot_id: &'a str,
    doc_type: crate::review::model::DocType,
    content: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<&'a crate::review::model::AnchorIndex>,
}

fn seal_managed_snapshot(
    share_id: &str,
    epoch: u64,
    snapshot: &crate::review::bootstrap::DurableEpochSnapshot,
    snapshot_key: &[u8; 32],
) -> Result<Zeroizing<Vec<u8>>, ShareLifecycleError> {
    let content = snapshot.plaintext.content.as_deref().ok_or_else(|| {
        ShareLifecycleError::Invalid(format!(
            "managed durable snapshot {} has no text content",
            snapshot.snapshot_id.as_str()
        ))
    })?;
    let aad = crate::review::crypto::canonical::to_canonical_bytes(&ManagedSnapshotAad {
        v: 3,
        purpose: "attn durable share snapshot v3",
        share_id,
        epoch,
        file_id: snapshot.file_id.as_str(),
        snapshot_id: snapshot.snapshot_id.as_str(),
    })
    .map_err(|error| ShareLifecycleError::Invalid(format!("canonical snapshot AAD: {error}")))?;
    let plaintext = Zeroizing::new(
        crate::review::crypto::canonical::to_canonical_bytes(&ManagedSnapshotPlaintext {
            v: 3,
            file_id: snapshot.file_id.as_str(),
            snapshot_id: snapshot.snapshot_id.as_str(),
            doc_type: snapshot.plaintext.doc_type,
            content,
            metadata: snapshot.plaintext.anchor_index.as_ref(),
        })
        .map_err(|error| {
            ShareLifecycleError::Invalid(format!("canonical managed snapshot: {error}"))
        })?,
    );
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce)
        .map_err(|error| ShareLifecycleError::Invalid(format!("snapshot nonce rng: {error}")))?;
    let cipher = XChaCha20Poly1305::new(snapshot_key.into());
    // Transparent gzip before the seal (readers sniff after decrypt) —
    // shared wire rule in review::compression.
    let wire = crate::review::compression::compress_if_smaller(&plaintext);
    let ciphertext = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: wire.as_ref(),
                aad: &aad,
            },
        )
        .map_err(|_| ShareLifecycleError::Invalid("managed snapshot encryption failed".into()))?;
    let mut sealed = Zeroizing::new(Vec::with_capacity(24 + ciphertext.len()));
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&ciphertext);
    nonce.zeroize();
    Ok(sealed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use wiremock::matchers::{body_partial_json, header, header_exists, method, path, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SHARE_ID: &str = "AAECAwQFBgcICQoLDA0ODw";

    fn record(root: &Path) -> DurableShareRecord {
        let owner = root.join("owner.md");
        std::fs::write(&owner, "# Owner\n").expect("write owner");
        let owner = std::fs::canonicalize(owner).expect("canonical owner");
        DurableShareRecord::new(SHARE_ID.into(), [0x42; 32], owner, false).expect("record")
    }

    fn snapshot_ref(file_id: &str, snapshot_id: &str) -> ManagedShareSnapshotRef {
        ManagedShareSnapshotRef {
            file_id: file_id.into(),
            snapshot_id: snapshot_id.into(),
            ciphertext_bytes: 1,
            ciphertext_sha256: "digest".into(),
            uploaded_at: 1,
        }
    }

    fn typed_id<T: for<'de> Deserialize<'de>>(value: &str) -> T {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
            .expect("typed protocol id")
    }

    struct MailboxFixtureRelay {
        items: Vec<ShareMailboxItem>,
    }

    struct FailOnceAckRelay {
        fail: AtomicBool,
        operations: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ShareRelayClient for FailOnceAckRelay {
        fn device_id(&self) -> &str {
            "owner-device"
        }

        async fn fetch_share(
            &self,
            _: &str,
            _: &ShareBundleAccess,
        ) -> Result<ShareRelayRecord, ShareLifecycleError> {
            self.operations.lock().unwrap().push("fetch".into());
            unreachable!("pending ACK must precede a fresh share fetch")
        }

        async fn create_or_renew(
            &self,
            _: &str,
            _: &ShareUpsertRequest,
        ) -> Result<ShareRelayRecord, ShareLifecycleError> {
            unreachable!()
        }

        async fn fetch_mailbox(
            &self,
            _: &str,
            _: &ShareBundleAccess,
            _: u64,
            _: u16,
        ) -> Result<ShareMailboxPage, ShareLifecycleError> {
            unreachable!()
        }

        async fn ack_mailbox(&self, _: &str, through: u64) -> Result<(), ShareLifecycleError> {
            self.operations
                .lock()
                .unwrap()
                .push(format!("ack:{through}"));
            if self.fail.swap(false, Ordering::SeqCst) {
                Err(ShareLifecycleError::Relay("injected ACK failure".into()))
            } else {
                Ok(())
            }
        }

        async fn revoke_share(&self, _: &str) -> Result<(), ShareLifecycleError> {
            unreachable!()
        }

        async fn upload_snapshot(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &[u8],
        ) -> Result<ManagedShareSnapshotRef, ShareLifecycleError> {
            unreachable!()
        }

        async fn fetch_snapshot(
            &self,
            _: &str,
            _: &str,
            _: &ShareBundleAccess,
        ) -> Result<ManagedSnapshotCiphertext, ShareLifecycleError> {
            unreachable!()
        }
    }

    #[async_trait]
    impl ShareRelayClient for MailboxFixtureRelay {
        fn device_id(&self) -> &str {
            "owner-device"
        }

        async fn fetch_share(
            &self,
            _: &str,
            _: &ShareBundleAccess,
        ) -> Result<ShareRelayRecord, ShareLifecycleError> {
            unreachable!()
        }

        async fn create_or_renew(
            &self,
            _: &str,
            _: &ShareUpsertRequest,
        ) -> Result<ShareRelayRecord, ShareLifecycleError> {
            unreachable!()
        }

        async fn fetch_mailbox(
            &self,
            _: &str,
            access: &ShareBundleAccess,
            after: u64,
            _: u16,
        ) -> Result<ShareMailboxPage, ShareLifecycleError> {
            let items = self
                .items
                .iter()
                .filter(|item| item.seq > after && item.tier == Some(access.tier))
                .cloned()
                .collect::<Vec<_>>();
            let next_after = items.last().map_or(after, |item| item.seq);
            Ok(ShareMailboxPage {
                items,
                next_after,
                bundle: Some(SelectedShareBundle {
                    bundle_id: access.bundle_id.clone(),
                    tier: access.tier,
                    sealed_bundle: "sealed".into(),
                }),
            })
        }

        async fn ack_mailbox(&self, _: &str, _: u64) -> Result<(), ShareLifecycleError> {
            Ok(())
        }

        async fn revoke_share(&self, _: &str) -> Result<(), ShareLifecycleError> {
            unreachable!()
        }

        async fn upload_snapshot(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &[u8],
        ) -> Result<ManagedShareSnapshotRef, ShareLifecycleError> {
            unreachable!()
        }

        async fn fetch_snapshot(
            &self,
            _: &str,
            _: &str,
            _: &ShareBundleAccess,
        ) -> Result<ManagedSnapshotCiphertext, ShareLifecycleError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn renewal_retries_persisted_mailbox_ack_before_any_fresh_remote_read() {
        use crate::review::bootstrap::BootstrapConfig;
        use crate::review::store::ReviewStore;

        let temporary = tempfile::tempdir().expect("tempdir");
        let share_store =
            Arc::new(DurableShareStore::open_at(temporary.path().join("shares")).expect("shares"));
        let mut pending = record(temporary.path());
        pending.current_room_id = Some(pending.room_for_epoch(0).expect("epoch room"));
        pending.imported_cursor = 7;
        pending.drain_cursor = 7;
        share_store
            .save(&pending)
            .expect("persist pending ACK intent");

        let review_store =
            Arc::new(ReviewStore::open_at(temporary.path().join("reviews")).expect("reviews"));
        let bootstrap = Arc::new(
            Bootstrapper::new(
                Arc::clone(&review_store),
                Arc::new(BootstrapConfig {
                    relay_url: "http://127.0.0.1:9".into(),
                    identity_dir: Some(temporary.path().join("identity")),
                }),
            )
            .expect("bootstrap"),
        );
        let relay = Arc::new(FailOnceAckRelay {
            fail: AtomicBool::new(true),
            operations: std::sync::Mutex::new(Vec::new()),
        });
        let service = DurableShareService::new(
            Arc::clone(&share_store),
            review_store,
            relay.clone(),
            bootstrap,
        );

        assert!(matches!(
            service.renew(Some(SHARE_ID)).await,
            Err(ShareLifecycleError::Relay(_))
        ));
        assert_eq!(
            share_store
                .resolve(SHARE_ID)
                .expect("saved intent")
                .drain_cursor,
            7,
            "failed ACK must leave the persisted retry cursor intact"
        );
        assert!(matches!(
            service.renew(Some(SHARE_ID)).await,
            Err(ShareLifecycleError::Relay(_))
        ));
        assert_eq!(
            relay.operations.lock().unwrap().as_slice(),
            ["ack:7", "ack:7"],
            "the next renewal must retry the exact ACK before any fresh relay read"
        );
    }

    struct DarkPointerRelay {
        remote: std::sync::Mutex<ShareRelayRecord>,
        operations: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ShareRelayClient for DarkPointerRelay {
        fn device_id(&self) -> &str {
            "owner-device"
        }
        async fn fetch_share(
            &self,
            _: &str,
            _: &ShareBundleAccess,
        ) -> Result<ShareRelayRecord, ShareLifecycleError> {
            Ok(self.remote.lock().unwrap().clone())
        }
        async fn create_or_renew(
            &self,
            _: &str,
            request: &ShareUpsertRequest,
        ) -> Result<ShareRelayRecord, ShareLifecycleError> {
            self.operations.lock().unwrap().push("pointer".into());
            let mut remote = self.remote.lock().unwrap();
            remote.current_room_id = request.current_room_id.clone();
            remote.revision = request.revision;
            remote.owner_signing_key = request.owner_signing_key.clone();
            // Commit semantics: the upsert's manifest is the projection.
            remote.snapshots = request.snapshots.clone();
            Ok(remote.clone())
        }
        async fn fetch_mailbox(
            &self,
            _: &str,
            _: &ShareBundleAccess,
            _: u64,
            _: u16,
        ) -> Result<ShareMailboxPage, ShareLifecycleError> {
            unreachable!()
        }
        async fn ack_mailbox(&self, _: &str, _: u64) -> Result<(), ShareLifecycleError> {
            unreachable!()
        }
        async fn revoke_share(&self, _: &str) -> Result<(), ShareLifecycleError> {
            unreachable!()
        }
        async fn upload_snapshot(
            &self,
            _: &str,
            file_id: &str,
            snapshot_id: &str,
            ciphertext: &[u8],
        ) -> Result<ManagedShareSnapshotRef, ShareLifecycleError> {
            self.operations
                .lock()
                .unwrap()
                .push(format!("upload:{file_id}"));
            // Staging semantics: the ref is returned but the public record
            // does not change until the commit upsert.
            Ok(ManagedShareSnapshotRef {
                file_id: file_id.into(),
                snapshot_id: snapshot_id.into(),
                ciphertext_bytes: ciphertext.len() as u64,
                ciphertext_sha256: "new-digest".into(),
                uploaded_at: 2,
            })
        }
        async fn fetch_snapshot(
            &self,
            _: &str,
            _: &str,
            _: &ShareBundleAccess,
        ) -> Result<ManagedSnapshotCiphertext, ShareLifecycleError> {
            unreachable!()
        }
    }

    #[test]
    fn dark_pointer_recovery_rejects_stale_offline_content() {
        let remote = vec![
            snapshot_ref("edited-file", "old-snapshot"),
            snapshot_ref("deleted-file", "deleted-snapshot"),
        ];
        let desired = std::collections::HashSet::from([("edited-file", "new-snapshot")]);
        assert!(
            !retained_manifest_is_exact(&remote, &desired),
            "a live-pointer shortcut must reject stale offline content"
        );
    }

    #[tokio::test]
    async fn complete_create_commits_manifest_without_stale_dark_pointer_artifact() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/v3/rooms/[^/]+$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "roomId": "x", "createdAt": 0, "expiresAt": 0, "policy": {},
                "ownerSigningKeyId": "k", "serverSeq": 0
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex(r"^/v3/rooms/[^/]+/devices$"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let temporary = tempfile::tempdir().expect("tempdir");
        let owner = temporary.path().join("current.md");
        std::fs::write(&owner, "# Current\n").expect("current source");
        let owner = std::fs::canonicalize(owner).expect("canonical owner");
        let share_store = Arc::new(
            DurableShareStore::open_at(temporary.path().join("shares")).expect("share store"),
        );
        let review_store = Arc::new(
            crate::review::store::ReviewStore::open_at(temporary.path().join("reviews"))
                .expect("review store"),
        );
        let bootstrap = Arc::new(
            Bootstrapper::new(
                Arc::clone(&review_store),
                Arc::new(crate::review::bootstrap::BootstrapConfig {
                    relay_url: server.uri(),
                    identity_dir: Some(temporary.path().join("identity")),
                }),
            )
            .expect("bootstrap"),
        );
        let relay = Arc::new(DarkPointerRelay {
            remote: std::sync::Mutex::new(ShareRelayRecord {
                v: 3,
                share_id: SHARE_ID.into(),
                owner_signing_key: URL_SAFE_NO_PAD.encode([9u8; 32]),
                epoch: 0,
                revision: 1,
                current_room_id: None,
                snapshots: vec![snapshot_ref("deleted-file", "partial-snapshot")],
                placeholders: vec![],
                manifest_digest: EMPTY_MANIFEST_DIGEST.into(),
                bundle: None,
                updated_at: 1,
                expires_at: 2,
                mailbox: ShareMailboxSummary {
                    count: 0,
                    bytes: 0,
                    latest_seq: 0,
                },
                features: ShareFeatures { push: false },
            }),
            operations: std::sync::Mutex::new(Vec::new()),
        });
        let service = DurableShareService::new(share_store, review_store, relay.clone(), bootstrap);
        let intent =
            DurableShareRecord::new(SHARE_ID.into(), [0x42; 32], owner, false).expect("intent");
        service.complete_create(intent).await.expect("recovery");

        let operations = relay.operations.lock().unwrap().clone();
        // No standalone delete: the stale ref simply falls out of the
        // committed manifest, so upload + one commit is the whole publish.
        assert!(operations[0].starts_with("upload:"));
        assert_eq!(operations[1], "pointer");
        assert_eq!(operations.len(), 2);
        let remote = relay.remote.lock().unwrap();
        assert_eq!(remote.snapshots.len(), 1);
        assert_ne!(remote.snapshots[0].file_id, "deleted-file");
        assert!(remote.current_room_id.is_some());
    }

    #[test]
    fn persistence_round_trips_and_epoch_mapping_is_stable() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let store = DurableShareStore::open_at(temporary.path().join("shares")).expect("store");
        let mut before = record(temporary.path());
        let initial = before.room_for_epoch(0).expect("initial room");
        before.current_room_id = Some(initial);
        assert!(before.room_for_epoch(1).is_err());
        assert!(!before.epoch_rooms.contains_key(&1));
        let room = before.transition_epoch(0, 1, 99).expect("transition");
        assert_eq!(before.epoch_rooms.get(&1), Some(&room));
        store.save(&before).expect("save");

        let mut after = store.load(SHARE_ID).expect("load");
        assert_eq!(after, before);
        assert_eq!(after.room_for_epoch(1).expect("room retry"), room);
        let epoch_before = after.epoch;
        assert!(after.transition_epoch(1, 3, 100).is_err());
        assert_eq!(after.epoch, epoch_before);
        assert_eq!(
            store
                .resolve(after.owner_path.to_str().expect("utf8 path"))
                .expect("path lookup"),
            after
        );
    }

    #[test]
    fn revoke_is_retryable_and_success_clears_secret_but_keeps_tombstone() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let store = DurableShareStore::open_at(temporary.path().join("shares")).expect("store");
        let mut active = record(temporary.path());
        assert!(active.finish_revoke().is_err());
        store.save(&active).expect("save");

        let pending = store.begin_revoke(SHARE_ID).expect("begin revoke");
        assert_eq!(pending.state, DurableShareState::RevokePending);
        assert!(
            pending.share_secret.is_some(),
            "network retry needs the secret"
        );
        assert_eq!(
            store.load(SHARE_ID).expect("pending persisted").state,
            DurableShareState::RevokePending
        );
        let mut pending = pending;
        assert!(pending.ensure_renewable().is_err());
        assert!(pending.room_for_epoch(1).is_err());

        let mut revoked = store.finish_revoke(SHARE_ID).expect("finish revoke");
        assert_eq!(revoked.state, DurableShareState::Revoked);
        assert!(revoked.share_secret.is_none());
        assert!(revoked.current_room_id.is_none());
        assert!(matches!(
            revoked.room_for_epoch(8),
            Err(ShareLifecycleError::Revoked(_))
        ));
    }

    #[test]
    fn debug_output_redacts_secret_and_admission_keys() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let record = record(temporary.path());
        let rendered = format!("{record:?}");
        assert!(rendered.contains("[REDACTED]"));
        assert!(!rendered.contains(&URL_SAFE_NO_PAD.encode([0x42; 32])));

        let request = ShareUpsertRequest {
            v: 3,
            owner_signing_key: "owner-public".into(),
            bundles: vec![ShareBundleMutation {
                bundle_id: "bundle".into(),
                tier: ShareTier::Comment,
                read_admission_key: SecretString::new("read-private".into()),
                write_admission_key: Some(SecretString::new("write-private".into())),
                sealed_bundle: "ciphertext".into(),
            }],
            epoch: 0,
            revision: 0,
            current_room_id: None,
            snapshots: vec![],
            placeholders: vec![],
            device_id: "device".into(),
        };
        let rendered = format!("{request:?}");
        assert!(!rendered.contains("read-private"));
        assert!(!rendered.contains("write-private"));
    }

    #[test]
    fn relay_dtos_match_tier_bundle_share_do_wire() {
        let request = ShareUpsertRequest {
            v: 3,
            owner_signing_key: "owner-public".into(),
            bundles: vec![ShareBundleMutation {
                bundle_id: "bundle-id".into(),
                tier: ShareTier::Suggest,
                read_admission_key: SecretString::new("read-secret".into()),
                write_admission_key: Some(SecretString::new("write-secret".into())),
                sealed_bundle: "sealed".into(),
            }],
            epoch: 4,
            revision: 9,
            current_room_id: Some("room-id".into()),
            snapshots: vec![],
            placeholders: vec![],
            device_id: "device-id".into(),
        };
        let json = serde_json::to_value(&request).expect("request json");
        assert_eq!(json["v"], 3);
        assert_eq!(json["revision"], 9);
        assert!(
            json.get("shareId").is_none(),
            "shareId belongs in the URL path"
        );
        assert_eq!(json["bundles"][0]["tier"], "suggest");
        assert_eq!(json["bundles"][0]["readAdmissionKey"], "read-secret");

        let response = serde_json::json!({
            "v": 3,
            "shareId": SHARE_ID,
            "ownerSigningKey": "owner-public",
            "epoch": 4,
            "revision": 9,
            "currentRoomId": "room-id",
            "snapshots": [],
            "placeholders": [],
            "manifestDigest": "digest",
            "bundle": { "bundleId": "bundle-id", "tier": "suggest", "sealedBundle": "sealed" },
            "updatedAt": 10,
            "expiresAt": 20,
            "mailbox": { "count": 1, "bytes": 2, "latestSeq": 3 },
            "features": { "push": false }
        });
        let decoded: ShareRelayRecord = serde_json::from_value(response).expect("response");
        assert_eq!(decoded.revision, 9);
        assert_eq!(decoded.manifest_digest, "digest");
        assert_eq!(decoded.bundle.expect("bundle").tier, ShareTier::Suggest);

        let item: ShareMailboxItem = serde_json::from_value(serde_json::json!({
            "seq": 7,
            "envelopeId": "env",
            "bytes": 12,
            "payload": { "envelopeId": "env" },
            "epoch": 4,
            "bundleId": "bundle-id",
            "tier": "comment"
        }))
        .expect("mail item");
        assert_eq!(item.epoch, Some(4));
        assert_eq!(item.bundle_id.as_deref(), Some("bundle-id"));
        assert_eq!(item.tier, Some(ShareTier::Comment));
    }

    #[test]
    fn store_rejects_invalid_records_and_symlinked_state() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let store = DurableShareStore::open_at(temporary.path().join("shares")).expect("store");
        let record = record(temporary.path());
        store.save(&record).expect("save");
        let path = store.root().join(SHARE_ID).join(RECORD_FILENAME);
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
        json["state"] = serde_json::Value::String("revoked".into());
        std::fs::write(&path, serde_json::to_vec(&json).expect("encode")).expect("corrupt");
        assert!(matches!(
            store.load(SHARE_ID),
            Err(ShareLifecycleError::Invalid(_))
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            std::fs::remove_file(&path).expect("remove record");
            let decoy = temporary.path().join("decoy");
            std::fs::write(&decoy, b"{}").expect("decoy");
            symlink(&decoy, &path).expect("record symlink");
            assert!(matches!(
                store.load(SHARE_ID),
                Err(ShareLifecycleError::Store(_))
            ));

            let linked_root = temporary.path().join("linked-shares");
            symlink(store.root(), &linked_root).expect("symlink");
            assert!(DurableShareStore::open_at(linked_root).is_err());
        }
    }

    #[test]
    fn target_validation_rejects_symlinks_and_non_shareable_files() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let text = temporary.path().join("notes.txt");
        std::fs::write(&text, "no").expect("text");
        assert!(canonical_share_target(&text).is_err());

        #[cfg(unix)]
        {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt as _;
            use std::os::unix::fs::symlink;
            let markdown = temporary.path().join("notes.md");
            let link = temporary.path().join("linked.md");
            std::fs::write(&markdown, "# yes").expect("markdown");
            symlink(&markdown, &link).expect("symlink");
            assert!(canonical_share_target(&link).is_err());

            let invalid_utf8 = temporary
                .path()
                .join(OsString::from_vec(b"invalid-\xff.md".to_vec()));
            assert!(canonical_share_target(&invalid_utf8).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn store_permissions_are_private_and_temp_files_do_not_remain() {
        use std::os::unix::fs::PermissionsExt as _;
        let temporary = tempfile::tempdir().expect("tempdir");
        let store = DurableShareStore::open_at(temporary.path().join("shares")).expect("store");
        store.save(&record(temporary.path())).expect("save");
        let share_dir = store.root().join(SHARE_ID);
        let record_path = share_dir.join(RECORD_FILENAME);
        assert_eq!(
            std::fs::metadata(store.root())
                .expect("root metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&share_dir)
                .expect("share metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(record_path)
                .expect("record metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(std::fs::read_dir(share_dir).expect("entries").all(|entry| {
            !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }

    struct RevokeRelay {
        fail: AtomicBool,
    }

    #[async_trait]
    impl ShareRelayClient for RevokeRelay {
        fn device_id(&self) -> &str {
            "owner-device"
        }
        async fn fetch_share(
            &self,
            _: &str,
            _: &ShareBundleAccess,
        ) -> Result<ShareRelayRecord, ShareLifecycleError> {
            unreachable!()
        }
        async fn create_or_renew(
            &self,
            _: &str,
            _: &ShareUpsertRequest,
        ) -> Result<ShareRelayRecord, ShareLifecycleError> {
            unreachable!()
        }
        async fn fetch_mailbox(
            &self,
            _: &str,
            _: &ShareBundleAccess,
            _: u64,
            _: u16,
        ) -> Result<ShareMailboxPage, ShareLifecycleError> {
            unreachable!()
        }
        async fn ack_mailbox(&self, _: &str, _: u64) -> Result<(), ShareLifecycleError> {
            unreachable!()
        }
        async fn revoke_share(&self, _: &str) -> Result<(), ShareLifecycleError> {
            if self.fail.load(Ordering::SeqCst) {
                Err(ShareLifecycleError::Relay("injected delete crash".into()))
            } else {
                Ok(())
            }
        }
        async fn upload_snapshot(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &[u8],
        ) -> Result<ManagedShareSnapshotRef, ShareLifecycleError> {
            unreachable!()
        }
        async fn fetch_snapshot(
            &self,
            _: &str,
            _: &str,
            _: &ShareBundleAccess,
        ) -> Result<ManagedSnapshotCiphertext, ShareLifecycleError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn revoke_persists_pending_before_remote_delete_and_retries_to_tombstone() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let share_store =
            Arc::new(DurableShareStore::open_at(temporary.path().join("shares")).expect("shares"));
        share_store.save(&record(temporary.path())).expect("intent");
        let review_store = Arc::new(
            crate::review::store::ReviewStore::open_at(temporary.path().join("reviews"))
                .expect("reviews"),
        );
        let config = Arc::new(crate::review::bootstrap::BootstrapConfig {
            relay_url: "http://127.0.0.1:9".into(),
            identity_dir: Some(temporary.path().join("identity")),
        });
        let bootstrap =
            Arc::new(Bootstrapper::new(Arc::clone(&review_store), config).expect("bootstrap"));
        let relay = Arc::new(RevokeRelay {
            fail: AtomicBool::new(true),
        });
        let service = DurableShareService::new(
            Arc::clone(&share_store),
            review_store,
            relay.clone(),
            bootstrap,
        );

        assert!(service.revoke(SHARE_ID).await.is_err());
        let pending = share_store.load(SHARE_ID).expect("pending");
        assert_eq!(pending.state, DurableShareState::RevokePending);
        assert!(
            pending.share_secret.is_some(),
            "retry capability cleared before remote delete"
        );

        relay.fail.store(false, Ordering::SeqCst);
        service.revoke(SHARE_ID).await.expect("retry revoke");
        let revoked = share_store.load(SHARE_ID).expect("tombstone");
        assert_eq!(revoked.state, DurableShareState::Revoked);
        assert!(revoked.share_secret.is_none());
    }

    #[test]
    fn managed_snapshot_wire_is_nonce_ciphertext_and_exact_context_bound() {
        let snapshot = crate::review::bootstrap::DurableEpochSnapshot {
            file_id: serde_json::from_value(serde_json::Value::String("file-a".into())).unwrap(),
            snapshot_id: serde_json::from_value(serde_json::Value::String("snapshot-a".into()))
                .unwrap(),
            plaintext: crate::review::model::SnapshotPlaintext {
                doc_type: crate::review::model::DocType::Markdown,
                content: Some("# secret\n".into()),
                anchor_index: None,
                media_type: None,
                encoding: None,
                manifest: None,
            },
        };
        let key = [0x55; 32];
        let sealed = seal_managed_snapshot(SHARE_ID, 4, &snapshot, &key).expect("seal");
        assert!(sealed.len() > 24 + 16);
        let aad = crate::review::crypto::canonical::to_canonical_bytes(&ManagedSnapshotAad {
            v: 3,
            purpose: "attn durable share snapshot v3",
            share_id: SHARE_ID,
            epoch: 4,
            file_id: "file-a",
            snapshot_id: "snapshot-a",
        })
        .unwrap();
        let plaintext = XChaCha20Poly1305::new((&key).into())
            .decrypt(
                (&sealed[..24]).into(),
                Payload {
                    msg: &sealed[24..],
                    aad: &aad,
                },
            )
            .expect("open");
        let value: serde_json::Value = serde_json::from_slice(&plaintext).expect("json");
        assert_eq!(
            value,
            serde_json::json!({
                "v": 3, "fileId": "file-a", "snapshotId": "snapshot-a", "docType": "markdown", "content": "# secret\n"
            })
        );
        let wrong_aad = crate::review::crypto::canonical::to_canonical_bytes(&ManagedSnapshotAad {
            v: 3,
            purpose: "attn durable share snapshot v3",
            share_id: SHARE_ID,
            epoch: 5,
            file_id: "file-a",
            snapshot_id: "snapshot-a",
        })
        .unwrap();
        assert!(
            XChaCha20Poly1305::new((&key).into())
                .decrypt(
                    (&sealed[..24]).into(),
                    Payload {
                        msg: &sealed[24..],
                        aad: &wrong_aad
                    },
                )
                .is_err()
        );
    }

    #[test]
    fn managed_snapshot_rejects_workspace_manifest_without_inventing_text_content() {
        let snapshot = crate::review::bootstrap::DurableEpochSnapshot {
            file_id: serde_json::from_value(serde_json::Value::String("manifest-file".into()))
                .unwrap(),
            snapshot_id: serde_json::from_value(serde_json::Value::String(
                "manifest-snapshot".into(),
            ))
            .unwrap(),
            plaintext: crate::review::model::SnapshotPlaintext {
                doc_type: crate::review::model::DocType::WorkspaceManifest,
                content: None,
                anchor_index: None,
                media_type: None,
                encoding: None,
                manifest: Some(crate::review::model::WorkspaceSnapshotManifest {
                    v: 1,
                    kind: crate::review::model::WorkspaceManifestKind::AttnWorkspaceSnapshot,
                    scope: crate::review::model::WorkspaceManifestScope::Workspace,
                    entries: Vec::new(),
                }),
            },
        };
        let error = seal_managed_snapshot(SHARE_ID, 4, &snapshot, &[0x55; 32])
            .expect_err("workspace manifests are not legacy text snapshots");
        assert!(error.to_string().contains("has no text content"));
        assert!(snapshot.plaintext.content.is_none());
    }

    #[tokio::test]
    async fn native_drain_quarantines_poison_retries_transient_and_dedupes_later_valid_mail() {
        use crate::review::bootstrap::{
            BootstrapConfig, InviteTierV3, assemble_envelope_for_event, canonical_device_grant_v3,
        };
        use crate::review::ids::{ContentHash, FileId, SnapshotId};
        use crate::review::model::{
            Anchor, Capability, Device, DeviceClient, Participant, ParticipantKind, PositionAnchor,
            ReviewEventBody,
        };
        use crate::review::store::ReviewStore;

        let temporary = tempfile::tempdir().expect("tempdir");
        let mut record = record(temporary.path());
        let room_id = record.room_for_epoch(0).expect("epoch room");
        record.current_room_id = Some(room_id.clone());

        let owner = DeviceIdentity::generate().expect("owner identity");
        let poison_visitor = DeviceIdentity::generate().expect("poison visitor identity");
        let visitor = DeviceIdentity::generate().expect("visitor identity");
        let owner_grant = owner
            .signing_key()
            .expect("owner signer")
            .sign_protocol_bytes(
                &canonical_device_grant_v3(&room_id, InviteTierV3::Comment).expect("grant bytes"),
            );
        let root = record.share_secret.as_ref().expect("root");
        let epoch_secret = derive_share_epoch_room_secret(root.expose(), 0);
        let event_key = derive_room_key_tree_v3(epoch_secret.as_bytes())
            .read_keys
            .event_key;
        let bundle_id = submission_bundle_id(root.expose(), ShareTier::Comment);
        let submission = |identity: &DeviceIdentity, outer_id: &str, thread_id: &str| {
            let unsigned_registration = serde_json::json!({
                "deviceId": identity.device_id,
                "participantId": identity.participant_id,
                "publicSigningKey": identity.public_signing_key,
                "publicEncryptionKey": identity.public_encryption_key,
                "client": "attn-browser",
                "kind": "reviewer",
                "grantTier": "comment",
                "grantSignature": URL_SAFE_NO_PAD.encode(owner_grant),
            });
            let self_signature = identity
                .signing_key()
                .expect("visitor signer")
                .sign_protocol_bytes(
                    &crate::review::crypto::canonical::to_canonical_bytes(&unsigned_registration)
                        .expect("registration canonical bytes"),
                );
            let mut registration = unsigned_registration;
            registration["selfSignature"] =
                serde_json::Value::String(URL_SAFE_NO_PAD.encode(self_signature));
            let participant = Participant {
                participant_id: identity.typed_participant_id(),
                display_name: "Offline reviewer".into(),
                kind: ParticipantKind::Reviewer,
                public_signing_key: identity.public_signing_key.clone(),
                capabilities: vec![
                    Capability::ReadSnapshot,
                    Capability::WriteComment,
                    Capability::ResolveComment,
                ],
            };
            let device = Device {
                device_id: identity.typed_device_id(),
                participant_id: identity.typed_participant_id(),
                public_encryption_key: identity.public_encryption_key.clone(),
                public_signing_key: identity.public_signing_key.clone(),
                client: DeviceClient::AttnBrowser,
                created_at: 100,
            };
            let joined = assemble_envelope_for_event(
                identity,
                &room_id,
                event_key.as_bytes(),
                ReviewEventBody::ParticipantJoined {
                    participant,
                    device,
                },
                100,
                10_000,
            )
            .expect("joined envelope");
            let comment = assemble_envelope_for_event(
                identity,
                &room_id,
                event_key.as_bytes(),
                ReviewEventBody::CommentCreated {
                    thread_id: thread_id.into(),
                    anchor: Anchor {
                        v: 2,
                        file_id: typed_id::<FileId>("file-valid"),
                        snapshot_id: typed_id::<SnapshotId>("snapshot-valid"),
                        base_hash: typed_id::<ContentHash>("hash-valid"),
                        position: PositionAnchor {
                            byte_range: [0, 1],
                            line_range: [1, 1],
                            pm_range: None,
                        },
                        quote: None,
                        block: None,
                        context: None,
                        structure: None,
                    },
                    body: "valid comment after poison".into(),
                },
                101,
                10_000,
            )
            .expect("comment envelope");
            serde_json::json!({
                "v": 3,
                "envelopeId": outer_id,
                "type": "review_submission",
                "shareId": SHARE_ID,
                "epoch": 0,
                "roomId": room_id,
                "tier": "comment",
                "bundleId": bundle_id,
                "deviceRegistration": registration,
                "envelopes": [joined, comment],
            })
        };
        let valid = submission(&visitor, "outer-valid", "thread-valid");
        let duplicate = submission(&visitor, "outer-duplicate", "thread-valid");
        let poison = submission(&poison_visitor, "outer-poison", "thread-poison");
        let joined_envelope_id = valid["envelopes"][0]["envelopeId"].clone();
        let comment_envelope_id = valid["envelopes"][1]["envelopeId"].clone();
        let item = |seq, envelope_id: &str, payload| ShareMailboxItem {
            seq,
            envelope_id: envelope_id.into(),
            bytes: serde_json::to_vec(&payload).unwrap().len() as u64,
            payload,
            epoch: Some(0),
            bundle_id: Some(bundle_id.clone()),
            tier: Some(ShareTier::Comment),
        };
        let relay = Arc::new(MailboxFixtureRelay {
            items: vec![
                item(1, "outer-poison", poison),
                item(2, "outer-valid", valid),
                item(3, "outer-duplicate", duplicate),
            ],
        });

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/v3/rooms/{}/devices", room_id.as_str())))
            .and(body_partial_json(serde_json::json!({
                "deviceId": poison_visitor.device_id
            })))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": {
                    "code": "ATTN_DEVICE_ID_CONFLICT",
                    "message": "device identifier is already bound to another participant"
                }
            })))
            .with_priority(1)
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/v3/rooms/{}/devices", room_id.as_str())))
            .respond_with(ResponseTemplate::new(204))
            .expect(3)
            .mount(&server)
            .await;
        let envelopes_path = format!("/v3/rooms/{}/envelopes", room_id.as_str());
        Mock::given(method("POST"))
            .and(path(envelopes_path.clone()))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .with_priority(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(envelopes_path))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "accepted": [
                    { "envelopeId": joined_envelope_id, "serverSeq": 1 },
                    { "envelopeId": comment_envelope_id, "serverSeq": 2 }
                ]
            })))
            .expect(2)
            .mount(&server)
            .await;

        let review_store =
            Arc::new(ReviewStore::open_at(temporary.path().join("reviews")).expect("review store"));
        let bootstrap = Arc::new(
            Bootstrapper::new(
                Arc::clone(&review_store),
                Arc::new(BootstrapConfig {
                    relay_url: server.uri(),
                    identity_dir: Some(temporary.path().join("identity")),
                }),
            )
            .expect("bootstrap"),
        );
        let service = DurableShareService::new(
            Arc::new(DurableShareStore::open_at(temporary.path().join("shares")).expect("shares")),
            Arc::clone(&review_store),
            relay,
            bootstrap,
        );
        let remote = ShareRelayRecord {
            v: 3,
            share_id: SHARE_ID.into(),
            owner_signing_key: owner.public_signing_key,
            epoch: 0,
            revision: 0,
            current_room_id: Some(room_id.as_str().into()),
            snapshots: vec![],
            placeholders: vec![],
            manifest_digest: EMPTY_MANIFEST_DIGEST.into(),
            bundle: None,
            updated_at: 1,
            expires_at: 10_000,
            mailbox: ShareMailboxSummary {
                count: 3,
                bytes: 1,
                latest_seq: 3,
            },
            features: ShareFeatures { push: false },
        };

        let first = service.drain_mailbox(&record, &remote).await;
        assert!(
            matches!(first, Err(ShareLifecycleError::Relay(_))),
            "transient relay failure must preserve the prefix for retry: {first:?}"
        );
        assert_eq!(
            review_store
                .iter_events(&room_id)
                .expect("events")
                .collect::<Result<Vec<_>, _>>()
                .expect("event decode")
                .len(),
            2,
            "valid submission was durably imported before transient forward failure"
        );

        assert_eq!(
            service
                .drain_mailbox(&record, &remote)
                .await
                .expect("retry drain"),
            Some(3),
            "poison and duplicate are terminally accounted through the later valid item"
        );
        let events = review_store
            .iter_events(&room_id)
            .expect("events")
            .collect::<Result<Vec<_>, _>>()
            .expect("event decode");
        assert_eq!(events.len(), 2, "retry and duplicate import exactly once");
        assert!(matches!(
            &events[1].body,
            ReviewEventBody::CommentCreated { body, .. } if body == "valid comment after poison"
        ));
    }

    #[tokio::test]
    async fn public_share_resolver_authenticates_comment_bundle_and_builds_v3_invite() {
        let server = MockServer::start().await;
        let owner_root = [0x42; 32];
        let comment = derive_share_link_keys(&owner_root, ShareLinkTier::Comment);
        let room_id = URL_SAFE_NO_PAD.encode([0x11; 16]);
        let read = [0x22; 32];
        let write = [0x33; 32];
        let grant = [0x44; 64];
        let bundle = ShareCapabilityBundle {
            v: 3,
            purpose: "attn share capability bundle v3".into(),
            bundle_id: comment.bundle_id.clone(),
            owner_signing_key: URL_SAFE_NO_PAD.encode([0x55; 32]),
            share_id: SHARE_ID.into(),
            epoch: 7,
            revision: 9,
            manifest_digest: EMPTY_MANIFEST_DIGEST.into(),
            tier: ShareLinkTier::Comment,
            room_id: room_id.clone(),
            read_capability_key: URL_SAFE_NO_PAD.encode(read),
            write_admission_key: Some(URL_SAFE_NO_PAD.encode(write)),
            grant_signature: Some(URL_SAFE_NO_PAD.encode(grant)),
        };
        let sealed_bundle = seal_capability_bundle_with_nonce(
            comment.bundle_key.as_bytes(),
            &comment.bundle_id,
            &bundle,
            &[0x66; 24],
        )
        .expect("seal comment bundle");

        Mock::given(method("GET"))
            .and(path(format!("/v3/shares/{SHARE_ID}")))
            .and(header("Attn-Share-Bundle", comment.bundle_id.as_str()))
            .and(header_exists("Attn-Admission"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "v": 3,
                "shareId": SHARE_ID,
                "ownerSigningKey": URL_SAFE_NO_PAD.encode([0x55; 32]),
                "epoch": 7,
                "revision": 9,
                "currentRoomId": room_id,
                "snapshots": [],
                "placeholders": [],
                "manifestDigest": EMPTY_MANIFEST_DIGEST,
                "bundle": {
                    "bundleId": comment.bundle_id,
                    "tier": "comment",
                    "sealedBundle": sealed_bundle
                },
                "updatedAt": 1,
                "expiresAt": 2,
                "mailbox": { "count": 0, "bytes": 0, "latestSeq": 0 },
                "features": { "push": false }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let invite = resolve_public_share_to_room_invite(
            &server.uri(),
            SHARE_ID,
            &ShareLinkSecret::new(*comment.link_secret.as_bytes()),
        )
        .await
        .expect("resolve comment link");
        let fragment =
            build_invite_fragment_v3(InviteTierV3::Comment, &read, Some(&write), Some(&grant))
                .expect("comment fragment");
        assert_eq!(invite, format!("attn://review/{room_id}{fragment}"));
    }

    #[tokio::test]
    async fn http_client_scopes_bundle_read_and_owner_revoke_headers() {
        let server = MockServer::start().await;
        let identity = DeviceIdentity::generate().expect("identity");
        let client =
            HttpShareRelayClient::with_http_client(server.uri(), &identity, reqwest::Client::new())
                .expect("client");
        let bundle_id = "B".repeat(22);
        let record_json = serde_json::json!({
            "v": 3, "shareId": SHARE_ID, "ownerSigningKey": identity.public_signing_key,
            "epoch": 0, "revision": 0, "currentRoomId": "room-id", "snapshots": [],
            "placeholders": [], "manifestDigest": EMPTY_MANIFEST_DIGEST,
            "bundle": { "bundleId": bundle_id, "tier": "view", "sealedBundle": "sealed" },
            "updatedAt": 1, "expiresAt": 2,
            "mailbox": { "count": 0, "bytes": 0, "latestSeq": 0 }, "features": { "push": false }
        });
        Mock::given(method("GET"))
            .and(path(format!("/v3/shares/{SHARE_ID}")))
            .and(header("Attn-Share-Bundle", bundle_id.as_str()))
            .and(header_exists("Attn-Admission"))
            .respond_with(ResponseTemplate::new(200).set_body_json(record_json))
            .expect(1)
            .mount(&server)
            .await;
        let access = ShareBundleAccess {
            bundle_id,
            tier: ShareTier::View,
            read_admission_key: SecretString::new(URL_SAFE_NO_PAD.encode([7u8; 32])),
            write_admission_key: None,
        };
        assert_eq!(
            client.fetch_share(SHARE_ID, &access).await.unwrap().epoch,
            0
        );

        Mock::given(method("DELETE"))
            .and(path(format!("/v3/shares/{SHARE_ID}")))
            .and(header_exists("Attn-Owner-Signature"))
            .and(header_exists("Attn-PoW"))
            .and(header("Attn-Device-Id", identity.device_id.as_str()))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "ATTN_SHARE_NOT_FOUND", "message": "already gone" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        client
            .revoke_share(SHARE_ID)
            .await
            .expect("404 revoke is success");
    }
}
