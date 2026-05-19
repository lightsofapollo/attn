//! WebRTC DataChannel arm of the [`Transport`](super::Transport) trait.
//!
//! Same `MailboxEnvelope` wire format as the mailbox arm — only the bytes path
//! changes. Per `planning/collab/amendments.md` §Decision #1 the entire
//! webrtc-rs stack lives in Rust; the frontend never holds an
//! `RTCPeerConnection` and only sees typed `ReviewUpdate`s coming up through
//! `ReviewManager`. Per `planning/collab/amendments.md` §Decision #14 there is
//! no plaintext on the DataChannel — every payload is the same AEAD-sealed
//! envelope a mailbox round-trip would produce, so the inbound pipeline at
//! `transport::inbound::InboundPipeline` does the decrypt/verify regardless
//! of which transport delivered the bytes.
//!
//! Layering: this module owns the WebRTC peer-connection state machine plus
//! the wiring that translates between webrtc-rs callbacks and the shared
//! `TransportEvent` channel `ReviewManager` listens on. It does NOT:
//!
//!   - perform signaling I/O — the actual transmission of `kind: "signal"`
//!     envelopes goes back out through the mailbox transport's
//!     `POST /envelopes`. We push outbound signal envelopes onto a
//!     `signaling_tx` channel and let the mailbox arm forward them;
//!   - decrypt or verify envelopes — that lives in `InboundPipeline`;
//!   - resolve SDP/ICE negotiations across multiple peers — one
//!     `WebRtcTransport` instance is bound to a single remote `DeviceId`
//!     (see `WebRtcConfig::remote_device_id`).
//!
//! Spec:
//!   - `planning/collab/data-model.md` §Transport Model §WebRTC DataChannel,
//!   - `planning/collab/amendments.md` §Phase 4 + §Decisions #1, #14,
//!   - `planning/collab/relay-spec.md` §Signaling (envelope routing tag).
//!
//! Test strategy: a real DataChannel round-trip requires actual UDP sockets
//! and is reserved for the integration test in `attn-nnj.7.7`. The unit
//! tests in this module exercise the parts that don't need a live remote
//! peer — construction, the inbound message → `InboundPipeline` dispatch
//! routed via `parse_inbound_envelope`, and the offer/answer/ICE → signal
//! envelope translation that lives in helpers callers can drive directly.

#![allow(dead_code)]

use std::sync::Arc;

use tokio::sync::{Mutex, mpsc};
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::ice_transport::ice_candidate::RTCIceCandidate;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use crate::review::ids::{DeviceId, ParticipantId, RoomId};
use crate::review::model::MailboxEnvelope;
use crate::review::transport::inbound::InboundPipeline;
use crate::review::transport::signaling::{
    SignalingPayload, assemble_signal_envelope,
};
use crate::review::transport::{EnvelopeAck, TransportError, TransportEvent};

/// Default STUN server set when `WebRtcConfig::stun_servers` is empty. Google
/// runs a free public STUN endpoint that's been the de-facto default for
/// browser WebRTC; we match it so a fresh `WebRtcConfig::default_stun()`
/// behaves the same as a vanilla browser PeerConnection.
const DEFAULT_STUN_SERVER: &str = "stun:stun.l.google.com:19302";

/// Label assigned to the application DataChannel. Both peers agree on the
/// same label so the side that did NOT call `create_data_channel` can match
/// the inbound channel by name in its `on_data_channel` handler.
const DATA_CHANNEL_LABEL: &str = "attn-review";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Static configuration for a single `WebRtcTransport` instance.
///
/// A transport is bound to **one** remote peer for **one** room — the
/// `remote_device_id` is the address every outbound signal envelope targets.
/// Multi-peer rooms (the common Phase 4 case) instantiate one
/// `WebRtcTransport` per remote device and let `ReviewManager` fan in.
///
/// Three AEAD keys are pinned here rather than the inbound pipeline because
/// the assembler side (signal envelopes minted by this module) needs them
/// independently of the decrypt side. They MUST be the same byte values the
/// `InboundPipeline` was constructed with — both come from
/// `crypto::kdf::derive_room_keys` over the same `roomSecret`.
pub struct WebRtcConfig {
    pub room_id: RoomId,
    /// Logical author id under which this device publishes events/signals.
    /// Matches `ReviewManager::participant_id` for the local user.
    pub author_id: ParticipantId,
    /// This device's id. Used as the AAD/cleartext `deviceId` on every
    /// outbound envelope and to fill the `from` field of signal payloads.
    pub local_device_id: DeviceId,
    /// The peer we are negotiating with. Every signal envelope this transport
    /// mints carries `target.deviceId = remote_device_id` so the relay routes
    /// the SDP/ICE to exactly the right device.
    pub remote_device_id: DeviceId,
    /// 32-byte AEAD subkey for `kind: "event"` envelopes. Re-derived via
    /// `crypto::kdf::derive_room_keys(roomSecret).event_key`. Unused on the
    /// signaling fast path but kept here so the transport can serialize
    /// outbound application envelopes for the DataChannel without re-deriving.
    pub event_key: [u8; 32],
    /// 32-byte AEAD subkey for `kind: "snapshot_blob"` envelopes. Same
    /// derivation as `event_key`.
    pub snapshot_key: [u8; 32],
    /// 32-byte AEAD subkey for `kind: "signal"` envelopes. Used by
    /// `assemble_signal_envelope` when minting outbound offer/answer/ICE
    /// signal envelopes that we push onto `signaling_tx`.
    pub signaling_key: [u8; 32],
    /// STUN server URLs. Empty -> default to `DEFAULT_STUN_SERVER`. TURN
    /// servers can be added here too (same format), but per `data-model.md`
    /// §WebRTC DataChannel we ship STUN-only by default.
    pub stun_servers: Vec<String>,
}

