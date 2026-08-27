//! `ReviewManager` runtime scaffold: the daemon-owned service that ties
//! together the review store, working-copy service, and (eventually) the
//! transport + anchor engine layers.
//!
//! Integrates into the *existing* tao event loop in `src/main.rs` by emitting
//! `UserEvent::Review(ReviewUpdate)` through the `EventLoopProxy` — per
//! `planning/collab/amendments.md` §Codebase Corrections, this issue does NOT
//! factor out a new event loop. The proxy is wrapped in an `update_tx`
//! closure so the manager stays decoupled from tao types and is easy to mock
//! in tests.
//!
//! Spec: `planning/collab/data-model.md` §Rust Architecture Changes
//! §Review Manager. This is the **scaffold** (issue attn-nnj.2.8) — every
//! command handler logs and emits a stub `ReviewUpdate`. Real behavior
//! (snapshot creation, transport, anchor resolution, suggestion apply) lands
//! in follow-up issues 3a/3b/3.4/4/5.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::review::bootstrap::{BootstrapConfig, Bootstrapper, JoinOutcome, ShareOutcome};
use crate::review::crypto::signing::DeviceSigningKey;
use crate::review::envelope::{AssembleInput, assemble_event_envelope};
use crate::review::ids::{DeviceId, EventId, FileId, ParticipantId, RoomId, SnapshotId};
use crate::review::model::{
    Anchor, DeviceClient, EnvelopeKind, MailboxEnvelope, PositionAnchor, ResolvedAnchor,
    ReviewEventBody, RoomMode, SuggestionDraft,
};
use crate::review::notifications::{
    NoopNotificationSink, ReviewNotificationSink, ReviewNotifications, summary_for_event,
};
use crate::review::share_lifecycle::{DurableShareLinks, DurableShareService};
use crate::review::store::ReviewStore;
use crate::review::transport::inbound::{AuthorizationCache, GrantTier, VerifyingKeyCache};
use crate::review::transport::selector::{self, RoomTransports, TransportConfig, TransportMode};
use crate::review::transport::signaling::{SignalingPayload, assemble_signal_envelope};
use crate::review::transport::{EnvelopeAck, TransportError};
use crate::review::working_copy::WorkingCopyService;

fn device_supports_webrtc(client: DeviceClient) -> bool {
    matches!(client, DeviceClient::AttnNative | DeviceClient::AttnBrowser)
}

// ---------------------------------------------------------------------------
// Command + Update types
// ---------------------------------------------------------------------------

/// Commands the daemon (or CLI / IPC handlers) submits to the `ReviewManager`.
///
/// Mirrors `planning/collab/data-model.md` §Review Manager `ReviewCommand`.
/// The scaffold logs every variant and emits a stub `ReviewUpdate`; real
/// behavior is filled in by later issues:
///
/// - `Share` / `Join` / `Pull` / `Stop` → transport + room runtime (3a/3b/4)
/// - `Inbox` → cross-room aggregation (3b)
/// - `CreateComment` / `CreateSuggestion` → envelope assembly + outbox (3a)
/// - `AcceptSuggestion` → guarded apply (Phase 5)
/// - `ResolveAnchor` → anchor engine override (3.4)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HtmlResolutionStatus {
    Exact,
    Remapped,
    Ambiguous,
    Stale,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReviewCommand {
    /// Share the current path as a new review room.
    Share {
        path: PathBuf,
        /// Exact files selected by the owner. Empty preserves the legacy
        /// single-file/folder command used by CLI callers.
        selected_paths: Vec<PathBuf>,
        /// Selected document the reviewer should receive first.
        primary_path: Option<PathBuf>,
        mode: String,
        ttl: Option<String>,
    },
    /// Create a stable durable share rooted at `path`.
    CreateDurableShare { path: PathBuf },
    /// Renew one durable share, or every active share when `target` is absent.
    RenewDurableShare { target: Option<String> },
    /// Revoke a durable share by canonical share id or exact owner path.
    RevokeDurableShare { target: String },
    /// Resolve a durable-share deep link. The secret wrapper zeroizes on drop
    /// and redacts Debug output, so command diagnostics cannot leak it.
    OpenDurableShare {
        share_id: String,
        link_secret: crate::review::share_lifecycle::ShareLinkSecret,
    },
    /// Join a remote review room from an `attn://review/...` invite.
    Join { invite: String },
    /// Join a remote review room announcing `kind: "agent"`, signing with
    /// this home's own base identity (see `Bootstrapper::join_self_as_agent`).
    /// Used by the headless `attn review agent` runtime.
    JoinAsAgent { invite: String },
    /// Pull pending envelopes for a room, or for every active room when `None`.
    Pull { room_id: Option<RoomId> },
    /// Stop hosting/participating in a room (all rooms when `None`).
    Stop { room_id: Option<RoomId> },
    /// List inbound review notifications across all rooms.
    Inbox,
    /// Create a comment. With `parent_thread_id = None` this opens a new
    /// thread; with `Some(thread_id)` it joins that thread as a reply
    /// (attn-1rm). A reply reuses the root comment's `anchor`, supplied by the
    /// caller — `reconstructThreads` groups by `threadId`, so a reply is just a
    /// `CommentCreated` carrying the existing thread id.
    CreateComment {
        room_id: RoomId,
        anchor: Anchor,
        body: String,
        parent_thread_id: Option<String>,
    },
    /// Create a new suggestion (replace/insert/delete) from a frontend draft.
    CreateSuggestion {
        room_id: RoomId,
        draft: SuggestionDraft,
    },
    /// Owner accepts a suggestion; triggers the guarded apply flow (Phase 5).
    AcceptSuggestion {
        room_id: RoomId,
        suggestion_id: EventId,
    },
    /// Owner rejects a suggestion; mints a `SuggestionRejected` event so every
    /// participant's log records the decline and the inline ghost text stops
    /// rendering. No apply, no on-disk change.
    RejectSuggestion {
        room_id: RoomId,
        suggestion_id: EventId,
        reason: Option<String>,
    },
    /// Owner manually re-anchors a stale comment/suggestion to a new range.
    ResolveAnchor {
        room_id: RoomId,
        event_id: EventId,
        range: PositionAnchor,
    },
    /// The document frame resolved an HTML anchor against its own DOM and is
    /// reporting the outcome so the rail can show position and confidence.
    ///
    /// Deliberately **local-only**: unlike [`Self::ResolveAnchor`] this mints
    /// no durable event. An HTML anchor resolves against *this* client's
    /// rendered DOM, so the verdict is a local observation rather than a
    /// shared fact — two peers can legitimately disagree, and propagating one
    /// peer's view would overwrite the other's correct one.
    ///
    /// Spec: `html-annotation.md` §5, §7.
    ReportHtmlAnchorResolution {
        room_id: RoomId,
        event_id: EventId,
        status: HtmlResolutionStatus,
        confidence: f64,
        /// Resolved rendered-text offsets. Absent when nothing was found.
        range: Option<PositionAnchor>,
    },
    /// Mark a comment thread resolved. Mints a durable `CommentResolved`
    /// event so the resolution persists and propagates to every peer (a
    /// resolution is a shared fact, not a local view tweak).
    ResolveComment { room_id: RoomId, thread_id: String },
    /// Reopen a resolved comment thread. Mints a durable `CommentReopened`
    /// event; same reasoning as `ResolveComment` — reopening is a shared
    /// fact, so it travels rather than living in one client's view state.
    ReopenComment { room_id: RoomId, thread_id: String },
    /// Owner edited a shared file — republish a fresh snapshot so connected
    /// reviewers see the update. No-op when `path` isn't part of any share.
    PublishSnapshot { path: PathBuf },
    /// Send a live co-typing payload (prosemirror-collab submission or
    /// broadcast) from this webview to the room over the encrypted signal
    /// channel. `payload` is opaque JSON the daemon doesn't parse.
    SendCollab { room_id: RoomId, payload: String },
    /// The local display name changed: re-announce the identity into every
    /// active room so existing comments resolve to the new name everywhere
    /// (the original ParticipantJoined was frozen at share/join time).
    ReannounceIdentity,
    /// Browser visibility report. Unread state may advance only when both
    /// predicates are true; keeping the decision native prevents a hidden or
    /// blurred webview from clearing durable badges optimistically.
    SetViewState {
        room_id: RoomId,
        room_visible: bool,
        window_focused: bool,
    },
    /// Persist the native notification preference for one room.
    SetNotificationMuted { room_id: RoomId, muted: bool },
}

/// Updates the `ReviewManager` emits up to the tao event loop.
///
/// Mirrors `planning/collab/data-model.md` §Review Manager `ReviewUpdate`.
/// Each variant maps to a distinct `window.__attn__.review*` callback on the
/// frontend (see `update_callback_name`):
///
/// - `RoomStatusChanged` → `reviewStatus`
/// - `EventImported` → `reviewEvent`
/// - `SnapshotCreated` → `reviewSnapshot`
/// - `AnchorResolutionChanged` → `reviewAnchorResolution`
/// - `OutboxChanged` → `reviewStatus` (outbox pending count is a status field)
/// - `Error` → `reviewStatus` with `connection: "offline"` and an error payload
///   (frontend chooses how to surface; the scaffold just routes via `reviewStatus`)
///
/// The payload is intentionally serialized as `camelCase` JSON via serde so it
/// round-trips through `evaluate_script` into the TypeScript types in
/// `web/src/lib/types.ts` without an extra translation layer.
// `EventImported` carries a full `ReviewEvent` (~816B). Boxing it would churn
// every match/construct site across the IPC + transport layers for a payload
// that is built once and immediately consumed — not worth the indirection.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewUpdate {
    /// Room connection / mode / peer list changed.
    RoomStatusChanged { room_id: RoomId, status: String },
    /// A Share completed and the owner's invite URL is ready to copy.
    /// Separate from `RoomStatusChanged` so the frontend can keep the
    /// Share dialog open and atomically populate the URL field, fingerprint,
    /// expiry timer, etc. without parsing strings.
    ShareReady {
        room_id: RoomId,
        /// Native deep link retained for desktop and CLI reviewers.
        invite_url: String,
        /// HTTPS invite for the hosted reviewer. The room secret remains in
        /// the URL fragment and is never sent to the static host.
        browser_invite_url: String,
        view_invite_url: String,
        suggest_invite_url: String,
        browser_view_invite_url: String,
        browser_suggest_invite_url: String,
        /// Absolute path the owner shared, so the dialog can recognise its own
        /// room without relying on a frontend-captured intent. Serialised as
        /// `ownerDisplayPath`.
        owner_display_path: String,
        owner_signing_key: String,
        mode: String,
        expires_at: u64,
        newly_created: bool,
    },
    /// A `ReviewEvent` was imported and is now durable in the local store.
    /// Carries the full event so the frontend can append it to the review
    /// store and re-render comment threads / suggestions without a second
    /// round-trip.
    EventImported {
        room_id: RoomId,
        event: crate::review::model::ReviewEvent,
    },
    /// A new `SnapshotNode` was created (owner-side) or imported (reviewer-side).
    SnapshotCreated {
        room_id: RoomId,
        snapshot_id: String,
        file_id: String,
    },
    /// An anchor was (re)resolved against the current replica. The payload
    /// matches the frontend `ReviewAnchorResolutionUpdate` shape exactly so
    /// it deserializes straight into the store via
    /// `window.__attn__.reviewAnchorResolution(...)` (issue attn-nnj.3.8).
    AnchorResolutionChanged {
        room_id: RoomId,
        event_id: EventId,
        file_id: FileId,
        resolved: ResolvedAnchor,
    },
    /// The room's live peer roster changed. `replace=true` means `peers`
    /// is the authoritative full roster (a Hello frame on (re)connect);
    /// `replace=false` is a single join/leave delta the store merges by
    /// `deviceId`. Drives the `PeerStrip` face chips.
    PresenceChanged {
        room_id: RoomId,
        peers: Vec<PeerPresence>,
        replace: bool,
    },
    /// The live transport connection state changed. `mailbox` once the relay
    /// socket subscribes (a Hello frame), `offline` on disconnect. Drives the
    /// `ConnectionBadge`. Values match the frontend `ReviewStatus.connection`
    /// union (`live_direct | mailbox | offline | direct_failed`).
    ConnectionChanged { room_id: RoomId, connection: String },
    /// Effective grant for the local room identity. Join/bootstrap can set
    /// this before any authoring command; absent legacy/owner metadata keeps
    /// the v2-compatible `suggest` default.
    LocalGrantTierChanged {
        room_id: RoomId,
        grant_tier: GrantTier,
    },
    /// Inbound live co-typing traffic for the webview's prosemirror-collab
    /// authority/client. `payload` is the opaque step JSON the sender emitted;
    /// `from` lets the webview drop its own broadcast echoes.
    CollabSignal {
        room_id: RoomId,
        from: String,
        payload: String,
    },
    /// The outbox depth for a room changed (envelopes queued for send).
    OutboxChanged {
        room_id: RoomId,
        pending_count: usize,
    },
    /// Durable per-room unread count derived from fresh verified imports.
    UnreadChanged { room_id: RoomId, unread_count: u32 },
    /// Durable native notification preference for the focused room.
    NotificationMuteChanged { room_id: RoomId, muted: bool },
    /// A command failed; surfaced to the frontend for toast/error UI.
    Error {
        room_id: Option<RoomId>,
        code: String,
        message: String,
    },
}

impl ReviewUpdate {
    /// Name of the `window.__attn__` callback the update should be forwarded
    /// to. The main.rs event-loop arm calls
    /// `evaluate_script("window.__attn__.<name>(<json>)")`.
    ///
    /// `OutboxChanged` and `Error` both ride on `reviewStatus` because that's
    /// the only callback the frontend exposes today for room-scoped state
    /// changes; once the frontend grows a dedicated error/outbox channel
    /// (later phase) we can split them out.
    pub fn callback_name(&self) -> &'static str {
        match self {
            ReviewUpdate::RoomStatusChanged { .. } => "reviewStatus",
            ReviewUpdate::ShareReady { .. } => "reviewShareReady",
            ReviewUpdate::EventImported { .. } => "reviewEvent",
            ReviewUpdate::SnapshotCreated { .. } => "reviewSnapshot",
            ReviewUpdate::AnchorResolutionChanged { .. } => "reviewAnchorResolution",
            ReviewUpdate::PresenceChanged { .. } => "reviewPresence",
            ReviewUpdate::ConnectionChanged { .. } => "reviewConnection",
            ReviewUpdate::LocalGrantTierChanged { .. } => "reviewStatus",
            ReviewUpdate::CollabSignal { .. } => "reviewCollab",
            ReviewUpdate::OutboxChanged { .. } => "reviewStatus",
            ReviewUpdate::UnreadChanged { .. } => "reviewUnread",
            ReviewUpdate::NotificationMuteChanged { .. } => "reviewNotificationMute",
            ReviewUpdate::Error { .. } => "reviewStatus",
        }
    }
}

/// One peer's presence summary, shaped to match the frontend
/// `ReviewStatusPeer` (`web/src/lib/types.ts`) so it deserializes straight
/// into `reviewStore.peers` via `window.__attn__.reviewPresence(...)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerPresence {
    pub participant_id: String,
    pub device_id: String,
    pub display_name: String,
    pub kind: crate::review::model::ParticipantKind,
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_snapshot_id: Option<String>,
}

// ---------------------------------------------------------------------------
// ReviewManager
// ---------------------------------------------------------------------------

/// Type alias for the closure the manager uses to deliver updates back to the
/// event loop. Pulled out so tests can hand in an `mpsc::Sender`-backed
/// closure without dragging in `tao::EventLoopProxy`.
pub type UpdateSink = Arc<dyn Fn(ReviewUpdate) + Send + Sync>;

/// Result of waiting for a fixed set of suggestion verdicts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", content = "report", rename_all = "snake_case")]
pub enum VerdictWaitOutcome {
    Complete(crate::review::store::VerdictsReport),
    TimedOut(crate::review::store::VerdictsReport),
}

/// Daemon-owned runtime service. Owns the durable review store handle and
/// the working-copy writer; exposes a synchronous `submit` entry point that
/// dispatches a `ReviewCommand` and (eventually) drives the room runtime.
///
/// **Scaffold contract** (issue attn-nnj.2.8): every command handler logs
/// the command, emits a sensible no-op `ReviewUpdate` through `update_tx`,
/// and does NOT mutate the store or working copy. Real handler bodies land
/// in follow-up issues — the shape here is what they wire into.
pub struct ReviewManager {
    #[allow(dead_code)]
    store: Arc<ReviewStore>,
    #[allow(dead_code)]
    working_copy: Arc<WorkingCopyService>,
    update_tx: UpdateSink,
    /// Optional bootstrap pipeline (attn-nnj.6.6). When `None`, Share/Join
    /// fall back to the scaffold stub status messages — keeps unit tests
    /// that don't care about networking trivially constructable.
    bootstrap: Option<Arc<Bootstrapper>>,
    durable_shares: Option<Arc<DurableShareService>>,
    /// Tokio runtime used to drive bootstrap calls from the synchronous
    /// `submit` dispatch. Lazy-instantiated alongside `bootstrap`; only
    /// present when the manager was built via `with_bootstrap`.
    runtime: Option<Arc<tokio::runtime::Runtime>>,
    /// Verifying-key cache shared with the inbound pipeline (attn-nnj.6.4)
    /// so Join can populate device keys before the first inbound envelope.
    verifying_keys: Option<VerifyingKeyCache>,
    /// Active transport handles keyed by `RoomId`.
    ///
    /// Populated by `open_room_transports` and read by `send_envelopes` —
    /// the mode-aware selector lives in `transport::selector`. The map is an
    /// async mutex because mode transitions (Live -> Hybrid, Hybrid -> Async)
    /// hold the value briefly while swapping handles.
    ///
    /// One inner `AsyncMutex` per room so distinct rooms can send in parallel
    /// without blocking each other.
    rooms: Arc<AsyncMutex<HashMap<RoomId, Arc<AsyncMutex<RoomTransports>>>>>,

    /// Per-room identity + AEAD key material the manager needs to mint
    /// outbound signal / snapshot / event envelopes for the recovery path
    /// (attn-nnj.7.6 `request_snapshot` + `handle_inbound_request_snapshot`).
    ///
    /// Populated by `register_signal_context` after the bootstrap pipeline
    /// has run (it owns the key derivation + identity bytes). Kept in an
    /// `Arc<RwLock<...>>` because reads dominate writes — every send takes
    /// a read snapshot, registration is a one-shot per (room, device) pair.
    signal_contexts: Arc<tokio::sync::RwLock<HashMap<RoomId, Arc<RoomSignalContext>>>>,

    /// Live WebRTC handle per room (2-party). `send_collab` consults this to put
    /// high-frequency collab steps on the DataChannel instead of the relay when
    /// the channel is the SOLE path to the room — keeping that traffic (the
    /// cost driver at scale) off the relay. Gated on `peers == 1`: with more
    /// peers the relay broadcast still reaches the relay-only peer(s), and
    /// double-sending would double-apply collab steps. Populated + kept current
    /// by the per-room orchestrator in `start_room_runtime`.
    live_webrtc: Arc<std::sync::Mutex<HashMap<RoomId, LiveWebrtc>>>,

    /// Per-room cooperative-shutdown handle. `start_room_runtime` inserts the
    /// outbox/WS `cancel_tx` here keyed by room (instead of leaking it) so it
    /// lives for the room's life — preserving the no-race behavior the WS
    /// `select!` depends on — AND so `Stop` can flip it to wind the outbox +
    /// WS tasks down cooperatively. The presence of a key is the authoritative
    /// "this room has a live runtime" signal `Stop`/`Inbox` read.
    cancels: Arc<std::sync::Mutex<HashMap<RoomId, tokio::sync::watch::Sender<bool>>>>,

    /// Per-room outbox handle. Retained alongside `cancels` so `Pull` can force
    /// a one-shot drain (`OutboxProcessor::process_once`) without re-deriving
    /// the room keys / mailbox config. Dropped on `Stop`.
    outboxes: Arc<
        std::sync::Mutex<HashMap<RoomId, Arc<crate::review::transport::mailbox::OutboxProcessor>>>,
    >,

    /// Runtime authorization metadata for the local participant. This is a
    /// typed seam for v3 Join population; missing entries are legacy/owner
    /// rooms and therefore retain the historical suggest capability.
    local_grant_tiers: Arc<std::sync::Mutex<HashMap<RoomId, GrantTier>>>,

    /// Monotonic signal for freshly imported, durably persisted verdicts.
    /// Waiters subscribe before reading the store, closing the query/park race.
    verdict_revision_tx: tokio::sync::watch::Sender<u64>,
    notifications: Arc<ReviewNotifications>,
}

/// A room's live WebRTC mesh — one DataChannel transport per other participant
/// — plus the current non-self peer count. `send_collab` fans collab steps out
/// over every transport when the mesh is complete (`transports.len() == peers`
/// and all Connected), else falls back to the relay.
struct LiveWebrtc {
    transports: HashMap<
        crate::review::ids::DeviceId,
        Arc<crate::review::transport::webrtc::WebRtcTransport>,
    >,
    peers: usize,
}

/// Identity + key material a room needs to mint outbound signal and
/// snapshot envelopes for the live-recovery path.
///
/// One context per `(room_id, local_device_id)` pair — the manager registers
/// it once when a room is opened and reads it for every
/// `request_snapshot` / `handle_inbound_request_snapshot` call.
///
/// Fields mirror `WebRtcConfig` (which owns the same material on the WebRTC
/// arm), but are stored here separately so the manager can drive the
/// recovery path even when no `WebRtcTransport` is live (e.g. Hybrid mode
/// where the DataChannel is down but the mailbox arm is up).
pub struct RoomSignalContext {
    pub protocol_version: u32,
    pub room_id: RoomId,
    pub author_id: ParticipantId,
    pub local_device_id: DeviceId,
    /// Optional peer to address the signal envelope to. When `None`, the
    /// envelope is broadcast on the relay's signal channel (the spec
    /// allows this for `request_snapshot` so any reachable peer can
    /// respond — see `signaling.rs` module docs).
    pub target_device_id: Option<DeviceId>,
    /// Ed25519 signing key for `kind=event` envelopes the owner mints when
    /// responding to a `request_snapshot`.
    pub signing_key: DeviceSigningKey,
    pub event_key: [u8; 32],
    pub snapshot_key: [u8; 32],
    pub signaling_key: [u8; 32],
}

impl std::fmt::Debug for RoomSignalContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // DeviceSigningKey + the AEAD keys must NOT leak through Debug — pin
        // their absence so a stray `dbg!` in a test does not log secrets.
        f.debug_struct("RoomSignalContext")
            .field("room_id", &self.room_id)
            .field("author_id", &self.author_id)
            .field("local_device_id", &self.local_device_id)
            .field("target_device_id", &self.target_device_id)
            .field("signing_key", &"<redacted>")
            .field("event_key", &"<redacted 32 bytes>")
            .field("snapshot_key", &"<redacted 32 bytes>")
            .field("signaling_key", &"<redacted 32 bytes>")
            .finish()
    }
}

fn verdict_report_for_targets(
    report: &crate::review::store::VerdictsReport,
    targets: &std::collections::BTreeSet<(String, String)>,
) -> crate::review::store::VerdictsReport {
    let mut rooms = std::collections::BTreeMap::new();
    for (room_id, room) in &report.rooms {
        let suggestions = room
            .suggestions
            .iter()
            .filter(|(suggestion_id, _)| {
                targets.contains(&(room_id.clone(), (*suggestion_id).clone()))
            })
            .map(|(suggestion_id, verdict)| (suggestion_id.clone(), verdict.clone()))
            .collect();
        if targets
            .iter()
            .any(|(target_room, _)| target_room == room_id)
        {
            rooms.insert(
                room_id.clone(),
                crate::review::store::RoomVerdicts { suggestions },
            );
        }
    }
    crate::review::store::VerdictsReport { rooms }
}

impl ReviewManager {
    /// Record the verified local grant supplied by room bootstrap metadata.
    /// `None` removes v3 metadata and restores the v2/owner suggest default.
    pub fn set_local_grant_tier(&self, room_id: RoomId, tier: Option<GrantTier>) {
        let effective = tier.unwrap_or(GrantTier::Suggest);
        let mut tiers = self
            .local_grant_tiers
            .lock()
            .expect("local grant tier mutex poisoned");
        if let Some(tier) = tier {
            tiers.insert(room_id.clone(), tier);
        } else {
            tiers.remove(&room_id);
        }
        drop(tiers);
        (self.update_tx)(ReviewUpdate::LocalGrantTierChanged {
            room_id,
            grant_tier: effective,
        });
    }

    fn local_grant_tier(&self, room_id: &RoomId) -> GrantTier {
        self.local_grant_tiers
            .lock()
            .expect("local grant tier mutex poisoned")
            .get(room_id)
            .copied()
            .unwrap_or(GrantTier::Suggest)
    }

