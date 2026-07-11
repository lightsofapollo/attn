//! Share + Join bootstrap flow for `ReviewManager` (attn-nnj.6.6).
//!
//! Owns the lifecycle that turns a `ReviewCommand::Share`/`Join` into a live
//! room: device identity persistence, room/device registration against the
//! relay's HTTP control plane, signed `RoomCreated`/`ParticipantJoined` events,
//! and the on-disk `room.json` / `bindings.json` writes that make the room
//! durable.
//!
//! Spec:
//!   - `planning/collab/relay-spec.md` §`POST /v2/rooms/:roomId`,
//!     §`POST /v2/rooms/:roomId/devices`, §`GET /v2/rooms/:roomId/devices`.
//!   - `planning/collab/data-model.md` §Daemon Socket Commands, §Sync Cursors,
//!     §Review Manager.
//!   - `planning/collab/crypto-spec.md` §Key Derivation, §Identity And Key
//!     Hierarchy, §Hashcash Proof-of-Work, §Admission Key.
//!
//! Identity persistence (`~/.attn/identity.json`):
//!
//! ```json
//! {
//!   "deviceId":            "<base64url>",
//!   "participantId":       "<base64url>",
//!   "signingKey":          "<base64url Ed25519 seed (private)>",
//!   "publicSigningKey":    "<base64url Ed25519>",
//!   "publicEncryptionKey": "<base64url X25519>"
//! }
//! ```
//!
//! The encryption key is currently a deterministic public placeholder (the
//! Ed25519 public key, re-encoded) because attn-nnj.6.6 only exercises the
//! HTTP control plane — Curve25519 ECDH lands with the WebRTC issues. The
//! shape is fixed now so identity files written today don't need a schema
//! migration when ECDH lands.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::daemon::runtime_dir;
use crate::review::crypto::ids::{derive_envelope_id_for_event, derive_event_id};
use crate::review::crypto::kdf::{RoomKeys, derive_room_id, derive_room_id_v3, derive_room_keys};
use crate::review::crypto::pow::TokenPool;
use crate::review::crypto::signing::{DeviceSigningKey, DeviceVerifyingKey, SignError, sign_event};
use crate::review::envelope::{AssembleInput, assemble_event_envelope};
use crate::review::ids::{DeviceId, FileId, ParticipantId, RoomId, SnapshotId};
use crate::review::model::SnapshotPlaintext;
use crate::review::model::{
    Capability, Device, DeviceClient, EnvelopeKind, EventMeta, MailboxEnvelope, Participant,
    ParticipantKind, ReviewEvent, ReviewEventBody, ReviewRoom, RoomMode, RoomPolicy,
};
use crate::review::store::ReviewStore;
use crate::review::transport::inbound::{
    AuthorizationCache, RegisteredDeviceAuthorization, VerifyingKeyCache,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Filename for the persisted device identity inside `runtime_dir()`.
pub const IDENTITY_FILENAME: &str = "identity.json";

/// PoW difficulty surfaced to a fresh `TokenPool` for bootstrap device
/// registration. The relay clamps to its own min/max; we pick the
/// crypto-spec default so dev rooms still mint tokens quickly.
// Rooms minted by the daemon use the relay's *minimum* PoW difficulty
// (12 bits) rather than its default (16). 12-bit search completes in
// ~milliseconds vs 16-bit's ~hundreds; both are well above the
// abuse-deterrence floor. Keeping rooms at MIN_POW_BITS also means the
// outbox processor's `TokenPool` (which mints at the same difficulty)
// doesn't need to know the per-room policy before the first POST.
pub(crate) const BOOTSTRAP_POW_DIFFICULTY: u32 = 12;

/// PoW token TTL for bootstrap device registration. Matches the crypto-spec
/// default — tokens persist long enough for a single device-register retry
/// after PoW invalidation.
pub(crate) const BOOTSTRAP_POW_TTL_MS: u64 = crate::review::crypto::pow::DEFAULT_TTL_MS;

/// The relay's inline/R2 routing threshold for `kind=snapshot_blob`
/// envelopes (relay-spec.md §R2 spillover, `BLOB_SPILLOVER_THRESHOLD_BYTES`
/// in `relay/src/room-do.ts`). Ciphertexts at or below ride the mailbox
/// outbox; above, the sealed bytes are PUT to R2 and the envelope carries an
/// encrypted `BlobRef`. The relay rejects presigns at or below this value
/// (`ATTN_BLOB_TOO_SMALL`) and DO storage rejects inline envelopes above it,
/// so the constants MUST stay in lock-step.
const RELAY_BLOB_SPILLOVER_THRESHOLD_BYTES: u64 = 1024 * 1024;

/// Hosted review entry used when `ATTN_BROWSER_REVIEW_URL` is unset. Runtime
/// overrides are useful for staging/local builds, but production must not
/// silently default to the staging origin.
const DEFAULT_BROWSER_REVIEW_URL: &str = "https://attn.sh/review";

/// Default `RoomPolicy` for newly shared rooms.
///
/// Default mode is `Hybrid` — direct WebRTC when both peers are online,
/// mailbox fallback when they're not, transparent switching as
/// connectivity changes. The user-facing Share dialog does NOT expose
/// a mode picker (per UX feedback 2026-05-19: "I want not live or
/// envelope mode it should seamlessly do both"); only power-user CLI
/// paths can override.
///
/// Browser and remote-agent admission are enabled for shared rooms. Both still
/// require possession of the room secret and the normal relay admission proof;
/// these flags only permit the corresponding authenticated clients.
fn default_room_policy(created_at_ms: u64) -> RoomPolicy {
    RoomPolicy {
        mode: RoomMode::Hybrid,
        max_peers: 8,
        max_snapshot_bytes: 5 * 1024 * 1024,
        max_event_bytes: 256 * 1024,
        max_events: 500,
        // 24h TTL per relay-spec.md §`POST /v2/rooms/:roomId` (clamped to
        // `createdAt + 24h` unless `longSession`).
        expires_at: created_at_ms + 24 * 60 * 60 * 1000,
        delete_events_after_owner_ack: false,
        allow_browser: true,
        allow_remote_agents: true,
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors returned by the bootstrap flow.
///
/// Each variant maps to a distinct failure surface so the manager can decide
/// whether to retry, surface to the user, or short-circuit (e.g. malformed
/// invite is a hard parse error, not a transport retry).
#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error("identity persistence: {0}")]
    Identity(String),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("relay http {status}: {code}: {message}")]
    Relay {
        status: u16,
        code: String,
        message: String,
    },
    #[error("network: {0}")]
    Network(String),
    #[error("invite parse: {0}")]
    InviteParse(String),
    #[error("invalid share: {0}")]
    InvalidShare(String),
    #[error("store: {0}")]
    Store(String),
}

impl BootstrapError {
    /// True when the relay reports the room no longer exists (HTTP 404,
    /// `ATTN_ROOM_NOT_FOUND`). The caller prunes such rooms from the local
    /// store so the daemon stops resuming dead rooms on every boot.
    pub fn is_room_not_found(&self) -> bool {
        matches!(
            self,
            BootstrapError::Relay { status: 404, code, .. } if code == "ATTN_ROOM_NOT_FOUND"
        )
    }
}

impl From<SignError> for BootstrapError {
    fn from(e: SignError) -> Self {
        Self::Crypto(e.to_string())
    }
}

impl From<anyhow::Error> for BootstrapError {
    fn from(e: anyhow::Error) -> Self {
        Self::Store(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Device identity (~/.attn/identity.json)
// ---------------------------------------------------------------------------

/// On-disk device identity record. Persisted at `runtime_dir()/identity.json`
/// (so `ATTN_HOME` overrides are honored). Re-loaded on every Share/Join so
/// every room shares the same `(deviceId, participantId, signingKey)` triple.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub participant_id: String,
    /// 32-byte Ed25519 seed, base64url-no-pad. The matching public key is
    /// also stored so callers don't need to round-trip through Ed25519
    /// derivation to surface it to the relay/UI.
    pub signing_key: String,
    pub public_signing_key: String,
    /// Public encryption key (X25519). Placeholder during attn-nnj.6.6 — set
    /// to the Ed25519 public key so the field is wire-shaped; ECDH wiring
    /// lands with the WebRTC issues (Phase 4). Surfaced now so the identity
    /// file's schema doesn't need a future migration.
    pub public_encryption_key: String,
    /// Human display name peers see in presence + on comments/suggestions
    /// (attn onboarding). `None`/empty until the user sets one — the onboarding
    /// prompt seeds it from `resolve_default_display_name()`. `#[serde(default)]`
    /// so identity.json files written before this field still load.
    #[serde(default)]
    pub display_name: Option<String>,
}

impl DeviceIdentity {
    /// Generate a brand-new identity from OS entropy. The `deviceId` and
    /// `participantId` are random base64url labels so the relay can't
    /// correlate two unrelated installations sharing a name; the user-facing
    /// display name is decoupled and lives in the room directory.
    pub fn generate() -> Result<Self, BootstrapError> {
        // Ed25519 signing seed.
        let signing_key = DeviceSigningKey::generate()?;
        let vk = signing_key.verifying_key();
        let public_signing_key = URL_SAFE_NO_PAD.encode(vk.to_bytes());
        let signing_key_b64 = URL_SAFE_NO_PAD.encode(signing_key.to_bytes());

        // Random opaque ids. The relay caps deviceId/participantId at 64
        // chars; 16 random bytes -> 22 base64url chars — comfortably under.
        let mut device_id_bytes = [0u8; 16];
        let mut participant_id_bytes = [0u8; 16];
        getrandom::getrandom(&mut device_id_bytes)
            .map_err(|e| BootstrapError::Identity(format!("device id rng: {e}")))?;
        getrandom::getrandom(&mut participant_id_bytes)
            .map_err(|e| BootstrapError::Identity(format!("participant id rng: {e}")))?;

        Ok(Self {
            device_id: URL_SAFE_NO_PAD.encode(device_id_bytes),
            participant_id: URL_SAFE_NO_PAD.encode(participant_id_bytes),
            signing_key: signing_key_b64,
            public_signing_key: public_signing_key.clone(),
            // Placeholder per module docs — re-use the Ed25519 public key.
            // ECDH key generation lands with WebRTC (Phase 4).
            public_encryption_key: public_signing_key,
            // Decoupled from the crypto identity; set via the onboarding prompt.
            display_name: None,
        })
    }

    /// The display name peers should see for this device, falling back to the
    /// resolved OS/git default when the user hasn't set one. Never empty.
    pub fn effective_display_name(&self) -> String {
        match self.display_name.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => resolve_default_display_name(),
        }
    }

    /// Reconstruct the live `DeviceSigningKey` from the persisted seed.
    pub fn signing_key(&self) -> Result<DeviceSigningKey, BootstrapError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(self.signing_key.as_bytes())
            .map_err(|e| BootstrapError::Identity(format!("signing key decode: {e}")))?;
        let seed: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| BootstrapError::Identity("signing key must decode to 32 bytes".into()))?;
        Ok(DeviceSigningKey::from_bytes(&seed)?)
    }

    /// Reconstruct the verifying key from the persisted public bytes.
    pub fn verifying_key(&self) -> Result<DeviceVerifyingKey, BootstrapError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(self.public_signing_key.as_bytes())
            .map_err(|e| BootstrapError::Identity(format!("public key decode: {e}")))?;
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| BootstrapError::Identity("public key must decode to 32 bytes".into()))?;
        Ok(DeviceVerifyingKey::from_bytes(&arr)?)
    }

    /// Typed view of `device_id` as the cross-crate `DeviceId` newtype.
    pub fn typed_device_id(&self) -> DeviceId {
        serde_json::from_value(serde_json::Value::String(self.device_id.clone()))
            .expect("DeviceId deserializes from any non-empty string")
    }

    /// Typed view of `participant_id` as the cross-crate `ParticipantId` newtype.
    pub fn typed_participant_id(&self) -> ParticipantId {
        serde_json::from_value(serde_json::Value::String(self.participant_id.clone()))
            .expect("ParticipantId deserializes from any non-empty string")
    }
}

/// Resolve a friendly default display name for the onboarding prompt to
/// pre-fill: `git config user.name` → macOS full name (`id -F`) → `$USER`/
/// `$USERNAME` → `"Anonymous"`. Each source is trimmed and skipped when empty.
/// Pure best-effort — never errors, always returns a non-empty string.
pub fn resolve_default_display_name() -> String {
    fn run(cmd: &str, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new(cmd).args(args).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    run("git", &["config", "--get", "user.name"])
        .or_else(|| {
            // BSD `id -F` prints the user's full ("real") name on macOS.
            if cfg!(target_os = "macos") {
                run("id", &["-F"])
            } else {
                None
            }
        })
        .or_else(|| {
            std::env::var("USER")
                .ok()
                .or_else(|| std::env::var("USERNAME").ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "Anonymous".to_string())
}

/// Persist a user-chosen display name onto the identity at `dir`, creating the
/// identity first if it doesn't exist. An empty/whitespace name clears it back
/// to the resolved default. Returns the effective name now in force.
pub fn set_display_name_in(dir: &std::path::Path, name: &str) -> Result<String, BootstrapError> {
    let mut identity = load_or_create_identity_in(dir)?;
    let trimmed = name.trim();
    identity.display_name = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    save_identity_to(dir, &identity)?;
    Ok(identity.effective_display_name())
}

/// Path to the on-disk identity file inside `runtime_dir()`.
pub fn identity_path() -> Result<PathBuf, BootstrapError> {
    Ok(runtime_dir()
        .map_err(|e| BootstrapError::Identity(format!("runtime_dir: {e}")))?
        .join(IDENTITY_FILENAME))
}

/// Identity loader/saver with an explicit base directory. Tests bypass
/// `runtime_dir()` by calling these directly; production code uses
/// `load_or_create_identity()`.
pub fn load_identity_from(dir: &std::path::Path) -> Result<Option<DeviceIdentity>, BootstrapError> {
    let path = dir.join(IDENTITY_FILENAME);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let id: DeviceIdentity = serde_json::from_slice(&bytes)
                .map_err(|e| BootstrapError::Identity(format!("decode {}: {e}", path.display())))?;
            Ok(Some(id))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(BootstrapError::Identity(format!(
            "read {}: {err}",
            path.display()
        ))),
    }
}

/// Write `identity` to `dir/identity.json` atomically (tmp + rename).
pub fn save_identity_to(
    dir: &std::path::Path,
    identity: &DeviceIdentity,
) -> Result<(), BootstrapError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| BootstrapError::Identity(format!("create dir {}: {e}", dir.display())))?;
    let path = dir.join(IDENTITY_FILENAME);
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(identity)
        .map_err(|e| BootstrapError::Identity(format!("serialize identity: {e}")))?;
    std::fs::write(&tmp, &bytes)
        .map_err(|e| BootstrapError::Identity(format!("write {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        BootstrapError::Identity(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        ))
    })?;
    Ok(())
}

/// Load the device identity at `runtime_dir()` WITHOUT creating one. Used at
/// startup to surface the profile (display name) to the UI without eagerly
/// minting crypto keys for users who never collaborate.
pub fn load_identity() -> Result<Option<DeviceIdentity>, BootstrapError> {
    let dir = runtime_dir().map_err(|e| BootstrapError::Identity(format!("runtime_dir: {e}")))?;
    load_identity_from(&dir)
}

/// Persist a user-chosen display name onto the identity at `runtime_dir()`.
/// Thin wrapper over [`set_display_name_in`] for the daemon IPC handler.
pub fn set_display_name(name: &str) -> Result<String, BootstrapError> {
    let dir = runtime_dir().map_err(|e| BootstrapError::Identity(format!("runtime_dir: {e}")))?;
    set_display_name_in(&dir, name)
}

/// Load (or generate-and-save) the device identity at `runtime_dir()`.
///
/// Generation only happens on a true miss; once written, the same identity
/// is reused across every Share/Join (and across daemon restarts) so each
/// machine has one stable `(deviceId, participantId, signingKey)` triple.
pub fn load_or_create_identity() -> Result<DeviceIdentity, BootstrapError> {
    let dir = runtime_dir().map_err(|e| BootstrapError::Identity(format!("runtime_dir: {e}")))?;
    load_or_create_identity_in(&dir)
}

/// Like `load_or_create_identity` but with an explicit directory. Used by the
/// bootstrap flow when a manager-scoped override is in play and by tests.
pub fn load_or_create_identity_in(dir: &std::path::Path) -> Result<DeviceIdentity, BootstrapError> {
    if let Some(existing) = load_identity_from(dir)? {
        return Ok(existing);
    }
    let identity = DeviceIdentity::generate()?;
    save_identity_to(dir, &identity)?;
    Ok(identity)
}

// ---------------------------------------------------------------------------
// Invite parsing
// ---------------------------------------------------------------------------

/// Parsed result of an `attn://review/<roomId>#key=<base64url>` invite URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInvite {
    pub room_id: RoomId,
    pub room_secret: [u8; 32],
}

/// Additive v3 invite tier. Production v2 `#key=` parsing remains separate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteTierV3 {
    View,
    Comment,
    Suggest,
}

impl InviteTierV3 {
    fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Comment => "comment",
            Self::Suggest => "suggest",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInviteFragmentV3 {
    pub tier: InviteTierV3,
    pub read_capability_key: [u8; 32],
    pub write_admission_key: Option<[u8; 32]>,
    pub grant_signature: Option<[u8; 64]>,
}

/// Build a strict canonical v3 capability fragment, including the leading `#`.
pub fn build_invite_fragment_v3(
    tier: InviteTierV3,
    read_capability_key: &[u8; 32],
    write_admission_key: Option<&[u8; 32]>,
    grant_signature: Option<&[u8; 64]>,
) -> Result<String, BootstrapError> {
    let read = URL_SAFE_NO_PAD.encode(read_capability_key);
    match (tier, write_admission_key, grant_signature) {
        (InviteTierV3::View, None, None) => Ok(format!("#v=3&tier=view&read={read}")),
        (InviteTierV3::View, _, _) => Err(BootstrapError::InviteParse(
            "view tier must not include write capability or grant".into(),
        )),
        (InviteTierV3::Comment | InviteTierV3::Suggest, Some(write), Some(grant)) => Ok(format!(
            "#v=3&tier={}&read={read}&write={}&grant={}",
            tier.as_str(),
            URL_SAFE_NO_PAD.encode(write),
            URL_SAFE_NO_PAD.encode(grant),
        )),
        (InviteTierV3::Comment | InviteTierV3::Suggest, _, _) => {
            Err(BootstrapError::InviteParse(format!(
                "{} tier requires write capability and owner grant",
                tier.as_str()
            )))
        }
    }
}

/// Parse only the additive v3 fragment grammar. Duplicate/unknown fields,
/// tier/write mismatches, invalid lengths, and noncanonical ordering fail.
pub fn parse_invite_fragment_v3(fragment: &str) -> Result<ParsedInviteFragmentV3, BootstrapError> {
    let body = fragment
        .strip_prefix('#')
        .ok_or_else(|| BootstrapError::InviteParse("v3 fragment must start with `#`".into()))?;
    let mut fields = std::collections::BTreeMap::new();
    for part in body.split('&') {
        let (key, value) = part
            .split_once('=')
            .filter(|(key, value)| !key.is_empty() && !value.is_empty() && !value.contains('='))
            .ok_or_else(|| BootstrapError::InviteParse("malformed v3 fragment field".into()))?;
        if !matches!(key, "v" | "tier" | "read" | "write" | "grant") {
            return Err(BootstrapError::InviteParse(format!(
                "unknown v3 fragment field: {key}"
            )));
        }
        if fields.insert(key, value).is_some() {
            return Err(BootstrapError::InviteParse(format!(
                "duplicate v3 fragment field: {key}"
            )));
        }
    }
    if fields.get("v") != Some(&"3") {
        return Err(BootstrapError::InviteParse(
            "v3 fragment requires v=3".into(),
        ));
    }
    let tier = match fields.get("tier").copied() {
        Some("view") => InviteTierV3::View,
        Some("comment") => InviteTierV3::Comment,
        Some("suggest") => InviteTierV3::Suggest,
        other => {
            return Err(BootstrapError::InviteParse(format!(
                "unknown v3 invite tier: {other:?}"
            )));
        }
    };
    let decode = |field: &'static str| -> Result<[u8; 32], BootstrapError> {
        let encoded = fields
            .get(field)
            .ok_or_else(|| BootstrapError::InviteParse(format!("missing {field} capability")))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|error| {
                BootstrapError::InviteParse(format!("{field} capability base64url decode: {error}"))
            })?;
        bytes.try_into().map_err(|bytes: Vec<u8>| {
            BootstrapError::InviteParse(format!(
                "{field} capability must decode to 32 bytes, got {}",
                bytes.len()
            ))
        })
    };
    let read_capability_key = decode("read")?;
    let write_admission_key = fields.get("write").map(|_| decode("write")).transpose()?;
    let grant_signature = fields
        .get("grant")
        .map(|encoded| {
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded.as_bytes())
                .map_err(|error| {
                    BootstrapError::InviteParse(format!("grant base64url decode: {error}"))
                })?;
            bytes.try_into().map_err(|bytes: Vec<u8>| {
                BootstrapError::InviteParse(format!(
                    "grant must decode to 64 bytes, got {}",
                    bytes.len()
                ))
            })
        })
        .transpose()?;
    let canonical = build_invite_fragment_v3(
        tier,
        &read_capability_key,
        write_admission_key.as_ref(),
        grant_signature.as_ref(),
    )?;
    if canonical != fragment {
        return Err(BootstrapError::InviteParse(
            "v3 fragment is not in canonical field order or encoding".into(),
        ));
    }
    Ok(ParsedInviteFragmentV3 {
        tier,
        read_capability_key,
        write_admission_key,
        grant_signature,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInviteV3 {
    pub room_id: RoomId,
    pub fragment: ParsedInviteFragmentV3,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedInviteAny {
    V2(ParsedInvite),
    V3(ParsedInviteV3),
}

pub fn parse_invite_any(invite: &str) -> Result<ParsedInviteAny, BootstrapError> {
    let rest = invite
        .strip_prefix("attn://review/")
        .ok_or_else(|| BootstrapError::InviteParse(format!("missing prefix: {invite}")))?;
    let (room_id, fragment) = rest
        .split_once('#')
        .ok_or_else(|| BootstrapError::InviteParse("missing invite fragment".into()))?;
    if room_id.is_empty() {
        return Err(BootstrapError::InviteParse("empty roomId".into()));
    }
    if fragment.starts_with("v=3&") {
        let room_id = serde_json::from_value(serde_json::Value::String(room_id.to_owned()))
            .expect("RoomId deserializes from any string");
        return Ok(ParsedInviteAny::V3(ParsedInviteV3 {
            room_id,
            fragment: parse_invite_fragment_v3(&format!("#{fragment}"))?,
        }));
    }
    parse_invite(invite).map(ParsedInviteAny::V2)
}

pub(crate) fn canonical_device_grant_v3(
    room_id: &RoomId,
    tier: InviteTierV3,
) -> Result<Vec<u8>, BootstrapError> {
    let grant_tier = match tier {
        InviteTierV3::Comment => "comment",
        InviteTierV3::Suggest => "suggest",
        InviteTierV3::View => {
            return Err(BootstrapError::InviteParse(
                "view tier has no device grant".into(),
            ));
        }
    };
    crate::review::crypto::canonical::to_canonical_bytes(&serde_json::json!({
        "grantTier": grant_tier,
        "purpose": "attn device grant v3",
        "roomId": room_id.as_str(),
        "v": 3,
    }))
    .map_err(|error| BootstrapError::Crypto(format!("canonicalize device grant: {error}")))
}

pub fn build_invite_url_v3(
    room_id: &RoomId,
    room_secret: &[u8; 32],
    tier: InviteTierV3,
    owner_signing_key: &DeviceSigningKey,
) -> Result<String, BootstrapError> {
    use crate::review::crypto::kdf::derive_room_key_tree_v3;
    use ed25519_dalek::Signer as _;
    let tree = derive_room_key_tree_v3(room_secret);
    let grant = if tier == InviteTierV3::View {
        None
    } else {
        let key = ed25519_dalek::SigningKey::from_bytes(&owner_signing_key.to_bytes());
        Some(
            key.sign(&canonical_device_grant_v3(room_id, tier)?)
                .to_bytes(),
        )
    };
    let fragment = build_invite_fragment_v3(
        tier,
        tree.read_keys.read_capability_key.as_bytes(),
        (tier != InviteTierV3::View).then_some(tree.write_admission_key.as_bytes()),
        grant.as_ref(),
    )?;
    Ok(format!("attn://review/{}{fragment}", room_id.as_str()))
}

pub fn verify_invite_grant_v3(
    invite: &ParsedInviteV3,
    owner_public_key: &[u8; 32],
) -> Result<(), BootstrapError> {
    if invite.fragment.tier == InviteTierV3::View {
        return invite
            .fragment
            .grant_signature
            .is_none()
            .then_some(())
            .ok_or_else(|| BootstrapError::InviteParse("view invite carried a grant".into()));
    }
    let signature = invite
        .fragment
        .grant_signature
        .ok_or_else(|| BootstrapError::InviteParse("writable invite missing owner grant".into()))?;
    use ed25519_dalek::Verifier as _;
    let owner = ed25519_dalek::VerifyingKey::from_bytes(owner_public_key)
        .map_err(|error| BootstrapError::Crypto(format!("owner public key: {error}")))?;
    owner
        .verify(
            &canonical_device_grant_v3(&invite.room_id, invite.fragment.tier)?,
            &ed25519_dalek::Signature::from_bytes(&signature),
        )
        .map_err(|_| BootstrapError::InviteParse("owner grant signature invalid".into()))
}

pub fn build_browser_invite_url_v3(
    room_id: &RoomId,
    room_secret: &[u8; 32],
    tier: InviteTierV3,
    owner_signing_key: &DeviceSigningKey,
) -> Result<String, BootstrapError> {
    let native = build_invite_url_v3(room_id, room_secret, tier, owner_signing_key)?;
    build_browser_invite_url_v3_from_base(&browser_review_base_url()?, room_id, &native)
}

fn build_browser_invite_url_v3_from_base(
    base: &reqwest::Url,
    room_id: &RoomId,
    native: &str,
) -> Result<String, BootstrapError> {
    let fragment = native
        .split_once('#')
        .map(|(_, fragment)| fragment)
        .expect("v3 invite always has a fragment");
    let mut url = base.clone();
    let base_path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{base_path}/{}", room_id.as_str()));
    url.set_fragment(Some(fragment));
    Ok(url.to_string())
}

/// Re-emit a capability-scoped invite for an already-persisted owner share.
/// `target` may be its room id or the exact shared path from local-shares.json.
pub fn build_existing_share_invite_v3(
    store_root: &std::path::Path,
    identity: &DeviceIdentity,
    target: &str,
    tier: InviteTierV3,
    browser: bool,
) -> Result<String, BootstrapError> {
    let shares = load_local_shares(store_root)?;
    let room_id_str = shares
        .iter()
        .find_map(|(room_id, record)| {
            (room_id == target || record.path == target).then_some(room_id.clone())
        })
        .ok_or_else(|| {
            BootstrapError::InvalidShare(format!(
                "no existing local share matches room or path {target:?}"
            ))
        })?;
    let room_id = serde_json::from_value(serde_json::Value::String(room_id_str))
        .expect("RoomId deserializes from any string");
    let room = ReviewStore::open_at(store_root.to_path_buf())
        .map_err(|error| BootstrapError::Store(format!("open review store: {error}")))?
        .load_room(&room_id)
        .map_err(|error| BootstrapError::Store(format!("load room: {error}")))?
        .ok_or_else(|| {
            BootstrapError::InvalidShare("local share room metadata is missing".into())
        })?;
    if room.v != 3 || load_room_access_v3(store_root, &room_id)?.is_none() {
        return Err(BootstrapError::InvalidShare(
            "legacy v2 shares cannot emit v3 tiered invites; create a new share".into(),
        ));
    }
    let secret = load_room_secret(store_root, &room_id)?;
    let signing_key = identity.signing_key()?;
    if browser {
        build_browser_invite_url_v3(&room_id, &secret, tier, &signing_key)
    } else {
        build_invite_url_v3(&room_id, &secret, tier, &signing_key)
    }
}

/// Translate a `RoomMode` to its wire-format string. Matches the IPC mode
/// strings the frontend already deals with for ShareDialog mode selection
/// (`live` / `async` / `hybrid`).
pub(crate) fn room_mode_wire(mode: RoomMode) -> String {
    match mode {
        RoomMode::Live => "live".to_string(),
        RoomMode::Async => "async".to_string(),
        RoomMode::Hybrid => "hybrid".to_string(),
    }
}

/// Build the invite URL for a freshly minted room.
pub fn build_invite_url(room_id: &RoomId, room_secret: &[u8; 32]) -> String {
    format!(
        "attn://review/{}#key={}",
        room_id.as_str(),
        URL_SAFE_NO_PAD.encode(room_secret)
    )
}

/// Build the HTTPS invite for the hosted reviewer. The room secret is carried
/// exclusively in the URL fragment, which browsers do not send to the server.
/// `ATTN_BROWSER_REVIEW_URL` may override the production base for staging or
/// local development.
pub fn build_browser_invite_url(
    room_id: &RoomId,
    room_secret: &[u8; 32],
) -> Result<String, BootstrapError> {
    let base = browser_review_base_url()?;
    Ok(build_browser_invite_url_from_base(
        &base,
        room_id,
        room_secret,
    ))
}

fn browser_review_base_url() -> Result<reqwest::Url, BootstrapError> {
    let configured = std::env::var("ATTN_BROWSER_REVIEW_URL").ok();
    parse_browser_review_base_url(configured.as_deref())
}

fn parse_browser_review_base_url(configured: Option<&str>) -> Result<reqwest::Url, BootstrapError> {
    let raw = configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BROWSER_REVIEW_URL);
    let url = reqwest::Url::parse(raw).map_err(|_| {
        BootstrapError::InvalidShare(
            "ATTN_BROWSER_REVIEW_URL must be an absolute HTTP(S) URL".into(),
        )
    })?;
    let secure_transport = url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
            ));
    if !secure_transport
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BootstrapError::InvalidShare(
            "ATTN_BROWSER_REVIEW_URL must use HTTPS (or exact loopback HTTP) without credentials, query, or fragment"
                .into(),
        ));
    }
    Ok(url)
}

