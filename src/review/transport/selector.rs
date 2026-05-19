//! Mode-aware transport selector for `ReviewManager` (attn-nnj.7.5).
//!
//! The selector layers on top of the two concrete `Transport` arms
//! (`mailbox::OutboxProcessor` + `webrtc::WebRtcTransport`) and decides, per
//! room and per outbound batch, which path the bytes take. The rules are
//! pinned by `planning/collab/amendments.md` §Phase 4 and
//! `planning/collab/data-model.md` §Product Modes:
//!
//! - **Live**: WebRTC required; mailbox is unused. If the DataChannel is
//!   unavailable / failed, surface `ATTN_LIVE_REQUIRED` to the UI and FAIL
//!   the send. No silent mailbox fallback.
//! - **Async**: Mailbox only. No WebRTC peer connection is built. Send goes
//!   through `POST /v2/rooms/:roomId/envelopes`.
//! - **Hybrid**: Both. WebRTC is the low-latency primary when connected;
//!   the mailbox is the always-on outbox so async receivers (and the
//!   long-tail of offline peers) still see every envelope. Receiving-side
//!   dedup (`InboundPipeline::import_event_envelope`'s `EventId` collision
//!   guard) collapses the double delivery — see attn-nnj.6.4.
//!
//! Inbound for every mode flows through the same `InboundPipeline`, so the
//! frontend never sees a difference based on which transport delivered an
//! envelope.

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::review::model::MailboxEnvelope;
use crate::review::transport::{EnvelopeAck, TransportError};

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/// Selector mode applied to outbound envelope routing. Mirrors `RoomMode` but
/// owned by the transport-selector layer so the manager can flip between
/// modes (e.g. owner extending a live session into hybrid) without touching
/// the room policy on disk.
///
/// See `planning/collab/data-model.md` §Product Modes for the canonical
/// definitions. The selector implements the routing half of those modes; the
/// peer-connection state machine in attn-nnj.7.4 owns the WebRTC half.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TransportMode {
    /// WebRTC required; mailbox unused; failure surfaces to UI as
    /// `ATTN_LIVE_REQUIRED`.
    Live,
    /// Mailbox only; no WebRTC.
    Async,
    /// Both: DataChannel opportunistic when connected, mailbox always-on
    /// outbox for missed / offline peers.
    Hybrid,
}

impl TransportMode {
    /// True when this mode runs the WebRTC arm.
    pub fn uses_webrtc(self) -> bool {
        matches!(self, TransportMode::Live | TransportMode::Hybrid)
    }

    /// True when this mode runs the mailbox arm.
    pub fn uses_mailbox(self) -> bool {
        matches!(self, TransportMode::Async | TransportMode::Hybrid)
    }
}

impl From<crate::review::model::RoomMode> for TransportMode {
    fn from(value: crate::review::model::RoomMode) -> Self {
        match value {
            crate::review::model::RoomMode::Live => TransportMode::Live,
            crate::review::model::RoomMode::Async => TransportMode::Async,
            crate::review::model::RoomMode::Hybrid => TransportMode::Hybrid,
        }
    }
}

// ---------------------------------------------------------------------------
// Sender abstractions
// ---------------------------------------------------------------------------

/// Outbound mailbox-arm send. A thin trait wrapping the existing
/// `OutboxProcessor` so the selector can be tested without spinning up a
/// wiremock relay. The production impl is `MailboxTransport` (below) which
/// enqueues into the durable outbox and drains it via
/// `OutboxProcessor::process_once`.
///
/// Implementations MUST be idempotent on `envelopeId` — the relay dedups
/// already and the local outbox file uses the same id as its primary key.
#[async_trait]
pub trait MailboxSender: Send + Sync {
    /// Send a batch of envelopes through the mailbox arm. Returns the
    /// relay-assigned `serverSeq` per envelope. Failure is the same
    /// `TransportError` taxonomy as the underlying `Transport` trait.
    async fn send_envelopes(
        &self,
        envelopes: Vec<MailboxEnvelope>,
    ) -> Result<Vec<EnvelopeAck>, TransportError>;
}

/// Outbound WebRTC-arm send. Wraps `WebRtcTransport::send_envelope` per item
/// and reports whether the DataChannel is currently open (so the selector
/// can decide between WebRTC-only Live and Hybrid's "fall back to mailbox"
/// behaviour without poking at peer-connection state directly).
#[async_trait]
pub trait WebRtcSender: Send + Sync {
    /// True when the DataChannel is open and bytes can flow. False during
    /// negotiation, reconnect, or after a terminal failure.
    fn is_connected(&self) -> bool;

    /// Send a batch of envelopes over the DataChannel one at a time. The
    /// `EnvelopeAck.server_seq` is always `0` because the DataChannel has no
    /// relay-assigned ordering — the receiver derives ordering from the
    /// inbound pipeline (see `webrtc.rs::send_envelope`).
    async fn send_envelopes(
        &self,
        envelopes: Vec<MailboxEnvelope>,
    ) -> Result<Vec<EnvelopeAck>, TransportError>;