    /// Submit one suggestion synchronously and durably mirror its authored
    /// event into the local event log before acknowledging the caller.
    ///
    /// The local append is what makes an immediate `verdicts --wait` capture
    /// this suggestion as pending without racing its relay round-trip.
    pub fn submit_suggestion_sync(
        &self,
        room_id: RoomId,
        draft: SuggestionDraft,
    ) -> anyhow::Result<String> {
        if self.local_grant_tier(&room_id) == GrantTier::Comment {
            anyhow::bail!("comment-only grant cannot create suggestions");
        }
        let bootstrapper = self
            .bootstrap
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("review bootstrapper unavailable"))?;
        let suggestion_id = mint_thread_id();
        let event_body = ReviewEventBody::SuggestionCreated {
            suggestion_id: suggestion_id.clone(),
            anchor: draft.anchor,
            operation: draft.operation,
            note: draft.note,
        };
        let outcome = bootstrapper
            .send_event_sync(&room_id, event_body, unix_now_ms_for_manager())
            .map_err(|err| anyhow::anyhow!(err.to_string()))?;
        self.store
            .append_event(&room_id, &outcome.event)
            .map_err(|err| anyhow::anyhow!("persist locally-authored suggestion: {err:#}"))?;
        self.fan_envelope_over_mesh(&room_id, &outcome.envelope);
        (self.update_tx)(ReviewUpdate::EventImported {
            room_id,
            event: outcome.event,
        });
        Ok(suggestion_id)
    }

    /// Query current suggestion verdicts across every persisted room.
    ///
    /// `creator = Some(..)` limits the report to suggestions authored by that
    /// participant. `None` is the explicit `--all` view. This is synchronous
    /// because it only folds local append-only JSONL logs.
    pub fn verdicts(
        &self,
        creator: Option<&ParticipantId>,
    ) -> anyhow::Result<crate::review::store::VerdictsReport> {
        let mut rooms = std::collections::BTreeMap::new();
        for room_id in self.store.list_rooms()? {
            rooms.insert(
                room_id.as_str().to_string(),
                self.store.verdicts_for_room(&room_id, creator)?,
            );
        }
        Ok(crate::review::store::VerdictsReport { rooms })
    }

    /// Wait until a fixed suggestion set has accepted/rejected verdicts.
    ///
    /// With `suggestion_ids = None`, the target is every currently pending
    /// suggestion visible through `creator`. Explicit ids override that
    /// default and may name already-complete suggestions. The returned report
    /// contains only the captured targets. No polling is used: after draining
    /// persisted state, this parks on the imported-verdict revision stream.
    pub async fn wait_for_verdicts(
        &self,
        creator: Option<&ParticipantId>,
        suggestion_ids: Option<&std::collections::BTreeSet<String>>,
        timeout: Option<std::time::Duration>,
    ) -> anyhow::Result<VerdictWaitOutcome> {
        use crate::review::store::SuggestionVerdictStatus;

        // Subscribe first. A verdict imported between this subscription and
        // the first store fold leaves `changed()` ready instead of being lost.
        let mut revisions = self.verdict_revision_tx.subscribe();
        let initial = self.verdicts(creator)?;
        let mut targets = std::collections::BTreeSet::<(String, String)>::new();

        for (room_id, room) in &initial.rooms {
            for (suggestion_id, verdict) in &room.suggestions {
                let selected = suggestion_ids
                    .map_or(verdict.status == SuggestionVerdictStatus::Pending, |ids| {
                        ids.contains(suggestion_id)
                    });
                if selected {
                    targets.insert((room_id.clone(), suggestion_id.clone()));
                }
            }
        }

        if let Some(ids) = suggestion_ids {
            let found = targets
                .iter()
                .map(|(_, suggestion_id)| suggestion_id.clone())
                .collect::<std::collections::BTreeSet<_>>();
            let missing = ids.difference(&found).cloned().collect::<Vec<_>>();
            if !missing.is_empty() {
                anyhow::bail!("unknown suggestion id(s): {}", missing.join(","));
            }
        }

        let deadline = timeout.map(|duration| tokio::time::Instant::now() + duration);
        let mut current = initial;
        loop {
            let partial = verdict_report_for_targets(&current, &targets);
            let complete = partial.rooms.values().all(|room| {
                room.suggestions
                    .values()
                    .all(|verdict| verdict.status != SuggestionVerdictStatus::Pending)
            });
            if complete {
                return Ok(VerdictWaitOutcome::Complete(partial));
            }

            let changed = match deadline {
                Some(deadline) => tokio::time::timeout_at(deadline, revisions.changed()).await,
                None => Ok(revisions.changed().await),
            };
            match changed {
                Ok(Ok(())) => current = self.verdicts(creator)?,
                Ok(Err(_)) => anyhow::bail!("verdict notification stream closed"),
                Err(_) => {
                    // Drain durable state once more at the deadline so a
                    // verdict persisted concurrently with timeout wins.
                    current = self.verdicts(creator)?;
                    let partial = verdict_report_for_targets(&current, &targets);
                    let complete = partial.rooms.values().all(|room| {
                        room.suggestions
                            .values()
                            .all(|verdict| verdict.status != SuggestionVerdictStatus::Pending)
                    });
                    return Ok(if complete {
                        VerdictWaitOutcome::Complete(partial)
                    } else {
                        VerdictWaitOutcome::TimedOut(partial)
                    });
                }
            }
        }
    }

    /// Construct a new manager. The `update_tx` closure is invoked from
    /// `submit` (synchronously today; future async work may spawn). It's
    /// expected to forward into the tao event loop via
    /// `EventLoopProxy::send_event(UserEvent::Review(_))`.
    pub fn new(
        store: Arc<ReviewStore>,
        working_copy: Arc<WorkingCopyService>,
        update_tx: UpdateSink,
    ) -> Self {
        let (verdict_revision_tx, _) = tokio::sync::watch::channel(0);
        let notifications = ReviewNotifications::new(
            Arc::clone(&store),
            Arc::new(NoopNotificationSink),
            std::time::Duration::from_secs(5),
        );
        Self {
            store,
            working_copy,
            update_tx,
            bootstrap: None,
            durable_shares: None,
            runtime: None,
            verifying_keys: None,
            rooms: Arc::new(AsyncMutex::new(HashMap::new())),
            signal_contexts: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            live_webrtc: Arc::new(std::sync::Mutex::new(HashMap::new())),
            cancels: Arc::new(std::sync::Mutex::new(HashMap::new())),
            outboxes: Arc::new(std::sync::Mutex::new(HashMap::new())),
            local_grant_tiers: Arc::new(std::sync::Mutex::new(HashMap::new())),
            verdict_revision_tx,
            notifications,
        }
    }

    /// Replace the no-op platform seam used by tests/CLI with the native OS
    /// notification sink used by the desktop daemon.
    pub fn with_notification_sink(mut self, sink: Arc<dyn ReviewNotificationSink>) -> Self {
        self.notifications = ReviewNotifications::new(
            Arc::clone(&self.store),
            sink,
            std::time::Duration::from_secs(5),
        );
        self
    }

    /// Attach the Share/Join bootstrap pipeline (attn-nnj.6.6).
    ///
    /// `relay_url` is the base URL of the Cloudflare relay (no trailing
    /// slash). The optional `identity_dir` overrides
    /// `daemon::runtime_dir()` for tests; production code passes `None`.
    /// `verifying_keys` is the cache the inbound pipeline reads from —
    /// Join populates it from `GET /v2/rooms/:roomId/devices` so the
    /// pipeline can verify the first envelope it receives.
    pub fn with_bootstrap(
        mut self,
        relay_url: String,
        identity_dir: Option<std::path::PathBuf>,
        verifying_keys: VerifyingKeyCache,
    ) -> anyhow::Result<Self> {
        let cfg = Arc::new(BootstrapConfig {
            relay_url,
            identity_dir,
        });
        let bootstrapper = Bootstrapper::new(Arc::clone(&self.store), cfg)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("attn-review-bootstrap")
            .build()?;
        let bootstrapper = Arc::new(bootstrapper);
        let share_store = Arc::new(
            match &bootstrapper.config().identity_dir {
                Some(directory) => crate::review::share_lifecycle::DurableShareStore::open_at(
                    directory.join("shares"),
                ),
                None => crate::review::share_lifecycle::DurableShareStore::open(),
            }
            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        );
        let identity = crate::review::bootstrap::load_or_create_identity_in(
            &bootstrapper
                .config()
                .identity_dir()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        )
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let share_relay = Arc::new(
            crate::review::share_lifecycle::HttpShareRelayClient::new(
                bootstrapper.config().relay_url.clone(),
                &identity,
            )
            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        );
        self.durable_shares = Some(Arc::new(
            DurableShareService::new(
                share_store,
                Arc::clone(&self.store),
                share_relay,
                Arc::clone(&bootstrapper),
            )
            .with_notification_observer(Arc::clone(&self.notifications)),
        ));
        self.bootstrap = Some(bootstrapper);
        self.runtime = Some(Arc::new(runtime));
        self.verifying_keys = Some(verifying_keys);
        Ok(self)
    }

    /// Test-only constructor that injects a pre-built `Bootstrapper` + runtime
    /// (used by the wiremock-backed tests).
    #[cfg(test)]
    pub fn with_bootstrap_components(
        mut self,
        bootstrapper: Arc<Bootstrapper>,
        runtime: Arc<tokio::runtime::Runtime>,
        verifying_keys: VerifyingKeyCache,
    ) -> Self {
        self.bootstrap = Some(bootstrapper);
        self.runtime = Some(runtime);
        self.verifying_keys = Some(verifying_keys);
        self
    }

    /// Synchronous command dispatch.
    ///
    /// `Share`/`Join` block on the bootstrap pipeline when one is attached;
    /// every other variant emits the scaffold stub update. The blocking is
    /// intentional today — the IPC layer already runs `submit` on a worker
    /// thread, and the bootstrap calls (room create + device register + one
    /// GET) complete in well under a second against a healthy relay.
    pub fn submit(&self, cmd: ReviewCommand) {
        // Log only the command NAME — never the `{:?}` body, which would spill
        // comment/suggestion plaintext + collab steps to stderr.
        tracing::info!("received command {}", review_command_name(&cmd));

        if let ReviewCommand::CreateSuggestion { room_id, .. } = &cmd
            && self.local_grant_tier(room_id) == GrantTier::Comment
        {
            (self.update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: "ATTN_GRANT_FORBIDDEN".into(),
                message: "comment-only grant cannot create suggestions".into(),
            });
            return;
        }

        // Bootstrap pipeline owns Share + Join when wired in. Everything else
        // still goes through `stub_update_for` (filled in by follow-up issues).
        match (&cmd, self.bootstrap.as_ref(), self.runtime.as_ref()) {
            (
                ReviewCommand::OpenDurableShare {
                    share_id,
                    link_secret,
                },
                Some(_),
                Some(_),
            ) => {
                if let Err(error) = self.open_durable_share(share_id, link_secret) {
                    (self.update_tx)(ReviewUpdate::Error {
                        room_id: None,
                        code: "ATTN_DURABLE_SHARE_OPEN".into(),
                        message: error.to_string(),
                    });
                }
                return;
            }
            (ReviewCommand::CreateDurableShare { path }, _, Some(runtime)) => {
                let result = self
                    .durable_shares
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("durable share service unavailable"))
                    .and_then(|service| {
                        runtime
                            .block_on(service.create(path))
                            .map_err(|error| anyhow::anyhow!(error.to_string()))
                    });
                let result = result.and_then(|link| {
                    self.start_room_runtime(&link.room_id)?;
                    Ok(link)
                });
                self.emit_durable_share_result(result, true);
                return;
            }
            (ReviewCommand::RenewDurableShare { target }, _, Some(runtime)) => {
                let result = self
                    .durable_shares
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("durable share service unavailable"))
                    .and_then(|service| {
                        runtime
                            .block_on(service.renew(target.as_deref()))
                            .map_err(|error| anyhow::anyhow!(error.to_string()))
                    });
                match result {
                    Ok(links) => {
                        for link in links {
                            match self.start_room_runtime(&link.room_id) {
                                Ok(()) => {
                                    let room_id = link.room_id.clone();
                                    self.emit_durable_share_ready(link, false);
                                    // Durable renew drains authenticated offline
                                    // mailbox events directly into events.jsonl,
                                    // bypassing the live transport forwarder.
                                    // Reconcile unread + replay now so the
                                    // resident process surfaces them without a
                                    // restart; frontend eventId dedup keeps
                                    // already-rendered events idempotent.
                                    self.replay_room_to_webview(&room_id);
                                }
                                Err(error) => (self.update_tx)(ReviewUpdate::Error {
                                    room_id: Some(link.room_id.clone()),
                                    code: "ATTN_DURABLE_SHARE".into(),
                                    message: error.to_string(),
                                }),
                            }
                        }
                    }
                    Err(error) => (self.update_tx)(ReviewUpdate::Error {
                        room_id: None,
                        code: "ATTN_DURABLE_SHARE".into(),
                        message: error.to_string(),
                    }),
                }
                return;
            }
            (ReviewCommand::RevokeDurableShare { target }, _, Some(runtime)) => {
                let result = self
                    .durable_shares
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("durable share service unavailable"))
                    .and_then(|service| {
                        runtime
                            .block_on(service.revoke(target))
                            .map_err(|error| anyhow::anyhow!(error.to_string()))
                    });
                match result {
                    Ok(()) => (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                        room_id: stub_room_id(),
                        status: format!("Durable share revoked: {target}"),
                    }),
                    Err(error) => (self.update_tx)(ReviewUpdate::Error {
                        room_id: None,
                        code: "ATTN_DURABLE_SHARE".into(),
                        message: error.to_string(),
                    }),
                }
                return;
            }
            (
                ReviewCommand::Share {
                    path,
                    selected_paths,
                    primary_path,
                    mode,
                    ttl,
                },
                Some(bootstrapper),
                Some(runtime),
            ) => {
                let mode = mode_from_str(mode);
                let result = runtime.block_on(bootstrapper.share_selected(
                    path.clone(),
                    selected_paths.clone(),
                    primary_path.clone(),
                    mode,
                    ttl.clone(),
                ));
                self.emit_share_outcome(result);
                return;
            }
            (ReviewCommand::Join { invite }, Some(bootstrapper), Some(runtime)) => {
                let cache = self.verifying_keys.clone();
                let result = runtime.block_on(bootstrapper.join(invite, cache));
                self.emit_join_outcome(result);
                return;
            }
            (ReviewCommand::JoinAsAgent { invite }, Some(bootstrapper), Some(runtime)) => {
                let cache = self.verifying_keys.clone();
                let result = runtime.block_on(bootstrapper.join_self_as_agent(invite, cache));
                self.emit_join_outcome(result);
                return;
            }
            (
                ReviewCommand::CreateComment {
                    room_id,
                    anchor,
                    body,
                    parent_thread_id,
                },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                // An HTML anchor is authored inside a document frame that shares
                // a JS context with untrusted page scripts, so it is bounded here
                // before it can be persisted or synced to peers. Rust cannot
                // check that the selectors address anything — that needs a DOM —
                // but it can refuse a malformed or oversized payload.
                // @see planning/collab/html-annotation.md §3
                if let Some(html) = anchor.html.as_ref()
                    && let Err(err) = html.validate()
                {
                    self.emit_event_outcome(
                        room_id.clone(),
                        Err(crate::review::bootstrap::BootstrapError::Crypto(format!(
                            "invalid html anchor: {err}"
                        ))),
                    );
                    return;
                }
                // A reply reuses the parent's thread id; a new comment mints one.
                let thread_id = parent_thread_id.clone().unwrap_or_else(mint_thread_id);
                let event_body = crate::review::model::ReviewEventBody::CommentCreated {
                    thread_id,
                    anchor: anchor.clone(),
                    body: body.clone(),
                };
                let result =
                    bootstrapper.send_event_sync(room_id, event_body, unix_now_ms_for_manager());
                self.emit_event_outcome(room_id.clone(), result);
                return;
            }
            (
                ReviewCommand::CreateSuggestion { room_id, draft },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                // Suggestions on HTML documents are a v1 non-goal
                // (html-annotation.md §8): the apply pipeline cannot resolve
                // an HTML anchor against source bytes, so an html-anchored
                // suggestion would sync to every peer and then fail at accept
                // time forever. Refuse it at the same trust boundary where
                // CreateComment bounds its anchor — IPC input is
                // attacker-adjacent.
                if draft.anchor.html.is_some() {
                    self.emit_event_outcome(
                        room_id.clone(),
                        Err(crate::review::bootstrap::BootstrapError::Crypto(
                            "suggestions on HTML documents are not supported".to_string(),
                        )),
                    );
                    return;
                }
                let suggestion_id = mint_thread_id();
                let event_body = crate::review::model::ReviewEventBody::SuggestionCreated {
                    suggestion_id,
                    anchor: draft.anchor.clone(),
                    operation: draft.operation.clone(),
                    note: draft.note.clone(),
                };
                let result =
                    bootstrapper.send_event_sync(room_id, event_body, unix_now_ms_for_manager());
                self.emit_event_outcome(room_id.clone(), result);
                return;
            }
            (
                ReviewCommand::AcceptSuggestion {
                    room_id,
                    suggestion_id,
                },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                self.accept_suggestion(bootstrapper, room_id, suggestion_id);
                return;
            }
            (
                ReviewCommand::RejectSuggestion {
                    room_id,
                    suggestion_id,
                    reason,
                },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                self.reject_suggestion(bootstrapper, room_id, suggestion_id, reason.clone());
                return;
            }
            (
                ReviewCommand::ResolveAnchor {
                    room_id,
                    event_id,
                    range,
                },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                self.resolve_anchor(bootstrapper, room_id, event_id, range);
                return;
            }
            (
                ReviewCommand::ReportHtmlAnchorResolution {
                    room_id,
                    event_id,
                    status,
                    confidence,
                    range,
                },
                Some(_bootstrapper),
                Some(_runtime),
            ) => {
                self.report_html_anchor_resolution(
                    room_id,
                    event_id,
                    *status,
                    *confidence,
                    range.as_ref(),
                );
                return;
            }
            (
                ReviewCommand::ResolveComment { room_id, thread_id },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                self.resolve_comment(bootstrapper, room_id, thread_id);
                return;
            }
            (
                ReviewCommand::ReopenComment { room_id, thread_id },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                self.reopen_comment(bootstrapper, room_id, thread_id);
                return;
            }
            (
                ReviewCommand::SendCollab { room_id, payload },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                self.send_collab(bootstrapper, room_id, payload);
                return;
            }
            (ReviewCommand::PublishSnapshot { path }, Some(bootstrapper), Some(runtime)) => {
                match runtime.block_on(
                    bootstrapper.republish_snapshot_for_path(path, unix_now_ms_for_manager()),
                ) {
                    Ok(Some((room_id, _file_id, snapshot_id))) => {
                        tracing::info!(
                            "republished snapshot {} for {} (room={})",
                            snapshot_id.as_str(),
                            path.display(),
                            room_id.as_str()
                        );
                    }
                    Ok(None) => { /* path isn't shared — nothing to do */ }
                    Err(err) => {
                        (self.update_tx)(ReviewUpdate::Error {
                            room_id: None,
                            code: "ATTN_SNAPSHOT_PUBLISH".to_string(),
                            message: format!("republish snapshot for {}: {err}", path.display()),
                        });
                    }
                }
                return;
            }
            // Stop / Pull / Inbox operate on the per-room runtime registries,
            // not the bootstrap pipeline, so they match regardless of whether
            // a Bootstrapper is attached (they no-op cleanly with no rooms).
            (ReviewCommand::Stop { room_id }, _, _) => {
                self.stop_rooms(room_id.clone());
                return;
            }
            (ReviewCommand::ReannounceIdentity, Some(bootstrapper), Some(runtime)) => {
                // Display name changed: refresh the ParticipantJoined
                // announce in every active room so existing comments resolve
                // to the new name on all windows (frontends key names by
                // participantId; last write wins). The onboarding NamePrompt
                // fires AFTER a room is entered, so without this a name typed
                // there never reached the already-joined room. Drain each
                // room's outbox immediately so the rename lands without
                // waiting for the next scheduled pass; a failed drain is fine
                // (the envelope is durably queued).
                let rooms: Vec<(
                    RoomId,
                    Arc<crate::review::transport::mailbox::OutboxProcessor>,
                )> = self
                    .outboxes
                    .lock()
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), Arc::clone(v))).collect())
                    .unwrap_or_default();
                for (room_id, outbox) in rooms {
                    let kind = match crate::review::bootstrap::find_path_for_room(
                        self.store.root(),
                        &room_id,
                    ) {
                        Ok(Some(_)) => crate::review::model::ParticipantKind::Owner,
                        _ => crate::review::model::ParticipantKind::Reviewer,
                    };
                    if let Err(e) = bootstrapper.reannounce_identity(&room_id, kind) {
                        tracing::warn!("reannounce into room {} failed: {e}", room_id.as_str());
                        continue;
                    }
                    let _ = runtime.block_on(outbox.process_once());
                }
                return;
            }
            (ReviewCommand::Pull { room_id }, _, _) => {
                self.pull_rooms(room_id.clone());
                return;
            }
            (ReviewCommand::Inbox, _, _) => {
                self.emit_inbox();
                return;
            }
            (
                ReviewCommand::SetViewState {
                    room_id,
                    room_visible,
                    window_focused,
                },
                _,
                _,
            ) => {
                self.notifications
                    .set_view_state(room_id.clone(), *room_visible, *window_focused);
                if *room_visible && *window_focused {
                    match self.store.clear_unread(room_id) {
                        Ok(state) => (self.update_tx)(ReviewUpdate::UnreadChanged {
                            room_id: room_id.clone(),
                            unread_count: state.unread_count,
                        }),
                        Err(error) => tracing::warn!(
                            "could not persist read cursor for room {}: {error:#}",
                            room_id.as_str()
                        ),
                    }
                }
                return;
            }
            (ReviewCommand::SetNotificationMuted { room_id, muted }, _, _) => {
                match self.store.set_notification_muted(room_id, *muted) {
                    Ok(()) => (self.update_tx)(ReviewUpdate::NotificationMuteChanged {
                        room_id: room_id.clone(),
                        muted: *muted,
                    }),
                    Err(error) => (self.update_tx)(ReviewUpdate::Error {
                        room_id: Some(room_id.clone()),
                        code: "ATTN_NOTIFICATION_PREFERENCE_FAILED".into(),
                        message: format!("could not save notification preference: {error:#}"),
                    }),
                }
                return;
            }
            _ => {}
        }

        let update = stub_update_for(&cmd);
        (self.update_tx)(update);
    }

    fn emit_durable_share_result(
        &self,
        result: anyhow::Result<DurableShareLinks>,
        newly_created: bool,
    ) {
        match result {
            Ok(links) => self.emit_durable_share_ready(links, newly_created),
            Err(error) => (self.update_tx)(ReviewUpdate::Error {
                room_id: None,
                code: "ATTN_DURABLE_SHARE".into(),
                message: error.to_string(),
            }),
        }
    }

    fn emit_durable_share_ready(&self, links: DurableShareLinks, newly_created: bool) {
        (self.update_tx)(ReviewUpdate::ShareReady {
            room_id: links.room_id.clone(),
            invite_url: links.comment_native.clone(),
            browser_invite_url: links.comment_browser.clone(),
            view_invite_url: links.view_native.clone(),
            suggest_invite_url: links.suggest_native.clone(),
            browser_view_invite_url: links.view_browser.clone(),
            browser_suggest_invite_url: links.suggest_browser.clone(),
            owner_display_path: links.owner_display_path.clone(),
            owner_signing_key: links.owner_signing_key.clone(),
            mode: "hybrid".into(),
            expires_at: links.expires_at,
            newly_created,
        });
    }

    pub fn reconcile_durable_shares(&self) -> anyhow::Result<Vec<DurableShareLinks>> {
        let service = self
            .durable_shares
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("durable share service unavailable"))?;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("review runtime unavailable"))?;
        runtime
            .block_on(service.renew(None))
            .map_err(|error| anyhow::anyhow!(error.to_string()))
    }

    /// Synchronous daemon/socket boundary for owner durable-share commands.
    /// The caller receives the actual relay/persistence result; UI command
    /// dispatch may additionally emit the returned links as updates.
    pub fn run_durable_command(
        &self,
        command: &ReviewCommand,
    ) -> anyhow::Result<Vec<DurableShareLinks>> {
        let service = self
            .durable_shares
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("durable share service unavailable"))?;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("review runtime unavailable"))?;
        let links = match command {
            ReviewCommand::CreateDurableShare { path } => runtime
                .block_on(service.create(path))
                .map(|link| vec![link])
                .map_err(|error| anyhow::anyhow!(error.to_string())),
            ReviewCommand::RenewDurableShare { target } => runtime
                .block_on(service.renew(target.as_deref()))
                .map_err(|error| anyhow::anyhow!(error.to_string())),
            ReviewCommand::RevokeDurableShare { target } => runtime
                .block_on(service.revoke(target))
                .map(|()| vec![])
                .map_err(|error| anyhow::anyhow!(error.to_string())),
            _ => anyhow::bail!("not a durable-share owner command"),
        }?;
        for link in &links {
            self.start_room_runtime(&link.room_id)?;
        }
        Ok(links)
    }

    /// Resolve a stable public link and hand its exact tier-scoped v3 room
    /// invite to the existing native Join pipeline.
    pub fn open_durable_share(
        &self,
        share_id: &str,
        link_secret: &crate::review::share_lifecycle::ShareLinkSecret,
    ) -> anyhow::Result<()> {
        let bootstrap = self
            .bootstrap
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("review bootstrap unavailable"))?;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("review runtime unavailable"))?;
        let invite = runtime
            .block_on(
                crate::review::share_lifecycle::resolve_public_share_to_room_invite(
                    &bootstrap.config().relay_url,
                    share_id,
                    link_secret,
                ),
            )
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        self.submit(ReviewCommand::Join { invite });
        Ok(())
    }

    pub fn emit_durable_command_result(
        &self,
        command: &ReviewCommand,
        links: &[DurableShareLinks],
    ) {
        match command {
            ReviewCommand::CreateDurableShare { .. } => {
                for link in links.iter().cloned() {
                    self.emit_durable_share_ready(link, true);
                }
            }
            ReviewCommand::RenewDurableShare { .. } => {
                for link in links.iter().cloned() {
                    let room_id = link.room_id.clone();
                    self.emit_durable_share_ready(link, false);
                    self.replay_room_to_webview(&room_id);
                }
            }
            ReviewCommand::RevokeDurableShare { target } => {
                (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                    room_id: stub_room_id(),
                    status: format!("Durable share revoked: {target}"),
                })
            }
            _ => {}
        }
    }

    /// Stop hosting/participating in `target` (every active room when `None`).
    ///
    /// For each affected room: flip the room's cancel signal (winding the
    /// outbox + WS tasks down cooperatively) then drop its entries from every
    /// registry. Dropping the `live_webrtc` entry drops the DataChannel
    /// transports + the `webrtc_sig_tx`/`webrtc_events_tx` senders they hold,
    /// which closes the signaling-forwarder + orchestrator channels and ends
    /// those loops. Dropping the outbox handle releases it once the run loop
    /// observes the cancel and returns.
    ///
    /// Idempotent: stopping an unknown room is a clean no-op `RoomStatusChanged`
    /// update, never an error. We rely entirely on cooperative shutdown — no
    /// `JoinHandle::abort` — so in-flight POSTs/imports finish before exit.
    fn stop_rooms(&self, target: Option<RoomId>) {
        // Determine which rooms to stop. `cancels` is the authoritative set of
        // rooms with a live runtime (only `start_room_runtime` populates it).
        let to_stop: Vec<RoomId> = match &target {
            Some(room_id) => vec![room_id.clone()],
            None => self
                .cancels
                .lock()
                .map(|map| map.keys().cloned().collect())
                .unwrap_or_default(),
        };

        for room_id in to_stop {
            // Signal cancel BEFORE dropping the sender so the receivers observe
            // `true` (a dropped sender resolves `changed()` as Err, which the
            // WS loop also treats as shutdown — but an explicit `true` is the
            // clean path and lets the outbox loop's `*cancel.borrow()` exit).
            if let Ok(mut cancels) = self.cancels.lock()
                && let Some(cancel_tx) = cancels.remove(&room_id)
            {
                let _ = cancel_tx.send(true);
            }
            // Drop the retained outbox handle; the run loop holds its own Arc
            // and releases it after observing the cancel.
            if let Ok(mut outboxes) = self.outboxes.lock() {
                outboxes.remove(&room_id);
            }
            // Drop the live WebRTC mesh: closes the forwarder + orchestrator
            // channels (their senders live in this entry / its transports).
            if let Ok(mut live) = self.live_webrtc.lock() {
                live.remove(&room_id);
            }
            // The async selector map + signal-context map need the runtime to
            // take their async locks. Fall back to a blocking lock when no
            // runtime is attached (e.g. unit tests) so cleanup is unconditional.
            self.with_async_block(|| {
                let rooms = Arc::clone(&self.rooms);
                let signal_contexts = Arc::clone(&self.signal_contexts);
                let room_id = room_id.clone();
                async move {
                    rooms.lock().await.remove(&room_id);
                    signal_contexts.write().await.remove(&room_id);
                }
            });

            if let Err(err) = self.store.delete_room(&room_id) {
                tracing::warn!("delete room state failed for {}: {err}", room_id.as_str());
            }

            tracing::info!("stopped room runtime room={}", room_id.as_str());
            (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                room_id,
                status: "Stopped".to_string(),
            });
        }
    }

    /// Force a one-shot outbox drain for `target` (every active room when
    /// `None`) so pending outbound envelopes flush immediately instead of
    /// waiting on the outbox poll tick. The live WS already handles inbound,
    /// so Pull is purely an outbound-flush nudge.
    ///
    /// A room with no live runtime (no retained outbox) is a no-op
    /// `RoomStatusChanged` update, not an error. Drain errors surface as a
    /// `ReviewUpdate::Error` so the UI can show why the flush stalled.
    fn pull_rooms(&self, target: Option<RoomId>) {
        let runtime = match self.runtime.as_ref() {
            Some(rt) => Arc::clone(rt),
            None => {
                // No runtime → no live outbox to drive. Emit a no-op status so
                // the caller still gets a response.
                (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                    room_id: target.unwrap_or_else(stub_room_id),
                    status: "Pulled (no active runtime)".to_string(),
                });
                return;
            }
        };

        // Snapshot the (room, outbox) pairs to drain. Cloning the Arcs lets us
        // drop the lock before the (potentially slow) network drain.
        let targets: Vec<(
            RoomId,
            Arc<crate::review::transport::mailbox::OutboxProcessor>,
        )> = match self.outboxes.lock() {
            Ok(map) => match &target {
                Some(room_id) => map
                    .get(room_id)
                    .map(|ob| vec![(room_id.clone(), Arc::clone(ob))])
                    .unwrap_or_default(),
                None => map
                    .iter()
                    .map(|(rid, ob)| (rid.clone(), Arc::clone(ob)))
                    .collect(),
            },
            Err(_) => Vec::new(),
        };

        if targets.is_empty() {
            (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                room_id: target.unwrap_or_else(stub_room_id),
                status: "Pulled (no active runtime)".to_string(),
            });
            return;
        }

        for (room_id, outbox) in targets {
            match runtime.block_on(outbox.process_once()) {
                Ok(acks) => {
                    tracing::info!(
                        "pull drained {} envelope(s) for room={}",
                        acks.len(),
                        room_id.as_str()
                    );
                    (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                        room_id,
                        status: format!("Pulled ({} sent)", acks.len()),
                    });
                }
                Err(err) => {
                    (self.update_tx)(ReviewUpdate::Error {
                        room_id: Some(room_id),
                        code: "ATTN_PULL_DRAIN".to_string(),
                        message: err.to_string(),
                    });
                }
            }
        }
    }

    /// List the rooms with a live runtime and emit one `RoomStatusChanged`
    /// summarizing them. There is no dedicated inbox/aggregation variant on
    /// `ReviewUpdate` yet, so we reuse `RoomStatusChanged` (the room-scoped
    /// status channel) with a synthetic room id carrying the active count.
    fn emit_inbox(&self) {
        // `cancels` is the authoritative set of rooms with a live runtime.
        let active: Vec<RoomId> = self
            .cancels
            .lock()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default();

        let summary = if active.is_empty() {
            "Inbox: no active rooms".to_string()
        } else {
            let ids = active
                .iter()
                .map(|r| r.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            format!("Inbox: {} active room(s): {}", active.len(), ids)
        };
        tracing::info!("{summary}");
        (self.update_tx)(ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: summary,
        });
    }

    /// Run an async cleanup closure to completion from synchronous `submit`.
    /// Uses the manager's runtime when one is attached; otherwise spins up a
    /// throwaway current-thread runtime so registry cleanup (the async selector
    /// + signal-context maps) is unconditional even in runtime-less unit tests.
    fn with_async_block<F, Fut>(&self, f: F)
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        match self.runtime.as_ref() {
            Some(rt) => rt.block_on(f()),
            None => {
                match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt.block_on(f()),
                    Err(err) => {
                        tracing::error!("transient runtime build failed: {err}");
                    }
                }
            }
        }
    }

    /// Push a freshly minted `SendEventOutcome` to the frontend as an
    /// `EventImported` callback so the local store renders the comment /
    /// suggestion immediately, plus an `OutboxChanged` count update.
    fn emit_event_outcome(
        &self,
        room_id: RoomId,
        result: Result<
            crate::review::bootstrap::SendEventOutcome,
            crate::review::bootstrap::BootstrapError,
        >,
    ) {
        match result {
            Ok(outcome) => {
                // attn-woc: also push the event over the live WebRTC mesh for
                // low-latency delivery to connected peers. The durable relay
                // path already ran in `send_event_sync` (outbox), which also
                // covers un-meshed peers; receivers dedup by EventId so the
                // double-delivery (mesh + relay) is harmless. This gives review
                // events the same WebRTC-primary delivery as collab steps.
                self.fan_envelope_over_mesh(&room_id, &outcome.envelope);
                (self.update_tx)(ReviewUpdate::EventImported {
                    room_id,
                    event: outcome.event,
                });
            }
            Err(err) => {
                (self.update_tx)(ReviewUpdate::Error {
                    room_id: None,
                    code: error_code(&err),
                    message: err.to_string(),
                });
            }
        }
    }

    /// Send an already-assembled envelope over every *connected* WebRTC
    /// DataChannel for `room_id` (attn-woc). Used for review events on top of
    /// their durable relay/outbox path — connected peers get it with mesh
    /// latency; the relay still covers un-meshed peers; receivers dedup by
    /// EventId. No-op when nothing is connected.
    fn fan_envelope_over_mesh(
        &self,
        room_id: &RoomId,
        envelope: &crate::review::model::MailboxEnvelope,
    ) {
        use crate::review::transport::webrtc::WebRtcConnectionState;
        let channels: Vec<Arc<crate::review::transport::webrtc::WebRtcTransport>> = self
            .live_webrtc
            .lock()
            .ok()
            .map(|map| {
                map.get(room_id)
                    .map(|live| {
                        live.transports
                            .values()
                            .filter(|t| matches!(t.state(), WebRtcConnectionState::Connected))
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        if let Some(runtime) = self.runtime.as_ref() {
            for transport in channels {
                let env = envelope.clone();
                runtime.spawn(async move {
                    let _ = transport.send_envelope(env).await;
                });
            }
        }
    }

    /// Owner rejects a suggestion: mint a `SuggestionRejected` event through
    /// the same outbox path as comments/suggestions. No apply and no on-disk
    /// change — the event simply records the decline so it propagates to every
    /// participant and the decoration layer drops the suggestion's ghost text.
    fn reject_suggestion(
        &self,
        bootstrapper: &Arc<Bootstrapper>,
        room_id: &RoomId,
        suggestion_id: &EventId,
        reason: Option<String>,
    ) {
        let event_body = crate::review::model::ReviewEventBody::SuggestionRejected {
            suggestion_id: suggestion_id.as_str().to_string(),
            reason,
        };
        let result = bootstrapper.send_event_sync(room_id, event_body, unix_now_ms_for_manager());
        self.emit_event_outcome(room_id.clone(), result);
    }

    /// Owner accepts a suggestion: resolve it against the current document,
    /// apply the `Ready` verdict to the working copy, emit a
    /// `SuggestionAccepted` event, and republish the snapshot so reviewers
    /// see the applied change. Non-`Ready` verdicts (drift / ambiguous /
    /// stale) surface as a `ReviewUpdate::Error` so the UI can prompt the
    /// three-way / re-anchor flow instead of silently rewriting.
    fn accept_suggestion(
        &self,
        bootstrapper: &Arc<Bootstrapper>,
        room_id: &RoomId,
        suggestion_id: &EventId,
    ) {
        use crate::review::anchors::index::build_anchor_index;
        use crate::review::apply::{ApplyContext, apply_ready_verdict, resolve_suggestion};
        use crate::review::crypto::ids::{content_hash, derive_snapshot_id};

        let emit_err = |code: &str, msg: String| {
            (self.update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: code.to_string(),
                message: msg,
            });
        };

        // 1. Find the SuggestionCreated event whose suggestion_id matches.
        let want = format!("{:?}", suggestion_id);
        let mut found: Option<(EventId, crate::review::model::ReviewEventBody)> = None;
        match self.store.iter_events(room_id) {
            Ok(iter) => {
                for ev in iter.flatten() {
                    if let crate::review::model::ReviewEventBody::SuggestionCreated {
                        suggestion_id: sid,
                        ..
                    } = &ev.body
                    {
                        // suggestion_id arrives as either the typed EventId's
                        // debug form or the raw string; match on the raw
                        // wire value the body carries.
                        if *sid == suggestion_id.as_str() || format!("{:?}", sid) == want {
                            found = Some((ev.meta.event_id.clone(), ev.body.clone()));
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                emit_err("ATTN_ACCEPT", format!("read events: {e}"));
                return;
            }
        }
        let Some((event_id, body)) = found else {
            emit_err(
                "ATTN_ACCEPT",
                format!("suggestion {} not found in room", suggestion_id.as_str()),
            );
            return;
        };

        // 2. Resolve the on-disk path for this room's shared file.
        let path = match crate::review::bootstrap::find_path_for_room(self.store.root(), room_id) {
            Ok(Some(p)) => p,
            Ok(None) => {
                emit_err("ATTN_ACCEPT", "no local file for room".to_string());
                return;
            }
            Err(e) => {
                emit_err("ATTN_ACCEPT", format!("path lookup: {e}"));
                return;
            }
        };

        // 3. Read current bytes + build the resolution context.
        let current_bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                emit_err("ATTN_ACCEPT", format!("read {}: {e}", path.display()));
                return;
            }
        };
        let current_hash = content_hash(&current_bytes);
        let now_ms = unix_now_ms_for_manager();
        // The anchor index's snapshot_id only seeds per-block ids; a fresh
        // derived id is fine for resolution against the live doc.
        let anchor = match &body {
            crate::review::model::ReviewEventBody::SuggestionCreated { anchor, .. } => anchor,
            _ => unreachable!("found is always SuggestionCreated"),
        };
        let file_id = anchor.file_id.clone();
        let tmp_snapshot_id = derive_snapshot_id(room_id, &file_id, &current_hash, now_ms as i64);
        let current_index = match build_anchor_index(&current_bytes, &tmp_snapshot_id) {
            Ok(idx) => idx,
            Err(e) => {
                emit_err("ATTN_ACCEPT", format!("anchor index: {e}"));
                return;
            }
        };

        // 4. Resolve → verdict.
        let verdict = match resolve_suggestion(
            &event_id,
            &body,
            &current_index,
            &current_bytes,
            &current_hash,
            None,
        ) {
            Ok(v) => v,
            Err(e) => {
                emit_err("ATTN_ACCEPT", format!("resolve: {e}"));
                return;
            }
        };

        // 5. Apply Ready verdicts; surface anything else for the UI to
        //    drive the three-way / re-anchor path.
        let ctx = ApplyContext {
            working_copy: Arc::clone(&self.working_copy),
            store: Arc::clone(&self.store),
            room_id: room_id.clone(),
            file_id,
            path: path.clone(),
        };
        let outcome = match apply_ready_verdict(&verdict, &ctx, &current_bytes) {
            Ok(o) => o,
            Err(e) => {
                emit_err(
                    "ATTN_ACCEPT_NOT_READY",
                    format!("suggestion needs review before apply: {e}"),
                );
                return;
            }
        };

        // 6. Emit a SuggestionAccepted event (round-trips to reviewers).
        let accepted_body = crate::review::model::ReviewEventBody::SuggestionAccepted {
            suggestion_id: match &body {
                crate::review::model::ReviewEventBody::SuggestionCreated {
                    suggestion_id, ..
                } => suggestion_id.clone(),
                _ => unreachable!(),
            },
            applied_revision_id: format!("{:?}", outcome.revision.revision_id),
            resulting_hash: outcome.resulting_hash.clone(),
        };
        let send = bootstrapper.send_event_sync(room_id, accepted_body, now_ms);
        self.emit_event_outcome(room_id.clone(), send);

        // 7. Republish the snapshot — the working copy changed, so reviewers
        //    must get the new content. The accept arm only matches when a
        //    runtime is attached (see `submit`), so the expect is structural.
        let republish = self
            .runtime
            .as_ref()
            .expect("accept_suggestion requires an attached runtime")
            .block_on(bootstrapper.republish_snapshot_for_path(&path, now_ms));
        if let Err(e) = republish {
            emit_err(
                "ATTN_SNAPSHOT_PUBLISH",
                format!("post-accept republish: {e}"),
            );
        }

        tracing::info!(
            "accepted suggestion {} → applied to {} (room={})",
            suggestion_id.as_str(),
            path.display(),
            room_id.as_str()
        );
    }

    /// Mark a comment thread resolved. Mints a durable `CommentResolved`
    /// event (carrying the resolver's participant id) and sends it through the
    /// normal outbox path, so the resolution persists locally and propagates
    /// to peers. The frontend's `reconstructThreads` flips the thread's
    /// `resolved` flag off the same event, so the card collapses to its
    /// resolved strip when the `EventImported` round-trips. The inverse is
    /// [`Self::reopen_comment`], which mints `CommentReopened`.
    fn resolve_comment(&self, bootstrapper: &Arc<Bootstrapper>, room_id: &RoomId, thread_id: &str) {
        let emit_err = |msg: String| {
            (self.update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: "ATTN_RESOLVE_COMMENT".to_string(),
                message: msg,
            });
        };

        let resolved_by = match bootstrapper
            .config()
            .identity_dir()
            .and_then(|dir| crate::review::bootstrap::load_or_create_identity_in(&dir))
        {
            Ok(identity) => identity.typed_participant_id(),
            Err(e) => return emit_err(format!("load identity: {e}")),
        };

        let body = crate::review::model::ReviewEventBody::CommentResolved {
            thread_id: thread_id.to_string(),
            resolved_by,
        };
        let send = bootstrapper.send_event_sync(room_id, body, unix_now_ms_for_manager());
        self.emit_event_outcome(room_id.clone(), send);

        tracing::info!(
            "resolved comment thread {} (room={})",
            thread_id,
            room_id.as_str()
        );
    }

    /// Reopen a resolved comment thread — the inverse of
    /// [`Self::resolve_comment`] (attn-bb6t.4). Mints a durable
    /// `CommentReopened` event carrying the reopener's participant id, so the
    /// thread comes back for every peer rather than only in the clicking
    /// client's view. Projections fold resolve/reopen in log order, so a
    /// reopen after a resolve wins and a later resolve closes it again.
    fn reopen_comment(&self, bootstrapper: &Arc<Bootstrapper>, room_id: &RoomId, thread_id: &str) {
        let emit_err = |msg: String| {
            (self.update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: "ATTN_REOPEN_COMMENT".to_string(),
                message: msg,
            });
        };

        // Only a comment thread reopens (attn-1l2f.1). The UI hides Unresolve
        // on suggestion cards; this is the durable half of that rule, so a
        // stale client or a scripted command can't mint the event either.
        match self.store.is_suggestion_thread(room_id, thread_id) {
            Ok(true) => {
                return emit_err(format!(
                    "thread {thread_id} is a suggestion: accept and reject are terminal"
                ));
            }
            Ok(false) => {}
            Err(e) => return emit_err(format!("read room events: {e}")),
        }

        let reopened_by = match bootstrapper
            .config()
            .identity_dir()
            .and_then(|dir| crate::review::bootstrap::load_or_create_identity_in(&dir))
        {
            Ok(identity) => identity.typed_participant_id(),
            Err(e) => return emit_err(format!("load identity: {e}")),
        };

        let body = crate::review::model::ReviewEventBody::CommentReopened {
            thread_id: thread_id.to_string(),
            reopened_by,
        };
        let send = bootstrapper.send_event_sync(room_id, body, unix_now_ms_for_manager());
        self.emit_event_outcome(room_id.clone(), send);

        tracing::info!(
            "reopened comment thread {} (room={})",
            thread_id,
            room_id.as_str()
        );
    }

    /// Owner/reviewer manually re-anchors a stale comment or suggestion to a
    /// range they selected in the editor. We:
    ///   1. Look up the original event to recover its real `file_id` (the
    ///      stub used a placeholder, so the resolution never matched a file).
    ///   2. Emit a durable `AnchorManuallyResolved` event so the override
    ///      persists and propagates to peers — a manual re-anchor is a shared
    ///      fact, not a local-only view tweak.
    ///   3. Push an `AnchorResolutionChanged` (confident `Remapped` at the
    ///      chosen range) so the local card flips from stale to resolved
    ///      immediately, without waiting for the event to round-trip.
    fn resolve_anchor(
        &self,
        bootstrapper: &Arc<Bootstrapper>,
        room_id: &RoomId,
        event_id: &EventId,
        range: &crate::review::model::PositionAnchor,
    ) {
        let emit_err = |code: &str, msg: String| {
            (self.update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: code.to_string(),
                message: msg,
            });
        };

        // 1. Find the target comment/suggestion event → its anchor's file_id.
        let want = event_id.as_str();
        let mut file_id: Option<FileId> = None;
        match self.store.iter_events(room_id) {
            Ok(iter) => {
                for ev in iter.flatten() {
                    if ev.meta.event_id.as_str() != want {
                        continue;
                    }
                    file_id = match &ev.body {
                        crate::review::model::ReviewEventBody::CommentCreated {
                            anchor, ..
                        } => Some(anchor.file_id.clone()),
                        crate::review::model::ReviewEventBody::SuggestionCreated {
                            anchor, ..
                        } => Some(anchor.file_id.clone()),
                        _ => None,
                    };
                    break;
                }
            }
            Err(e) => {
                emit_err("ATTN_RESOLVE_ANCHOR", format!("read events: {e}"));
                return;
            }
        }
        let Some(file_id) = file_id else {
            emit_err(
                "ATTN_RESOLVE_ANCHOR",
                format!("event {} not found or carries no anchor", want),
            );
            return;
        };

        // 2. Emit the durable, propagating override event.
        let resolved_by = match bootstrapper
            .config()
            .identity_dir()
            .and_then(|dir| crate::review::bootstrap::load_or_create_identity_in(&dir))
        {
            Ok(identity) => identity.typed_participant_id(),
            Err(e) => {
                emit_err("ATTN_RESOLVE_ANCHOR", format!("load identity: {e}"));
                return;
            }
        };
        let body = crate::review::model::ReviewEventBody::AnchorManuallyResolved {
            event_id: event_id.clone(),
            range: range.clone(),
            resolved_by,
        };
        let send = bootstrapper.send_event_sync(room_id, body, unix_now_ms_for_manager());
        self.emit_event_outcome(room_id.clone(), send);

        // 3. Push the immediate local resolution for the original event.
        (self.update_tx)(ReviewUpdate::AnchorResolutionChanged {
            room_id: room_id.clone(),
            event_id: event_id.clone(),
            file_id,
            resolved: ResolvedAnchor::Remapped {
                confidence: 1.0,
                current_range: range.clone(),
                reason: crate::review::model::RemappedReason::QuoteMatch,
            },
        });

        tracing::info!(
            "manually re-anchored event {} (room={})",
            event_id.as_str(),
            room_id.as_str()
        );
    }

    /// Record a client-side HTML anchor resolution and push it to the rail.
    ///
    /// Nothing durable is minted and nothing is sent to peers — see
    /// [`ReviewCommand::ReportHtmlAnchorResolution`]. The daemon's only jobs
    /// are to find the event's `fileId` (the frame does not know it) and to
    /// translate the frame's verdict into the `ResolvedAnchor` vocabulary the
    /// store already renders.
    fn report_html_anchor_resolution(
        &self,
        room_id: &RoomId,
        event_id: &EventId,
        status: HtmlResolutionStatus,
        confidence: f64,
        range: Option<&crate::review::model::PositionAnchor>,
    ) {
        let want = event_id.as_str();
        let mut file_id: Option<FileId> = None;
        match self.store.iter_events(room_id) {
            Ok(iter) => {
                for ev in iter.flatten() {
                    if ev.meta.event_id.as_str() != want {
                        continue;
                    }
                    file_id = match &ev.body {
                        crate::review::model::ReviewEventBody::CommentCreated {
                            anchor, ..
                        }
                        | crate::review::model::ReviewEventBody::SuggestionCreated {
                            anchor, ..
                        } => Some(anchor.file_id.clone()),
                        _ => None,
                    };
                    break;
                }
            }
            Err(e) => {
                (self.update_tx)(ReviewUpdate::Error {
                    room_id: Some(room_id.clone()),
                    code: "ATTN_HTML_ANCHOR_RESOLUTION".to_string(),
                    message: format!("read events: {e}"),
                });
                return;
            }
        }
        let Some(file_id) = file_id else {
            (self.update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: "ATTN_HTML_ANCHOR_RESOLUTION".to_string(),
                message: format!("event {want} not found or carries no anchor"),
            });
            return;
        };

        // The frame is untrusted, so clamp rather than trust its confidence.
        let confidence = confidence.clamp(0.0, 1.0);
        let resolved = match (status, range) {
            (HtmlResolutionStatus::Exact, Some(range)) => ResolvedAnchor::Exact {
                confidence,
                current_range: range.clone(),
                reason: crate::review::model::ExactReason::ClientResolved,
            },
            (HtmlResolutionStatus::Remapped, Some(range)) => ResolvedAnchor::Remapped {
                confidence,
                current_range: range.clone(),
                reason: crate::review::model::RemappedReason::ClientResolved,
            },
            (HtmlResolutionStatus::Ambiguous, _) => ResolvedAnchor::Ambiguous {
                candidates: Vec::new(),
                reason: "document frame found more than one equally good match".to_string(),
            },
            (HtmlResolutionStatus::Stale, _) => ResolvedAnchor::Stale {
                reason: "document frame could not find the anchored content".to_string(),
            },
            // A positive verdict with no range is incoherent; treat it as
            // stale rather than inventing a position for the rail to point at.
            (HtmlResolutionStatus::Exact | HtmlResolutionStatus::Remapped, None) => {
                ResolvedAnchor::Stale {
                    reason: "document frame reported a match without a range".to_string(),
                }
            }
        };

        (self.update_tx)(ReviewUpdate::AnchorResolutionChanged {
            room_id: room_id.clone(),
            event_id: event_id.clone(),
            file_id,
            resolved,
        });
    }

    /// Send a live co-typing payload over the encrypted `signal` channel.
    ///
    /// The webview's prosemirror-collab authority/client produced `payload`
    /// (a submission or an authoritative broadcast); we seal it as a
    /// `SignalingPayload::Collab` under the room's signaling key and append it
    /// to the outbox as a broadcast (target=None) so every connected peer
    /// receives it. The running OutboxProcessor POSTs it to the relay, which
    /// fans it out over the live WebSocket. Steps ride this ephemeral,
    /// FIFO-capped lane — never the durable event log.
    fn send_collab(&self, bootstrapper: &Arc<Bootstrapper>, room_id: &RoomId, payload: &str) {
        use crate::review::bootstrap::load_room_secret;
        use crate::review::crypto::kdf::derive_room_keys;

        let emit_err = |msg: String| {
            (self.update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: "ATTN_COLLAB_SEND".to_string(),
                message: msg,
            });
        };

        let (signaling_key, protocol_version) =
            match crate::review::bootstrap::load_room_access_v3(self.store.root(), room_id) {
                Ok(Some(access)) => (
                    *crate::review::crypto::kdf::derive_read_keys_v3(&access.read_capability_key)
                        .signaling_key
                        .as_bytes(),
                    3,
                ),
                Ok(None) => {
                    let secret = match load_room_secret(self.store.root(), room_id) {
                        Ok(secret) => secret,
                        Err(error) => return emit_err(format!("load room secret: {error}")),
                    };
                    (*derive_room_keys(&secret).signaling_key.as_bytes(), 2)
                }
                Err(error) => return emit_err(format!("load v3 room access: {error}")),
            };

        let identity = match bootstrapper
            .config()
            .identity_dir()
            .and_then(|dir| crate::review::bootstrap::load_or_create_identity_in(&dir))
        {
            Ok(id) => id,
            Err(e) => return emit_err(format!("load identity: {e}")),
        };
        let device_id = identity.typed_device_id();
        let participant_id = identity.typed_participant_id();
        let is_owner = self
            .store
            .load_room(room_id)
            .ok()
            .flatten()
            .is_some_and(|room| room.created_by == participant_id);
        let Some(kind) = collab_wire_kind(payload) else {
            return emit_err("invalid collaboration payload".to_string());
        };
        if !outbound_collab_allowed(is_owner, kind) {
            return emit_err(if is_owner {
                "owner collaboration may only broadcast local document state or cursor presence"
                    .to_string()
            } else {
                "reviewers cannot submit live document mutations; create a durable suggestion instead"
                    .to_string()
            });
        }

        let now_ms = unix_now_ms_for_manager() as i64;
        let envelope = match assemble_signal_envelope(
            SignalingPayload::Collab {
                from: device_id.clone(),
                payload: payload.to_string(),
            },
            &signaling_key,
            room_id,
            &participant_id,
            &device_id,
            None, // broadcast to the whole room
            &fresh_client_nonce_16(),
            now_ms,
            now_ms + SIGNAL_TTL_MS,
        ) {
            Ok(mut env) if protocol_version == 3 => {
                env.signal_class = collab_signal_class(protocol_version, kind);
                match crate::review::transport::signaling::authenticate_signal_envelope_v3(
                    env,
                    now_ms.max(0) as u64,
                    &match identity.signing_key() {
                        Ok(key) => key,
                        Err(error) => return emit_err(format!("load signal signing key: {error}")),
                    },
                ) {
                    Ok(env) => env,
                    Err(error) => return emit_err(format!("authenticate collab signal: {error}")),
                }
            }
            Ok(env) => env,
            Err(e) => return emit_err(format!("assemble collab signal: {e}")),
        };

        // Per-peer routing (attn-7qv). Cursor/view presence is deliberately
        // WebRTC-only: send it to every connected channel and drop it for
        // peers without a direct path. It is replaceable UI state, so relay
        // fallback would spend a request + fan-out on a sample that the next
        // cursor update immediately supersedes.
        //
        // Document collaboration uses the hybrid routing below: ALWAYS send
        // over every *connected* channel, AND relay as well whenever the mesh
        // is incomplete. Choosing one or the other drops data under a partial
        // mesh — without TURN, a peer reachable only via its DataChannel gets
        // nothing on a relay-only path. Connected peers may then see the
        // sample twice; the receiver is idempotent (steps dedup by version,
        // cursor/presence is last-writer, `from` drops self-echoes). A
        // complete mesh skips the relay to keep high-frequency step/cursor
        // traffic off it, which is the cost driver at scale.
        let (channels, peer_count): (
            Vec<Arc<crate::review::transport::webrtc::WebRtcTransport>>,
            usize,
        ) = {
            use crate::review::transport::webrtc::WebRtcConnectionState;
            self.live_webrtc
                .lock()
                .ok()
                .and_then(|map| {
                    map.get(room_id).map(|live| {
                        let connected: Vec<_> = live
                            .transports
                            .values()
                            .filter(|t| matches!(t.state(), WebRtcConnectionState::Connected))
                            .cloned()
                            .collect();
                        (connected, live.peers)
                    })
                })
                .unwrap_or_default()
        };

        let routing = decide_collab_routing(kind, peer_count, channels.len());

        if routing.send_over_channels
            && let Some(runtime) = self.runtime.as_ref()
        {
            for transport in channels {
                let env = envelope.clone();
                runtime.spawn(async move {
                    let _ = transport.send_envelope(env).await;
                });
            }
        }

        if routing.use_relay
            && let Err(e) = self.store.append_outbox(room_id, &envelope)
        {
            emit_err(format!("enqueue collab signal: {e}"));
        }
    }

    /// Translate a `ShareOutcome` (or its error) into the corresponding
    /// `ReviewUpdate` and dispatch it. Carries the invite in the status
    /// field per the frontend contract — the right-rail Share view reads
    /// `status` and surfaces the URL via a copy-to-clipboard button.
    fn emit_share_outcome(
        &self,
        result: Result<ShareOutcome, crate::review::bootstrap::BootstrapError>,
    ) {
        match result {
            Ok(outcome) => {
                // Emit the rich ShareReady payload first so the dialog
                // populates the URL field, then drop a plain RoomStatusChanged
                // so existing wiring (ReviewBar visibility predicate) also
                // sees the room come online.
                let room_id = outcome.room_id.clone();
                (self.update_tx)(ReviewUpdate::ShareReady {
                    room_id: outcome.room_id,
                    invite_url: outcome.invite,
                    browser_invite_url: outcome.browser_invite,
                    view_invite_url: outcome.view_invite,
                    suggest_invite_url: outcome.suggest_invite,
                    browser_view_invite_url: outcome.browser_view_invite,
                    browser_suggest_invite_url: outcome.browser_suggest_invite,
                    owner_display_path: outcome.owner_display_path,
                    owner_signing_key: outcome.owner_signing_key,
                    mode: outcome.mode,
                    expires_at: outcome.expires_at,
                    newly_created: outcome.newly_created,
                });
                (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                    room_id: room_id.clone(),
                    status: "Live".to_string(),
                });
                // Open outbox + inbound WS so envelopes flow both ways.
                // Failures are surfaced as Error updates rather than
                // bailing out — Share itself already succeeded at the
                // relay; the transport layer is just the live keepalive.
                if let Err(err) = self.start_room_runtime(&room_id) {
                    (self.update_tx)(ReviewUpdate::Error {
                        room_id: Some(room_id),
                        code: "ATTN_TRANSPORT_INIT".to_string(),
                        message: format!("could not start room transports: {err}"),
                    });
                }
            }
            Err(err) => {
                (self.update_tx)(ReviewUpdate::Error {
                    room_id: None,
                    code: error_code(&err),
                    message: err.to_string(),
                });
            }
        };
    }

    /// Translate a `JoinOutcome` (or its error) into the corresponding
    /// `ReviewUpdate` and dispatch it.
    /// Join a room and REPORT whether it worked (attn-q8gs).
    ///
    /// `ReviewCommand::Join` is fire-and-forget: `submit` hands it to the
    /// dispatch loop, the caller is told nothing, and a failure surfaces only
    /// as a `ReviewUpdate::Error` in the window and a line in the daemon log.
    /// That is right for the in-app path — the window is watching — and wrong
    /// for `attn review join`, whose caller is a terminal that exits before
    /// any update arrives and so reported success for joins that never
    /// happened.
    ///
    /// This runs the SAME work as the `Join` arm of `submit` — same
    /// bootstrapper call, same `emit_join_outcome`, so the window still
    /// updates exactly as it would have — and additionally returns the
    /// outcome to whoever asked. Returns the joined `RoomId` on success, or a
    /// human-readable reason on failure.
    pub fn join_blocking(&self, invite: String) -> Result<String, String> {
        let (Some(bootstrap), Some(runtime)) = (self.bootstrap.as_ref(), self.runtime.as_ref())
        else {
            return Err("review bootstrapper unavailable (daemon started without one)".to_string());
        };
        let cache = self.verifying_keys.clone();
        let result = runtime.block_on(bootstrap.join(&invite, cache));
        // Summarise BEFORE handing ownership to the emitter, which consumes
        // the result. The emit must still happen: it starts the room runtime
        // and flips the window onto the shared document.
        let summary = match &result {
            Ok(outcome) => Ok(outcome.room_id.as_str().to_string()),
            Err(err) => Err(format!("{err}")),
        };
        self.emit_join_outcome(result);
        summary
    }

    fn emit_join_outcome(
        &self,
        result: Result<JoinOutcome, crate::review::bootstrap::BootstrapError>,
    ) {
        match result {
            Ok(outcome) => {
                let room_id = outcome.room_id;
                self.set_local_grant_tier(room_id.clone(), outcome.local_grant_tier);
                // Start the transport runtime BEFORE emitting status so
                // by the time the frontend reacts to "Joined" the WS
                // subscriber is already listening. If init fails we
                // still surface "Joined" — the user is technically in
                // the room, just offline for live events.
                if let Err(err) = self.start_room_runtime(&room_id) {
                    (self.update_tx)(ReviewUpdate::Error {
                        room_id: Some(room_id.clone()),
                        code: "ATTN_TRANSPORT_INIT".to_string(),
                        message: format!("could not start room transports: {err}"),
                    });
                }
                (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                    room_id: room_id.clone(),
                    status: "Joined".to_string(),
                });
                // A RE-join over persisted state gets nothing re-delivered
                // by the relay (the WS cursor already advanced past the
                // session-1 envelopes), so replay the on-disk log. Fresh
                // joins have an empty events.jsonl — a no-op (attn-6dd).
                self.replay_room_to_webview(&room_id);
            }
            Err(err) => {
                (self.update_tx)(ReviewUpdate::Error {
                    room_id: None,
                    code: error_code(&err),
                    message: err.to_string(),
                });
            }
        }
    }

    /// Spawn the outbox drain + inbound WS subscriber for `room_id` onto the
    /// manager's tokio runtime. Idempotent: a duplicate call is a no-op since
    /// the `cancels` registry already holds a handle for the room (that map is
    /// the authoritative "this room has a live runtime" set).
    ///
    /// What this wires up:
    ///   - `OutboxProcessor::run` — drains pending envelopes from
    ///     `outbox.jsonl` (POSTed in batches of ≤ 32 with PoW tokens).
    ///     This is what gets the comment we just appended in
    ///     `CreateComment` *off* the daemon and onto the relay.
    ///   - `MailboxWsClient::run` — subscribes to the relay's WS,
    ///     decrypts inbound envelopes via `InboundPipeline`, appends to
    ///     `events.jsonl`, and emits `TransportEvent::EventImported`.
    ///     A forwarder spawned alongside re-emits each as
    ///     `ReviewUpdate::EventImported` so the frontend store renders
    ///     the new comment.
    ///
    /// Returns a typed error when the room secret / identity / runtime
    /// pre-conditions aren't met. The caller surfaces these as
    /// `ReviewUpdate::Error` so the UI sees them.
    pub(crate) fn start_room_runtime(&self, room_id: &RoomId) -> anyhow::Result<()> {
        use crate::review::bootstrap::load_room_secret;
        use crate::review::crypto::kdf::derive_room_keys;
        use crate::review::crypto::pow::TokenPool;
        use crate::review::transport::TransportEvent;
        use crate::review::transport::inbound::InboundPipeline;
        use crate::review::transport::mailbox::MailboxConfig;
        use crate::review::transport::mailbox::OutboxProcessor;
        use crate::review::transport::mailbox::ws::MailboxWsClient;

        let bootstrap = self
            .bootstrap
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("bootstrap not attached; relay url unknown"))?;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no tokio runtime; cannot spawn outbox / ws tasks"))?;
        let verifying_keys = self
            .verifying_keys
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("verifying-key cache absent"))?
            .clone();
        let authorizations: AuthorizationCache = Arc::new(tokio::sync::RwLock::new(HashMap::new()));

        // Idempotency guard: a room with a live cancel handle already has its
        // outbox/WS/forwarder tasks running. Re-running here would insert a
        // fresh `cancel_tx`, dropping the old one — making the live tasks'
        // `cancel.changed()` resolve Err (misread as cancel) and tearing the
        // connection down. Bail out cleanly instead. (`cancels` is the
        // authoritative "this room has a runtime" set since this is the only
        // place that populates it.)
        if let Ok(cancels) = self.cancels.lock()
            && cancels.contains_key(room_id)
        {
            return Ok(());
        }

        // Identity for this device. Cheap to re-load; we don't need to
        // cache because the daemon owns its identity file for life.
        let identity_dir = bootstrap.config().identity_dir()?;
        let identity = crate::review::bootstrap::load_or_create_identity_in(&identity_dir)?;
        let device_id = identity.typed_device_id();

        // Prefer persisted v3 capability metadata. Legacy rooms continue to
        // derive the v2 tree from their owner/reviewer room secret.
        let v3_access = crate::review::bootstrap::load_room_access_v3(self.store.root(), room_id)?;
        if let Some(access) = v3_access.as_ref() {
            self.set_local_grant_tier(room_id.clone(), access.grant_tier);
        }
        let (event_key, snapshot_key, signaling_key, mailbox_config) = if let Some(access) =
            v3_access.as_ref()
        {
            let read = crate::review::crypto::kdf::derive_read_keys_v3(&access.read_capability_key);
            let config = MailboxConfig::from_v3_access(
                bootstrap.config().relay_url.clone(),
                room_id.clone(),
                device_id.clone(),
                access,
                identity.signing_key()?.to_bytes(),
                12,
            )?;
            (
                *read.event_key.as_bytes(),
                *read.snapshot_key.as_bytes(),
                *read.signaling_key.as_bytes(),
                config,
            )
        } else {
            let room_secret = load_room_secret(self.store.root(), room_id)?;
            let room_keys = derive_room_keys(&room_secret);
            let config = MailboxConfig::from_room_secret(
                bootstrap.config().relay_url.clone(),
                room_id.clone(),
                device_id.clone(),
                &room_secret,
                12,
            );
            (
                *room_keys.event_key.as_bytes(),
                *room_keys.snapshot_key.as_bytes(),
                *room_keys.signaling_key.as_bytes(),
                config,
            )
        };

        // MailboxConfig + TokenPool — shared between the outbox processor
        // and the WS subscriber so admission HMAC + PoW caching are
        // consistent across both paths.
        let mailbox_config = Arc::new(mailbox_config);
        let token_pool = Arc::new(TokenPool::new(
            room_id.as_str().to_string(),
            device_id.as_str().to_string(),
            12,
            5 * 60 * 1000,
        ));

        // Outbox processor — drains envelopes to the relay.
        let outbox = Arc::new(OutboxProcessor::new(
            Arc::clone(&self.store),
            Arc::clone(&mailbox_config),
            token_pool,
        )?);
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        // One cancel signal drives BOTH the outbox loop and the WS subscriber:
        // the outbox owns `cancel_rx`, the WS subscriber gets a `subscribe()`
        // clone below. The sender must live for the room's life, so it goes in
        // the per-room `cancels` registry — drop it and `cancel.changed()`
        // resolves Err, which the WS `select!` misreads as a cancel and aborts
        // connect_async before it completes. Keeping it in the map also lets
        // `Stop` flip it to wind the outbox + WS tasks down cooperatively. The
        // matching outbox handle is retained so `Pull` can force a one-shot
        // drain.
        let ws_cancel_rx = cancel_tx.subscribe();
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.insert(room_id.clone(), cancel_tx);
        }
        if let Ok(mut outboxes) = self.outboxes.lock() {
            outboxes.insert(room_id.clone(), Arc::clone(&outbox));
        }
        let outbox_clone = Arc::clone(&outbox);
        runtime.spawn(async move {
            outbox_clone.run(cancel_rx).await;
        });

        // Seed the verifying-key cache from the relay's device directory
        // BEFORE the WS connects, so the InboundPipeline can verify
        // signatures on the first envelopes it sees — including the
        // owner's own snapshot, which the relay broadcasts back to the
        // author the instant the outbox POSTs it. Done synchronously
        // (block_on) to close the race where that broadcast arrives
        // before the directory fetch completes. The GET is ~milliseconds
        // against a healthy relay; failures are logged but non-fatal
        // (peer keys also arrive via ParticipantJoined events).
        match runtime.block_on(bootstrap.refresh_device_authorizations(
            room_id,
            &verifying_keys,
            &authorizations,
        )) {
            Ok(n) => tracing::info!("seeded {n} device key(s) for room={}", room_id.as_str()),
            // The relay says this room no longer exists. The local store still
            // had it with a future TTL, so without this it would be resumed on
            // EVERY boot — each time blocking here on a 404 then dialing a dead
            // WS (the startup stall). Tear down the partial runtime we just
            // spawned, forget the room, and abort so it never resumes again.
            // (To revive, the owner re-Shares, which re-establishes the room.)
            Err(err) if err.is_room_not_found() => {
                tracing::warn!(
                    "room={} no longer exists on the relay; forgetting it (won't resume again)",
                    room_id.as_str()
                );
                if let Ok(mut cancels) = self.cancels.lock()
                    && let Some(tx) = cancels.remove(room_id)
                {
                    let _ = tx.send(true);
                }
                if let Ok(mut outboxes) = self.outboxes.lock() {
                    outboxes.remove(room_id);
                }
                if let Err(e) = self.store.delete_room(room_id) {
                    tracing::warn!("delete_room failed for {}: {e}", room_id.as_str());
                }
                (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                    room_id: room_id.clone(),
                    status: "Stopped".to_string(),
                });
                return Err(anyhow::anyhow!(
                    "room {} no longer exists on the relay (forgotten)",
                    room_id.as_str()
                ));
            }
            Err(err) => tracing::warn!(
                "refresh_device_keys failed room={}: {err}",
                room_id.as_str()
            ),
        }

        // Inbound pipeline: decrypts incoming envelopes and appends them
        // to events.jsonl. Wired through the WS subscriber.
        let inbound = Arc::new(InboundPipeline::new(
            Arc::clone(&self.store),
            verifying_keys.clone(),
            authorizations.clone(),
            event_key,
            snapshot_key,
            signaling_key,
        ));

        // Refresher invoked when an inbound envelope arrives from a peer
        // that joined AFTER our cache was seeded (e.g. a reviewer's first
        // comment reaching the owner). Re-fetches GET /devices into the
        // shared cache; the WS retries the import once. Without this, a
        // late joiner's events are dropped as UnknownSigner forever.
        let key_refresher: Arc<dyn crate::review::transport::DeviceKeyRefresher> =
            Arc::new(BootstrapKeyRefresher {
                bootstrap: Arc::clone(bootstrap),
                room_id: room_id.clone(),
                cache: verifying_keys,
                authorizations,
            });

        // WS subscriber — long-lived task that auto-reconnects.
        let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<TransportEvent>();
        // Clones for the WebRTC live arm (built lazily when a peer appears).
        // The transport shares the same inbound pipeline (dedups by EventId via
        // the store) and emits inbound DataChannel envelopes onto the same
        // events channel, so they flow through the forwarder below unchanged.
        let webrtc_inbound = Arc::clone(&inbound);
        let webrtc_events_tx = events_tx.clone();
        let ws_client =
            MailboxWsClient::new(mailbox_config, inbound, Arc::clone(&self.store), events_tx)
                .with_key_refresher(key_refresher);
        // Shares the room's single cancel signal (subscribed above, before
        // the sender moved into `cancels`) so `Stop` winds the WS down too.
        runtime.spawn(async move {
            let _ = ws_client.run(ws_cancel_rx).await;
        });

        // ---- WebRTC live data plane (Hybrid) ------------------------------
        // Negotiate a DataChannel with the peer so the high-frequency live
        // traffic (collab steps, cursors) flows peer-to-peer; the relay stays
        // the signaling carrier (SDP/ICE) + durable/offline fallback. Keeping
        // steps off the relay is the whole point — relay bandwidth/DO-time is
        // the cost driver at scale. Stage 2 handles the 2-party (first-peer)
        // case; the N-peer star lands in a later stage.
        let webrtc_author_id = identity.typed_participant_id();
        let webrtc_local_device = device_id.clone();
        let webrtc_event_key = event_key;
        let webrtc_snapshot_key = snapshot_key;
        let webrtc_signaling_key = signaling_key;
        let webrtc_protocol_version = if v3_access.is_some() { 3 } else { 2 };
        let webrtc_signing_seed = if v3_access.is_some() {
            Some(identity.signing_key()?.to_bytes())
        } else {
            None
        };
        let webrtc_room_id = room_id.clone();

        // Outbound signaling forwarder: drain the transport's signaling_tx into
        // the durable outbox and drain it immediately, so SDP/ICE reach the
        // peer without waiting on the outbox poll tick (prompt negotiation).
        let (webrtc_sig_tx, mut webrtc_sig_rx) =
            tokio::sync::mpsc::unbounded_channel::<crate::review::model::MailboxEnvelope>();
        let sig_outbox = Arc::clone(&outbox);
        runtime.spawn(async move {
            while let Some(env) = webrtc_sig_rx.recv().await {
                if let Err(err) = sig_outbox.enqueue(env) {
                    tracing::warn!("webrtc: signaling enqueue failed: {err}");
                    continue;
                }
                if let Err(err) = sig_outbox.process_once().await {
                    tracing::warn!("webrtc: signaling drain failed: {err}");
                }
            }
        });

        // Event forwarder + WebRTC orchestrator: drains TransportEvents into
        // ReviewUpdates (inbound comments / presence / policy) AND drives the
        // peer connection. We capture our own device id (to drop self-echoes
        // and pick the initiator) and the room's owner participant (to tag the
        // owner chip warm vs. reviewer cool).
        let update_tx = Arc::clone(&self.update_tx);
        let badge_update_tx = Arc::clone(&self.update_tx);
        let webrtc_live_map = Arc::clone(&self.live_webrtc);
        let forward_store = Arc::clone(&self.store);
        let verdict_revision_tx = self.verdict_revision_tx.clone();
        let notifications = Arc::clone(&self.notifications);
        let room_id_owned = room_id.clone();
        let self_device_id = device_id.as_str().to_string();
        let owner_participant_id: Option<String> = self
            .store
            .load_room(room_id)
            .ok()
            .flatten()
            .map(|room| room.created_by.as_str().to_string());
        let local_is_owner = owner_participant_id.as_deref() == Some(webrtc_author_id.as_str());
        runtime.spawn(async move {
            use crate::review::transport::PresenceEvent;
            use crate::review::transport::signaling::SignalingPayload;
            use crate::review::transport::webrtc::{
                WebRtcConfig, WebRtcConnectionState, WebRtcTransport,
            };

            // Full-mesh DataChannel transports keyed by peer deviceId: every
            // participant connects to every other, so cursors (all-to-all
            // presence) and the owner-authority collab both flow P2P. Mirrored
            // into the manager's live_webrtc map for send_collab's fan-out.
            let mut transports: HashMap<crate::review::ids::DeviceId, Arc<WebRtcTransport>> =
                HashMap::new();
            // Native and hosted-browser devices share the same encrypted
            // signaling/DataChannel wire. Agent CLI devices remain mailbox-only.
            let mut webrtc_eligible_peers: std::collections::HashSet<crate::review::ids::DeviceId> =
                std::collections::HashSet::new();
            // Device registration is immutable for a room, while online
            // membership is not. Preserve the native classification across a
            // leave so a later Presence::Join can rebuild its transport.
            let mut known_webrtc_peers: std::collections::HashSet<crate::review::ids::DeviceId> =
                std::collections::HashSet::new();
            let mut known_webrtc_clients: HashMap<crate::review::ids::DeviceId, DeviceClient> =
                HashMap::new();
            let mut online_peers: std::collections::HashSet<crate::review::ids::DeviceId> =
                std::collections::HashSet::new();
            // Non-self peer count, kept current from Hello (absolute) + Presence
            // (delta). The mesh is "complete" when transports.len() == peer_count.
            let mut peer_count: usize = 0;

            while let Some(event) = events_rx.recv().await {
                // Maintain the peer count + mirror it into the live map.
                match &event {
                    TransportEvent::Hello {
                        devices,
                        online_device_ids,
                        ..
                    } => {
                        known_webrtc_clients = devices
                            .iter()
                            .filter(|d| {
                                d.device_id.as_str() != self_device_id
                                    && device_supports_webrtc(d.client)
                            })
                            .map(|d| (d.device_id.clone(), d.client))
                            .collect();
                        known_webrtc_peers = known_webrtc_clients.keys().cloned().collect();
                        online_peers = online_device_ids
                            .iter()
                            .filter(|device_id| device_id.as_str() != self_device_id)
                            .cloned()
                            .collect();
                        webrtc_eligible_peers = known_webrtc_peers
                            .intersection(&online_peers)
                            .cloned()
                            .collect();
                        peer_count = webrtc_eligible_peers.len();
                    }
                    TransportEvent::EventImported { event, .. } => {
                        if let crate::review::model::ReviewEventBody::ParticipantJoined {
                            device,
                            ..
                        } = &event.body
                            && device.device_id.as_str() != self_device_id
                            && device_supports_webrtc(device.client)
                        {
                            known_webrtc_peers.insert(device.device_id.clone());
                            known_webrtc_clients.insert(device.device_id.clone(), device.client);
                            if online_peers.contains(&device.device_id) {
                                webrtc_eligible_peers.insert(device.device_id.clone());
                            }
                            peer_count = webrtc_eligible_peers.len();
                        }
                    }
                    TransportEvent::Presence {
                        event: PresenceEvent::Leave,
                        device_id: peer,
                        ..
                    } if peer.as_str() != self_device_id => {
                        online_peers.remove(peer);
                        webrtc_eligible_peers.remove(peer);
                        peer_count = webrtc_eligible_peers.len();
                    }
                    TransportEvent::Presence {
                        event: PresenceEvent::Join,
                        device_id: peer,
                        ..
                    } if peer.as_str() != self_device_id => {
                        online_peers.insert(peer.clone());
                        if known_webrtc_peers.contains(peer) {
                            webrtc_eligible_peers.insert(peer.clone());
                        }
                        peer_count = webrtc_eligible_peers.len();
                    }
                    _ => {}
                }
                let stale_peers: Vec<_> = match &event {
                    TransportEvent::Hello { .. } => transports
                        .keys()
                        .filter(|peer| !webrtc_eligible_peers.contains(*peer))
                        .cloned()
                        .collect(),
                    TransportEvent::Presence {
                        event: PresenceEvent::Leave,
                        device_id: peer,
                        ..
                    } => vec![peer.clone()],
                    _ => Vec::new(),
                };
                for peer in stale_peers {
                    if let Some(transport) = transports.remove(&peer) {
                        let _ = transport.close().await;
                        if let Ok(mut map) = webrtc_live_map.lock()
                            && let Some(live) = map.get_mut(&webrtc_room_id)
                        {
                            live.transports.remove(&peer);
                        }
                    }
                }
                if let Ok(mut map) = webrtc_live_map.lock()
                    && let Some(live) = map.get_mut(&webrtc_room_id)
                {
                    live.peers = peer_count;
                }

                // Which peers need a transport from THIS event, and whether we
                // may initiate. Hello → all peers; Presence(Join) → that peer;
                // an inbound signal → its sender (and we only answer, not offer).
                let (peers_to_build, may_offer): (Vec<crate::review::ids::DeviceId>, bool) =
                    match &event {
                        TransportEvent::Hello {
                            devices,
                            online_device_ids,
                            ..
                        } => (
                            devices
                                .iter()
                                .filter(|d| {
                                    d.device_id.as_str() != self_device_id
                                        && device_supports_webrtc(d.client)
                                        && online_device_ids.contains(&d.device_id)
                                })
                                .map(|d| d.device_id.clone())
                                .collect(),
                            true,
                        ),
                        TransportEvent::EventImported { event, .. } => {
                            let peer = match &event.body {
                                crate::review::model::ReviewEventBody::ParticipantJoined {
                                    device,
                                    ..
                                } if device.device_id.as_str() != self_device_id
                                    && device_supports_webrtc(device.client)
                                    && online_peers.contains(&device.device_id) =>
                                {
                                    Some(device.device_id.clone())
                                }
                                _ => None,
                            };
                            (peer.into_iter().collect(), true)
                        }
                        TransportEvent::Presence {
                            event: PresenceEvent::Join,
                            device_id: peer,
                            ..
                        } if peer.as_str() != self_device_id
                            && known_webrtc_peers.contains(peer) =>
                        {
                            (vec![peer.clone()], true)
                        }
                        TransportEvent::Signaling { payload, .. } => {
                            let from = match payload {
                                SignalingPayload::Offer { from, .. }
                                | SignalingPayload::Answer { from, .. }
                                | SignalingPayload::Ice { from, .. } => Some(from.clone()),
                                _ => None,
                            };
                            (
                                from.filter(|d| {
                                    d.as_str() != self_device_id
                                        && webrtc_eligible_peers.contains(d)
                                })
                                .into_iter()
                                .collect(),
                                false,
                            )
                        }
                        _ => (Vec::new(), false),
                    };

                // Build a transport for each peer we don't have a LIVE one for.
                // We consult the shared live map (not the local `transports`)
                // because the per-transport badge watcher prunes it there when a
                // connection dies terminally — so a peer whose DataChannel failed
                // during a prolonged offline gets a FRESH transport (re-signaling
                // a new offer/answer) on the next Hello, instead of being skipped
                // forever and stuck on the relay fallback.
                for remote in peers_to_build {
                    let has_live_transport = webrtc_live_map
                        .lock()
                        .ok()
                        .and_then(|m| {
                            m.get(&webrtc_room_id)
                                .map(|live| live.transports.contains_key(&remote))
                        })
                        .unwrap_or(false);
                    if has_live_transport {
                        continue;
                    }
                    let cfg = Arc::new(WebRtcConfig {
                        protocol_version: webrtc_protocol_version,
                        device_signing_seed: webrtc_signing_seed,
                        room_id: webrtc_room_id.clone(),
                        author_id: webrtc_author_id.clone(),
                        local_device_id: webrtc_local_device.clone(),
                        remote_device_id: remote.clone(),
                        event_key: webrtc_event_key,
                        snapshot_key: webrtc_snapshot_key,
                        signaling_key: webrtc_signaling_key,
                        // The browser is the designated offerer for
                        // native-browser pairs, including ICE restarts.
                        // Keeping native passive avoids glare and prevents an
                        // unsignaled native restart offer from replacing the
                        // active local description.
                        allow_local_ice_restart: !matches!(
                            known_webrtc_clients.get(&remote),
                            Some(DeviceClient::AttnBrowser)
                        ),
                        stun_servers: Vec::new(),
                    });
                    match WebRtcTransport::new(
                        cfg,
                        Arc::clone(&webrtc_inbound),
                        webrtc_events_tx.clone(),
                        webrtc_sig_tx.clone(),
                    )
                    .await
                    {
                        Ok(transport) => {
                            let transport = Arc::new(transport);
                            transports.insert(remote.clone(), Arc::clone(&transport));
                            // Mirror into the manager-shared live map so
                            // send_collab can fan out over the mesh.
                            if let Ok(mut map) = webrtc_live_map.lock() {
                                let entry =
                                    map.entry(webrtc_room_id.clone()).or_insert_with(|| {
                                        LiveWebrtc {
                                            transports: HashMap::new(),
                                            peers: peer_count,
                                        }
                                    });
                                entry
                                    .transports
                                    .insert(remote.clone(), Arc::clone(&transport));
                                entry.peers = peer_count;
                            }
                            // Badge: a per-transport state watch that recomputes
                            // the AGGREGATE — live_direct only when EVERY peer's
                            // channel is open; mailbox (the fallback) otherwise.
                            let badge_tx = Arc::clone(&badge_update_tx);
                            let badge_room = webrtc_room_id.clone();
                            let badge_map = Arc::clone(&webrtc_live_map);
                            let badge_remote = remote.clone();
                            let mut state_rx = transport.watch_state().await;
                            tokio::spawn(async move {
                                loop {
                                    let all_live = badge_map
                                        .lock()
                                        .ok()
                                        .and_then(|map| {
                                            map.get(&badge_room).map(|live| {
                                                live.peers > 0
                                                    && live.transports.len() == live.peers
                                                    && live.transports.values().all(|t| {
                                                        matches!(
                                                            t.state(),
                                                            WebRtcConnectionState::Connected
                                                        )
                                                    })
                                            })
                                        })
                                        .unwrap_or(false);
                                    (badge_tx)(ReviewUpdate::ConnectionChanged {
                                        room_id: badge_room.clone(),
                                        connection: if all_live {
                                            "live_direct".to_string()
                                        } else {
                                            "mailbox".to_string()
                                        },
                                    });
                                    if state_rx.changed().await.is_err() {
                                        break;
                                    }
                                    // Terminal death (ICE-restart exhausted, or
                                    // closed after a prolonged offline): drop this
                                    // transport from the live map so the next Hello
                                    // on WS-reconnect re-negotiates a fresh
                                    // DataChannel (re-signaling) instead of skipping
                                    // the peer forever. Then stop watching it.
                                    if matches!(
                                        *state_rx.borrow(),
                                        WebRtcConnectionState::Failed
                                            | WebRtcConnectionState::Closed
                                    ) {
                                        if let Ok(mut map) = badge_map.lock()
                                            && let Some(live) = map.get_mut(&badge_room)
                                        {
                                            live.transports.remove(&badge_remote);
                                        }
                                        (badge_tx)(ReviewUpdate::ConnectionChanged {
                                            room_id: badge_room.clone(),
                                            connection: "mailbox".to_string(),
                                        });
                                        break;
                                    }
                                }
                            });
                            // Cross-client rule: browser offers to native for
                            // reliable Chromium↔webrtc-rs DTLS setup. Native
                            // pairs retain the lexical glare-free tie-break.
                            if may_offer
                                && !matches!(
                                    known_webrtc_clients.get(&remote),
                                    Some(DeviceClient::AttnBrowser)
                                )
                                && webrtc_local_device.as_str() < remote.as_str()
                                && let Err(err) = transport.create_offer().await
                            {
                                tracing::warn!("webrtc: create_offer failed: {err}");
                            }
                        }
                        Err(err) => tracing::warn!("webrtc: transport build failed: {err}"),
                    }
                }

                // Route inbound SDP/ICE to the transport bound to that peer.
                if let TransportEvent::Signaling { payload, .. } = &event {
                    let from = match payload {
                        SignalingPayload::Offer { from, .. }
                        | SignalingPayload::Answer { from, .. }
                        | SignalingPayload::Ice { from, .. } => Some(from.clone()),
                        _ => None,
                    };
                    if let Some(from) = from
                        && let Some(transport) = transports.get(&from)
                    {
                        let res = match payload {
                            SignalingPayload::Offer { sdp, .. } => {
                                transport.handle_offer(sdp.clone()).await
                            }
                            SignalingPayload::Answer { sdp, .. } => {
                                transport.handle_answer(sdp.clone()).await
                            }
                            SignalingPayload::Ice { candidates, .. } => {
                                transport.handle_ice(candidates.clone()).await
                            }
                            _ => Ok(()),
                        };
                        if let Err(err) = res {
                            tracing::warn!("webrtc: applying signaling failed: {err}");
                        }
                    }
                }

                forward_transport_event(
                    &update_tx,
                    &forward_store,
                    TransportObservers {
                        verdict_revision_tx: &verdict_revision_tx,
                        notifications: Some(&notifications),
                        local_is_owner,
                    },
                    &room_id_owned,
                    &self_device_id,
                    owner_participant_id.as_deref(),
                    event,
                );
            }
        });

        tracing::info!(
            "started room runtime room={} outbox+ws subscribed",
            room_id.as_str()
        );
        Ok(())
    }

    /// On daemon boot, scan `rooms/` and start a runtime for every room
    /// whose policy hasn't expired. This is what lets a reviewer daemon
    /// (which joined via the `attn review join` CLI before launching the
    /// GUI) reconnect to its rooms on next start — without this, joined
    /// rooms sit cold on disk until the user manually re-joins.
    ///
    /// Returns the list of room ids that successfully started so the
    /// daemon can hand them to the frontend bridge for auto-navigation.
    pub fn resume_known_rooms(&self) -> Vec<RoomId> {
        let room_ids = match self.store.list_rooms() {
            Ok(ids) => ids,
            Err(err) => {
                tracing::warn!("list_rooms failed: {err}");
                return vec![];
            }
        };
        let mut resumed = Vec::new();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default();
        for room_id in room_ids {
            // Skip expired rooms so the daemon doesn't pile up dead WS
            // reconnect loops against rooms the relay will 4xx anyway.
            match self.store.load_room(&room_id) {
                Ok(Some(room)) if room.policy.expires_at <= now_ms => {
                    tracing::warn!(
                        "skipping expired room={} (expires_at={} now={})",
                        room_id.as_str(),
                        room.policy.expires_at,
                        now_ms
                    );
                    continue;
                }
                Ok(None) => continue,
                Err(err) => {
                    tracing::warn!("load_room failed for {}: {err}", room_id.as_str());
                    continue;
                }
                _ => {}
            }
            if let Err(err) = self.start_room_runtime(&room_id) {
                tracing::warn!("start_room_runtime failed for {}: {err}", room_id.as_str());
                continue;
            }
            // Tell the frontend a known room is live so its review store
            // hydrates `currentRoomId` and the ReviewBar / margin
            // surfaces appear. Without this push the reviewer's UI shows
            // only the local file tree even though the WS subscription
            // is already streaming inbound envelopes.
            //
            // The lifecycle string must be role-accurate: a room WE shared (a
            // local share binding exists) resumes as the owner's "Live"; a
            // room we joined resumes as "Joined". The frontend derives the
            // role from that string, so a neutral value leaves the role
            // 'unknown' and a restarted reviewer never flips back into the
            // shared-doc view (attn-6dd). Owners never flip — isReviewerView
            // requires role 'reviewer' — so a resumed share cannot hijack the
            // owner's local file view (attn-0wa).
            let is_owner =
                crate::review::bootstrap::find_path_for_room(self.store.root(), &room_id)
                    .ok()
                    .flatten()
                    .is_some();
            (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                room_id: room_id.clone(),
                status: if is_owner { "Live" } else { "Joined" }.to_string(),
            });
            // Re-feed the webview everything the room already imported in
            // earlier sessions. The WS mailbox resumes at its persisted
            // cursor, so the relay never re-delivers the envelopes behind
            // events.jsonl — without this replay a resumed reviewer (or a
            // restarted owner) renders "Waiting for the shared document…"
            // forever even though the snapshot sits on disk (attn-6dd).
            self.replay_room_to_webview(&room_id);
            resumed.push(room_id);
        }
        resumed
    }

    /// Replay a room's persisted state to the webview using the SAME
    /// `ReviewUpdate::EventImported` pushes the live inbound pipeline emits
    /// on fresh import (see `forward_transport_event`), in `events.jsonl`
    /// log order.
    ///
    /// `SnapshotCreated` events persist in wire form (`inline_snapshot:
    /// None`, decision #14); `rehydrate_snapshot_event` fills the plaintext
    /// from the local blob store at this IPC boundary exactly like the live
    /// forwarder does, so the webview receives the shared document's
    /// markdown and flips from "Waiting for the shared document…" to the
    /// snapshot view. Snapshots therefore ride the `reviewEvent` lane here
    /// too — that is the only snapshot delivery path the frontend store
    /// consumes (`applyEvent` mirrors `snapshot_created` events into its
    /// `snapshots` view).
    ///
    /// Safe to run before, after, or concurrently with live imports: the
    /// frontend dedups events by `eventId` and snapshots by `snapshotId`
    /// (`store.svelte.ts` `applyEvent`). Decode errors skip the bad line
    /// instead of aborting so one corrupt entry can't hide the rest of the
    /// log.
    pub(crate) fn replay_room_to_webview(&self, room_id: &RoomId) {
        if let Some(bootstrapper) = self.bootstrap.as_ref() {
            let identity = bootstrapper
                .config()
                .identity_dir()
                .and_then(|dir| crate::review::bootstrap::load_or_create_identity_in(&dir));
            match identity {
                Ok(identity) => {
                    if let Err(error) = self
                        .store
                        .reconcile_unread_from_events(room_id, identity.device_id.as_str())
                    {
                        tracing::warn!(
                            "could not reconcile unread cursor for room {}: {error:#}",
                            room_id.as_str()
                        );
                    }
                }
                Err(error) => tracing::warn!(
                    "could not load identity for unread reconciliation in room {}: {error}",
                    room_id.as_str()
                ),
            }
        }
        let events = match self.store.iter_events(room_id) {
            Ok(iter) => iter,
            Err(err) => {
                tracing::warn!("replay iter_events for {}: {err}", room_id.as_str());
                return;
            }
        };
        let mut replayed = 0usize;
        for entry in events {
            let mut event = match entry {
                Ok(event) => event,
                Err(err) => {
                    tracing::warn!(
                        "replay skipping undecodable event in {}: {err}",
                        room_id.as_str()
                    );
                    continue;
                }
            };
            rehydrate_snapshot_event(&self.store, room_id, &mut event);
            (self.update_tx)(ReviewUpdate::EventImported {
                room_id: room_id.clone(),
                event,
            });
            replayed += 1;
        }
        if replayed > 0 {
            tracing::info!(
                "replayed {replayed} persisted event(s) to the webview for room={}",
                room_id.as_str()
            );
        }
        match self.store.load_unread_state(room_id) {
            Ok(state) if state.unread_count > 0 => (self.update_tx)(ReviewUpdate::UnreadChanged {
                room_id: room_id.clone(),
                unread_count: state.unread_count,
            }),
            Ok(_) => {}
            Err(error) => tracing::warn!(
                "could not restore unread state for room {}: {error:#}",
                room_id.as_str()
            ),
        }
        match self.store.notification_muted(room_id) {
            Ok(true) => (self.update_tx)(ReviewUpdate::NotificationMuteChanged {
                room_id: room_id.clone(),
                muted: true,
            }),
            Ok(false) => {}
            Err(error) => tracing::warn!(
                "could not restore notification preference for room {}: {error:#}",
                room_id.as_str()
            ),
        }
    }

    /// Push a freshly-resolved anchor to the frontend.
    ///
    /// Issue attn-nnj.3.8: the callback path Rust → tao event loop →
    /// `window.__attn__.reviewAnchorResolution` exists end-to-end. The actual
    /// recompute-on-change scheduler (run resolver after doc edit, snapshot
    /// import, or manual override) lands with the later anchor-engine
    /// integration issue — this method is what that scheduler will call.
    pub fn emit_anchor_resolution(
        &self,
        room_id: RoomId,
        event_id: EventId,
        file_id: FileId,
        resolved: ResolvedAnchor,
    ) {
        (self.update_tx)(ReviewUpdate::AnchorResolutionChanged {
            room_id,
            event_id,
            file_id,
            resolved,
        });
    }

    // -------------------------------------------------------------------
    // Mode-aware transport selector (attn-nnj.7.5)
    // -------------------------------------------------------------------

    /// Materialize and persist the per-room transport handles for `room_id`
    /// according to `mode`. Replaces any prior handles for the same room.
    ///
    /// The selector validates the (mode, config) pair via
    /// `selector::build_room_transports`:
    ///   - `Live` needs `webrtc`,
    ///   - `Async` needs `mailbox`,
    ///   - `Hybrid` needs both.
    ///
    /// Returns a clone of the resolved `RoomTransports` for the caller's
    /// convenience (e.g. the bootstrap may want to read `mode` to decide
    /// which inbound connection to spin up next).
    pub async fn open_room_transports(
        &self,
        room_id: &RoomId,
        mode: TransportMode,
        config: TransportConfig,
    ) -> Result<TransportMode, TransportError> {
        let transports = selector::build_room_transports(mode, config)?;
        let mode = transports.mode;
        let shared = Arc::new(AsyncMutex::new(transports));
        let mut rooms = self.rooms.lock().await;
        rooms.insert(room_id.clone(), shared);
        Ok(mode)
    }

    /// Outbound dispatch — route a batch of envelopes through the right
    /// transport(s) for the room's current mode.
    ///
    /// Per `planning/collab/amendments.md` §Phase 4:
    ///   - `Live` sends via WebRTC; if the DataChannel is not connected, the
    ///     send fails and the manager surfaces a `ReviewUpdate::Error` with
    ///     `code: "ATTN_LIVE_REQUIRED"`. The mailbox is NOT touched.
    ///   - `Async` sends via mailbox only.
    ///   - `Hybrid` writes to both; the mailbox always-on outbox owns the
    ///     `serverSeq`s returned to the caller. The WebRTC arm is best-effort
    ///     when connected.
    ///
    /// `TransportError` failures from any path bubble up unchanged. The
    /// caller (typically the IPC layer or a higher-level command handler) is
    /// responsible for translating them into `ReviewUpdate::Error` if they
    /// need to surface to the UI; this method itself only emits the
    /// `ATTN_LIVE_REQUIRED` error update on the dedicated Live-mode failure
    /// path so the routing rule is observable from the manager's API.
    pub async fn send_envelopes(
        &self,
        room_id: &RoomId,
        envelopes: Vec<MailboxEnvelope>,
    ) -> Result<Vec<EnvelopeAck>, TransportError> {
        let shared = {
            let rooms = self.rooms.lock().await;
            rooms
                .get(room_id)
                .cloned()
                .ok_or(TransportError::RoomNotFound)?
        };
        let transports = shared.lock().await;
        let result = selector::send_envelopes(&transports, envelopes).await;
        if let Err(TransportError::Io(msg)) = &result
            && msg.contains(selector::LIVE_REQUIRED_CODE)
        {
            (self.update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: selector::LIVE_REQUIRED_CODE.to_string(),
                message: msg.clone(),
            });
        }
        result
    }

    /// Apply a mode transition for `room_id`. Supports only the documented
    /// safe transitions — see `selector::transition_mode`. The caller passes
    /// a freshly-constructed mailbox handle for Live -> Hybrid; for the
    /// Hybrid -> Async path the WebRTC handle is dropped (the manager does
    /// not own the underlying close path — the caller closes the
    /// `WebRtcTransport` separately).
    pub async fn transition_room_mode(
        &self,
        room_id: &RoomId,
        next: TransportMode,
        new_mailbox: Option<Arc<dyn selector::MailboxSender>>,
    ) -> Result<(), TransportError> {
        let shared = {
            let rooms = self.rooms.lock().await;
            rooms
                .get(room_id)
                .cloned()
                .ok_or(TransportError::RoomNotFound)?
        };
        let mut transports = shared.lock().await;
        selector::transition_mode(&mut transports, next, new_mailbox)
    }

    /// Read the current `TransportMode` for `room_id`, or `None` if the room
    /// has no transports open.
    pub async fn room_mode(&self, room_id: &RoomId) -> Option<TransportMode> {
        let shared = {
            let rooms = self.rooms.lock().await;
            rooms.get(room_id).cloned()?
        };
        let transports = shared.lock().await;
        Some(transports.mode)
    }

    // -------------------------------------------------------------------
    // RequestSnapshot live recovery (attn-nnj.7.6)
    // -------------------------------------------------------------------

    /// Register the identity + AEAD key material a room needs to mint
    /// signal / event envelopes. Called by the bootstrap pipeline once
    /// after `Share`/`Join` completes — the key derivation lives there;
    /// the manager just holds the resulting bytes.
    ///
    /// Re-registering overwrites the previous context — used when the
    /// owner rotates the targeted-peer device id between recovery rounds.
    pub async fn register_signal_context(&self, ctx: RoomSignalContext) {
        let mut guard = self.signal_contexts.write().await;
        guard.insert(ctx.room_id.clone(), Arc::new(ctx));
    }

    /// Read the current signal context for `room_id`. Returns `None` if
    /// no context has been registered (e.g. bootstrap has not yet run, or
    /// the room is on a path that does not need the recovery primitive).
    pub async fn signal_context(&self, room_id: &RoomId) -> Option<Arc<RoomSignalContext>> {
        let guard = self.signal_contexts.read().await;
        guard.get(room_id).cloned()
    }

    /// Ask a peer to re-send the latest snapshot for `file_id` over the
    /// live recovery path (amendments.md §Recovery from local-store loss):
    ///
    ///   "a `kind: \"request_snapshot\"` signal envelope, content =
    ///    `{ fileId, sinceSnapshotId? }`; owner responds with a fresh
    ///    `SnapshotCreated` event over the DataChannel"
    ///
    /// Routing rules (in priority order):
    ///   1. If a `WebRtcSender` is registered for the room AND it reports
    ///      `is_connected()`, mint a `SignalingPayload::RequestSnapshot`
    ///      and push it onto the transport's outbound signaling lane via
    ///      `WebRtcSender::publish_signal`. The DataChannel path on the
    ///      WebRTC arm forwards this envelope through the relay's
    ///      `kind=signal` channel (see `webrtc.rs::publish_signal`).
    ///   2. Otherwise (Async mode, or Hybrid with WebRTC down), mint the
    ///      same envelope and post it via the room's `MailboxSender` as
    ///      a `kind=signal` envelope. The relay's signal channel forwards
    ///      it to the targeted device.
    ///
    /// Returns `TransportError::RoomNotFound` if the room has no
    /// transports registered, and `TransportError::Io(...)` carrying a
    /// stable error code (`ATTN_NO_SIGNAL_CONTEXT`) when the room has
    /// transports but no registered signal context (i.e. the bootstrap
    /// has not finished priming the key material yet).
    pub async fn request_snapshot(
        &self,
        room_id: &RoomId,
        file_id: FileId,
        since_snapshot_id: Option<SnapshotId>,
    ) -> Result<(), TransportError> {
        // ---- 1. Look up the per-room signal context.
        let ctx = self
            .signal_context(room_id)
            .await
            .ok_or_else(|| TransportError::Io(NO_SIGNAL_CONTEXT_MESSAGE.into()))?;

        // ---- 2. Look up the room's transports. We need the (mailbox,
        //         webrtc) pair to decide which arm to publish onto.
        let shared = {
            let rooms = self.rooms.lock().await;
            rooms
                .get(room_id)
                .cloned()
                .ok_or(TransportError::RoomNotFound)?
        };
        let transports = shared.lock().await;

        // ---- 3. Build the inner plaintext payload. `from` is pinned to
        //         our `local_device_id` so the receiver can cross-check
        //         against the AAD-bound envelope `deviceId`.
        let payload = SignalingPayload::RequestSnapshot {
            file_id,
            since_snapshot_id,
            from: ctx.local_device_id.clone(),
        };

        // ---- 4. Prefer the WebRTC arm when connected — its
        //         `publish_signal` impl re-uses the existing
        //         signaling_tx → mailbox-forward task so we don't
        //         duplicate the assembly logic here.
        if let Some(webrtc) = transports.webrtc.as_ref()
            && webrtc.is_connected()
        {
            return webrtc.publish_signal(payload);
        }

        // ---- 5. Mailbox fallback. Mint the envelope locally and post
        //         it via the mailbox `kind=signal` lane. `client_nonce`
        //         is freshly random — we don't retry at this layer.
        let mailbox = transports
            .mailbox
            .as_ref()
            .ok_or_else(|| TransportError::Io(NO_SIGNAL_TRANSPORT_MESSAGE.into()))?;

        let now_ms = current_ms();
        let envelope = assemble_signal_envelope(
            payload,
            &ctx.signaling_key,
            &ctx.room_id,
            &ctx.author_id,
            &ctx.local_device_id,
            ctx.target_device_id.as_ref(),
            &fresh_client_nonce_16(),
            now_ms,
            now_ms + SIGNAL_TTL_MS,
        )
        .map_err(|e| TransportError::Io(format!("assemble request_snapshot signal: {e}")))?;
        let envelope = if ctx.protocol_version == 3 {
            crate::review::transport::signaling::authenticate_signal_envelope_v3(
                envelope,
                now_ms.max(0) as u64,
                &ctx.signing_key,
            )
            .map_err(|e| TransportError::Io(format!("authenticate request_snapshot signal: {e}")))?
        } else {
            envelope
        };

        mailbox.send_envelopes(vec![envelope]).await.map(|_| ())
    }

    /// Owner-side handler for an inbound `SignalingPayload::RequestSnapshot`.
    ///
    /// Per amendments.md §Recovery from local-store loss the owner
    /// responds by re-emitting the latest `SnapshotCreated` event for
    /// `file_id` over the DataChannel. We:
    ///
    ///   1. Resolve the latest `SnapshotNode` for `file_id` from the
    ///      local `ReviewStore` (skipping snapshots with
    ///      `created_at <= since_snapshot.created_at` if the requester
    ///      supplied `since_snapshot_id` — delta recovery).
    ///   2. Reconstruct a `ReviewEventBody::SnapshotCreated` referencing
    ///      that snapshot (the wire form carries `encryptedBlobRef`
    ///      only; the local plaintext stays off the wire per
    ///      amendments.md decision #14).
    ///   3. Assemble a fresh `kind=event` envelope under `event_key` +
    ///      `signing_key` from the room's `RoomSignalContext`.
    ///   4. Push it through the room's `WebRtcSender::send_envelopes`
    ///      (the DataChannel path). If WebRTC is down or the room has
    ///      no DataChannel, fall through to the mailbox arm — the
    ///      receiver's `InboundPipeline` dedups by `EventId` either way.
    ///
    /// Returns the assembled envelope on success so callers can echo it
    /// into their local replica + outbox without re-deriving (the
    /// owner's local store stays consistent with what it just sent).
    /// Returns `Ok(None)` when there is no snapshot newer than
    /// `since_snapshot_id` for `file_id` — the requester is already
    /// up to date and no response is owed.
    pub async fn handle_inbound_request_snapshot(
        &self,
        room_id: &RoomId,
        payload: &SignalingPayload,
    ) -> Result<Option<MailboxEnvelope>, TransportError> {
        let (file_id, since_snapshot_id) = match payload {
            SignalingPayload::RequestSnapshot {
                file_id,
                since_snapshot_id,
                ..
            } => (file_id.clone(), since_snapshot_id.clone()),
            other => {
                return Err(TransportError::Io(format!(
                    "handle_inbound_request_snapshot: expected RequestSnapshot, got {other:?}"
                )));
            }
        };

        let ctx = self
            .signal_context(room_id)
            .await
            .ok_or_else(|| TransportError::Io(NO_SIGNAL_CONTEXT_MESSAGE.into()))?;

        // ---- 1. Find the latest snapshot for the file.
        let latest = self
            .store
            .latest_snapshot_for_file(room_id, &file_id)
            .map_err(|e| TransportError::Io(format!("latest_snapshot_for_file: {e}")))?;
        let latest = match latest {
            Some(node) => node,
            // No snapshot at all — nothing to send back. This matches the
            // amendments.md "owner has been wiped too" branch — the caller
            // (mailbox WS / WebRTC dispatch) surfaces it as a stale-room
            // error rather than synthesizing a phantom event.
            None => return Ok(None),
        };

        // ---- 2. If the requester is already at-or-ahead of the latest,
        //         skip the response — they have nothing newer to learn.
        if let Some(since_id) = since_snapshot_id.as_ref()
            && let Some(since_node) = self
                .store
                .load_snapshot(room_id, since_id)
                .map_err(|e| TransportError::Io(format!("load_snapshot(since): {e}")))?
            && since_node.created_at >= latest.created_at
        {
            return Ok(None);
        }
        // If the since_snapshot_id is unknown to us locally we still
        // respond with the latest — the requester explicitly asked for
        // a newer snapshot than one we don't have, which is the
        // intended-recovery shape.

        // ---- 3. Build the SnapshotCreated event body. Per amendments
        //         decision #14 the wire form omits the local plaintext.
        let body = ReviewEventBody::SnapshotCreated {
            file_id: latest.file_id.clone(),
            snapshot_id: latest.snapshot_id.clone(),
            owner_display_path: None,
            parent_snapshot_id: latest.parent_snapshot_id.clone(),
            base_hash: latest.base_hash.clone(),
            encrypted_blob_ref: latest.encrypted_blob_ref.clone(),
            inline_snapshot: None,
        };

        // ---- 4. Mint a kind=event envelope under the room's event_key
        //         + signing_key. The receiver's InboundPipeline will
        //         verify + dedup by EventId — re-sends of the same
        //         (latest) snapshot collapse to a single import.
        let now_ms = current_ms();
        // `DeviceSigningKey` is move-only by design — clone via the seed
        // round-trip so we don't take ownership out of the registered
        // context. `from_bytes` only fails on corrupted-seed inputs, and
        // the seed bytes we just round-tripped through `to_bytes()` are
        // by construction valid; treat any failure as a hard `Io`.
        let signing_key = DeviceSigningKey::from_bytes(&ctx.signing_key.to_bytes())
            .map_err(|e| TransportError::Io(format!("clone signing key: {e}")))?;
        let envelope = assemble_event_envelope(AssembleInput {
            event_key: ctx.event_key,
            signing_key,
            room_id: ctx.room_id.clone(),
            author_id: ctx.author_id.clone(),
            device_id: ctx.local_device_id.clone(),
            created_at_ms: now_ms as u64,
            expires_at_ms: (now_ms + SIGNAL_TTL_MS) as u64,
            parent_event_ids: vec![],
            snapshot_id: Some(latest.snapshot_id.clone()),
            body,
            kind: EnvelopeKind::Event,
            client_nonce: None,
        })
        .map_err(|e| TransportError::Io(format!("assemble SnapshotCreated event: {e}")))?;

        // ---- 5. Send via the room's transports. We send via WebRTC
        //         (DataChannel) when connected — amendments.md pins this
        //         as the response carrier — and fall back to mailbox
        //         otherwise so a peer whose channel went down mid-recovery
        //         still receives the event on the next online cycle.
        let shared = {
            let rooms = self.rooms.lock().await;
            rooms
                .get(room_id)
                .cloned()
                .ok_or(TransportError::RoomNotFound)?
        };
        let transports = shared.lock().await;

        if let Some(webrtc) = transports.webrtc.as_ref()
            && webrtc.is_connected()
        {
            webrtc.send_envelopes(vec![envelope.clone()]).await?;
            return Ok(Some(envelope));
        }

        if let Some(mailbox) = transports.mailbox.as_ref() {
            mailbox.send_envelopes(vec![envelope.clone()]).await?;
            return Ok(Some(envelope));
        }

        Err(TransportError::Io(NO_SIGNAL_TRANSPORT_MESSAGE.into()))
    }
}