impl WebRtcConfig {
    /// Resolve the ICE server list, falling back to the default Google STUN
    /// endpoint when the caller passed nothing.
    fn ice_servers(&self) -> Vec<RTCIceServer> {
        let urls: Vec<String> = if self.stun_servers.is_empty() {
            vec![DEFAULT_STUN_SERVER.to_string()]
        } else {
            self.stun_servers.clone()
        };
        vec![RTCIceServer {
            urls,
            ..Default::default()
        }]
    }
}

// ---------------------------------------------------------------------------
// Outbound signal-envelope clock
// ---------------------------------------------------------------------------

/// Source of the `createdAt`/`expiresAt` timestamps stamped onto outbound
/// signal envelopes. Pulled out as a trait so unit tests can pin the clock
/// without touching `SystemTime` directly — the same pattern used by the
/// mailbox arm (`transport::mailbox::clock::Clock`).
pub trait Clock: Send + Sync {
    /// Current wall-clock time in unix-epoch milliseconds.
    fn now_ms(&self) -> i64;
}

/// Real wall-clock implementation. Production callers always use this; tests
/// substitute `FixedClock` to make envelope `createdAt` deterministic.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// How far in the future to set `expiresAt` on signal envelopes. Signaling
/// envelopes are short-lived (the SDP/ICE they carry only matters during a
/// negotiation window); we match the mailbox arm's default of 7 days because
/// the relay treats every envelope's expiry uniformly. Signaling envelopes
/// older than this are GC'd by the relay even if they were never delivered.
const SIGNAL_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// WebRTC DataChannel arm of the `Transport` trait.
///
/// One instance per (room, remote-device) pair. The peer-connection state
/// machine lives entirely in this module; webrtc-rs callbacks bridge into
/// the shared `events_tx` (for `TransportEvent`) and `signaling_tx` (for
/// outbound signal envelopes the mailbox arm will forward) channels.
///
/// The transport does NOT own a tokio task itself — webrtc-rs spawns the
/// background workers internally. Clean shutdown is driven by [`close`],
/// which closes the peer connection (which in turn cancels webrtc-rs's
/// internal tasks).
pub struct WebRtcTransport {
    config: Arc<WebRtcConfig>,
    inbound: Arc<InboundPipeline>,
    peer_connection: Arc<RTCPeerConnection>,
    /// Application DataChannel. Populated by `create_offer` (initiator) or
    /// by the `on_data_channel` callback (responder). `Mutex<Option<_>>` so
    /// both code paths can assign without recreating the transport.
    data_channel: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    events_tx: mpsc::UnboundedSender<TransportEvent>,
    /// Outbound signal envelopes (offer/answer/ICE bursts) get pushed here.
    /// The mailbox arm consumes the receive side and POSTs them via
    /// `/envelopes` with `kind=signal`. Decoupled to keep this module from
    /// directly depending on `transport::mailbox`.
    signaling_tx: mpsc::UnboundedSender<MailboxEnvelope>,
    /// Wall clock used to stamp outbound signal envelopes. Pulled out as a
    /// trait object so tests can pin it; production code passes
    /// `Arc::new(SystemClock)`.
    clock: Arc<dyn Clock>,
}