    /// Push a single `SignalingPayload` onto the transport's outbound
    /// signaling lane. The implementer assembles + seals a `kind=signal`
    /// envelope under `signaling_key` and routes it through whatever
    /// signaling carrier it owns (typically the mailbox-arm-forwarded
    /// `POST /envelopes`, per `webrtc.rs::publish_signal`).
    ///
    /// Used by `ReviewManager::request_snapshot` (attn-nnj.7.6) so a
    /// recovering reviewer can ask its peer for the latest snapshot over
    /// the same signaling channel the SDP/ICE handshake rides.
    ///
    /// Defaults to `TransportError::Io("publish_signal: not supported")` so
    /// existing in-tree mock implementations (and any future read-only
    /// transports) don't have to opt in to recovery semantics — the manager
    /// surfaces the failure to the UI and the caller can retry via mailbox.
    fn publish_signal(
        &self,
        payload: crate::review::transport::signaling::SignalingPayload,
    ) -> Result<(), TransportError> {
        let _ = payload;
        Err(TransportError::Io(
            "publish_signal: not supported by this WebRtcSender impl".into(),
        ))
    }
}

// ---------------------------------------------------------------------------
// MailboxTransport (production impl over OutboxProcessor)
// ---------------------------------------------------------------------------

/// Production `MailboxSender` impl that wraps a real `OutboxProcessor`.
/// Enqueues each envelope durably (so a daemon restart can replay) and then
/// drains via `process_once`. The `MAX_BATCH_SIZE = 32` chunking is owned by
/// the processor; callers can pass any batch length.
pub struct MailboxTransport {
    processor: Arc<crate::review::transport::mailbox::OutboxProcessor>,
}

impl MailboxTransport {
    /// Wrap a pre-built processor. The processor's room/device binding is the
    /// transport's binding — one `MailboxTransport` per `(roomId, deviceId)`.
    pub fn new(processor: Arc<crate::review::transport::mailbox::OutboxProcessor>) -> Self {
        Self { processor }
    }
}

#[async_trait]
impl MailboxSender for MailboxTransport {
    async fn send_envelopes(
        &self,
        envelopes: Vec<MailboxEnvelope>,
    ) -> Result<Vec<EnvelopeAck>, TransportError> {
        // Stage durably first so a panic between enqueue + drain still
        // leaves the bytes recoverable on next boot.
        for env in &envelopes {
            self.processor.enqueue(env.clone())?;
        }
        self.processor.process_once().await
    }
}

// ---------------------------------------------------------------------------
// WebRtcSender adapter
// ---------------------------------------------------------------------------

/// Production `WebRtcSender` adapter that wraps a real `WebRtcTransport`.
/// `is_connected` reads the transport's state-watch channel; sends call
/// through `send_envelope` per item and collect the acks.
pub struct WebRtcTransportAdapter {
    transport: Arc<crate::review::transport::webrtc::WebRtcTransport>,
}

impl WebRtcTransportAdapter {
    pub fn new(transport: Arc<crate::review::transport::webrtc::WebRtcTransport>) -> Self {
        Self { transport }
    }
}

#[async_trait]
impl WebRtcSender for WebRtcTransportAdapter {
    fn is_connected(&self) -> bool {
        matches!(
            self.transport.state(),
            crate::review::transport::webrtc::WebRtcConnectionState::Connected
        )
    }

    async fn send_envelopes(
        &self,
        envelopes: Vec<MailboxEnvelope>,
    ) -> Result<Vec<EnvelopeAck>, TransportError> {
        let mut acks = Vec::with_capacity(envelopes.len());
        for env in envelopes {
            let ack = self.transport.send_envelope(env).await?;
            acks.push(ack);
        }
        Ok(acks)
    }

    fn publish_signal(
        &self,
        payload: crate::review::transport::signaling::SignalingPayload,
    ) -> Result<(), TransportError> {
        self.transport.publish_signal(payload)
    }
}

// ---------------------------------------------------------------------------
// RoomTransports
// ---------------------------------------------------------------------------

/// Holds the active transport handles for a single room, plus the mode that
/// governs how `ReviewManager::send_envelopes` routes between them.
///
/// `mailbox` is `Some` for Async + Hybrid (the always-on outbox). In Live
/// mode it is `None` — outbound writes go exclusively through the
/// DataChannel, and failure surfaces to the UI rather than silently buffering
/// in mailbox.
///
/// `webrtc` is `Some` for Live + Hybrid (the DataChannel arm). In Async mode
/// it is `None` — no peer connection is built, no signaling envelopes mint.
pub struct RoomTransports {
    pub mode: TransportMode,
    pub mailbox: Option<Arc<dyn MailboxSender>>,
    pub webrtc: Option<Arc<dyn WebRtcSender>>,
}

impl std::fmt::Debug for RoomTransports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoomTransports")
            .field("mode", &self.mode)
            .field("mailbox", &self.mailbox.as_ref().map(|_| "<dyn MailboxSender>"))
            .field("webrtc", &self.webrtc.as_ref().map(|_| "<dyn WebRtcSender>"))
            .finish()
    }
}

