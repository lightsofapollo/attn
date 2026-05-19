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

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::review::bootstrap::{
    BootstrapConfig, Bootstrapper, JoinOutcome, ShareOutcome,
};
use crate::review::ids::{EventId, FileId, RoomId};
use crate::review::model::{Anchor, PositionAnchor, ResolvedAnchor, RoomMode, SuggestionDraft};
use crate::review::store::ReviewStore;
use crate::review::transport::inbound::VerifyingKeyCache;
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
