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

use crate::review::bootstrap::{
    BootstrapConfig, Bootstrapper, JoinOutcome, ShareOutcome,
};
use crate::review::ids::{EventId, FileId, RoomId};
use crate::review::model::{
    Anchor, MailboxEnvelope, PositionAnchor, ResolvedAnchor, RoomMode, SuggestionDraft,
};
use crate::review::store::ReviewStore;
use crate::review::transport::inbound::VerifyingKeyCache;
use crate::review::transport::selector::{
    self, RoomTransports, TransportConfig, TransportMode,
};
use crate::review::transport::{EnvelopeAck, TransportError};
use crate::review::working_copy::WorkingCopyService;

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
#[derive(Debug, Clone, PartialEq)]
pub enum ReviewCommand {
    /// Share the current path as a new review room.
    Share {
        path: PathBuf,
        mode: String,
        ttl: Option<String>,
    },
    /// Join a remote review room from an `attn://review/...` invite.
    Join { invite: String },
    /// Pull pending envelopes for a room, or for every active room when `None`.
    Pull { room_id: Option<RoomId> },
    /// Stop hosting/participating in a room (all rooms when `None`).
    Stop { room_id: Option<RoomId> },
    /// List inbound review notifications across all rooms.
    Inbox,
    /// Create a new comment thread anchored at `anchor` with body text.
    CreateComment {
        room_id: RoomId,
        anchor: Anchor,
        body: String,
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
    /// Owner manually re-anchors a stale comment/suggestion to a new range.
    ResolveAnchor {
        room_id: RoomId,
        event_id: EventId,
        range: PositionAnchor,
    },
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ReviewUpdate {
    /// Room connection / mode / peer list changed.
    RoomStatusChanged { room_id: RoomId, status: String },
    /// A `ReviewEvent` was imported and is now durable in the local store.
    EventImported {
        room_id: RoomId,
        event_id: EventId,
        body_type: String,
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
    /// The outbox depth for a room changed (envelopes queued for send).
    OutboxChanged {
        room_id: RoomId,
        pending_count: usize,
    },
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
            ReviewUpdate::EventImported { .. } => "reviewEvent",
            ReviewUpdate::SnapshotCreated { .. } => "reviewSnapshot",
            ReviewUpdate::AnchorResolutionChanged { .. } => "reviewAnchorResolution",
            ReviewUpdate::OutboxChanged { .. } => "reviewStatus",
            ReviewUpdate::Error { .. } => "reviewStatus",
        }
    }
}

// ---------------------------------------------------------------------------
// ReviewManager
// ---------------------------------------------------------------------------

/// Type alias for the closure the manager uses to deliver updates back to the
/// event loop. Pulled out so tests can hand in an `mpsc::Sender`-backed
/// closure without dragging in `tao::EventLoopProxy`.
pub type UpdateSink = Box<dyn Fn(ReviewUpdate) + Send + Sync>;

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
}

