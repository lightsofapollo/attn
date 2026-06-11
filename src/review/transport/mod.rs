//! Transport trait + message types for review envelope delivery.
//!
//! Two concrete impls land later:
//!   - Mailbox (HTTP + WebSocket via Cloudflare relay)  — issues 6.2-6.7
//!   - WebRTC DataChannel                                — Phase 4 (issues 7.x)
//!
//! Both speak the same `MailboxEnvelope` wire format — the only difference is
//! the bytes path. The frontend never holds raw transport; `ReviewManager`
//! owns it and pumps inbound `TransportEvent`s back into the daemon loop.
//!
//! Spec: `planning/collab/data-model.md` §Transport Model + §Encrypted
//! Envelopes; `planning/collab/relay-spec.md` §WebSocket Protocol (frame
//! types the trait must surface).

#![allow(dead_code)]

use async_trait::async_trait;
use tokio::sync::mpsc;

pub mod blobs;
pub mod inbound;
pub mod mailbox;
pub mod selector;
pub mod signaling;
pub mod webrtc;

use crate::review::ids::{DeviceId, RoomId};
use crate::review::model::{Device, MailboxEnvelope, RoomPolicy};

/// Errors any `Transport` implementation may surface.
///
/// Variants mirror the error/close codes the relay surfaces over the
/// WebSocket control channel — see `planning/collab/relay-spec.md`
/// §WebSocket Protocol §Close Codes.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// Underlying connection dropped / not reconnectable without backoff.
    #[error("transport disconnected: {0}")]
    Disconnected(String),
    /// The supplied `after_seq` is older than the relay's retention window;
    /// the consumer must resync from `0` (or the supplied floor).
    #[error("cursor too old; reset required (resync from seq {0})")]
    CursorTooOld(u64),
    /// Relay rejected this device's admission proof (PoW token, signing key,
    /// or capability mismatch).
    #[error("admission rejected")]
    AdmissionRejected,
    /// The room id is unknown to the relay.
    #[error("room not found")]
    RoomNotFound,
    /// The room was deleted (owner stop, GC, or policy violation).
    #[error("room deleted")]
    RoomDeleted,
    /// The room's policy `expires_at` has passed.
    #[error("room expired")]
    RoomExpired,
    /// Relay applied per-room or per-device backpressure.
    #[error("rate limited; retry after {0}ms")]
    RateLimited(u64),
    /// Relay refused the write because the room is at its mailbox cap.
    #[error("storage cap reached")]
    StorageCapReached,
    /// Generic I/O failure (DNS, TLS, socket, JSON, etc).
    #[error("io: {0}")]
    Io(String),
}

/// Events the transport pushes back to its consumer (typically
/// `ReviewManager`).
///
/// The transport runs its own task internally; the consumer drains an
/// `UnboundedReceiver<TransportEvent>` returned from `connect`.
// `EventImported` carries a full `ReviewEvent` (~816B). These events flow one at
// a time over an unbounded channel and are consumed immediately; boxing would
// only churn every construct/match site for no real allocation win.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum TransportEvent {
    /// First frame the relay sends after admission completes.
    ///
    /// Carries the current `server_seq` watermark, the room policy
    /// snapshot, the live device list, and any signal envelope ids the
    /// consumer missed while offline (so it can pull them on demand).
    Hello {
        server_seq: u64,
        policy: RoomPolicy,
        devices: Vec<Device>,
        missed_signal_envelope_ids: Vec<String>,
    },
    /// A `MailboxEnvelope` delivered from the relay along with the server
    /// sequence number the consumer should persist before acking.
    Envelope {
        envelope: MailboxEnvelope,
        server_seq: u64,
    },
    /// A `ReviewEvent` was just successfully decoded + appended to
    /// `events.jsonl`. Carries the decoded event so downstream consumers
    /// (the daemon's UI bridge, primarily) can render it without a
    /// second filesystem read.
    EventImported {
        room_id: RoomId,
        event: crate::review::model::ReviewEvent,
    },
    /// Presence (join/leave) update for a remote device in the room.
    Presence {
        event: PresenceEvent,
        device_id: DeviceId,
        participant_id: String,
    },
    /// Live co-typing traffic decoded from a `signal` envelope. `payload` is
    /// the opaque prosemirror-collab JSON the sender's webview emitted (a
    /// submission or a broadcast); the daemon shuttles it to its own webview
    /// without parsing. `from` is the originating device (lets the webview
    /// drop its own broadcast echoes).
    CollabSignal {
        room_id: RoomId,
        from: DeviceId,
        payload: String,
    },
    /// WebRTC negotiation signaling (SDP offer/answer, trickle ICE) decoded
    /// from a `signal` envelope. The per-room connection orchestrator routes
    /// this to the matching `WebRtcTransport` (handle_offer / handle_answer /
    /// add_remote_ice). This is the CONTROL plane — once the DataChannel opens,
    /// the high-frequency DATA plane (collab steps, cursors) rides the channel
    /// directly, not the relay. `Collab` keeps its own `CollabSignal` variant.
    Signaling {
        room_id: RoomId,
        payload: crate::review::transport::signaling::SignalingPayload,
    },
    /// The room policy changed (owner edit, capability revocation, expiry
    /// update). Consumer should reload policy-dependent UI / caps.
    PolicyChanged { policy: RoomPolicy },
    /// Transport-level disconnect notification. Includes the relay close
    /// code when one was received cleanly.
    Disconnected {
        reason: String,
        close_code: Option<u16>,
    },
    /// Non-fatal relay-side error frame surfaced for telemetry / UI.
    Error { code: String, message: String },
}