fn build_browser_invite_url_from_base(
    base: &reqwest::Url,
    room_id: &RoomId,
    room_secret: &[u8; 32],
) -> String {
    let mut invite = base.clone();
    let base_path = invite.path().trim_end_matches('/').to_string();
    invite.set_path(&format!("{base_path}/{}", room_id.as_str()));
    invite.set_fragment(Some(&format!(
        "key={}",
        URL_SAFE_NO_PAD.encode(room_secret)
    )));
    invite.to_string()
}

/// Parse an `attn://review/<roomId>#key=<base64url>` invite. Strict: the
/// scheme, host segment, and fragment shape must all match; anything else is
/// surfaced as a `BootstrapError::InviteParse`.
pub fn parse_invite(invite: &str) -> Result<ParsedInvite, BootstrapError> {
    let rest = invite
        .strip_prefix("attn://review/")
        .ok_or_else(|| BootstrapError::InviteParse("missing attn review prefix".into()))?;
    let (room_id_str, fragment) = rest
        .split_once('#')
        .ok_or_else(|| BootstrapError::InviteParse("missing key fragment".into()))?;
    if room_id_str.is_empty() {
        return Err(BootstrapError::InviteParse("empty roomId".into()));
    }
    let key_b64 = fragment
        .strip_prefix("key=")
        .ok_or_else(|| BootstrapError::InviteParse("fragment must start with `key=`".into()))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(key_b64.as_bytes())
        .map_err(|e| BootstrapError::InviteParse(format!("key base64url decode: {e}")))?;
    let room_secret: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        BootstrapError::InviteParse(format!(
            "room secret must decode to 32 bytes, got {}",
            bytes.len()
        ))
    })?;

    // Cross-check the encoded roomId against the derived one — catches a
    // tampered invite where someone swapped the path without re-deriving.
    let derived = derive_room_id(&room_secret);
    if derived.as_str() != room_id_str {
        return Err(BootstrapError::InviteParse(format!(
            "roomId mismatch: invite says {room_id_str}, derived from key says {}",
            derived.as_str()
        )));
    }
    Ok(ParsedInvite {
        room_id: derived,
        room_secret,
    })
}

// ---------------------------------------------------------------------------
// HTTP wire shapes
// ---------------------------------------------------------------------------

/// `POST /v2/rooms/:roomId` request body. Mirrors `relay-spec.md` §`POST
/// /v2/rooms/:roomId` exactly so a wiremock corpus rebuild against the relay
/// catches drift.
#[derive(Debug, Serialize)]
struct CreateRoomBody<'a> {
    v: u32,
    policy: &'a WirePolicy,
    /// `base64url(Ed25519 public)`.
    #[serde(rename = "ownerSigningKey")]
    owner_signing_key: &'a str,
    /// `base64url(admissionKey)`. NOT part of the v2 relay spec — included
    /// here so the relay (which derives admission via the same KDF when it
    /// later mints sub-tokens) can sanity-check the binding without
    /// regenerating it from the (unknown) roomSecret. Treated as advisory by
    /// the relay; a future relay-spec revision will codify this header.
    #[serde(rename = "admissionKey")]
    admission_key: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomBodyV3<'a> {
    v: u32,
    policy: &'a WirePolicy,
    owner_signing_key: &'a str,
    read_admission_key: String,
    write_admission_key: String,
}

/// Wire-form `RoomPolicy` exactly matching relay-spec.md §`POST /v2/rooms/:roomId`.
/// Distinct from `model::RoomPolicy` so we can serialize the optional
/// `idleTimeoutMs` / `longSession` / `powBits` fields the relay accepts even
/// though `model::RoomPolicy` doesn't carry them (the local model only
/// persists the values that survive a server clamp; relay-only fields like
/// `powBits` live on the wire form alone).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WirePolicy {
    mode: &'static str,
    max_peers: u32,
    max_snapshot_bytes: u64,
    max_event_bytes: u64,
    max_events: u32,
    expires_at: u64,
    /// Default idle alarm (1h). Relay clamps to `[1m, expiresAt]`.
    idle_timeout_ms: u64,
    long_session: bool,
    pow_bits: u32,
    delete_events_after_owner_ack: bool,
    allow_browser: bool,
    allow_remote_agents: bool,
}

impl WirePolicy {
    fn from_model(policy: &RoomPolicy) -> Self {
        Self {
            mode: match policy.mode {
                RoomMode::Live => "live",
                RoomMode::Async => "async",
                RoomMode::Hybrid => "hybrid",
            },
            max_peers: policy.max_peers,
            max_snapshot_bytes: policy.max_snapshot_bytes,
            max_event_bytes: policy.max_event_bytes,
            max_events: policy.max_events,
            expires_at: policy.expires_at,
            idle_timeout_ms: 60 * 60 * 1000,
            long_session: false,
            pow_bits: BOOTSTRAP_POW_DIFFICULTY,
            delete_events_after_owner_ack: policy.delete_events_after_owner_ack,
            allow_browser: policy.allow_browser,
            allow_remote_agents: policy.allow_remote_agents,
        }
    }
}

/// `POST /v2/rooms/:roomId` success response (201 or 200).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomResponse {
    #[allow(dead_code)]
    room_id: String,
    #[allow(dead_code)]
    created_at: u64,
    #[allow(dead_code)]
    expires_at: u64,
    /// Server-clamped policy. We round-trip-deserialize as a JSON value
    /// rather than `WirePolicy` so any extra fields the relay tacks on
    /// (idle_timeout_ms, etc) don't fail us.
    #[allow(dead_code)]
    policy: serde_json::Value,
    #[allow(dead_code)]
    owner_signing_key_id: String,
    #[allow(dead_code)]
    server_seq: u64,
}

/// `POST /v2/rooms/:roomId/devices` request body. Spec: relay-spec.md
/// §`POST /v2/rooms/:roomId/devices`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceBody {
    device_id: String,
    participant_id: String,
    public_signing_key: String,
    public_encryption_key: String,
    /// Always `attn-native` from the Rust daemon. Browser/agent registrations
    /// land via different binaries.
    client: String,
    /// `owner` for Share, `reviewer` for Join. Agents lie outside 6.6.
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant_tier: Option<crate::review::transport::inbound::GrantTier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant_signature: Option<String>,
    /// `base64url(Ed25519 signature)` over the canonical body without
    /// `selfSignature`. See relay-spec.md §`POST /v2/rooms/:roomId/devices`
    /// "verify selfSignature".
    self_signature: String,
}

/// `GET /v2/rooms/:roomId/devices` response shape.
#[derive(Debug, Deserialize)]
struct ListDevicesResponse {
    devices: Vec<DirectoryDevice>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryDevice {
    device_id: String,
    participant_id: String,
    public_signing_key: String,
    public_encryption_key: String,
    client: String,
    kind: String,
    #[serde(default)]
    grant_tier: Option<crate::review::transport::inbound::GrantTier>,
    #[serde(default)]
    grant_signature: Option<String>,
    self_signature: String,
    #[allow(dead_code)]
    registered_at: u64,
}

/// Generic relay error body. Mirrors relay-spec.md §Wire Conventions.
#[derive(Debug, Deserialize)]
struct RelayErrorBody {
    error: RelayErrorInner,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayErrorInner {
    code: String,
    #[serde(default)]
    message: String,
}

// ---------------------------------------------------------------------------
// Bootstrap configuration + outcomes
// ---------------------------------------------------------------------------

/// Live configuration for the bootstrap flow. Carried as `Arc<>` inside
/// `ReviewManager` so the same relay URL + HTTP client is reused across every
/// Share/Join.
#[derive(Debug, Clone)]
pub struct BootstrapConfig {
    /// Base URL of the relay (e.g. `https://relay.attn.dev`). No trailing slash.
    pub relay_url: String,
    /// Directory in which `identity.json` lives. When `None`, derived from
    /// `runtime_dir()` on demand.
    pub identity_dir: Option<PathBuf>,
}

impl BootstrapConfig {
    /// Resolve the identity directory, honoring `ATTN_HOME` via `runtime_dir()`
    /// when no explicit override is set.
    pub fn identity_dir(&self) -> Result<PathBuf, BootstrapError> {
        match &self.identity_dir {
            Some(p) => Ok(p.clone()),
            None => runtime_dir().map_err(|e| BootstrapError::Identity(e.to_string())),
        }
    }
}

/// Successful Share outcome — carries native/browser invites plus the room id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareOutcome {
    pub room_id: RoomId,
    /// Native deep link retained for desktop/CLI compatibility.
    pub invite: String,
    /// HTTPS link for the hosted reviewer. The secret remains fragment-only.
    pub browser_invite: String,
    pub view_invite: String,
    pub suggest_invite: String,
    pub browser_view_invite: String,
    pub browser_suggest_invite: String,
    /// Absolute path (file or folder) the owner shared, exactly as the frontend
    /// passed it to `reviewShare` (`path.to_string_lossy()`). The Share dialog
    /// matches this against the active target to recognise its own room (see
    /// `shareTargetMatches`), so it must be the verbatim path string.
    pub owner_display_path: String,
    /// `true` if the room was newly created, `false` if `Share` was a no-op
    /// because the bindings file already had an entry pointing at a live room.
    pub newly_created: bool,
    /// Owner's public signing key (base64url). The frontend hashes this to
    /// render the verify-key fingerprint that the owner reads out-of-band.
    pub owner_signing_key: String,
    /// The mode the room was minted with (`"live"` / `"async"` / `"hybrid"`),
    /// so the frontend can render the right ReviewBar / mode badge without
    /// re-querying the room file.
    pub mode: String,
    /// Wall-clock ms timestamp when the room expires. Drives the "Expires
    /// in ..." countdown in the dialog.
    pub expires_at: u64,
}

/// Owner material produced when a durable share creates or recreates one
/// deterministic epoch room. The caller owns the long-lived share record;
/// Bootstrapper remains the sole authority for ordinary v3 room creation,
/// device registration, grants, and local room/snapshot persistence.
pub struct DurableEpochRoomOutcome {
    pub room_id: RoomId,
    pub owner_signing_key: String,
    pub device_id: String,
    pub read_capability_key: zeroize::Zeroizing<[u8; 32]>,
    pub write_admission_key: zeroize::Zeroizing<[u8; 32]>,
    pub comment_grant_signature: [u8; 64],
    pub suggest_grant_signature: [u8; 64],
    pub snapshots: Vec<DurableEpochSnapshot>,
}

pub struct DurableEpochSnapshot {
    pub file_id: FileId,
    pub snapshot_id: SnapshotId,
    pub plaintext: SnapshotPlaintext,
}

#[derive(Deserialize)]
struct FrozenAcks {
    accepted: Vec<FrozenAck>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrozenAck {
    envelope_id: String,
    server_seq: u64,
}

fn validate_frozen_acks(expected_ids: &[&str], bytes: &[u8]) -> Result<u64, BootstrapError> {
    let parsed: FrozenAcks = serde_json::from_slice(bytes).map_err(|error| {
        BootstrapError::Network(format!("decode frozen envelope ACKs: {error}"))
    })?;
    if parsed.accepted.len() != expected_ids.len() {
        return Err(BootstrapError::Network(
            "frozen envelope ACK count mismatch".into(),
        ));
    }
    let mut previous = None;
    for (expected_id, ack) in expected_ids.iter().zip(&parsed.accepted) {
        if ack.envelope_id != *expected_id || ack.server_seq == 0 {
            return Err(BootstrapError::Network(
                "frozen envelope ACK identity/sequence mismatch".into(),
            ));
        }
        if previous.is_some_and(|seq| ack.server_seq != seq + 1) {
            return Err(BootstrapError::Network(
                "frozen envelope ACK sequences are not contiguous".into(),
            ));
        }
        previous = Some(ack.server_seq);
    }
    previous.ok_or_else(|| BootstrapError::Network("frozen envelope ACK set is empty".into()))
}

impl Drop for DurableEpochSnapshot {
    fn drop(&mut self) {
        use zeroize::Zeroize as _;
        self.plaintext.content.zeroize();
        if let Some(index) = &mut self.plaintext.anchor_index {
            for block in &mut index.blocks {
                block.snapshot_block_id.zeroize();
                block.content_fingerprint.zeroize();
                block.text_hash.zeroize();
                block.normalized_text_hash.zeroize();
                block.previous_block_hash.zeroize();
                block.next_block_hash.zeroize();
                for heading in &mut block.heading_path {
                    heading.text_hash.zeroize();
                }
            }
            for heading in &mut index.headings {
                heading.text.zeroize();
                heading.text_hash.zeroize();
                for ancestor in &mut heading.path {
                    ancestor.text_hash.zeroize();
                }
            }
        }
    }
}

impl std::fmt::Debug for DurableEpochRoomOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DurableEpochRoomOutcome")
            .field("room_id", &self.room_id)
            .field("owner_signing_key", &self.owner_signing_key)
            .field("device_id", &self.device_id)
            .field("read_capability_key", &"[REDACTED]")
            .field("write_admission_key", &"[REDACTED]")
            .field(
                "snapshots",
                &format_args!("[{} plaintext snapshots]", self.snapshots.len()),
            )
            .finish_non_exhaustive()
    }
}

/// Successful Join outcome — carries the room id the user joined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinOutcome {
    pub room_id: RoomId,
    pub local_grant_tier: Option<crate::review::transport::inbound::GrantTier>,
}

/// Result of `Bootstrapper::send_event_sync` — the signed event for local
/// echo plus the AEAD envelope that's now durable in the outbox.
#[derive(Debug, Clone)]
pub struct SendEventOutcome {
    pub event: ReviewEvent,
    pub envelope: MailboxEnvelope,
    /// `false` if `append_outbox` deduped against an existing envelopeId.
    pub appended_to_outbox: bool,
}

// ---------------------------------------------------------------------------
// Bootstrapper
// ---------------------------------------------------------------------------

/// Runs the Share + Join bootstrap pipelines against the relay HTTP API.
///
/// Stateless across calls. Each Share/Join call:
///   1. Loads or generates the local device identity.
///   2. Derives room keys (Share-only generates a fresh `roomSecret`; Join
///      decodes it from the invite).
///   3. POSTs `/v2/rooms/:roomId` (Share creates, Join asserts existence — the
///      relay's idempotent create means a Join can also call POST safely; per
///      relay-spec.md §`POST /v2/rooms/:roomId` "If the room exists, ignore
///      the body and return the stored policy as 200").
///   4. POSTs `/v2/rooms/:roomId/devices` with the caller's keys + selfSig.
///   5. (Join-only) GETs the device directory to seed the verifying-key cache.
///   6. Signs the appropriate `ReviewEvent` (`RoomCreated` / `ParticipantJoined`)
///      and assembles an encrypted envelope onto the outbox.
///   7. Persists `room.json` + `bindings.json` + the identity itself.
pub struct Bootstrapper {
    store: Arc<ReviewStore>,
    http: reqwest::Client,
    config: Arc<BootstrapConfig>,
}

impl Bootstrapper {
    /// Idempotently assert the deterministic epoch room and owner device.
    /// Returns `true` only when the relay created a missing room (HTTP 201),
    /// allowing durable-share reconciliation to republish snapshots before it
    /// restores the public pointer.
    pub async fn touch_durable_epoch_room(
        &self,
        room_secret: [u8; 32],
    ) -> Result<bool, BootstrapError> {
        let room_secret = zeroize::Zeroizing::new(room_secret);
        let now_ms = unix_now_ms();
        let identity = load_or_create_identity_in(&self.config.identity_dir()?)?;
        let room_id = derive_room_id_v3(&room_secret);
        let tree = crate::review::crypto::kdf::derive_room_key_tree_v3(&room_secret);
        let created = self
            .create_room_v3(
                &room_id,
                &default_room_policy(now_ms),
                &identity,
                tree.read_keys.read_admission_key.as_bytes(),
                tree.write_admission_key.as_bytes(),
            )
            .await?;
        self.register_device_v3(
            &room_id,
            &identity,
            "owner",
            "attn-native",
            None,
            None,
            tree.write_admission_key.as_bytes(),
        )
        .await?;
        Ok(created)
    }