impl RoomTransports {
    /// Build a new `RoomTransports` snapshot.
    ///
    /// Panics if the (mode, transports) shape is inconsistent — e.g. Live mode
    /// without a WebRTC handle, or Async mode with a WebRTC handle. The
    /// selector enforces the invariants up front so downstream `send_envelopes`
    /// can rely on them.
    pub fn new(
        mode: TransportMode,
        mailbox: Option<Arc<dyn MailboxSender>>,
        webrtc: Option<Arc<dyn WebRtcSender>>,
    ) -> Self {
        debug_assert_eq!(
            mode.uses_mailbox(),
            mailbox.is_some(),
            "mailbox handle must match mode.uses_mailbox()"
        );
        debug_assert_eq!(
            mode.uses_webrtc(),
            webrtc.is_some(),
            "webrtc handle must match mode.uses_webrtc()"
        );
        Self {
            mode,
            mailbox,
            webrtc,
        }
    }
}

/// Wraps a `RoomTransports` in an async mutex so the selector can mutate it
/// (e.g. attach a mailbox handle on a Live -> Hybrid transition) while the
/// outbound send path holds it briefly to read the active transports.
pub(crate) type SharedRoomTransports = Arc<Mutex<RoomTransports>>;

// ---------------------------------------------------------------------------
// TransportConfig
// ---------------------------------------------------------------------------

/// Inputs needed to materialize a `RoomTransports` from a (room, mode) pair.
///
/// The selector consumes these and constructs the appropriate concrete
/// transports — or in tests, the caller injects pre-built `MailboxSender` /
/// `WebRtcSender` instances via `open_room_transports_with_handles` to keep
/// the unit tests free of real I/O.
pub struct TransportConfig {
    pub mailbox: Option<Arc<dyn MailboxSender>>,
    pub webrtc: Option<Arc<dyn WebRtcSender>>,
}