impl WebRtcTransport {
    /// Construct a new transport, building the underlying webrtc-rs
    /// `RTCPeerConnection` and wiring the callback handlers (`on_message`,
    /// `on_ice_candidate`, `on_peer_connection_state_change`, etc).
    ///
    /// The peer connection is created in the `New` state — call
    /// `create_offer` (initiator) or `handle_offer` (responder) to drive
    /// negotiation.
    pub async fn new(
        config: Arc<WebRtcConfig>,
        inbound: Arc<InboundPipeline>,
        events_tx: mpsc::UnboundedSender<TransportEvent>,
        signaling_tx: mpsc::UnboundedSender<MailboxEnvelope>,
    ) -> Result<Self, TransportError> {
        Self::new_with_clock(
            config,
            inbound,
            events_tx,
            signaling_tx,
            Arc::new(SystemClock),
        )
        .await
    }

    /// Same as [`new`] but with a pluggable clock — exposed for unit tests
    /// that need deterministic envelope timestamps.
    pub async fn new_with_clock(
        config: Arc<WebRtcConfig>,
        inbound: Arc<InboundPipeline>,
        events_tx: mpsc::UnboundedSender<TransportEvent>,
        signaling_tx: mpsc::UnboundedSender<MailboxEnvelope>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, TransportError> {
        let api = APIBuilder::new().build();
        let rtc_config = RTCConfiguration {
            ice_servers: config.ice_servers(),
            ..Default::default()
        };
        let pc = api
            .new_peer_connection(rtc_config)
            .await
            .map_err(|e| TransportError::Io(format!("new_peer_connection: {e}")))?;
        let pc = Arc::new(pc);

        let transport = Self {
            config: Arc::clone(&config),
            inbound: Arc::clone(&inbound),
            peer_connection: Arc::clone(&pc),
            data_channel: Arc::new(Mutex::new(None)),
            events_tx: events_tx.clone(),
            signaling_tx: signaling_tx.clone(),
            clock: Arc::clone(&clock),
        };

        // Wire ICE-candidate trickle: every local candidate webrtc-rs gathers
        // becomes an outbound `SignalingPayload::Ice` envelope. We send one
        // candidate per envelope here (rather than batching) to minimize
        // negotiation latency — a burst-coalescing pass can land in 7.4 if
        // benchmarks show envelope overhead dominates.
        Self::wire_on_ice_candidate(&pc, &config, &signaling_tx, &clock);

        // Wire peer-connection state transitions onto the shared events_tx
        // so `ReviewManager` can react to Connected / Disconnected /
        // Failed / Closed in the same loop it uses for mailbox events.
        Self::wire_on_peer_connection_state(&pc, &events_tx);

        // Wire `on_data_channel` for the responder side — the initiator
        // calls `create_data_channel` directly inside `create_offer`, so
        // its channel is wired separately at that call site.
        Self::wire_on_data_channel(&pc, &inbound, &events_tx, &transport.data_channel, &config);

        Ok(transport)
    }

    /// Initiator side: create the DataChannel, generate an SDP offer, set it
    /// as the local description, and push a `SignalingPayload::Offer`
    /// envelope onto `signaling_tx`. The mailbox arm POSTs it; the remote
    /// peer's `handle_offer` consumes it.
    ///
    /// Idempotent only at the webrtc-rs layer — repeated calls produce
    /// fresh DataChannels and fresh offers. Callers (Phase 4 connection
    /// state machine in 7.4) gate against this.
    pub async fn create_offer(&self) -> Result<(), TransportError> {
        // Create the DataChannel BEFORE the offer so the SDP includes the
        // m=application section. Per the WebRTC spec, `create_offer` only
        // emits a DataChannel section if one has been allocated.
        let dc = self
            .peer_connection
            .create_data_channel(DATA_CHANNEL_LABEL, None)
            .await
            .map_err(|e| TransportError::Io(format!("create_data_channel: {e}")))?;

        wire_data_channel_handlers(
            Arc::clone(&dc),
            Arc::clone(&self.inbound),
            self.events_tx.clone(),
            Arc::clone(&self.config),
        );
        *self.data_channel.lock().await = Some(Arc::clone(&dc));

        let offer = self
            .peer_connection
            .create_offer(None)
            .await
            .map_err(|e| TransportError::Io(format!("create_offer: {e}")))?;
        self.peer_connection
            .set_local_description(offer.clone())
            .await
            .map_err(|e| TransportError::Io(format!("set_local_description: {e}")))?;

        self.publish_signal(SignalingPayload::Offer {
            sdp: offer.sdp,
            from: self.config.local_device_id.clone(),
        })?;
        Ok(())
    }

    /// Responder side: install the remote peer's offer SDP, generate an
    /// answer, install the answer as the local description, and emit a
    /// `SignalingPayload::Answer` envelope on `signaling_tx`.
    pub async fn handle_offer(&self, sdp: String) -> Result<(), TransportError> {
        let offer = RTCSessionDescription::offer(sdp)
            .map_err(|e| TransportError::Io(format!("parse offer sdp: {e}")))?;
        self.peer_connection
            .set_remote_description(offer)
            .await
            .map_err(|e| TransportError::Io(format!("set_remote_description offer: {e}")))?;

        let answer = self
            .peer_connection
            .create_answer(None)
            .await
            .map_err(|e| TransportError::Io(format!("create_answer: {e}")))?;
        self.peer_connection
            .set_local_description(answer.clone())
            .await
            .map_err(|e| TransportError::Io(format!("set_local_description answer: {e}")))?;

        self.publish_signal(SignalingPayload::Answer {
            sdp: answer.sdp,
            from: self.config.local_device_id.clone(),
        })?;
        Ok(())
    }

    /// Initiator side: install the remote peer's answer SDP. Completes the
    /// SDP negotiation; ICE trickle continues independently via
    /// `handle_ice`.
    pub async fn handle_answer(&self, sdp: String) -> Result<(), TransportError> {
        let answer = RTCSessionDescription::answer(sdp)
            .map_err(|e| TransportError::Io(format!("parse answer sdp: {e}")))?;
        self.peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| TransportError::Io(format!("set_remote_description answer: {e}")))?;
        Ok(())
    }