/// Stable error-message text surfaced when `request_snapshot` is invoked
/// before a `RoomSignalContext` has been registered. Includes the code
/// `ATTN_NO_SIGNAL_CONTEXT` so the frontend's `ReviewUpdate::Error`
/// branch can pattern-match on a stable token rather than the freeform
/// message.
pub const NO_SIGNAL_CONTEXT_MESSAGE: &str =
    "ATTN_NO_SIGNAL_CONTEXT: no signal context registered for room";

/// Stable error-message text surfaced when neither a WebRTC nor a mailbox
/// transport is available for a recovery send.
pub const NO_SIGNAL_TRANSPORT_MESSAGE: &str =
    "ATTN_NO_SIGNAL_TRANSPORT: no live transport for room";

/// TTL for signal/recovery envelopes — same 7-day window the WebRTC arm
/// uses (see `webrtc.rs::SIGNAL_TTL_MS`). The relay applies its own
/// shorter retention to signal envelopes but the wire field is uniform.
const SIGNAL_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Wall-clock millis-since-epoch. Pulled out as a free function so the
/// recovery path doesn't depend on the WebRTC arm's `Clock` trait — the
/// recovery callers always use real wall-clock time.
fn current_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Fresh 16-byte client nonce for signal-envelope id derivation. Matches
/// `webrtc::fresh_client_nonce` byte-for-byte so a future merge of the
/// two callers is trivial.
fn fresh_client_nonce_16() -> [u8; 16] {
    let mut nonce = [0u8; 16];
    let _ = getrandom::getrandom(&mut nonce);
    nonce
}