impl TransportConfig {
    /// Construct a config from pre-built sender handles. Used by tests today;
    /// the production wiring path in attn-nnj.6.6 will land separately.
    pub fn from_handles(
        mailbox: Option<Arc<dyn MailboxSender>>,
        webrtc: Option<Arc<dyn WebRtcSender>>,
    ) -> Self {
        Self { mailbox, webrtc }
    }
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

/// Compose a `RoomTransports` from a `TransportConfig` per the rules of the
/// supplied mode. Returns `TransportError::Io` when the config is missing a
/// handle the mode requires.
///
/// - `Live` requires `webrtc` and rejects `mailbox`.
/// - `Async` requires `mailbox` and rejects `webrtc`.
/// - `Hybrid` requires both.
pub fn build_room_transports(
    mode: TransportMode,
    config: TransportConfig,
) -> Result<RoomTransports, TransportError> {
    match mode {
        TransportMode::Live => {
            let webrtc = config.webrtc.ok_or_else(|| {
                TransportError::Io("Live mode requires a WebRTC transport handle".into())
            })?;
            Ok(RoomTransports::new(mode, None, Some(webrtc)))
        }
        TransportMode::Async => {
            let mailbox = config.mailbox.ok_or_else(|| {
                TransportError::Io("Async mode requires a mailbox transport handle".into())
            })?;
            Ok(RoomTransports::new(mode, Some(mailbox), None))
        }
        TransportMode::Hybrid => {
            let mailbox = config.mailbox.ok_or_else(|| {
                TransportError::Io("Hybrid mode requires a mailbox transport handle".into())
            })?;
            let webrtc = config.webrtc.ok_or_else(|| {
                TransportError::Io("Hybrid mode requires a WebRTC transport handle".into())
            })?;
            Ok(RoomTransports::new(mode, Some(mailbox), Some(webrtc)))
        }
    }
}

// ---------------------------------------------------------------------------
// send_envelopes routing
// ---------------------------------------------------------------------------

/// Outbound dispatch implementing the per-mode rules in the module docs.
///
/// - `Live`: WebRTC only. If `webrtc.is_connected()` is false, surface
///   `ATTN_LIVE_REQUIRED` via a `TransportError::Io` (the manager translates
///   this into a `ReviewUpdate::Error` for the UI) and DO NOT touch the
///   mailbox.
/// - `Async`: Mailbox only.
/// - `Hybrid`: Mailbox always; WebRTC opportunistically when connected. The
///   acks returned are the mailbox acks (they carry the relay's `serverSeq`,
///   which the receiver-side dedup needs); WebRTC errors degrade quietly to
///   mailbox-only delivery (the room policy already commits to mailbox as
///   the safety net in Hybrid mode).
pub async fn send_envelopes(
    transports: &RoomTransports,
    envelopes: Vec<MailboxEnvelope>,
) -> Result<Vec<EnvelopeAck>, TransportError> {
    match transports.mode {
        TransportMode::Live => {
            let webrtc = transports
                .webrtc
                .as_ref()
                .ok_or_else(|| TransportError::Io(LIVE_REQUIRED_MESSAGE.into()))?;
            if !webrtc.is_connected() {
                // Per amendments.md §Phase 4: "live mode surfaces
                // direct-connection failure explicitly — no silent mailbox
                // fallback". Emit the stable code so the manager can route
                // it onto the frontend as a `ReviewUpdate::Error`.
                return Err(TransportError::Io(LIVE_REQUIRED_MESSAGE.into()));
            }
            webrtc.send_envelopes(envelopes).await
        }
        TransportMode::Async => {
            let mailbox = transports
                .mailbox
                .as_ref()
                .ok_or_else(|| TransportError::Io("Async mode missing mailbox".into()))?;
            mailbox.send_envelopes(envelopes).await
        }
        TransportMode::Hybrid => {
            let mailbox = transports
                .mailbox
                .as_ref()
                .ok_or_else(|| TransportError::Io("Hybrid mode missing mailbox".into()))?;

            // Mailbox is always-on in hybrid; we drive it first so the
            // durable outbox holds the bytes before we attempt the
            // opportunistic DataChannel path. A WebRTC error after mailbox
            // succeeds still leaves the envelopes acked from the relay's
            // perspective, which is what the data-model commits to.
            let mailbox_acks = mailbox.send_envelopes(envelopes.clone()).await?;

            if let Some(webrtc) = transports.webrtc.as_ref() {
                if webrtc.is_connected() {
                    // Best-effort DataChannel send. Errors here are swallowed
                    // because the mailbox already accepted the envelopes;
                    // the receiver-side `InboundPipeline` dedups by EventId
                    // so a missed DataChannel attempt is harmless.
                    let _ = webrtc.send_envelopes(envelopes).await;
                }
            }
            Ok(mailbox_acks)
        }
    }
}

/// Stable error code surfaced to the frontend when a Live-mode send fails
/// because the DataChannel is not connected. Mirrors the `ATTN_LIVE_REQUIRED`
/// code referenced in `attn-nnj.7.5`.
pub const LIVE_REQUIRED_MESSAGE: &str =
    "ATTN_LIVE_REQUIRED: live mode requires direct WebRTC connection";

/// Short, stable error-code key for the manager to translate the
/// "live-required" failure into a `ReviewUpdate::Error` payload.
pub const LIVE_REQUIRED_CODE: &str = "ATTN_LIVE_REQUIRED";

// ---------------------------------------------------------------------------
// Mode transition
// ---------------------------------------------------------------------------

/// Apply a mode transition to an existing `RoomTransports`. Supports only the
/// safe transitions documented in `attn-nnj.7.5`:
///
/// - `Live` → `Hybrid`: attach the supplied mailbox handle. Existing WebRTC
///   stays connected.
/// - `Hybrid` → `Async`: drop the WebRTC handle (caller is responsible for
///   closing the underlying transport).
///
/// All other transitions return `TransportError::Io` — supporting arbitrary
/// downgrades (e.g. Async → Live mid-session) is out of scope because the
/// peer-connection state machine is not designed to recover state that was
/// never gathered.
pub fn transition_mode(
    transports: &mut RoomTransports,
    next: TransportMode,
    new_mailbox: Option<Arc<dyn MailboxSender>>,
) -> Result<(), TransportError> {
    match (transports.mode, next) {
        (a, b) if a == b => Ok(()),
        (TransportMode::Live, TransportMode::Hybrid) => {
            let mailbox = new_mailbox.ok_or_else(|| {
                TransportError::Io("Live -> Hybrid transition requires a mailbox handle".into())
            })?;
            transports.mailbox = Some(mailbox);
            transports.mode = TransportMode::Hybrid;
            Ok(())
        }
        (TransportMode::Hybrid, TransportMode::Async) => {
            transports.webrtc = None;
            transports.mode = TransportMode::Async;
            Ok(())
        }
        _ => Err(TransportError::Io(format!(
            "unsupported mode transition: {:?} -> {:?}",
            transports.mode, next
        ))),
    }
}

// ---------------------------------------------------------------------------
// Convenience helper used by ReviewManager
// ---------------------------------------------------------------------------

/// Build a `SharedRoomTransports` wrapper for storing inside the manager's
/// room map. Centralised here so the manager doesn't reach into Mutex
/// internals.
pub(crate) fn share(transports: RoomTransports) -> SharedRoomTransports {
    Arc::new(Mutex::new(transports))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    //! Mock `MailboxSender` / `WebRtcSender` impls used by the manager-level
    //! routing tests. Exposed at `pub(crate)` so the manager tests in
    //! `manager.rs` can re-use them.

    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Mock mailbox sender — records every batch it received and returns a
    /// configurable canned outcome. Default is "every envelope acked with a
    /// monotonically-increasing serverSeq".
    pub struct MockMailbox {
        pub sent: StdMutex<Vec<Vec<MailboxEnvelope>>>,
        pub outcome: StdMutex<MailboxOutcome>,
    }

    pub enum MailboxOutcome {
        AcceptAll { start_seq: u64 },
        Error(TransportError),
    }

    impl MockMailbox {
        pub fn new() -> Self {
            Self {
                sent: StdMutex::new(Vec::new()),
                outcome: StdMutex::new(MailboxOutcome::AcceptAll { start_seq: 1 }),
            }
        }

        pub fn with_outcome(outcome: MailboxOutcome) -> Self {
            Self {
                sent: StdMutex::new(Vec::new()),
                outcome: StdMutex::new(outcome),
            }
        }

        pub fn set_outcome(&self, outcome: MailboxOutcome) {
            *self.outcome.lock().unwrap() = outcome;
        }

        pub fn batches(&self) -> Vec<Vec<MailboxEnvelope>> {
            self.sent.lock().unwrap().clone()
        }

        pub fn total_sent(&self) -> usize {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .map(|b| b.len())
                .sum()
        }
    }

    #[async_trait]
    impl MailboxSender for MockMailbox {
        async fn send_envelopes(
            &self,
            envelopes: Vec<MailboxEnvelope>,
        ) -> Result<Vec<EnvelopeAck>, TransportError> {
            // Take the outcome out of the lock first so we don't hold it
            // across the (sync) record step.
            let outcome_guard = self.outcome.lock().unwrap();
            // Take ownership by swapping a "default" placeholder in — we
            // only need the variant to decide what to return, but we want
            // to keep the same outcome across multiple calls, so clone the
            // enum's data instead.
            let outcome_snapshot = match &*outcome_guard {
                MailboxOutcome::AcceptAll { start_seq } => {
                    MailboxOutcome::AcceptAll {
                        start_seq: *start_seq,
                    }
                }
                MailboxOutcome::Error(err) => {
                    // Clone the error variant by reconstructing — TransportError
                    // doesn't impl Clone, so reconstruct only the variants we
                    // use in tests.
                    MailboxOutcome::Error(clone_transport_error(err))
                }
            };
            drop(outcome_guard);

            self.sent.lock().unwrap().push(envelopes.clone());

            match outcome_snapshot {
                MailboxOutcome::AcceptAll { start_seq } => {
                    let acks: Vec<EnvelopeAck> = envelopes
                        .iter()
                        .enumerate()
                        .map(|(i, env)| EnvelopeAck {
                            envelope_id: env.envelope_id.clone(),
                            server_seq: start_seq + i as u64,
                        })
                        .collect();
                    Ok(acks)
                }
                MailboxOutcome::Error(err) => Err(err),
            }
        }
    }

    /// Clone a `TransportError` variant. `TransportError` doesn't implement
    /// `Clone` (its `Io` payload is a heap string and the variants are
    /// otherwise plain enums), so we hand-roll the subset of variants the
    /// tests need.
    pub fn clone_transport_error(err: &TransportError) -> TransportError {
        match err {
            TransportError::AdmissionRejected => TransportError::AdmissionRejected,
            TransportError::RoomNotFound => TransportError::RoomNotFound,
            TransportError::RoomDeleted => TransportError::RoomDeleted,
            TransportError::RoomExpired => TransportError::RoomExpired,
            TransportError::StorageCapReached => TransportError::StorageCapReached,
            TransportError::RateLimited(ms) => TransportError::RateLimited(*ms),
            TransportError::CursorTooOld(seq) => TransportError::CursorTooOld(*seq),
            TransportError::Disconnected(msg) => TransportError::Disconnected(msg.clone()),
            TransportError::Io(msg) => TransportError::Io(msg.clone()),
        }
    }

    /// Mock WebRTC sender — tracks calls and lets tests flip connectedness on
    /// the fly.
    pub struct MockWebRtc {
        pub sent: StdMutex<Vec<Vec<MailboxEnvelope>>>,
        pub connected: std::sync::atomic::AtomicBool,
        pub outcome: StdMutex<WebRtcOutcome>,
        /// Captured `SignalingPayload`s passed to `publish_signal`. Tests
        /// inspect this to confirm `ReviewManager::request_snapshot` routed
        /// through the WebRTC arm with the right `(file_id, sinceSnapshotId)`
        /// (attn-nnj.7.6).
        pub signals:
            StdMutex<Vec<crate::review::transport::signaling::SignalingPayload>>,
    }

    pub enum WebRtcOutcome {
        AcceptAll,
        Error(TransportError),
    }

    impl MockWebRtc {
        pub fn new(connected: bool) -> Self {
            Self {
                sent: StdMutex::new(Vec::new()),
                connected: std::sync::atomic::AtomicBool::new(connected),
                outcome: StdMutex::new(WebRtcOutcome::AcceptAll),
                signals: StdMutex::new(Vec::new()),
            }
        }

        pub fn set_connected(&self, connected: bool) {
            self.connected
                .store(connected, std::sync::atomic::Ordering::SeqCst);
        }

        pub fn set_outcome(&self, outcome: WebRtcOutcome) {
            *self.outcome.lock().unwrap() = outcome;
        }

        pub fn batches(&self) -> Vec<Vec<MailboxEnvelope>> {
            self.sent.lock().unwrap().clone()
        }

        pub fn total_sent(&self) -> usize {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .map(|b| b.len())
                .sum()
        }

        /// Snapshot of every `SignalingPayload` the manager pushed through
        /// `publish_signal`.
        pub fn published_signals(
            &self,
        ) -> Vec<crate::review::transport::signaling::SignalingPayload> {
            self.signals.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl WebRtcSender for MockWebRtc {
        fn is_connected(&self) -> bool {
            self.connected.load(std::sync::atomic::Ordering::SeqCst)
        }

        async fn send_envelopes(
            &self,
            envelopes: Vec<MailboxEnvelope>,
        ) -> Result<Vec<EnvelopeAck>, TransportError> {
            self.sent.lock().unwrap().push(envelopes.clone());
            let outcome_guard = self.outcome.lock().unwrap();
            let snapshot = match &*outcome_guard {
                WebRtcOutcome::AcceptAll => WebRtcOutcome::AcceptAll,
                WebRtcOutcome::Error(err) => WebRtcOutcome::Error(clone_transport_error(err)),
            };
            drop(outcome_guard);
            match snapshot {
                WebRtcOutcome::AcceptAll => {
                    let acks: Vec<EnvelopeAck> = envelopes
                        .into_iter()
                        .map(|env| EnvelopeAck {
                            envelope_id: env.envelope_id,
                            server_seq: 0,
                        })
                        .collect();
                    Ok(acks)
                }
                WebRtcOutcome::Error(err) => Err(err),
            }
        }

        fn publish_signal(
            &self,
            payload: crate::review::transport::signaling::SignalingPayload,
        ) -> Result<(), TransportError> {
            // Live mode of the recovery path: the channel must be open before
            // we accept a signal — mirrors `WebRtcTransport::publish_signal`,
            // which would fail with `signaling_tx receiver dropped` if the
            // mailbox-forward task had exited.
            if !self.connected.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(TransportError::Disconnected(
                    "MockWebRtc: not connected".into(),
                ));
            }
            self.signals.lock().unwrap().push(payload);
            Ok(())
        }
    }

    /// Helper to mint a `MailboxEnvelope` shaped enough for routing tests
    /// (every test bypasses the AEAD/sig layer because the selector only
    /// looks at the envelope's id).
    pub fn dummy_envelope(
        envelope_id: &str,
        room_id: &crate::review::ids::RoomId,
    ) -> MailboxEnvelope {
        use serde::Deserialize;
        use serde_json::Value;

        fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
            serde_json::from_value(Value::String(s.to_string())).expect("typed id")
        }

        MailboxEnvelope {
            v: 2,
            room_id: room_id.clone(),
            envelope_id: envelope_id.to_string(),
            server_seq: None,
            author_id: id("p-author"),
            device_id: id("d-local"),
            created_at: 1_700_000_000_000,
            expires_at: 1_700_000_086_400,
            kind: crate::review::model::EnvelopeKind::Event,
            target: None,
            nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
            ciphertext: "Y2lwaGVy".to_string(),
            ciphertext_bytes: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::review::ids::RoomId;
    use serde::Deserialize;
    use serde_json::Value;

    fn room_id() -> RoomId {
        serde_json::from_value::<RoomId>(Value::String("room-abc".to_string())).unwrap()
    }

    fn _id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).unwrap()
    }

    // -----------------------------------------------------------------
    // TransportMode helpers
    // -----------------------------------------------------------------

    #[test]
    fn transport_mode_uses_webrtc_and_mailbox_match_spec() {
        assert!(TransportMode::Live.uses_webrtc());
        assert!(!TransportMode::Live.uses_mailbox());

        assert!(!TransportMode::Async.uses_webrtc());
        assert!(TransportMode::Async.uses_mailbox());

        assert!(TransportMode::Hybrid.uses_webrtc());
        assert!(TransportMode::Hybrid.uses_mailbox());
    }

    #[test]
    fn transport_mode_from_room_mode_is_total() {
        use crate::review::model::RoomMode;
        assert_eq!(TransportMode::from(RoomMode::Live), TransportMode::Live);
        assert_eq!(TransportMode::from(RoomMode::Async), TransportMode::Async);
        assert_eq!(TransportMode::from(RoomMode::Hybrid), TransportMode::Hybrid);
    }

    // -----------------------------------------------------------------
    // build_room_transports invariants
    // -----------------------------------------------------------------

    #[test]
    fn build_room_transports_live_requires_webrtc() {
        let cfg = TransportConfig::from_handles(None, None);
        let err = build_room_transports(TransportMode::Live, cfg).expect_err("live needs webrtc");
        assert!(matches!(err, TransportError::Io(_)));

        let webrtc = Arc::new(MockWebRtc::new(true));
        let cfg = TransportConfig::from_handles(None, Some(webrtc));
        let rt = build_room_transports(TransportMode::Live, cfg).expect("live build");
        assert!(rt.mailbox.is_none(), "live must not hold a mailbox handle");
        assert!(rt.webrtc.is_some());
    }

    #[test]
    fn build_room_transports_async_requires_mailbox_and_rejects_webrtc_silently() {
        let cfg = TransportConfig::from_handles(None, None);
        let err =
            build_room_transports(TransportMode::Async, cfg).expect_err("async needs mailbox");
        assert!(matches!(err, TransportError::Io(_)));

        let mailbox = Arc::new(MockMailbox::new());
        let cfg = TransportConfig::from_handles(Some(mailbox), None);
        let rt = build_room_transports(TransportMode::Async, cfg).expect("async build");
        assert!(rt.mailbox.is_some());
        assert!(rt.webrtc.is_none(), "async must not hold a webrtc handle");
    }

    #[test]
    fn build_room_transports_hybrid_requires_both() {
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(true));
        let cfg = TransportConfig::from_handles(Some(mailbox), Some(webrtc));
        let rt = build_room_transports(TransportMode::Hybrid, cfg).expect("hybrid build");
        assert!(rt.mailbox.is_some());
        assert!(rt.webrtc.is_some());
    }