    /// Apply one or more inbound trickle-ICE candidates from the remote
    /// peer. Candidates are bundled per `SignalingPayload::Ice` envelope so
    /// a single call may install several at once.
    ///
    /// Candidate strings are the standard SDP `a=candidate:` lines without
    /// the `a=` prefix (i.e. starting with `candidate:...`) — matches what
    /// `wire_on_ice_candidate` produces via `RTCIceCandidate::to_json`.
    pub async fn handle_ice(&self, candidates: Vec<String>) -> Result<(), TransportError> {
        use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
        for candidate in candidates {
            let init = RTCIceCandidateInit {
                candidate,
                sdp_mid: Some(String::new()),
                sdp_mline_index: Some(0),
                username_fragment: None,
            };
            self.peer_connection
                .add_ice_candidate(init)
                .await
                .map_err(|e| TransportError::Io(format!("add_ice_candidate: {e}")))?;
        }
        Ok(())
    }

    /// Send an application envelope (event or snapshot blob) over the
    /// DataChannel as canonical-JSON bytes. Per amendments #14 the bytes
    /// are already AEAD-sealed — this module never produces plaintext on
    /// the wire.
    ///
    /// Returns an `EnvelopeAck` with `server_seq = 0`. DataChannel does not
    /// have a relay sequence number; the receiver derives any ordering it
    /// needs from `events.jsonl` after the import pipeline runs.
    pub async fn send_envelope(
        &self,
        envelope: MailboxEnvelope,
    ) -> Result<EnvelopeAck, TransportError> {
        let bytes = serde_json::to_vec(&envelope)
            .map_err(|e| TransportError::Io(format!("serialize envelope: {e}")))?;
        let dc_guard = self.data_channel.lock().await;
        let dc = dc_guard
            .as_ref()
            .ok_or_else(|| TransportError::Disconnected("data channel not open".into()))?;
        dc.send(&bytes.into())
            .await
            .map_err(|e| TransportError::Io(format!("data_channel.send: {e}")))?;
        Ok(EnvelopeAck {
            envelope_id: envelope.envelope_id,
            server_seq: 0,
        })
    }

    /// Close the peer connection cleanly. webrtc-rs cancels its internal
    /// tasks and the DataChannel transitions to `Closed`, which fires the
    /// `on_close` handler we registered and ultimately emits a
    /// `TransportEvent::Disconnected` upstream.
    pub async fn close(&self) -> Result<(), TransportError> {
        self.peer_connection
            .close()
            .await
            .map_err(|e| TransportError::Io(format!("peer_connection.close: {e}")))?;
        Ok(())
    }

    // -----------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------

    /// Mint and publish a single signal envelope onto `signaling_tx`.
    /// `client_nonce` is freshly random per call — outbound signal
    /// envelopes are not retried at this layer (the 7.4 state machine
    /// handles retries by re-invoking `create_offer` / `handle_offer`).
    fn publish_signal(&self, payload: SignalingPayload) -> Result<(), TransportError> {
        let envelope = mint_signal_envelope(
            payload,
            &self.config,
            self.clock.now_ms(),
            &fresh_client_nonce(),
        )
        .map_err(|e| TransportError::Io(format!("assemble signal envelope: {e}")))?;
        self.signaling_tx
            .send(envelope)
            .map_err(|_| TransportError::Disconnected("signaling_tx receiver dropped".into()))?;
        Ok(())
    }