    /// Register a visitor's already-signed v3 device body into a recreated
    /// durable epoch room without reauthoring it. The exact body supplied by
    /// the frozen `review_submission` remains self-signed by that visitor;
    /// the owner only contributes the room write admission and relay PoW.
    pub async fn register_frozen_device_v3(
        &self,
        room_id: &RoomId,
        registration: &serde_json::Value,
        write_admission_key: &[u8; 32],
    ) -> Result<(), BootstrapError> {
        let device_id = registration
            .get("deviceId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                BootstrapError::InvalidShare("frozen registration has no deviceId".into())
            })?;
        let body = serde_json::to_vec(registration)
            .map_err(|error| BootstrapError::Crypto(format!("serialize frozen device: {error}")))?;
        let path = format!("/v3/rooms/{}/devices", room_id.as_str());
        let pow = TokenPool::new(
            room_id.as_str().to_owned(),
            device_id.to_owned(),
            BOOTSTRAP_POW_DIFFICULTY,
            BOOTSTRAP_POW_TTL_MS,
        )
        .take("POST", &path)
        .await
        .map_err(|error| BootstrapError::Crypto(format!("frozen device PoW: {error}")))?;
        let response = self
            .http
            .post(format!(
                "{}{}",
                self.config.relay_url.trim_end_matches('/'),
                path
            ))
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )
            .header(
                "Attn-Admission",
                admission_header_value_v3(write_admission_key, "write", "POST", &path, &body),
            )
            .header("Attn-PoW", pow)
            .body(body)
            .send()
            .await
            .map_err(|error| BootstrapError::Network(format!("POST frozen v3 device: {error}")))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| BootstrapError::Network(format!("read frozen v3 device: {error}")))?;
        match status.as_u16() {
            200 | 204 => Ok(()),
            status => Err(relay_error(status, &bytes)),
        }
    }

    /// Forward a validated durable submission into the current room without
    /// decrypt/re-encrypt or authorship changes. The exact frozen envelopes
    /// are posted in their original order before ShareDO's pointer is touched.
    pub async fn post_frozen_envelopes_v3(
        &self,
        room_id: &RoomId,
        device_id: &str,
        envelopes: &[MailboxEnvelope],
        write_admission_key: &[u8; 32],
    ) -> Result<u64, BootstrapError> {
        if envelopes.is_empty() || envelopes.len() > 8 {
            return Err(BootstrapError::InvalidShare(
                "durable submission must forward 1..8 envelopes".into(),
            ));
        }
        #[derive(Serialize)]
        struct FrozenBatch<'a> {
            envelopes: &'a [MailboxEnvelope],
        }
        let body = serde_json::to_vec(&FrozenBatch { envelopes })
            .map_err(|error| BootstrapError::Crypto(format!("serialize frozen batch: {error}")))?;
        let path = format!("/v3/rooms/{}/envelopes", room_id.as_str());
        let pow = TokenPool::new(
            room_id.as_str().to_owned(),
            device_id.to_owned(),
            BOOTSTRAP_POW_DIFFICULTY,
            BOOTSTRAP_POW_TTL_MS,
        )
        .take("POST", &path)
        .await
        .map_err(|error| BootstrapError::Crypto(format!("frozen envelope PoW: {error}")))?;
        let response = self
            .http
            .post(format!(
                "{}{}",
                self.config.relay_url.trim_end_matches('/'),
                path
            ))
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )
            .header(
                "Attn-Admission",
                admission_header_value_v3(write_admission_key, "write", "POST", &path, &body),
            )
            .header("Attn-PoW", pow)
            .body(body)
            .send()
            .await
            .map_err(|error| BootstrapError::Network(format!("POST frozen envelopes: {error}")))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| {
            BootstrapError::Network(format!("read frozen envelope ACKs: {error}"))
        })?;
        match status.as_u16() {
            200 | 201 => {
                let expected = envelopes
                    .iter()
                    .map(|envelope| envelope.envelope_id.as_str())
                    .collect::<Vec<_>>();
                validate_frozen_acks(&expected, &bytes)
            }
            status => Err(relay_error(status, &bytes)),
        }
    }

    /// Borrow the active `BootstrapConfig`. Callers in `ReviewManager` use
    /// this to read the relay URL + identity dir when spawning per-room
    /// transports — there's no Bootstrapper method for those flows
    /// (different cross-cutting concern) but they share configuration.
    pub fn config(&self) -> &BootstrapConfig {
        &self.config
    }

    /// Construct a bootstrapper with a fresh `reqwest::Client`. Tests inject
    /// their own client via `with_http_client`.
    pub fn new(store: Arc<ReviewStore>, config: Arc<BootstrapConfig>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .context("build reqwest client")?;
        Ok(Self {
            store,
            http,
            config,
        })
    }

    /// Test-only constructor that injects a pre-built client. Mirrors the
    /// pattern in `transport::mailbox::OutboxProcessor::with_http_client`.
    pub fn with_http_client(
        store: Arc<ReviewStore>,
        config: Arc<BootstrapConfig>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            store,
            http,
            config,
        }
    }

    // -----------------------------------------------------------------
    // Share
    // -----------------------------------------------------------------

    /// Share a path as a new review room. Returns the invite URL on success.
    ///
    /// Re-Share of the same path is idempotent: if `bindings.json` already
    /// records a `LocalFileBinding` whose room hasn't expired, we look up the
    /// room secret stashed on disk and re-emit the same invite without any
    /// network calls.
    /// Sign + enqueue the owner's self `ParticipantJoined` announce
    /// (attn-42y). Joiners emit one in `join_with_identity`, but the owner
    /// historically never did — so owner-authored comments degraded to a
    /// raw participant id on every window. Called on fresh mint AND on
    /// re-Share: re-announcing is harmless (frontends key names by
    /// participantId, last write wins), backfills rooms shared before this
    /// landed, and refreshes a display name changed since the first share.
    fn announce_owner(
        &self,
        room_id: &RoomId,
        room_keys: &RoomKeys,
        policy: &RoomPolicy,
        identity: &DeviceIdentity,
        now_ms: u64,
    ) -> Result<(), BootstrapError> {
        self.announce_participant_with_event_key(
            room_id,
            *room_keys.event_key.as_bytes(),
            policy,
            identity,
            ParticipantKind::Owner,
            now_ms,
        )
    }

    /// Sign + enqueue a `ParticipantJoined` announce for the local identity
    /// with the given kind. Shared by the owner's share-time announce and
    /// `reannounce_identity` (display-name changes). Re-announcing is
    /// harmless: frontends key names by participantId, last write wins.
    fn announce_participant(
        &self,
        room_id: &RoomId,
        room_keys: &RoomKeys,
        policy: &RoomPolicy,
        identity: &DeviceIdentity,
        kind: ParticipantKind,
        now_ms: u64,
    ) -> Result<(), BootstrapError> {
        self.announce_participant_with_event_key(
            room_id,
            *room_keys.event_key.as_bytes(),
            policy,
            identity,
            kind,
            now_ms,
        )
    }

    fn announce_participant_with_event_key(
        &self,
        room_id: &RoomId,
        event_key: [u8; 32],
        policy: &RoomPolicy,
        identity: &DeviceIdentity,
        kind: ParticipantKind,
        now_ms: u64,
    ) -> Result<(), BootstrapError> {
        let participant_id = identity.typed_participant_id();
        let device_id = identity.typed_device_id();
        let participant = Participant {
            participant_id: participant_id.clone(),
            display_name: identity.effective_display_name(),
            kind,
            public_signing_key: identity.public_signing_key.clone(),
            capabilities: agent_capabilities(kind),
        };
        let device = Device {
            device_id: device_id.clone(),
            participant_id: participant_id.clone(),
            public_encryption_key: identity.public_encryption_key.clone(),
            public_signing_key: identity.public_signing_key.clone(),
            client: DeviceClient::AttnNative,
            created_at: now_ms,
        };
        let joined_body = ReviewEventBody::ParticipantJoined {
            participant,
            device,
        };
        let joined_envelope = assemble_event_envelope(AssembleInput {
            event_key,
            signing_key: identity.signing_key()?,
            room_id: room_id.clone(),
            author_id: participant_id,
            device_id,
            created_at_ms: now_ms,
            expires_at_ms: policy.expires_at,
            parent_event_ids: vec![],
            snapshot_id: None,
            body: joined_body,
            kind: EnvelopeKind::Event,
            client_nonce: None,
        })
        .map_err(|e| BootstrapError::Crypto(format!("assemble ParticipantJoined envelope: {e}")))?;
        self.store
            .append_outbox(room_id, &joined_envelope)
            .map_err(|e| BootstrapError::Store(format!("append ParticipantJoined outbox: {e}")))?;
        Ok(())
    }

    /// Re-announce the local identity into an existing room — the fix for
    /// "I renamed myself but my comments still show the old name": the
    /// original `ParticipantJoined` is emitted at share/join time with the
    /// then-current name, and the onboarding NamePrompt fires AFTER a room
    /// is entered, so a name typed there never reached already-active
    /// rooms. Reads the room secret + policy from disk; the caller supplies
    /// the participant kind (owner for locally-shared rooms, reviewer
    /// otherwise).
    pub fn reannounce_identity(
        &self,
        room_id: &RoomId,
        kind: ParticipantKind,
    ) -> Result<(), BootstrapError> {
        let identity_dir = self.config.identity_dir()?;
        let identity = load_or_create_identity_in(&identity_dir)?;
        let secret = load_room_secret(self.store.root(), room_id)?;
        let now_ms = unix_now_ms();
        let policy = self
            .store
            .load_room(room_id)
            .ok()
            .flatten()
            .map(|r| r.policy)
            .unwrap_or_else(|| default_room_policy(now_ms));
        if let Some(access) = load_room_access_v3(self.store.root(), room_id)? {
            let read = crate::review::crypto::kdf::derive_read_keys_v3(&access.read_capability_key);
            self.announce_participant_with_event_key(
                room_id,
                *read.event_key.as_bytes(),
                &policy,
                &identity,
                kind,
                now_ms,
            )
        } else {
            let keys = derive_room_keys(&secret);
            self.announce_participant(room_id, &keys, &policy, &identity, kind, now_ms)
        }
    }

    pub async fn share(
        &self,
        path: PathBuf,
        mode: RoomMode,
        _ttl: Option<String>,
    ) -> Result<ShareOutcome, BootstrapError> {
        let now_ms = unix_now_ms();
        // Validate deployment configuration before creating any relay or local
        // state. The parsed base contains no room secret and is safe to retain.
        let browser_review_base = browser_review_base_url()?;
        let identity_dir = self.config.identity_dir()?;
        let identity = load_or_create_identity_in(&identity_dir)?;
        let doc_targets = validate_share_targets(&path)?;

        // 1. Re-Share of the same path: reuse the existing room id + invite, but
        //    RE-ESTABLISH the room on the relay first. The local binding only
        //    proves WE still think the room is live (room.json TTL); the relay
        //    may have expired/deleted it (or it lived on a different instance),
        //    which left the owner endlessly dialing a dead room (404 storm).
        //    create_room is idempotent on roomId — a no-op when the room exists,
        //    a clean re-create (same id, derived from the secret) when it's gone.
        if let Some(existing) = self.find_existing_share(&path, now_ms, &browser_review_base)? {
            let secret = load_room_secret(self.store.root(), &existing.room_id)?;
            let keys = derive_room_keys(&secret);
            let v3_access = load_room_access_v3(self.store.root(), &existing.room_id)?;
            let policy = self
                .store
                .load_room(&existing.room_id)
                .ok()
                .flatten()
                .map(|r| r.policy)
                .unwrap_or_else(|| {
                    let mut p = default_room_policy(now_ms);
                    p.mode = mode;
                    p
                });
            // Re-establish the existing room (idempotent create + device
            // register). If the relay rejects it — e.g. the room expired
            // server-side while the local binding's TTL still looked live —
            // the binding is stale: forget it and fall through to mint a FRESH
            // room, so a re-Share always yields a working invite instead of
            // hanging the dialog on "generated when the room is ready".
            let reestablished = if let Some(access) = v3_access {
                let tree = crate::review::crypto::kdf::derive_room_key_tree_v3(&secret);
                self.create_room_v3(
                    &existing.room_id,
                    &policy,
                    &identity,
                    tree.read_keys.read_admission_key.as_bytes(),
                    tree.write_admission_key.as_bytes(),
                )
                .await
                .is_ok()
                    && self
                        .register_device_v3(
                            &existing.room_id,
                            &identity,
                            "owner",
                            "attn-native",
                            None,
                            None,
                            access
                                .write_admission_key
                                .as_ref()
                                .unwrap_or(tree.write_admission_key.as_bytes()),
                        )
                        .await
                        .is_ok()
            } else {
                self.create_room(&existing.room_id, &policy, &identity, &keys.admission_key)
                    .await
                    .is_ok()
                    && self
                        .register_device(&existing.room_id, &identity, "owner", &keys.admission_key)
                        .await
                        .is_ok()
            };
            if reestablished {
                // Re-announce the owner on every re-Share: backfills rooms
                // shared before the owner self-announce existed and picks up
                // a display name changed since the original share.
                if let Some(access) = load_room_access_v3(self.store.root(), &existing.room_id)? {
                    let read = crate::review::crypto::kdf::derive_read_keys_v3(
                        &access.read_capability_key,
                    );
                    self.announce_participant_with_event_key(
                        &existing.room_id,
                        *read.event_key.as_bytes(),
                        &policy,
                        &identity,
                        ParticipantKind::Owner,
                        now_ms,
                    )?;
                } else {
                    self.announce_owner(&existing.room_id, &keys, &policy, &identity, now_ms)?;
                }
                return Ok(existing);
            }
            tracing::warn!(
                "re-establishing existing share room {} failed (likely expired on the relay); minting a fresh room",
                existing.room_id.as_str()
            );
            let _ = self.store.delete_room(&existing.room_id);
            // fall through to the fresh-mint path below
        }

        // 2. Mint room secret + derive room id and keys.
        let mut room_secret = [0u8; 32];
        getrandom::getrandom(&mut room_secret)
            .map_err(|e| BootstrapError::Crypto(format!("room secret rng: {e}")))?;
        let room_id = derive_room_id_v3(&room_secret);
        let room_keys = crate::review::crypto::kdf::derive_room_key_tree_v3(&room_secret);

        let policy = {
            let mut p = default_room_policy(now_ms);
            p.mode = mode;
            p
        };

        // 3. Register the room with the relay. Idempotent on roomId; returns
        //    200 with the stored policy if it already exists.
        let _created = self
            .create_room_v3(
                &room_id,
                &policy,
                &identity,
                room_keys.read_keys.read_admission_key.as_bytes(),
                room_keys.write_admission_key.as_bytes(),
            )
            .await?;

        // 4. Publish the owner device.
        self.register_device_v3(
            &room_id,
            &identity,
            "owner",
            "attn-native",
            None,
            None,
            room_keys.write_admission_key.as_bytes(),
        )
        .await?;

        // 5. Sign + enqueue a RoomCreated envelope so the room's append-only
        //    log starts with the right genesis event. The outbox processor
        //    (attn-nnj.6.2) picks this up on its next drain.
        let signing_key = identity.signing_key()?;
        let participant_id = identity.typed_participant_id();
        let device_id = identity.typed_device_id();

        let body = ReviewEventBody::RoomCreated {
            room_id: room_id.clone(),
            policy: policy.clone(),
            created_by: participant_id.clone(),
        };
        let event_id_for_room = derive_event_id(
            &EventMeta {
                v: 2,
                event_id: placeholder_event_id(),
                room_id: room_id.clone(),
                author_id: participant_id.clone(),
                device_id: device_id.clone(),
                created_at: now_ms,
                parent_event_ids: vec![],
                snapshot_id: None,
            },
            &body,
        )
        .map_err(|e| BootstrapError::Crypto(format!("derive RoomCreated event id: {e}")))?;
        let envelope = assemble_event_envelope(AssembleInput {
            event_key: *room_keys.read_keys.event_key.as_bytes(),
            signing_key,
            room_id: room_id.clone(),
            author_id: participant_id.clone(),
            device_id: device_id.clone(),
            created_at_ms: now_ms,
            expires_at_ms: policy.expires_at,
            parent_event_ids: vec![],
            snapshot_id: None,
            body: body.clone(),
            kind: EnvelopeKind::Event,
            client_nonce: None,
        })
        .map_err(|e| BootstrapError::Crypto(format!("assemble RoomCreated envelope: {e}")))?;
        self.store
            .append_outbox(&room_id, &envelope)
            .map_err(|e| BootstrapError::Store(format!("append RoomCreated outbox: {e}")))?;

        // 5b. Announce the owner identity (display name) into the room log.
        self.announce_participant_with_event_key(
            &room_id,
            *room_keys.read_keys.event_key.as_bytes(),
            &policy,
            &identity,
            ParticipantKind::Owner,
            now_ms,
        )?;

        // 6. Persist the room state on disk. We snapshot a `ReviewRoom` with
        //    no documents/snapshots yet — that wiring lands when SnapshotCreated
        //    flows through ReviewManager. The path is recorded in `bindings.json`
        //    keyed by a placeholder FileId-shaped key derived from the invite,
        //    so a re-Share of the same path can short-circuit (see
        //    `find_existing_share`).
        let review_room = ReviewRoom {
            v: 3,
            room_id: room_id.clone(),
            created_at: now_ms,
            created_by: participant_id.clone(),
            policy: policy.clone(),
            documents: Default::default(),
            snapshots: Default::default(),
            event_heads: vec![event_id_for_room.clone()],
        };
        self.store
            .save_room(&review_room)
            .map_err(|e| BootstrapError::Store(format!("save_room: {e}")))?;
        let is_dir = path.is_dir();
        save_room_secret(self.store.root(), &room_id, &room_secret)?;
        save_room_access_v3(
            self.store.root(),
            &room_id,
            &RoomAccessV3 {
                read_capability_key: *room_keys.read_keys.read_capability_key.as_bytes(),
                write_admission_key: Some(*room_keys.write_admission_key.as_bytes()),
                grant_tier: None,
                grant_signature: None,
            },
        )?;
        record_local_share(self.store.root(), &room_id, &path, is_dir)?;

        // 6b. Publish the initial snapshot(s) so reviewers get the doc bytes the
        //     moment they join. A single file → just it; a folder-share → every
        //     `*.md` under the directory (recursively, skipping ignored dirs).
        //     New files added to a shared folder later are picked up by the
        //     fs-watcher → `republish_snapshot_for_path`. Failures are non-fatal
        //     — the room exists; log and continue.
        let mut published = 0usize;
        let mut publish_errors = Vec::new();
        for doc_path in doc_targets {
            match self
                .publish_initial_snapshot(&room_id, &doc_path, now_ms)
                .await
            {
                Ok(_) => published += 1,
                Err(err) => {
                    publish_errors.push(format!("{}: {err}", doc_path.display()));
                    tracing::warn!(
                        "publish_initial_snapshot failed (room={}, file={}): {err}",
                        room_id.as_str(),
                        doc_path.display()
                    );
                }
            }
        }
        if published == 0 {
            return Err(BootstrapError::InvalidShare(format!(
                "no markdown snapshots could be published for {}{}",
                path.display(),
                if publish_errors.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", publish_errors.join("; "))
                }
            )));
        }

        // 7. Build invite. `room_secret` is consumed when we encode it into the
        //    URL — after this point it only lives encrypted in the room file
        //    cache + on the relay (in the admissionKey form).
        let owner_key = identity.signing_key()?;
        let invite =
            build_invite_url_v3(&room_id, &room_secret, InviteTierV3::Comment, &owner_key)?;
        let view_invite =
            build_invite_url_v3(&room_id, &room_secret, InviteTierV3::View, &owner_key)?;
        let suggest_invite =
            build_invite_url_v3(&room_id, &room_secret, InviteTierV3::Suggest, &owner_key)?;
        let browser_invite =
            build_browser_invite_url_v3_from_base(&browser_review_base, &room_id, &invite)?;
        let browser_view_invite =
            build_browser_invite_url_v3_from_base(&browser_review_base, &room_id, &view_invite)?;
        let browser_suggest_invite =
            build_browser_invite_url_v3_from_base(&browser_review_base, &room_id, &suggest_invite)?;

        Ok(ShareOutcome {
            room_id,
            invite,
            browser_invite,
            view_invite,
            suggest_invite,
            browser_view_invite,
            browser_suggest_invite,
            owner_display_path: path.to_string_lossy().to_string(),
            newly_created: true,
            owner_signing_key: identity.public_signing_key.clone(),
            mode: room_mode_wire(policy.mode),
            expires_at: policy.expires_at,
        })
    }

    /// Create (or idempotently recreate) an ordinary v3 room from an exact
    /// caller-supplied secret. Durable shares derive this secret from
    /// `(shareSecret, epoch)`; it must never be replaced by fresh randomness.
    ///
    /// The room is fully usable before this returns: owner registration and
    /// local room/access state are durable, and every current document has a
    /// published snapshot. The durable-share caller may therefore upload the
    /// returned plaintexts and flip its public room pointer only afterwards.
    pub async fn create_durable_epoch_room(
        &self,
        path: PathBuf,
        room_secret: [u8; 32],
    ) -> Result<DurableEpochRoomOutcome, BootstrapError> {
        use ed25519_dalek::Signer as _;

        let room_secret = zeroize::Zeroizing::new(room_secret);
        let now_ms = unix_now_ms();
        let identity_dir = self.config.identity_dir()?;
        let identity = load_or_create_identity_in(&identity_dir)?;
        let doc_targets = validate_share_targets(&path)?;
        let room_id = derive_room_id_v3(&room_secret);
        let room_keys = crate::review::crypto::kdf::derive_room_key_tree_v3(&room_secret);
        let policy = default_room_policy(now_ms);

        self.create_room_v3(
            &room_id,
            &policy,
            &identity,
            room_keys.read_keys.read_admission_key.as_bytes(),
            room_keys.write_admission_key.as_bytes(),
        )
        .await?;
        self.register_device_v3(
            &room_id,
            &identity,
            "owner",
            "attn-native",
            None,
            None,
            room_keys.write_admission_key.as_bytes(),
        )
        .await?;

        // Same-epoch reconciliation must never reset local history or append
        // another genesis. A missing relay room can be recreated under the
        // same deterministic id while the owner's existing append-only log
        // and latest plaintext snapshots remain authoritative locally.
        if let Some(mut local_room) = self
            .store
            .load_room(&room_id)
            .map_err(|error| BootstrapError::Store(format!("load durable epoch room: {error}")))?
        {
            // A same-epoch relay recovery extends the local policy too, so a
            // subsequent daemon resume does not discard the renewed runtime.
            local_room.policy.expires_at = policy.expires_at;
            self.store.save_room(&local_room).map_err(|error| {
                BootstrapError::Store(format!("refresh durable room policy: {error}"))
            })?;
            let mut desired_file_ids = std::collections::BTreeSet::new();
            let mut desired_targets = Vec::with_capacity(doc_targets.len());
            for doc_path in &doc_targets {
                let existing = find_room_for_path(self.store.root(), doc_path)?.and_then(
                    |(candidate_room, file_id)| {
                        (candidate_room == room_id).then_some(file_id).flatten()
                    },
                );
                let file_id = match existing {
                    Some(file_id) => file_id,
                    None => {
                        self.publish_initial_snapshot(&room_id, doc_path, now_ms)
                            .await?
                            .0
                    }
                };
                desired_file_ids.insert(file_id.as_str().to_owned());
                desired_targets.push((doc_path.clone(), file_id));
            }
            let mut latest =
                std::collections::BTreeMap::<String, crate::review::model::SnapshotNode>::new();
            for node in self.store.iter_snapshots(&room_id).map_err(|error| {
                BootstrapError::Store(format!("iterate durable snapshots: {error}"))
            })? {
                let node = node.map_err(|error| {
                    BootstrapError::Store(format!("decode durable snapshot: {error}"))
                })?;
                let key = node.file_id.as_str().to_owned();
                if !desired_file_ids.contains(&key) {
                    continue;
                }
                let replace = latest.get(&key).is_none_or(|current| {
                    (node.created_at, node.snapshot_id.as_str())
                        > (current.created_at, current.snapshot_id.as_str())
                });
                if replace {
                    latest.insert(key, node);
                }
            }
            for (doc_path, file_id) in desired_targets {
                let source = std::fs::read_to_string(&doc_path).map_err(|error| {
                    BootstrapError::InvalidShare(format!(
                        "cannot read current durable source {}: {error}",
                        doc_path.display()
                    ))
                })?;
                let expected_doc_type = if is_html_path(&doc_path) {
                    crate::review::model::DocType::Html
                } else {
                    crate::review::model::DocType::Markdown
                };
                let matches_source = latest
                    .get(file_id.as_str())
                    .and_then(|node| node.plaintext.as_ref())
                    .is_some_and(|plaintext| {
                        plaintext.doc_type == expected_doc_type
                            && plaintext.content.as_deref() == Some(source.as_str())
                    });
                if matches_source {
                    continue;
                }
                let (_, snapshot_id) = self
                    .publish_snapshot(&room_id, &doc_path, Some(file_id.clone()), now_ms)
                    .await?;
                let node = self
                    .store
                    .load_snapshot(&room_id, &snapshot_id)
                    .map_err(|error| {
                        BootstrapError::Store(format!("load recovered durable snapshot: {error}"))
                    })?
                    .ok_or_else(|| {
                        BootstrapError::Store("recovered durable snapshot is missing".into())
                    })?;
                latest.insert(file_id.as_str().to_owned(), node);
            }
            let snapshots = latest
                .into_values()
                .map(|node| {
                    let plaintext = node.plaintext.ok_or_else(|| {
                        BootstrapError::Store(
                            "latest durable snapshot has no local plaintext".into(),
                        )
                    })?;
                    Ok(DurableEpochSnapshot {
                        file_id: node.file_id,
                        snapshot_id: node.snapshot_id,
                        plaintext,
                    })
                })
                .collect::<Result<Vec<_>, BootstrapError>>()?;
            let signer = ed25519_dalek::SigningKey::from_bytes(&identity.signing_key()?.to_bytes());
            return Ok(DurableEpochRoomOutcome {
                room_id: room_id.clone(),
                owner_signing_key: identity.public_signing_key,
                device_id: identity.device_id,
                read_capability_key: zeroize::Zeroizing::new(
                    *room_keys.read_keys.read_capability_key.as_bytes(),
                ),
                write_admission_key: zeroize::Zeroizing::new(
                    *room_keys.write_admission_key.as_bytes(),
                ),
                comment_grant_signature: signer
                    .sign(&canonical_device_grant_v3(&room_id, InviteTierV3::Comment)?)
                    .to_bytes(),
                suggest_grant_signature: signer
                    .sign(&canonical_device_grant_v3(&room_id, InviteTierV3::Suggest)?)
                    .to_bytes(),
                snapshots,
            });
        }

        let participant_id = identity.typed_participant_id();
        let device_id = identity.typed_device_id();
        let body = ReviewEventBody::RoomCreated {
            room_id: room_id.clone(),
            policy: policy.clone(),
            created_by: participant_id.clone(),
        };
        let event_id_for_room = derive_event_id(
            &EventMeta {
                v: 2,
                event_id: placeholder_event_id(),
                room_id: room_id.clone(),
                author_id: participant_id.clone(),
                device_id: device_id.clone(),
                created_at: now_ms,
                parent_event_ids: vec![],
                snapshot_id: None,
            },
            &body,
        )
        .map_err(|error| BootstrapError::Crypto(format!("derive RoomCreated id: {error}")))?;
        let envelope = assemble_event_envelope(AssembleInput {
            event_key: *room_keys.read_keys.event_key.as_bytes(),
            signing_key: identity.signing_key()?,
            room_id: room_id.clone(),
            author_id: participant_id.clone(),
            device_id: device_id.clone(),
            created_at_ms: now_ms,
            expires_at_ms: policy.expires_at,
            parent_event_ids: vec![],
            snapshot_id: None,
            body,
            kind: EnvelopeKind::Event,
            client_nonce: None,
        })
        .map_err(|error| BootstrapError::Crypto(format!("assemble RoomCreated: {error}")))?;
        self.store
            .append_outbox(&room_id, &envelope)
            .map_err(|error| BootstrapError::Store(format!("append RoomCreated: {error}")))?;
        self.announce_participant_with_event_key(
            &room_id,
            *room_keys.read_keys.event_key.as_bytes(),
            &policy,
            &identity,
            ParticipantKind::Owner,
            now_ms,
        )?;

        self.store
            .save_room(&ReviewRoom {
                v: 3,
                room_id: room_id.clone(),
                created_at: now_ms,
                created_by: participant_id,
                policy: policy.clone(),
                documents: Default::default(),
                snapshots: Default::default(),
                event_heads: vec![event_id_for_room],
            })
            .map_err(|error| BootstrapError::Store(format!("save durable epoch room: {error}")))?;
        save_room_secret(self.store.root(), &room_id, &room_secret)?;
        save_room_access_v3(
            self.store.root(),
            &room_id,
            &RoomAccessV3 {
                read_capability_key: *room_keys.read_keys.read_capability_key.as_bytes(),
                write_admission_key: Some(*room_keys.write_admission_key.as_bytes()),
                grant_tier: None,
                grant_signature: None,
            },
        )?;
        record_local_share(self.store.root(), &room_id, &path, path.is_dir())?;

        let mut snapshots = Vec::with_capacity(doc_targets.len());
        let mut failures = Vec::new();
        for doc_path in doc_targets {
            match self
                .publish_initial_snapshot(&room_id, &doc_path, now_ms)
                .await
            {
                Ok((file_id, snapshot_id)) => {
                    let node = self
                        .store
                        .load_snapshot(&room_id, &snapshot_id)
                        .map_err(|error| {
                            BootstrapError::Store(format!("load durable snapshot: {error}"))
                        })?
                        .ok_or_else(|| {
                            BootstrapError::Store("published durable snapshot is missing".into())
                        })?;
                    let plaintext = node.plaintext.ok_or_else(|| {
                        BootstrapError::Store(
                            "published durable snapshot has no local plaintext".into(),
                        )
                    })?;
                    snapshots.push(DurableEpochSnapshot {
                        file_id,
                        snapshot_id,
                        plaintext,
                    });
                }
                Err(error) => failures.push(format!("{}: {error}", doc_path.display())),
            }
        }
        if !failures.is_empty() {
            return Err(BootstrapError::InvalidShare(format!(
                "durable snapshot publication failed for {} ({})",
                path.display(),
                failures.join("; ")
            )));
        }

        let signer = ed25519_dalek::SigningKey::from_bytes(&identity.signing_key()?.to_bytes());
        let comment_grant_signature = signer
            .sign(&canonical_device_grant_v3(&room_id, InviteTierV3::Comment)?)
            .to_bytes();
        let suggest_grant_signature = signer
            .sign(&canonical_device_grant_v3(&room_id, InviteTierV3::Suggest)?)
            .to_bytes();
        Ok(DurableEpochRoomOutcome {
            room_id,
            owner_signing_key: identity.public_signing_key,
            device_id: identity.device_id,
            read_capability_key: zeroize::Zeroizing::new(
                *room_keys.read_keys.read_capability_key.as_bytes(),
            ),
            write_admission_key: zeroize::Zeroizing::new(*room_keys.write_admission_key.as_bytes()),
            comment_grant_signature,
            suggest_grant_signature,
            snapshots,
        })
    }

    /// Look up an existing share for `path` whose room hasn't expired. Returns
    /// `Ok(None)` when no live binding exists. The on-disk index is
    /// `{store_root}/shares/local-shares.json` (see `record_local_share`).
    fn find_existing_share(
        &self,
        path: &std::path::Path,
        now_ms: u64,
        browser_review_base: &reqwest::Url,
    ) -> Result<Option<ShareOutcome>, BootstrapError> {
        let shares = load_local_shares(self.store.root())?;
        for (room_id_str, record) in shares {
            if record.path != path.to_string_lossy() {
                continue;
            }
            let room_id: RoomId =
                serde_json::from_value(serde_json::Value::String(room_id_str.clone()))
                    .expect("RoomId deserializes from any string");
            // Honor the room's TTL by reading room.json — a re-Share that
            // races a policy expiry should still mint a fresh room.
            let room = self
                .store
                .load_room(&room_id)
                .map_err(|e| BootstrapError::Store(format!("load_room: {e}")))?;
            let policy = match room.as_ref().map(|r| r.policy.clone()) {
                Some(p) if p.expires_at > now_ms => p,
                _ => continue,
            };
            let secret = load_room_secret(self.store.root(), &room_id)?;
            // For the re-Share path we don't have the owner identity in
            // scope, so resolve it the same way `share()` does. The dialog
            // needs the signing key to render the fingerprint regardless of
            // whether this Share is a fresh mint or a cached re-emit.
            let identity_dir = self.config.identity_dir()?;
            let identity = load_or_create_identity_in(&identity_dir)?;
            let owner_key = identity.signing_key()?;
            let (invite, view_invite, suggest_invite) = if room.as_ref().is_some_and(|r| r.v == 3) {
                (
                    build_invite_url_v3(&room_id, &secret, InviteTierV3::Comment, &owner_key)?,
                    build_invite_url_v3(&room_id, &secret, InviteTierV3::View, &owner_key)?,
                    build_invite_url_v3(&room_id, &secret, InviteTierV3::Suggest, &owner_key)?,
                )
            } else {
                let legacy = build_invite_url(&room_id, &secret);
                (legacy.clone(), legacy.clone(), legacy)
            };
            let browser_invite = if room.as_ref().is_some_and(|r| r.v == 3) {
                build_browser_invite_url_v3_from_base(browser_review_base, &room_id, &invite)?
            } else {
                build_browser_invite_url_from_base(browser_review_base, &room_id, &secret)
            };
            let browser_view_invite = if room.as_ref().is_some_and(|r| r.v == 3) {
                build_browser_invite_url_v3_from_base(browser_review_base, &room_id, &view_invite)?
            } else {
                browser_invite.clone()
            };
            let browser_suggest_invite = if room.as_ref().is_some_and(|r| r.v == 3) {
                build_browser_invite_url_v3_from_base(
                    browser_review_base,
                    &room_id,
                    &suggest_invite,
                )?
            } else {
                browser_invite.clone()
            };
            let policy_mode = policy.mode;
            let expires_at = policy.expires_at;
            return Ok(Some(ShareOutcome {
                room_id,
                invite,
                browser_invite,
                view_invite,
                suggest_invite,
                browser_view_invite,
                browser_suggest_invite,
                owner_display_path: path.to_string_lossy().to_string(),
                newly_created: false,
                owner_signing_key: identity.public_signing_key.clone(),
                mode: room_mode_wire(policy_mode),
                expires_at,
            }));
        }
        Ok(None)
    }

    // -----------------------------------------------------------------
    // Join
    // -----------------------------------------------------------------

    /// Join an existing room from an invite as a regular reviewer.
    /// Loads (or generates) the daemon's `~/.attn/identity.json` and runs
    /// the shared [`Self::join_with_identity`] pipeline with
    /// `kind="reviewer"`.
    pub async fn join(
        &self,
        invite: &str,
        verifying_keys: Option<Arc<RwLock<std::collections::HashMap<String, DeviceVerifyingKey>>>>,
    ) -> Result<JoinOutcome, BootstrapError> {
        let identity_dir = self.config.identity_dir()?;
        let identity = load_or_create_identity_in(&identity_dir)?;
        self.join_with_identity(
            invite,
            &identity,
            ParticipantKind::Reviewer,
            DeviceClient::AttnNative,
            verifying_keys,
        )
        .await
    }

    /// Join an existing room from an invite as an `kind: "agent"`
    /// participant.
    ///
    /// Spec: `planning/collab/amendments.md` §Agent CLI key handling
    /// (the "Remote agents (different machines or hosted) join the room as
    /// `kind: "agent"` participants and are first-class members with their
    /// own keys, registered via `POST /devices` like any reviewer" bullet).
    ///
    /// `agent_identity` is the agent's own keypair as written by
    /// [`crate::review::agent_identity::register_agent_in`]. The daemon's
    /// owner identity is **not** touched — comments + suggestions emitted
    /// by this join are attributed to the agent participant.
    ///
    /// The device record sent to the relay uses `client: "agent-cli"` (the
    /// `agent-cli` variant on `DeviceClient`) so the relay's device
    /// directory can attribute traffic without an extra encoding.
    pub async fn join_as_agent(
        &self,
        invite: &str,
        agent_identity: &DeviceIdentity,
        verifying_keys: Option<Arc<RwLock<std::collections::HashMap<String, DeviceVerifyingKey>>>>,
    ) -> Result<JoinOutcome, BootstrapError> {
        self.join_with_identity(
            invite,
            agent_identity,
            ParticipantKind::Agent,
            DeviceClient::AgentCli,
            verifying_keys,
        )
        .await
    }

    /// Shared join pipeline. `kind` selects the wire-form `kind` field on
    /// `POST /devices` (`"reviewer"` or `"agent"`) and the local
    /// `ParticipantKind` baked into the `ParticipantJoined` event body.
    /// `client` selects the `DeviceClient` variant the relay uses for
    /// per-device attribution.
    ///
    /// Spec: relay-spec.md §`POST /v2/rooms/:roomId/devices` accepts
    /// `kind: "owner" | "reviewer" | "agent"`; data-model.md §Participant
    /// And Device documents the local model side.
    async fn join_with_identity(
        &self,
        invite: &str,
        identity: &DeviceIdentity,
        kind: ParticipantKind,
        client: DeviceClient,
        verifying_keys: Option<Arc<RwLock<std::collections::HashMap<String, DeviceVerifyingKey>>>>,
    ) -> Result<JoinOutcome, BootstrapError> {
        if let ParsedInviteAny::V3(parsed) = parse_invite_any(invite)? {
            return self
                .join_v3_with_identity(parsed, identity, kind, client, verifying_keys)
                .await;
        }
        let now_ms = unix_now_ms();
        let parsed = parse_invite(invite)?;
        let room_keys = derive_room_keys(&parsed.room_secret);

        // 1. Re-create the room on the relay. POST is idempotent — if the room
        //    exists the relay returns 200 with the stored policy and we move
        //    on. Per relay-spec.md, reviewer-side POST `/rooms/:roomId` is the
        //    canonical way to "join or rejoin" a room.
        let policy = default_room_policy(now_ms);
        self.create_room(&parsed.room_id, &policy, identity, &room_keys.admission_key)
            .await?;

        // 2. Register this device as a reviewer or agent per `kind`.
        //    Spec: relay-spec.md §`POST /v2/rooms/:roomId/devices`. The wire
        //    kind string is "agent" for remote agents (validated by 5.6's
        //    deviceRegistrationSchema enum).
        let wire_kind = match kind {
            ParticipantKind::Owner => "owner",
            ParticipantKind::Reviewer => "reviewer",
            ParticipantKind::Agent => "agent",
        };
        let wire_client = match client {
            DeviceClient::AttnNative => "attn-native",
            DeviceClient::AttnBrowser => "attn-browser",
            DeviceClient::AgentCli => "agent-cli",
        };
        self.register_device_with_client(
            &parsed.room_id,
            identity,
            wire_kind,
            wire_client,
            &room_keys.admission_key,
        )
        .await?;

        // 3. Fetch the device directory and seed the verifying-key cache so
        //    the inbound pipeline (attn-nnj.6.4) can verify event signatures
        //    from this point forward.
        let directory = self
            .list_devices(&parsed.room_id, &room_keys.admission_key)
            .await?;
        if let Some(cache) = verifying_keys.as_ref() {
            let mut guard = cache.write().await;
            for dev in &directory {
                let raw = URL_SAFE_NO_PAD
                    .decode(dev.public_signing_key.as_bytes())
                    .map_err(|e| BootstrapError::Crypto(format!("directory key decode: {e}")))?;
                let bytes: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
                    BootstrapError::Crypto("directory key must decode to 32 bytes".into())
                })?;
                let vk = DeviceVerifyingKey::from_bytes(&bytes)?;
                let key_id = vk.signing_key_id_base64url();
                guard.insert(key_id, vk);
            }
        }

        // 4. Sign + enqueue a ParticipantJoined event so the owner sees us in
        //    their inbox. Agents land in the event log with
        //    `ParticipantKind::Agent` so peer-strip + presence UI (10.5) can
        //    consult the kind for the hex chip + ⊳ glyph rendering.
        let signing_key = identity.signing_key()?;
        let participant_id = identity.typed_participant_id();
        let device_id = identity.typed_device_id();
        let vk = identity.verifying_key()?;
        let participant = Participant {
            participant_id: participant_id.clone(),
            // The user-chosen name (or resolved OS/git default) so peers see a
            // real name instead of the opaque participant id (attn onboarding).
            display_name: identity.effective_display_name(),
            kind,
            public_signing_key: identity.public_signing_key.clone(),
            capabilities: agent_capabilities(kind),
        };
        let _ = vk; // verifying key materialization sanity-checked the seed.
        let device_payload = Device {
            device_id: device_id.clone(),
            participant_id: participant_id.clone(),
            public_encryption_key: identity.public_encryption_key.clone(),
            public_signing_key: identity.public_signing_key.clone(),
            client,
            created_at: now_ms,
        };
        let body = ReviewEventBody::ParticipantJoined {
            participant,
            device: device_payload,
        };
        let envelope = assemble_event_envelope(AssembleInput {
            event_key: *room_keys.event_key.as_bytes(),
            signing_key,
            room_id: parsed.room_id.clone(),
            author_id: participant_id.clone(),
            device_id: device_id.clone(),
            created_at_ms: now_ms,
            expires_at_ms: policy.expires_at,
            parent_event_ids: vec![],
            snapshot_id: None,
            body: body.clone(),
            kind: EnvelopeKind::Event,
            client_nonce: None,
        })
        .map_err(|e| BootstrapError::Crypto(format!("assemble ParticipantJoined envelope: {e}")))?;
        self.store
            .append_outbox(&parsed.room_id, &envelope)
            .map_err(|e| BootstrapError::Store(format!("append ParticipantJoined outbox: {e}")))?;

        // 5. Persist a local `ReviewRoom`. The reviewer view starts empty —
        //    documents/snapshots fill in as snapshot envelopes arrive.
        //    Only on FIRST join though: a re-join over persisted state
        //    (same invite pasted twice, daemon restart + join) must not
        //    clobber the room.json that already accumulated
        //    documents/snapshots/event_heads — overwriting it with this
        //    empty shell orphaned the locally stored room state (attn-6dd).
        let already_known = self
            .store
            .load_room(&parsed.room_id)
            .map_err(|e| BootstrapError::Store(format!("load_room: {e}")))?
            .is_some();
        if !already_known {
            let review_room = ReviewRoom {
                v: 2,
                room_id: parsed.room_id.clone(),
                created_at: now_ms,
                created_by: participant_id.clone(),
                policy,
                documents: Default::default(),
                snapshots: Default::default(),
                event_heads: vec![],
            };
            self.store
                .save_room(&review_room)
                .map_err(|e| BootstrapError::Store(format!("save_room: {e}")))?;
        }
        save_room_secret(self.store.root(), &parsed.room_id, &parsed.room_secret)?;

        Ok(JoinOutcome {
            room_id: parsed.room_id,
            local_grant_tier: None,
        })
    }

    async fn join_v3_with_identity(
        &self,
        parsed: ParsedInviteV3,
        identity: &DeviceIdentity,
        kind: ParticipantKind,
        client: DeviceClient,
        verifying_keys: Option<VerifyingKeyCache>,
    ) -> Result<JoinOutcome, BootstrapError> {
        let grant_tier = match parsed.fragment.tier {
            InviteTierV3::View => {
                return Err(BootstrapError::InvalidShare(
                    "native view-only joins are not supported; open this invite in the browser"
                        .into(),
                ));
            }
            InviteTierV3::Comment => crate::review::transport::inbound::GrantTier::Comment,
            InviteTierV3::Suggest => crate::review::transport::inbound::GrantTier::Suggest,
        };
        let write_key = parsed.fragment.write_admission_key.ok_or_else(|| {
            BootstrapError::InviteParse("writable v3 invite missing write capability".into())
        })?;
        let grant = parsed.fragment.grant_signature.ok_or_else(|| {
            BootstrapError::InviteParse("writable v3 invite missing owner grant".into())
        })?;
        let read_keys =
            crate::review::crypto::kdf::derive_read_keys_v3(&parsed.fragment.read_capability_key);
        let wire_kind = match kind {
            ParticipantKind::Owner => "owner",
            ParticipantKind::Reviewer => "reviewer",
            ParticipantKind::Agent => "agent",
        };
        let wire_client = match client {
            DeviceClient::AttnNative => "attn-native",
            DeviceClient::AttnBrowser => "attn-browser",
            DeviceClient::AgentCli => "agent-cli",
        };
        self.register_device_v3(
            &parsed.room_id,
            identity,
            wire_kind,
            wire_client,
            Some(grant_tier),
            Some(&grant),
            &write_key,
        )
        .await?;
        let directory = self
            .list_devices_v3(&parsed.room_id, read_keys.read_admission_key.as_bytes())
            .await?;
        if let Some(cache) = verifying_keys {
            let mut guard = cache.write().await;
            for device in directory {
                let raw = URL_SAFE_NO_PAD
                    .decode(device.public_signing_key.as_bytes())
                    .map_err(|error| {
                        BootstrapError::Crypto(format!("directory key decode: {error}"))
                    })?;
                let bytes: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
                    BootstrapError::Crypto("directory key must decode to 32 bytes".into())
                })?;
                let key = DeviceVerifyingKey::from_bytes(&bytes)?;
                guard.insert(key.signing_key_id_base64url(), key);
            }
        }

        let now_ms = unix_now_ms();
        let policy = default_room_policy(now_ms);
        let participant_id = identity.typed_participant_id();
        let device_id = identity.typed_device_id();
        let capabilities = match (kind, grant_tier) {
            (ParticipantKind::Reviewer, crate::review::transport::inbound::GrantTier::Comment) => {
                vec![
                    Capability::ReadSnapshot,
                    Capability::WriteComment,
                    Capability::ResolveComment,
                ]
            }
            (ParticipantKind::Agent, crate::review::transport::inbound::GrantTier::Comment) => {
                vec![Capability::ReadSnapshot, Capability::WriteComment]
            }
            _ => agent_capabilities(kind),
        };
        let body = ReviewEventBody::ParticipantJoined {
            participant: Participant {
                participant_id: participant_id.clone(),
                display_name: identity.effective_display_name(),
                kind,
                public_signing_key: identity.public_signing_key.clone(),
                capabilities,
            },
            device: Device {
                device_id: device_id.clone(),
                participant_id: participant_id.clone(),
                public_encryption_key: identity.public_encryption_key.clone(),
                public_signing_key: identity.public_signing_key.clone(),
                client,
                created_at: now_ms,
            },
        };
        let envelope = assemble_event_envelope(AssembleInput {
            event_key: *read_keys.event_key.as_bytes(),
            signing_key: identity.signing_key()?,
            room_id: parsed.room_id.clone(),
            author_id: participant_id.clone(),
            device_id,
            created_at_ms: now_ms,
            expires_at_ms: policy.expires_at,
            parent_event_ids: vec![],
            snapshot_id: None,
            body,
            kind: EnvelopeKind::Event,
            client_nonce: None,
        })
        .map_err(|error| BootstrapError::Crypto(format!("assemble v3 join: {error}")))?;
        self.store
            .append_outbox(&parsed.room_id, &envelope)
            .map_err(|error| BootstrapError::Store(format!("append v3 join outbox: {error}")))?;
        if self
            .store
            .load_room(&parsed.room_id)
            .map_err(|error| BootstrapError::Store(format!("load v3 room: {error}")))?
            .is_none()
        {
            self.store
                .save_room(&ReviewRoom {
                    v: 3,
                    room_id: parsed.room_id.clone(),
                    created_at: now_ms,
                    created_by: participant_id,
                    policy,
                    documents: Default::default(),
                    snapshots: Default::default(),
                    event_heads: vec![],
                })
                .map_err(|error| BootstrapError::Store(format!("save v3 room: {error}")))?;
        }
        save_room_access_v3(
            self.store.root(),
            &parsed.room_id,
            &RoomAccessV3 {
                read_capability_key: parsed.fragment.read_capability_key,
                write_admission_key: Some(write_key),
                grant_tier: Some(grant_tier),
                grant_signature: Some(URL_SAFE_NO_PAD.encode(grant)),
            },
        )?;
        Ok(JoinOutcome {
            room_id: parsed.room_id,
            local_grant_tier: Some(grant_tier),
        })
    }

    // -----------------------------------------------------------------
    // Snapshot publishing — read the file off disk, build its AnchorIndex,
    // and emit a `SnapshotCreated` event carrying the inline plaintext so
    // reviewers can render the doc immediately on join. The plaintext is
    // still AEAD-encrypted on the wire (inside the event envelope) — the
    // `decision #14` separate-blob path is for snapshots large enough to
    // need R2 spillover, which doesn't apply to typical markdown docs.
    // -----------------------------------------------------------------

    /// Fetch the room's device directory from the relay and merge every
    /// device's verifying key into `cache`. Used by `ReviewManager` when it
    /// spins up a room runtime (Share or resume) so the InboundPipeline can
    /// verify signatures on envelopes — including the owner's own
    /// self-echoed snapshot, which the relay broadcasts back to the author.
    ///
    /// Idempotent: re-running just re-inserts the same keys. Reviewers'
    /// keys land here as `ParticipantJoined` events arrive, but seeding
    /// from the directory at startup avoids a window where early envelopes
    /// fail to verify with `unknown signer`.
    pub async fn refresh_device_keys(
        &self,
        room_id: &RoomId,
        cache: &VerifyingKeyCache,
    ) -> Result<usize, BootstrapError> {
        self.refresh_device_directory(room_id, cache, None).await
    }

    pub async fn refresh_device_authorizations(
        &self,
        room_id: &RoomId,
        cache: &VerifyingKeyCache,
        authorizations: &AuthorizationCache,
    ) -> Result<usize, BootstrapError> {
        self.refresh_device_directory(room_id, cache, Some(authorizations))
            .await
    }

    async fn refresh_device_directory(
        &self,
        room_id: &RoomId,
        cache: &VerifyingKeyCache,
        authorizations: Option<&AuthorizationCache>,
    ) -> Result<usize, BootstrapError> {
        let directory = if let Some(access) = load_room_access_v3(self.store.root(), room_id)? {
            let read = crate::review::crypto::kdf::derive_read_keys_v3(&access.read_capability_key);
            self.list_devices_v3(room_id, read.read_admission_key.as_bytes())
                .await?
        } else {
            let room_secret = load_room_secret(self.store.root(), room_id)?;
            let room_keys = derive_room_keys(&room_secret);
            self.list_devices(room_id, &room_keys.admission_key).await?
        };
        let persisted_device_keys = self.persisted_device_key_bindings(room_id)?;
        let mut guard = cache.write().await;
        let mut authorization_guard = match authorizations {
            Some(records) => Some(records.write().await),
            None => None,
        };
        let mut added = 0usize;
        let owners = directory
            .iter()
            .filter(|device| device.kind == "owner")
            .collect::<Vec<_>>();
        if owners.len() > 1 {
            return Err(BootstrapError::Crypto(
                "directory contains conflicting owner registrations".into(),
            ));
        }
        if owners
            .iter()
            .any(|owner| owner.grant_tier.is_some() || owner.grant_signature.is_some())
        {
            return Err(BootstrapError::Crypto(
                "directory owner registration must not contain a grant".into(),
            ));
        }
        let owner_grant_verifier = owners
            .first()
            .copied()
            .map(|device| {
                let raw = URL_SAFE_NO_PAD
                    .decode(device.public_signing_key.as_bytes())
                    .map_err(|e| {
                        BootstrapError::Crypto(format!("owner directory key decode: {e}"))
                    })?;
                let bytes: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
                    BootstrapError::Crypto("owner directory key must decode to 32 bytes".into())
                })?;
                ed25519_dalek::VerifyingKey::from_bytes(&bytes)
                    .map_err(|e| BootstrapError::Crypto(format!("owner directory key: {e}")))
            })
            .transpose()?;
        for dev in &directory {
            if dev.kind != "owner" && dev.grant_tier.is_some() != dev.grant_signature.is_some() {
                return Err(BootstrapError::Crypto(
                    "directory grant tier and owner signature must be paired".into(),
                ));
            }
            let raw = URL_SAFE_NO_PAD
                .decode(dev.public_signing_key.as_bytes())
                .map_err(|e| BootstrapError::Crypto(format!("directory key decode: {e}")))?;
            let bytes: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
                BootstrapError::Crypto("directory key must decode to 32 bytes".into())
            })?;
            let vk = DeviceVerifyingKey::from_bytes(&bytes)?;
            let registration = RegisterDeviceBody {
                device_id: dev.device_id.clone(),
                participant_id: dev.participant_id.clone(),
                public_signing_key: dev.public_signing_key.clone(),
                public_encryption_key: dev.public_encryption_key.clone(),
                client: dev.client.clone(),
                kind: dev.kind.clone(),
                grant_tier: dev.grant_tier,
                grant_signature: dev.grant_signature.clone(),
                self_signature: String::new(),
            };
            let canonical = canonical_register_device_bytes(&registration)?;
            let signature_bytes = URL_SAFE_NO_PAD
                .decode(dev.self_signature.as_bytes())
                .map_err(|e| {
                    BootstrapError::Crypto(format!("directory self signature decode: {e}"))
                })?;
            let signature = ed25519_dalek::Signature::from_slice(&signature_bytes)
                .map_err(|e| BootstrapError::Crypto(format!("directory self signature: {e}")))?;
            use ed25519_dalek::Verifier as _;
            let verifier = ed25519_dalek::VerifyingKey::from_bytes(&bytes)
                .map_err(|e| BootstrapError::Crypto(format!("directory verifying key: {e}")))?;
            verifier.verify(&canonical, &signature).map_err(|_| {
                BootstrapError::Crypto(
                    "directory self signature does not match registration".into(),
                )
            })?;
            if let Some(grant_tier) = dev.grant_tier {
                let grant_signature = dev.grant_signature.as_ref().ok_or_else(|| {
                    BootstrapError::Crypto("directory grant tier missing owner signature".into())
                })?;
                let owner = owner_grant_verifier.as_ref().ok_or_else(|| {
                    BootstrapError::Crypto("directory missing pinned owner grant key".into())
                })?;
                let grant_value = serde_json::json!({
                    "grantTier": grant_tier,
                    "purpose": "attn device grant v3",
                    "roomId": room_id.as_str(),
                    "v": 3,
                });
                let grant_bytes =
                    crate::review::crypto::canonical::to_canonical_bytes(&grant_value).map_err(
                        |e| BootstrapError::Crypto(format!("canonicalize directory grant: {e}")),
                    )?;
                let raw = URL_SAFE_NO_PAD
                    .decode(grant_signature.as_bytes())
                    .map_err(|e| {
                        BootstrapError::Crypto(format!("directory grant signature decode: {e}"))
                    })?;
                let signature = ed25519_dalek::Signature::from_slice(&raw).map_err(|e| {
                    BootstrapError::Crypto(format!("directory grant signature: {e}"))
                })?;
                owner.verify(&grant_bytes, &signature).map_err(|_| {
                    BootstrapError::Crypto("directory owner grant signature invalid".into())
                })?;
            }
            let key_id = vk.signing_key_id_base64url();
            if let Some(pinned_key_id) = persisted_device_keys.get(&dev.device_id)
                && pinned_key_id != &key_id
            {
                return Err(BootstrapError::Crypto(
                    "directory key conflicts with persisted device trust binding".into(),
                ));
            }
            guard.insert(key_id.clone(), vk);
            if let Some(records) = authorization_guard.as_mut() {
                let participant_id =
                    serde_json::from_value(serde_json::Value::String(dev.participant_id.clone()))
                        .map_err(|e| {
                        BootstrapError::Crypto(format!("directory participant id: {e}"))
                    })?;
                let device_id =
                    serde_json::from_value(serde_json::Value::String(dev.device_id.clone()))
                        .map_err(|e| BootstrapError::Crypto(format!("directory device id: {e}")))?;
                let kind = serde_json::from_value(serde_json::Value::String(dev.kind.clone()))
                    .map_err(|e| {
                        BootstrapError::Crypto(format!("directory participant kind: {e}"))
                    })?;
                let client = serde_json::from_value(serde_json::Value::String(dev.client.clone()))
                    .map_err(|e| BootstrapError::Crypto(format!("directory client: {e}")))?;
                let mut incoming = RegisteredDeviceAuthorization {
                    participant_id,
                    device_id,
                    public_encryption_key: dev.public_encryption_key.clone(),
                    public_signing_key: dev.public_signing_key.clone(),
                    client,
                    kind,
                    grant_tier: dev.grant_tier,
                    grant_signature: dev.grant_signature.clone(),
                    attested: false,
                };
                incoming.attested = self
                    .store
                    .iter_events(room_id)
                    .map_err(|e| BootstrapError::Store(format!("read participant roster: {e}")))?
                    .filter_map(Result::ok)
                    .any(|event| {
                        event.auth.signing_key_id == key_id
                            && incoming.validates_attestation(&event)
                    });
                if let Some(existing) = records.get(&key_id)
                    && (existing.participant_id != incoming.participant_id
                        || existing.device_id != incoming.device_id
                        || existing.public_encryption_key != incoming.public_encryption_key
                        || existing.public_signing_key != incoming.public_signing_key
                        || existing.client != incoming.client
                        || existing.kind != incoming.kind
                        || existing.grant_tier != incoming.grant_tier
                        || existing.grant_signature != incoming.grant_signature)
                {
                    return Err(BootstrapError::Crypto(
                        "immutable directory registration changed".into(),
                    ));
                }
                if records.iter().any(|(existing_key_id, existing)| {
                    existing.device_id == incoming.device_id && existing_key_id != &key_id
                }) {
                    return Err(BootstrapError::Crypto(
                        "device id is already bound to another signing key".into(),
                    ));
                }
                match records.entry(key_id) {
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        if incoming.attested {
                            entry.get_mut().attested = true;
                        }
                    }
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(incoming);
                    }
                }
            }
            added += 1;
        }
        Ok(added)
    }

    fn persisted_device_key_bindings(
        &self,
        room_id: &RoomId,
    ) -> Result<std::collections::HashMap<String, String>, BootstrapError> {
        let mut bindings = std::collections::HashMap::new();
        for event in self
            .store
            .iter_events(room_id)
            .map_err(|e| BootstrapError::Store(format!("read participant roster: {e}")))?
            .filter_map(Result::ok)
        {
            let ReviewEventBody::ParticipantJoined {
                participant,
                device,
            } = &event.body
            else {
                continue;
            };
            if participant.participant_id != event.meta.author_id
                || device.device_id != event.meta.device_id
                || device.participant_id != event.meta.author_id
                || participant.public_signing_key != device.public_signing_key
            {
                continue;
            }
            let Ok(raw) = URL_SAFE_NO_PAD.decode(device.public_signing_key.as_bytes()) else {
                continue;
            };
            let Ok(bytes) = raw.as_slice().try_into() else {
                continue;
            };
            let Ok(verifier) = DeviceVerifyingKey::from_bytes(&bytes) else {
                continue;
            };
            let key_id = verifier.signing_key_id_base64url();
            if event.auth.signing_key_id != key_id {
                continue;
            }
            let device_id = device.device_id.as_str().to_string();
            if let Some(existing) = bindings.get(&device_id)
                && existing != &key_id
            {
                return Err(BootstrapError::Crypto(
                    "persisted device has conflicting signing keys".into(),
                ));
            }
            bindings.insert(device_id, key_id);
        }
        Ok(bindings)
    }

    /// Read the shared file off disk, build a snapshot of its current
    /// state, and append a `SnapshotCreated` event to the room's outbox.
    /// Returns the freshly minted `FileId` + `SnapshotId` so the caller
    /// can persist them into `ReviewRoom.documents` / `.snapshots`.
    pub async fn publish_initial_snapshot(
        &self,
        room_id: &RoomId,
        path: &std::path::Path,
        now_ms: u64,
    ) -> Result<(FileId, SnapshotId), BootstrapError> {
        self.publish_snapshot(room_id, path, None, now_ms).await
    }

    /// Read the file off disk and publish a `SnapshotCreated` event for it.
    ///
    /// `existing_file_id` keeps document identity stable across edits: the
    /// FileId is derived from the FIRST snapshot's content hash, so a
    /// republish (owner edit) MUST reuse it rather than re-derive from the
    /// new content (which would mint a different FileId and orphan all the
    /// reviewer's anchored comments). On the very first publish it's `None`
    /// and we derive + persist it via `record_share_file_id`.
    ///
    /// The new SnapshotId is always content-derived, so each edit produces a
    /// distinct snapshot that supersedes the prior one for the same FileId.
    ///
    /// Wire shape (decision #14, `crypto-spec.md` §Nonce Discipline): the
    /// snapshot bytes travel as a `kind=snapshot_blob` envelope sealed under
    /// the room's `snapshotKey` — the relay caps those at
    /// `policy.maxSnapshotBytes` (5 MiB) instead of `maxEventBytes`
    /// (256 KiB). The `SnapshotCreated` event itself stays small and points
    /// at the blob via `encryptedBlobRef`. Ciphertexts above the relay's
    /// 1 MiB inline threshold spill to R2 (presign + PUT); at or below, the
    /// blob envelope rides the normal outbox.
    pub async fn publish_snapshot(
        &self,
        room_id: &RoomId,
        path: &std::path::Path,
        existing_file_id: Option<FileId>,
        now_ms: u64,
    ) -> Result<(FileId, SnapshotId), BootstrapError> {
        use crate::review::anchors::index::build_anchor_index;
        use crate::review::crypto::ids::{content_hash, derive_file_id, derive_snapshot_id};
        use crate::review::envelope::{assemble_snapshot_blob_envelope, seal_snapshot_r2_body};
        use crate::review::model::{BlobRef, BlobStorage, DocType, SnapshotNode};
        use crate::review::transport::blobs as relay_blobs;

        let doc_bytes = std::fs::read(path)
            .map_err(|e| BootstrapError::Store(format!("read {}: {e}", path.display())))?;
        let base_hash = content_hash(&doc_bytes);

        let room_secret = load_room_secret(self.store.root(), room_id)?;
        let display_path = path.to_string_lossy().to_string();
        let (file_id, is_first) = match existing_file_id {
            Some(fid) => (fid, false),
            None => (
                derive_file_id(&room_secret, &display_path, &base_hash),
                true,
            ),
        };
        let snapshot_id = derive_snapshot_id(room_id, &file_id, &base_hash, now_ms as i64);

        let content = String::from_utf8(doc_bytes)
            .map_err(|_| BootstrapError::Crypto("snapshot document must be utf-8".into()))?;
        // HTML docs are shared read-only — no comment anchors (yet), so they
        // carry no anchor index. Markdown docs anchor against rendered
        // structure for comments/suggestions.
        let (doc_type, anchor_index) = if is_html_path(path) {
            (DocType::Html, None)
        } else {
            let index = build_anchor_index(content.as_bytes(), &snapshot_id)
                .map_err(|e| BootstrapError::Crypto(format!("anchor index: {e}")))?;
            (DocType::Markdown, Some(index))
        };
        let plaintext = SnapshotPlaintext {
            doc_type,
            content: Some(content),
            anchor_index,
            media_type: None,
            encoding: None,
            manifest: None,
        };

        // ---- Seal the snapshot bytes as a `kind=snapshot_blob` envelope.
        let blob_bytes = crate::review::crypto::canonical::to_canonical_bytes(&plaintext)
            .map_err(|e| BootstrapError::Crypto(format!("canonical snapshot: {e}")))?;
        let blob_hash = content_hash(&blob_bytes);
        let v3_access = load_room_access_v3(self.store.root(), room_id)?;
        let (snapshot_key, upload_admission_key, protocol_version) = if let Some(access) =
            v3_access.as_ref()
        {
            let read = crate::review::crypto::kdf::derive_read_keys_v3(&access.read_capability_key);
            let write = access.write_admission_key.ok_or_else(|| {
                BootstrapError::InvalidShare("view-only room cannot publish snapshots".into())
            })?;
            (*read.snapshot_key.as_bytes(), write, 3)
        } else {
            let keys = derive_room_keys(&room_secret);
            (
                *keys.snapshot_key.as_bytes(),
                *keys.admission_key.as_bytes(),
                2,
            )
        };
        let identity_dir = self.config.identity_dir()?;
        let identity = load_or_create_identity_in(&identity_dir)?;
        let participant_id = identity.typed_participant_id();
        let device_id = identity.typed_device_id();
        let expires_at = match self
            .store
            .load_room(room_id)
            .map_err(|e| BootstrapError::Store(format!("load_room: {e}")))?
        {
            Some(r) => r.policy.expires_at,
            None => now_ms + 60 * 60 * 1000,
        };
        let mut client_nonce = [0u8; 16];
        getrandom::getrandom(&mut client_nonce)
            .map_err(|e| BootstrapError::Crypto(format!("client nonce: {e}")))?;

        let blob_envelope = assemble_snapshot_blob_envelope(
            &blob_bytes,
            &snapshot_key,
            room_id,
            &participant_id,
            &device_id,
            &client_nonce,
            now_ms as i64,
            expires_at as i64,
        )
        .map_err(|e| BootstrapError::Crypto(format!("assemble snapshot blob: {e}")))?;

        // ---- Route by size: the relay stores inline envelopes in DO
        //      storage only up to its 1 MiB spillover threshold; above
        //      that, the sealed bytes go to R2 and the mailbox envelope
        //      carries an encrypted BlobRef instead.
        let storage = if blob_envelope.ciphertext_bytes <= RELAY_BLOB_SPILLOVER_THRESHOLD_BYTES {
            // Enqueue the blob BEFORE the SnapshotCreated event so peers
            // receive bytes-then-pointer in relay serverSeq order.
            self.store
                .append_outbox(room_id, &blob_envelope)
                .map_err(|e| BootstrapError::Store(format!("append blob outbox: {e}")))?;
            BlobStorage::Mailbox
        } else {
            // R2 spillover. The wrapper envelope reuses the blob's
            // envelopeId (same clientNonce) and its plaintext is the
            // canonical-JSON BlobRef; the sealed snapshot bytes are bound
            // to the wrapper's AAD and PUT to R2.
            let blob_ref = BlobRef {
                storage: BlobStorage::R2,
                blob_id: blob_envelope.envelope_id.clone(),
                byte_length: blob_bytes.len() as u64,
                content_hash: blob_hash.clone(),
            };
            let ref_bytes = crate::review::crypto::canonical::to_canonical_bytes(&blob_ref)
                .map_err(|e| BootstrapError::Crypto(format!("canonical blob ref: {e}")))?;
            let wrapper = assemble_snapshot_blob_envelope(
                &ref_bytes,
                &snapshot_key,
                room_id,
                &participant_id,
                &device_id,
                &client_nonce,
                now_ms as i64,
                expires_at as i64,
            )
            .map_err(|e| BootstrapError::Crypto(format!("assemble blob wrapper: {e}")))?;
            let sealed_body = seal_snapshot_r2_body(&snapshot_key, &blob_bytes, &wrapper)
                .map_err(|e| BootstrapError::Crypto(format!("seal R2 body: {e}")))?;

            let presigned = relay_blobs::presign_blob_upload_versioned(
                &self.http,
                &self.config.relay_url,
                &upload_admission_key,
                protocol_version,
                room_id,
                &wrapper.envelope_id,
                &participant_id,
                &device_id,
                sealed_body.len() as u64,
            )
            .await
            .map_err(|e| BootstrapError::Network(format!("blob presign: {e}")))?;
            relay_blobs::put_blob(&self.http, &self.config.relay_url, &presigned, sealed_body)
                .await
                .map_err(|e| BootstrapError::Network(format!("blob upload: {e}")))?;

            self.store
                .append_outbox(room_id, &wrapper)
                .map_err(|e| BootstrapError::Store(format!("append blob wrapper outbox: {e}")))?;
            BlobStorage::R2
        };

        let blob_ref = BlobRef {
            storage,
            blob_id: blob_envelope.envelope_id.clone(),
            byte_length: blob_bytes.len() as u64,
            content_hash: blob_hash,
        };

        // ---- Persist locally: the decrypted blob (so the daemon can
        //      rehydrate `inline_snapshot` when the relay echoes the event
        //      back) and the SnapshotNode (so the WebRTC RequestSnapshot
        //      recovery path can re-emit the latest snapshot).
        self.store
            .save_snapshot_blob(room_id, &blob_envelope.envelope_id, &blob_bytes)
            .map_err(|e| BootstrapError::Store(format!("save snapshot blob: {e}")))?;
        self.store
            .save_snapshot(
                room_id,
                &SnapshotNode {
                    snapshot_id: snapshot_id.clone(),
                    file_id: file_id.clone(),
                    parent_snapshot_id: None,
                    supersedes_snapshot_id: None,
                    created_at: now_ms,
                    created_by: participant_id,
                    base_hash: base_hash.clone(),
                    byte_length: blob_bytes.len() as u64,
                    encrypted_blob_ref: Some(blob_ref.clone()),
                    plaintext: Some(plaintext),
                },
            )
            .map_err(|e| BootstrapError::Store(format!("save snapshot node: {e}")))?;

        let body = ReviewEventBody::SnapshotCreated {
            file_id: file_id.clone(),
            snapshot_id: snapshot_id.clone(),
            owner_display_path: Some(display_path),
            parent_snapshot_id: None,
            base_hash,
            encrypted_blob_ref: Some(blob_ref),
            // Decision #14: the wire form never inlines the plaintext — the
            // bytes travel in the snapshot_blob envelope above. Receivers
            // rehydrate this field locally at the IPC boundary.
            inline_snapshot: None,
        };

        let outcome = self.send_event_sync(room_id, body, now_ms)?;
        // Persist the stable file_id on the first publish so future edits
        // reuse it (looked up via `find_room_for_path`).
        if is_first {
            record_share_file_id(self.store.root(), room_id, path, &file_id)?;
        }
        tracing::info!(
            "published snapshot file={} snapshot={} blob_bytes={} storage={:?} event_bytes={} first={} room={}",
            file_id.as_str(),
            snapshot_id.as_str(),
            blob_envelope.ciphertext_bytes,
            storage,
            outcome.envelope.ciphertext_bytes,
            is_first,
            room_id.as_str(),
        );
        Ok((file_id, snapshot_id))
    }

    /// Republish a snapshot for a file the owner just edited. Looks up the
    /// room + stable file_id for `path`; no-op (returns `Ok(None)`) when the
    /// path isn't shared. Called from the `PublishSnapshot` IPC on save.
    pub async fn republish_snapshot_for_path(
        &self,
        path: &std::path::Path,
        now_ms: u64,
    ) -> Result<Option<(RoomId, FileId, SnapshotId)>, BootstrapError> {
        let Some((room_id, file_id)) = find_room_for_path(self.store.root(), path)? else {
            return Ok(None);
        };
        let (fid, sid) = self
            .publish_snapshot(&room_id, path, file_id, now_ms)
            .await?;
        Ok(Some((room_id, fid, sid)))
    }

    // -----------------------------------------------------------------
    // Outbound event helper — used by the manager's CreateComment /
    // CreateSuggestion / AcceptSuggestion arms to mint a signed +
    // AEAD-encrypted envelope and persist it to the outbox in one call.
    // -----------------------------------------------------------------

    /// Outcome of `send_event`. Carries both the signed `ReviewEvent`
    /// (so the caller can echo it locally — frontend updates immediately)
    /// and the `MailboxEnvelope` (so the caller can route it through the
    /// transport selector when one is wired).
    ///
    /// `appended_to_outbox` is `false` when `append_outbox`'s dedup
    /// already had the same `envelopeId` (idempotent caller retried).
    pub fn send_event_sync(
        &self,
        room_id: &RoomId,
        body: ReviewEventBody,
        now_ms: u64,
    ) -> Result<SendEventOutcome, BootstrapError> {
        let identity_dir = self.config.identity_dir()?;
        let identity = load_or_create_identity_in(&identity_dir)?;
        let event_key = if let Some(access) = load_room_access_v3(self.store.root(), room_id)? {
            *crate::review::crypto::kdf::derive_read_keys_v3(&access.read_capability_key)
                .event_key
                .as_bytes()
        } else {
            let room_secret = load_room_secret(self.store.root(), room_id)?;
            *derive_room_keys(&room_secret).event_key.as_bytes()
        };

        // Read the policy's expiry off room.json so envelopes don't
        // outlive the room itself.
        let room = self
            .store
            .load_room(room_id)
            .map_err(|e| BootstrapError::Store(format!("load_room: {e}")))?;
        let expires_at = match room.as_ref() {
            Some(r) => r.policy.expires_at,
            None => now_ms + 60 * 60 * 1000,
        };

        let signing_key = identity.signing_key()?;
        let participant_id = identity.typed_participant_id();
        let device_id = identity.typed_device_id();

        // Build the signed `ReviewEvent` first so we can echo it locally;
        // assemble the AEAD envelope from the same meta+body so the
        // event_id matches between the two surfaces (the frontend dedupes
        // by event.meta.event_id when the relay round-trip eventually
        // re-imports it).
        let mut meta = EventMeta {
            v: 2,
            event_id: placeholder_event_id(),
            room_id: room_id.clone(),
            author_id: participant_id.clone(),
            device_id: device_id.clone(),
            created_at: now_ms,
            parent_event_ids: vec![],
            snapshot_id: None,
        };
        let event_id = derive_event_id(&meta, &body)
            .map_err(|e| BootstrapError::Crypto(format!("derive event id: {e}")))?;
        meta.event_id = event_id.clone();
        let auth = sign_event(&signing_key, &meta, &body)
            .map_err(|e| BootstrapError::Crypto(format!("sign event: {e}")))?;
        let signed_event = ReviewEvent {
            meta,
            body: body.clone(),
            auth,
        };

        let signing_key_again = identity.signing_key()?;
        let envelope = assemble_event_envelope(AssembleInput {
            event_key,
            signing_key: signing_key_again,
            room_id: room_id.clone(),
            author_id: participant_id,
            device_id,
            created_at_ms: now_ms,
            expires_at_ms: expires_at,
            parent_event_ids: vec![],
            snapshot_id: None,
            body,
            kind: EnvelopeKind::Event,
            client_nonce: None,
        })
        .map_err(|e| BootstrapError::Crypto(format!("assemble envelope: {e}")))?;

        let appended = self
            .store
            .append_outbox(room_id, &envelope)
            .map_err(|e| BootstrapError::Store(format!("append outbox: {e}")))?;

        Ok(SendEventOutcome {
            event: signed_event,
            envelope,
            appended_to_outbox: appended,
        })
    }

    // -----------------------------------------------------------------
    // Relay HTTP helpers
    // -----------------------------------------------------------------

    async fn create_room_v3(
        &self,
        room_id: &RoomId,
        policy: &RoomPolicy,
        identity: &DeviceIdentity,
        read_admission_key: &[u8; 32],
        write_admission_key: &[u8; 32],
    ) -> Result<bool, BootstrapError> {
        let body = CreateRoomBodyV3 {
            v: 3,
            policy: &WirePolicy::from_model(policy),
            owner_signing_key: &identity.public_signing_key,
            read_admission_key: URL_SAFE_NO_PAD.encode(read_admission_key),
            write_admission_key: URL_SAFE_NO_PAD.encode(write_admission_key),
        };
        let body_bytes = serde_json::to_vec(&body)
            .map_err(|error| BootstrapError::Crypto(format!("serialize v3 room: {error}")))?;
        let path = format!("/v3/rooms/{}", room_id.as_str());
        let owner_signature =
            owner_sig_header_value(&identity.signing_key()?, "POST", &path, &body_bytes);
        let owner_key_id = identity.verifying_key()?.signing_key_id_base64url();
        let pow = TokenPool::new(
            room_id.as_str().to_owned(),
            owner_key_id,
            BOOTSTRAP_POW_DIFFICULTY,
            BOOTSTRAP_POW_TTL_MS,
        )
        .take("POST", &path)
        .await
        .map_err(|error| BootstrapError::Crypto(format!("v3 room pow: {error}")))?;
        let response = self
            .http
            .post(format!(
                "{}{}",
                self.config.relay_url.trim_end_matches('/'),
                path
            ))
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )
            .header(
                "Attn-Admission",
                admission_header_value_v3(write_admission_key, "write", "POST", &path, &body_bytes),
            )
            .header("Attn-Owner-Signature", owner_signature)
            .header("Attn-PoW", pow)
            .body(body_bytes)
            .send()
            .await
            .map_err(|error| BootstrapError::Network(format!("POST v3 room: {error}")))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| BootstrapError::Network(format!("read v3 room: {error}")))?;
        match status.as_u16() {
            200 => Ok(false),
            201 => Ok(true),
            status => Err(relay_error(status, &bytes)),
        }
    }

    async fn create_room(
        &self,
        room_id: &RoomId,
        policy: &RoomPolicy,
        identity: &DeviceIdentity,
        admission_key: &crate::review::crypto::kdf::DerivedKey,
    ) -> Result<(), BootstrapError> {
        let wire_policy = WirePolicy::from_model(policy);
        let admission_b64 = URL_SAFE_NO_PAD.encode(admission_key.as_bytes());
        let body = CreateRoomBody {
            v: 2,
            policy: &wire_policy,
            owner_signing_key: &identity.public_signing_key,
            admission_key: &admission_b64,
        };
        let body_bytes = serde_json::to_vec(&body)
            .map_err(|e| BootstrapError::Crypto(format!("serialize CreateRoomBody: {e}")))?;
        let path = format!("/v2/rooms/{}", room_id.as_str());
        let url = format!("{}{}", self.config.relay_url.trim_end_matches('/'), path);
        let admission_header =
            admission_header_value(admission_key.as_bytes(), "POST", &path, &body_bytes);

        // Attn-Owner-Signature (security-review.md §H1): prove possession of
        // the owner private key on first-create. The relay verifies this
        // against `ownerSigningKey` in the body before persisting room meta.
        // On rejoin, the relay short-circuits on admission HMAC alone, but we
        // attach the header unconditionally — the Share/Join client can't
        // know whether this call is first-create or rejoin until it sees the
        // response status (201 vs 200), and the relay accepts a valid sig
        // either way.
        let owner_sig_header =
            owner_sig_header_value(&identity.signing_key()?, "POST", &path, &body_bytes);

        // Attn-PoW (abuse hardening). The relay gates room-create on a PoW token
        // bound to (roomId, ownerSigningKeyId, POST, path). ownerSigningKeyId is
        // base64url(SHA-256(ownerSigningKey)) — the relay derives the same id
        // from the body, and we mint against it here so the deviceId slot
        // matches without an extra wire field.
        let owner_signing_key_id = identity.verifying_key()?.signing_key_id_base64url();
        let pow_token = TokenPool::new(
            room_id.as_str().to_string(),
            owner_signing_key_id,
            BOOTSTRAP_POW_DIFFICULTY,
            BOOTSTRAP_POW_TTL_MS,
        )
        .take("POST", &path)
        .await
        .map_err(|e| BootstrapError::Crypto(format!("create pow: {e}")))?;

        let resp = self
            .http
            .post(&url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )
            .header("Attn-Admission", admission_header)
            .header("Attn-Owner-Signature", owner_sig_header)
            .header("Attn-PoW", pow_token)
            .body(body_bytes.clone())
            .send()
            .await
            .map_err(|e| BootstrapError::Network(format!("POST {url}: {e}")))?;
        let status = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| BootstrapError::Network(format!("read body: {e}")))?;
        match status.as_u16() {
            200 | 201 => {
                let _parsed: CreateRoomResponse =
                    serde_json::from_slice(&raw).map_err(|e| BootstrapError::Relay {
                        status: status.as_u16(),
                        code: "ATTN_RESPONSE_DECODE".to_string(),
                        message: e.to_string(),
                    })?;
                Ok(())
            }
            other => Err(relay_error(other, &raw)),
        }
    }

    async fn register_device(
        &self,
        room_id: &RoomId,
        identity: &DeviceIdentity,
        kind: &str,
        admission_key: &crate::review::crypto::kdf::DerivedKey,
    ) -> Result<(), BootstrapError> {
        self.register_device_with_client(room_id, identity, kind, "attn-native", admission_key)
            .await
    }

    async fn register_device_with_client(
        &self,
        room_id: &RoomId,
        identity: &DeviceIdentity,
        kind: &str,
        client: &str,
        admission_key: &crate::review::crypto::kdf::DerivedKey,
    ) -> Result<(), BootstrapError> {
        // Construct the body WITHOUT selfSignature first, sign its canonical
        // bytes, then attach selfSignature. Mirrors relay-spec.md §`POST
        // /v2/rooms/:roomId/devices` "verify selfSignature against the
        // canonical body without selfSignature".
        let mut body = RegisterDeviceBody {
            device_id: identity.device_id.clone(),
            participant_id: identity.participant_id.clone(),
            public_signing_key: identity.public_signing_key.clone(),
            public_encryption_key: identity.public_encryption_key.clone(),
            client: client.to_string(),
            kind: kind.to_string(),
            grant_tier: None,
            grant_signature: None,
            self_signature: String::new(),
        };
        let canonical_unsigned = canonical_register_device_bytes(&body)?;
        let signing_key = identity.signing_key()?;
        // Sign the canonical bytes directly — re-uses the deterministic
        // Ed25519 path but at the byte level (not through `sign_event`, which
        // expects an `EventMeta`).
        use ed25519_dalek::Signer as _;
        let inner: ed25519_dalek::SigningKey =
            ed25519_dalek::SigningKey::from_bytes(&signing_key.to_bytes());
        let sig = inner.sign(&canonical_unsigned);
        body.self_signature = URL_SAFE_NO_PAD.encode(sig.to_bytes());

        // Mint a PoW token before sending. `devices` is a write endpoint.
        let path = format!("/v2/rooms/{}/devices", room_id.as_str());
        let pool = TokenPool::new(
            room_id.as_str().to_string(),
            identity.device_id.clone(),
            BOOTSTRAP_POW_DIFFICULTY,
            BOOTSTRAP_POW_TTL_MS,
        );
        let pow_token = pool
            .take("POST", &path)
            .await
            .map_err(|e| BootstrapError::Crypto(format!("pow: {e}")))?;
        let body_bytes = serde_json::to_vec(&body)
            .map_err(|e| BootstrapError::Crypto(format!("serialize RegisterDeviceBody: {e}")))?;
        let url = format!("{}{}", self.config.relay_url.trim_end_matches('/'), path);
        let admission_header =
            admission_header_value(admission_key.as_bytes(), "POST", &path, &body_bytes);

        let resp = self
            .http
            .post(&url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )
            .header("Attn-Admission", admission_header)
            .header("Attn-PoW", pow_token)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| BootstrapError::Network(format!("POST {url}: {e}")))?;
        let status = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| BootstrapError::Network(format!("read body: {e}")))?;
        match status.as_u16() {
            // Relay-spec.md says `204 No Content`; some impls return 200 with
            // an empty body. Accept both.
            200 | 204 => Ok(()),
            other => Err(relay_error(other, &raw)),
        }
    }

    async fn list_devices(
        &self,
        room_id: &RoomId,
        admission_key: &crate::review::crypto::kdf::DerivedKey,
    ) -> Result<Vec<DirectoryDevice>, BootstrapError> {
        let path = format!("/v2/rooms/{}/devices", room_id.as_str());
        let url = format!("{}{}", self.config.relay_url.trim_end_matches('/'), path);
        let admission_header = admission_header_value(admission_key.as_bytes(), "GET", &path, &[]);
        let resp = self
            .http
            .get(&url)
            .header("Attn-Admission", admission_header)
            .send()
            .await
            .map_err(|e| BootstrapError::Network(format!("GET {url}: {e}")))?;
        let status = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| BootstrapError::Network(format!("read body: {e}")))?;
        match status.as_u16() {
            200 => {
                let parsed: ListDevicesResponse =
                    serde_json::from_slice(&raw).map_err(|e| BootstrapError::Relay {
                        status: 200,
                        code: "ATTN_RESPONSE_DECODE".to_string(),
                        message: e.to_string(),
                    })?;
                Ok(parsed.devices)
            }
            other => Err(relay_error(other, &raw)),
        }
    }

    // These arguments intentionally mirror the authenticated registration
    // boundary; keeping identity, wire attribution, owner grant, and write
    // capability explicit makes call-site privilege review straightforward.
    #[allow(clippy::too_many_arguments)]
    async fn register_device_v3(
        &self,
        room_id: &RoomId,
        identity: &DeviceIdentity,
        kind: &str,
        client: &str,
        grant_tier: Option<crate::review::transport::inbound::GrantTier>,
        grant_signature: Option<&[u8; 64]>,
        write_admission_key: &[u8; 32],
    ) -> Result<(), BootstrapError> {
        let mut body = RegisterDeviceBody {
            device_id: identity.device_id.clone(),
            participant_id: identity.participant_id.clone(),
            public_signing_key: identity.public_signing_key.clone(),
            public_encryption_key: identity.public_encryption_key.clone(),
            client: client.to_owned(),
            kind: kind.to_owned(),
            grant_tier,
            grant_signature: grant_signature.map(|signature| URL_SAFE_NO_PAD.encode(signature)),
            self_signature: String::new(),
        };
        use ed25519_dalek::Signer as _;
        let signer = ed25519_dalek::SigningKey::from_bytes(&identity.signing_key()?.to_bytes());
        body.self_signature = URL_SAFE_NO_PAD.encode(
            signer
                .sign(&canonical_register_device_bytes(&body)?)
                .to_bytes(),
        );
        let path = format!("/v3/rooms/{}/devices", room_id.as_str());
        let body_bytes = serde_json::to_vec(&body)
            .map_err(|error| BootstrapError::Crypto(format!("serialize v3 device: {error}")))?;
        let pow = TokenPool::new(
            room_id.as_str().to_owned(),
            identity.device_id.clone(),
            BOOTSTRAP_POW_DIFFICULTY,
            BOOTSTRAP_POW_TTL_MS,
        )
        .take("POST", &path)
        .await
        .map_err(|error| BootstrapError::Crypto(format!("v3 device pow: {error}")))?;
        let response = self
            .http
            .post(format!(
                "{}{}",
                self.config.relay_url.trim_end_matches('/'),
                path
            ))
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )
            .header(
                "Attn-Admission",
                admission_header_value_v3(write_admission_key, "write", "POST", &path, &body_bytes),
            )
            .header("Attn-PoW", pow)
            .body(body_bytes)
            .send()
            .await
            .map_err(|error| BootstrapError::Network(format!("POST v3 device: {error}")))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| BootstrapError::Network(format!("read v3 device: {error}")))?;
        match status.as_u16() {
            200 | 204 => Ok(()),
            status => Err(relay_error(status, &bytes)),
        }
    }

    async fn list_devices_v3(
        &self,
        room_id: &RoomId,
        read_admission_key: &[u8; 32],
    ) -> Result<Vec<DirectoryDevice>, BootstrapError> {
        let path = format!("/v3/rooms/{}/devices", room_id.as_str());
        let response = self
            .http
            .get(format!(
                "{}{}",
                self.config.relay_url.trim_end_matches('/'),
                path
            ))
            .header(
                "Attn-Admission",
                admission_header_value_v3(read_admission_key, "read", "GET", &path, &[]),
            )
            .send()
            .await
            .map_err(|error| BootstrapError::Network(format!("GET v3 devices: {error}")))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| BootstrapError::Network(format!("read v3 devices: {error}")))?;
        if status.as_u16() != 200 {
            return Err(relay_error(status.as_u16(), &bytes));
        }
        serde_json::from_slice::<ListDevicesResponse>(&bytes)
            .map(|response| response.devices)
            .map_err(|error| BootstrapError::Relay {
                status: 200,
                code: "ATTN_RESPONSE_DECODE".into(),
                message: error.to_string(),
            })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Synthetic `EventId` used when stamping a meta we're about to hash. The