    // -----------------------------------------------------------------
    // send_envelopes: Live mode
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn send_envelopes_live_uses_webrtc_only_when_connected() {
        let room = room_id();
        let webrtc = Arc::new(MockWebRtc::new(true));
        let cfg = TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<_>));
        let rt = build_room_transports(TransportMode::Live, cfg).expect("live build");
        let acks = send_envelopes(&rt, vec![dummy_envelope("env-1", &room)])
            .await
            .expect("live send ok");
        assert_eq!(acks.len(), 1);
        assert_eq!(webrtc.total_sent(), 1);
    }

    #[tokio::test]
    async fn send_envelopes_live_surfaces_attn_live_required_when_webrtc_down() {
        let room = room_id();
        let webrtc = Arc::new(MockWebRtc::new(false)); // not connected
        let cfg = TransportConfig::from_handles(None, Some(webrtc.clone() as Arc<_>));
        let rt = build_room_transports(TransportMode::Live, cfg).expect("live build");
        let err = send_envelopes(&rt, vec![dummy_envelope("env-1", &room)])
            .await
            .expect_err("live should fail when webrtc not connected");
        match err {
            TransportError::Io(msg) => {
                assert!(
                    msg.contains(LIVE_REQUIRED_CODE),
                    "expected ATTN_LIVE_REQUIRED in error, got: {msg}"
                );
            }
            other => panic!("expected Io(ATTN_LIVE_REQUIRED), got {other:?}"),
        }
        // Crucial: NOT sent via webrtc (it would have errored at the
        // send layer rather than the pre-flight) and NOT sent via mailbox
        // (mailbox handle is None in Live anyway, but assert it twice via
        // the invariant).
        assert_eq!(webrtc.total_sent(), 0, "live must not send on closed channel");
        assert!(rt.mailbox.is_none(), "live must not hold a mailbox handle");
    }

    #[tokio::test]
    async fn send_envelopes_live_does_not_fall_back_to_mailbox_even_when_attached() {
        // Even if the manager (incorrectly) handed us a mailbox in Live mode,
        // the routing rule still skips it. Build the `RoomTransports` directly
        // to bypass the build_room_transports invariant.
        let room = room_id();
        let webrtc = Arc::new(MockWebRtc::new(false));
        let mailbox = Arc::new(MockMailbox::new());
        let rt = RoomTransports {
            mode: TransportMode::Live,
            // Deliberately violate the invariant for this test — proves the
            // routing layer is the second line of defense.
            mailbox: Some(mailbox.clone() as Arc<_>),
            webrtc: Some(webrtc.clone() as Arc<_>),
        };
        let err = send_envelopes(&rt, vec![dummy_envelope("env-1", &room)])
            .await
            .expect_err("live must fail");
        assert!(matches!(err, TransportError::Io(_)));
        assert_eq!(
            mailbox.total_sent(),
            0,
            "live mode must NOT fall back to mailbox"
        );
    }

    // -----------------------------------------------------------------
    // send_envelopes: Async mode
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn send_envelopes_async_uses_mailbox_only() {
        let room = room_id();
        let mailbox = Arc::new(MockMailbox::new());
        let cfg = TransportConfig::from_handles(Some(mailbox.clone() as Arc<_>), None);
        let rt = build_room_transports(TransportMode::Async, cfg).expect("async build");
        let acks = send_envelopes(
            &rt,
            vec![
                dummy_envelope("env-1", &room),
                dummy_envelope("env-2", &room),
            ],
        )
        .await
        .expect("async send ok");
        assert_eq!(acks.len(), 2);
        // server_seqs assigned by the mock: 1, 2.
        assert_eq!(acks[0].server_seq, 1);
        assert_eq!(acks[1].server_seq, 2);
        assert_eq!(mailbox.total_sent(), 2);
        assert!(rt.webrtc.is_none());
    }

    #[tokio::test]
    async fn send_envelopes_async_bubbles_mailbox_error() {
        let room = room_id();
        let mailbox = Arc::new(MockMailbox::with_outcome(MailboxOutcome::Error(
            TransportError::AdmissionRejected,
        )));
        let cfg = TransportConfig::from_handles(Some(mailbox.clone() as Arc<_>), None);
        let rt = build_room_transports(TransportMode::Async, cfg).expect("async build");
        let err = send_envelopes(&rt, vec![dummy_envelope("env-1", &room)])
            .await
            .expect_err("async should bubble");
        assert!(matches!(err, TransportError::AdmissionRejected));
    }

    // -----------------------------------------------------------------
    // send_envelopes: Hybrid mode
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn send_envelopes_hybrid_connected_writes_to_both_paths() {
        let room = room_id();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(true));
        let cfg = TransportConfig::from_handles(
            Some(mailbox.clone() as Arc<_>),
            Some(webrtc.clone() as Arc<_>),
        );
        let rt = build_room_transports(TransportMode::Hybrid, cfg).expect("hybrid build");

        let envelopes = vec![
            dummy_envelope("env-1", &room),
            dummy_envelope("env-2", &room),
        ];
        let acks = send_envelopes(&rt, envelopes).await.expect("hybrid send ok");

        // Acks come back from the mailbox arm (carry serverSeq).
        assert_eq!(acks.len(), 2);
        assert!(acks.iter().all(|a| a.server_seq > 0));

        // Both transports got the same batch — receiver dedups by EventId.
        assert_eq!(mailbox.total_sent(), 2);
        assert_eq!(
            webrtc.total_sent(),
            2,
            "hybrid must also send via webrtc when connected"
        );
    }

    #[tokio::test]
    async fn send_envelopes_hybrid_disconnected_uses_mailbox_only_no_error() {
        let room = room_id();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(false));
        let cfg = TransportConfig::from_handles(
            Some(mailbox.clone() as Arc<_>),
            Some(webrtc.clone() as Arc<_>),
        );
        let rt = build_room_transports(TransportMode::Hybrid, cfg).expect("hybrid build");

        let acks = send_envelopes(&rt, vec![dummy_envelope("env-1", &room)])
            .await
            .expect("hybrid send must NOT error when webrtc is down");
        assert_eq!(acks.len(), 1);
        assert_eq!(mailbox.total_sent(), 1);
        assert_eq!(
            webrtc.total_sent(),
            0,
            "hybrid must not attempt webrtc when disconnected"
        );
    }

    #[tokio::test]
    async fn send_envelopes_hybrid_webrtc_error_does_not_fail_overall_send() {
        // Mailbox succeeds, WebRTC errors mid-send. The overall send must
        // still return the mailbox acks — Hybrid commits to mailbox as the
        // safety net.
        let room = room_id();
        let mailbox = Arc::new(MockMailbox::new());
        let webrtc = Arc::new(MockWebRtc::new(true));
        webrtc.set_outcome(WebRtcOutcome::Error(TransportError::Disconnected(
            "channel closed mid-send".into(),
        )));
        let cfg = TransportConfig::from_handles(
            Some(mailbox.clone() as Arc<_>),
            Some(webrtc.clone() as Arc<_>),
        );
        let rt = build_room_transports(TransportMode::Hybrid, cfg).expect("hybrid build");

        let acks = send_envelopes(&rt, vec![dummy_envelope("env-1", &room)])
            .await
            .expect("hybrid send ok despite webrtc error");
        assert_eq!(acks.len(), 1);
        assert_eq!(mailbox.total_sent(), 1);
    }

    #[tokio::test]
    async fn send_envelopes_hybrid_mailbox_error_bubbles_up() {
        let room = room_id();
        let mailbox = Arc::new(MockMailbox::with_outcome(MailboxOutcome::Error(
            TransportError::AdmissionRejected,
        )));
        let webrtc = Arc::new(MockWebRtc::new(true));
        let cfg = TransportConfig::from_handles(
            Some(mailbox.clone() as Arc<_>),
            Some(webrtc.clone() as Arc<_>),
        );
        let rt = build_room_transports(TransportMode::Hybrid, cfg).expect("hybrid build");

        let err = send_envelopes(&rt, vec![dummy_envelope("env-1", &room)])
            .await
            .expect_err("hybrid must bubble mailbox error");
        assert!(matches!(err, TransportError::AdmissionRejected));
        // WebRTC was never attempted because mailbox failed first.
        assert_eq!(webrtc.total_sent(), 0);
    }

    // -----------------------------------------------------------------
    // Mode transitions
    // -----------------------------------------------------------------

    #[test]
    fn transition_live_to_hybrid_spawns_mailbox_without_dropping_webrtc() {
        let webrtc = Arc::new(MockWebRtc::new(true));
        let mut rt = RoomTransports::new(
            TransportMode::Live,
            None,
            Some(webrtc.clone() as Arc<_>),
        );
        let mailbox = Arc::new(MockMailbox::new());
        transition_mode(
            &mut rt,
            TransportMode::Hybrid,
            Some(mailbox.clone() as Arc<_>),
        )
        .expect("live -> hybrid ok");
        assert_eq!(rt.mode, TransportMode::Hybrid);
        assert!(rt.mailbox.is_some(), "mailbox must be attached");
        assert!(rt.webrtc.is_some(), "webrtc must NOT be dropped");
    }

    #[test]
    fn transition_hybrid_to_async_drops_webrtc() {
        let webrtc = Arc::new(MockWebRtc::new(true));
        let mailbox = Arc::new(MockMailbox::new());
        let mut rt = RoomTransports::new(
            TransportMode::Hybrid,
            Some(mailbox.clone() as Arc<_>),
            Some(webrtc.clone() as Arc<_>),
        );
        transition_mode(&mut rt, TransportMode::Async, None).expect("hybrid -> async ok");
        assert_eq!(rt.mode, TransportMode::Async);
        assert!(rt.mailbox.is_some());
        assert!(rt.webrtc.is_none(), "webrtc must be dropped");
    }

    #[test]
    fn transition_unsupported_returns_error() {
        let mailbox = Arc::new(MockMailbox::new());
        let mut rt =
            RoomTransports::new(TransportMode::Async, Some(mailbox as Arc<_>), None);
        // Async -> Live is not a supported transition (no WebRTC state to
        // recover from). The selector refuses it rather than silently
        // booting a new transport.
        let err = transition_mode(&mut rt, TransportMode::Live, None)
            .expect_err("unsupported transition must error");
        assert!(matches!(err, TransportError::Io(_)));
    }

    #[test]
    fn transition_noop_when_same_mode() {
        let mailbox = Arc::new(MockMailbox::new());
        let mut rt = RoomTransports::new(
            TransportMode::Async,
            Some(mailbox.clone() as Arc<_>),
            None,
        );
        transition_mode(&mut rt, TransportMode::Async, None).expect("noop ok");
        assert_eq!(rt.mode, TransportMode::Async);
    }
}