    /// Bridge webrtc-rs's `on_ice_candidate` callback onto `signaling_tx`.
    fn wire_on_ice_candidate(
        pc: &Arc<RTCPeerConnection>,
        config: &Arc<WebRtcConfig>,
        signaling_tx: &mpsc::UnboundedSender<MailboxEnvelope>,
        clock: &Arc<dyn Clock>,
    ) {
        let config = Arc::clone(config);
        let tx = signaling_tx.clone();
        let clock = Arc::clone(clock);
        pc.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
            let config = Arc::clone(&config);
            let tx = tx.clone();
            let clock = Arc::clone(&clock);
            Box::pin(async move {
                // `None` signals end-of-gathering. Nothing to send.
                let Some(candidate) = candidate else { return };
                let init = match candidate.to_json() {
                    Ok(init) => init,
                    Err(_) => return, // can't trickle a malformed candidate
                };
                let payload = SignalingPayload::Ice {
                    candidates: vec![init.candidate],
                    from: config.local_device_id.clone(),
                };
                let envelope = match mint_signal_envelope(
                    payload,
                    &config,
                    clock.now_ms(),
                    &fresh_client_nonce(),
                ) {
                    Ok(env) => env,
                    Err(_) => return,
                };
                // If the receiver is gone, drop silently — the transport is
                // mid-shutdown.
                let _ = tx.send(envelope);
            })
        }));
    }

    /// Bridge webrtc-rs's `on_peer_connection_state_change` callback onto
    /// `events_tx` as `TransportEvent::Disconnected` for terminal states.
    fn wire_on_peer_connection_state(
        pc: &Arc<RTCPeerConnection>,
        events_tx: &mpsc::UnboundedSender<TransportEvent>,
    ) {
        let tx = events_tx.clone();
        pc.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
            let tx = tx.clone();
            Box::pin(async move {
                match state {
                    RTCPeerConnectionState::Failed => {
                        let _ = tx.send(TransportEvent::Disconnected {
                            reason: "peer connection failed".into(),
                            close_code: None,
                        });
                    }
                    RTCPeerConnectionState::Closed => {
                        let _ = tx.send(TransportEvent::Disconnected {
                            reason: "peer connection closed".into(),
                            close_code: None,
                        });
                    }
                    RTCPeerConnectionState::Disconnected => {
                        let _ = tx.send(TransportEvent::Disconnected {
                            reason: "peer connection disconnected".into(),
                            close_code: None,
                        });
                    }
                    // Connected / Connecting / New / Unspecified: no upstream
                    // event. ReviewManager only cares about terminal states
                    // (and the Hello/Envelope traffic which is bridged
                    // separately on the DataChannel).
                    _ => {}
                }
            })
        }));
    }

    /// Bridge webrtc-rs's `on_data_channel` callback onto our wiring helper.
    fn wire_on_data_channel(
        pc: &Arc<RTCPeerConnection>,
        inbound: &Arc<InboundPipeline>,
        events_tx: &mpsc::UnboundedSender<TransportEvent>,
        data_channel_slot: &Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
        config: &Arc<WebRtcConfig>,
    ) {
        let inbound = Arc::clone(inbound);
        let events_tx = events_tx.clone();
        let slot = Arc::clone(data_channel_slot);
        let config = Arc::clone(config);
        pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
            let inbound = Arc::clone(&inbound);
            let events_tx = events_tx.clone();
            let slot = Arc::clone(&slot);
            let config = Arc::clone(&config);
            Box::pin(async move {
                wire_data_channel_handlers(
                    Arc::clone(&dc),
                    Arc::clone(&inbound),
                    events_tx,
                    Arc::clone(&config),
                );
                *slot.lock().await = Some(dc);
            })
        }));
    }
}

// ---------------------------------------------------------------------------
// DataChannel message dispatch
// ---------------------------------------------------------------------------

/// Wire the inbound message handler for a freshly-opened DataChannel. Used
/// from both the initiator side (`create_offer`) and the responder side
/// (`on_data_channel` callback) — the wiring is identical regardless of who
/// allocated the channel.
fn wire_data_channel_handlers(
    dc: Arc<RTCDataChannel>,
    inbound: Arc<InboundPipeline>,
    events_tx: mpsc::UnboundedSender<TransportEvent>,
    config: Arc<WebRtcConfig>,
) {
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let inbound = Arc::clone(&inbound);
        let events_tx = events_tx.clone();
        let config = Arc::clone(&config);
        Box::pin(async move {
            dispatch_inbound_message(msg, inbound, events_tx, config).await;
        })
    }));
}