/// derivation ignores this field but `EventMeta` requires it at construction
/// time. Mirrors `envelope::placeholder_event_id` (which is module-private
/// over there).
fn placeholder_event_id() -> crate::review::ids::EventId {
    serde_json::from_value(serde_json::Value::String(
        "bootstrap-placeholder".to_string(),
    ))
    .expect("EventId deserializes from any string")
}

/// Canonical bytes used as the input to `selfSignature` on
/// `POST /v2/rooms/:roomId/devices`. The relay reproduces the same bytes by
/// removing `selfSignature` (or treating it as the empty string) before
/// canonicalizing.
fn canonical_register_device_bytes(body: &RegisterDeviceBody) -> Result<Vec<u8>, BootstrapError> {
    // Serialize as a JSON value first so we can drop `selfSignature` cleanly.
    let mut value = serde_json::to_value(body)
        .map_err(|e| BootstrapError::Crypto(format!("serialize device body: {e}")))?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("selfSignature");
    }
    crate::review::crypto::canonical::to_canonical_bytes(&value)
        .map_err(|e| BootstrapError::Crypto(format!("canonicalize device body: {e}")))
}

/// Build the `Attn-Admission` header per relay-spec.md §Identity / §Admission Key.
/// Same canonical-request format as the mailbox transport so the relay's
/// admission verifier reuses one code path.
fn admission_header_value(
    admission_key: &[u8; 32],
    method: &str,
    url_path: &str,
    body: &[u8],
) -> String {
    format!(
        "v2.{}",
        admission_mac_value(admission_key, method, url_path, body)
    )
}

