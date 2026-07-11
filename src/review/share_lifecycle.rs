//! Owner-side durable-share state and relay boundary.
//!
//! This module deliberately owns no HTTP implementation. The durable local
//! record and the typed relay trait are stable seams while the exact share
//! mailbox protocol evolves. `ReviewManager` remains the daemon authority and
//! will drive this interface from its existing Tokio runtime.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use zeroize::{Zeroize, Zeroizing};

use crate::review::crypto::kdf::{derive_room_id_v3, derive_share_epoch_room_secret};
use crate::review::ids::RoomId;

const RECORD_VERSION: u32 = 3;
const RECORD_FILENAME: &str = "share.json";

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
        let record =
            serde_json::from_slice::<DurableShareRecord>(bytes.as_slice()).map_err(|error| {
                ShareLifecycleError::Store(format!("decode {}: {error}", path.display()))
            })?;
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

#[cfg(test)]
mod tests {
    use super::*;

    const SHARE_ID: &str = "AAECAwQFBgcICQoLDA0ODw";

    fn record(root: &Path) -> DurableShareRecord {
        let owner = root.join("owner.md");
        std::fs::write(&owner, "# Owner\n").expect("write owner");
        let owner = std::fs::canonicalize(owner).expect("canonical owner");
        DurableShareRecord::new(SHARE_ID.into(), [0x42; 32], owner, false).expect("record")
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
}