/// Translate a user-supplied mode string (`"live"`, `"async"`, `"hybrid"`)
/// into the typed `RoomMode`. Defaults to `Async` for unknown values so
/// callers don't have to special-case an empty/bad mode at the IPC layer —
/// the bootstrap pipeline's relay request will reflect the chosen mode but
/// the policy hard-cap stays the same regardless.
fn mode_from_str(mode: &str) -> RoomMode {
    match mode.to_ascii_lowercase().as_str() {
        "live" => RoomMode::Live,
        "hybrid" => RoomMode::Hybrid,
        _ => RoomMode::Async,
    }
}

/// Map a `BootstrapError` to a short stable error code for the frontend.
/// Kept here rather than as a `Display` impl on the error so the wire string
/// is independent of how the error is rendered in logs/devtools.
fn error_code(err: &crate::review::bootstrap::BootstrapError) -> String {
    use crate::review::bootstrap::BootstrapError;
    match err {
        BootstrapError::Identity(_) => "ATTN_IDENTITY".to_string(),
        BootstrapError::Crypto(_) => "ATTN_CRYPTO".to_string(),
        BootstrapError::Relay { code, .. } => code.clone(),
        BootstrapError::Network(_) => "ATTN_NETWORK".to_string(),
        BootstrapError::InviteParse(_) => "ATTN_INVITE_PARSE".to_string(),
        BootstrapError::InvalidShare(_) => "ATTN_INVALID_SHARE".to_string(),
        BootstrapError::Store(_) => "ATTN_STORE".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Stub update generation
// ---------------------------------------------------------------------------

/// The command's variant name only — for logging without spilling payloads
/// (comment/suggestion plaintext, collab steps) to stderr.
/// How a collab signal should be routed given the live mesh state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CollabRouting {
    /// Send over every currently-connected DataChannel.
    send_over_channels: bool,
    /// Also enqueue on the relay (covers peers not reachable over the mesh).
    use_relay: bool,
}

/// Decide collab routing from its wire kind plus `(peer_count,
/// connected_count)` — the room's peer count and how many have a Connected
/// DataChannel right now (attn-7qv).
///
/// - Cursor/view presence uses connected DataChannels only and never relays.
/// - Send over channels whenever at least one peer is connected.
/// - Use the relay UNLESS the mesh is complete (every peer connected). An
///   incomplete mesh (including a not-yet-formed one, or one a no-TURN
///   symmetric NAT can never complete) relays so the un-meshable peer(s) still
///   receive it; a complete mesh skips the relay to keep cost off it.
///
/// Double-delivery to connected peers under an incomplete mesh is intentional
/// and safe — collab is idempotent on the receiver.
fn decide_collab_routing(
    kind: CollabWireKind,
    peer_count: usize,
    connected_count: usize,
) -> CollabRouting {
    let complete_mesh = peer_count > 0 && connected_count == peer_count;
    CollabRouting {
        send_over_channels: connected_count > 0,
        use_relay: kind != CollabWireKind::Cursor && !complete_mesh,
    }
}

fn review_command_name(cmd: &ReviewCommand) -> &'static str {
    match cmd {
        ReviewCommand::Share { .. } => "Share",
        ReviewCommand::CreateDurableShare { .. } => "CreateDurableShare",
        ReviewCommand::RenewDurableShare { .. } => "RenewDurableShare",
        ReviewCommand::RevokeDurableShare { .. } => "RevokeDurableShare",
        ReviewCommand::OpenDurableShare { .. } => "OpenDurableShare",
        ReviewCommand::Join { .. } => "Join",
        ReviewCommand::JoinAsAgent { .. } => "JoinAsAgent",
        ReviewCommand::Pull { .. } => "Pull",
        ReviewCommand::Stop { .. } => "Stop",
        ReviewCommand::Inbox => "Inbox",
        ReviewCommand::CreateComment { .. } => "CreateComment",
        ReviewCommand::CreateSuggestion { .. } => "CreateSuggestion",
        ReviewCommand::AcceptSuggestion { .. } => "AcceptSuggestion",
        ReviewCommand::RejectSuggestion { .. } => "RejectSuggestion",
        ReviewCommand::ResolveAnchor { .. } => "ResolveAnchor",
        ReviewCommand::ReportHtmlAnchorResolution { .. } => "ReportHtmlAnchorResolution",
        ReviewCommand::ResolveComment { .. } => "ResolveComment",
        ReviewCommand::ReopenComment { .. } => "ReopenComment",
        ReviewCommand::SendCollab { .. } => "SendCollab",
        ReviewCommand::PublishSnapshot { .. } => "PublishSnapshot",
        ReviewCommand::ReannounceIdentity => "ReannounceIdentity",
        ReviewCommand::SetViewState { .. } => "SetViewState",
        ReviewCommand::SetNotificationMuted { .. } => "SetNotificationMuted",
    }
}