/// Whether a presence event is a join or leave for the named device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceEvent {
    Join,
    Leave,
}

/// Refreshes the verifying-key cache when the inbound pipeline hits an
/// `UnknownSigner` — i.e. an envelope arrived from a device that joined
/// after the cache was last populated. The mailbox WS client calls this,
/// then retries the import once. The implementation (wired by
/// `ReviewManager`) re-fetches `GET /devices` and merges the roster into
/// the shared cache the `InboundPipeline` reads from.
#[async_trait]
pub trait DeviceKeyRefresher: Send + Sync {
    /// Re-fetch the room's device directory and merge it into the cache.
    /// Returns the number of keys merged, or an error string for logging.
    async fn refresh(&self) -> Result<usize, String>;
}

/// A `Transport` is bound to a single `(RoomId, DeviceId)` pair.
///
/// Implementations:
///   - `Mailbox` — HTTP + WebSocket against the Cloudflare relay (6.2-6.7).
///   - `WebRtc` — peer-to-peer DataChannel (Phase 4, issues 7.x).
///
/// Both deliver the same `MailboxEnvelope` wire format; the only difference
/// is the bytes path.
#[async_trait]
pub trait Transport: Send + Sync {
    /// Connect (or reconnect) and subscribe to envelopes after `after_seq`.
    ///
    /// Returns a receiver of inbound events; the transport spawns its own
    /// task to drive the underlying socket. Dropping the receiver does NOT
    /// disconnect — call `disconnect` for a clean shutdown.
    async fn connect(
        &self,
        room_id: &RoomId,
        device_id: &DeviceId,
        after_seq: u64,
    ) -> Result<mpsc::UnboundedReceiver<TransportEvent>, TransportError>;

    /// Send a batch of envelopes.
    ///
    /// Per `planning/collab/crypto-spec.md` §Envelope Batch Cap the batch
    /// size MUST be ≤ 32 envelopes. Callers are expected to chunk; the
    /// trait does not enforce — implementations may return an error.
    async fn send_envelopes(
        &self,
        envelopes: Vec<MailboxEnvelope>,
    ) -> Result<Vec<EnvelopeAck>, TransportError>;

    /// ACK one or more delivered envelopes.
    ///
    /// When `with_delete` is `true` and the room policy has
    /// `delete_events_after_owner_ack`, the relay will GC the acked
    /// envelopes from the mailbox.
    async fn ack(&self, envelope_ids: Vec<String>, with_delete: bool)
    -> Result<(), TransportError>;

    /// Disconnect cleanly. The transport's background task exits and any
    /// outstanding receivers see a final `Disconnected` event before close.
    async fn disconnect(&self) -> Result<(), TransportError>;
}

/// Server-issued acknowledgement of an envelope the client sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeAck {
    pub envelope_id: String,
    pub server_seq: u64,
}