fn admission_mac_value(
    admission_key: &[u8; 32],
    method: &str,
    url_path: &str,
    body: &[u8],
) -> String {
    let canonical = build_canonical_request(method, url_path, body);
    let mut mac =
        <Hmac<Sha256>>::new_from_slice(admission_key).expect("HMAC accepts any key length");
    mac.update(&canonical);
    let tag = mac.finalize().into_bytes();
    URL_SAFE_NO_PAD.encode(tag)
}

pub(crate) fn admission_header_value_v3(
    admission_key: &[u8; 32],
    scope: &str,
    method: &str,
    path: &str,
    body: &[u8],
) -> String {
    admission_header_value_v3_with_query(admission_key, scope, method, path, &[], body)
}

pub(crate) fn admission_header_value_v3_with_query(
    admission_key: &[u8; 32],
    scope: &str,
    method: &str,
    path: &str,
    query_pairs: &[(String, String)],
    body: &[u8],
) -> String {
    format!(
        "v3.{scope}.{}",
        admission_mac_value_with_query(admission_key, method, path, query_pairs, body)
    )
}

/// Build the `Attn-Owner-Signature` header per relay-spec.md §Owner Distinction
/// and §POST /v2/rooms/:roomId. Ed25519 signature over the same canonicalRequest
/// bytes used for `Attn-Admission`. Wire format is just `base64url(sig)` —
/// no version prefix, matching `relay/src/owner-sig.ts`.
pub(crate) fn owner_sig_header_value(
    signing_key: &DeviceSigningKey,
    method: &str,
    url_path: &str,
    body: &[u8],
) -> String {
    owner_sig_header_value_with_query(signing_key, method, url_path, &[], body)
}