/// Build a sensible no-op `ReviewUpdate` for a given command. Centralized so
/// the scaffold contract is testable in one place and so future handlers can
/// progressively replace each arm with real work without touching `submit`.
fn stub_update_for(cmd: &ReviewCommand) -> ReviewUpdate {
    match cmd {
        // TODO(attn-nnj.3a/3b): create the room runtime, persist `ReviewRoom`,
        // mint owner identity, kick off transport, emit a real RoomStatus.
        ReviewCommand::Share { path, mode, .. } => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: format!(
                "Pending share — not yet implemented (path={}, mode={})",
                path.display(),
                mode
            ),
        },
        ReviewCommand::CreateDurableShare { path } => ReviewUpdate::Error {
            room_id: None,
            code: "ATTN_DURABLE_SHARE_UNAVAILABLE".into(),
            message: format!(
                "durable share service is unavailable (path={})",
                path.display()
            ),
        },
        ReviewCommand::RenewDurableShare { target } => ReviewUpdate::Error {
            room_id: None,
            code: "ATTN_DURABLE_SHARE_UNAVAILABLE".into(),
            message: format!(
                "durable share service is unavailable (target={})",
                target.as_deref().unwrap_or("all")
            ),
        },
        ReviewCommand::RevokeDurableShare { target } => ReviewUpdate::Error {
            room_id: None,
            code: "ATTN_DURABLE_SHARE_UNAVAILABLE".into(),
            message: format!("durable share service is unavailable (target={target})"),
        },
        ReviewCommand::OpenDurableShare { share_id, .. } => ReviewUpdate::Error {
            room_id: None,
            code: "ATTN_NOT_IMPLEMENTED".into(),
            message: format!("durable share resolution is not wired yet (shareId={share_id})"),
        },
        // TODO(attn-nnj.3b): parse invite, open transport, fetch snapshot, emit
        // RoomStatus + SnapshotCreated as data arrives.
        ReviewCommand::Join { invite: _ } => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: "Pending join — invite accepted for processing".to_string(),
        },
        ReviewCommand::JoinAsAgent { invite: _ } => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: "Pending join — invite accepted for processing".to_string(),
        },
        // Pull / Stop / Inbox are handled for real in `submit` (they drive the
        // per-room runtime registries) and always return before reaching here.
        // These arms keep the match exhaustive; they are not reached in
        // practice.
        ReviewCommand::Pull { room_id } => ReviewUpdate::RoomStatusChanged {
            room_id: room_id.clone().unwrap_or_else(stub_room_id),
            status: "Pulled".to_string(),
        },
        ReviewCommand::Stop { room_id } => ReviewUpdate::RoomStatusChanged {
            room_id: room_id.clone().unwrap_or_else(stub_room_id),
            status: "Stopped".to_string(),
        },
        ReviewCommand::Inbox => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: "Inbox".to_string(),
        },
        // CreateComment / CreateSuggestion fall through to the real path
        // in `submit` when a Bootstrapper is attached; the stub here only
        // fires when the manager was built without one (smoke tests that
        // don't need network). We synthesize a placeholder
        // `ReviewEventBody::CommentCreated` so the wire shape lines up with
        // the production path.
        ReviewCommand::CreateComment {
            room_id,
            anchor,
            body,
            ..
        } => ReviewUpdate::EventImported {
            room_id: room_id.clone(),
            event: stub_review_event(
                room_id,
                crate::review::model::ReviewEventBody::CommentCreated {
                    thread_id: "stub-thread".to_string(),
                    anchor: anchor.clone(),
                    body: body.clone(),
                },
            ),
        },
        ReviewCommand::CreateSuggestion { room_id, draft } => ReviewUpdate::EventImported {
            room_id: room_id.clone(),
            event: stub_review_event(
                room_id,
                crate::review::model::ReviewEventBody::SuggestionCreated {
                    suggestion_id: "stub-suggestion".to_string(),
                    anchor: draft.anchor.clone(),
                    operation: draft.operation.clone(),
                    note: draft.note.clone(),
                },
            ),
        },
        // TODO(Phase 5): run guarded apply flow, write working copy, emit
        // SuggestionAccepted event + AnchorResolutionChanged for affected
        // anchors. The stub still emits the matching event shape.
        ReviewCommand::AcceptSuggestion {
            room_id,
            suggestion_id,
        } => ReviewUpdate::EventImported {
            room_id: room_id.clone(),
            event: stub_review_event(
                room_id,
                crate::review::model::ReviewEventBody::SuggestionAccepted {
                    suggestion_id: format!("{:?}", suggestion_id),
                    applied_revision_id: "stub-revision".to_string(),
                    resulting_hash: stub_content_hash(),
                },
            ),
        },
        // TODO(attn-nnj.3.4 integration): persist override in store, re-run
        // resolver for the event, emit AnchorResolutionChanged with the chosen
        // range. The scaffold echoes the caller's manual range as a confident
        // `Remapped` verdict so the frontend store wiring is observable.
        ReviewCommand::ResolveAnchor {
            room_id,
            event_id,
            range,
        } => ReviewUpdate::AnchorResolutionChanged {
            room_id: room_id.clone(),
            event_id: event_id.clone(),
            file_id: stub_file_id(),
            resolved: ResolvedAnchor::Remapped {
                confidence: 1.0,
                current_range: range.clone(),
                reason: crate::review::model::RemappedReason::QuoteMatch,
            },
        },
        // Client-reported HTML resolution needs no bootstrapper (it mints
        // nothing), but it does need the store to find the event's fileId, so
        // without one the stub echoes the verdict against a placeholder file.
        ReviewCommand::ReportHtmlAnchorResolution {
            room_id,
            event_id,
            status,
            confidence,
            range,
        } => ReviewUpdate::AnchorResolutionChanged {
            room_id: room_id.clone(),
            event_id: event_id.clone(),
            file_id: stub_file_id(),
            resolved: match (status, range) {
                (HtmlResolutionStatus::Exact, Some(range)) => ResolvedAnchor::Exact {
                    confidence: confidence.clamp(0.0, 1.0),
                    current_range: range.clone(),
                    reason: crate::review::model::ExactReason::ClientResolved,
                },
                (HtmlResolutionStatus::Remapped, Some(range)) => ResolvedAnchor::Remapped {
                    confidence: confidence.clamp(0.0, 1.0),
                    current_range: range.clone(),
                    reason: crate::review::model::RemappedReason::ClientResolved,
                },
                (HtmlResolutionStatus::Ambiguous, _) => ResolvedAnchor::Ambiguous {
                    candidates: Vec::new(),
                    reason: "document frame found more than one equally good match".to_string(),
                },
                _ => ResolvedAnchor::Stale {
                    reason: "document frame could not find the anchored content".to_string(),
                },
            },
        },
        // ResolveComment goes through the real bootstrap path in `submit`
        // (mints a CommentResolved event). Without a bootstrapper this stub
        // just keeps the dispatch contract total.
        ReviewCommand::ResolveComment { room_id, .. } => ReviewUpdate::RoomStatusChanged {
            room_id: room_id.clone(),
            status: "Pending resolve-comment — no bootstrap attached".to_string(),
        },
        ReviewCommand::ReopenComment { room_id, .. } => ReviewUpdate::RoomStatusChanged {
            room_id: room_id.clone(),
            status: "Pending reopen-comment — no bootstrap attached".to_string(),
        },
        // PublishSnapshot goes through the real bootstrap path in `submit`
        // when one is attached. Without a bootstrapper (smoke tests) it's a
        // no-op — surface a benign status so the dispatch contract stays
        // total.
        ReviewCommand::PublishSnapshot { .. } => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: "Pending snapshot publish — no bootstrap attached".to_string(),
        },
        // SendCollab requires a live bootstrap+runtime; without one (smoke
        // tests) it's a benign no-op surfaced as status.
        ReviewCommand::SendCollab { .. } => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: "Pending collab send — no bootstrap attached".to_string(),
        },
        // RejectSuggestion mints an event via the outbox; without a bootstrap
        // (smoke tests) it's a benign no-op surfaced as status.
        ReviewCommand::RejectSuggestion { .. } => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: "Pending suggestion reject — no bootstrap attached".to_string(),
        },
        // ReannounceIdentity iterates active rooms in `submit`; without a
        // bootstrap (smoke tests) it's a benign no-op surfaced as status.
        ReviewCommand::ReannounceIdentity => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: "Pending identity reannounce — no bootstrap attached".to_string(),
        },
        ReviewCommand::SetViewState { room_id, .. } => ReviewUpdate::UnreadChanged {
            room_id: room_id.clone(),
            unread_count: 0,
        },
        ReviewCommand::SetNotificationMuted { room_id, muted } => {
            ReviewUpdate::NotificationMuteChanged {
                room_id: room_id.clone(),
                muted: *muted,
            }
        }
    }
}

/// Synthesize a placeholder `RoomId` for stub updates that don't have a real
/// one to reference yet. Real handlers will derive ids via
/// `crypto::kdf::derive_room_id`.
fn stub_room_id() -> RoomId {
    // Going through serde keeps id construction routed through the same path
    // the rest of the codebase uses (the `new` constructor is crate-private).
    serde_json::from_value::<RoomId>(serde_json::Value::String(
        "room-stub-pending-implementation".to_string(),
    ))
    .expect("stub RoomId deserializes")
}

/// Synthesize a placeholder `EventId` for stub updates.
fn stub_event_id() -> EventId {
    serde_json::from_value::<EventId>(serde_json::Value::String(
        "evt-stub-pending-implementation".to_string(),
    ))
    .expect("stub EventId deserializes")
}

/// Synthesize a placeholder `FileId` for stub anchor-resolution updates.
/// Real handlers will look up the FileId from the room/event mapping.
fn stub_file_id() -> FileId {
    serde_json::from_value::<FileId>(serde_json::Value::String(
        "file-stub-pending-implementation".to_string(),
    ))
    .expect("stub FileId deserializes")
}

/// Mint a fresh thread / suggestion id. Random 16-byte base64url; the
/// frontend treats these as opaque keys. Real implementations must mint
/// these here (not on the frontend) because the value participates in
/// event-id derivation — the bridge would otherwise need a round-trip.
fn mint_thread_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Fall back to a deterministic-ish id rather than panic the IPC
        // worker. The frontend treats thread_id as opaque.
        let now = unix_now_ms_for_manager();
        return format!("thread-fallback-{now}");
    }
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn unix_now_ms_for_manager() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Build a placeholder `ReviewEvent` for the no-bootstrap stub paths so
/// the manager's wire shape stays consistent across configurations.
/// Real callers go through `Bootstrapper::send_event_sync` which signs
/// and AEAD-encrypts. The stub uses non-cryptographic placeholders since
/// nothing reads `meta.event_id` / `auth` off these paths.
fn stub_review_event(
    room_id: &RoomId,
    body: crate::review::model::ReviewEventBody,
) -> crate::review::model::ReviewEvent {
    use crate::review::model::{EventAuth, EventMeta, ReviewEvent};
    let participant = serde_json::from_value::<ParticipantId>(serde_json::Value::String(
        "stub-participant".to_string(),
    ))
    .expect("stub ParticipantId deserializes");
    let device =
        serde_json::from_value::<DeviceId>(serde_json::Value::String("stub-device".to_string()))
            .expect("stub DeviceId deserializes");
    ReviewEvent {
        meta: EventMeta {
            v: 2,
            event_id: stub_event_id(),
            room_id: room_id.clone(),
            author_id: participant,
            device_id: device,
            created_at: unix_now_ms_for_manager(),
            parent_event_ids: vec![],
            snapshot_id: None,
        },
        body,
        auth: EventAuth {
            signing_key_id: "stub-keyid".to_string(),
            signature: "stub-sig".to_string(),
        },
    }
}

/// `DeviceKeyRefresher` impl that re-fetches the room's device directory
/// through the `Bootstrapper` and merges it into the shared verifying-key
/// cache. Wired into `MailboxWsClient` so a late joiner's first event
/// (which arrives before the owner has that device's key) triggers a
/// refresh + import retry instead of being dropped as `UnknownSigner`.
struct BootstrapKeyRefresher {
    bootstrap: Arc<Bootstrapper>,
    room_id: RoomId,
    cache: VerifyingKeyCache,
    authorizations: AuthorizationCache,
}

#[async_trait::async_trait]
impl crate::review::transport::DeviceKeyRefresher for BootstrapKeyRefresher {
    async fn refresh(&self) -> Result<usize, String> {
        self.bootstrap
            .refresh_device_authorizations(&self.room_id, &self.cache, &self.authorizations)
            .await
            .map_err(|e| e.to_string())
    }
}

/// Fill `inline_snapshot` on a `SnapshotCreated` event from the locally
/// persisted snapshot blob before the event crosses the IPC boundary.
///
/// The wire form never inlines the plaintext (decision #14) — the bytes
/// travel as a `kind=snapshot_blob` envelope which the WS client persists
/// via `ReviewStore::save_snapshot_blob` (resolving R2 spillover when
/// needed). The frontend, however, renders straight from
/// `body.inlineSnapshot`, so this is where the two meet: load the blob the
/// event references, verify it against the signed event's `BlobRef`
/// (length + content hash), and inline it.
///
/// Missing blob is a soft failure — the event still surfaces (the reviewer
/// sees the room; the snapshot fills in on a later replay) and we log the
/// gap. The blob-before-event outbox ordering makes this rare: by the time
/// the event arrives, the blob envelope has already been processed.
fn rehydrate_snapshot_event(
    store: &crate::review::store::ReviewStore,
    room_id: &RoomId,
    event: &mut crate::review::model::ReviewEvent,
) {
    use crate::review::model::ReviewEventBody;

    let ReviewEventBody::SnapshotCreated {
        inline_snapshot, ..
    } = &mut event.body
    else {
        return;
    };
    // `inlineSnapshot` is local-only. Never trust a sender-provided value: a
    // malicious but authorized publisher could otherwise bypass BlobRef,
    // baseHash, anchor-index, and manifest-entry binding checks by putting
    // plaintext directly in the signed event.
    *inline_snapshot = None;
    let plaintext = match load_validated_snapshot_plaintext(store, room_id, event) {
        Ok(plaintext) => plaintext,
        Err(err) => {
            tracing::warn!("snapshot hydration rejected: {err}");
            return;
        }
    };
    if plaintext.doc_type == crate::review::model::DocType::WorkspaceManifest
        && let Err(err) = validate_workspace_manifest_binding(store, room_id, event, &plaintext)
    {
        tracing::warn!("workspace manifest hydration rejected: {err}");
        return;
    }
    let is_manifest = plaintext.doc_type == crate::review::model::DocType::WorkspaceManifest;
    if let ReviewEventBody::SnapshotCreated {
        inline_snapshot, ..
    } = &mut event.body
    {
        *inline_snapshot = Some(plaintext);
    }
    // Explicit native shares use portable root-relative paths on the wire.
    // Only the owner has the private local-share record needed to restore an
    // absolute path for native file-tree and room-focus behavior.
    if !is_manifest
        && let ReviewEventBody::SnapshotCreated {
            owner_display_path: Some(display_path),
            ..
        } = &mut event.body
    {
        match crate::review::bootstrap::local_owner_display_path(
            store.root(),
            room_id,
            display_path,
        ) {
            Ok(Some(local_path)) => *display_path = local_path,
            Ok(None) => {}
            Err(error) => tracing::warn!("could not resolve local owner display path: {error}"),
        }
    }
}

/// Load and validate one persisted snapshot without recursively hydrating any
/// other event. The event has already passed envelope signature and room
/// authorization checks before `InboundPipeline` appends it to `events.jsonl`.
/// Checking its signed `BlobRef` and `baseHash` here therefore extends that
/// authentication to both the snapshot JSON and its recovered raw bytes.
fn load_validated_snapshot_plaintext(
    store: &crate::review::store::ReviewStore,
    room_id: &RoomId,
    event: &crate::review::model::ReviewEvent,
) -> Result<crate::review::model::SnapshotPlaintext, String> {
    use crate::review::crypto::ids::content_hash;
    use crate::review::model::{DocType, ReviewEventBody, SnapshotPlaintext};

    let ReviewEventBody::SnapshotCreated {
        encrypted_blob_ref: Some(blob_ref),
        snapshot_id,
        base_hash,
        ..
    } = &event.body
    else {
        return Err("SnapshotCreated event has no encrypted BlobRef".to_string());
    };
    let bytes = store
        .load_snapshot_blob(room_id, &blob_ref.blob_id)
        .map_err(|err| format!("load snapshot blob {}: {err}", blob_ref.blob_id))?
        .ok_or_else(|| {
            format!(
                "snapshot {} references blob {} not (yet) in local store",
                snapshot_id.as_str(),
                blob_ref.blob_id
            )
        })?;
    if bytes.len() as u64 != blob_ref.byte_length || content_hash(&bytes) != blob_ref.content_hash {
        return Err(format!(
            "snapshot blob {} failed signed BlobRef integrity check",
            blob_ref.blob_id
        ));
    }
    let plaintext = serde_json::from_slice::<SnapshotPlaintext>(&bytes).map_err(|err| {
        format!(
            "snapshot blob {} did not parse as SnapshotPlaintext: {err}",
            blob_ref.blob_id
        )
    })?;
    plaintext.validate().map_err(|err| {
        format!(
            "snapshot blob {} failed payload validation: {err}",
            blob_ref.blob_id
        )
    })?;
    let raw_bytes = plaintext.raw_content_bytes().map_err(|err| {
        format!(
            "snapshot blob {} failed raw-content recovery: {err}",
            blob_ref.blob_id
        )
    })?;
    if content_hash(&raw_bytes) != *base_hash {
        return Err(format!(
            "snapshot blob {} raw content does not match signed baseHash",
            blob_ref.blob_id
        ));
    }
    if let (DocType::Markdown, Some(index)) = (plaintext.doc_type, plaintext.anchor_index.as_ref())
    {
        let expected = crate::review::anchors::index::build_anchor_index(&raw_bytes, snapshot_id)
            .map_err(|err| {
            format!(
                "snapshot blob {} anchorIndex rebuild failed: {err}",
                blob_ref.blob_id
            )
        })?;
        if expected != *index {
            return Err(format!(
                "snapshot blob {} carries a non-canonical anchorIndex",
                blob_ref.blob_id
            ));
        }
    }
    Ok(plaintext)
}

/// Bind a workspace manifest to the exact authenticated entry events that
/// precede it in the durable room log. A valid manifest cannot invent an
/// entry, relabel an asset, move a path, or point at bytes other than those
/// vouched for by each entry event's signed `BlobRef` and `baseHash`.
fn validate_workspace_manifest_binding(
    store: &crate::review::store::ReviewStore,
    room_id: &RoomId,
    manifest_event: &crate::review::model::ReviewEvent,
    plaintext: &crate::review::model::SnapshotPlaintext,
) -> Result<(), String> {
    use crate::review::crypto::ids::derive_workspace_manifest_file_id;
    use crate::review::model::ReviewEventBody;

    let ReviewEventBody::SnapshotCreated {
        file_id: manifest_file_id,
        ..
    } = &manifest_event.body
    else {
        return Err("workspace manifest payload is not attached to SnapshotCreated".to_string());
    };
    let manifest = plaintext
        .manifest
        .as_ref()
        .ok_or_else(|| "workspace manifest payload is missing its manifest".to_string())?;

    // Every joined/owned room persists the invite secret before starting its
    // transport. It is therefore available at this production hydration
    // boundary and lets native receivers reject an ordinary file masquerading
    // as the room's one synthetic manifest document.
    let room_secret = crate::review::bootstrap::load_room_secret(store.root(), room_id)
        .map_err(|err| format!("load room secret for manifest FileId binding: {err}"))?;
    let expected_manifest_file_id = derive_workspace_manifest_file_id(&room_secret);
    if *manifest_file_id != expected_manifest_file_id {
        return Err(
            "manifest event fileId is not the room's synthetic manifest FileId".to_string(),
        );
    }

    let mut earlier_snapshots = Vec::new();
    let mut found_manifest_event = false;
    for stored in store
        .iter_events(room_id)
        .map_err(|err| format!("iterate room events for manifest binding: {err}"))?
    {
        let stored = stored.map_err(|err| format!("decode earlier room event: {err}"))?;
        if stored.meta.event_id == manifest_event.meta.event_id {
            found_manifest_event = true;
            break;
        }
        if matches!(stored.body, ReviewEventBody::SnapshotCreated { .. }) {
            earlier_snapshots.push(stored);
        }
    }
    if !found_manifest_event {
        return Err("manifest event is absent from the authenticated room log".to_string());
    }

    for entry in &manifest.entries {
        let matching: Vec<_> = earlier_snapshots
            .iter()
            .filter(|candidate| {
                matches!(
                    &candidate.body,
                    ReviewEventBody::SnapshotCreated {
                        file_id,
                        snapshot_id,
                        ..
                    } if file_id == &entry.file_id && snapshot_id == &entry.snapshot_id
                )
            })
            .collect();
        let [candidate] = matching.as_slice() else {
            return Err(format!(
                "manifest entry {} must match exactly one earlier SnapshotCreated event",
                entry.path
            ));
        };
        let ReviewEventBody::SnapshotCreated {
            owner_display_path, ..
        } = &candidate.body
        else {
            unreachable!("candidate filter only admits SnapshotCreated");
        };
        if owner_display_path.as_deref() != Some(entry.path.as_str()) {
            return Err(format!(
                "manifest entry {} does not match the event's normalized ownerDisplayPath",
                entry.path
            ));
        }
        let entry_payload = load_validated_snapshot_plaintext(store, room_id, candidate)
            .map_err(|err| format!("manifest entry {}: {err}", entry.path))?;
        manifest
            .validate_entry_payload(entry, &entry_payload)
            .map_err(|err| format!("manifest entry {}: {err}", entry.path))?;
    }
    Ok(())
}

/// Translate a `TransportEvent` from the mailbox WS subscriber into the
/// matching `ReviewUpdate` so the frontend store reflects inbound events
/// in real time. Lives outside `impl ReviewManager` so the spawned task
/// only needs the `UpdateSink` clone (not the full manager).
struct TransportObservers<'a> {
    verdict_revision_tx: &'a tokio::sync::watch::Sender<u64>,
    notifications: Option<&'a Arc<ReviewNotifications>>,
    local_is_owner: bool,
}

