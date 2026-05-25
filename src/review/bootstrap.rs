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
use crate::review::crypto::kdf::{derive_room_id, derive_room_keys};
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
const BOOTSTRAP_POW_DIFFICULTY: u32 = 12;

/// PoW token TTL for bootstrap device registration. Matches the crypto-spec
/// default — tokens persist long enough for a single device-register retry
/// after PoW invalidation.
const BOOTSTRAP_POW_TTL_MS: u64 = crate::review::crypto::pow::DEFAULT_TTL_MS;

/// Default `RoomPolicy` for newly shared rooms.
///
/// Default mode is `Hybrid` — direct WebRTC when both peers are online,
/// mailbox fallback when they're not, transparent switching as
/// connectivity changes. The user-facing Share dialog does NOT expose
/// a mode picker (per UX feedback 2026-05-19: "I want not live or
/// envelope mode it should seamlessly do both"); only power-user CLI
/// paths can override.
///
/// `allow_remote_agents` defaults to `true` because the only way to
/// reach the doc as a reviewer today is `attn review join --as-agent`
/// (the UI's paste-invite flow isn't built yet), so leaving this `false`
/// would silently block every reviewer at the relay.
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
        allow_browser: false,
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

/// Parse an `attn://review/<roomId>#key=<base64url>` invite. Strict: the
/// scheme, host segment, and fragment shape must all match; anything else is
/// surfaced as a `BootstrapError::InviteParse`.
pub fn parse_invite(invite: &str) -> Result<ParsedInvite, BootstrapError> {
    let rest = invite
        .strip_prefix("attn://review/")
        .ok_or_else(|| BootstrapError::InviteParse(format!("missing prefix: {invite}")))?;
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
    #[allow(dead_code)]
    public_encryption_key: String,
    #[allow(dead_code)]
    client: String,
    kind: String,
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

/// Successful Share outcome — carries the freshly minted invite + the room id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareOutcome {
    pub room_id: RoomId,
    pub invite: String,
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

/// Successful Join outcome — carries the room id the user joined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinOutcome {
    pub room_id: RoomId,
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
    pub async fn share(
        &self,
        path: PathBuf,
        mode: RoomMode,
        _ttl: Option<String>,
    ) -> Result<ShareOutcome, BootstrapError> {
        let now_ms = unix_now_ms();
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
        if let Some(existing) = self.find_existing_share(&path, now_ms)? {
            let secret = load_room_secret(self.store.root(), &existing.room_id)?;
            let keys = derive_room_keys(&secret);
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
            let create_res = self
                .create_room(&existing.room_id, &policy, &identity, &keys.admission_key)
                .await;
            let reestablished = match create_res {
                Ok(()) => self
                    .register_device(&existing.room_id, &identity, "owner", &keys.admission_key)
                    .await
                    .is_ok(),
                Err(_) => false,
            };
            if reestablished {
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
        let room_id = derive_room_id(&room_secret);
        let room_keys = derive_room_keys(&room_secret);

        let policy = {
            let mut p = default_room_policy(now_ms);
            p.mode = mode;
            p
        };

        // 3. Register the room with the relay. Idempotent on roomId; returns
        //    200 with the stored policy if it already exists.
        self.create_room(&room_id, &policy, &identity, &room_keys.admission_key)
            .await?;

        // 4. Publish the owner device.
        self.register_device(&room_id, &identity, "owner", &room_keys.admission_key)
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
            event_key: *room_keys.event_key.as_bytes(),
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

        // 6. Persist the room state on disk. We snapshot a `ReviewRoom` with
        //    no documents/snapshots yet — that wiring lands when SnapshotCreated
        //    flows through ReviewManager. The path is recorded in `bindings.json`
        //    keyed by a placeholder FileId-shaped key derived from the invite,
        //    so a re-Share of the same path can short-circuit (see
        //    `find_existing_share`).
        let review_room = ReviewRoom {
            v: 2,
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
            match self.publish_initial_snapshot(&room_id, &doc_path, now_ms) {
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
        let invite = build_invite_url(&room_id, &room_secret);

        Ok(ShareOutcome {
            room_id,
            invite,
            newly_created: true,
            owner_signing_key: identity.public_signing_key.clone(),
            mode: room_mode_wire(policy.mode),
            expires_at: policy.expires_at,
        })
    }

    /// Look up an existing share for `path` whose room hasn't expired. Returns
    /// `Ok(None)` when no live binding exists. The on-disk index is
    /// `{store_root}/shares/local-shares.json` (see `record_local_share`).
    fn find_existing_share(
        &self,
        path: &std::path::Path,
        now_ms: u64,
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
            let invite = build_invite_url(&room_id, &secret);
            // For the re-Share path we don't have the owner identity in
            // scope, so resolve it the same way `share()` does. The dialog
            // needs the signing key to render the fingerprint regardless of
            // whether this Share is a fresh mint or a cached re-emit.
            let identity_dir = self.config.identity_dir()?;
            let identity = load_or_create_identity_in(&identity_dir)?;
            let policy_mode = policy.mode;
            let expires_at = policy.expires_at;
            return Ok(Some(ShareOutcome {
                room_id,
                invite,
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
        save_room_secret(self.store.root(), &parsed.room_id, &parsed.room_secret)?;

        Ok(JoinOutcome {
            room_id: parsed.room_id,
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
        cache: &Arc<RwLock<std::collections::HashMap<String, DeviceVerifyingKey>>>,
    ) -> Result<usize, BootstrapError> {
        let room_secret = load_room_secret(self.store.root(), room_id)?;
        let room_keys = derive_room_keys(&room_secret);
        let directory = self.list_devices(room_id, &room_keys.admission_key).await?;
        let mut guard = cache.write().await;
        let mut added = 0usize;
        for dev in &directory {
            let raw = URL_SAFE_NO_PAD
                .decode(dev.public_signing_key.as_bytes())
                .map_err(|e| BootstrapError::Crypto(format!("directory key decode: {e}")))?;
            let bytes: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
                BootstrapError::Crypto("directory key must decode to 32 bytes".into())
            })?;
            let vk = DeviceVerifyingKey::from_bytes(&bytes)?;
            guard.insert(vk.signing_key_id_base64url(), vk);
            added += 1;
        }
        Ok(added)
    }

    /// Read the shared file off disk, build a snapshot of its current
    /// state, and append a `SnapshotCreated` event to the room's outbox.
    /// Returns the freshly minted `FileId` + `SnapshotId` so the caller
    /// can persist them into `ReviewRoom.documents` / `.snapshots`.
    pub fn publish_initial_snapshot(
        &self,
        room_id: &RoomId,
        path: &std::path::Path,
        now_ms: u64,
    ) -> Result<(FileId, SnapshotId), BootstrapError> {
        self.publish_snapshot(room_id, path, None, now_ms)
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
    pub fn publish_snapshot(
        &self,
        room_id: &RoomId,
        path: &std::path::Path,
        existing_file_id: Option<FileId>,
        now_ms: u64,
    ) -> Result<(FileId, SnapshotId), BootstrapError> {
        use crate::review::anchors::index::build_anchor_index;
        use crate::review::crypto::ids::{content_hash, derive_file_id, derive_snapshot_id};

        let markdown_bytes = std::fs::read(path)
            .map_err(|e| BootstrapError::Store(format!("read {}: {e}", path.display())))?;
        let base_hash = content_hash(&markdown_bytes);

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

        let markdown = String::from_utf8(markdown_bytes)
            .map_err(|_| BootstrapError::Crypto("snapshot markdown must be utf-8".into()))?;
        let anchor_index = build_anchor_index(markdown.as_bytes(), &snapshot_id)
            .map_err(|e| BootstrapError::Crypto(format!("anchor index: {e}")))?;
        let plaintext = SnapshotPlaintext {
            markdown,
            anchor_index,
        };

        let body = ReviewEventBody::SnapshotCreated {
            file_id: file_id.clone(),
            snapshot_id: snapshot_id.clone(),
            owner_display_path: Some(display_path),
            parent_snapshot_id: None,
            base_hash,
            encrypted_blob_ref: None,
            // Inline the plaintext. The whole event body is AEAD-encrypted
            // by `assemble_event_envelope`, so the markdown is still
            // ciphertext on the wire — `decision #14` is preserved in
            // spirit (no plaintext over HTTP) even though the field
            // serializes through the event JSON.
            inline_snapshot: Some(plaintext),
        };

        let outcome = self.send_event_sync(room_id, body, now_ms)?;
        // Persist the stable file_id on the first publish so future edits
        // reuse it (looked up via `find_room_for_path`).
        if is_first {
            record_share_file_id(self.store.root(), room_id, path, &file_id)?;
        }
        tracing::info!(
            "published snapshot file={} snapshot={} bytes={} first={} room={}",
            file_id.as_str(),
            snapshot_id.as_str(),
            outcome.envelope.ciphertext_bytes,
            is_first,
            room_id.as_str(),
        );
        Ok((file_id, snapshot_id))
    }

    /// Republish a snapshot for a file the owner just edited. Looks up the
    /// room + stable file_id for `path`; no-op (returns `Ok(None)`) when the
    /// path isn't shared. Called from the `PublishSnapshot` IPC on save.
    pub fn republish_snapshot_for_path(
        &self,
        path: &std::path::Path,
        now_ms: u64,
    ) -> Result<Option<(RoomId, FileId, SnapshotId)>, BootstrapError> {
        let Some((room_id, file_id)) = find_room_for_path(self.store.root(), path)? else {
            return Ok(None);
        };
        let (fid, sid) = self.publish_snapshot(&room_id, path, file_id, now_ms)?;
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
        let room_secret = load_room_secret(self.store.root(), room_id)?;
        let room_keys = derive_room_keys(&room_secret);

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
            event_key: *room_keys.event_key.as_bytes(),
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
    let canonical = build_canonical_request(method, url_path, body);
    let mut mac =
        <Hmac<Sha256>>::new_from_slice(admission_key).expect("HMAC accepts any key length");
    mac.update(&canonical);
    let tag = mac.finalize().into_bytes();
    format!("v2.{}", URL_SAFE_NO_PAD.encode(tag))
}

/// Build the `Attn-Owner-Signature` header per relay-spec.md §Owner Distinction
/// and §POST /v2/rooms/:roomId. Ed25519 signature over the same canonicalRequest
/// bytes used for `Attn-Admission`. Wire format is just `base64url(sig)` —
/// no version prefix, matching `relay/src/owner-sig.ts`.
fn owner_sig_header_value(
    signing_key: &DeviceSigningKey,
    method: &str,
    url_path: &str,
    body: &[u8],
) -> String {
    let canonical = build_canonical_request(method, url_path, body);
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
    let body_hash = Sha256::digest(body);
    let mut canonical = Vec::with_capacity(
        method.len() + 1 + url_path.len() + 1 /* empty query */ + 1 + body_hash.len(),
    );
    canonical.extend_from_slice(method.to_ascii_uppercase().as_bytes());
    canonical.push(b'\n');
    canonical.extend_from_slice(url_path.as_bytes());
    canonical.push(b'\n');
    canonical.push(b'\n');
    canonical.extend_from_slice(&body_hash);
    canonical
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
/// `data-model.md` §Participant And Device — reviewers and agents share the
/// "write findings" capability set today; agents additionally do *not* get
/// `RoomAdmin` or `AcceptSuggestion` (only the owner accepts on their own
/// behalf). The owner branch is unreachable today (Share owns owner creation)
/// but is kept exhaustive so a future `ParticipantKind` variant doesn't
/// silently fall through.
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
        ParticipantKind::Reviewer | ParticipantKind::Agent => vec![
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
/// (folder-share) → every `*.md` under it (recursively), skipping ignored dirs.
/// Sorted for stable ordering.
fn markdown_targets(path: &std::path::Path) -> Vec<PathBuf> {
    if !path.is_dir() {
        return if is_markdown_path(path) {
            vec![path.to_path_buf()]
        } else {
            Vec::new()
        };
    }
    let mut out: Vec<PathBuf> = Vec::new();
    collect_markdown(path, &mut out);
    out.sort();
    out
}

fn validate_share_targets(path: &std::path::Path) -> Result<Vec<PathBuf>, BootstrapError> {
    let targets = markdown_targets(path);
    if targets.is_empty() {
        return Err(BootstrapError::InvalidShare(format!(
            "{} is not shareable; choose a markdown file or a folder containing .md/.markdown files",
            path.display()
        )));
    }

    for target in &targets {
        let bytes = std::fs::read(target).map_err(|e| {
            BootstrapError::InvalidShare(format!("cannot read {}: {e}", target.display()))
        })?;
        if std::str::from_utf8(&bytes).is_err() {
            return Err(BootstrapError::InvalidShare(format!(
                "{} is not UTF-8 markdown",
                target.display()
            )));
        }
    }

    Ok(targets)
}

fn collect_markdown(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
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
            collect_markdown(&p, out);
        } else if is_markdown_path(&p) {
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
            if is_markdown_path(path) && path_within(&record.path, path) {
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
        fs::write(docs.path().join("notes.txt"), b"x").unwrap();
        fs::create_dir(docs.path().join("node_modules")).unwrap();
        fs::write(docs.path().join("node_modules/c.md"), b"# C").unwrap();
        fs::create_dir(docs.path().join("sub")).unwrap();
        fs::write(docs.path().join("sub/d.md"), b"# D").unwrap();

        // Directory → every *.md (recursive, sorted), skipping notes.txt +
        // node_modules; a single file → just itself.
        assert_eq!(
            markdown_targets(docs.path()),
            vec![
                docs.path().join("a.md"),
                docs.path().join("b.md"),
                docs.path().join("sub").join("d.md"),
            ]
        );
        assert_eq!(
            markdown_targets(&docs.path().join("a.md")),
            vec![docs.path().join("a.md")]
        );
        assert!(
            markdown_targets(&docs.path().join("notes.txt")).is_empty(),
            "single non-markdown files should not create empty review rooms"
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
    fn parse_invite_rejects_missing_prefix() {
        let err = parse_invite("not-an-invite").expect_err("malformed");
        match err {
            BootstrapError::InviteParse(msg) => {
                assert!(msg.contains("missing prefix"), "got: {msg}");
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
            .and(path_regex_for_room_create())
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
            .and(path_regex_for_devices())
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
        assert_eq!(loaded_room.policy.mode, RoomMode::Async);

        // Outbox holds the RoomCreated event plus the first document snapshot.
        let envelopes: Vec<MailboxEnvelope> = store
            .iter_outbox(&outcome.room_id)
            .expect("iter")
            .collect::<anyhow::Result<_>>()
            .expect("decode");
        assert_eq!(envelopes.len(), 2);
        assert!(
            envelopes
                .iter()
                .all(|envelope| envelope.kind == EnvelopeKind::Event)
        );
    }

    #[tokio::test]
    async fn share_emits_invite_with_expected_shape() {
        let server = MockServer::start().await;
        let id_dir = TempDir::new().expect("id tempdir");
        let (_store_tmp, _store, boot) =
            make_bootstrapper(server.uri(), id_dir.path().to_path_buf());

        Mock::given(method("POST"))
            .and(path_regex_for_room_create())
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
            .and(path_regex_for_devices())
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let (_doc_tmp, path) = temp_markdown_file("x.md", "# X\n");
        let outcome = boot
            .share(path, RoomMode::Async, None)
            .await
            .expect("share");
        assert!(outcome.invite.starts_with("attn://review/"));
        assert!(outcome.invite.contains("#key="));
        // The invite must round-trip through `parse_invite`.
        let parsed = parse_invite(&outcome.invite).expect("parse");
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
            .and(path_regex_for_room_create())
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
            .and(path_regex_for_devices())
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
    fn agent_capabilities_match_data_model_spec() {
        // Spec: data-model.md §Participant And Device. Agents get the
        // read/write-finding capabilities but NOT room admin / accept-
        // suggestion (those are owner-only). This is the canonical place
        // the policy is enforced for join_as_agent.
        let caps = agent_capabilities(ParticipantKind::Agent);
        assert!(caps.contains(&Capability::ReadSnapshot));
        assert!(caps.contains(&Capability::WriteComment));
        assert!(caps.contains(&Capability::WriteSuggestion));
        assert!(!caps.contains(&Capability::RoomAdmin));
        assert!(!caps.contains(&Capability::AcceptSuggestion));
        assert!(!caps.contains(&Capability::PublishSnapshot));

        // Reviewer parity — sanity that we didn't accidentally differentiate
        // agents below reviewers; the kind distinction is on the wire
        // (`kind` field), not the capability set.
        let reviewer_caps = agent_capabilities(ParticipantKind::Reviewer);
        assert_eq!(caps, reviewer_caps);
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
            .and(path_regex(r"^/v2/rooms/[A-Za-z0-9_-]{20,32}$"))
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
            .and(path_regex_for_devices())
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
}
