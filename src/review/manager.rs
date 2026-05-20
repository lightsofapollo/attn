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
use crate::review::crypto::signing::DeviceSigningKey;
use crate::review::envelope::{AssembleInput, assemble_event_envelope};
use crate::review::ids::{DeviceId, EventId, FileId, ParticipantId, RoomId, SnapshotId};
use crate::review::model::{
    Anchor, EnvelopeKind, MailboxEnvelope, PositionAnchor, ResolvedAnchor, ReviewEventBody,
    RoomMode, SuggestionDraft,
};
use crate::review::store::ReviewStore;
use crate::review::transport::inbound::VerifyingKeyCache;
use crate::review::transport::selector::{
    self, RoomTransports, TransportConfig, TransportMode,
};
use crate::review::transport::signaling::{SignalingPayload, assemble_signal_envelope};
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
    /// Owner edited a shared file — republish a fresh snapshot so connected
    /// reviewers see the update. No-op when `path` isn't part of any share.
    PublishSnapshot { path: PathBuf },
    /// Send a live co-typing payload (prosemirror-collab submission or
    /// broadcast) from this webview to the room over the encrypted signal
    /// channel. `payload` is opaque JSON the daemon doesn't parse.
    SendCollab { room_id: RoomId, payload: String },
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
    /// A Share completed and the owner's invite URL is ready to copy.
    /// Separate from `RoomStatusChanged` so the frontend can keep the
    /// Share dialog open and atomically populate the URL field, fingerprint,
    /// expiry timer, etc. without parsing strings.
    ShareReady {
        room_id: RoomId,
        invite_url: String,
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
    ConnectionChanged {
        room_id: RoomId,
        connection: String,
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
            ReviewUpdate::CollabSignal { .. } => "reviewCollab",
            ReviewUpdate::OutboxChanged { .. } => "reviewStatus",
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

    /// Per-room identity + AEAD key material the manager needs to mint
    /// outbound signal / snapshot / event envelopes for the recovery path
    /// (attn-nnj.7.6 `request_snapshot` + `handle_inbound_request_snapshot`).
    ///
    /// Populated by `register_signal_context` after the bootstrap pipeline
    /// has run (it owns the key derivation + identity bytes). Kept in an
    /// `Arc<RwLock<...>>` because reads dominate writes — every send takes
    /// a read snapshot, registration is a one-shot per (room, device) pair.
    signal_contexts: Arc<tokio::sync::RwLock<HashMap<RoomId, Arc<RoomSignalContext>>>>,
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
            signal_contexts: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
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
            (
                ReviewCommand::CreateComment { room_id, anchor, body },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                let thread_id = mint_thread_id();
                let event_body = crate::review::model::ReviewEventBody::CommentCreated {
                    thread_id,
                    anchor: anchor.clone(),
                    body: body.clone(),
                };
                let result = bootstrapper.send_event_sync(
                    room_id,
                    event_body,
                    unix_now_ms_for_manager(),
                );
                self.emit_event_outcome(room_id.clone(), result);
                return;
            }
            (
                ReviewCommand::CreateSuggestion { room_id, draft },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                let suggestion_id = mint_thread_id();
                let event_body = crate::review::model::ReviewEventBody::SuggestionCreated {
                    suggestion_id,
                    anchor: draft.anchor.clone(),
                    operation: draft.operation.clone(),
                    note: draft.note.clone(),
                };
                let result = bootstrapper.send_event_sync(
                    room_id,
                    event_body,
                    unix_now_ms_for_manager(),
                );
                self.emit_event_outcome(room_id.clone(), result);
                return;
            }
            (
                ReviewCommand::AcceptSuggestion { room_id, suggestion_id },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                self.accept_suggestion(bootstrapper, room_id, suggestion_id);
                return;
            }
            (
                ReviewCommand::ResolveAnchor { room_id, event_id, range },
                Some(bootstrapper),
                Some(_runtime),
            ) => {
                self.resolve_anchor(bootstrapper, room_id, event_id, range);
                return;
            }
            (ReviewCommand::SendCollab { room_id, payload }, Some(bootstrapper), Some(_runtime)) => {
                self.send_collab(bootstrapper, room_id, payload);
                return;
            }
            (ReviewCommand::PublishSnapshot { path }, Some(bootstrapper), Some(_runtime)) => {
                match bootstrapper
                    .republish_snapshot_for_path(path, unix_now_ms_for_manager())
                {
                    Ok(Some((room_id, _file_id, snapshot_id))) => {
                        eprintln!(
                            "review: republished snapshot {} for {} (room={})",
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
            _ => {}
        }

        let update = stub_update_for(&cmd);
        (self.update_tx)(update);
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
        use crate::review::apply::{apply_ready_verdict, resolve_suggestion, ApplyContext};
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
        let path = match crate::review::bootstrap::find_path_for_room(
            self.store.root(),
            room_id,
        ) {
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
                    suggestion_id,
                    ..
                } => suggestion_id.clone(),
                _ => unreachable!(),
            },
            applied_revision_id: format!("{:?}", outcome.revision.revision_id),
            resulting_hash: outcome.resulting_hash.clone(),
        };
        let send = bootstrapper.send_event_sync(room_id, accepted_body, now_ms);
        self.emit_event_outcome(room_id.clone(), send);

        // 7. Republish the snapshot — the working copy changed, so reviewers
        //    must get the new content.
        if let Err(e) = bootstrapper.republish_snapshot_for_path(&path, now_ms) {
            emit_err("ATTN_SNAPSHOT_PUBLISH", format!("post-accept republish: {e}"));
        }

        eprintln!(
            "review: accepted suggestion {} → applied to {} (room={})",
            suggestion_id.as_str(),
            path.display(),
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
                        crate::review::model::ReviewEventBody::CommentCreated { anchor, .. } => {
                            Some(anchor.file_id.clone())
                        }
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
        let resolved_by = match bootstrapper.config().identity_dir().and_then(|dir| {
            crate::review::bootstrap::load_or_create_identity_in(&dir)
                .map_err(crate::review::bootstrap::BootstrapError::from)
        }) {
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

        eprintln!(
            "review: manually re-anchored event {} (room={})",
            event_id.as_str(),
            room_id.as_str()
        );
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

        let secret = match load_room_secret(self.store.root(), room_id) {
            Ok(s) => s,
            Err(e) => return emit_err(format!("load room secret: {e}")),
        };
        let keys = derive_room_keys(&secret);

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

        let now_ms = unix_now_ms_for_manager() as i64;
        let envelope = match assemble_signal_envelope(
            SignalingPayload::Collab {
                from: device_id.clone(),
                payload: payload.to_string(),
            },
            keys.signaling_key.as_bytes(),
            room_id,
            &participant_id,
            &device_id,
            None, // broadcast to the whole room
            &fresh_client_nonce_16(),
            now_ms,
            now_ms + SIGNAL_TTL_MS,
        ) {
            Ok(env) => env,
            Err(e) => return emit_err(format!("assemble collab signal: {e}")),
        };

        if let Err(e) = self.store.append_outbox(room_id, &envelope) {
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
    fn emit_join_outcome(
        &self,
        result: Result<JoinOutcome, crate::review::bootstrap::BootstrapError>,
    ) {
        let update = match result {
            Ok(outcome) => {
                let room_id = outcome.room_id.clone();
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
                ReviewUpdate::RoomStatusChanged {
                    room_id: outcome.room_id,
                    status: "Joined".to_string(),
                }
            }
            Err(err) => ReviewUpdate::Error {
                room_id: None,
                code: error_code(&err),
                message: err.to_string(),
            },
        };
        (self.update_tx)(update);
    }

    /// Spawn the outbox drain + inbound WS subscriber for `room_id` onto the
    /// manager's tokio runtime. Idempotent: a duplicate call is a no-op since
    /// the rooms map already has a handle (verified by `self.rooms`).
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
        use crate::review::transport::inbound::InboundPipeline;
        use crate::review::transport::mailbox::OutboxProcessor;
        use crate::review::transport::mailbox::ws::MailboxWsClient;
        use crate::review::transport::mailbox::MailboxConfig;
        use crate::review::transport::TransportEvent;

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

        // Identity for this device. Cheap to re-load; we don't need to
        // cache because the daemon owns its identity file for life.
        let identity_dir = bootstrap.config().identity_dir()?;
        let identity = crate::review::bootstrap::load_or_create_identity_in(&identity_dir)?;
        let device_id = identity.typed_device_id();

        // Room secret (32 bytes). Derives all per-room keys: AEAD for
        // event / snapshot / signaling, plus the HMAC admission key.
        let room_secret = load_room_secret(self.store.root(), room_id)?;
        let room_keys = derive_room_keys(&room_secret);

        // MailboxConfig + TokenPool — shared between the outbox processor
        // and the WS subscriber so admission HMAC + PoW caching are
        // consistent across both paths.
        let mailbox_config = Arc::new(MailboxConfig::from_room_secret(
            bootstrap.config().relay_url.clone(),
            room_id.clone(),
            device_id.clone(),
            &room_secret,
            12, // MIN_POW_BITS — relay clamps anyway
        ));
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
        // Leak the sender so it lives for the daemon's lifetime. The
        // alternative is keeping a `Vec<Sender>` somewhere on the
        // manager; daemons spawn per-room runtimes once at boot and
        // never tear them down individually, so a per-room leak is
        // bounded by the number of joined rooms (typically < 10).
        // Without this, the sender drops at the end of this scope and
        // `cancel.changed()` resolves Err, which the WS `select!`
        // interprets as a cancel — aborting the connect_async before
        // it even completes.
        Box::leak(Box::new(cancel_tx));
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
        match runtime.block_on(bootstrap.refresh_device_keys(room_id, &verifying_keys)) {
            Ok(n) => eprintln!(
                "review: seeded {n} device key(s) for room={}",
                room_id.as_str()
            ),
            Err(err) => eprintln!(
                "review: refresh_device_keys failed room={}: {err}",
                room_id.as_str()
            ),
        }

        // Inbound pipeline: decrypts incoming envelopes and appends them
        // to events.jsonl. Wired through the WS subscriber.
        let inbound = Arc::new(InboundPipeline::new(
            Arc::clone(&self.store),
            verifying_keys.clone(),
            *room_keys.event_key.as_bytes(),
            *room_keys.snapshot_key.as_bytes(),
            *room_keys.signaling_key.as_bytes(),
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
            });

        // WS subscriber — long-lived task that auto-reconnects.
        let (events_tx, mut events_rx) =
            tokio::sync::mpsc::unbounded_channel::<TransportEvent>();
        let ws_client = MailboxWsClient::new(
            mailbox_config,
            inbound,
            Arc::clone(&self.store),
            events_tx,
        )
        .with_key_refresher(key_refresher);
        let (ws_cancel_tx, ws_cancel_rx) = tokio::sync::watch::channel(false);
        // Same lifetime concern as the outbox cancel sender above.
        Box::leak(Box::new(ws_cancel_tx));
        runtime.spawn(async move {
            let _ = ws_client.run(ws_cancel_rx).await;
        });

        // Event forwarder: drain TransportEvents into ReviewUpdates so
        // the frontend store reflects inbound comments / presence /
        // policy changes in real time. We capture our own device id (to
        // drop self-echoes from the presence roster) and the room's owner
        // participant (to tag the owner chip warm vs. reviewer cool).
        let update_tx = Arc::clone(&self.update_tx);
        let room_id_owned = room_id.clone();
        let self_device_id = device_id.as_str().to_string();
        let owner_participant_id: Option<String> = self
            .store
            .load_room(room_id)
            .ok()
            .flatten()
            .map(|room| room.created_by.as_str().to_string());
        runtime.spawn(async move {
            while let Some(event) = events_rx.recv().await {
                forward_transport_event(
                    &update_tx,
                    &room_id_owned,
                    &self_device_id,
                    owner_participant_id.as_deref(),
                    event,
                );
            }
        });

        eprintln!(
            "review: started room runtime room={} outbox+ws subscribed",
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
                eprintln!("review: list_rooms failed: {err}");
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
                    eprintln!(
                        "review: skipping expired room={} (expires_at={} now={})",
                        room_id.as_str(),
                        room.policy.expires_at,
                        now_ms
                    );
                    continue;
                }
                Ok(None) => continue,
                Err(err) => {
                    eprintln!(
                        "review: load_room failed for {}: {err}",
                        room_id.as_str()
                    );
                    continue;
                }
                _ => {}
            }
            if let Err(err) = self.start_room_runtime(&room_id) {
                eprintln!(
                    "review: start_room_runtime failed for {}: {err}",
                    room_id.as_str()
                );
                continue;
            }
            // Tell the frontend a known room is live so its review store
            // hydrates `currentRoomId` and the ReviewBar / margin
            // surfaces appear. Without this push the reviewer's UI shows
            // only the local file tree even though the WS subscription
            // is already streaming inbound envelopes.
            (self.update_tx)(ReviewUpdate::RoomStatusChanged {
                room_id: room_id.clone(),
                status: "Resumed".to_string(),
            });
            resumed.push(room_id);
        }
        resumed
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
        if let Some(since_id) = since_snapshot_id.as_ref() {
            if let Some(since_node) = self
                .store
                .load_snapshot(room_id, since_id)
                .map_err(|e| TransportError::Io(format!("load_snapshot(since): {e}")))?
            {
                if since_node.created_at >= latest.created_at {
                    return Ok(None);
                }
            }
            // If the since_snapshot_id is unknown to us locally we still
            // respond with the latest — the requester explicitly asked for
            // a newer snapshot than one we don't have, which is the
            // intended-recovery shape.
        }

        // ---- 3. Build the SnapshotCreated event body. Per amendments
        //         decision #14 the wire form omits the local plaintext.
        let body = ReviewEventBody::SnapshotCreated {
            file_id: latest.file_id.clone(),
            snapshot_id: latest.snapshot_id.clone(),
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
        // CreateComment / CreateSuggestion fall through to the real path
        // in `submit` when a Bootstrapper is attached; the stub here only
        // fires when the manager was built without one (smoke tests that
        // don't need network). We synthesize a placeholder
        // `ReviewEventBody::CommentCreated` so the wire shape lines up with
        // the production path.
        ReviewCommand::CreateComment { room_id, anchor, body } => {
            ReviewUpdate::EventImported {
                room_id: room_id.clone(),
                event: stub_review_event(
                    room_id,
                    crate::review::model::ReviewEventBody::CommentCreated {
                        thread_id: "stub-thread".to_string(),
                        anchor: anchor.clone(),
                        body: body.clone(),
                    },
                ),
            }
        }
        ReviewCommand::CreateSuggestion { room_id, draft } => {
            ReviewUpdate::EventImported {
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
            }
        }
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
/// + AEAD-encrypts. The stub uses non-cryptographic placeholders since
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
    let device = serde_json::from_value::<DeviceId>(serde_json::Value::String(
        "stub-device".to_string(),
    ))
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
}

#[async_trait::async_trait]
impl crate::review::transport::DeviceKeyRefresher for BootstrapKeyRefresher {
    async fn refresh(&self) -> Result<usize, String> {
        self.bootstrap
            .refresh_device_keys(&self.room_id, &self.cache)
            .await
            .map_err(|e| e.to_string())
    }
}

/// Translate a `TransportEvent` from the mailbox WS subscriber into the
/// matching `ReviewUpdate` so the frontend store reflects inbound events
/// in real time. Lives outside `impl ReviewManager` so the spawned task
/// only needs the `UpdateSink` clone (not the full manager).
fn forward_transport_event(
    update_tx: &UpdateSink,
    room_id: &RoomId,
    self_device_id: &str,
    owner_participant_id: Option<&str>,
    event: crate::review::transport::TransportEvent,
) {
    use crate::review::transport::{PresenceEvent, TransportEvent};
    match event {
        TransportEvent::EventImported {
            room_id: rid,
            event,
        } => {
            (update_tx)(ReviewUpdate::EventImported { room_id: rid, event });
        }
        TransportEvent::Envelope { .. } => {
            // Already covered by EventImported (events) / handled elsewhere
            // for signaling. Snapshot envelopes will get their own
            // ReviewUpdate variant in the snapshot pipeline; today they
            // just persist via the InboundPipeline.
        }
        TransportEvent::Hello { devices, .. } => {
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
                .filter(|d| d.device_id.as_str() != self_device_id)
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
        TransportEvent::CollabSignal { room_id: rid, from, payload } => {
            // Drop our own broadcast echo (the relay fans broadcasts back to
            // the author); the webview also guards, but skipping here saves a
            // bridge round-trip.
            if from.as_str() == self_device_id {
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

    /// Build a `(ReviewManager, receiver)` pair backed by an std::mpsc channel
    /// so tests can assert which `ReviewUpdate`s the manager emitted.
    fn make_manager() -> (ReviewManager, mpsc::Receiver<ReviewUpdate>, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let store =
            Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
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
        assert_eq!(json["event"]["body"]["type"], serde_json::json!("comment_created"));
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

        // emit_share_outcome now drops two updates: ShareReady (rich
        // payload for the dialog) followed by RoomStatusChanged (drives
        // the ReviewBar visibility).
        let first = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("first");
        let invite = match first {
            ReviewUpdate::ShareReady {
                invite_url,
                owner_signing_key,
                mode,
                expires_at,
                ..
            } => {
                assert!(
                    invite_url.starts_with("attn://review/"),
                    "ShareReady invite_url shape, got: {invite_url}"
                );
                assert_eq!(mode, "async", "wire mode string round-trips");
                assert!(!owner_signing_key.is_empty(), "owner key surfaced");
                assert!(expires_at > 0, "expires_at populated");
                invite_url
            }
            other => panic!("expected ShareReady first, got {other:?}"),
        };
        let second = rx.recv_timeout(std::time::Duration::from_secs(2)).expect("second");
        match second {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert_eq!(status, "Live", "post-share status flips to Live");
            }
            other => panic!("expected RoomStatusChanged second, got {other:?}"),
        }
        assert!(rx.try_recv().is_err(), "no spurious third update");
        let _ = invite;
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
    use crate::review::transport::selector::{MailboxSender, TransportConfig, TransportMode, WebRtcSender};
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
    fn make_manager_with_store() -> (ReviewManager, mpsc::Receiver<ReviewUpdate>, TempDir, Arc<ReviewStore>) {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"),
        );
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
    fn fixture_signal_context(
        room_id: &RoomId,
        target: Option<DeviceId>,
    ) -> RoomSignalContext {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let signing_key = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED)
            .expect("signing key from seed");
        RoomSignalContext {
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
                markdown: "# hi\n".to_string(),
                anchor_index: AnchorIndex {
                    doc_hash: id::<ContentHash>("hash-1"),
                    canonical_encoding: CanonicalEncoding::Utf8Bytes,
                    line_count: 1,
                    blocks: vec![],
                    headings: vec![],
                },
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
        assert_eq!(webrtc.total_sent(), 0, "request_snapshot must not call send_envelopes");
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