fn forward_transport_event(
    update_tx: &UpdateSink,
    store: &crate::review::store::ReviewStore,
    observers: TransportObservers<'_>,
    room_id: &RoomId,
    self_device_id: &str,
    owner_participant_id: Option<&str>,
    event: crate::review::transport::TransportEvent,
) {
    use crate::review::transport::{PresenceEvent, TransportEvent};
    match event {
        TransportEvent::EventImported {
            room_id: rid,
            mut event,
            newly_imported,
        } => {
            let is_verdict = matches!(
                &event.body,
                ReviewEventBody::SuggestionAccepted { .. }
                    | ReviewEventBody::SuggestionRejected { .. }
            );
            tracing::debug!(
                event_id = event.meta.event_id.as_str(),
                body_type = review_event_body_name(&event.body),
                "forwarding imported review event to webview"
            );
            if newly_imported
                && event.meta.device_id.as_str() != self_device_id
                && matches!(
                    &event.body,
                    ReviewEventBody::CommentCreated { .. }
                        | ReviewEventBody::SuggestionCreated { .. }
                        | ReviewEventBody::SuggestionAccepted { .. }
                        | ReviewEventBody::SuggestionRejected { .. }
                )
            {
                match store.record_unread_event(&rid, &event.meta.event_id) {
                    Ok(state) => (update_tx)(ReviewUpdate::UnreadChanged {
                        room_id: rid.clone(),
                        unread_count: state.unread_count,
                    }),
                    Err(error) => tracing::warn!(
                        "could not persist unread import for room {}: {error:#}",
                        rid.as_str()
                    ),
                }
                if let Some(notifications) = observers.notifications {
                    let (kind, file_display) = summary_for_event(store, &rid, &event.body);
                    notifications.enqueue(rid.clone(), kind, file_display);
                }
            }
            rehydrate_snapshot_event(store, &rid, &mut event);
            (update_tx)(ReviewUpdate::EventImported {
                room_id: rid,
                event,
            });
            if is_verdict {
                observers.verdict_revision_tx.send_modify(|revision| {
                    *revision = revision.wrapping_add(1);
                });
            }
        }
        TransportEvent::Envelope { .. } => {
            // Already covered by EventImported (events) / handled elsewhere
            // for signaling. Snapshot envelopes will get their own
            // ReviewUpdate variant in the snapshot pipeline; today they
            // just persist via the InboundPipeline.
        }
        TransportEvent::Hello {
            devices,
            online_device_ids,
            ..
        } => {
            // A Hello means our relay socket subscribed — we're live on the
            // mailbox transport. Surface that to the connection badge first.
            (update_tx)(ReviewUpdate::ConnectionChanged {
                room_id: room_id.clone(),
                connection: "mailbox".to_string(),
            });
            // Authoritative full roster on (re)connect — replace the store's
            // peer list with everyone the relay reports, minus ourselves.
            let peers = devices
                .iter()
                .filter(|d| {
                    d.device_id.as_str() != self_device_id
                        && online_device_ids.contains(&d.device_id)
                })
                .map(|d| peer_presence_from_device(d, owner_participant_id))
                .collect::<Vec<_>>();
            (update_tx)(ReviewUpdate::PresenceChanged {
                room_id: room_id.clone(),
                peers,
                replace: true,
            });
        }
        TransportEvent::Presence {
            event,
            device_id,
            participant_id,
        } => {
            // Single join/leave delta — skip our own echo, then upsert one
            // chip. The relay doesn't carry the peer's device client kind on
            // the presence frame, so kind is inferred from owner identity.
            if device_id.as_str() == self_device_id {
                return;
            }
            let online = matches!(event, PresenceEvent::Join);
            let kind = participant_kind_for(&participant_id, owner_participant_id, None);
            (update_tx)(ReviewUpdate::PresenceChanged {
                room_id: room_id.clone(),
                peers: vec![PeerPresence {
                    display_name: presence_display_name(kind),
                    participant_id,
                    device_id: device_id.as_str().to_string(),
                    kind,
                    online,
                    on_snapshot_id: None,
                }],
                replace: false,
            });
        }
        TransportEvent::CollabSignal {
            room_id: rid,
            from,
            payload,
        } => {
            // Drop our own broadcast echo (the relay fans broadcasts back to
            // the author); the webview also guards, but skipping here saves a
            // bridge round-trip.
            if from.as_str() == self_device_id {
                return;
            }
            let Some(kind) = collab_wire_kind(&payload) else {
                return;
            };
            let sender_is_owner = owner_participant_id.is_some_and(|owner| {
                store
                    .load_devices(room_id)
                    .ok()
                    .flatten()
                    .is_some_and(|devices| {
                        devices.iter().any(|device| {
                            device.device_id == from && device.participant_id.as_str() == owner
                        })
                    })
            });
            if !inbound_collab_allowed(observers.local_is_owner, sender_is_owner, kind) {
                tracing::warn!(
                    room_id = room_id.as_str(),
                    from = from.as_str(),
                    kind = ?kind,
                    "dropped remote document mutation at owner authority boundary"
                );
                return;
            }
            (update_tx)(ReviewUpdate::CollabSignal {
                room_id: rid,
                from: from.as_str().to_string(),
                payload,
            });
        }
        TransportEvent::PolicyChanged { .. } => {
            // Room policy edits. Not yet surfaced.
        }
        TransportEvent::Signaling { .. } => {
            // WebRTC SDP/ICE control-plane. The per-room connection
            // orchestrator (Stage 2) intercepts these before this forwarder to
            // drive the WebRtcTransport; decoded-but-unrouted here is a no-op.
        }
        TransportEvent::Disconnected { reason, close_code } => {
            // Flip the connection badge to offline. The WS auto-reconnect
            // loop will emit a fresh Hello (→ mailbox) when it re-subscribes,
            // so a transient drop self-heals in the UI.
            (update_tx)(ReviewUpdate::ConnectionChanged {
                room_id: room_id.clone(),
                connection: "offline".to_string(),
            });
            (update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code: format!(
                    "ATTN_DISCONNECTED{}",
                    close_code.map_or(String::new(), |c| format!("_{c}"))
                ),
                message: reason,
            });
        }
        TransportEvent::Error { code, message } => {
            (update_tx)(ReviewUpdate::Error {
                room_id: Some(room_id.clone()),
                code,
                message,
            });
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CollabWireKind {
    Submit,
    Broadcast,
    Resync,
    Cursor,
}

fn collab_wire_kind(payload: &str) -> Option<CollabWireKind> {
    if payload.len() > 262_144 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    match value.get("kind")?.as_str()? {
        "submit" => Some(CollabWireKind::Submit),
        "broadcast" => Some(CollabWireKind::Broadcast),
        "resync" => Some(CollabWireKind::Resync),
        "cursor" => Some(CollabWireKind::Cursor),
        _ => None,
    }
}

fn collab_signal_class(
    protocol_version: u8,
    kind: CollabWireKind,
) -> Option<crate::review::model::SignalClass> {
    (protocol_version == 3 && kind == CollabWireKind::Cursor)
        .then_some(crate::review::model::SignalClass::Presence)
}

fn outbound_collab_allowed(is_owner: bool, kind: CollabWireKind) -> bool {
    if is_owner {
        matches!(kind, CollabWireKind::Broadcast | CollabWireKind::Cursor)
    } else {
        matches!(kind, CollabWireKind::Resync | CollabWireKind::Cursor)
    }
}

fn inbound_collab_allowed(
    local_is_owner: bool,
    sender_is_owner: bool,
    kind: CollabWireKind,
) -> bool {
    if local_is_owner {
        matches!(kind, CollabWireKind::Resync | CollabWireKind::Cursor)
    } else {
        sender_is_owner && matches!(kind, CollabWireKind::Broadcast | CollabWireKind::Cursor)
    }
}

fn review_event_body_name(body: &crate::review::model::ReviewEventBody) -> &'static str {
    use crate::review::model::ReviewEventBody;
    match body {
        ReviewEventBody::RoomCreated { .. } => "room_created",
        ReviewEventBody::ParticipantJoined { .. } => "participant_joined",
        ReviewEventBody::SnapshotCreated { .. } => "snapshot_created",
        ReviewEventBody::SnapshotSuperseded { .. } => "snapshot_superseded",
        ReviewEventBody::CommentCreated { .. } => "comment_created",
        ReviewEventBody::CommentResolved { .. } => "comment_resolved",
        ReviewEventBody::CommentReopened { .. } => "comment_reopened",
        ReviewEventBody::SuggestionCreated { .. } => "suggestion_created",
        ReviewEventBody::SuggestionAccepted { .. } => "suggestion_accepted",
        ReviewEventBody::SuggestionRejected { .. } => "suggestion_rejected",
        ReviewEventBody::AnchorManuallyResolved { .. } => "anchor_manually_resolved",
        ReviewEventBody::PresenceUpdated { .. } => "presence_updated",
        ReviewEventBody::SessionEnded { .. } => "session_ended",
    }
}

/// Infer a peer's `ParticipantKind` for the presence chips. The relay's
/// device directory doesn't carry an owner/reviewer label, so we derive it:
/// the room's `created_by` participant is the owner, an `agent-cli` device
/// client is an agent, everything else is a reviewer.
fn participant_kind_for(
    participant_id: &str,
    owner_participant_id: Option<&str>,
    client: Option<crate::review::model::DeviceClient>,
) -> crate::review::model::ParticipantKind {
    use crate::review::model::{DeviceClient, ParticipantKind};
    if owner_participant_id == Some(participant_id) {
        return ParticipantKind::Owner;
    }
    match client {
        Some(DeviceClient::AgentCli) => ParticipantKind::Agent,
        _ => ParticipantKind::Reviewer,
    }
}

/// Friendly display label for a presence chip. The daemon's device
/// directory has no human display name, so we label by role; the chip's
/// monogram is the first letter (`O`/`R`) and the identity card's tail-6
/// fingerprint disambiguates same-role peers.
fn presence_display_name(kind: crate::review::model::ParticipantKind) -> String {
    use crate::review::model::ParticipantKind;
    match kind {
        ParticipantKind::Owner => "Owner".to_string(),
        ParticipantKind::Agent => "Agent".to_string(),
        ParticipantKind::Reviewer => "Reviewer".to_string(),
    }
}

/// Build a `PeerPresence` from a relay `Device` (Hello roster). Devices in a
/// Hello frame are, by definition, currently connected → `online = true`.
fn peer_presence_from_device(
    device: &crate::review::model::Device,
    owner_participant_id: Option<&str>,
) -> PeerPresence {
    let participant_id = device.participant_id.as_str().to_string();
    let kind = participant_kind_for(&participant_id, owner_participant_id, Some(device.client));
    PeerPresence {
        display_name: presence_display_name(kind),
        participant_id,
        device_id: device.device_id.as_str().to_string(),
        kind,
        online: true,
        on_snapshot_id: None,
    }
}

fn stub_content_hash() -> crate::review::ids::ContentHash {
    serde_json::from_value::<crate::review::ids::ContentHash>(serde_json::Value::String(
        "sha256-stub".to_string(),
    ))
    .expect("stub ContentHash deserializes")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::ids::{ContentHash, FileId, SnapshotId};
    use crate::review::model::{Anchor, PositionAnchor, SuggestionDraft, SuggestionOperation};
    use std::sync::Mutex;
    use std::sync::mpsc;
    use tempfile::TempDir;

    // --- attn-7qv: per-peer collab routing decision -------------------------

    #[test]
    fn webrtc_eligibility_includes_native_and_browser_but_not_agents() {
        assert!(device_supports_webrtc(DeviceClient::AttnNative));
        assert!(device_supports_webrtc(DeviceClient::AttnBrowser));
        assert!(!device_supports_webrtc(DeviceClient::AgentCli));
    }

    #[test]
    fn owner_accept_boundary_allows_only_non_mutating_remote_collab() {
        assert_eq!(
            collab_wire_kind(r#"{"kind":"submit","submission":{"steps":[]}}"#),
            Some(CollabWireKind::Submit)
        );
        assert!(!inbound_collab_allowed(true, false, CollabWireKind::Submit));
        assert!(!inbound_collab_allowed(
            true,
            false,
            CollabWireKind::Broadcast
        ));
        assert!(inbound_collab_allowed(true, false, CollabWireKind::Resync));
        assert!(inbound_collab_allowed(true, false, CollabWireKind::Cursor));
        assert!(inbound_collab_allowed(
            false,
            true,
            CollabWireKind::Broadcast
        ));
        assert!(inbound_collab_allowed(false, true, CollabWireKind::Cursor));
        assert!(!inbound_collab_allowed(false, true, CollabWireKind::Submit));
        assert!(!inbound_collab_allowed(
            false,
            false,
            CollabWireKind::Broadcast
        ));
        assert!(!inbound_collab_allowed(
            false,
            false,
            CollabWireKind::Cursor
        ));
    }

    #[test]
    fn native_reviewer_cannot_emit_document_steps_in_any_grant_tier() {
        assert!(!outbound_collab_allowed(false, CollabWireKind::Submit));
        assert!(!outbound_collab_allowed(false, CollabWireKind::Broadcast));
        assert!(outbound_collab_allowed(false, CollabWireKind::Resync));
        assert!(outbound_collab_allowed(false, CollabWireKind::Cursor));
        assert!(outbound_collab_allowed(true, CollabWireKind::Broadcast));
        assert!(!outbound_collab_allowed(true, CollabWireKind::Submit));
    }

    #[test]
    fn only_v3_cursor_collab_uses_replaceable_presence_retention() {
        use crate::review::model::SignalClass;

        assert_eq!(
            collab_signal_class(3, CollabWireKind::Cursor),
            Some(SignalClass::Presence)
        );
        assert_eq!(collab_signal_class(3, CollabWireKind::Broadcast), None);
        assert_eq!(collab_signal_class(3, CollabWireKind::Resync), None);
        assert_eq!(collab_signal_class(2, CollabWireKind::Cursor), None);
    }

    #[test]
    fn collab_routing_complete_mesh_sends_channels_only_no_relay() {
        // Every peer connected → mesh covers everyone; skip the relay (cost).
        let r = decide_collab_routing(CollabWireKind::Broadcast, 2, 2);
        assert!(r.send_over_channels);
        assert!(!r.use_relay, "complete mesh must NOT relay");
    }

    #[test]
    fn collab_routing_partial_mesh_sends_channels_and_relays() {
        // The attn-7qv fix: some peers connected, some not (no-TURN partial
        // mesh) → send to the connected channel(s) AND relay for the rest.
        let r = decide_collab_routing(CollabWireKind::Broadcast, 2, 1);
        assert!(
            r.send_over_channels,
            "must still send to the connected peer"
        );
        assert!(
            r.use_relay,
            "incomplete mesh must relay to reach un-meshed peers"
        );
    }

    #[test]
    fn collab_routing_no_mesh_relays_only() {
        // No DataChannels formed yet (or none possible) → relay only.
        let r = decide_collab_routing(CollabWireKind::Broadcast, 3, 0);
        assert!(!r.send_over_channels);
        assert!(r.use_relay);
    }

    #[test]
    fn collab_routing_no_peers_relays() {
        // No known peers → relay (matches the legacy fallback; harmless no-op
        // if nobody is subscribed).
        let r = decide_collab_routing(CollabWireKind::Broadcast, 0, 0);
        assert!(!r.send_over_channels);
        assert!(r.use_relay);
    }

    #[test]
    fn cursor_presence_never_uses_relay_even_with_partial_or_no_mesh() {
        let partial = decide_collab_routing(CollabWireKind::Cursor, 3, 1);
        assert!(partial.send_over_channels);
        assert!(!partial.use_relay);

        let absent = decide_collab_routing(CollabWireKind::Cursor, 3, 0);
        assert!(!absent.send_over_channels);
        assert!(!absent.use_relay);
    }

    // ----- snapshot rehydration at the IPC boundary -----------------------

    #[test]
    fn rehydrate_snapshot_event_inlines_persisted_blob_and_enforces_integrity() {
        use crate::review::crypto::ids::content_hash;
        use crate::review::model::{BlobRef, BlobStorage, ReviewEventBody, SnapshotPlaintext};

        let tmp = TempDir::new().expect("tempdir");
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("open store");
        let room_id: RoomId = dummy_id("room-rehydrate");

        let snapshot_id: SnapshotId = dummy_id("snap-1");
        let content = "# rehydrated\n";
        let base_hash = content_hash(content.as_bytes());
        let plaintext = SnapshotPlaintext {
            doc_type: crate::review::model::DocType::Markdown,
            content: Some(content.to_string()),
            anchor_index: Some(
                crate::review::anchors::index::build_anchor_index(content.as_bytes(), &snapshot_id)
                    .expect("anchor index"),
            ),
            media_type: None,
            encoding: None,
            manifest: None,
            annotation: None,
        };
        let blob_bytes = crate::review::crypto::canonical::to_canonical_bytes(&plaintext)
            .expect("canonical snapshot");
        store
            .save_snapshot_blob(&room_id, "blob-env-1", &blob_bytes)
            .expect("save blob");

        let blob_ref = BlobRef {
            storage: BlobStorage::Mailbox,
            blob_id: "blob-env-1".to_string(),
            byte_length: blob_bytes.len() as u64,
            content_hash: content_hash(&blob_bytes),
        };
        let body = ReviewEventBody::SnapshotCreated {
            file_id: dummy_id("file-1"),
            snapshot_id,
            owner_display_path: None,
            parent_snapshot_id: None,
            base_hash,
            encrypted_blob_ref: Some(blob_ref.clone()),
            inline_snapshot: None,
        };

        // Happy path: blob present + hash matches → inline filled. A
        // sender-provided inline payload is discarded first because the wire
        // protocol authenticates the referenced blob, not inline plaintext.
        let mut event = stub_review_event(&room_id, body.clone());
        if let ReviewEventBody::SnapshotCreated {
            inline_snapshot, ..
        } = &mut event.body
        {
            *inline_snapshot = Some(SnapshotPlaintext {
                content: Some("# injected\n".to_string()),
                anchor_index: None,
                ..plaintext.clone()
            });
        }
        rehydrate_snapshot_event(&store, &room_id, &mut event);
        match &event.body {
            ReviewEventBody::SnapshotCreated {
                inline_snapshot: Some(inline),
                ..
            } => assert_eq!(inline.content.as_deref(), Some("# rehydrated\n")),
            other => panic!("expected inlined snapshot, got {other:?}"),
        }

        // Integrity mismatch: signed BlobRef hash differs from stored bytes
        // → inline stays None (blob lane is confidentiality-only; the
        // event signature is what vouches for the bytes).
        let bad_ref = BlobRef {
            content_hash: dummy_id("hash-wrong"),
            ..blob_ref.clone()
        };
        let mut event = stub_review_event(
            &room_id,
            match body.clone() {
                ReviewEventBody::SnapshotCreated {
                    file_id,
                    snapshot_id,
                    owner_display_path,
                    parent_snapshot_id,
                    base_hash,
                    ..
                } => ReviewEventBody::SnapshotCreated {
                    file_id,
                    snapshot_id,
                    owner_display_path,
                    parent_snapshot_id,
                    base_hash,
                    encrypted_blob_ref: Some(bad_ref),
                    inline_snapshot: None,
                },
                _ => unreachable!(),
            },
        );
        rehydrate_snapshot_event(&store, &room_id, &mut event);
        assert!(
            matches!(
                &event.body,
                ReviewEventBody::SnapshotCreated {
                    inline_snapshot: None,
                    ..
                }
            ),
            "hash mismatch must not inline"
        );

        // Missing blob: event passes through without inline (soft failure).
        let missing_ref = BlobRef {
            blob_id: "blob-missing".to_string(),
            ..blob_ref
        };
        let mut event = stub_review_event(
            &room_id,
            match body.clone() {
                ReviewEventBody::SnapshotCreated {
                    file_id,
                    snapshot_id,
                    owner_display_path,
                    parent_snapshot_id,
                    base_hash,
                    ..
                } => ReviewEventBody::SnapshotCreated {
                    file_id,
                    snapshot_id,
                    owner_display_path,
                    parent_snapshot_id,
                    base_hash,
                    encrypted_blob_ref: Some(missing_ref),
                    inline_snapshot: None,
                },
                _ => unreachable!(),
            },
        );
        rehydrate_snapshot_event(&store, &room_id, &mut event);
        assert!(matches!(
            &event.body,
            ReviewEventBody::SnapshotCreated {
                inline_snapshot: None,
                ..
            }
        ));

        // A BlobRef-valid payload still cannot override the signed raw
        // baseHash carried by SnapshotCreated.
        let mut wrong_base = stub_review_event(&room_id, body.clone());
        if let ReviewEventBody::SnapshotCreated { base_hash, .. } = &mut wrong_base.body {
            *base_hash = content_hash(b"different raw document");
        }
        rehydrate_snapshot_event(&store, &room_id, &mut wrong_base);
        assert!(matches!(
            wrong_base.body,
            ReviewEventBody::SnapshotCreated {
                inline_snapshot: None,
                ..
            }
        ));

        // Structurally invalid new payloads are soft-dropped after BlobRef
        // verification; they never poison the replay/event stream.
        let malformed_asset = br#"{"content":"AA==","docType":"asset","encoding":"base64url","mediaType":"application/octet-stream"}"#;
        store
            .save_snapshot_blob(&room_id, "blob-malformed-asset", malformed_asset)
            .expect("save malformed asset blob");
        let mut malformed_event = stub_review_event(
            &room_id,
            ReviewEventBody::SnapshotCreated {
                file_id: dummy_id("file-asset"),
                snapshot_id: dummy_id("snap-asset"),
                owner_display_path: Some("assets/raw.bin".to_string()),
                parent_snapshot_id: None,
                base_hash: content_hash(&[0]),
                encrypted_blob_ref: Some(BlobRef {
                    storage: BlobStorage::Mailbox,
                    blob_id: "blob-malformed-asset".to_string(),
                    byte_length: malformed_asset.len() as u64,
                    content_hash: content_hash(malformed_asset),
                }),
                inline_snapshot: None,
            },
        );
        rehydrate_snapshot_event(&store, &room_id, &mut malformed_event);
        assert!(matches!(
            malformed_event.body,
            ReviewEventBody::SnapshotCreated {
                inline_snapshot: None,
                ..
            }
        ));
    }

    #[derive(Debug, Clone, Copy)]
    enum ManifestBindingTamper {
        None,
        MissingEntry,
        FileId,
        SnapshotId,
        Path,
        Kind,
        ByteLength,
        ContentHash,
        MediaType,
        SyntheticManifestFileId,
        MissingRoomSecret,
    }

    fn persist_snapshot_event(
        store: &ReviewStore,
        room_id: &RoomId,
        event_label: &str,
        file_id: FileId,
        snapshot_id: SnapshotId,
        path: &str,
        payload: &crate::review::model::SnapshotPlaintext,
    ) -> crate::review::model::ReviewEvent {
        use crate::review::crypto::ids::content_hash;
        use crate::review::model::{BlobRef, BlobStorage, ReviewEventBody};

        let blob_id = format!("blob-{event_label}");
        let blob_bytes = crate::review::crypto::canonical::to_canonical_bytes(payload)
            .expect("canonical snapshot payload");
        store
            .save_snapshot_blob(room_id, &blob_id, &blob_bytes)
            .expect("save snapshot blob");
        let raw = payload.raw_content_bytes().expect("raw snapshot content");
        let mut event = stub_review_event(
            room_id,
            ReviewEventBody::SnapshotCreated {
                file_id,
                snapshot_id,
                owner_display_path: Some(path.to_string()),
                parent_snapshot_id: None,
                base_hash: content_hash(&raw),
                encrypted_blob_ref: Some(BlobRef {
                    storage: BlobStorage::Mailbox,
                    blob_id,
                    byte_length: blob_bytes.len() as u64,
                    content_hash: content_hash(&blob_bytes),
                }),
                inline_snapshot: None,
            },
        );
        event.meta.event_id = dummy_id(&format!("event-{event_label}"));
        event
    }

    fn bound_manifest_case(
        tamper: ManifestBindingTamper,
    ) -> (
        TempDir,
        ReviewStore,
        RoomId,
        crate::review::model::ReviewEvent,
    ) {
        use crate::review::crypto::ids::{
            content_hash, derive_room_id, derive_workspace_manifest_file_id,
        };
        use crate::review::model::{
            DocType, ReviewEventBody, SnapshotAssetEncoding, SnapshotPlaintext,
            WorkspaceManifestEntry, WorkspaceManifestEntryKind, WorkspaceManifestKind,
            WorkspaceManifestScope, WorkspaceSnapshotManifest,
        };
        use base64::Engine;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;

        let tmp = TempDir::new().expect("tempdir");
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("open store");
        let secret = [0x11; 32];
        let room_id = derive_room_id(&secret);
        if !matches!(tamper, ManifestBindingTamper::MissingRoomSecret) {
            let shares = store.root().join("shares");
            std::fs::create_dir_all(&shares).expect("create shares dir");
            std::fs::write(
                shares.join(format!("{}.secret", room_id.as_str())),
                URL_SAFE_NO_PAD.encode(secret),
            )
            .expect("persist test room secret");
        }

        let asset_file_id: FileId = dummy_id("AQEBAQEBAQEBAQEBAQEBAQ");
        let asset_snapshot_id: SnapshotId = dummy_id("AgICAgICAgICAgICAgICAg");
        let markdown_file_id: FileId = dummy_id("AwMDAwMDAwMDAwMDAwMDAw");
        let markdown_snapshot_id: SnapshotId = dummy_id("BAQEBAQEBAQEBAQEBAQEBA");
        let asset_raw = vec![0, 0xff, 0x80, b'A', 0, b'/', b'*'];
        let asset_payload = SnapshotPlaintext {
            doc_type: DocType::Asset,
            content: Some(URL_SAFE_NO_PAD.encode(&asset_raw)),
            anchor_index: None,
            media_type: Some("application/octet-stream".to_string()),
            encoding: Some(SnapshotAssetEncoding::Base64url),
            manifest: None,
            annotation: None,
        };
        let markdown_raw = b"# Nested\n\nHello workspace.\n";
        let markdown_payload = SnapshotPlaintext {
            doc_type: DocType::Markdown,
            content: Some(String::from_utf8(markdown_raw.to_vec()).expect("utf8 markdown")),
            anchor_index: Some(
                crate::review::anchors::index::build_anchor_index(
                    markdown_raw,
                    &markdown_snapshot_id,
                )
                .expect("markdown anchor index"),
            ),
            media_type: None,
            encoding: None,
            manifest: None,
            annotation: None,
        };

        let mut asset_event = persist_snapshot_event(
            &store,
            &room_id,
            "asset-entry",
            asset_file_id.clone(),
            asset_snapshot_id.clone(),
            "assets/raw.bin",
            &asset_payload,
        );
        match tamper {
            ManifestBindingTamper::FileId => {
                if let ReviewEventBody::SnapshotCreated { file_id, .. } = &mut asset_event.body {
                    *file_id = dummy_id("BQUFBQUFBQUFBQUFBQUFBQ");
                }
            }
            ManifestBindingTamper::SnapshotId => {
                if let ReviewEventBody::SnapshotCreated { snapshot_id, .. } = &mut asset_event.body
                {
                    *snapshot_id = dummy_id("BgYGBgYGBgYGBgYGBgYGBg");
                }
            }
            ManifestBindingTamper::Path => {
                if let ReviewEventBody::SnapshotCreated {
                    owner_display_path, ..
                } = &mut asset_event.body
                {
                    *owner_display_path = Some("assets/moved.bin".to_string());
                }
            }
            _ => {}
        }
        if !matches!(tamper, ManifestBindingTamper::MissingEntry) {
            assert!(
                store
                    .append_event(&room_id, &asset_event)
                    .expect("append asset event")
            );
        }

        let markdown_event = persist_snapshot_event(
            &store,
            &room_id,
            "markdown-entry",
            markdown_file_id.clone(),
            markdown_snapshot_id.clone(),
            "notes/readme.md",
            &markdown_payload,
        );
        assert!(
            store
                .append_event(&room_id, &markdown_event)
                .expect("append markdown event")
        );

        let mut manifest = WorkspaceSnapshotManifest {
            v: 1,
            kind: WorkspaceManifestKind::AttnWorkspaceSnapshot,
            scope: WorkspaceManifestScope::Workspace,
            entries: vec![
                WorkspaceManifestEntry {
                    file_id: asset_file_id.clone(),
                    snapshot_id: asset_snapshot_id,
                    path: "assets/raw.bin".to_string(),
                    kind: WorkspaceManifestEntryKind::Asset,
                    media_type: Some("application/octet-stream".to_string()),
                    byte_length: asset_raw.len() as u64,
                    content_hash: content_hash(&asset_raw),
                },
                WorkspaceManifestEntry {
                    file_id: markdown_file_id,
                    snapshot_id: markdown_snapshot_id,
                    path: "notes/readme.md".to_string(),
                    kind: WorkspaceManifestEntryKind::Markdown,
                    media_type: None,
                    byte_length: markdown_raw.len() as u64,
                    content_hash: content_hash(markdown_raw),
                },
            ],
        };
        match tamper {
            ManifestBindingTamper::Kind => {
                manifest.entries[0].kind = WorkspaceManifestEntryKind::Html;
                manifest.entries[0].media_type = None;
            }
            ManifestBindingTamper::ByteLength => manifest.entries[0].byte_length += 1,
            ManifestBindingTamper::ContentHash => {
                manifest.entries[0].content_hash = content_hash(b"different raw bytes");
            }
            ManifestBindingTamper::MediaType => {
                manifest.entries[0].media_type = Some("image/png".to_string());
            }
            _ => {}
        }
        let manifest_payload = SnapshotPlaintext {
            doc_type: DocType::WorkspaceManifest,
            content: None,
            anchor_index: None,
            media_type: None,
            encoding: None,
            manifest: Some(manifest),
            annotation: None,
        };
        let mut manifest_event = persist_snapshot_event(
            &store,
            &room_id,
            "workspace-manifest",
            derive_workspace_manifest_file_id(&secret),
            dummy_id("BwcHBwcHBwcHBwcHBwcHBw"),
            "workspace.manifest",
            &manifest_payload,
        );
        if matches!(tamper, ManifestBindingTamper::SyntheticManifestFileId)
            && let ReviewEventBody::SnapshotCreated { file_id, .. } = &mut manifest_event.body
        {
            *file_id = asset_file_id;
        }
        assert!(
            store
                .append_event(&room_id, &manifest_event)
                .expect("append manifest event")
        );
        (tmp, store, room_id, manifest_event)
    }

    #[test]
    fn rehydrate_manifest_binds_valid_nested_markdown_and_binary_entries() {
        use crate::review::model::{DocType, ReviewEventBody};

        let (_tmp, store, room_id, mut event) = bound_manifest_case(ManifestBindingTamper::None);
        rehydrate_snapshot_event(&store, &room_id, &mut event);
        match event.body {
            ReviewEventBody::SnapshotCreated {
                inline_snapshot: Some(inline),
                ..
            } => {
                assert_eq!(inline.doc_type, DocType::WorkspaceManifest);
                assert_eq!(inline.manifest.expect("manifest").entries.len(), 2);
            }
            other => panic!("expected bound workspace manifest, got {other:?}"),
        }
    }

    #[test]
    fn rehydrate_manifest_rejects_every_entry_binding_tamper_and_missing_entry() {
        use crate::review::model::ReviewEventBody;

        for tamper in [
            ManifestBindingTamper::MissingEntry,
            ManifestBindingTamper::FileId,
            ManifestBindingTamper::SnapshotId,
            ManifestBindingTamper::Path,
            ManifestBindingTamper::Kind,
            ManifestBindingTamper::ByteLength,
            ManifestBindingTamper::ContentHash,
            ManifestBindingTamper::MediaType,
            ManifestBindingTamper::SyntheticManifestFileId,
            ManifestBindingTamper::MissingRoomSecret,
        ] {
            let (_tmp, store, room_id, mut event) = bound_manifest_case(tamper);
            rehydrate_snapshot_event(&store, &room_id, &mut event);
            assert!(
                matches!(
                    event.body,
                    ReviewEventBody::SnapshotCreated {
                        inline_snapshot: None,
                        ..
                    }
                ),
                "{tamper:?} must fail closed"
            );
        }
    }

    #[test]
    fn rehydrate_legacy_html_does_not_require_manifest_correlation() {
        use crate::review::model::{DocType, ReviewEventBody, SnapshotPlaintext};

        let tmp = TempDir::new().expect("tempdir");
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("open store");
        let room_id: RoomId = dummy_id("legacy-html-room");
        let payload = SnapshotPlaintext {
            doc_type: DocType::Html,
            content: Some("<article>legacy</article>\n".to_string()),
            anchor_index: None,
            media_type: None,
            encoding: None,
            manifest: None,
            annotation: None,
        };
        let mut event = persist_snapshot_event(
            &store,
            &room_id,
            "legacy-html",
            dummy_id("legacy-file"),
            dummy_id("legacy-snapshot"),
            "legacy.html",
            &payload,
        );
        // Legacy single-document snapshots predate the manifest protocol and
        // therefore need neither a persisted room secret nor an event-log
        // correlation record at this hydration boundary.
        rehydrate_snapshot_event(&store, &room_id, &mut event);
        assert!(matches!(
            event.body,
            ReviewEventBody::SnapshotCreated {
                inline_snapshot: Some(ref inline),
                ..
            } if inline == &payload
        ));
    }

    // ----- replay of persisted room state on resume/re-join (attn-6dd) ----

    #[test]
    fn replay_room_to_webview_emits_persisted_events_with_rehydrated_snapshots() {
        use crate::review::crypto::ids::content_hash;
        use crate::review::model::{BlobRef, BlobStorage, ReviewEventBody, SnapshotPlaintext};

        let (mgr, rx, tmp) = make_manager();
        // Second handle onto the same on-disk store to seed "session 1" state.
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("open store");
        let room_id: RoomId = dummy_id("room-replay");

        // Persist the snapshot blob the SnapshotCreated event references —
        // this is what the inbound pipeline leaves behind for a reviewer
        // (events.jsonl + blobs/*.bin; no SnapshotNode on the reviewer side).
        let snapshot_id: SnapshotId = dummy_id("snap-1");
        let content = "# replayed doc\n";
        let base_hash = content_hash(content.as_bytes());
        let plaintext = SnapshotPlaintext {
            doc_type: crate::review::model::DocType::Markdown,
            content: Some(content.to_string()),
            anchor_index: Some(
                crate::review::anchors::index::build_anchor_index(content.as_bytes(), &snapshot_id)
                    .expect("anchor index"),
            ),
            media_type: None,
            encoding: None,
            manifest: None,
            annotation: None,
        };
        let blob_bytes = crate::review::crypto::canonical::to_canonical_bytes(&plaintext)
            .expect("canonical snapshot");
        store
            .save_snapshot_blob(&room_id, "blob-env-replay", &blob_bytes)
            .expect("save blob");
        let blob_ref = BlobRef {
            storage: BlobStorage::Mailbox,
            blob_id: "blob-env-replay".to_string(),
            byte_length: blob_bytes.len() as u64,
            content_hash: content_hash(&blob_bytes),
        };

        // Seed events.jsonl in log order: snapshot first (wire form, no
        // inline plaintext — decision #14), then a comment.
        let mut snapshot_event = stub_review_event(
            &room_id,
            ReviewEventBody::SnapshotCreated {
                file_id: dummy_id("file-1"),
                snapshot_id,
                owner_display_path: Some("/tmp/doc.md".to_string()),
                parent_snapshot_id: None,
                base_hash,
                encrypted_blob_ref: Some(blob_ref),
                inline_snapshot: None,
            },
        );
        snapshot_event.meta.event_id = dummy_id("evt-snap-1");
        let mut comment_event = stub_review_event(
            &room_id,
            ReviewEventBody::CommentCreated {
                thread_id: "thr-1".to_string(),
                anchor: dummy_anchor(),
                body: "persisted comment".to_string(),
            },
        );
        comment_event.meta.event_id = dummy_id("evt-comment-1");
        assert!(
            store
                .append_event(&room_id, &snapshot_event)
                .expect("append")
        );
        assert!(
            store
                .append_event(&room_id, &comment_event)
                .expect("append")
        );

        // "Session 2": replay must re-emit both events through the same
        // EventImported push the live inbound pipeline uses, in log order,
        // with the snapshot's plaintext rehydrated from the blob store.
        mgr.replay_room_to_webview(&room_id);

        let first = rx.try_recv().expect("first replayed update");
        match first {
            ReviewUpdate::EventImported {
                room_id: rid,
                event,
            } => {
                assert_eq!(rid, room_id);
                assert_eq!(event.meta.event_id, dummy_id::<EventId>("evt-snap-1"));
                match event.body {
                    ReviewEventBody::SnapshotCreated {
                        inline_snapshot: Some(inline),
                        ..
                    } => assert_eq!(inline.content.as_deref(), Some("# replayed doc\n")),
                    other => panic!("expected rehydrated SnapshotCreated, got {other:?}"),
                }
            }
            other => panic!("expected EventImported, got {other:?}"),
        }
        let second = rx.try_recv().expect("second replayed update");
        match second {
            ReviewUpdate::EventImported { event, .. } => {
                assert_eq!(event.meta.event_id, dummy_id::<EventId>("evt-comment-1"));
                assert!(matches!(event.body, ReviewEventBody::CommentCreated { .. }));
            }
            other => panic!("expected EventImported, got {other:?}"),
        }
        assert!(
            rx.try_recv().is_err(),
            "replay must emit exactly the persisted events"
        );

        // A room with no persisted log replays nothing (fresh join).
        let empty_room: RoomId = dummy_id("room-empty");
        mgr.replay_room_to_webview(&empty_room);
        assert!(rx.try_recv().is_err(), "empty room must replay nothing");
    }

    /// Build a `(ReviewManager, receiver)` pair backed by an std::mpsc channel
    /// so tests can assert which `ReviewUpdate`s the manager emitted.
    fn make_manager() -> (ReviewManager, mpsc::Receiver<ReviewUpdate>, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());
        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = Mutex::new(tx);
        let sink: UpdateSink = Arc::new(move |update| {
            // `Fn` (not `FnMut`), so wrap the sender in a Mutex.
            let _ = tx.lock().expect("test sink mutex").send(update);
        });
        let mgr = ReviewManager::new(store, working_copy, sink);
        (mgr, rx, tmp)
    }

    fn verdicts_test_event(
        room_id: &RoomId,
        event_id: &str,
        author_id: &str,
        body: ReviewEventBody,
    ) -> crate::review::model::ReviewEvent {
        let mut event = stub_review_event(room_id, body);
        event.meta.event_id = dummy_id(event_id);
        event.meta.author_id = dummy_id(author_id);
        event
    }

    #[test]
    fn verified_remote_unread_import_counts_once_and_focused_visible_view_clears() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-unread-import");
        let mut event = verdicts_test_event(
            &room_id,
            "evt-unread-comment",
            "remote-reviewer",
            ReviewEventBody::CommentCreated {
                thread_id: "thread-unread".to_string(),
                anchor: dummy_anchor(),
                body: "remote comment".to_string(),
            },
        );
        event.meta.device_id = dummy_id("remote-device");

        let mut second = event.clone();
        second.meta.event_id = dummy_id("evt-unread-comment-b");
        let second_event_id = second.meta.event_id.clone();
        for (delivered, newly_imported) in [
            (event.clone(), true),
            (second, true),
            // Dual transport replay of A after B: the inbound append reports
            // it as an existing event, so it must not re-badge.
            (event.clone(), false),
        ] {
            forward_transport_event(
                &mgr.update_tx,
                &mgr.store,
                TransportObservers {
                    verdict_revision_tx: &mgr.verdict_revision_tx,
                    notifications: None,
                    local_is_owner: false,
                },
                &room_id,
                "self-device",
                None,
                crate::review::transport::TransportEvent::EventImported {
                    room_id: room_id.clone(),
                    event: delivered,
                    newly_imported,
                },
            );
        }
        assert_eq!(
            mgr.store
                .load_unread_state(&room_id)
                .expect("unread after duplicate")
                .unread_count,
            2,
            "A,B,A delivery must count the two fresh imports exactly once"
        );
        while rx.try_recv().is_ok() {}

        mgr.submit(ReviewCommand::SetViewState {
            room_id: room_id.clone(),
            room_visible: true,
            window_focused: false,
        });
        assert!(rx.try_recv().is_err(), "blurred view must not clear");
        assert_eq!(
            mgr.store
                .load_unread_state(&room_id)
                .expect("still unread")
                .unread_count,
            2
        );

        mgr.submit(ReviewCommand::SetViewState {
            room_id: room_id.clone(),
            room_visible: true,
            window_focused: true,
        });
        assert!(matches!(
            rx.try_recv().expect("clear update"),
            ReviewUpdate::UnreadChanged {
                unread_count: 0,
                ..
            }
        ));
        let cleared = mgr
            .store
            .load_unread_state(&room_id)
            .expect("cleared state");
        assert_eq!(cleared.unread_count, 0);
        assert_eq!(cleared.last_seen_event_id, Some(second_event_id));
    }

    #[test]
    fn local_and_non_attention_events_do_not_increment_unread() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-unread-filter");
        let mut local = verdicts_test_event(
            &room_id,
            "evt-local-suggestion",
            "self",
            ReviewEventBody::SuggestionCreated {
                suggestion_id: "suggestion-local".to_string(),
                anchor: dummy_anchor(),
                operation: SuggestionOperation::InsertAfter {
                    text: "local".to_string(),
                },
                note: None,
            },
        );
        local.meta.device_id = dummy_id("self-device");
        let mut presence = verdicts_test_event(
            &room_id,
            "evt-remote-presence",
            "remote",
            ReviewEventBody::PresenceUpdated {
                participant_id: dummy_id("remote"),
                device_id: dummy_id("remote-device"),
                online: true,
                cursor: None,
            },
        );
        presence.meta.device_id = dummy_id("remote-device");

        for event in [local, presence] {
            forward_transport_event(
                &mgr.update_tx,
                &mgr.store,
                TransportObservers {
                    verdict_revision_tx: &mgr.verdict_revision_tx,
                    notifications: None,
                    local_is_owner: false,
                },
                &room_id,
                "self-device",
                None,
                crate::review::transport::TransportEvent::EventImported {
                    room_id: room_id.clone(),
                    event,
                    newly_imported: true,
                },
            );
        }
        assert_eq!(
            mgr.store
                .load_unread_state(&room_id)
                .expect("filtered state")
                .unread_count,
            0
        );
        assert!(
            rx.try_iter()
                .all(|update| !matches!(update, ReviewUpdate::UnreadChanged { .. }))
        );
    }

    #[test]
    fn fresh_verified_remote_attention_event_reaches_notification_sink_once() {
        #[derive(Default)]
        struct Sink(Mutex<Vec<crate::review::notifications::ReviewNotification>>);
        impl ReviewNotificationSink for Sink {
            fn post(&self, value: crate::review::notifications::ReviewNotification) {
                self.0.lock().expect("notification sink").push(value);
            }
        }

        let (mut mgr, _rx, _tmp) = make_manager();
        let sink = Arc::new(Sink::default());
        mgr.notifications = ReviewNotifications::new(
            Arc::clone(&mgr.store),
            sink.clone(),
            std::time::Duration::from_millis(10),
        );
        let room_id: RoomId = dummy_id("room-native-notification");
        let mut event = verdicts_test_event(
            &room_id,
            "evt-native-notification",
            "remote-reviewer",
            ReviewEventBody::CommentCreated {
                thread_id: "thread-native-notification".to_string(),
                anchor: dummy_anchor(),
                body: "plaintext must never enter the OS summary".to_string(),
            },
        );
        event.meta.device_id = dummy_id("remote-device");
        forward_transport_event(
            &mgr.update_tx,
            &mgr.store,
            TransportObservers {
                verdict_revision_tx: &mgr.verdict_revision_tx,
                notifications: Some(&mgr.notifications),
                local_is_owner: false,
            },
            &room_id,
            "self-device",
            None,
            crate::review::transport::TransportEvent::EventImported {
                room_id: room_id.clone(),
                event,
                newly_imported: true,
            },
        );
        std::thread::sleep(std::time::Duration::from_millis(40));
        let posted = sink.0.lock().expect("notification sink");
        assert_eq!(posted.len(), 1);
        assert!(!posted[0].body.contains("plaintext"));
    }

    #[test]
    fn resident_away_owner_loop_imports_notifies_focuses_and_survives_restart() {
        use crate::review::notifications::ReviewNotification;

        struct ChannelSink(mpsc::Sender<ReviewNotification>);
        impl ReviewNotificationSink for ChannelSink {
            fn post(&self, notification: ReviewNotification) {
                let _ = self.0.send(notification);
            }
        }

        let tmp = TempDir::new().expect("tempdir");
        let reviews_root = tmp.path().join("reviews");
        let store =
            Arc::new(ReviewStore::open_at(reviews_root.clone()).expect("open resident store"));
        let (update_tx, update_rx) = mpsc::channel::<ReviewUpdate>();
        let update_tx = Mutex::new(update_tx);
        let update_sink: UpdateSink = Arc::new(move |update| {
            let _ = update_tx.lock().expect("update sink").send(update);
        });
        let mut manager = ReviewManager::new(
            Arc::clone(&store),
            Arc::new(WorkingCopyService::new()),
            update_sink,
        );
        let (notification_tx, notification_rx) = mpsc::channel();
        // The debounce is real wall-clock in a worker thread, and the property
        // under test is that a room's burst folds into ONE notification. So the
        // window has to outlast every scheduling hiccup between two events of
        // the same room, on a CI runner running the rest of the suite beside
        // it. At 15ms it did not: the window closed mid-burst and first_room
        // posted "1 new comment" twice instead of "2 new comments" once.
        let debounce = std::time::Duration::from_millis(500);
        manager.notifications = ReviewNotifications::new(
            Arc::clone(&store),
            Arc::new(ChannelSink(notification_tx)),
            debounce,
        );

        let first_room: RoomId = dummy_id("room-resident-first");
        let second_room: RoomId = dummy_id("room-resident-second");
        let muted_room: RoomId = dummy_id("room-resident-muted");
        manager.submit(ReviewCommand::SetNotificationMuted {
            room_id: muted_room.clone(),
            muted: true,
        });

        // This is the production boundary immediately after the inbound
        // pipeline has authenticated, decrypted, and durably appended a
        // remote envelope. An empty view map models a resident daemon with no
        // window: every fresh remote attention event enters unread accounting
        // and the native notification coordinator.
        // Every durable append happens BEFORE the burst, so what the debounce
        // window has to cover is the forwarding alone. Appending inside the
        // loop put a file write and an fsync between two events of the same
        // room, which is the expensive part of this test and the thing most
        // likely to outlast the window under load.
        let imports = [
            (&first_room, "evt-resident-a1", "thread-a1"),
            (&second_room, "evt-resident-b1", "thread-b1"),
            (&first_room, "evt-resident-a2", "thread-a2"),
            (&muted_room, "evt-resident-muted", "thread-muted"),
        ]
        .map(|(room_id, event_id, thread_id)| {
            let mut event = verdicts_test_event(
                room_id,
                event_id,
                "browser-reviewer",
                ReviewEventBody::CommentCreated {
                    thread_id: thread_id.to_string(),
                    anchor: dummy_anchor(),
                    body: format!("private body for {event_id}"),
                },
            );
            event.meta.device_id = dummy_id("browser-device");
            assert!(
                store
                    .append_event(room_id, &event)
                    .expect("verified import is durable")
            );
            (room_id, event)
        });

        for (room_id, event) in imports {
            forward_transport_event(
                &manager.update_tx,
                &manager.store,
                TransportObservers {
                    verdict_revision_tx: &manager.verdict_revision_tx,
                    notifications: Some(&manager.notifications),
                    local_is_owner: false,
                },
                room_id,
                "owner-device",
                None,
                crate::review::transport::TransportEvent::EventImported {
                    room_id: room_id.clone(),
                    event,
                    newly_imported: true,
                },
            );
        }

        assert_eq!(
            store
                .load_unread_state(&first_room)
                .expect("first unread")
                .unread_count,
            2
        );
        assert_eq!(
            store
                .load_unread_state(&second_room)
                .expect("second unread")
                .unread_count,
            1
        );
        assert_eq!(
            store
                .load_unread_state(&muted_room)
                .expect("muted unread")
                .unread_count,
            1,
            "muting native notifications must not hide in-app unread state"
        );

        let posted = [
            notification_rx
                .recv_timeout(debounce.saturating_mul(8))
                .expect("first debounced native notification"),
            notification_rx
                .recv_timeout(debounce.saturating_mul(8))
                .expect("second debounced native notification"),
        ];
        let by_room = posted
            .into_iter()
            .map(|notification| (notification.room_id.clone(), notification))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(by_room.len(), 2, "bursts collapse independently per room");
        // Named, because a split burst still yields two notifications from two
        // rooms and passes the count above: the body is what says whether the
        // fold happened.
        assert!(
            by_room[&first_room].body.starts_with("2 new comments"),
            "first room's two comments must fold into one notification, got {:?}",
            by_room[&first_room].body
        );
        assert!(by_room[&second_room].body.starts_with("1 new comment"));
        assert!(!by_room.contains_key(&muted_room));
        // Both batches have already fired, so the muted room's — enqueued last,
        // and therefore due by now too — would arrive immediately if it were
        // ever going to. One more window is a generous wait for a post that
        // should never come.
        assert!(
            notification_rx.recv_timeout(debounce).is_err(),
            "muted room and burst duplicates must not post"
        );

        // A native click follows the production URI parser and focus script;
        // once the hydrated frontend reports that room visible in a focused
        // window, the same manager command clears only that room's badge.
        let clicked = &by_room[&first_room];
        let selected_room =
            crate::review::notifications::room_id_from_deep_link(&clicked.deep_link)
                .expect("notification deep link is a local room route");
        assert_eq!(selected_room, first_room.as_str());
        let focus_script = crate::review::notifications::focus_script(&selected_room);
        assert!(focus_script.contains("__attn_pending_review_focus__"));
        assert!(focus_script.contains("selectRoom(\"room-resident-first\")"));
        manager.submit(ReviewCommand::SetViewState {
            room_id: first_room.clone(),
            room_visible: true,
            window_focused: true,
        });
        assert_eq!(
            store
                .load_unread_state(&first_room)
                .expect("focused unread")
                .unread_count,
            0
        );
        assert_eq!(
            store
                .load_unread_state(&second_room)
                .expect("other room remains unread")
                .unread_count,
            1
        );
        assert!(update_rx.try_iter().any(|update| matches!(
            update,
            ReviewUpdate::UnreadChanged { room_id, unread_count: 0 }
                if room_id == first_room
        )));

        drop(manager);
        drop(store);

        // Simulate the next resident process. Replaying durable room state
        // restores badges and mute preferences to the frontend but never
        // re-enqueues historical events into the native notification worker.
        let reopened =
            Arc::new(ReviewStore::open_at(reviews_root.clone()).expect("reopen resident store"));
        let (restart_update_tx, restart_update_rx) = mpsc::channel::<ReviewUpdate>();
        let restart_update_tx = Mutex::new(restart_update_tx);
        let restart_updates: UpdateSink = Arc::new(move |update| {
            let _ = restart_update_tx
                .lock()
                .expect("restart update sink")
                .send(update);
        });
        let mut restarted = ReviewManager::new(
            Arc::clone(&reopened),
            Arc::new(WorkingCopyService::new()),
            restart_updates,
        );
        let (restart_notification_tx, restart_notification_rx) = mpsc::channel();
        restarted.notifications = ReviewNotifications::new(
            Arc::clone(&reopened),
            Arc::new(ChannelSink(restart_notification_tx)),
            debounce,
        );
        for room_id in [&first_room, &second_room, &muted_room] {
            restarted.replay_room_to_webview(room_id);
        }

        assert_eq!(
            reopened
                .load_unread_state(&first_room)
                .expect("cleared state survives restart")
                .unread_count,
            0
        );
        assert_eq!(
            reopened
                .load_unread_state(&second_room)
                .expect("unread survives restart")
                .unread_count,
            1
        );
        assert!(
            reopened
                .notification_muted(&muted_room)
                .expect("mute survives restart")
        );
        let replayed_updates = restart_update_rx.try_iter().collect::<Vec<_>>();
        assert!(replayed_updates.iter().any(|update| matches!(
            update,
            ReviewUpdate::UnreadChanged { room_id, unread_count: 1 }
                if room_id == &second_room
        )));
        assert!(replayed_updates.iter().any(|update| matches!(
            update,
            ReviewUpdate::NotificationMuteChanged { room_id, muted: true }
                if room_id == &muted_room
        )));
        assert!(
            restart_notification_rx
                .recv_timeout(debounce.saturating_mul(2))
                .is_err(),
            "resident restart must not replay historical OS notifications"
        );
    }

    #[test]
    fn durable_offline_unread_replay_surfaces_without_process_restart() {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("open durable replay store"),
        );
        let working_copy = Arc::new(WorkingCopyService::new());
        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = Mutex::new(tx);
        let sink: UpdateSink = Arc::new(move |update| {
            let _ = tx.lock().expect("sink").send(update);
        });
        let identity_dir = tmp.path().join("identity");
        let manager = ReviewManager::new(Arc::clone(&store), working_copy, sink)
            .with_bootstrap(
                "http://127.0.0.1:1".to_string(),
                Some(identity_dir),
                Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            )
            .expect("bootstrap without network");
        let room_id: RoomId = dummy_id("room-durable-offline-unread");
        let mut event = verdicts_test_event(
            &room_id,
            "evt-durable-offline-comment",
            "browser-reviewer",
            ReviewEventBody::CommentCreated {
                thread_id: "thread-durable-offline".to_string(),
                anchor: dummy_anchor(),
                body: "offline browser comment".to_string(),
            },
        );
        event.meta.device_id = dummy_id("browser-device");
        store
            .append_event(&room_id, &event)
            .expect("durable drain committed event");

        manager.replay_room_to_webview(&room_id);
        assert_eq!(
            store
                .load_unread_state(&room_id)
                .expect("unread reconciled")
                .unread_count,
            1
        );
        let updates = rx.try_iter().collect::<Vec<_>>();
        assert!(updates.iter().any(|update| matches!(
            update,
            ReviewUpdate::EventImported { event: imported, .. }
                if imported.meta.event_id == event.meta.event_id
        )));
        assert!(updates.iter().any(|update| matches!(
            update,
            ReviewUpdate::UnreadChanged {
                unread_count: 1,
                ..
            }
        )));

        manager.replay_room_to_webview(&room_id);
        assert_eq!(
            store
                .load_unread_state(&room_id)
                .expect("idempotent durable replay")
                .unread_count,
            1
        );
    }

    #[tokio::test]
    async fn verdicts_wait_already_complete_does_not_block() {
        let (mgr, _rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-verdicts-complete");
        let created = verdicts_test_event(
            &room_id,
            "evt-created",
            "agent-a",
            ReviewEventBody::SuggestionCreated {
                suggestion_id: "suggestion-a".to_string(),
                anchor: dummy_anchor(),
                operation: SuggestionOperation::Replace {
                    expected_text: "old".to_string(),
                    replacement: "done".to_string(),
                },
                note: None,
            },
        );
        let accepted = verdicts_test_event(
            &room_id,
            "evt-accepted",
            "owner",
            ReviewEventBody::SuggestionAccepted {
                suggestion_id: "suggestion-a".to_string(),
                applied_revision_id: "revision-a".to_string(),
                resulting_hash: stub_content_hash(),
            },
        );
        mgr.store.append_event(&room_id, &created).expect("create");
        mgr.store.append_event(&room_id, &accepted).expect("accept");
        let ids = ["suggestion-a".to_string()].into_iter().collect();

        let outcome = mgr
            .wait_for_verdicts(
                Some(&dummy_id("agent-a")),
                Some(&ids),
                Some(std::time::Duration::ZERO),
            )
            .await
            .expect("wait");
        assert!(matches!(outcome, VerdictWaitOutcome::Complete(_)));
    }

    #[tokio::test]
    async fn verdicts_wait_wakes_on_late_persisted_import_notification() {
        let (mgr, _rx, _tmp) = make_manager();
        let mgr = Arc::new(mgr);
        let room_id: RoomId = dummy_id("room-verdicts-late");
        let created = verdicts_test_event(
            &room_id,
            "evt-created-late",
            "agent-a",
            ReviewEventBody::SuggestionCreated {
                suggestion_id: "suggestion-late".to_string(),
                anchor: dummy_anchor(),
                operation: SuggestionOperation::Replace {
                    expected_text: "old".to_string(),
                    replacement: "late".to_string(),
                },
                note: None,
            },
        );
        mgr.store.append_event(&room_id, &created).expect("create");

        let notifier = Arc::clone(&mgr);
        let notify_room = room_id.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            let accepted = verdicts_test_event(
                &notify_room,
                "evt-accepted-late",
                "owner",
                ReviewEventBody::SuggestionAccepted {
                    suggestion_id: "suggestion-late".to_string(),
                    applied_revision_id: "revision-late".to_string(),
                    resulting_hash: stub_content_hash(),
                },
            );
            notifier
                .store
                .append_event(&notify_room, &accepted)
                .expect("persist before notification");
            forward_transport_event(
                &notifier.update_tx,
                &notifier.store,
                TransportObservers {
                    verdict_revision_tx: &notifier.verdict_revision_tx,
                    notifications: None,
                    local_is_owner: false,
                },
                &notify_room,
                "self-device",
                None,
                crate::review::transport::TransportEvent::EventImported {
                    room_id: notify_room.clone(),
                    event: accepted,
                    newly_imported: true,
                },
            );
        });

        let outcome = mgr
            .wait_for_verdicts(
                Some(&dummy_id("agent-a")),
                None,
                Some(std::time::Duration::from_secs(1)),
            )
            .await
            .expect("wait");
        let VerdictWaitOutcome::Complete(report) = outcome else {
            panic!("late verdict should complete")
        };
        assert_eq!(
            report.rooms["room-verdicts-late"].suggestions["suggestion-late"].status,
            crate::review::store::SuggestionVerdictStatus::Accepted
        );
    }

    #[tokio::test]
    async fn e2e_gate_timeout_returns_parseable_pending_partial_report() {
        let (mgr, _rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-verdicts-timeout");
        let created = verdicts_test_event(
            &room_id,
            "evt-created-timeout",
            "agent-a",
            ReviewEventBody::SuggestionCreated {
                suggestion_id: "suggestion-pending".to_string(),
                anchor: dummy_anchor(),
                operation: SuggestionOperation::Replace {
                    expected_text: "old".to_string(),
                    replacement: "pending".to_string(),
                },
                note: None,
            },
        );
        mgr.store.append_event(&room_id, &created).expect("create");

        let outcome = mgr
            .wait_for_verdicts(
                Some(&dummy_id("agent-a")),
                None,
                Some(std::time::Duration::ZERO),
            )
            .await
            .expect("wait");
        let VerdictWaitOutcome::TimedOut(report) = outcome else {
            panic!("pending verdict should time out")
        };
        assert_eq!(
            report.rooms["room-verdicts-timeout"].suggestions["suggestion-pending"].status,
            crate::review::store::SuggestionVerdictStatus::Pending
        );
        serde_json::to_string(&report).expect("partial verdict report remains JSON serializable");
    }

    #[tokio::test]
    async fn e2e_gate_mixed_verdicts_block_wake_scope_and_canonical_hash() {
        use crate::review::crypto::ids::content_hash;
        use crate::review::store::SuggestionVerdictStatus;

        let (mgr, _rx, tmp) = make_manager();
        let mgr = Arc::new(mgr);
        let room_id: RoomId = dummy_id("room-e2e-gate");
        let gate_agent: crate::review::ids::ParticipantId = dummy_id("gate-agent");

        for (event_id, author, suggestion_id, replacement) in [
            ("evt-gate-one", "gate-agent", "suggestion-one", "accepted"),
            ("evt-gate-two", "gate-agent", "suggestion-two", "rejected"),
            ("evt-other", "other-agent", "suggestion-other", "invisible"),
        ] {
            let created = verdicts_test_event(
                &room_id,
                event_id,
                author,
                ReviewEventBody::SuggestionCreated {
                    suggestion_id: suggestion_id.to_string(),
                    anchor: dummy_anchor(),
                    operation: SuggestionOperation::Replace {
                        expected_text: "old".to_string(),
                        replacement: replacement.to_string(),
                    },
                    note: None,
                },
            );
            mgr.store.append_event(&room_id, &created).expect("create");
        }

        let mut waiter = {
            let mgr = Arc::clone(&mgr);
            let gate_agent = gate_agent.clone();
            tokio::spawn(async move { mgr.wait_for_verdicts(Some(&gate_agent), None, None).await })
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut waiter)
                .await
                .is_err(),
            "gate must remain blocked before verdicts after being actively scheduled"
        );

        let owner_bytes = b"# Gate result\n\nfirst accepted\n\nsecond unchanged\n";
        let owner_path = tmp.path().join("owner.md");
        std::fs::write(&owner_path, owner_bytes).expect("write owner result");
        let resulting_hash = content_hash(&std::fs::read(owner_path).expect("read owner result"));
        let expected_hash = serde_json::to_value(&resulting_hash)
            .expect("serialize canonical hash")
            .as_str()
            .expect("hash is a string")
            .to_string();

        let accepted = verdicts_test_event(
            &room_id,
            "evt-gate-accepted",
            "owner",
            ReviewEventBody::SuggestionAccepted {
                suggestion_id: "suggestion-one".to_string(),
                applied_revision_id: "revision-gate".to_string(),
                resulting_hash,
            },
        );
        let rejected = verdicts_test_event(
            &room_id,
            "evt-gate-rejected",
            "owner",
            ReviewEventBody::SuggestionRejected {
                suggestion_id: "suggestion-two".to_string(),
                reason: Some("not for this change".to_string()),
            },
        );
        mgr.store.append_event(&room_id, &accepted).expect("accept");
        mgr.store.append_event(&room_id, &rejected).expect("reject");
        forward_transport_event(
            &mgr.update_tx,
            &mgr.store,
            TransportObservers {
                verdict_revision_tx: &mgr.verdict_revision_tx,
                notifications: None,
                local_is_owner: false,
            },
            &room_id,
            "owner-device",
            None,
            crate::review::transport::TransportEvent::EventImported {
                room_id: room_id.clone(),
                event: rejected,
                newly_imported: true,
            },
        );

        let outcome = waiter
            .await
            .expect("join waiter")
            .expect("wait for verdicts");
        let VerdictWaitOutcome::Complete(report) = outcome else {
            panic!("mixed verdict gate should complete")
        };
        let suggestions = &report.rooms["room-e2e-gate"].suggestions;
        assert_eq!(
            suggestions.len(),
            2,
            "distinct agent suggestions stay scoped out"
        );
        assert_eq!(
            suggestions["suggestion-one"].status,
            SuggestionVerdictStatus::Accepted
        );
        assert_eq!(
            suggestions["suggestion-one"].resulting_hash.as_deref(),
            Some(expected_hash.as_str())
        );
        assert_eq!(
            suggestions["suggestion-two"].status,
            SuggestionVerdictStatus::Rejected
        );
        assert!(!suggestions.contains_key("suggestion-other"));
    }

    fn dummy_id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(serde_json::Value::String(s.to_string())).expect("id deserializes")
    }

    fn dummy_anchor() -> Anchor {
        Anchor {
            v: 2,
            file_id: dummy_id::<FileId>("file-1"),
            snapshot_id: dummy_id::<SnapshotId>("snap-1"),
            base_hash: dummy_id::<ContentHash>("hash-1"),
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

    #[test]
    fn manager_can_be_instantiated() {
        // Smoke test: construction must succeed and the manager must accept
        // an empty command flow without panicking.
        let (_mgr, _rx, _tmp) = make_manager();
    }

    #[test]
    fn verdicts_aggregate_multiple_rooms_with_deterministic_serialization() {
        let (mgr, _rx, _tmp) = make_manager();
        for room in ["room-z", "room-a"] {
            std::fs::create_dir_all(mgr.store.root().join("rooms").join(room))
                .expect("create persisted room directory");
        }

        let report = mgr.verdicts(None).expect("aggregate verdicts");
        assert_eq!(
            serde_json::to_string(&report).expect("serialize"),
            r#"{"rooms":{"room-a":{"suggestions":{}},"room-z":{"suggestions":{}}}}"#
        );
    }

    #[test]
    fn submit_share_emits_room_status_changed_update() {
        let (mgr, rx, _tmp) = make_manager();
        mgr.submit(ReviewCommand::Share {
            path: PathBuf::from("/tmp/plan.md"),
            selected_paths: Vec::new(),
            primary_path: None,
            mode: "live".to_string(),
            ttl: None,
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert!(
                    status.contains("Pending share"),
                    "stub status should advertise pending share, got: {status}"
                );
            }
            other => panic!("expected RoomStatusChanged, got {other:?}"),
        }
        // No additional updates should have fired.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn submit_join_status_never_exposes_invite_fragment() {
        let (mgr, rx, _tmp) = make_manager();
        let invite = "attn://review/abc#key=xyz".to_string();
        mgr.submit(ReviewCommand::Join {
            invite: invite.clone(),
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert!(status.contains("Pending join"));
                assert!(!status.contains(&invite));
                assert!(!status.contains("key=xyz"));
            }
            other => panic!("expected RoomStatusChanged, got {other:?}"),
        }
    }

    #[test]
    fn submit_create_comment_emits_event_imported_with_room() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-abc");
        mgr.submit(ReviewCommand::CreateComment {
            room_id: room_id.clone(),
            anchor: dummy_anchor(),
            body: "looks great".to_string(),
            parent_thread_id: None,
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::EventImported {
                room_id: rid,
                event,
            } => {
                assert_eq!(rid, room_id);
                assert!(
                    matches!(
                        event.body,
                        crate::review::model::ReviewEventBody::CommentCreated { .. }
                    ),
                    "expected CommentCreated body, got {:?}",
                    event.body
                );
            }
            other => panic!("expected EventImported, got {other:?}"),
        }
    }

    #[test]
    fn submit_create_suggestion_emits_event_imported_with_room() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-abc");
        let draft = SuggestionDraft {
            anchor: dummy_anchor(),
            operation: SuggestionOperation::Replace {
                expected_text: "foo".to_string(),
                replacement: "bar".to_string(),
            },
            note: None,
        };
        mgr.submit(ReviewCommand::CreateSuggestion {
            room_id: room_id.clone(),
            draft,
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::EventImported {
                room_id: rid,
                event,
            } => {
                assert_eq!(rid, room_id);
                assert!(matches!(
                    event.body,
                    crate::review::model::ReviewEventBody::SuggestionCreated { .. }
                ));
            }
            other => panic!("expected EventImported, got {other:?}"),
        }
    }

    #[test]
    fn comment_grant_rejects_suggestion_before_event_or_outbox() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-comment-only");
        mgr.set_local_grant_tier(room_id.clone(), Some(GrantTier::Comment));
        assert!(matches!(
            rx.try_recv().expect("tier update"),
            ReviewUpdate::LocalGrantTierChanged {
                grant_tier: GrantTier::Comment,
                ..
            }
        ));

        mgr.submit(ReviewCommand::CreateSuggestion {
            room_id: room_id.clone(),
            draft: SuggestionDraft {
                anchor: dummy_anchor(),
                operation: SuggestionOperation::Replace {
                    expected_text: "foo".into(),
                    replacement: "bar".into(),
                },
                note: None,
            },
        });
        assert!(matches!(
            rx.try_recv().expect("authorization error"),
            ReviewUpdate::Error { code, .. } if code == "ATTN_GRANT_FORBIDDEN"
        ));
        assert!(
            mgr.store
                .iter_events(&room_id)
                .expect("events")
                .next()
                .is_none()
        );
        assert!(rx.try_recv().is_err(), "no event/outbox update may escape");
    }

    #[test]
    fn submit_accept_suggestion_carries_event_id_through() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-abc");
        let suggestion_id: EventId = dummy_id("evt-99");
        mgr.submit(ReviewCommand::AcceptSuggestion {
            room_id: room_id.clone(),
            suggestion_id: suggestion_id.clone(),
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::EventImported {
                room_id: rid,
                event,
            } => {
                assert_eq!(rid, room_id);
                // The stub path mirrors the requested suggestion_id back via
                // the body so the test still pins which suggestion is being
                // accepted.
                match event.body {
                    crate::review::model::ReviewEventBody::SuggestionAccepted {
                        suggestion_id: sid,
                        ..
                    } => {
                        let expected = format!("{:?}", suggestion_id);
                        assert_eq!(sid, expected);
                    }
                    other => panic!("expected SuggestionAccepted body, got {other:?}"),
                }
            }
            other => panic!("expected EventImported, got {other:?}"),
        }
    }

    #[test]
    fn submit_resolve_anchor_emits_anchor_resolution_changed() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-abc");
        let event_id: EventId = dummy_id("evt-1");
        let range = PositionAnchor {
            byte_range: [0, 10],
            line_range: [1, 1],
            pm_range: None,
        };
        mgr.submit(ReviewCommand::ResolveAnchor {
            room_id: room_id.clone(),
            event_id: event_id.clone(),
            range: range.clone(),
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::AnchorResolutionChanged {
                room_id: rid,
                event_id: eid,
                file_id: _,
                resolved,
            } => {
                assert_eq!(rid, room_id);
                assert_eq!(eid, event_id);
                match resolved {
                    ResolvedAnchor::Remapped { current_range, .. } => {
                        assert_eq!(current_range, range);
                    }
                    other => panic!("expected Remapped stub, got {other:?}"),
                }
            }
            other => panic!("expected AnchorResolutionChanged, got {other:?}"),
        }
    }

    #[test]
    fn submit_pull_and_stop_and_inbox_emit_room_status() {
        // Every "lifecycle" command should funnel through RoomStatusChanged
        // in the scaffold, so the frontend sees *something* even before real
        // transport handlers exist.
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-abc");

        mgr.submit(ReviewCommand::Pull {
            room_id: Some(room_id.clone()),
        });
        mgr.submit(ReviewCommand::Stop {
            room_id: Some(room_id.clone()),
        });
        mgr.submit(ReviewCommand::Inbox);

        let updates: Vec<ReviewUpdate> = (0..3)
            .map(|_| rx.try_recv().expect("update available"))
            .collect();
        assert_eq!(updates.len(), 3);
        for update in &updates {
            assert!(
                matches!(update, ReviewUpdate::RoomStatusChanged { .. }),
                "expected RoomStatusChanged, got {update:?}"
            );
        }
    }

    #[test]
    fn callback_name_routes_each_variant() {
        // Pin the callback routing so a frontend rename can't silently break
        // the dispatch arm in main.rs.
        let room_id: RoomId = dummy_id("room-abc");
        let event_id: EventId = dummy_id("evt-1");
        assert_eq!(
            ReviewUpdate::RoomStatusChanged {
                room_id: room_id.clone(),
                status: "x".to_string()
            }
            .callback_name(),
            "reviewStatus"
        );
        assert_eq!(
            ReviewUpdate::EventImported {
                room_id: room_id.clone(),
                event: stub_review_event(
                    &room_id,
                    crate::review::model::ReviewEventBody::CommentCreated {
                        thread_id: "thr".to_string(),
                        anchor: dummy_anchor(),
                        body: "body".to_string(),
                    },
                ),
            }
            .callback_name(),
            "reviewEvent"
        );
        let _ = &event_id; // referenced below
        assert_eq!(
            ReviewUpdate::SnapshotCreated {
                room_id: room_id.clone(),
                snapshot_id: "s".to_string(),
                file_id: "f".to_string()
            }
            .callback_name(),
            "reviewSnapshot"
        );
        assert_eq!(
            ReviewUpdate::AnchorResolutionChanged {
                room_id: room_id.clone(),
                event_id,
                file_id: dummy_id::<FileId>("file-1"),
                resolved: ResolvedAnchor::Stale {
                    reason: "low_confidence".to_string()
                },
            }
            .callback_name(),
            "reviewAnchorResolution"
        );
        assert_eq!(
            ReviewUpdate::OutboxChanged {
                room_id: room_id.clone(),
                pending_count: 0
            }
            .callback_name(),
            "reviewStatus"
        );
        assert_eq!(
            ReviewUpdate::Error {
                room_id: Some(room_id),
                code: "x".to_string(),
                message: "y".to_string()
            }
            .callback_name(),
            "reviewStatus"
        );
    }

    #[test]
    fn review_update_serializes_camel_case() {
        // The frontend types in web/src/lib/types.ts expect camelCase. Pin
        // the wire shape so a future rename of a Rust field stays compatible.
        let room_id: RoomId = dummy_id("room-abc");
        let update = ReviewUpdate::EventImported {
            room_id: room_id.clone(),
            event: stub_review_event(
                &room_id,
                crate::review::model::ReviewEventBody::CommentCreated {
                    thread_id: "thr-1".to_string(),
                    anchor: dummy_anchor(),
                    body: "hi".to_string(),
                },
            ),
        };
        let json = serde_json::to_value(&update).expect("serialize update");
        assert_eq!(json["kind"], serde_json::json!("event_imported"));
        assert_eq!(json["roomId"], serde_json::json!("room-abc"));
        // The nested event uses ReviewEvent's own serde shape (camelCase).
        assert!(json["event"]["meta"].is_object());
        assert!(json["event"]["body"].is_object());
        assert_eq!(
            json["event"]["body"]["type"],
            serde_json::json!("comment_created")
        );
    }

    // ----- attn-nnj.3.8 anchor-resolution emission -----------------------

    #[test]
    fn emit_anchor_resolution_fires_anchor_resolution_changed_update() {
        // Issue attn-nnj.3.8: the public `emit_anchor_resolution` entrypoint
        // is the seam the later anchor-engine scheduler will call. Verify it
        // routes through `update_tx` as an `AnchorResolutionChanged` carrying
        // the resolver's full `ResolvedAnchor` payload.
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-abc");
        let event_id: EventId = dummy_id("evt-42");
        let file_id: FileId = dummy_id("file-99");
        let range = PositionAnchor {
            byte_range: [10, 25],
            line_range: [3, 4],
            pm_range: None,
        };
        let resolved = ResolvedAnchor::Exact {
            confidence: 1.0,
            current_range: range.clone(),
            reason: crate::review::model::ExactReason::BaseHashMatch,
        };

        mgr.emit_anchor_resolution(
            room_id.clone(),
            event_id.clone(),
            file_id.clone(),
            resolved.clone(),
        );

        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::AnchorResolutionChanged {
                room_id: rid,
                event_id: eid,
                file_id: fid,
                resolved: got,
            } => {
                assert_eq!(rid, room_id);
                assert_eq!(eid, event_id);
                assert_eq!(fid, file_id);
                assert_eq!(got, resolved);
            }
            other => panic!("expected AnchorResolutionChanged, got {other:?}"),
        }
        assert!(
            rx.try_recv().is_err(),
            "emit_anchor_resolution must fire exactly one update"
        );
    }

    #[test]
    fn anchor_resolution_changed_serializes_to_frontend_shape() {
        // Pin the wire envelope: the frontend `ReviewAnchorResolutionUpdate`
        // in `web/src/lib/types.ts` expects roomId/eventId/fileId/resolved
        // (camelCase) with `resolved.status` as the tag — this round-trip
        // proves `evaluate_script(window.__attn__.reviewAnchorResolution(...))`
        // hands the store a payload it can consume verbatim.
        let update = ReviewUpdate::AnchorResolutionChanged {
            room_id: dummy_id::<RoomId>("room-abc"),
            event_id: dummy_id::<EventId>("evt-1"),
            file_id: dummy_id::<FileId>("file-1"),
            resolved: ResolvedAnchor::Remapped {
                confidence: 0.85,
                current_range: PositionAnchor {
                    byte_range: [0, 5],
                    line_range: [1, 1],
                    pm_range: None,
                },
                reason: crate::review::model::RemappedReason::QuoteMatch,
            },
        };
        let json = serde_json::to_value(&update).expect("serialize update");
        assert_eq!(json["kind"], serde_json::json!("anchor_resolution_changed"));
        assert_eq!(json["roomId"], serde_json::json!("room-abc"));
        assert_eq!(json["eventId"], serde_json::json!("evt-1"));
        assert_eq!(json["fileId"], serde_json::json!("file-1"));
        assert_eq!(json["resolved"]["status"], serde_json::json!("remapped"));
        assert_eq!(json["resolved"]["reason"], serde_json::json!("quote_match"));
        assert_eq!(json["resolved"]["confidence"], serde_json::json!(0.85));
        assert_eq!(update.callback_name(), "reviewAnchorResolution");
    }

    // -----------------------------------------------------------------
    // Stop / Inbox over the per-room runtime registries.
    //
    // We can't stand up a full `start_room_runtime` here (it needs a relay
    // URL, identity, and a room secret on disk), so we simulate the registry
    // state the runtime would have produced: a live `cancel_tx` keyed by room.
    // This exercises exactly the teardown contract `Stop` relies on.
    // -----------------------------------------------------------------

    /// Seed a room's cancel handle as if `start_room_runtime` had run, and
    /// return a receiver so the test can observe the cancel signal.
    fn seed_room_runtime(
        mgr: &ReviewManager,
        room_id: &RoomId,
    ) -> tokio::sync::watch::Receiver<bool> {
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        mgr.cancels
            .lock()
            .expect("cancels lock")
            .insert(room_id.clone(), cancel_tx);
        cancel_rx
    }

    #[test]
    fn stop_signals_cancel_and_removes_room_from_registries() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-stop");
        let cancel_rx = seed_room_runtime(&mgr, &room_id);
        // Mirror a live WebRTC entry so we can prove it is dropped too.
        mgr.live_webrtc.lock().expect("live lock").insert(
            room_id.clone(),
            LiveWebrtc {
                transports: HashMap::new(),
                peers: 1,
            },
        );

        assert!(!*cancel_rx.borrow(), "cancel starts false");

        mgr.submit(ReviewCommand::Stop {
            room_id: Some(room_id.clone()),
        });

        // Cancel was flipped before the sender dropped.
        assert!(
            *cancel_rx.borrow(),
            "Stop should flip the room's cancel signal to true"
        );
        // The room is gone from every registry the runtime populated.
        assert!(
            !mgr.cancels
                .lock()
                .expect("cancels lock")
                .contains_key(&room_id),
            "Stop should remove the room from `cancels`"
        );
        assert!(
            !mgr.live_webrtc
                .lock()
                .expect("live lock")
                .contains_key(&room_id),
            "Stop should remove the room from `live_webrtc`"
        );
        assert!(
            !mgr.outboxes
                .lock()
                .expect("outboxes lock")
                .contains_key(&room_id),
            "Stop should remove the room from `outboxes`"
        );

        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::RoomStatusChanged {
                room_id: rid,
                status,
            } => {
                assert_eq!(rid, room_id);
                assert_eq!(status, "Stopped");
            }
            other => panic!("expected RoomStatusChanged(Stopped), got {other:?}"),
        }
    }

    #[test]
    fn stop_unknown_room_is_a_clean_noop() {
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-never-started");
        // No runtime was ever seeded for this room.
        mgr.submit(ReviewCommand::Stop {
            room_id: Some(room_id.clone()),
        });
        // Still emits a status (never an Error), and registries stay empty.
        let update = rx.try_recv().expect("expected one update");
        assert!(
            matches!(update, ReviewUpdate::RoomStatusChanged { status, .. } if status == "Stopped"),
            "stopping an unknown room should be a clean Stopped status, not an error"
        );
    }

    #[test]
    fn stop_all_tears_down_every_active_room() {
        let (mgr, _rx, _tmp) = make_manager();
        let room_a: RoomId = dummy_id("room-a");
        let room_b: RoomId = dummy_id("room-b");
        let rx_a = seed_room_runtime(&mgr, &room_a);
        let rx_b = seed_room_runtime(&mgr, &room_b);

        mgr.submit(ReviewCommand::Stop { room_id: None });

        assert!(*rx_a.borrow(), "room-a cancel flipped");
        assert!(*rx_b.borrow(), "room-b cancel flipped");
        assert!(
            mgr.cancels.lock().expect("cancels lock").is_empty(),
            "Stop(None) should drain the cancels registry"
        );
    }

    #[test]
    fn inbox_lists_active_rooms() {
        let (mgr, rx, _tmp) = make_manager();
        let room_a: RoomId = dummy_id("room-inbox-a");
        let room_b: RoomId = dummy_id("room-inbox-b");
        let _rx_a = seed_room_runtime(&mgr, &room_a);
        let _rx_b = seed_room_runtime(&mgr, &room_b);

        mgr.submit(ReviewCommand::Inbox);

        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert!(status.contains("2 active room(s)"), "got: {status}");
                assert!(status.contains("room-inbox-a"), "got: {status}");
                assert!(status.contains("room-inbox-b"), "got: {status}");
            }
            other => panic!("expected RoomStatusChanged, got {other:?}"),
        }
    }

    #[test]
    fn inbox_with_no_active_rooms_reports_empty() {
        let (mgr, rx, _tmp) = make_manager();
        mgr.submit(ReviewCommand::Inbox);
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert_eq!(status, "Inbox: no active rooms");
            }
            other => panic!("expected RoomStatusChanged, got {other:?}"),
        }
    }

    #[test]
    fn pull_without_runtime_is_a_noop_status() {
        // The base `make_manager` attaches no tokio runtime, so Pull cannot
        // drive an outbox — it must emit a benign status, never an error.
        let (mgr, rx, _tmp) = make_manager();
        let room_id: RoomId = dummy_id("room-pull");
        mgr.submit(ReviewCommand::Pull {
            room_id: Some(room_id.clone()),
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert!(status.starts_with("Pulled"), "got: {status}");
            }
            other => panic!("expected RoomStatusChanged, got {other:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Bootstrap integration tests (attn-nnj.6.6)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod bootstrap_integration_tests {
    use super::*;
    use crate::review::bootstrap::{
        BootstrapConfig, Bootstrapper, build_invite_url, load_identity_from,
    };
    use crate::review::crypto::kdf::derive_room_id;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;
    use std::sync::mpsc;
    use tempfile::TempDir;
    use tokio::sync::RwLock;
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Wire a manager pre-loaded with a bootstrap pipeline pointing at the
    /// supplied wiremock URL. Returns the manager + the receiver of emitted
    /// updates + a temp dir holding both the store and the identity file.
    fn make_bootstrapped_manager(
        relay_url: String,
    ) -> (
        ReviewManager,
        mpsc::Receiver<ReviewUpdate>,
        TempDir,
        TempDir,
    ) {
        let store_tmp = TempDir::new().expect("store tempdir");
        let id_tmp = TempDir::new().expect("id tempdir");
        let store =
            Arc::new(ReviewStore::open_at(store_tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());

        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = StdMutex::new(tx);
        let sink: UpdateSink = Arc::new(move |update| {
            let _ = tx.lock().expect("sink mutex").send(update);
        });

        let cfg = Arc::new(BootstrapConfig {
            relay_url,
            identity_dir: Some(id_tmp.path().to_path_buf()),
        });
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("client");
        let boot = Arc::new(Bootstrapper::with_http_client(
            Arc::clone(&store),
            cfg,
            http,
        ));
        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("runtime"),
        );
        let cache = Arc::new(RwLock::new(HashMap::new()));
        let mgr = ReviewManager::new(store, working_copy, sink)
            .with_bootstrap_components(boot, runtime, cache);
        (mgr, rx, store_tmp, id_tmp)
    }

    fn temp_markdown_file(name: &str, body: &str) -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().expect("markdown tempdir");
        let path = dir.path().join(name);
        std::fs::write(&path, body).expect("write markdown fixture");
        (dir, path)
    }

    /// Set up wiremock stubs accepting any room create + device register.
    async fn mount_create_and_register(server: &MockServer) {
        Mock::given(method("POST"))
            .and(wiremock::matchers::path_regex(
                r"^/v3/rooms/[A-Za-z0-9_-]+$",
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "roomId": "any",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .mount(server)
            .await;
        // The join compatibility assertion below deliberately exercises a
        // persisted v2 invite while new shares use v3.
        Mock::given(method("POST"))
            .and(wiremock::matchers::path_regex(
                r"^/v2/rooms/[A-Za-z0-9_-]+$",
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "roomId": "any",
                "createdAt": 0u64,
                "expiresAt": 0u64,
                "policy": {},
                "ownerSigningKeyId": "k",
                "serverSeq": 0,
            })))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path_regex(
                r"^/v2/rooms/[A-Za-z0-9_-]+/devices$",
            ))
            .respond_with(ResponseTemplate::new(204))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path_regex(
                r"^/v3/rooms/[A-Za-z0-9_-]+/devices$",
            ))
            .respond_with(ResponseTemplate::new(204))
            .mount(server)
            .await;
    }

    async fn mount_get_devices_empty(server: &MockServer) {
        Mock::given(method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/v2/rooms/[A-Za-z0-9_-]+/devices$",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "devices": []
            })))
            .mount(server)
            .await;
    }

    #[test]
    fn submit_share_with_bootstrap_emits_live_status_with_invite() {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        let server = runtime.block_on(MockServer::start());
        runtime.block_on(mount_create_and_register(&server));

        let (mgr, rx, _store_tmp, id_tmp) = make_bootstrapped_manager(server.uri());
        let (_doc_tmp, path) = temp_markdown_file("manager-share.md", "# Manager share\n");
        mgr.submit(ReviewCommand::Share {
            path,
            selected_paths: Vec::new(),
            primary_path: None,
            mode: "async".to_string(),
            ttl: None,
        });

        // emit_share_outcome now drops two updates: ShareReady (rich
        // payload for the dialog) followed by RoomStatusChanged (drives
        // the ReviewBar visibility).
        let first = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("first");
        let invite = match first {
            ReviewUpdate::ShareReady {
                invite_url,
                browser_invite_url,
                view_invite_url,
                suggest_invite_url,
                browser_view_invite_url,
                browser_suggest_invite_url,
                owner_signing_key,
                mode,
                expires_at,
                ..
            } => {
                assert!(
                    invite_url.starts_with("attn://review/"),
                    "ShareReady invite_url shape, got: {invite_url}"
                );
                assert!(
                    browser_invite_url.starts_with("https://attn.sh/review/"),
                    "ShareReady browser_invite_url shape, got: {browser_invite_url}"
                );
                assert!(view_invite_url.contains("tier=view"));
                assert!(suggest_invite_url.contains("tier=suggest"));
                assert!(browser_view_invite_url.contains("tier=view"));
                assert!(browser_suggest_invite_url.contains("tier=suggest"));
                assert_eq!(mode, "async", "wire mode string round-trips");
                assert!(!owner_signing_key.is_empty(), "owner key surfaced");
                assert!(expires_at > 0, "expires_at populated");
                invite_url
            }
            other => panic!("expected ShareReady first, got {other:?}"),
        };
        let second = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("second");
        match second {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert_eq!(status, "Live", "post-share status flips to Live");
            }
            other => panic!("expected RoomStatusChanged second, got {other:?}"),
        }
        // Starting the live runtime is best-effort. With no WebSocket mock,
        // its expected transport error can race onto the channel here.
        if let Ok(third) = rx.try_recv() {
            assert!(
                matches!(&third, ReviewUpdate::LocalGrantTierChanged { .. })
                    || matches!(&third, ReviewUpdate::Error { code, .. } if code == "ATTN_TRANSPORT_INIT" || code == "ATTN_WS"),
                "unexpected third update: {third:?}"
            );
        }
        let _ = invite;
        // Identity must be on disk.
        let identity = load_identity_from(id_tmp.path())
            .expect("load id")
            .expect("present");
        assert!(!identity.device_id.is_empty());
        assert!(!identity.public_signing_key.is_empty());
    }

    #[test]
    fn submit_join_with_bootstrap_emits_joined_status() {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        let server = runtime.block_on(MockServer::start());
        runtime.block_on(mount_create_and_register(&server));
        runtime.block_on(mount_get_devices_empty(&server));

        let (mgr, rx, _store_tmp, _id_tmp) = make_bootstrapped_manager(server.uri());

        let secret = [0x33u8; 32];
        let room_id = derive_room_id(&secret);
        let invite = build_invite_url(&room_id, &secret);

        mgr.submit(ReviewCommand::Join {
            invite: invite.clone(),
        });
        // The join flow spawns the live WS subscriber (start_room_runtime)
        // BEFORE emitting "Joined" — see emit_join_outcome. With no WS mock
        // mounted, that subscriber's dial 404s and emits an Error update,
        // which can race ahead of "Joined" on the channel (it does on Linux).
        // The contract under test is that "Joined" is surfaced regardless of
        // WS health, so drain updates until we observe it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut joined = false;
        let mut seen = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(ReviewUpdate::RoomStatusChanged {
                    room_id: rid,
                    status,
                }) if status == "Joined" => {
                    assert_eq!(rid, room_id);
                    joined = true;
                    break;
                }
                // Ignore the expected transient WS-dial failure and any other
                // pre-"Joined" updates.
                Ok(update) => {
                    seen.push(format!("{update:?}"));
                    continue;
                }
                Err(_) => break,
            }
        }
        assert!(
            joined,
            "expected a RoomStatusChanged {{ status: \"Joined\" }} update; saw {seen:?}"
        );
    }

    #[test]
    fn submit_join_with_malformed_invite_emits_error_update() {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        let server = runtime.block_on(MockServer::start());
        let (mgr, rx, _store_tmp, _id_tmp) = make_bootstrapped_manager(server.uri());

        mgr.submit(ReviewCommand::Join {
            invite: "not-an-invite".to_string(),
        });
        let update = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("update");
        match update {
            ReviewUpdate::Error { code, .. } => {
                assert_eq!(code, "ATTN_INVITE_PARSE");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Transport selector tests (attn-nnj.7.5)
//
// Drives `ReviewManager::open_room_transports` + `send_envelopes` end-to-end
// through the public API using the in-process mock senders from
// `transport::selector::test_support`. The selector module's own tests
// pin the routing rules in isolation; this module proves the same rules
// flow through the manager facade and that the manager dispatches the
// expected `ReviewUpdate::Error` on the Live-required failure path.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod transport_selector_tests {
    use super::*;
    use crate::review::transport::TransportError;
    use crate::review::transport::selector::test_support::{
        MailboxOutcome, MockMailbox, MockWebRtc, dummy_envelope,
    };
    use crate::review::transport::selector::{
        MailboxSender, TransportConfig, TransportMode, WebRtcSender,
    };
    use std::sync::Mutex;
    use std::sync::mpsc;
    use tempfile::TempDir;

    fn make_manager() -> (ReviewManager, mpsc::Receiver<ReviewUpdate>, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());
        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = Mutex::new(tx);
        let sink: UpdateSink = Arc::new(move |update| {
            let _ = tx.lock().expect("sink mutex").send(update);
        });
        let mgr = ReviewManager::new(store, working_copy, sink);
        (mgr, rx, tmp)
    }

    fn dummy_room() -> RoomId {
        serde_json::from_value(serde_json::Value::String("room-7-5".to_string())).unwrap()
    }

    // -----------------------------------------------------------------
    // 1. Live mode: webrtc disconnected -> ATTN_LIVE_REQUIRED error
    //    update + envelopes NOT sent via mailbox (mailbox is None in Live).
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn live_mode_disconnected_emits_live_required_and_does_not_send_mailbox() {
        let (mgr, rx, _tmp) = make_manager();
        let room = dummy_room();
        let webrtc = Arc::new(MockWebRtc::new(false)); // not connected

        mgr.open_room_transports(
            &room,
            TransportMode::Live,
            TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<dyn WebRtcSender>)),
        )
        .await
        .expect("open live transports");

        // Mailbox would never have been built in Live mode; assert via
        // the manager's accessor.
        assert_eq!(mgr.room_mode(&room).await, Some(TransportMode::Live));

        let err = mgr
            .send_envelopes(&room, vec![dummy_envelope("env-live-1", &room)])
            .await
            .expect_err("live send must fail when webrtc down");
        match err {
            TransportError::Io(msg) => {
                assert!(
                    msg.contains("ATTN_LIVE_REQUIRED"),
                    "expected ATTN_LIVE_REQUIRED in error message, got: {msg}"
                );
            }
            other => panic!("expected Io(ATTN_LIVE_REQUIRED), got {other:?}"),
        }

        // The manager surfaces the failure as a ReviewUpdate::Error so the UI
        // can show "direct connection failed" — matching amendments.md
        // Phase 4 "no silent mailbox fallback".
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::Error {
                room_id: rid, code, ..
            } => {
                assert_eq!(rid.as_ref(), Some(&room));
                assert_eq!(code, "ATTN_LIVE_REQUIRED");
            }
            other => panic!("expected ReviewUpdate::Error, got {other:?}"),
        }
        // No webrtc send was attempted either — the pre-flight failed.
        assert_eq!(webrtc.total_sent(), 0);
    }

    // -----------------------------------------------------------------
    // 2. Live mode: even if mailbox returns AdmissionRejected and the
    //    webrtc transport returns a connect-failure, the envelopes must
    //    NOT be routed via mailbox. Verifies the no-fallback rule.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn live_mode_never_falls_back_to_mailbox_even_under_failure() {
        let (mgr, _rx, _tmp) = make_manager();
        let room = dummy_room();
        // Mailbox would reject if asked (admission failure) — proves the
        // selector NEVER asks it in Live mode.
        let _mailbox_unused = Arc::new(MockMailbox::with_outcome(MailboxOutcome::Error(
            TransportError::AdmissionRejected,
        )));
        let webrtc = Arc::new(MockWebRtc::new(false));
        mgr.open_room_transports(
            &room,
            TransportMode::Live,
            TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<dyn WebRtcSender>)),
        )
        .await
        .expect("open live transports");

        let err = mgr
            .send_envelopes(&room, vec![dummy_envelope("env-live-2", &room)])
            .await
            .expect_err("live send must fail");
        assert!(matches!(err, TransportError::Io(_)));
        // mailbox_unused was never wired in, so we can only assert that we
        // never reached for a mailbox handle — which the selector enforces
        // by holding `mailbox: None` for Live. The Live test in selector.rs
        // covers the deeper "mailbox handle present but unused" case.
        assert_eq!(webrtc.total_sent(), 0);
    }

    // -----------------------------------------------------------------
    // 3. Async mode: only the mailbox is used; webrtc handle is None.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn async_mode_uses_mailbox_only_and_returns_server_seqs() {
        let (mgr, _rx, _tmp) = make_manager();
        let room = dummy_room();
        let mailbox = Arc::new(MockMailbox::new());
        mgr.open_room_transports(
            &room,
            TransportMode::Async,
            TransportConfig::from_handles(Some(mailbox.clone() as Arc<dyn MailboxSender>), None),
        )
        .await
        .expect("open async transports");

        assert_eq!(mgr.room_mode(&room).await, Some(TransportMode::Async));

        let acks = mgr
            .send_envelopes(
                &room,
                vec![
                    dummy_envelope("env-async-1", &room),
                    dummy_envelope("env-async-2", &room),
                ],
            )
            .await
            .expect("async send ok");
        assert_eq!(acks.len(), 2);
        // Mock mailbox assigns serverSeqs starting at 1.
        assert_eq!(acks[0].server_seq, 1);
        assert_eq!(acks[1].server_seq, 2);
        assert_eq!(mailbox.total_sent(), 2);
    }

    // -----------------------------------------------------------------
    // 4. Hybrid mode: webrtc connected -> DataChannel send; mailbox also
    //    receives the envelope (parallel delivery; receiver dedups).
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn hybrid_mode_connected_sends_to_both_paths() {
        let (mgr, _rx, _tmp) = make_manager();
        let room = dummy_room();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(true));
        mgr.open_room_transports(
            &room,
            TransportMode::Hybrid,
            TransportConfig::from_handles(
                Some(mailbox.clone() as Arc<dyn MailboxSender>),
                Some(webrtc.clone() as Arc<dyn WebRtcSender>),
            ),
        )
        .await
        .expect("open hybrid transports");

        let acks = mgr
            .send_envelopes(&room, vec![dummy_envelope("env-hy-1", &room)])
            .await
            .expect("hybrid send ok");
        assert_eq!(acks.len(), 1);
        // Mailbox returned the serverSeq; webrtc also received the bytes.
        assert_eq!(mailbox.total_sent(), 1);
        assert_eq!(webrtc.total_sent(), 1, "hybrid must also drive webrtc");
    }

    // -----------------------------------------------------------------
    // 5. Hybrid mode: webrtc disconnected -> mailbox only; NO error.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn hybrid_mode_disconnected_uses_mailbox_only_no_error() {
        let (mgr, rx, _tmp) = make_manager();
        let room = dummy_room();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(false));
        mgr.open_room_transports(
            &room,
            TransportMode::Hybrid,
            TransportConfig::from_handles(
                Some(mailbox.clone() as Arc<dyn MailboxSender>),
                Some(webrtc.clone() as Arc<dyn WebRtcSender>),
            ),
        )
        .await
        .expect("open hybrid transports");

        let acks = mgr
            .send_envelopes(&room, vec![dummy_envelope("env-hy-2", &room)])
            .await
            .expect("hybrid send must succeed even when webrtc is down");
        assert_eq!(acks.len(), 1);
        assert_eq!(mailbox.total_sent(), 1);
        assert_eq!(webrtc.total_sent(), 0);
        // No ReviewUpdate emitted on the no-error path.
        assert!(rx.try_recv().is_err(), "no update on hybrid happy path");
    }

    // -----------------------------------------------------------------
    // 6. Mode transition Live -> Hybrid: spawns mailbox transport without
    //    dropping existing connection. Subsequent send must drive both
    //    paths.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn live_to_hybrid_transition_attaches_mailbox_and_preserves_webrtc() {
        let (mgr, _rx, _tmp) = make_manager();
        let room = dummy_room();
        let webrtc = Arc::new(MockWebRtc::new(true));
        mgr.open_room_transports(
            &room,
            TransportMode::Live,
            TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<dyn WebRtcSender>)),
        )
        .await
        .expect("open live");

        // Confirm initial mode.
        assert_eq!(mgr.room_mode(&room).await, Some(TransportMode::Live));

        // Transition to Hybrid by attaching a fresh mailbox handle.
        let mailbox = Arc::new(MockMailbox::new());
        mgr.transition_room_mode(
            &room,
            TransportMode::Hybrid,
            Some(mailbox.clone() as Arc<dyn MailboxSender>),
        )
        .await
        .expect("Live -> Hybrid transition ok");
        assert_eq!(mgr.room_mode(&room).await, Some(TransportMode::Hybrid));

        // A subsequent send must drive both paths.
        let acks = mgr
            .send_envelopes(&room, vec![dummy_envelope("env-trans-1", &room)])
            .await
            .expect("send after transition ok");
        assert_eq!(acks.len(), 1);
        assert_eq!(mailbox.total_sent(), 1);
        assert_eq!(webrtc.total_sent(), 1, "webrtc must NOT be dropped");
    }

    // -----------------------------------------------------------------
    // 7. send_envelopes for an unknown room returns RoomNotFound.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn send_envelopes_unknown_room_returns_room_not_found() {
        let (mgr, _rx, _tmp) = make_manager();
        let room = dummy_room();
        let err = mgr
            .send_envelopes(&room, vec![dummy_envelope("env-x", &room)])
            .await
            .expect_err("unknown room must error");
        assert!(matches!(err, TransportError::RoomNotFound));
    }

    // -----------------------------------------------------------------
    // 8. send_envelopes failures bubble up as TransportError unchanged.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn async_mode_mailbox_failure_bubbles_up_unchanged() {
        let (mgr, rx, _tmp) = make_manager();
        let room = dummy_room();
        let mailbox = Arc::new(MockMailbox::with_outcome(MailboxOutcome::Error(
            TransportError::RateLimited(2500),
        )));
        mgr.open_room_transports(
            &room,
            TransportMode::Async,
            TransportConfig::from_handles(Some(mailbox as Arc<dyn MailboxSender>), None),
        )
        .await
        .expect("open async");

        let err = mgr
            .send_envelopes(&room, vec![dummy_envelope("env-rate", &room)])
            .await
            .expect_err("rate limit must bubble");
        match err {
            TransportError::RateLimited(ms) => assert_eq!(ms, 2500),
            other => panic!("expected RateLimited(2500), got {other:?}"),
        }
        // Mailbox failures are NOT the live-required path, so the manager
        // does NOT emit a ReviewUpdate::Error — the caller is responsible
        // for surfacing as needed.
        assert!(rx.try_recv().is_err(), "no Error update on mailbox failure");
    }

    // -----------------------------------------------------------------
    // 9. Hybrid -> Async transition drops the webrtc handle; subsequent
    //    sends must use mailbox only.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn hybrid_to_async_transition_drops_webrtc() {
        let (mgr, _rx, _tmp) = make_manager();
        let room = dummy_room();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(true));
        mgr.open_room_transports(
            &room,
            TransportMode::Hybrid,
            TransportConfig::from_handles(
                Some(mailbox.clone() as Arc<dyn MailboxSender>),
                Some(webrtc.clone() as Arc<dyn WebRtcSender>),
            ),
        )
        .await
        .expect("open hybrid");

        mgr.transition_room_mode(&room, TransportMode::Async, None)
            .await
            .expect("Hybrid -> Async ok");
        assert_eq!(mgr.room_mode(&room).await, Some(TransportMode::Async));

        let acks = mgr
            .send_envelopes(&room, vec![dummy_envelope("env-after-async", &room)])
            .await
            .expect("async send ok");
        assert_eq!(acks.len(), 1);
        assert_eq!(mailbox.total_sent(), 1);
        // WebRTC was dropped; never touched.
        assert_eq!(webrtc.total_sent(), 0);
    }

    // -----------------------------------------------------------------
    // 10. open_room_transports with a mismatched config errors cleanly.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn open_room_transports_rejects_mismatched_config() {
        let (mgr, _rx, _tmp) = make_manager();
        let room = dummy_room();
        // Live mode without a webrtc handle.
        let err = mgr
            .open_room_transports(
                &room,
                TransportMode::Live,
                TransportConfig::from_handles(None, None),
            )
            .await
            .expect_err("live without webrtc must error");
        assert!(matches!(err, TransportError::Io(_)));
        // Map remains empty.
        assert_eq!(mgr.room_mode(&room).await, None);
    }
}