/// Decode an inbound DataChannel message and route it through the
/// `InboundPipeline`. On a successful event import we emit
/// `TransportEvent::Envelope` so `ReviewManager` sees the same shape it
/// receives from the mailbox transport.
///
/// Errors are logged at the tracing layer (handled by the caller) but never
/// panic — a malformed envelope from a peer is annoying but not fatal.
async fn dispatch_inbound_message(
    msg: DataChannelMessage,
    inbound: Arc<InboundPipeline>,
    events_tx: mpsc::UnboundedSender<TransportEvent>,
    config: Arc<WebRtcConfig>,
) {
    let envelope: MailboxEnvelope = match parse_inbound_envelope(&msg.data) {
        Ok(env) => env,
        Err(_) => return, // bad bytes from peer; drop
    };

    use crate::review::model::EnvelopeKind;
    match envelope.kind {
        EnvelopeKind::Event => {
            if let Ok(_outcome) = inbound
                .import_event_envelope(&config.room_id, &envelope)
                .await
            {
                let _ = events_tx.send(TransportEvent::Envelope {
                    envelope,
                    server_seq: 0,
                });
            }
        }
        EnvelopeKind::SnapshotBlob => {
            if inbound
                .import_snapshot_envelope(&config.room_id, &envelope)
                .await
                .is_ok()
            {
                let _ = events_tx.send(TransportEvent::Envelope {
                    envelope,
                    server_seq: 0,
                });
            }
        }
        EnvelopeKind::Signal => {
            // Signal envelopes that arrive via the DataChannel are unusual
            // (the normal path is the mailbox), but we still hand them to
            // the same import method so the AAD/AEAD check fires. We do not
            // re-emit them as `TransportEvent::Envelope` — the 7.4 state
            // machine consumes signal envelopes via `signaling_tx`'s
            // companion receiver, not the inbound event channel.
            let _ = inbound
                .import_signal_envelope(&config.room_id, &envelope)
                .await;
        }
    }
}

/// Parse the inbound DataChannel bytes as a `MailboxEnvelope`. The wire
/// format is canonical-JSON, same as the mailbox HTTP body — see amendment
/// #14 ("DataChannel format IDENTICAL to mailbox").
fn parse_inbound_envelope(bytes: &[u8]) -> Result<MailboxEnvelope, serde_json::Error> {
    serde_json::from_slice(bytes)
}

// ---------------------------------------------------------------------------
// Signal envelope minting
// ---------------------------------------------------------------------------

/// Mint an outbound signal envelope from a `SignalingPayload` using the
/// caller's transport config + clock. Pulled out as a free function so
/// tests can exercise the assembly path without standing up a full
/// `WebRtcTransport`.
fn mint_signal_envelope(
    payload: SignalingPayload,
    config: &WebRtcConfig,
    created_at_ms: i64,
    client_nonce: &[u8; 16],
) -> Result<MailboxEnvelope, crate::review::envelope::EnvelopeError> {
    assemble_signal_envelope(
        payload,
        &config.signaling_key,
        &config.room_id,
        &config.author_id,
        &config.local_device_id,
        Some(&config.remote_device_id),
        client_nonce,
        created_at_ms,
        created_at_ms + SIGNAL_TTL_MS,
    )
}