impl ReviewManager {
    /// Construct a new manager. The `update_tx` closure is invoked from
    /// `submit` (synchronously today; future async work may spawn). It's
    /// expected to forward into the tao event loop via
    /// `EventLoopProxy::send_event(UserEvent::Review(_))`.
    pub fn new(
        store: Arc<ReviewStore>,
        working_copy: Arc<WorkingCopyService>,
        update_tx: UpdateSink,
    ) -> Self {
        Self {
            store,
            working_copy,
            update_tx,
            bootstrap: None,
            runtime: None,
            verifying_keys: None,
            rooms: Arc::new(AsyncMutex::new(HashMap::new())),
        }
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
        self.bootstrap = Some(Arc::new(bootstrapper));
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
        eprintln!("review: received command {:?}", cmd);

        // Bootstrap pipeline owns Share + Join when wired in. Everything else
        // still goes through `stub_update_for` (filled in by follow-up issues).
        match (&cmd, self.bootstrap.as_ref(), self.runtime.as_ref()) {
            (
                ReviewCommand::Share { path, mode, ttl },
                Some(bootstrapper),
                Some(runtime),
            ) => {
                let mode = mode_from_str(mode);
                let result = runtime.block_on(bootstrapper.share(
                    path.clone(),
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
            _ => {}
        }

        let update = stub_update_for(&cmd);
        (self.update_tx)(update);
    }

    /// Translate a `ShareOutcome` (or its error) into the corresponding
    /// `ReviewUpdate` and dispatch it. Carries the invite in the status
    /// field per the frontend contract — the right-rail Share view reads
    /// `status` and surfaces the URL via a copy-to-clipboard button.
    fn emit_share_outcome(
        &self,
        result: Result<ShareOutcome, crate::review::bootstrap::BootstrapError>,
    ) {
        let update = match result {
            Ok(outcome) => ReviewUpdate::RoomStatusChanged {
                room_id: outcome.room_id,
                // Status carries both the connection state and the invite.
                // The frontend parses the prefix to detect the live state
                // and extracts the URL after the pipe. See
                // `web/src/lib/review/store.ts` (attn-nnj.0c.x).
                status: format!("Live|{}", outcome.invite),
            },
            Err(err) => ReviewUpdate::Error {
                room_id: None,
                code: error_code(&err),
                message: err.to_string(),
            },
        };
        (self.update_tx)(update);
    }

    /// Translate a `JoinOutcome` (or its error) into the corresponding
    /// `ReviewUpdate` and dispatch it.
    fn emit_join_outcome(
        &self,
        result: Result<JoinOutcome, crate::review::bootstrap::BootstrapError>,
    ) {
        let update = match result {
            Ok(outcome) => ReviewUpdate::RoomStatusChanged {
                room_id: outcome.room_id,
                status: "Joined".to_string(),
            },
            Err(err) => ReviewUpdate::Error {
                room_id: None,
                code: error_code(&err),
                message: err.to_string(),
            },
        };
        (self.update_tx)(update);
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
                .ok_or_else(|| TransportError::RoomNotFound)?
        };
        let transports = shared.lock().await;
        let result = selector::send_envelopes(&transports, envelopes).await;
        if let Err(TransportError::Io(msg)) = &result {
            if msg.contains(selector::LIVE_REQUIRED_CODE) {
                (self.update_tx)(ReviewUpdate::Error {
                    room_id: Some(room_id.clone()),
                    code: selector::LIVE_REQUIRED_CODE.to_string(),
                    message: msg.clone(),
                });
            }
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
                .ok_or_else(|| TransportError::RoomNotFound)?
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
        BootstrapError::Store(_) => "ATTN_STORE".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Stub update generation
// ---------------------------------------------------------------------------

/// Build a sensible no-op `ReviewUpdate` for a given command. Centralized so
/// the scaffold contract is testable in one place and so future handlers can
/// progressively replace each arm with real work without touching `submit`.
///
/// TODO comments call out the issue that will replace each branch.
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
        // TODO(attn-nnj.3b): parse invite, open transport, fetch snapshot, emit
        // RoomStatus + SnapshotCreated as data arrives.
        ReviewCommand::Join { invite } => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: format!("Pending join — not yet implemented (invite={invite})"),
        },
        // TODO(attn-nnj.3b): drain mailbox for `room_id` (or all rooms), import
        // each envelope, emit EventImported per record.
        ReviewCommand::Pull { room_id } => ReviewUpdate::RoomStatusChanged {
            room_id: room_id.clone().unwrap_or_else(stub_room_id),
            status: "Pending pull — not yet implemented".to_string(),
        },
        // TODO(attn-nnj.3b): tear down transport for the room (or all rooms),
        // mark as offline, emit RoomStatus.
        ReviewCommand::Stop { room_id } => ReviewUpdate::RoomStatusChanged {
            room_id: room_id.clone().unwrap_or_else(stub_room_id),
            status: "Pending stop — not yet implemented".to_string(),
        },
        // TODO(attn-nnj.3b): aggregate inbox across rooms, emit a synthetic
        // RoomStatus per pending room or a dedicated InboxChanged variant
        // (TBD when inbox UI lands).
        ReviewCommand::Inbox => ReviewUpdate::RoomStatusChanged {
            room_id: stub_room_id(),
            status: "Pending inbox — not yet implemented".to_string(),
        },
        // TODO(attn-nnj.3a): assemble ReviewEventBody::CommentCreated, sign,
        // envelope, append to store + outbox, emit EventImported (local echo).
        ReviewCommand::CreateComment { room_id, anchor, .. } => ReviewUpdate::EventImported {
            room_id: room_id.clone(),
            event_id: stub_event_id(),
            body_type: format!("comment_created_stub_anchor_v{}", anchor.v),
        },
        // TODO(attn-nnj.3a): same as CreateComment for SuggestionCreated.
        ReviewCommand::CreateSuggestion { room_id, draft } => ReviewUpdate::EventImported {
            room_id: room_id.clone(),
            event_id: stub_event_id(),
            body_type: format!("suggestion_created_stub_anchor_v{}", draft.anchor.v),
        },
        // TODO(Phase 5): run guarded apply flow, write working copy, emit
        // SuggestionAccepted event + AnchorResolutionChanged for affected
        // anchors.
        ReviewCommand::AcceptSuggestion {
            room_id,
            suggestion_id,
        } => ReviewUpdate::EventImported {
            room_id: room_id.clone(),
            event_id: suggestion_id.clone(),
            body_type: "suggestion_accepted_stub".to_string(),
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

    /// Build a `(ReviewManager, receiver)` pair backed by an std::mpsc channel
    /// so tests can assert which `ReviewUpdate`s the manager emitted.
    fn make_manager() -> (ReviewManager, mpsc::Receiver<ReviewUpdate>, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let store =
            Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());
        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = Mutex::new(tx);
        let sink: UpdateSink = Box::new(move |update| {
            // `Fn` (not `FnMut`), so wrap the sender in a Mutex.
            let _ = tx.lock().expect("test sink mutex").send(update);
        });
        let mgr = ReviewManager::new(store, working_copy, sink);
        (mgr, rx, tmp)
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
        }
    }

    #[test]
    fn manager_can_be_instantiated() {
        // Smoke test: construction must succeed and the manager must accept
        // an empty command flow without panicking.
        let (_mgr, _rx, _tmp) = make_manager();
    }

    #[test]
    fn submit_share_emits_room_status_changed_update() {
        let (mgr, rx, _tmp) = make_manager();
        mgr.submit(ReviewCommand::Share {
            path: PathBuf::from("/tmp/plan.md"),
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
    fn submit_join_emits_room_status_changed_with_invite() {
        let (mgr, rx, _tmp) = make_manager();
        let invite = "attn://review/abc#key=xyz".to_string();
        mgr.submit(ReviewCommand::Join {
            invite: invite.clone(),
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert!(status.contains(&invite));
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
        });
        let update = rx.try_recv().expect("expected one update");
        match update {
            ReviewUpdate::EventImported {
                room_id: rid,
                body_type,
                ..
            } => {
                assert_eq!(rid, room_id);
                assert!(
                    body_type.starts_with("comment_created_stub"),
                    "expected comment_created_stub, got {body_type}"
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
                body_type,
                ..
            } => {
                assert_eq!(rid, room_id);
                assert!(body_type.starts_with("suggestion_created_stub"));
            }
            other => panic!("expected EventImported, got {other:?}"),
        }
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
                event_id,
                body_type,
            } => {
                assert_eq!(rid, room_id);
                assert_eq!(event_id, suggestion_id);
                assert_eq!(body_type, "suggestion_accepted_stub");
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
                event_id: event_id.clone(),
                body_type: "t".to_string()
            }
            .callback_name(),
            "reviewEvent"
        );
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
        let update = ReviewUpdate::EventImported {
            room_id: dummy_id::<RoomId>("room-abc"),
            event_id: dummy_id::<EventId>("evt-1"),
            body_type: "comment_created_stub".to_string(),
        };
        let json = serde_json::to_value(&update).expect("serialize update");
        assert_eq!(json["kind"], serde_json::json!("event_imported"));
        assert_eq!(json["roomId"], serde_json::json!("room-abc"));
        assert_eq!(json["eventId"], serde_json::json!("evt-1"));
        assert_eq!(json["bodyType"], serde_json::json!("comment_created_stub"));
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
        let store = Arc::new(
            ReviewStore::open_at(store_tmp.path().join("reviews")).expect("open store"),
        );
        let working_copy = Arc::new(WorkingCopyService::new());

        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = StdMutex::new(tx);
        let sink: UpdateSink = Box::new(move |update| {
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

    /// Set up wiremock stubs accepting any room create + device register.
    async fn mount_create_and_register(server: &MockServer) {
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
        mgr.submit(ReviewCommand::Share {
            path: std::path::PathBuf::from("/tmp/manager-share.md"),
            mode: "async".to_string(),
            ttl: None,
        });

        let update = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("update");
        match update {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert!(
                    status.starts_with("Live|attn://review/"),
                    "status must encode invite, got: {status}"
                );
                // No follow-up error update.
                assert!(rx.try_recv().is_err(), "single update per Share");
            }
            other => panic!("expected RoomStatusChanged, got {other:?}"),
        }
        // Identity must be on disk.
        let identity = load_identity_from(id_tmp.path()).expect("load id").expect("present");
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
        let update = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("update");
        match update {
            ReviewUpdate::RoomStatusChanged {
                room_id: rid,
                status,
            } => {
                assert_eq!(rid, room_id);
                assert_eq!(status, "Joined");
            }
            other => panic!("expected RoomStatusChanged, got {other:?}"),
        }
    }

    #[test]
    fn submit_join_with_malformed_invite_emits_error_update() {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        let server = runtime.block_on(MockServer::start());
        let (mgr, rx, _store_tmp, _id_tmp) = make_bootstrapped_manager(server.uri());

        mgr.submit(ReviewCommand::Join {
            invite: "not-an-invite".to_string(),
        });
        let update = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("update");
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
    use crate::review::transport::selector::test_support::{
        dummy_envelope, MailboxOutcome, MockMailbox, MockWebRtc,
    };
    use crate::review::transport::selector::{
        MailboxSender, TransportConfig, TransportMode, WebRtcSender,
    };
    use crate::review::transport::TransportError;
    use std::sync::Mutex;
    use std::sync::mpsc;
    use tempfile::TempDir;

    fn make_manager() -> (ReviewManager, mpsc::Receiver<ReviewUpdate>, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let store =
            Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());
        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = Mutex::new(tx);
        let sink: UpdateSink = Box::new(move |update| {
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
                room_id: rid,
                code,
                ..
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