// ---------------------------------------------------------------------------
// RequestSnapshot live-recovery tests (attn-nnj.7.6)
//
// Pins the round-trip for the amendments.md §Recovery from local-store loss
// path: client A → `request_snapshot` mints a SignalingPayload, owner B →
// `handle_inbound_request_snapshot` resolves the latest snapshot, mints a
// SnapshotCreated event, and routes it back over the DataChannel (or the
// mailbox fallback when the WebRTC arm is down).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod request_snapshot_tests {
    use super::*;
    use crate::review::crypto::kdf::derive_room_keys;
    use crate::review::ids::{ContentHash, ParticipantId, SnapshotId};
    use crate::review::model::{AnchorIndex, CanonicalEncoding, SnapshotNode, SnapshotPlaintext};
    use crate::review::transport::selector::test_support::{MockMailbox, MockWebRtc};
    use crate::review::transport::selector::{
        MailboxSender, TransportConfig, TransportMode, WebRtcSender,
    };
    use serde::Deserialize;
    use std::sync::Mutex as StdMutex;
    use std::sync::mpsc;
    use tempfile::TempDir;

    /// Pinned room secret — matches the corpus used across the rest of the
    /// review tests so a stray cross-module derivation divergence is loud.
    const TEST_ROOM_SECRET: [u8; 32] = [0x11u8; 32];
    const TEST_SIGNING_SEED: [u8; 32] = [0x22u8; 32];

    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(serde_json::Value::String(s.to_string()))
            .expect("typed id deserializes")
    }

    /// Build a `ReviewManager` + receiver + tempdir for a single recovery
    /// scenario. The manager is `new`-only (no bootstrap) — recovery tests
    /// drive the registry directly.
    fn make_manager_with_store() -> (
        ReviewManager,
        mpsc::Receiver<ReviewUpdate>,
        TempDir,
        Arc<ReviewStore>,
    ) {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());
        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = StdMutex::new(tx);
        let sink: UpdateSink = Arc::new(move |update| {
            let _ = tx.lock().expect("sink mutex").send(update);
        });
        let mgr = ReviewManager::new(Arc::clone(&store), working_copy, sink);
        (mgr, rx, tmp, store)
    }

    /// Mint a `RoomSignalContext` with the canonical pinned key material.
    fn fixture_signal_context(room_id: &RoomId, target: Option<DeviceId>) -> RoomSignalContext {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let signing_key =
            DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).expect("signing key from seed");
        RoomSignalContext {
            protocol_version: 2,
            room_id: room_id.clone(),
            author_id: id::<ParticipantId>("p-author-01"),
            local_device_id: id::<DeviceId>("d-local-01"),
            target_device_id: target,
            signing_key,
            event_key: *keys.event_key.as_bytes(),
            snapshot_key: *keys.snapshot_key.as_bytes(),
            signaling_key: *keys.signaling_key.as_bytes(),
        }
    }

    fn dummy_snapshot(snapshot_id: &str, file_id: &str, created_at: u64) -> SnapshotNode {
        SnapshotNode {
            snapshot_id: id::<SnapshotId>(snapshot_id),
            file_id: id::<FileId>(file_id),
            parent_snapshot_id: None,
            supersedes_snapshot_id: None,
            created_at,
            created_by: id::<ParticipantId>("p-author-01"),
            base_hash: id::<ContentHash>("hash-1"),
            byte_length: 5,
            encrypted_blob_ref: None,
            plaintext: Some(SnapshotPlaintext {
                doc_type: crate::review::model::DocType::Markdown,
                content: Some("# hi\n".to_string()),
                anchor_index: Some(AnchorIndex {
                    doc_hash: id::<ContentHash>("hash-1"),
                    canonical_encoding: CanonicalEncoding::Utf8Bytes,
                    line_count: 1,
                    blocks: vec![],
                    headings: vec![],
                }),
                media_type: None,
                encoding: None,
                manifest: None,
                annotation: None,
            }),
        }
    }

    fn dummy_room() -> RoomId {
        id::<RoomId>("hjCfgOvsatNOUedgxhZpyw")
    }

    // -----------------------------------------------------------------
    // 1. request_snapshot prefers the WebRTC arm when connected and pushes
    //    a SignalingPayload::RequestSnapshot through publish_signal.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn request_snapshot_uses_webrtc_publish_signal_when_connected() {
        let (mgr, _rx, _tmp, _store) = make_manager_with_store();
        let room = dummy_room();
        let webrtc = Arc::new(MockWebRtc::new(true));

        mgr.open_room_transports(
            &room,
            TransportMode::Live,
            TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<dyn WebRtcSender>)),
        )
        .await
        .expect("open live");
        mgr.register_signal_context(fixture_signal_context(
            &room,
            Some(id::<DeviceId>("d-remote-01")),
        ))
        .await;

        let file_id: FileId = id("f-file-01");
        let since: SnapshotId = id("snap-since");
        mgr.request_snapshot(&room, file_id.clone(), Some(since.clone()))
            .await
            .expect("request_snapshot ok via webrtc");

        let signals = webrtc.published_signals();
        assert_eq!(signals.len(), 1, "exactly one signal must be published");
        match &signals[0] {
            SignalingPayload::RequestSnapshot {
                file_id: f,
                since_snapshot_id: s,
                from,
            } => {
                assert_eq!(f, &file_id);
                assert_eq!(s.as_ref(), Some(&since));
                assert_eq!(from, &id::<DeviceId>("d-local-01"));
            }
            other => panic!("expected RequestSnapshot, got {other:?}"),
        }
        // Mailbox was never wired in Live mode; nothing should hit it.
        // (The selector invariant prevents a mailbox handle here, but we
        // also assert the webrtc path didn't fan out a bonus envelope.)
        assert_eq!(
            webrtc.total_sent(),
            0,
            "request_snapshot must not call send_envelopes"
        );
    }

    // -----------------------------------------------------------------
    // 2. request_snapshot falls back to the mailbox arm when WebRTC is
    //    not connected. The minted envelope round-trips through
    //    disassemble_signal_envelope so we can also assert the wire shape.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn request_snapshot_falls_back_to_mailbox_when_webrtc_down() {
        use crate::review::transport::signaling::disassemble_signal_envelope;

        let (mgr, _rx, _tmp, _store) = make_manager_with_store();
        let room = dummy_room();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(false)); // disconnected
        mgr.open_room_transports(
            &room,
            TransportMode::Hybrid,
            TransportConfig::from_handles(
                Some(mailbox.clone() as Arc<dyn MailboxSender>),
                Some(webrtc.clone() as Arc<dyn WebRtcSender>),
            ),
        )
        .await
        .expect("open hybrid");
        let ctx = fixture_signal_context(&room, Some(id::<DeviceId>("d-remote-01")));
        let signaling_key = ctx.signaling_key;
        mgr.register_signal_context(ctx).await;

        let file_id: FileId = id("f-file-02");
        mgr.request_snapshot(&room, file_id.clone(), None)
            .await
            .expect("request_snapshot ok via mailbox");

        // WebRTC saw nothing (it was down).
        assert!(webrtc.published_signals().is_empty());
        assert_eq!(webrtc.total_sent(), 0);

        // Mailbox got exactly one batch of one envelope, kind=signal,
        // targeted at the remote device.
        let batches = mailbox.batches();
        assert_eq!(batches.len(), 1);
        let env = batches[0]
            .first()
            .cloned()
            .expect("one envelope in the mailbox batch");
        assert_eq!(env.kind, EnvelopeKind::Signal);
        assert_eq!(
            env.target.as_ref().map(|t| &t.device_id),
            Some(&id::<DeviceId>("d-remote-01")),
            "request_snapshot must target the remote device when ctx has one",
        );

        // Round-trip the envelope payload to prove the bytes are well-formed.
        let payload = disassemble_signal_envelope(&env, &signaling_key)
            .expect("disassemble mailbox-routed signal");
        match payload {
            SignalingPayload::RequestSnapshot {
                file_id: f,
                since_snapshot_id: s,
                from,
            } => {
                assert_eq!(f, file_id);
                assert!(s.is_none(), "None since must round-trip as omitted field");
                assert_eq!(from, id::<DeviceId>("d-local-01"));
            }
            other => panic!("expected RequestSnapshot, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // 3. request_snapshot without a registered signal context surfaces
    //    a stable ATTN_NO_SIGNAL_CONTEXT error code.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn request_snapshot_without_signal_context_returns_stable_error_code() {
        let (mgr, _rx, _tmp, _store) = make_manager_with_store();
        let room = dummy_room();
        let webrtc = Arc::new(MockWebRtc::new(true));
        mgr.open_room_transports(
            &room,
            TransportMode::Live,
            TransportConfig::from_handles(None, Some(webrtc as Arc<dyn WebRtcSender>)),
        )
        .await
        .expect("open live");

        let err = mgr
            .request_snapshot(&room, id::<FileId>("f-file-x"), None)
            .await
            .expect_err("must error without ctx");
        match err {
            TransportError::Io(msg) => assert!(
                msg.contains("ATTN_NO_SIGNAL_CONTEXT"),
                "expected ATTN_NO_SIGNAL_CONTEXT in error, got: {msg}"
            ),
            other => panic!("expected Io(ATTN_NO_SIGNAL_CONTEXT), got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // 4. request_snapshot for an unknown room returns RoomNotFound.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn request_snapshot_unknown_room_returns_room_not_found() {
        let (mgr, _rx, _tmp, _store) = make_manager_with_store();
        let room = dummy_room();
        // Register a signal context but never open transports.
        mgr.register_signal_context(fixture_signal_context(&room, None))
            .await;
        let err = mgr
            .request_snapshot(&room, id::<FileId>("f-file-x"), None)
            .await
            .expect_err("unknown transports must error");
        assert!(matches!(err, TransportError::RoomNotFound));
    }

    // -----------------------------------------------------------------
    // 5. handle_inbound_request_snapshot returns the latest snapshot for
    //    the file as a SnapshotCreated event envelope routed over WebRTC.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn handle_inbound_request_snapshot_emits_snapshot_created_over_webrtc() {
        let (mgr, _rx, _tmp, store) = make_manager_with_store();
        let room = dummy_room();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(true));
        mgr.open_room_transports(
            &room,
            TransportMode::Hybrid,
            TransportConfig::from_handles(
                Some(mailbox.clone() as Arc<dyn MailboxSender>),
                Some(webrtc.clone() as Arc<dyn WebRtcSender>),
            ),
        )
        .await
        .expect("open hybrid");
        mgr.register_signal_context(fixture_signal_context(&room, None))
            .await;

        // Seed two snapshots for the same file — the newer one must win.
        let older = dummy_snapshot("snap-old", "f-file-99", 1_700_000_000_000);
        let newer = dummy_snapshot("snap-new", "f-file-99", 1_700_000_010_000);
        store.save_snapshot(&room, &older).expect("save older");
        store.save_snapshot(&room, &newer).expect("save newer");
        // Plus a snapshot for a different file that must NOT be picked.
        let other = dummy_snapshot("snap-other", "f-file-other", 1_700_000_020_000);
        store.save_snapshot(&room, &other).expect("save other");

        let payload = SignalingPayload::RequestSnapshot {
            file_id: id::<FileId>("f-file-99"),
            since_snapshot_id: None,
            from: id::<DeviceId>("d-remote-01"),
        };
        let response = mgr
            .handle_inbound_request_snapshot(&room, &payload)
            .await
            .expect("handler ok");
        let env = response.expect("expected a response envelope");
        assert_eq!(env.kind, EnvelopeKind::Event);

        // WebRTC arm got the envelope; mailbox didn't (Hybrid w/ webrtc up
        // prefers the DataChannel for the recovery response).
        assert_eq!(webrtc.total_sent(), 1);
        assert_eq!(mailbox.total_sent(), 0);

        // The envelope was the freshly-minted one — id matches.
        let webrtc_batch = webrtc.batches();
        assert_eq!(webrtc_batch.len(), 1);
        assert_eq!(webrtc_batch[0].len(), 1);
        assert_eq!(webrtc_batch[0][0].envelope_id, env.envelope_id);
    }

    // -----------------------------------------------------------------
    // 6. handle_inbound_request_snapshot honors since_snapshot_id:
    //    if the requester's "since" is already the latest, return None
    //    (no payload).
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn handle_inbound_request_snapshot_returns_none_when_requester_is_up_to_date() {
        let (mgr, _rx, _tmp, store) = make_manager_with_store();
        let room = dummy_room();
        let webrtc = Arc::new(MockWebRtc::new(true));
        mgr.open_room_transports(
            &room,
            TransportMode::Live,
            TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<dyn WebRtcSender>)),
        )
        .await
        .expect("open live");
        mgr.register_signal_context(fixture_signal_context(&room, None))
            .await;

        let latest = dummy_snapshot("snap-latest", "f-file-99", 1_700_000_000_000);
        store.save_snapshot(&room, &latest).expect("save latest");

        let payload = SignalingPayload::RequestSnapshot {
            file_id: id::<FileId>("f-file-99"),
            since_snapshot_id: Some(id::<SnapshotId>("snap-latest")),
            from: id::<DeviceId>("d-remote-01"),
        };
        let response = mgr
            .handle_inbound_request_snapshot(&room, &payload)
            .await
            .expect("handler ok");
        assert!(response.is_none(), "requester is current — no resend");
        assert_eq!(webrtc.total_sent(), 0);
    }

    // -----------------------------------------------------------------
    // 7. handle_inbound_request_snapshot returns None when the room has no
    //    snapshot for the requested file (caller surfaces as recovery
    //    failure to the UI).
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn handle_inbound_request_snapshot_returns_none_when_file_has_no_snapshot() {
        let (mgr, _rx, _tmp, _store) = make_manager_with_store();
        let room = dummy_room();
        let webrtc = Arc::new(MockWebRtc::new(true));
        mgr.open_room_transports(
            &room,
            TransportMode::Live,
            TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<dyn WebRtcSender>)),
        )
        .await
        .expect("open live");
        mgr.register_signal_context(fixture_signal_context(&room, None))
            .await;

        let payload = SignalingPayload::RequestSnapshot {
            file_id: id::<FileId>("f-file-empty"),
            since_snapshot_id: None,
            from: id::<DeviceId>("d-remote-01"),
        };
        let response = mgr
            .handle_inbound_request_snapshot(&room, &payload)
            .await
            .expect("handler ok");
        assert!(response.is_none());
        assert_eq!(webrtc.total_sent(), 0);
    }

    // -----------------------------------------------------------------
    // 8. handle_inbound_request_snapshot falls back to the mailbox when
    //    the WebRTC arm is down (peer that asked may still reach us via
    //    relay; receiver-side dedup collapses duplicates).
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn handle_inbound_request_snapshot_falls_back_to_mailbox_when_webrtc_down() {
        let (mgr, _rx, _tmp, store) = make_manager_with_store();
        let room = dummy_room();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(false));
        mgr.open_room_transports(
            &room,
            TransportMode::Hybrid,
            TransportConfig::from_handles(
                Some(mailbox.clone() as Arc<dyn MailboxSender>),
                Some(webrtc.clone() as Arc<dyn WebRtcSender>),
            ),
        )
        .await
        .expect("open hybrid");
        mgr.register_signal_context(fixture_signal_context(&room, None))
            .await;
        store
            .save_snapshot(
                &room,
                &dummy_snapshot("snap-1", "f-file-7", 1_700_000_000_000),
            )
            .expect("save");

        let payload = SignalingPayload::RequestSnapshot {
            file_id: id::<FileId>("f-file-7"),
            since_snapshot_id: None,
            from: id::<DeviceId>("d-remote-01"),
        };
        let response = mgr
            .handle_inbound_request_snapshot(&room, &payload)
            .await
            .expect("handler ok");
        assert!(response.is_some());
        assert_eq!(mailbox.total_sent(), 1, "mailbox must carry the fallback");
        assert_eq!(webrtc.total_sent(), 0);
    }

    // -----------------------------------------------------------------
    // 9. End-to-end round trip: client A requests, owner B's handler
    //    responds, and the response envelope decrypts cleanly under the
    //    same room keys A would use.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn round_trip_request_snapshot_decrypts_under_room_keys() {
        use crate::review::crypto::signing::DeviceVerifyingKey;
        use crate::review::envelope::{DisassembleInput, disassemble_event_envelope};
        use std::collections::HashMap as StdHashMap;

        let (mgr, _rx, _tmp, store) = make_manager_with_store();
        let room = dummy_room();
        let webrtc = Arc::new(MockWebRtc::new(true));
        mgr.open_room_transports(
            &room,
            TransportMode::Live,
            TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<dyn WebRtcSender>)),
        )
        .await
        .expect("open live");
        mgr.register_signal_context(fixture_signal_context(&room, None))
            .await;

        // Save the snapshot the owner will pick up.
        let snap = dummy_snapshot("snap-fresh", "f-file-rt", 1_700_000_001_000);
        store.save_snapshot(&room, &snap).expect("save snap");

        // Owner-side: receive the inbound request and let the handler
        // produce a response envelope.
        let request = SignalingPayload::RequestSnapshot {
            file_id: id::<FileId>("f-file-rt"),
            since_snapshot_id: None,
            from: id::<DeviceId>("d-remote-01"),
        };
        let response = mgr
            .handle_inbound_request_snapshot(&room, &request)
            .await
            .expect("handler")
            .expect("response envelope");

        // Client-side: pretend we're the recovering peer. Decrypt + verify
        // the response under the same room keys + the owner's verifying
        // key. The owner used `TEST_SIGNING_SEED`; recompute the matching
        // public key so the verify lookup succeeds.
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let signer = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let signer_keyid = signer.verifying_key().signing_key_id_base64url();
        let mut verifying_keys: StdHashMap<String, DeviceVerifyingKey> = StdHashMap::new();
        verifying_keys.insert(signer_keyid, signer.verifying_key());

        let event = disassemble_event_envelope(DisassembleInput {
            envelope: &response,
            event_key: *keys.event_key.as_bytes(),
            verifying_keys: &verifying_keys,
        })
        .expect("decrypt + verify recovery event");

        match event.body {
            ReviewEventBody::SnapshotCreated {
                file_id: f,
                snapshot_id: s,
                ..
            } => {
                assert_eq!(f, id::<FileId>("f-file-rt"));
                assert_eq!(s, id::<SnapshotId>("snap-fresh"));
            }
            other => panic!("expected SnapshotCreated, got {other:?}"),
        }
    }
}