/// Stub no-op transport used by tests and by `ReviewManager` before any
/// real impl is wired in. Every method succeeds, no I/O is performed, and
/// the `connect` stream is empty.
#[derive(Default)]
pub struct StubTransport;

impl StubTransport {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Transport for StubTransport {
    async fn connect(
        &self,
        _room_id: &RoomId,
        _device_id: &DeviceId,
        _after_seq: u64,
    ) -> Result<mpsc::UnboundedReceiver<TransportEvent>, TransportError> {
        // Create a channel and immediately drop the sender — the receiver
        // returns `None` on first poll, modeling "connected but silent".
        let (_tx, rx) = mpsc::unbounded_channel();
        Ok(rx)
    }

    async fn send_envelopes(
        &self,
        _envelopes: Vec<MailboxEnvelope>,
    ) -> Result<Vec<EnvelopeAck>, TransportError> {
        Ok(Vec::new())
    }

    async fn ack(
        &self,
        _envelope_ids: Vec<String>,
        _with_delete: bool,
    ) -> Result<(), TransportError> {
        Ok(())
    }

    async fn disconnect(&self) -> Result<(), TransportError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;

    /// Mint a typed newtype id from a string through serde — the tuple
    /// structs in `ids.rs` keep their inner field crate-private so wire
    /// formats are the only entry point. Matches the helper used in
    /// `model.rs` tests.
    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("id deserializes from string")
    }

    #[tokio::test]
    async fn stub_connect_returns_empty_stream() {
        let t = StubTransport::new();
        let mut rx = t
            .connect(&id::<RoomId>("room-1"), &id::<DeviceId>("dev-1"), 0)
            .await
            .expect("connect ok");

        // The sender side was dropped inside `connect`, so the next recv
        // resolves to `None` rather than panicking or hanging.
        assert!(rx.recv().await.is_none(), "stub stream should be empty");
    }

    #[tokio::test]
    async fn stub_send_envelopes_returns_empty_acks() {
        let t = StubTransport::new();
        let acks = t.send_envelopes(Vec::new()).await.expect("send ok");
        assert!(acks.is_empty(), "stub should return zero acks");
    }

    #[tokio::test]
    async fn stub_ack_succeeds() {
        let t = StubTransport::new();
        t.ack(vec!["env-1".to_string(), "env-2".to_string()], false)
            .await
            .expect("ack ok");
        t.ack(vec!["env-3".to_string()], true)
            .await
            .expect("ack with_delete ok");
    }

    #[tokio::test]
    async fn stub_disconnect_succeeds() {
        let t = StubTransport::new();
        t.disconnect().await.expect("disconnect ok");
    }

    #[test]
    fn transport_error_display_smoke() {
        // Every variant must have a non-empty Display impl so daemon logs
        // and IPC error frames stay legible.
        let cases: Vec<TransportError> = vec![
            TransportError::Disconnected("socket closed".into()),
            TransportError::CursorTooOld(42),
            TransportError::AdmissionRejected,
            TransportError::RoomNotFound,
            TransportError::RoomDeleted,
            TransportError::RoomExpired,
            TransportError::RateLimited(1500),
            TransportError::StorageCapReached,
            TransportError::Io("dns failure".into()),
        ];
        for err in cases {
            let rendered = err.to_string();
            assert!(
                !rendered.is_empty(),
                "TransportError variant rendered empty: {err:?}"
            );
        }

        // Spot-check that numeric payloads survive into the message.
        assert!(
            TransportError::CursorTooOld(99).to_string().contains("99"),
            "CursorTooOld should embed the seq number"
        );
        assert!(
            TransportError::RateLimited(2500)
                .to_string()
                .contains("2500"),
            "RateLimited should embed the retry-after ms"
        );
    }

    #[test]
    fn presence_event_is_copy() {
        // PresenceEvent appears inside TransportEvent::Presence, which
        // implements Clone — keeping the inner enum Copy avoids surprise
        // allocations when fanning out.
        fn assert_copy<T: Copy>() {}
        assert_copy::<PresenceEvent>();
        let e = PresenceEvent::Join;
        let _ = e;
        let _ = e; // second use is fine because it's Copy.
    }
}