pub(crate) fn owner_sig_header_value_with_query(
    signing_key: &DeviceSigningKey,
    method: &str,
    url_path: &str,
    query_pairs: &[(String, String)],
    body: &[u8],
) -> String {
    let canonical = build_canonical_request_with_query(method, url_path, query_pairs, body);
    use ed25519_dalek::Signer as _;
    let inner: ed25519_dalek::SigningKey =
        ed25519_dalek::SigningKey::from_bytes(&signing_key.to_bytes());
    let sig = inner.sign(&canonical);
    URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

/// canonicalRequest bytes per relay-spec.md §Identity / §Admission Key:
///
///   METHOD || "\n" || URL_PATH || "\n" || CANONICAL_QUERY || "\n" || SHA256(body)
///
/// Share/Join calls never use a query string, so CANONICAL_QUERY is always the
/// empty string. Shared between admission HMAC and owner Ed25519 signature so
/// the two layered headers commit to the same byte sequence.
fn build_canonical_request(method: &str, url_path: &str, body: &[u8]) -> Vec<u8> {
    build_canonical_request_with_query(method, url_path, &[], body)
}

fn admission_mac_value_with_query(
    admission_key: &[u8; 32],
    method: &str,
    url_path: &str,
    query_pairs: &[(String, String)],
    body: &[u8],
) -> String {
    let canonical = build_canonical_request_with_query(method, url_path, query_pairs, body);
    let mut mac =
        <Hmac<Sha256>>::new_from_slice(admission_key).expect("HMAC accepts any key length");
    mac.update(&canonical);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub(crate) fn build_canonical_request_with_query(
    method: &str,
    url_path: &str,
    query_pairs: &[(String, String)],
    body: &[u8],
) -> Vec<u8> {
    let mut pairs = query_pairs.to_vec();
    pairs.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let canonical_query = pairs
        .iter()
        .map(|(key, value)| format!("{}={}", rfc3986_encode(key), rfc3986_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let body_hash = Sha256::digest(body);
    let mut canonical = Vec::with_capacity(
        method.len() + 1 + url_path.len() + 1 + canonical_query.len() + 1 + body_hash.len(),
    );
    canonical.extend_from_slice(method.to_ascii_uppercase().as_bytes());
    canonical.push(b'\n');
    canonical.extend_from_slice(url_path.as_bytes());
    canonical.push(b'\n');
    canonical.extend_from_slice(canonical_query.as_bytes());
    canonical.push(b'\n');
    canonical.extend_from_slice(&body_hash);
    canonical
}

fn rfc3986_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Translate a non-2xx HTTP body into a typed relay error. Falls back to an
/// `ATTN_UNKNOWN` code when the body isn't the standard `{error: {...}}`
/// shape, so we never swallow a status.
fn relay_error(status: u16, body: &[u8]) -> BootstrapError {
    let parsed: RelayErrorBody = serde_json::from_slice(body).unwrap_or(RelayErrorBody {
        error: RelayErrorInner {
            code: "ATTN_UNKNOWN".to_string(),
            message: String::from_utf8_lossy(body).into_owned(),
        },
    });
    BootstrapError::Relay {
        status,
        code: parsed.error.code,
        message: parsed.error.message,
    }
}

/// Capability set granted to a newly-joined participant. Mirrors
/// `data-model.md` §Participant And Device — human reviewers may resolve
/// comment threads in addition to writing findings, while agents only get the
/// read/write-finding capabilities. Neither role gets `RoomAdmin`,
/// `AcceptSuggestion`, or `PublishSnapshot`. The owner branch is unreachable
/// today (Share owns owner creation) but is kept exhaustive so a future
/// `ParticipantKind` variant doesn't silently fall through.
fn agent_capabilities(kind: ParticipantKind) -> Vec<Capability> {
    match kind {
        ParticipantKind::Owner => vec![
            Capability::RoomAdmin,
            Capability::ReadSnapshot,
            Capability::WriteComment,
            Capability::WriteSuggestion,
            Capability::ResolveComment,
            Capability::AcceptSuggestion,
            Capability::PublishSnapshot,
        ],
        ParticipantKind::Reviewer => vec![
            Capability::ReadSnapshot,
            Capability::WriteComment,
            Capability::WriteSuggestion,
            Capability::ResolveComment,
        ],
        ParticipantKind::Agent => vec![
            Capability::ReadSnapshot,
            Capability::WriteComment,
            Capability::WriteSuggestion,
        ],
    }
}

/// Wall-clock unix milliseconds. Pulled out so tests that need a deterministic
/// timestamp can stub via the AssembleInput path.
fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Local shares index (path -> roomId) + room secret cache
// ---------------------------------------------------------------------------
//
// `find_existing_share` needs to map an absolute path to the room secret
// without re-deriving from the user. We persist:
//
//   {store_root}/shares/local-shares.json  -> {roomIdStr: {path, createdAt}}
//   {store_root}/shares/<roomId>.secret    -> base64url(roomSecret)
//
// Both are owner-private (the secret never leaves the local machine for
// anyone but the inviter), so they live outside the per-room directory and
// inside the store root.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalShareRecord {
    path: String,
    created_at: u64,
    /// `true` when `path` is a directory (folder-share): the room holds a
    /// snapshot per `*.md` file under it, tracked in `files`. New files added
    /// to the directory are picked up by the fs-watcher and published lazily.
    #[serde(default)]
    is_dir: bool,
    /// Stable document identity for `path` within this room (single-file
    /// share). Set when the initial snapshot is published; reused for every
    /// subsequent republish so the FileId stays constant across edits (only the
    /// SnapshotId changes). `None` for shares minted before this field
    /// existed — `publish_snapshot` derives + persists it on first edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_id: Option<String>,
    /// Folder-share only: per-file stable FileIds keyed by absolute file path.
    /// Grows as new `*.md` files appear in the shared directory.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    files: std::collections::HashMap<String, String>,
}

fn shares_dir(root: &std::path::Path) -> PathBuf {
    root.join("shares")
}

fn local_shares_index_path(root: &std::path::Path) -> PathBuf {
    shares_dir(root).join("local-shares.json")
}

fn room_secret_path(root: &std::path::Path, room_id: &RoomId) -> PathBuf {
    shares_dir(root).join(format!("{}.secret", room_id.as_str()))
}

fn room_access_v3_path(root: &std::path::Path, room_id: &RoomId) -> PathBuf {
    shares_dir(root).join(format!("{}.access-v3.json", room_id.as_str()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomAccessV3 {
    pub read_capability_key: [u8; 32],
    pub write_admission_key: Option<[u8; 32]>,
    pub grant_tier: Option<crate::review::transport::inbound::GrantTier>,
    pub grant_signature: Option<String>,
}

fn save_room_access_v3(
    root: &std::path::Path,
    room_id: &RoomId,
    access: &RoomAccessV3,
) -> Result<(), BootstrapError> {
    let dir = shares_dir(root);
    std::fs::create_dir_all(&dir)
        .map_err(|error| BootstrapError::Store(format!("create {}: {error}", dir.display())))?;
    let path = room_access_v3_path(root, room_id);
    let bytes = serde_json::to_vec(access)
        .map_err(|error| BootstrapError::Store(format!("encode {}: {error}", path.display())))?;
    std::fs::write(&path, bytes)
        .map_err(|error| BootstrapError::Store(format!("write {}: {error}", path.display())))
}

pub(crate) fn load_room_access_v3(
    root: &std::path::Path,
    room_id: &RoomId,
) -> Result<Option<RoomAccessV3>, BootstrapError> {
    let path = room_access_v3_path(root, room_id);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| BootstrapError::Store(format!("decode {}: {error}", path.display()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BootstrapError::Store(format!(
            "read {}: {error}",
            path.display()
        ))),
    }
}

fn load_local_shares(
    root: &std::path::Path,
) -> Result<std::collections::HashMap<String, LocalShareRecord>, BootstrapError> {
    let path = local_shares_index_path(root);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| BootstrapError::Store(format!("decode {}: {e}", path.display()))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(err) => Err(BootstrapError::Store(format!(
            "read {}: {err}",
            path.display()
        ))),
    }
}

fn record_local_share(
    root: &std::path::Path,
    room_id: &RoomId,
    path: &std::path::Path,
    is_dir: bool,
) -> Result<(), BootstrapError> {
    let mut all = load_local_shares(root)?;
    // Preserve previously-stored file ids if this room was already shared
    // (re-share of the same path) so document identity stays stable.
    let prior = all.get(room_id.as_str());
    let prior_file_id = prior.and_then(|r| r.file_id.clone());
    let prior_files = prior.map(|r| r.files.clone()).unwrap_or_default();
    all.insert(
        room_id.as_str().to_string(),
        LocalShareRecord {
            path: path.to_string_lossy().to_string(),
            created_at: unix_now_ms(),
            is_dir,
            file_id: prior_file_id,
            files: prior_files,
        },
    );
    write_local_shares(root, &all)
}

/// Persist the stable `file_id` for a shared document (`path`) so subsequent
/// snapshot republishes (on owner edit) reuse the same document identity. For
/// a folder-share room the id is recorded per-file in `files`; for a
/// single-file room it's the room-level `file_id`.
fn record_share_file_id(
    root: &std::path::Path,
    room_id: &RoomId,
    path: &std::path::Path,
    file_id: &FileId,
) -> Result<(), BootstrapError> {
    let mut all = load_local_shares(root)?;
    if let Some(record) = all.get_mut(room_id.as_str()) {
        if record.is_dir {
            record.files.insert(
                path.to_string_lossy().to_string(),
                file_id.as_str().to_string(),
            );
        } else {
            record.file_id = Some(file_id.as_str().to_string());
        }
        write_local_shares(root, &all)?;
    }
    Ok(())
}

fn write_local_shares(
    root: &std::path::Path,
    all: &std::collections::HashMap<String, LocalShareRecord>,
) -> Result<(), BootstrapError> {
    let dir = shares_dir(root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| BootstrapError::Store(format!("create {}: {e}", dir.display())))?;
    let tmp = local_shares_index_path(root).with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(all)
        .map_err(|e| BootstrapError::Store(format!("serialize local shares: {e}")))?;
    std::fs::write(&tmp, &bytes)
        .map_err(|e| BootstrapError::Store(format!("write {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, local_shares_index_path(root))
        .map_err(|e| BootstrapError::Store(format!("rename shares index: {e}")))?;
    Ok(())
}

/// Reverse of `find_room_for_path`: the on-disk path a room's shared
/// document lives at. Used by the AcceptSuggestion apply flow to read the
/// current bytes + write the accepted result. `None` when the room has no
/// local share record (e.g. a reviewer-only daemon).
pub(crate) fn find_path_for_room(
    root: &std::path::Path,
    room_id: &RoomId,
) -> Result<Option<PathBuf>, BootstrapError> {
    let all = load_local_shares(root)?;
    Ok(all
        .get(room_id.as_str())
        .map(|record| PathBuf::from(&record.path)))
}

/// `true` if `path` ends in a markdown extension.
fn is_markdown_path(path: &std::path::Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// `true` if `path` ends in an HTML extension. HTML docs are shareable
/// read-only (no collaborative editing, no comment anchors yet).
fn is_html_path(path: &std::path::Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
}

/// `true` if `path` is a document attn can share — markdown (anchored,
/// suggestable) or HTML (read-only).
fn is_shareable_path(path: &std::path::Path) -> bool {
    is_markdown_path(path) || is_html_path(path)
}

/// `true` if `path` is `dir` or sits underneath it (component-wise, so
/// `/a/b` does NOT match `/a/bc`).
fn path_within(dir: &str, path: &std::path::Path) -> bool {
    path.starts_with(std::path::Path::new(dir))
}

/// Directory/file names skipped when walking a folder-share (mirrors the
/// fs-watcher's ignore set so we don't publish snapshots for build output etc.).
fn is_ignored_dir_component(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "out"
                | "coverage"
                | "__pycache__"
                | "venv"
        )
}

/// The files to snapshot for a share. A regular file → just itself; a directory
/// (folder-share) → every shareable doc (`*.md`/`*.markdown`/`*.html`/`*.htm`)
/// under it (recursively), skipping ignored dirs. Sorted for stable ordering.
fn shareable_targets(path: &std::path::Path) -> Vec<PathBuf> {
    if !path.is_dir() {
        return if is_shareable_path(path) {
            vec![path.to_path_buf()]
        } else {
            Vec::new()
        };
    }
    let mut out: Vec<PathBuf> = Vec::new();
    collect_shareable(path, &mut out);
    out.sort();
    out
}

fn validate_share_targets(path: &std::path::Path) -> Result<Vec<PathBuf>, BootstrapError> {
    let targets = shareable_targets(path);
    if targets.is_empty() {
        return Err(BootstrapError::InvalidShare(format!(
            "{} is not shareable; choose a markdown or HTML file, or a folder containing .md/.markdown/.html/.htm files",
            path.display()
        )));
    }

    for target in &targets {
        let bytes = std::fs::read(target).map_err(|e| {
            BootstrapError::InvalidShare(format!("cannot read {}: {e}", target.display()))
        })?;
        if std::str::from_utf8(&bytes).is_err() {
            return Err(BootstrapError::InvalidShare(format!(
                "{} is not UTF-8 text",
                target.display()
            )));
        }
    }

    Ok(targets)
}

fn collect_shareable(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if is_ignored_dir_component(&name.to_string_lossy()) {
            continue;
        }
        let p = entry.path();
        if p.is_dir() {
            collect_shareable(&p, out);
        } else if is_shareable_path(&p) {
            out.push(p);
        }
    }
}

/// Look up the room a shared `path` belongs to, plus the stable file_id if one
/// has been recorded. Matches either a single-file share (exact path) or a
/// folder share (a `*.md` file under the shared directory). For a folder share,
/// a not-yet-seen file returns `(room, None)` so the caller derives a fresh
/// FileId on first publish. Returns `None` when the path isn't shared.
fn find_room_for_path(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<Option<(RoomId, Option<FileId>)>, BootstrapError> {
    let target = path.to_string_lossy().to_string();
    let all = load_local_shares(root)?;
    for (room_id_str, record) in all {
        let matched: Option<Option<String>> = if record.is_dir {
            if is_shareable_path(path) && path_within(&record.path, path) {
                Some(record.files.get(&target).cloned())
            } else {
                None
            }
        } else if record.path == target {
            Some(record.file_id.clone())
        } else {
            None
        };
        if let Some(file_id_str) = matched {
            let room_id: RoomId = serde_json::from_value(serde_json::Value::String(room_id_str))
                .expect("RoomId deserializes from any string");
            let file_id = file_id_str.map(|s| {
                serde_json::from_value::<FileId>(serde_json::Value::String(s))
                    .expect("FileId deserializes from any string")
            });
            return Ok(Some((room_id, file_id)));
        }
    }
    Ok(None)
}

fn save_room_secret(
    root: &std::path::Path,
    room_id: &RoomId,
    secret: &[u8; 32],
) -> Result<(), BootstrapError> {
    let dir = shares_dir(root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| BootstrapError::Store(format!("create {}: {e}", dir.display())))?;
    let path = room_secret_path(root, room_id);
    let encoded = URL_SAFE_NO_PAD.encode(secret);
    std::fs::write(&path, encoded.as_bytes())
        .map_err(|e| BootstrapError::Store(format!("write {}: {e}", path.display())))?;
    Ok(())
}

pub(crate) fn load_room_secret(
    root: &std::path::Path,
    room_id: &RoomId,
) -> Result<[u8; 32], BootstrapError> {
    let path = room_secret_path(root, room_id);
    let bytes = std::fs::read(&path)
        .map_err(|e| BootstrapError::Store(format!("read {}: {e}", path.display())))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(bytes.as_slice())
        .map_err(|e| BootstrapError::Store(format!("decode {}: {e}", path.display())))?;
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| BootstrapError::Store(format!("{} must be 32 bytes", path.display())))
}

// ---------------------------------------------------------------------------
// Lightweight helper for ReviewManager — turn a Bootstrapper outcome into a
// signed event we can persist into events.jsonl alongside the outbox copy.
// Optional today; kept here so manager.rs doesn't grow another import surface.
// ---------------------------------------------------------------------------

/// Build a `ReviewEvent` for a body that has already been emitted into the
/// outbox. Used to mirror the local echo into `events.jsonl` so the frontend
/// store reflects the round-trip without waiting for the relay.
pub fn build_local_review_event(
    identity: &DeviceIdentity,
    room_id: &RoomId,
    created_at_ms: u64,
    body: ReviewEventBody,
) -> Result<ReviewEvent, BootstrapError> {
    let participant_id = identity.typed_participant_id();
    let device_id = identity.typed_device_id();
    let signing_key = identity.signing_key()?;

    let mut meta = EventMeta {
        v: 2,
        event_id: placeholder_event_id(),
        room_id: room_id.clone(),
        author_id: participant_id,
        device_id,
        created_at: created_at_ms,
        parent_event_ids: vec![],
        snapshot_id: None,
    };
    let event_id = derive_event_id(&meta, &body)
        .map_err(|e| BootstrapError::Crypto(format!("derive event id: {e}")))?;
    meta.event_id = event_id;
    let auth = sign_event(&signing_key, &meta, &body)
        .map_err(|e| BootstrapError::Crypto(format!("sign event: {e}")))?;
    Ok(ReviewEvent { meta, body, auth })
}

/// Convenience: derive the EnvelopeId for a `ReviewEvent` from its
/// `(roomId, eventId)`. Mirrors the event-flavor of `derive_envelope_id_*`
/// without exposing the underlying functions to the manager.
pub fn envelope_id_for_event(room_id: &RoomId, event: &ReviewEvent) -> String {
    derive_envelope_id_for_event(room_id, &event.meta.event_id)
}

/// Surface a copy of the canonical event onto an outbox envelope. The
/// callers in manager.rs use this when they need the `MailboxEnvelope` shape
/// but already have a signed event in hand (e.g. for local-echo paths).
#[allow(clippy::too_many_arguments)]
pub fn assemble_envelope_for_event(
    identity: &DeviceIdentity,
    room_id: &RoomId,
    event_key: &[u8; 32],
    body: ReviewEventBody,
    created_at_ms: u64,
    expires_at_ms: u64,
) -> Result<MailboxEnvelope, BootstrapError> {
    let signing_key = identity.signing_key()?;
    assemble_event_envelope(AssembleInput {
        event_key: *event_key,
        signing_key,
        room_id: room_id.clone(),
        author_id: identity.typed_participant_id(),
        device_id: identity.typed_device_id(),
        created_at_ms,
        expires_at_ms,
        parent_event_ids: vec![],
        snapshot_id: None,
        body,
        kind: EnvelopeKind::Event,
        client_nonce: None,
    })
    .map_err(|e| BootstrapError::Crypto(format!("assemble envelope: {e}")))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::TempDir;
    use wiremock::matchers::{header_exists, method};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn fresh_store() -> (TempDir, Arc<ReviewStore>) {
        let tmp = TempDir::new().expect("tempdir");
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("open store");
        (tmp, Arc::new(store))
    }

    fn make_bootstrapper(
        relay_url: String,
        identity_dir: PathBuf,
    ) -> (TempDir, Arc<ReviewStore>, Bootstrapper) {
        let (tmp, store) = fresh_store();
        let cfg = Arc::new(BootstrapConfig {
            relay_url,
            identity_dir: Some(identity_dir),
        });
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("client");
        let boot = Bootstrapper::with_http_client(store.clone(), cfg, http);
        (tmp, store, boot)
    }

    fn temp_markdown_file(name: &str, body: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("markdown tempdir");
        let path = dir.path().join(name);
        std::fs::write(&path, body).expect("write markdown fixture");
        (dir, path)
    }

    // --- folder-share binding ----------------------------------------------

    #[test]
    fn folder_share_collects_md_and_binds_files_under_dir() {
        use std::fs;
        let root = TempDir::new().expect("store root");
        let docs = TempDir::new().expect("docs dir");
        fs::write(docs.path().join("a.md"), b"# A").unwrap();
        fs::write(docs.path().join("b.md"), b"# B").unwrap();
        fs::write(docs.path().join("page.html"), b"<h1>P</h1>").unwrap();
        fs::write(docs.path().join("notes.txt"), b"x").unwrap();
        fs::create_dir(docs.path().join("node_modules")).unwrap();
        fs::write(docs.path().join("node_modules/c.md"), b"# C").unwrap();
        fs::create_dir(docs.path().join("sub")).unwrap();
        fs::write(docs.path().join("sub/d.md"), b"# D").unwrap();

        // Directory → every shareable doc (*.md + *.html, recursive, sorted),
        // skipping notes.txt + node_modules; a single file → just itself.
        assert_eq!(
            shareable_targets(docs.path()),
            vec![
                docs.path().join("a.md"),
                docs.path().join("b.md"),
                docs.path().join("page.html"),
                docs.path().join("sub").join("d.md"),
            ]
        );
        assert_eq!(
            shareable_targets(&docs.path().join("a.md")),
            vec![docs.path().join("a.md")]
        );
        assert_eq!(
            shareable_targets(&docs.path().join("page.html")),
            vec![docs.path().join("page.html")]
        );
        assert!(
            shareable_targets(&docs.path().join("notes.txt")).is_empty(),
            "single non-shareable files should not create empty review rooms"
        );

        // Folder-share binding round-trip.
        let room: RoomId =
            serde_json::from_value(serde_json::Value::String("room-folder".into())).unwrap();
        record_local_share(root.path(), &room, docs.path(), true).expect("record dir share");
        let file_a: FileId =
            serde_json::from_value(serde_json::Value::String("file-a".into())).unwrap();
        record_share_file_id(root.path(), &room, &docs.path().join("a.md"), &file_a)
            .expect("record file id");

        // a.md is recorded → (room, Some(file-a)).
        let (r, f) = find_room_for_path(root.path(), &docs.path().join("a.md"))
            .unwrap()
            .expect("a.md resolves to the folder room");
        assert_eq!(r.as_str(), "room-folder");
        assert_eq!(f.expect("file-a recorded").as_str(), "file-a");

        // b.md is inside the folder but not yet published → (room, None) so the
        // caller derives a fresh FileId on first publish.
        let (r, f) = find_room_for_path(root.path(), &docs.path().join("b.md"))
            .unwrap()
            .expect("b.md resolves to the folder room");
        assert_eq!(r.as_str(), "room-folder");
        assert!(f.is_none());

        // Non-markdown inside the folder, and any path outside, do NOT match.
        assert!(
            find_room_for_path(root.path(), &docs.path().join("notes.txt"))
                .unwrap()
                .is_none()
        );
        assert!(
            find_room_for_path(root.path(), std::path::Path::new("/nope/x.md"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn validate_share_targets_rejects_empty_or_binary_share() {
        use std::fs;

        let empty_dir = TempDir::new().expect("empty dir");
        let err = validate_share_targets(empty_dir.path()).expect_err("empty folder rejected");
        assert!(err.to_string().contains("not shareable"));

        let docs = TempDir::new().expect("docs dir");
        let image = docs.path().join("hero.png");
        fs::write(&image, b"\x89PNG\r\n").unwrap();
        let err = validate_share_targets(&image).expect_err("image rejected");
        assert!(err.to_string().contains("not shareable"));

        let bad_md = docs.path().join("bad.md");
        fs::write(&bad_md, [0xff, 0xfe, 0xfd]).unwrap();
        let err = validate_share_targets(&bad_md).expect_err("binary markdown rejected");
        assert!(err.to_string().contains("UTF-8"));
    }

    // --- identity round-trip ----------------------------------------------

    #[test]
    fn identity_generate_save_load_roundtrip() {
        let dir = TempDir::new().expect("tempdir");

        // First call: no file -> generate + persist.
        assert!(
            load_identity_from(dir.path())
                .expect("load empty")
                .is_none()
        );
        let created = load_or_create_identity_in(dir.path()).expect("create");

        // The file must exist now and decode to the same struct.
        let on_disk_path = dir.path().join(IDENTITY_FILENAME);
        assert!(on_disk_path.exists(), "identity.json must be persisted");

        // Second call: must load the exact same identity, NOT regenerate.
        let loaded = load_or_create_identity_in(dir.path()).expect("load");
        assert_eq!(created, loaded, "identity must persist across calls");

        // Explicit load path also returns the persisted record.
        let raw = load_identity_from(dir.path())
            .expect("load")
            .expect("present");
        assert_eq!(raw, created);

        // Signing key reconstructs from the seed.
        let sk = created.signing_key().expect("sk");
        let vk = sk.verifying_key();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(vk.to_bytes()),
            created.public_signing_key,
            "public_signing_key field must match derived public from the seed"
        );
    }

    // --- invite parsing ---------------------------------------------------

    #[test]
    fn build_then_parse_invite_round_trip() {
        let secret = [0x7Au8; 32];
        let room_id = derive_room_id(&secret);
        let invite = build_invite_url(&room_id, &secret);
        let parsed = parse_invite(&invite).expect("parse");
        assert_eq!(parsed.room_id, room_id);
        assert_eq!(parsed.room_secret, secret);
    }

    #[test]
    fn v3_view_fragment_roundtrip_has_read_capability_only() {
        use crate::review::crypto::kdf::{derive_read_keys_v3, derive_room_key_tree_v3};

        let tree = derive_room_key_tree_v3(&[0x7a; 32]);
        let fragment = build_invite_fragment_v3(
            InviteTierV3::View,
            tree.read_keys.read_capability_key.as_bytes(),
            None,
            None,
        )
        .expect("build view fragment");
        let parsed = parse_invite_fragment_v3(&fragment).expect("parse view fragment");
        assert_eq!(parsed.tier, InviteTierV3::View);
        assert!(parsed.write_admission_key.is_none());
        let read_only = derive_read_keys_v3(&parsed.read_capability_key);
        assert_eq!(
            read_only.event_key.as_bytes(),
            tree.read_keys.event_key.as_bytes()
        );
        assert_eq!(
            read_only.snapshot_key.as_bytes(),
            tree.read_keys.snapshot_key.as_bytes()
        );
    }

    #[test]
    fn v3_tier_urls_roundtrip_and_owner_grants_are_room_bound() {
        let secret = [0x35; 32];
        let room_id = derive_room_id(&secret);
        let owner = DeviceSigningKey::from_bytes(&[0x71; 32]).expect("owner key");
        let owner_public = owner.verifying_key().to_bytes();
        let base = parse_browser_review_base_url(Some("https://example.test/review"))
            .expect("browser base");

        for tier in [
            InviteTierV3::View,
            InviteTierV3::Comment,
            InviteTierV3::Suggest,
        ] {
            let native = build_invite_url_v3(&room_id, &secret, tier, &owner).expect("native");
            let ParsedInviteAny::V3(parsed) = parse_invite_any(&native).expect("parse") else {
                panic!("expected v3 invite");
            };
            assert_eq!(parsed.fragment.tier, tier);
            verify_invite_grant_v3(&parsed, &owner_public).expect("valid owner grant");

            let browser =
                build_browser_invite_url_v3_from_base(&base, &room_id, &native).expect("browser");
            let browser_url = reqwest::Url::parse(&browser).expect("browser url");
            assert_eq!(browser_url.path(), format!("/review/{}", room_id.as_str()));
            assert_eq!(
                browser_url.fragment(),
                native.split_once('#').map(|(_, value)| value)
            );
        }

        let comment =
            build_invite_url_v3(&room_id, &secret, InviteTierV3::Comment, &owner).expect("comment");
        let ParsedInviteAny::V3(mut parsed) = parse_invite_any(&comment).expect("parse") else {
            unreachable!();
        };
        let other_room: RoomId =
            serde_json::from_value(serde_json::Value::String("cross-room-target".into())).unwrap();
        parsed.room_id = other_room;
        assert!(verify_invite_grant_v3(&parsed, &owner_public).is_err());
        parsed.room_id = room_id;
        parsed.fragment.grant_signature.as_mut().unwrap()[0] ^= 1;
        assert!(verify_invite_grant_v3(&parsed, &owner_public).is_err());
    }

    #[test]
    fn v3_access_metadata_survives_restart_roundtrip() {
        let root = TempDir::new().expect("tempdir");
        let room_id: RoomId =
            serde_json::from_value(serde_json::Value::String("room-v3".into())).unwrap();
        let access = RoomAccessV3 {
            read_capability_key: [1; 32],
            write_admission_key: Some([2; 32]),
            grant_tier: Some(crate::review::transport::inbound::GrantTier::Comment),
            grant_signature: Some(URL_SAFE_NO_PAD.encode([3; 64])),
        };
        save_room_access_v3(root.path(), &room_id, &access).expect("save");
        assert_eq!(
            load_room_access_v3(root.path(), &room_id).expect("reload"),
            Some(access)
        );
    }

    #[test]
    fn existing_share_invite_requires_real_v3_room_metadata() {
        let root = TempDir::new().expect("tempdir");
        let store = ReviewStore::open_at(root.path().to_path_buf()).expect("store");
        let secret = [0x45; 32];
        let room_id = derive_room_id_v3(&secret);
        let shared_path = root.path().join("plan.md");
        std::fs::write(&shared_path, "# Plan\n").unwrap();
        let identity = DeviceIdentity::generate().expect("identity");
        let participant_id = identity.typed_participant_id();
        let mut room = ReviewRoom {
            v: 2,
            room_id: room_id.clone(),
            created_at: 1,
            created_by: participant_id,
            policy: default_room_policy(unix_now_ms()),
            documents: Default::default(),
            snapshots: Default::default(),
            event_heads: vec![],
        };
        store.save_room(&room).unwrap();
        save_room_secret(store.root(), &room_id, &secret).unwrap();
        record_local_share(store.root(), &room_id, &shared_path, false).unwrap();
        let target = shared_path.to_string_lossy();
        assert!(
            build_existing_share_invite_v3(
                store.root(),
                &identity,
                &target,
                InviteTierV3::Comment,
                false,
            )
            .expect_err("legacy share rejected")
            .to_string()
            .contains("legacy v2")
        );

        room.v = 3;
        store.save_room(&room).unwrap();
        let tree = crate::review::crypto::kdf::derive_room_key_tree_v3(&secret);
        save_room_access_v3(
            store.root(),
            &room_id,
            &RoomAccessV3 {
                read_capability_key: *tree.read_keys.read_capability_key.as_bytes(),
                write_admission_key: Some(*tree.write_admission_key.as_bytes()),
                grant_tier: None,
                grant_signature: None,
            },
        )
        .unwrap();
        let invite = build_existing_share_invite_v3(
            store.root(),
            &identity,
            &target,
            InviteTierV3::Suggest,
            false,
        )
        .expect("v3 invite");
        assert!(invite.contains("tier=suggest"));
    }

    #[test]
    fn v3_admission_header_has_exact_scope_prefix() {
        let header = admission_header_value_v3(&[7; 32], "write", "POST", "/v3/rooms/r", b"{}");
        assert!(header.starts_with("v3.write."));
        assert_eq!(header.split('.').count(), 3);
        assert!(!header.contains(".v2."));
    }

    #[test]
    fn v3_fragment_parser_rejects_duplicates_unknown_mismatch_and_bad_lengths() {
        let read = URL_SAFE_NO_PAD.encode([1u8; 32]);
        let write = URL_SAFE_NO_PAD.encode([2u8; 32]);
        for invalid in [
            format!("#v=3&tier=view&read={read}&read={read}"),
            format!("#v=3&tier=view&read={read}&future=x"),
            format!("#v=3&tier=view&read={read}&write={write}"),
            format!("#v=3&tier=comment&read={read}"),
            "#v=3&tier=view&read=AQ".to_string(),
            format!("#tier=view&v=3&read={read}"),
        ] {
            assert!(
                parse_invite_fragment_v3(&invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn browser_invite_uses_configured_path_and_fragment_only_secret() {
        let secret = [0x5Au8; 32];
        let secret_b64 = URL_SAFE_NO_PAD.encode(secret);
        let room_id = derive_room_id(&secret);
        let base = parse_browser_review_base_url(Some("https://staging.attn.sh/review/"))
            .expect("valid staging base");
        let invite = build_browser_invite_url_from_base(&base, &room_id, &secret);
        let parsed = reqwest::Url::parse(&invite).expect("browser invite URL");

        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("staging.attn.sh"));
        assert_eq!(parsed.path(), format!("/review/{}", room_id.as_str()));
        assert_eq!(parsed.query(), None, "room secret must never enter query");
        let expected_fragment = format!("key={secret_b64}");
        assert_eq!(parsed.fragment(), Some(expected_fragment.as_str()));
        assert!(!parsed.path().contains(&secret_b64));
    }

    #[test]
    fn browser_invite_base_rejects_query_fragment_and_credentials() {
        for invalid in [
            "https://attn.sh/review?key=leak",
            "https://attn.sh/review#key=leak",
            "https://user:pass@attn.sh/review",
            "http://staging.attn.sh/review",
            "http://192.168.1.10/review",
            "file:///tmp/review",
        ] {
            assert!(
                parse_browser_review_base_url(Some(invalid)).is_err(),
                "unsafe browser review base must be rejected"
            );
        }
    }

    #[test]
    fn browser_invite_base_allows_exact_loopback_http_for_development() {
        for valid in [
            "http://localhost:5173/review",
            "http://127.0.0.1:5173/review",
            "http://[::1]:5173/review",
        ] {
            assert!(
                parse_browser_review_base_url(Some(valid)).is_ok(),
                "loopback development base must be accepted: {valid}"
            );
        }
    }

    #[test]
    fn browser_invite_base_defaults_to_production_review() {
        let base = parse_browser_review_base_url(None).expect("default base");
        assert_eq!(base.as_str(), DEFAULT_BROWSER_REVIEW_URL);
    }

    #[test]
    fn parse_invite_rejects_missing_prefix() {
        let raw = "https://attn.sh/review/room#key=SECRET-CANARY";
        let err = parse_invite(raw).expect_err("malformed");
        match err {
            BootstrapError::InviteParse(msg) => {
                assert!(msg.contains("missing attn review prefix"), "got: {msg}");
                assert!(!msg.contains(raw), "input leaked: {msg}");
                assert!(!msg.contains("SECRET-CANARY"), "secret leaked: {msg}");
            }
            other => panic!("expected InviteParse, got {other:?}"),
        }
    }

    #[test]
    fn parse_invite_rejects_missing_key_fragment() {
        let err = parse_invite("attn://review/abc").expect_err("no fragment");
        match err {
            BootstrapError::InviteParse(_) => {}
            other => panic!("expected InviteParse, got {other:?}"),
        }
    }

    #[test]
    fn parse_invite_rejects_bad_base64() {
        let err = parse_invite("attn://review/abc#key=***not_base64***").expect_err("bad b64");
        match err {
            BootstrapError::InviteParse(msg) => assert!(msg.contains("base64url"), "got: {msg}"),
            other => panic!("expected InviteParse, got {other:?}"),
        }
    }

    #[test]
    fn is_room_not_found_matches_only_the_specific_relay_code() {
        // The dead-room signal we prune on: 404 + ATTN_ROOM_NOT_FOUND.
        assert!(
            BootstrapError::Relay {
                status: 404,
                code: "ATTN_ROOM_NOT_FOUND".into(),
                message: "room X does not exist".into(),
            }
            .is_room_not_found(),
        );
        // A bare/unknown 404 (e.g. a routing miss) must NOT prune the room.
        assert!(
            !BootstrapError::Relay {
                status: 404,
                code: "ATTN_UNKNOWN".into(),
                message: String::new(),
            }
            .is_room_not_found(),
        );
        // Admission rejection (401) is terminal but not a missing room.
        assert!(
            !BootstrapError::Relay {
                status: 401,
                code: "ATTN_ADMISSION_REJECTED".into(),
                message: String::new(),
            }
            .is_room_not_found(),
        );
        assert!(!BootstrapError::Network("offline".into()).is_room_not_found());
    }

    #[test]
    fn resolve_default_display_name_is_non_empty() {
        // Best-effort resolution must always yield something usable to pre-fill.
        assert!(!resolve_default_display_name().is_empty());
    }

    #[test]
    fn effective_display_name_falls_back_to_default_when_unset() {
        let mut id = DeviceIdentity::generate().expect("generate");
        assert!(id.display_name.is_none());
        assert_eq!(id.effective_display_name(), resolve_default_display_name());
        // Whitespace-only is treated as unset.
        id.display_name = Some("   ".to_string());
        assert_eq!(id.effective_display_name(), resolve_default_display_name());
    }

    #[test]
    fn set_display_name_in_persists_then_clears() {
        let dir = TempDir::new().expect("home dir");
        // Set a name — creates the identity and persists the name.
        let effective = set_display_name_in(dir.path(), "  Ada Lovelace  ").expect("set");
        assert_eq!(effective, "Ada Lovelace"); // trimmed
        let reloaded = load_identity_from(dir.path())
            .expect("load")
            .expect("present");
        assert_eq!(reloaded.display_name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(reloaded.effective_display_name(), "Ada Lovelace");

        // Clearing with an empty string reverts to the resolved default.
        let effective = set_display_name_in(dir.path(), "").expect("clear");
        assert_eq!(effective, resolve_default_display_name());
        let reloaded = load_identity_from(dir.path())
            .expect("load")
            .expect("present");
        assert!(reloaded.display_name.is_none());
    }

    #[test]
    fn identity_json_without_display_name_field_still_loads() {
        // Pre-onboarding identity.json had no displayName field — serde(default)
        // must keep it loadable (None) rather than failing to deserialize.
        let dir = TempDir::new().expect("home dir");
        let legacy = r#"{
            "deviceId": "dev0000000000000000000",
            "participantId": "par0000000000000000000",
            "signingKey": "c2lnbmluZ19rZXlfc2VlZF8zMmJ5dGVzX2xvbmdfISEh",
            "publicSigningKey": "cHVibGljX3NpZ25pbmdfa2V5XzMyYnl0ZXNfISE",
            "publicEncryptionKey": "cHVibGljX3NpZ25pbmdfa2V5XzMyYnl0ZXNfISE"
        }"#;
        std::fs::write(dir.path().join(IDENTITY_FILENAME), legacy).expect("write legacy");
        let loaded = load_identity_from(dir.path())
            .expect("load")
            .expect("present");
        assert!(loaded.display_name.is_none());
        assert_eq!(loaded.device_id, "dev0000000000000000000");
    }

    #[test]
    fn parse_invite_rejects_room_id_mismatch() {
        // Build a legitimate invite for one secret, then swap the roomId in
        // the URL — parser must catch the inconsistency.
        let secret = [0x11u8; 32];
        let room_id = derive_room_id(&secret);
        let invite = build_invite_url(&room_id, &secret);
        let tampered = invite.replace(room_id.as_str(), "AAAAAAAAAAAAAAAAAAAAAA");
        let err = parse_invite(&tampered).expect_err("tampered roomId");
        match err {
            BootstrapError::InviteParse(msg) => assert!(msg.contains("mismatch"), "got: {msg}"),
            other => panic!("expected InviteParse, got {other:?}"),
        }
    }

    // --- Share flow -------------------------------------------------------

    #[tokio::test]
    async fn share_creates_room_registers_device_and_persists_identity() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        // Wiremock returns the request path back to us at runtime, so the
        // simplest path is to register catch-alls that match any roomId.
        Mock::given(method("POST"))
            .and(path_regex_for_room_create_v3())
            .and(header_exists("Attn-Admission"))
            .and(header_exists("Attn-Owner-Signature"))
            .respond_with(|req: &Request| {
                let body: serde_json::Value =
                    serde_json::from_slice(&req.body).unwrap_or(serde_json::Value::Null);
                let owner_key = body
                    .get("ownerSigningKey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let digest = Sha256::digest(owner_key.as_bytes());
                let owner_key_id = URL_SAFE_NO_PAD.encode(digest);
                ResponseTemplate::new(201).set_body_json(serde_json::json!({
                    "roomId": req.url.path().rsplit('/').next().unwrap_or(""),
                    "createdAt": 1_700_000_000_000u64,
                    "expiresAt": 1_700_086_400_000u64,
                    "policy": {},
                    "ownerSigningKeyId": owner_key_id,
                    "serverSeq": 0,
                }))
            })
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path_regex_for_devices_v3())
            .and(header_exists("Attn-Admission"))
            .and(header_exists("Attn-PoW"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let (_doc_tmp, path) = temp_markdown_file("plan.md", "# Plan\n");
        let outcome = boot
            .share(path.clone(), RoomMode::Async, None)
            .await
            .expect("share");
        assert!(outcome.newly_created);

        // Identity is on disk.
        let id_on_disk = load_identity_from(id_dir.path())
            .expect("load id")
            .expect("identity present");
        let derived_pub = id_on_disk
            .verifying_key()
            .expect("vk")
            .signing_key_id_base64url();
        assert_eq!(
            derived_pub,
            DeviceVerifyingKey::from_bytes(&{
                let raw = URL_SAFE_NO_PAD
                    .decode(id_on_disk.public_signing_key.as_bytes())
                    .unwrap();
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&raw);
                arr
            })
            .unwrap()
            .signing_key_id_base64url(),
            "verifying key derivation must be stable"
        );

        // Room is persisted with one event head (RoomCreated).
        let loaded_room = store
            .load_room(&outcome.room_id)
            .expect("load room")
            .expect("room present");
        assert_eq!(loaded_room.event_heads.len(), 1);
        assert_eq!(loaded_room.v, 3);
        let persisted_secret = load_room_secret(store.root(), &outcome.room_id).expect("secret");
        assert_eq!(derive_room_id_v3(&persisted_secret), outcome.room_id);
        assert_eq!(loaded_room.policy.mode, RoomMode::Async);
        assert!(
            loaded_room.policy.allow_browser,
            "new native shares must admit authenticated browser reviewers"
        );

        // Outbox holds: the RoomCreated event, the owner's self
        // ParticipantJoined announce (attn-42y — carries the display name
        // so owner-authored comments resolve to a real name on every
        // window), the snapshot blob, and the SnapshotCreated event — with
        // the blob enqueued BEFORE the event that references it, so peers
        // receive bytes-then-pointer in relay serverSeq order.
        let envelopes: Vec<MailboxEnvelope> = store
            .iter_outbox(&outcome.room_id)
            .expect("iter")
            .collect::<anyhow::Result<_>>()
            .expect("decode");
        assert_eq!(envelopes.len(), 4);
        assert_eq!(envelopes[0].kind, EnvelopeKind::Event, "RoomCreated");
        assert_eq!(
            envelopes[1].kind,
            EnvelopeKind::Event,
            "owner ParticipantJoined announce"
        );
        assert_eq!(
            envelopes[2].kind,
            EnvelopeKind::SnapshotBlob,
            "snapshot bytes ride the snapshot_blob lane"
        );
        assert_eq!(envelopes[3].kind, EnvelopeKind::Event, "SnapshotCreated");

        // The blob envelope opens under the room's snapshotKey and carries
        // the canonical SnapshotPlaintext bytes (markdown + anchor index).
        let ParsedInviteAny::V3(parsed) = parse_invite_any(&outcome.invite).expect("parse invite")
        else {
            panic!("new share must emit v3 invite")
        };
        let keys =
            crate::review::crypto::kdf::derive_read_keys_v3(&parsed.fragment.read_capability_key);
        let aad = crate::review::envelope::envelope_aad(&envelopes[2]);
        let nonce_bytes = URL_SAFE_NO_PAD
            .decode(envelopes[2].nonce.as_bytes())
            .expect("nonce decodes");
        let nonce: crate::review::crypto::aead::AeadNonce =
            nonce_bytes.as_slice().try_into().expect("24-byte nonce");
        let ciphertext = URL_SAFE_NO_PAD
            .decode(envelopes[2].ciphertext.as_bytes())
            .expect("ciphertext decodes");
        let blob_bytes = crate::review::crypto::aead::open(
            keys.snapshot_key.as_bytes(),
            &nonce,
            &ciphertext,
            &aad,
        )
        .expect("blob opens under snapshotKey");
        let plaintext: SnapshotPlaintext =
            serde_json::from_slice(&blob_bytes).expect("blob is a SnapshotPlaintext");
        assert_eq!(plaintext.content.as_deref(), Some("# Plan\n"));
        assert_eq!(plaintext.doc_type, crate::review::model::DocType::Markdown);
        assert!(
            plaintext.anchor_index.is_some(),
            "markdown snapshots carry an anchor index"
        );

        // Locally: blob persisted by envelopeId, SnapshotNode references it.
        let stored_blob = store
            .load_snapshot_blob(&outcome.room_id, &envelopes[2].envelope_id)
            .expect("load blob")
            .expect("owner persisted its own blob");
        assert_eq!(stored_blob, blob_bytes);
        let snapshots = store
            .iter_snapshots(&outcome.room_id)
            .expect("iter snapshots");
        assert_eq!(snapshots.len(), 1);
        let node = snapshots
            .into_iter()
            .next()
            .unwrap()
            .expect("snapshot node decodes");
        let node_ref = node
            .encrypted_blob_ref
            .expect("SnapshotNode carries the BlobRef");
        assert_eq!(node_ref.blob_id, envelopes[2].envelope_id);
        assert_eq!(
            node_ref.storage,
            crate::review::model::BlobStorage::Mailbox,
            "small fixture stays on the inline mailbox lane"
        );
        assert_eq!(node_ref.byte_length, blob_bytes.len() as u64);
    }

    /// Sharing an `.html` file publishes a read-only snapshot: the plaintext
    /// carries `DocType::Html`, the raw HTML source as `content`, and NO anchor
    /// index (HTML has no comment anchors yet).
    #[tokio::test]
    async fn share_html_file_publishes_read_only_snapshot() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        Mock::given(method("POST"))
            .and(path_regex_for_room_create_v3())
            .respond_with(|req: &Request| {
                ResponseTemplate::new(201).set_body_json(serde_json::json!({
                    "roomId": req.url.path().rsplit('/').next().unwrap_or(""),
                    "createdAt": 1_700_000_000_000u64,
                    "expiresAt": 1_700_086_400_000u64,
                    "policy": {},
                    "ownerSigningKeyId": "k",
                    "serverSeq": 0,
                }))
            })
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices_v3())
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let html = "<!doctype html><h1>Hi</h1>\n";
        let (_doc_tmp, path) = temp_markdown_file("page.html", html);
        let outcome = boot
            .share(path, RoomMode::Async, None)
            .await
            .expect("share html file");

        let envelopes: Vec<MailboxEnvelope> = store
            .iter_outbox(&outcome.room_id)
            .expect("iter")
            .collect::<anyhow::Result<_>>()
            .expect("decode");
        // Locate the snapshot-blob envelope rather than assume its index — the
        // share flow's envelope ordering has changed before (RoomCreated +
        // ParticipantJoined precede it).
        let blob_env = envelopes
            .iter()
            .find(|e| e.kind == EnvelopeKind::SnapshotBlob)
            .expect("a snapshot_blob envelope is enqueued for the shared HTML doc");

        let ParsedInviteAny::V3(parsed) = parse_invite_any(&outcome.invite).expect("parse invite")
        else {
            panic!("new share must emit v3 invite")
        };
        let keys =
            crate::review::crypto::kdf::derive_read_keys_v3(&parsed.fragment.read_capability_key);
        let aad = crate::review::envelope::envelope_aad(blob_env);
        let nonce_bytes = URL_SAFE_NO_PAD
            .decode(blob_env.nonce.as_bytes())
            .expect("nonce decodes");
        let nonce: crate::review::crypto::aead::AeadNonce =
            nonce_bytes.as_slice().try_into().expect("24-byte nonce");
        let ciphertext = URL_SAFE_NO_PAD
            .decode(blob_env.ciphertext.as_bytes())
            .expect("ciphertext decodes");
        let blob_bytes = crate::review::crypto::aead::open(
            keys.snapshot_key.as_bytes(),
            &nonce,
            &ciphertext,
            &aad,
        )
        .expect("blob opens under snapshotKey");
        let plaintext: SnapshotPlaintext =
            serde_json::from_slice(&blob_bytes).expect("blob is a SnapshotPlaintext");
        assert_eq!(plaintext.doc_type, crate::review::model::DocType::Html);
        assert_eq!(plaintext.content.as_deref(), Some(html));
        assert!(
            plaintext.anchor_index.is_none(),
            "read-only HTML snapshots carry no anchor index"
        );
    }

    #[tokio::test]
    async fn share_emits_invite_with_expected_shape() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, _store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        Mock::given(method("POST"))
            .and(path_regex_for_room_create_v3())
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "roomId": "x",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices_v3())
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let (_doc_tmp, path) = temp_markdown_file("x.md", "# X\n");
        let expected_display_path = path.to_string_lossy().to_string();
        let outcome = boot
            .share(path, RoomMode::Async, None)
            .await
            .expect("share");
        assert!(outcome.invite.starts_with("attn://review/"));
        assert!(
            outcome
                .browser_invite
                .starts_with("https://attn.sh/review/"),
            "ShareOutcome must expose the hosted-reviewer invite"
        );
        assert_eq!(
            outcome.owner_display_path, expected_display_path,
            "ShareOutcome must carry the exact path the owner shared so the dialog recognises its own room",
        );
        assert!(outcome.invite.contains("#v=3&tier=comment&"));
        assert!(outcome.view_invite.contains("tier=view"));
        assert!(outcome.suggest_invite.contains("tier=suggest"));
        let native_fragment = outcome.invite.split_once('#').expect("native fragment").1;
        let browser_url = reqwest::Url::parse(&outcome.browser_invite).expect("browser invite");
        assert_eq!(browser_url.query(), None);
        assert_eq!(browser_url.fragment(), Some(native_fragment));
        let ParsedInviteAny::V3(parsed) = parse_invite_any(&outcome.invite).expect("parse") else {
            panic!("new share must emit v3 invite")
        };
        assert_eq!(parsed.room_id, outcome.room_id);
    }

    #[tokio::test]
    async fn share_is_idempotent_per_path_for_live_room() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, _store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        // A re-Share of the same path returns the SAME room + invite (user-facing
        // idempotency), but it re-establishes the room on the relay first
        // (create_room is idempotent) so a relay that expired/lost the room can't
        // leave the owner dialing a dead room. So we expect TWO creates + two
        // registers across the two Shares.
        Mock::given(method("POST"))
            .and(path_regex_for_room_create_v3())
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "roomId": "x",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices_v3())
            .respond_with(ResponseTemplate::new(204))
            .expect(2)
            .mount(&server)
            .await;

        let (_doc_tmp, path) = temp_markdown_file("idempotent.md", "# Idempotent\n");
        let first = boot
            .share(path.clone(), RoomMode::Async, None)
            .await
            .expect("first share");
        assert!(first.newly_created);

        let second = boot
            .share(path.clone(), RoomMode::Async, None)
            .await
            .expect("second share");
        assert!(!second.newly_created, "second share must short-circuit");
        assert_eq!(first.room_id, second.room_id);
        assert_eq!(first.invite, second.invite);
        assert_eq!(first.browser_invite, second.browser_invite);
    }

    #[tokio::test]
    async fn durable_same_epoch_reconcile_publishes_an_offline_source_edit() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, _store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());
        Mock::given(method("POST"))
            .and(path_regex_for_room_create_v3())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "roomId": "x",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices_v3())
            .respond_with(ResponseTemplate::new(204))
            .expect(2)
            .mount(&server)
            .await;

        let (_doc_tmp, path) = temp_markdown_file("durable-offline.md", "# Before\n");
        let secret = [0xD4; 32];
        let first = boot
            .create_durable_epoch_room(path.clone(), secret)
            .await
            .expect("initial durable room");
        assert_eq!(
            first.snapshots[0].plaintext.content.as_deref(),
            Some("# Before\n")
        );
        std::fs::write(&path, "# After\n\nEdited offline.\n").expect("offline edit");

        let second = boot
            .create_durable_epoch_room(path, secret)
            .await
            .expect("same epoch reconcile");
        assert_eq!(first.snapshots[0].file_id, second.snapshots[0].file_id);
        assert_ne!(
            first.snapshots[0].snapshot_id,
            second.snapshots[0].snapshot_id
        );
        assert_eq!(
            second.snapshots[0].plaintext.content.as_deref(),
            Some("# After\n\nEdited offline.\n")
        );
    }

    // --- Join flow --------------------------------------------------------

    #[tokio::test]
    async fn join_parses_invite_registers_device_and_populates_cache() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        // Build a known invite. The wiremock relay responds to any roomId.
        let secret = [0x4Au8; 32];
        let room_id = derive_room_id(&secret);
        let invite = build_invite_url(&room_id, &secret);

        // Set up a pinned device directory entry that the cache will pick up.
        let directory_seed = [0x44u8; 32];
        let directory_sk = DeviceSigningKey::from_bytes(&directory_seed).unwrap();
        let directory_vk = directory_sk.verifying_key();
        let directory_public = URL_SAFE_NO_PAD.encode(directory_vk.to_bytes());
        let directory_key_id = directory_vk.signing_key_id_base64url();

        Mock::given(method("POST"))
            .and(path_regex_for_room_create())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "roomId": "x",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices())
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex_for_devices())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "devices": [
                    {
                        "deviceId": "owner-device",
                        "participantId": "owner-participant",
                        "publicSigningKey": directory_public,
                        "publicEncryptionKey": directory_public,
                        "client": "attn-native",
                        "kind": "owner",
                        "selfSignature": "test-fixture-signature",
                        "registeredAt": 1_700_000_000_000u64,
                    }
                ]
            })))
            .mount(&server)
            .await;

        let cache: Arc<RwLock<HashMap<String, DeviceVerifyingKey>>> =
            Arc::new(RwLock::new(HashMap::new()));
        let outcome = boot.join(&invite, Some(cache.clone())).await.expect("join");
        assert_eq!(outcome.room_id, room_id);

        // Verifying-key cache must contain the owner's keyId.
        let guard = cache.read().await;
        assert!(
            guard.contains_key(&directory_key_id),
            "verifying-key cache should be seeded with owner's keyId; got {:?}",
            guard.keys().collect::<Vec<_>>()
        );

        // Outbox holds a ParticipantJoined envelope.
        let envelopes: Vec<MailboxEnvelope> = store
            .iter_outbox(&room_id)
            .expect("iter")
            .collect::<anyhow::Result<_>>()
            .expect("decode");
        assert_eq!(envelopes.len(), 1);
    }

    #[tokio::test]
    async fn rejoin_preserves_existing_room_state() {
        // attn-6dd: step 5 of `join_with_identity` used to unconditionally
        // overwrite room.json with a fresh empty `ReviewRoom`. On a RE-join
        // (same invite pasted again, or a daemon restart followed by a join)
        // that clobbered the documents/snapshots/event_heads the room had
        // accumulated. Re-join must keep the existing room.json intact.
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        let secret = [0x4Bu8; 32];
        let room_id = derive_room_id(&secret);
        let invite = build_invite_url(&room_id, &secret);

        Mock::given(method("POST"))
            .and(path_regex_for_room_create())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "roomId": "x",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices())
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex_for_devices())
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "devices": [] })),
            )
            .mount(&server)
            .await;

        // First join persists the fresh empty room.
        boot.join(&invite, None).await.expect("first join");
        let mut room = store
            .load_room(&room_id)
            .expect("load")
            .expect("room.json exists after first join");
        assert!(room.event_heads.is_empty());

        // Simulate accumulated state between sessions.
        let head: crate::review::ids::EventId =
            serde_json::from_value(serde_json::Value::String("evt-head-1".into()))
                .expect("EventId deserializes");
        room.event_heads = vec![head.clone()];
        store.save_room(&room).expect("save mutated room");

        // Re-join with the same invite must NOT reset the room.
        boot.join(&invite, None).await.expect("re-join");
        let room_after = store
            .load_room(&room_id)
            .expect("load")
            .expect("room.json still exists");
        assert_eq!(
            room_after.event_heads,
            vec![head],
            "re-join must not clobber room.json with an empty ReviewRoom"
        );
    }

    #[tokio::test]
    async fn reannounce_identity_emits_participant_joined_with_fresh_name() {
        // The onboarding NamePrompt fires AFTER a room is entered, so the
        // join-time ParticipantJoined carries the stale default name.
        // `reannounce_identity` must enqueue a fresh PJ with the renamed
        // identity so all windows re-resolve the author.
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        let secret = [0x5Cu8; 32];
        let room_id = derive_room_id(&secret);
        let invite = build_invite_url(&room_id, &secret);

        Mock::given(method("POST"))
            .and(path_regex_for_room_create())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "roomId": "x",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices())
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex_for_devices())
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "devices": [] })),
            )
            .mount(&server)
            .await;

        boot.join(&invite, None).await.expect("join");

        // Rename AFTER joining — the user's exact flow.
        set_display_name_in(id_dir.path(), "Reader").expect("rename");
        boot.reannounce_identity(&room_id, ParticipantKind::Reviewer)
            .expect("reannounce");

        let envelopes: Vec<MailboxEnvelope> = store
            .iter_outbox(&room_id)
            .expect("iter")
            .collect::<anyhow::Result<_>>()
            .expect("decode");
        // Join-time PJ plus the re-announce.
        assert_eq!(envelopes.len(), 2);
        let env = &envelopes[1];
        assert_eq!(env.kind, EnvelopeKind::Event);

        // The re-announce decrypts to a participant_joined carrying the
        // renamed identity.
        let keys = derive_room_keys(&secret);
        let aad = crate::review::envelope::envelope_aad(env);
        let nonce_bytes = URL_SAFE_NO_PAD
            .decode(env.nonce.as_bytes())
            .expect("nonce decodes");
        let nonce: crate::review::crypto::aead::AeadNonce =
            nonce_bytes.as_slice().try_into().expect("24-byte nonce");
        let ciphertext = URL_SAFE_NO_PAD
            .decode(env.ciphertext.as_bytes())
            .expect("ciphertext decodes");
        let plaintext =
            crate::review::crypto::aead::open(keys.event_key.as_bytes(), &nonce, &ciphertext, &aad)
                .expect("event opens under eventKey");
        let event: serde_json::Value = serde_json::from_slice(&plaintext).expect("event JSON");
        assert_eq!(event["body"]["type"], "participant_joined");
        assert_eq!(event["body"]["participant"]["displayName"], "Reader");
        assert_eq!(event["body"]["participant"]["kind"], "reviewer");
    }

    #[tokio::test]
    async fn join_with_malformed_invite_errors_without_network() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, _store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        let err = boot
            .join("attn://wrong/abc#key=", None)
            .await
            .expect_err("malformed");
        match err {
            BootstrapError::InviteParse(_) => {}
            other => panic!("expected InviteParse, got {other:?}"),
        }
        // No HTTP calls should have fired.
        let reqs = server.received_requests().await.expect("requests");
        assert!(reqs.is_empty(), "malformed invite must not hit the relay");
    }

    // --- Join as agent flow (attn-nnj.9.6) --------------------------------

    #[tokio::test]
    async fn join_as_agent_registers_with_kind_agent_and_agent_cli_client() {
        // The remote-agent participant type sends `kind: "agent"` (NOT
        // "reviewer") and `client: "agent-cli"` on POST /devices, signed by
        // the agent's own Ed25519 key — verifies the wire shape pinned by
        // amendments.md §Agent CLI key handling.
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        // Build an invite the agent will join with.
        let secret = [0x5Au8; 32];
        let room_id = derive_room_id(&secret);
        let invite = build_invite_url(&room_id, &secret);

        // Spin up an explicit agent identity (parallels what
        // `agent_identity::register_agent_in` produces).
        let agent_identity = DeviceIdentity::generate().expect("agent identity");
        let agent_pub_key = agent_identity.public_signing_key.clone();
        let agent_device_id = agent_identity.device_id.clone();

        // Capture the device-registration body for assertions.
        let captured: Arc<std::sync::Mutex<Option<RegisterDeviceBody>>> =
            Arc::new(std::sync::Mutex::new(None));
        let capture_clone = captured.clone();

        Mock::given(method("POST"))
            .and(path_regex_for_room_create())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "roomId": "x",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices())
            .respond_with(move |req: &Request| {
                if let Ok(body) = serde_json::from_slice::<RegisterDeviceBody>(&req.body) {
                    *capture_clone.lock().unwrap() = Some(body);
                }
                ResponseTemplate::new(204)
            })
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex_for_devices())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "devices": []
            })))
            .mount(&server)
            .await;

        let outcome = boot
            .join_as_agent(&invite, &agent_identity, None)
            .await
            .expect("join_as_agent");
        assert_eq!(outcome.room_id, room_id);

        // The wire body must be `kind=agent`, `client=agent-cli`, and the
        // pubkey + deviceId from the agent identity (NOT the daemon's).
        let body = captured
            .lock()
            .unwrap()
            .take()
            .expect("devices POST must have been captured");
        assert_eq!(body.kind, "agent");
        assert_eq!(body.client, "agent-cli");
        assert_eq!(
            body.public_signing_key, agent_pub_key,
            "register-device body must carry the agent's pubkey, not the daemon's"
        );
        assert_eq!(body.device_id, agent_device_id);

        // The ParticipantJoined envelope landed on the outbox with the
        // agent identity's pubkey as the signer.
        let envelopes: Vec<MailboxEnvelope> = store
            .iter_outbox(&room_id)
            .expect("iter")
            .collect::<anyhow::Result<_>>()
            .expect("decode");
        assert_eq!(envelopes.len(), 1, "exactly one ParticipantJoined envelope");

        // Daemon-side identity must NOT have been touched — proves the
        // agent join uses its own key, not the owner's daemon identity.
        let daemon_id_path = id_dir.path().join(IDENTITY_FILENAME);
        assert!(
            !daemon_id_path.exists(),
            "join_as_agent must not auto-create the daemon identity"
        );
    }

    #[tokio::test]
    async fn join_as_agent_uses_distinct_identities_for_multiple_agents() {
        // Two agents (rufus + alex) join the same room independently. Each
        // POST /devices must carry the respective agent's pubkey — proves
        // multiple agents are first-class, distinct participants.
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, _store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        let secret = [0x6Bu8; 32];
        let room_id = derive_room_id(&secret);
        let invite = build_invite_url(&room_id, &secret);

        let rufus = DeviceIdentity::generate().expect("rufus identity");
        let alex = DeviceIdentity::generate().expect("alex identity");
        assert_ne!(rufus.public_signing_key, alex.public_signing_key);

        let captured: Arc<std::sync::Mutex<Vec<RegisterDeviceBody>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let capture_clone = captured.clone();

        Mock::given(method("POST"))
            .and(path_regex_for_room_create())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "roomId": "x",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices())
            .respond_with(move |req: &Request| {
                if let Ok(body) = serde_json::from_slice::<RegisterDeviceBody>(&req.body) {
                    capture_clone.lock().unwrap().push(body);
                }
                ResponseTemplate::new(204)
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex_for_devices())
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "devices": []
            })))
            .mount(&server)
            .await;

        let _ = boot
            .join_as_agent(&invite, &rufus, None)
            .await
            .expect("rufus join");
        let _ = boot
            .join_as_agent(&invite, &alex, None)
            .await
            .expect("alex join");

        let bodies = captured.lock().unwrap().clone();
        assert_eq!(bodies.len(), 2, "two devices POSTs expected");
        let keys: std::collections::HashSet<_> = bodies
            .iter()
            .map(|b| b.public_signing_key.clone())
            .collect();
        assert_eq!(
            keys.len(),
            2,
            "the two agents must register distinct pubkeys (got {keys:?})"
        );
        assert!(keys.contains(&rufus.public_signing_key));
        assert!(keys.contains(&alex.public_signing_key));
        for body in &bodies {
            assert_eq!(body.kind, "agent");
            assert_eq!(body.client, "agent-cli");
        }
    }

    #[tokio::test]
    async fn join_as_agent_rejects_malformed_invite_without_network() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, _store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        let agent_identity = DeviceIdentity::generate().expect("agent identity");
        let err = boot
            .join_as_agent("not-an-invite", &agent_identity, None)
            .await
            .expect_err("malformed");
        match err {
            BootstrapError::InviteParse(_) => {}
            other => panic!("expected InviteParse, got {other:?}"),
        }
        let reqs = server.received_requests().await.expect("requests");
        assert!(
            reqs.is_empty(),
            "malformed invite must not hit the relay (got {} reqs)",
            reqs.len()
        );
    }

    #[test]
    fn participant_capabilities_match_data_model_spec() {
        // Spec: data-model.md §Participant And Device. Agents get only the
        // read/write-finding capabilities. In particular, they cannot close a
        // human discussion by resolving its thread.
        let caps = agent_capabilities(ParticipantKind::Agent);
        assert_eq!(
            caps,
            vec![
                Capability::ReadSnapshot,
                Capability::WriteComment,
                Capability::WriteSuggestion,
            ]
        );

        // A human reviewer may resolve comment threads, but still cannot
        // administer the room, accept a suggestion on the owner's behalf, or
        // publish owner snapshots.
        let reviewer_caps = agent_capabilities(ParticipantKind::Reviewer);
        assert_eq!(
            reviewer_caps,
            vec![
                Capability::ReadSnapshot,
                Capability::WriteComment,
                Capability::WriteSuggestion,
                Capability::ResolveComment,
            ]
        );
    }

    #[test]
    fn persisted_participant_join_pins_device_signing_key_across_restart() {
        let id_dir = TempDir::new().expect("identity dir");
        let (_tmp, store, boot) = make_bootstrapper(
            "http://127.0.0.1:9".to_string(),
            id_dir.path().to_path_buf(),
        );
        let identity = DeviceIdentity::generate().expect("identity");
        let room_id = derive_room_id(&[0x6Cu8; 32]);
        let participant_id = identity.typed_participant_id();
        let device_id = identity.typed_device_id();
        let key_id = identity
            .verifying_key()
            .expect("verifying key")
            .signing_key_id_base64url();
        let event = ReviewEvent {
            meta: EventMeta {
                v: 2,
                event_id: placeholder_event_id(),
                room_id: room_id.clone(),
                author_id: participant_id.clone(),
                device_id: device_id.clone(),
                created_at: 1_700_000_000_000,
                parent_event_ids: vec![],
                snapshot_id: None,
            },
            body: ReviewEventBody::ParticipantJoined {
                participant: Participant {
                    participant_id: participant_id.clone(),
                    display_name: "Pinned reviewer".into(),
                    kind: ParticipantKind::Reviewer,
                    public_signing_key: identity.public_signing_key.clone(),
                    capabilities: agent_capabilities(ParticipantKind::Reviewer),
                },
                device: Device {
                    device_id: device_id.clone(),
                    participant_id,
                    public_encryption_key: identity.public_encryption_key.clone(),
                    public_signing_key: identity.public_signing_key.clone(),
                    client: DeviceClient::AttnNative,
                    created_at: 1_700_000_000_000,
                },
            },
            auth: crate::review::model::EventAuth {
                signature: "already-verified-fixture".into(),
                signing_key_id: key_id.clone(),
            },
        };
        store
            .append_event(&room_id, &event)
            .expect("persist participant join");

        let bindings = boot
            .persisted_device_key_bindings(&room_id)
            .expect("load trust bindings");
        assert_eq!(bindings.get(device_id.as_str()), Some(&key_id));
    }

    // --- attn-nnj.5.17 (H1) — Attn-Owner-Signature on first room create ---

    /// The Share flow must attach an `Attn-Owner-Signature` whose Ed25519
    /// signature verifies against the body's `ownerSigningKey`. This is the
    /// H1 mitigation: a leaked URL is not enough to register as room owner —
    /// the requester must also hold the owner private key.
    #[tokio::test]
    async fn share_attaches_owner_sig_that_verifies_against_canonical_request() {
        use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
        use std::sync::Mutex;
        use wiremock::matchers::path_regex;

        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, _store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        // Capture the request so we can re-derive canonicalRequest and
        // verify the sig the same way the relay does.
        // (method, path, body, owner-signature) snapshot of the mocked request.
        type CapturedRequest = (String, String, Vec<u8>, String);
        let captured: Arc<Mutex<Option<CapturedRequest>>> = Arc::new(Mutex::new(None));
        let capture = captured.clone();

        Mock::given(method("POST"))
            .and(path_regex(r"^/v3/rooms/[A-Za-z0-9_-]{20,32}$"))
            .and(header_exists("Attn-Owner-Signature"))
            .respond_with(move |req: &Request| {
                let owner_sig = req
                    .headers
                    .get("Attn-Owner-Signature")
                    .map(|v| v.to_str().unwrap_or("").to_string())
                    .unwrap_or_default();
                *capture.lock().unwrap() = Some((
                    req.method.to_string(),
                    req.url.path().to_string(),
                    req.body.clone(),
                    owner_sig,
                ));
                let body: serde_json::Value =
                    serde_json::from_slice(&req.body).unwrap_or(serde_json::Value::Null);
                let owner_key = body
                    .get("ownerSigningKey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let digest = Sha256::digest(owner_key.as_bytes());
                let owner_key_id = URL_SAFE_NO_PAD.encode(digest);
                ResponseTemplate::new(201).set_body_json(serde_json::json!({
                    "roomId": req.url.path().rsplit('/').next().unwrap_or(""),
                    "createdAt": 1_700_000_000_000u64,
                    "expiresAt": 1_700_086_400_000u64,
                    "policy": {},
                    "ownerSigningKeyId": owner_key_id,
                    "serverSeq": 0,
                }))
            })
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices_v3())
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let (_doc_tmp, path) = temp_markdown_file("owner-sig-test.md", "# Owner sig\n");
        boot.share(path, RoomMode::Async, None)
            .await
            .expect("share");

        // Decode the captured request + sig.
        let (method_s, url_path, body_bytes, owner_sig_b64) = captured
            .lock()
            .unwrap()
            .take()
            .expect("server must have observed the POST /v2/rooms/:roomId");

        // Re-build canonicalRequest exactly like the relay (and our shared
        // build_canonical_request helper): METHOD || \n || PATH || \n ||
        // EMPTY_QUERY || \n || SHA256(body).
        let canonical = build_canonical_request(&method_s, &url_path, &body_bytes);

        // Extract ownerSigningKey from the request body, decode, import as
        // an Ed25519 verifying key, and verify the sig over canonical.
        let parsed: serde_json::Value = serde_json::from_slice(&body_bytes).expect("body json");
        let owner_pub_b64 = parsed
            .get("ownerSigningKey")
            .and_then(|v| v.as_str())
            .expect("body has ownerSigningKey");
        let owner_pub_bytes = URL_SAFE_NO_PAD
            .decode(owner_pub_b64.as_bytes())
            .expect("ownerSigningKey decodes");
        let owner_pub_arr: [u8; 32] = owner_pub_bytes
            .as_slice()
            .try_into()
            .expect("32-byte pubkey");
        let verifying = VerifyingKey::from_bytes(&owner_pub_arr).expect("valid pubkey");

        let sig_bytes = URL_SAFE_NO_PAD
            .decode(owner_sig_b64.as_bytes())
            .expect("Attn-Owner-Signature decodes");
        let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("64-byte sig");
        let sig = Signature::from_bytes(&sig_arr);

        verifying
            .verify(&canonical, &sig)
            .expect("Attn-Owner-Signature must verify against ownerSigningKey + canonicalRequest");
    }

    /// `build_canonical_request` must produce exactly:
    ///   METHOD || "\n" || PATH || "\n" || "" || "\n" || SHA256(body)
    /// Drift here causes silent admission/owner-sig mismatches with the relay.
    #[test]
    fn build_canonical_request_matches_relay_format() {
        let bytes = build_canonical_request("POST", "/v2/rooms/abc", b"hello");
        // The first four parts are deterministic newline-separated text.
        let prefix_len = ("POST".len() + 1 + "/v2/rooms/abc".len() + 1) + 1;
        let expected_prefix = b"POST\n/v2/rooms/abc\n\n";
        assert_eq!(&bytes[..prefix_len], expected_prefix);
        // Last 32 bytes must be SHA-256(body).
        let body_hash = Sha256::digest(b"hello");
        assert_eq!(&bytes[prefix_len..], body_hash.as_slice());
        assert_eq!(bytes.len(), prefix_len + 32);
    }

    // --- helpers ----------------------------------------------------------

    /// Path regex matching `/v2/rooms/<22-char-base64url>` (room create).
    fn path_regex_for_room_create() -> wiremock::matchers::PathRegexMatcher {
        wiremock::matchers::path_regex(r"^/v2/rooms/[A-Za-z0-9_-]{20,32}$")
    }

    /// Path regex matching `/v2/rooms/<room>/devices`.
    fn path_regex_for_devices() -> wiremock::matchers::PathRegexMatcher {
        wiremock::matchers::path_regex(r"^/v2/rooms/[A-Za-z0-9_-]{20,32}/devices$")
    }

    fn path_regex_for_room_create_v3() -> wiremock::matchers::PathRegexMatcher {
        wiremock::matchers::path_regex(r"^/v3/rooms/[A-Za-z0-9_-]{20,32}$")
    }

    fn path_regex_for_devices_v3() -> wiremock::matchers::PathRegexMatcher {
        wiremock::matchers::path_regex(r"^/v3/rooms/[A-Za-z0-9_-]{20,32}/devices$")
    }

    // ----- R2 spillover lane (large snapshots) ----------------------------

    #[tokio::test]
    async fn publish_snapshot_spills_large_blobs_to_r2() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        Mock::given(method("POST"))
            .and(path_regex_for_room_create_v3())
            .respond_with(|req: &Request| {
                ResponseTemplate::new(201).set_body_json(serde_json::json!({
                    "roomId": req.url.path().rsplit('/').next().unwrap_or(""),
                    "createdAt": 1_700_000_000_000u64,
                    "expiresAt": 1_700_086_400_000u64,
                    "policy": {},
                    "ownerSigningKeyId": "k",
                    "serverSeq": 0,
                }))
            })
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path_regex_for_devices_v3())
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        // Upload presign: echo back a relative cap URL for the requested
        // envelopeId, exactly like relay r2.ts does.
        Mock::given(method("POST"))
            .and(wiremock::matchers::path_regex(
                r"^/v3/rooms/[A-Za-z0-9_-]{20,32}/blobs$",
            ))
            .and(header_exists("Attn-Admission"))
            .and(header_exists("Attn-PoW"))
            .respond_with(|req: &Request| {
                let body: serde_json::Value =
                    serde_json::from_slice(&req.body).unwrap_or(serde_json::Value::Null);
                let envelope_id = body
                    .get("envelopeId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("missing");
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "uploadUrl": format!("{}/{}?cap=test-cap", req.url.path(), envelope_id),
                    "method": "PUT",
                    "headers": {"Content-Type": "application/octet-stream"},
                    "expiresAt": 1_700_086_400_000u64,
                    "blobKey": format!("rooms/x/blobs/{envelope_id}"),
                }))
            })
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/v3/rooms/[A-Za-z0-9_-]{20,32}/blobs/[A-Za-z0-9_-]+$",
            ))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        // Big enough that the sealed SnapshotPlaintext ciphertext clears the
        // relay's 1 MiB inline threshold even before the anchor index.
        let big_markdown = format!("# Big\n\n{}\n", "x".repeat(1_200_000));
        let (_doc_tmp, path) = temp_markdown_file("big.md", &big_markdown);
        let outcome = boot
            .share(path, RoomMode::Async, None)
            .await
            .expect("share large file");

        let envelopes: Vec<MailboxEnvelope> = store
            .iter_outbox(&outcome.room_id)
            .expect("iter")
            .collect::<anyhow::Result<_>>()
            .expect("decode");
        // RoomCreated, owner ParticipantJoined announce (attn-42y), blob
        // wrapper, SnapshotCreated.
        assert_eq!(envelopes.len(), 4);
        assert_eq!(envelopes[2].kind, EnvelopeKind::SnapshotBlob);
        assert!(
            envelopes[2].ciphertext_bytes < 1024,
            "outbox envelope must be the small BlobRef wrapper, got {} bytes",
            envelopes[2].ciphertext_bytes
        );

        // The wrapper opens under snapshotKey to a BlobRef pointing at R2.
        let parsed = parse_invite_any(&outcome.invite).expect("parse invite");
        let snapshot_key = match parsed {
            ParsedInviteAny::V3(parsed) => *crate::review::crypto::kdf::derive_read_keys_v3(
                &parsed.fragment.read_capability_key,
            )
            .snapshot_key
            .as_bytes(),
            ParsedInviteAny::V2(parsed) => *derive_room_keys(&parsed.room_secret)
                .snapshot_key
                .as_bytes(),
        };
        let aad = crate::review::envelope::envelope_aad(&envelopes[2]);
        let nonce_bytes = URL_SAFE_NO_PAD
            .decode(envelopes[2].nonce.as_bytes())
            .expect("nonce decodes");
        let nonce: crate::review::crypto::aead::AeadNonce =
            nonce_bytes.as_slice().try_into().expect("24-byte nonce");
        let ciphertext = URL_SAFE_NO_PAD
            .decode(envelopes[2].ciphertext.as_bytes())
            .expect("ciphertext decodes");
        let ref_bytes = crate::review::crypto::aead::open(&snapshot_key, &nonce, &ciphertext, &aad)
            .expect("wrapper opens under snapshotKey");
        let blob_ref: crate::review::model::BlobRef =
            serde_json::from_slice(&ref_bytes).expect("wrapper plaintext is a BlobRef");
        assert_eq!(blob_ref.storage, crate::review::model::BlobStorage::R2);
        assert_eq!(blob_ref.blob_id, envelopes[2].envelope_id);

        // The owner still persists the decrypted bytes + node locally.
        let stored_blob = store
            .load_snapshot_blob(&outcome.room_id, &envelopes[2].envelope_id)
            .expect("load blob")
            .expect("blob persisted");
        assert_eq!(stored_blob.len() as u64, blob_ref.byte_length);
        let node = store
            .iter_snapshots(&outcome.room_id)
            .expect("iter snapshots")
            .into_iter()
            .next()
            .expect("one snapshot")
            .expect("node decodes");
        assert_eq!(
            node.encrypted_blob_ref.expect("node blob ref").storage,
            crate::review::model::BlobStorage::R2
        );
        // wiremock `.expect(1)` on presign + PUT verifies the upload happened.
    }

    #[test]
    fn frozen_ack_validation_rejects_reordering_gaps_zero_and_count_mismatch() {
        let valid = serde_json::json!({"accepted": [
            {"envelopeId": "a", "serverSeq": 41},
            {"envelopeId": "b", "serverSeq": 42}
        ]});
        assert_eq!(
            validate_frozen_acks(&["a", "b"], &serde_json::to_vec(&valid).unwrap()).unwrap(),
            42
        );
        for invalid in [
            serde_json::json!({"accepted": [
                {"envelopeId": "b", "serverSeq": 41},
                {"envelopeId": "a", "serverSeq": 42}
            ]}),
            serde_json::json!({"accepted": [
                {"envelopeId": "a", "serverSeq": 41},
                {"envelopeId": "b", "serverSeq": 43}
            ]}),
            serde_json::json!({"accepted": [
                {"envelopeId": "a", "serverSeq": 0},
                {"envelopeId": "b", "serverSeq": 1}
            ]}),
            serde_json::json!({"accepted": [
                {"envelopeId": "a", "serverSeq": 41}
            ]}),
        ] {
            assert!(
                validate_frozen_acks(&["a", "b"], &serde_json::to_vec(&invalid).unwrap()).is_err()
            );
        }
    }
}