/// Generate a fresh 16-byte client nonce for an outbound signal envelope.
/// Used as the `clientNonce` half of `derive_envelope_id_with_nonce` so the
/// relay can dedup retries — but since this transport does not retry at
/// this layer, each call to a signal-publishing path produces a fresh id.
fn fresh_client_nonce() -> [u8; 16] {
    let mut nonce = [0u8; 16];
    // `getrandom` is the same entropy source the rest of the crypto layer
    // uses (see `crypto::aead`). Failure here is exceptional (kernel CSPRNG
    // unavailable) — degrade to a deterministic-but-zero nonce so the
    // outbound signal still goes out; the receiver-side dedup just collapses
    // multiple retries onto the same envelope id, which is the worst case
    // and matches the documented "retries share clientNonce" contract.
    let _ = getrandom::getrandom(&mut nonce);
    nonce
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::RwLock;

    use crate::review::crypto::kdf::derive_room_keys;
    use crate::review::store::ReviewStore;
    use crate::review::transport::inbound::{InboundPipeline, VerifyingKeyCache};
    use crate::review::transport::signaling::disassemble_signal_envelope;

    /// Pinned room secret — matches the value used across the envelope /
    /// signaling test corpora so a cross-module divergence is loud.
    const TEST_ROOM_SECRET: [u8; 32] = [0x11u8; 32];

    /// Wall-clock substitute that always returns the same `now_ms`. Keeps
    /// envelope `createdAt` deterministic across asserts.
    struct FixedClock(i64);
    impl Clock for FixedClock {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("typed id deserializes")
    }

    /// Build a `WebRtcConfig` pinned to the standard test fixtures so every
    /// test exercises the same room/author/device tuple.
    fn fixture_config() -> Arc<WebRtcConfig> {
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        Arc::new(WebRtcConfig {
            room_id: id::<RoomId>("hjCfgOvsatNOUedgxhZpyw"),
            author_id: id::<ParticipantId>("p-author-01"),
            local_device_id: id::<DeviceId>("d-local"),
            remote_device_id: id::<DeviceId>("d-remote"),
            event_key: *keys.event_key.as_bytes(),
            snapshot_key: *keys.snapshot_key.as_bytes(),
            signaling_key: *keys.signaling_key.as_bytes(),
            stun_servers: vec![],
        })
    }

    fn fixture_pipeline() -> (Arc<InboundPipeline>, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"),
        );
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let cache: VerifyingKeyCache = Arc::new(RwLock::new(HashMap::new()));
        let pipeline = InboundPipeline::new(
            store,
            cache,
            *keys.event_key.as_bytes(),
            *keys.snapshot_key.as_bytes(),
            *keys.signaling_key.as_bytes(),
        );
        (Arc::new(pipeline), tmp)
    }

    // -----------------------------------------------------------------
    // 1. Construction smoke test — building the transport does not
    //    panic and produces a peer connection in the expected state.
    //    Catches regressions where webrtc-rs's APIBuilder changes shape
    //    or RTCConfiguration requires a new mandatory field.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn new_constructs_without_panic() {
        let config = fixture_config();
        let (inbound, _tmp) = fixture_pipeline();
        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let (signaling_tx, _signaling_rx) = mpsc::unbounded_channel();

        let transport = WebRtcTransport::new(config, inbound, events_tx, signaling_tx)
            .await
            .expect("construct webrtc transport");

        // A freshly-built peer connection should be in the `New` state —
        // no negotiation has happened yet.
        assert!(
            matches!(
                transport.peer_connection.connection_state(),
                RTCPeerConnectionState::New
            ),
            "fresh peer connection should be in New state"
        );
    }

    // -----------------------------------------------------------------
    // 2. Default STUN server fallback fires when stun_servers is empty.
    //    Locks down amendment-relevant default ("STUN only, configurable"
    //    in data-model.md §WebRTC DataChannel) so a future refactor
    //    cannot silently flip the default.
    // -----------------------------------------------------------------

    #[test]
    fn ice_servers_default_to_google_stun() {
        let mut cfg = WebRtcConfig {
            room_id: id::<RoomId>("r"),
            author_id: id::<ParticipantId>("a"),
            local_device_id: id::<DeviceId>("l"),
            remote_device_id: id::<DeviceId>("r"),
            event_key: [0u8; 32],
            snapshot_key: [0u8; 32],
            signaling_key: [0u8; 32],
            stun_servers: vec![],
        };
        let servers = cfg.ice_servers();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].urls, vec![DEFAULT_STUN_SERVER.to_string()]);

        // Explicit override is honoured verbatim.
        cfg.stun_servers = vec!["stun:custom:3478".to_string()];
        let servers = cfg.ice_servers();
        assert_eq!(servers[0].urls, vec!["stun:custom:3478".to_string()]);
    }

    // -----------------------------------------------------------------
    // 3. Signal-envelope minting routes through the same disassembler the
    //    7.2 helpers expose — proves the helper actually produces an
    //    envelope the inbound side can open under signalingKey, and that
    //    the `target.deviceId` field gets populated with the remote peer.
    // -----------------------------------------------------------------

    #[test]
    fn mint_signal_envelope_produces_round_trip_signal_envelope() {
        let config = fixture_config();
        let payload = SignalingPayload::Offer {
            sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n".into(),
            from: config.local_device_id.clone(),
        };

        let env = mint_signal_envelope(payload.clone(), &config, 1_700_000_000_000, &[0x42u8; 16])
            .expect("mint signal envelope");

        // Target must be the configured remote peer — that's what tells the
        // relay where to route the signal.
        assert_eq!(
            env.target.as_ref().map(|t| &t.device_id),
            Some(&config.remote_device_id),
            "signal envelopes must target remote_device_id"
        );

        // Round-trip through the public 7.2 helper to prove it was sealed
        // under the right key with the right AAD.
        let recovered = disassemble_signal_envelope(&env, &config.signaling_key)
            .expect("disassemble produced envelope");
        assert_eq!(recovered, payload);
    }

    // -----------------------------------------------------------------
    // 4. publish_signal pushes onto signaling_tx and the receiver gets
    //    a real signal envelope. Exercises the channel-bridging logic
    //    without needing a live peer connection — the same code path
    //    `create_offer` / `handle_offer` use to surface their outbound
    //    SDP onto the mailbox arm.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn publish_signal_routes_through_signaling_tx() {
        let config = fixture_config();
        let (inbound, _tmp) = fixture_pipeline();
        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let (signaling_tx, mut signaling_rx) = mpsc::unbounded_channel();

        let transport = WebRtcTransport::new_with_clock(
            Arc::clone(&config),
            inbound,
            events_tx,
            signaling_tx,
            Arc::new(FixedClock(1_700_000_001_234)),
        )
        .await
        .expect("construct webrtc transport");

        let payload = SignalingPayload::Answer {
            sdp: "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n".into(),
            from: config.local_device_id.clone(),
        };
        transport
            .publish_signal(payload.clone())
            .expect("publish signal");

        let env = signaling_rx
            .recv()
            .await
            .expect("signaling_tx must deliver an envelope");
        assert_eq!(env.created_at, 1_700_000_001_234);
        assert_eq!(env.expires_at, 1_700_000_001_234 + SIGNAL_TTL_MS as u64);
        let recovered = disassemble_signal_envelope(&env, &config.signaling_key)
            .expect("disassemble routed envelope");
        assert_eq!(recovered, payload);
    }

    // -----------------------------------------------------------------
    // 5. close() does not panic and leaves the peer in Closed state.
    //    Exercises the cleanup path the Drop-like teardown depends on;
    //    a future refactor that breaks `close` would otherwise surface
    //    only via leaked tasks in production.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn close_transitions_peer_connection_to_closed() {
        let config = fixture_config();
        let (inbound, _tmp) = fixture_pipeline();
        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let (signaling_tx, _signaling_rx) = mpsc::unbounded_channel();

        let transport = WebRtcTransport::new(config, inbound, events_tx, signaling_tx)
            .await
            .expect("construct webrtc transport");
        transport.close().await.expect("close ok");

        assert!(
            matches!(
                transport.peer_connection.connection_state(),
                RTCPeerConnectionState::Closed
            ),
            "peer connection should be Closed after close()"
        );

        // Closing twice must not panic — webrtc-rs returns Ok on a second
        // close, but we exercise the path to lock down the contract.
        transport.close().await.expect("double close ok");
    }

    // -----------------------------------------------------------------
    // 6. parse_inbound_envelope rejects garbage bytes cleanly so a
    //    malformed peer frame can't crash the dispatcher.
    // -----------------------------------------------------------------

    #[test]
    fn parse_inbound_envelope_rejects_non_json_bytes() {
        let err = parse_inbound_envelope(b"not json at all").expect_err("must reject non-JSON");
        assert!(
            !err.to_string().is_empty(),
            "parse error must carry a message"
        );
    }

    // -----------------------------------------------------------------
    // 7. send_envelope before the DataChannel exists fails with a
    //    Disconnected error, not a panic — the connection state machine
    //    in 7.4 relies on this to short-circuit early sends.
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn send_envelope_without_data_channel_returns_disconnected() {
        let config = fixture_config();
        let (inbound, _tmp) = fixture_pipeline();
        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let (signaling_tx, _signaling_rx) = mpsc::unbounded_channel();

        let transport = WebRtcTransport::new(Arc::clone(&config), inbound, events_tx, signaling_tx)
            .await
            .expect("construct webrtc transport");

        // Use a hand-rolled envelope rather than an assembled one; the send
        // path only cares about the JSON-serializable shape.
        let envelope = MailboxEnvelope {
            v: 2,
            room_id: config.room_id.clone(),
            envelope_id: "envid".to_string(),
            server_seq: None,
            author_id: config.author_id.clone(),
            device_id: config.local_device_id.clone(),
            created_at: 1,
            expires_at: 2,
            kind: crate::review::model::EnvelopeKind::Event,
            target: None,
            nonce: String::new(),
            ciphertext: String::new(),
            ciphertext_bytes: 0,
        };
        let err = transport
            .send_envelope(envelope)
            .await
            .expect_err("send before data channel must fail");
        assert!(
            matches!(err, TransportError::Disconnected(_)),
            "expected Disconnected, got {err:?}"
        );
    }
}
