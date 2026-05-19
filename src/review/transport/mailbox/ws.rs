//! Mailbox WebSocket client — inbound half of the Mailbox `Transport` impl.
//!
//! This module owns the **inbound** path against the Cloudflare relay
//! (`wss://relay/v2/rooms/:roomId/socket?device_id=:deviceId`). The outbound
//! path (HTTP POST envelopes) lives next door in `mod.rs::OutboxProcessor`;
//! both halves share the same `MailboxConfig` so admission HMAC keying stays
//! consistent.
//!
//! Wire protocol: `planning/collab/relay-spec.md` §WebSocket Protocol
//! (server frames `hello | envelope | presence | policy_changed | ping | error`,
//! client frames `subscribe | pong`). Close codes per §Close Codes
//! (1000 normal, 4000 admission, 4001 deleted, 4002 expired, 4005 cursor too old).
//!
//! Reconnect: exponential backoff with cap (1s, 2s, 4s, …, 60s). Cancellation
//! is driven by a `tokio::sync::watch::Receiver<bool>` so the daemon can flip
//! the flag from any task. Routing of decoded `envelope` frames is delegated
//! to the `InboundPipeline` (attn-nnj.6.4) so the WS layer never touches
//! cleartext or holds any key material.
//!
//! What this module does NOT do:
//!   - Send envelopes — that's `OutboxProcessor::send_batch` over HTTP.
//!   - Persist the cursor — caller owns `after_seq`; the client only reports
//!     `Hello.server_seq` and per-envelope `server_seq` so the consumer can
//!     advance its own watermark. Cursor management lands in attn-nnj.6.5.
//!   - Resolve `BlobRef` snapshots from R2 — that lives in 5.8.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::review::model::{Device, MailboxEnvelope, RoomPolicy, SyncCursor};
use crate::review::store::ReviewStore;
use crate::review::transport::inbound::InboundPipeline;
use crate::review::transport::{PresenceEvent, TransportError, TransportEvent};

use super::{CursorRecoveryPolicy, MailboxConfig};

// ---------------------------------------------------------------------------
// Reconnect tuning
// ---------------------------------------------------------------------------

/// Initial reconnect delay on network drop or 1xxx close. The relay's
/// `ping`/`pong` keepalive is on a 30s cadence so a 1s first retry stays
/// well inside the server's idle alarm without hammering on flap.
pub const RECONNECT_INITIAL_MS: u64 = 1_000;
/// Cap on the exponential backoff. After ~6 doublings we sit at 64s, which
/// we clamp to 60s — matching the OutboxProcessor's `BACKOFF_MAX_MS` so the
/// two halves don't drift if they're both reconnecting on the same outage.
pub const RECONNECT_MAX_MS: u64 = 60_000;

// ---------------------------------------------------------------------------
// MailboxWsClient — public surface
// ---------------------------------------------------------------------------

/// WebSocket client for the mailbox transport.
///
/// Owns:
///   - `config` — relay URL, room/device binding, 32-byte admission key.
///     Shared by reference with `OutboxProcessor` so a single rotation
///     replaces both halves at once.
///   - `inbound` — shared `InboundPipeline` that decrypts + verifies +
///     dedupes envelopes. Routing on `envelope.kind` happens inside `run`.
///   - `store` — durable review store; cursor persistence (attn-nnj.6.5)
///     calls `store.save_cursor` after every successful import so a process
///     restart resumes at the right `serverSeq`.
///   - `recovery_policy` — how the client reacts to an
///     `ATTN_CURSOR_TOO_OLD` (close 4005). Default is `ResyncFromOldest` —
///     discard the cursor and reconnect from the relay's oldest retained
///     `serverSeq`. The P2P snapshot path and a Manual override are also
///     supported (see `CursorRecoveryPolicy`).
///   - `events_tx` — un-bounded sender the consumer (typically
///     `ReviewManager`) drains for `TransportEvent`s. Un-bounded because
///     dropping a presence or hello frame would desync the live device list;
///     backpressure belongs in the consumer's downstream queues.
pub struct MailboxWsClient {
    config: Arc<MailboxConfig>,
    inbound: Arc<InboundPipeline>,
    store: Arc<ReviewStore>,
    recovery_policy: CursorRecoveryPolicy,
    events_tx: mpsc::UnboundedSender<TransportEvent>,
}

impl MailboxWsClient {
    /// Construct a new client. Does not open a connection — call `run`.
    ///
    /// Uses the default `CursorRecoveryPolicy::ResyncFromOldest` recovery
    /// policy. Use `with_recovery_policy` to override (e.g. for the P2P
    /// path or for tests that want to inspect the Error event before
    /// reconnecting).
    pub fn new(
        config: Arc<MailboxConfig>,
        inbound: Arc<InboundPipeline>,
        store: Arc<ReviewStore>,
        events_tx: mpsc::UnboundedSender<TransportEvent>,
    ) -> Self {
        Self {
            config,
            inbound,
            store,
            recovery_policy: CursorRecoveryPolicy::default(),
            events_tx,
        }
    }

    /// Override the cursor-recovery policy. See `CursorRecoveryPolicy` for
    /// the semantics of each variant.
    pub fn with_recovery_policy(mut self, policy: CursorRecoveryPolicy) -> Self {
        self.recovery_policy = policy;
        self
    }

    /// Borrow the active config (matches `OutboxProcessor::config`).
    pub fn config(&self) -> &MailboxConfig {
        &self.config
    }

    /// Borrow the active store (used by orchestrators that want to inspect
    /// the persisted cursor outside of the `run` loop).
    pub fn store(&self) -> &Arc<ReviewStore> {
        &self.store
    }

    /// Active cursor recovery policy.
    pub fn recovery_policy(&self) -> CursorRecoveryPolicy {
        self.recovery_policy
    }

    /// Load the persisted `last_pulled_seq` cursor for this client's room.
    /// Returns `0` when no cursor is yet on disk (first connect) or when
    /// the store read fails (treated as "start from beginning" — the
    /// reconnect path will save a fresh cursor as envelopes arrive).
    fn load_after_seq(&self) -> u64 {
        match self.store.load_cursor(&self.config.room_id) {
            Ok(Some(cursor)) => cursor.last_pulled_seq,
            Ok(None) => 0,
            Err(e) => {
                let _ = self.events_tx.send(TransportEvent::Error {
                    code: "ATTN_CURSOR_LOAD".to_string(),
                    message: format!("load_cursor failed: {e}; resuming from seq 0"),
                });
                0
            }
        }
    }

    /// Persist a fresh cursor at `seq`. Preserves any existing
    /// `imported_event_ids` / `pending_outbound_envelope_ids` lists — those
    /// are owned by `ReviewManager` and would silently regress if we
    /// overwrote with empty defaults from inside the WS layer.
    fn save_seq(&self, seq: u64) {
        let existing = self
            .store
            .load_cursor(&self.config.room_id)
            .ok()
            .flatten();
        let cursor = match existing {
            Some(mut c) => {
                c.last_pulled_seq = seq;
                c.device_id = self.config.device_id.clone();
                c.room_id = self.config.room_id.clone();
                c
            }
            None => SyncCursor {
                room_id: self.config.room_id.clone(),
                device_id: self.config.device_id.clone(),
                last_pulled_seq: seq,
                imported_event_ids: Vec::new(),
                pending_outbound_envelope_ids: Vec::new(),
            },
        };
        if let Err(e) = self.store.save_cursor(&self.config.room_id, &cursor) {
            let _ = self.events_tx.send(TransportEvent::Error {
                code: "ATTN_CURSOR_SAVE".to_string(),
                message: format!("save_cursor failed: {e}"),
            });
        }
    }

    // `run` is implemented further below once the connect + routing helpers
    // land. Splitting the impl keeps the public surface above readable and
    // the long internal helpers grouped near each other.
}

// ---------------------------------------------------------------------------
// Wire frame shapes (parsed JSON; mirrors relay/src/room-do.ts ServerFrame /
// clientFrameSchema). These types stay private — the public API exposes
// decoded events via `TransportEvent` so the wire shape can move without
// breaking callers.
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerFrame {
    Hello {
        #[serde(rename = "serverSeq")]
        server_seq: u64,
        policy: RoomPolicy,
        devices: Vec<Device>,
        #[serde(rename = "missedSignalEnvelopeIds", default)]
        missed_signal_envelope_ids: Vec<String>,
    },
    Envelope {
        envelope: MailboxEnvelope,
        #[serde(rename = "serverSeq")]
        server_seq: u64,
    },
    Presence {
        event: PresenceEventWire,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "participantId")]
        participant_id: String,
    },
    PolicyChanged {
        policy: RoomPolicy,
    },
    Ping {
        ts: i64,
    },
    Error {
        code: String,
        #[serde(default)]
        message: String,
        #[serde(rename = "resyncFromSeq", default)]
        resync_from_seq: Option<u64>,
    },
}

/// Wire form for presence — matches the relay's lowercase strings ("join" /
/// "leave"). Kept private so callers consume the public `PresenceEvent`.
#[derive(Debug, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum PresenceEventWire {
    Join,
    Leave,
}

impl From<PresenceEventWire> for PresenceEvent {
    fn from(w: PresenceEventWire) -> Self {
        match w {
            PresenceEventWire::Join => PresenceEvent::Join,
            PresenceEventWire::Leave => PresenceEvent::Leave,
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientFrame {
    Subscribe { after: u64 },
    Pong { ts: i64 },
}

// ---------------------------------------------------------------------------
// Admission HMAC subprotocol
// ---------------------------------------------------------------------------

/// Build the `Sec-WebSocket-Protocol` value `"attn.v2, hmac.<base64url>"` per
/// relay-spec.md §WebSocket Protocol. The HMAC binds the same canonicalRequest
/// the HTTP envelopes endpoint signs, with an empty body — see
/// `verifyAdmissionHmac` in `relay/src/room-do.ts` for the server-side mirror.
pub(crate) fn build_subprotocol(
    admission_key: &[u8; 32],
    method: &str,
    url_path: &str,
    query_pairs: &[(String, String)],
) -> String {
    let canonical = canonical_request_bytes(method, url_path, query_pairs, b"");
    let mut mac = <Hmac<Sha256>>::new_from_slice(admission_key)
        .expect("HMAC accepts any key length");
    mac.update(&canonical);
    let tag = mac.finalize().into_bytes();
    format!("attn.v2, hmac.{}", URL_SAFE_NO_PAD.encode(tag))
}

/// Duplicate of `super::canonical_request_bytes` — pulled inline so this
/// module compiles without a `pub(crate)` leak of the canonicalization helpers.
/// The shape is identical (METHOD || "\n" || PATH || "\n" || CANON_QUERY ||
/// "\n" || SHA256(body)); for an empty body the trailing 32 bytes are
/// SHA-256("") which is the standard "no body" sentinel.
fn canonical_request_bytes(
    method: &str,
    url_path: &str,
    query_pairs: &[(String, String)],
    body: &[u8],
) -> Vec<u8> {
    let canonical_query = canonicalize_query(query_pairs);
    let body_hash = Sha256::digest(body);
    let mut out = Vec::with_capacity(
        method.len() + 1 + url_path.len() + 1 + canonical_query.len() + 1 + body_hash.len(),
    );
    out.extend_from_slice(method.to_ascii_uppercase().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(url_path.as_bytes());
    out.push(b'\n');
    out.extend_from_slice(canonical_query.as_bytes());
    out.push(b'\n');
    out.extend_from_slice(&body_hash);
    out
}

fn canonicalize_query(pairs: &[(String, String)]) -> String {
    let mut pairs = pairs.to_vec();
    pairs.sort_by(|a, b| match a.0.cmp(&b.0) {
        std::cmp::Ordering::Equal => a.1.cmp(&b.1),
        other => other,
    });
    pairs
        .into_iter()
        .map(|(k, v)| format!("{}={}", rfc3986_encode(&k), rfc3986_encode(&v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn rfc3986_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let is_unreserved = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if is_unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Compose the WS URL `wss://<relay>/v2/rooms/:roomId/socket?device_id=:deviceId`.
///
/// The relay's HTTP base may be `https://…` (production) or `http://…` (local
/// dev / mock servers); we swap the scheme so `https`→`wss` and `http`→`ws`.
/// Anything else is left as-is so a caller can override (e.g. test fixtures
/// that hand in `ws://127.0.0.1:NNNN` directly).
pub(crate) fn build_ws_url(relay_url: &str, room_id: &str, device_id: &str) -> String {
    let trimmed = relay_url.trim_end_matches('/');
    let with_scheme = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_string()
    };
    format!(
        "{with_scheme}/v2/rooms/{room_id}/socket?device_id={device_id}",
        room_id = rfc3986_encode(room_id),
        device_id = rfc3986_encode(device_id),
    )
}

/// Path component used in the admission HMAC. The query string (`device_id=…`)
/// is part of the canonical request so the server can bind the HMAC to the
/// addressed device. We surface it as a separate `query_pairs` arg so the
/// canonicalizer (which sort+encodes) handles the formatting.
pub(crate) fn socket_path(room_id: &str) -> String {
    format!("/v2/rooms/{}/socket", room_id)
}

/// Round-trip a typed id newtype to its inner string. Mirrors the helper in
/// `inbound.rs::id_to_string` — kept private here so the WS module is a
/// self-contained translation unit and doesn't depend on a `pub(super)`
/// leak from the inbound module.
fn id_to_string<T: serde::Serialize>(id: &T) -> String {
    match serde_json::to_value(id).expect("typed id serializes as JSON string") {
        serde_json::Value::String(s) => s,
        other => panic!("typed id must serialize as JSON string, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Connection loop — `run`
// ---------------------------------------------------------------------------

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
use tokio_tungstenite::tungstenite::{self, Message};

/// Close-code constants mirroring `relay/src/room-do.ts`.
mod close_codes {
    pub const NORMAL: u16 = 1000;
    pub const ADMISSION_INVALID: u16 = 4000;
    pub const ROOM_DELETED: u16 = 4001;
    pub const ROOM_EXPIRED: u16 = 4002;
    pub const RATE_LIMIT: u16 = 4003;
    pub const PEER_CAP: u16 = 4004;
    pub const CURSOR_TOO_OLD: u16 = 4005;
}

/// Outcome of a single connect attempt. The caller (`run`) decides whether
/// to reconnect; this enum keeps the loop linear and the close-code mapping
/// explicit in one place.
#[derive(Debug)]
enum ConnectionOutcome {
    /// Server closed the stream with a relay-defined close code we should
    /// surface as a terminal `TransportError`.
    Terminal(TransportError),
    /// Network drop, 1xxx close, or transient I/O. Caller should back off
    /// and reconnect.
    Transient(String),
    /// `cancel` flipped to `true` — caller should exit cleanly without
    /// reconnecting.
    Cancelled,
    /// Server sent an `error { code: ATTN_CURSOR_TOO_OLD, resyncFromSeq }`
    /// frame. We propagate as a typed terminal so the consumer can decide
    /// whether to resync from the supplied floor (cursor management lives
    /// in attn-nnj.6.5).
    CursorTooOld(u64),
}

impl MailboxWsClient {
    /// Drive the connection loop until `cancel` flips to `true` or the relay
    /// hands us a terminal close code.
    ///
    /// The starting `after_seq` is loaded from the persisted `SyncCursor` on
    /// disk (`ReviewStore::load_cursor`) — the caller does NOT pass it in.
    /// The cursor is advanced + flushed to disk on every successful
    /// `InboundPipeline.import_*_envelope`, so a process restart resumes at
    /// the right server_seq without coordination.
    ///
    /// On `ATTN_CURSOR_TOO_OLD` (close 4005) the behavior is governed by
    /// the `CursorRecoveryPolicy`:
    ///   - `ResyncFromOldest` — reset the persisted cursor to `resyncFromSeq`
    ///     and reconnect from there (NOT from 0 — accepts that pre-deleted
    ///     history is gone).
    ///   - `RequestSnapshot` — log "P2P recovery not yet wired" and return
    ///     `TransportError::CursorTooOld`; the orchestrator initiates a
    ///     WebRTC `RequestSnapshot` signal (Phase 4).
    ///   - `Manual` — return `TransportError::CursorTooOld`; the caller
    ///     decides what to do via the emitted `TransportEvent::Error`.
    pub async fn run(
        &self,
        mut cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), TransportError> {
        let after_seq = self.load_after_seq();
        self.run_with_after_seq(after_seq, &mut cancel).await
    }

    /// Internal: drive the loop starting from `after_seq`. Pulled out so
    /// the 4005 → ResyncFromOldest branch can reset the cursor and re-enter
    /// without re-loading from disk (which would just race the
    /// `save_cursor` we just wrote).
    async fn run_with_after_seq(
        &self,
        mut last_seen_seq: u64,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), TransportError> {
        let mut backoff_ms = RECONNECT_INITIAL_MS;

        loop {
            if *cancel.borrow() {
                return Ok(());
            }

            let outcome = self.connect_once(last_seen_seq, cancel, &mut last_seen_seq).await;

            match outcome {
                ConnectionOutcome::Cancelled => return Ok(()),
                ConnectionOutcome::Terminal(err) => {
                    // Surface a Disconnected event so the consumer's UI updates
                    // even when the close was clean. The error itself is the
                    // function-level return value.
                    let _ = self.events_tx.send(TransportEvent::Disconnected {
                        reason: err.to_string(),
                        close_code: terminal_close_code(&err),
                    });
                    return Err(err);
                }
                ConnectionOutcome::CursorTooOld(resync_from_seq) => {
                    let _ = self.events_tx.send(TransportEvent::Disconnected {
                        reason: format!("cursor too old; resync from {resync_from_seq}"),
                        close_code: Some(close_codes::CURSOR_TOO_OLD),
                    });
                    match self.recovery_policy {
                        CursorRecoveryPolicy::ResyncFromOldest => {
                            // Reset the on-disk cursor to the relay's oldest
                            // retained seq and reconnect from there. We
                            // accept that envelopes between the old cursor
                            // and `resyncFromSeq` are permanently gone —
                            // the relay deleted them (owner ACK or expiry).
                            self.save_seq(resync_from_seq);
                            last_seen_seq = resync_from_seq;
                            backoff_ms = RECONNECT_INITIAL_MS;
                            continue;
                        }
                        CursorRecoveryPolicy::RequestSnapshot => {
                            // Phase 4 wires a WebRTC `RequestSnapshot`
                            // signal here. Stub for now — surface the
                            // typed error so the orchestrator can drive
                            // the snapshot dance, then bail out of the
                            // loop. Caller is responsible for calling
                            // `run` again after the snapshot lands.
                            eprintln!(
                                "review: P2P cursor-too-old recovery not yet wired (resync_from_seq={resync_from_seq}); returning to caller"
                            );
                            return Err(TransportError::CursorTooOld(resync_from_seq));
                        }
                        CursorRecoveryPolicy::Manual => {
                            // Caller owns the next step — they saw the
                            // `TransportEvent::Error` (ATTN_CURSOR_TOO_OLD)
                            // emitted by `handle_text_frame` and decide
                            // whether to call `run` again, reset cursor,
                            // or surface the error to the UI.
                            return Err(TransportError::CursorTooOld(resync_from_seq));
                        }
                    }
                }
                ConnectionOutcome::Transient(reason) => {
                    // Emit a Disconnected event for telemetry, then back off
                    // and retry. last_seen_seq has been advanced by
                    // connect_once for any envelopes we acknowledged before
                    // the drop, so the next subscribe resumes at the right
                    // place.
                    let _ = self.events_tx.send(TransportEvent::Disconnected {
                        reason,
                        close_code: None,
                    });
                    if wait_or_cancel(backoff_ms, cancel).await {
                        return Ok(());
                    }
                    backoff_ms = (backoff_ms * 2).min(RECONNECT_MAX_MS);
                    continue;
                }
            }
        }
    }

    /// One connect-subscribe-drain attempt. Returns when the socket closes,
    /// `cancel` flips, or the server hands us a terminal frame. On success
    /// `last_seen_seq` is updated to the highest envelope seq we acked
    /// before the close so the caller's retry resumes at the right cursor.
    async fn connect_once(
        &self,
        after_seq: u64,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
        last_seen_seq: &mut u64,
    ) -> ConnectionOutcome {
        // Build the URL + admission subprotocol header. We construct a Request
        // by hand so we can set `Sec-WebSocket-Protocol` to the canonical
        // "attn.v2, hmac.<base64url>" form. tokio-tungstenite's `connect_async`
        // would otherwise set its own protocol header.
        let device_id_str = id_to_string(&self.config.device_id);
        let path = socket_path(self.config.room_id.as_str());
        let query: Vec<(String, String)> =
            vec![("device_id".to_string(), device_id_str.clone())];
        let subprotocol = build_subprotocol(&self.config.admission_key, "GET", &path, &query);

        let url = build_ws_url(
            &self.config.relay_url,
            self.config.room_id.as_str(),
            &device_id_str,
        );
        let mut request = match url.as_str().into_client_request() {
            Ok(req) => req,
            Err(e) => {
                return ConnectionOutcome::Transient(format!("ws url parse: {e}"));
            }
        };
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            match subprotocol.parse() {
                Ok(v) => v,
                Err(e) => {
                    return ConnectionOutcome::Transient(format!("subprotocol header: {e}"));
                }
            },
        );

        let connect_fut = tokio_tungstenite::connect_async(request);
        let stream = tokio::select! {
            res = connect_fut => res,
            _ = cancel.changed() => return ConnectionOutcome::Cancelled,
        };

        let (ws_stream, _resp) = match stream {
            Ok(pair) => pair,
            Err(e) => {
                // Some handshake failures expose the close-frame inline (the
                // server may close 4000 during the HTTP upgrade if admission
                // fails). We classify those as terminal AdmissionRejected so
                // the caller doesn't reconnect into a guaranteed-failing loop.
                if let tungstenite::Error::Http(resp) = &e {
                    if resp.status().as_u16() == 401 {
                        return ConnectionOutcome::Terminal(TransportError::AdmissionRejected);
                    }
                }
                return ConnectionOutcome::Transient(format!("ws connect: {e}"));
            }
        };

        let (mut sink, mut stream) = ws_stream.split();

        // Send subscribe { after }. Any failure here is a transient drop —
        // the socket is dead and we let the reconnect path handle it.
        let subscribe = match serde_json::to_string(&ClientFrame::Subscribe { after: after_seq }) {
            Ok(s) => s,
            Err(e) => {
                return ConnectionOutcome::Transient(format!("serialize subscribe: {e}"));
            }
        };
        if let Err(e) = sink.send(Message::Text(subscribe.into())).await {
            return ConnectionOutcome::Transient(format!("send subscribe: {e}"));
        }

        // Drain frames until the stream closes, cancel fires, or we observe a
        // terminal close code.
        loop {
            tokio::select! {
                biased;
                _ = cancel.changed() => {
                    let _ = sink.send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Normal,
                        reason: "client cancel".into(),
                    }))).await;
                    return ConnectionOutcome::Cancelled;
                }
                msg = stream.next() => {
                    let Some(msg) = msg else {
                        // Stream ended without an explicit close frame.
                        return ConnectionOutcome::Transient("ws stream ended".into());
                    };
                    let msg = match msg {
                        Ok(m) => m,
                        Err(e) => return ConnectionOutcome::Transient(format!("ws read: {e}")),
                    };
                    match msg {
                        Message::Text(payload) => {
                            if let Some(outcome) = self
                                .handle_text_frame(&payload, &mut sink, last_seen_seq)
                                .await
                            {
                                return outcome;
                            }
                        }
                        Message::Binary(_) => {
                            // Spec: binary frames reserved. Treat as protocol
                            // violation but recoverable — drop, keep going.
                            continue;
                        }
                        Message::Ping(payload) => {
                            // tungstenite handles control frame Pongs
                            // automatically, but we still forward the payload
                            // verbatim per RFC 6455. Failure to send is a
                            // transient drop.
                            if let Err(e) = sink.send(Message::Pong(payload)).await {
                                return ConnectionOutcome::Transient(format!("send pong: {e}"));
                            }
                        }
                        Message::Pong(_) => continue,
                        Message::Frame(_) => continue,
                        Message::Close(close_frame) => {
                            return classify_close(close_frame);
                        }
                    }
                }
            }
        }
    }

    /// Decode one Text frame, route it through the InboundPipeline if it's
    /// an envelope, and emit the matching `TransportEvent`.
    ///
    /// Returns `Some(ConnectionOutcome)` if the frame is terminal (e.g. an
    /// error frame asking us to disconnect); `None` keeps the loop running.
    async fn handle_text_frame(
        &self,
        payload: &str,
        sink: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        last_seen_seq: &mut u64,
    ) -> Option<ConnectionOutcome> {
        let frame: ServerFrame = match serde_json::from_str(payload) {
            Ok(f) => f,
            Err(e) => {
                // Unknown frame shape — surface as a non-fatal error event
                // and keep the connection up. Future schema additions will
                // appear as parse failures here; a forward-compat client
                // doesn't want to flap on every new variant.
                let _ = self.events_tx.send(TransportEvent::Error {
                    code: "ATTN_WS_DECODE".to_string(),
                    message: format!("decode frame: {e}"),
                });
                return None;
            }
        };

        match frame {
            ServerFrame::Hello {
                server_seq,
                policy,
                devices,
                missed_signal_envelope_ids,
            } => {
                let _ = self.events_tx.send(TransportEvent::Hello {
                    server_seq,
                    policy,
                    devices,
                    missed_signal_envelope_ids,
                });
                None
            }
            ServerFrame::Envelope { envelope, server_seq } => {
                let room_id = envelope.room_id.clone();
                let kind = envelope.kind;
                use crate::review::model::EnvelopeKind;
                let import_res: Result<(), crate::review::transport::inbound::InboundError> =
                    match kind {
                        EnvelopeKind::Event => self
                            .inbound
                            .import_event_envelope(&room_id, &envelope)
                            .await
                            .map(|_| ()),
                        EnvelopeKind::SnapshotBlob => self
                            .inbound
                            .import_snapshot_envelope(&room_id, &envelope)
                            .await
                            .map(|_| ()),
                        EnvelopeKind::Signal => self
                            .inbound
                            .import_signal_envelope(&room_id, &envelope)
                            .await
                            .map(|_| ()),
                    };

                match import_res {
                    Ok(()) => {
                        // Advance the cursor only after successful import so a
                        // mid-batch decrypt failure doesn't poison resync. The
                        // consumer's own watermark advances when it observes
                        // the Envelope event.
                        if server_seq > *last_seen_seq {
                            *last_seen_seq = server_seq;
                            // Persist the cursor immediately so a process
                            // restart resumes here (attn-nnj.6.5). We
                            // intentionally do this BEFORE emitting the
                            // Envelope event so a panic in a downstream
                            // consumer can't lose the import.
                            self.save_seq(server_seq);
                        }
                        let _ = self.events_tx.send(TransportEvent::Envelope {
                            envelope,
                            server_seq,
                        });
                    }
                    Err(err) => {
                        // Surface the failure but keep the connection up — a
                        // single bad envelope (unknown signer, tampered MAC)
                        // is a per-envelope concern, not a reason to flap.
                        let _ = self.events_tx.send(TransportEvent::Error {
                            code: "ATTN_INBOUND".to_string(),
                            message: format!("inbound import failed: {err}"),
                        });
                    }
                }
                None
            }
            ServerFrame::Presence {
                event,
                device_id,
                participant_id,
            } => {
                // The wire deviceId/participantId arrive as plain strings; we
                // route through serde to mint the typed newtypes. This keeps
                // the rest of the daemon honest about ids only existing via
                // deserialization (see model.rs::tests for the same pattern).
                let typed_device: Option<crate::review::ids::DeviceId> =
                    serde_json::from_value(serde_json::Value::String(device_id.clone())).ok();
                let Some(typed_device) = typed_device else {
                    let _ = self.events_tx.send(TransportEvent::Error {
                        code: "ATTN_WS_DECODE".to_string(),
                        message: format!("presence: invalid deviceId {device_id}"),
                    });
                    return None;
                };
                let _ = self.events_tx.send(TransportEvent::Presence {
                    event: event.into(),
                    device_id: typed_device,
                    participant_id,
                });
                None
            }
            ServerFrame::PolicyChanged { policy } => {
                let _ = self.events_tx.send(TransportEvent::PolicyChanged { policy });
                None
            }
            ServerFrame::Ping { ts } => {
                // Respond with `pong { ts }` so the server keeps the
                // hibernation alarm reset. Failure to send is a transient
                // drop; surface to the reconnect loop.
                let pong = match serde_json::to_string(&ClientFrame::Pong { ts }) {
                    Ok(s) => s,
                    Err(e) => {
                        return Some(ConnectionOutcome::Transient(format!(
                            "serialize pong: {e}"
                        )));
                    }
                };
                if let Err(e) = sink.send(Message::Text(pong.into())).await {
                    return Some(ConnectionOutcome::Transient(format!("send pong: {e}")));
                }
                None
            }
            ServerFrame::Error {
                code,
                message,
                resync_from_seq,
            } => {
                // Surface the error for telemetry whether or not it's terminal.
                let _ = self.events_tx.send(TransportEvent::Error {
                    code: code.clone(),
                    message: message.clone(),
                });
                if code == "ATTN_CURSOR_TOO_OLD" {
                    // Per spec the server follows with close 4005; we don't
                    // wait — we initiate the disconnect ourselves so the
                    // outer loop maps to TransportError::CursorTooOld
                    // immediately. Best-effort close frame; ignore errors.
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code: CloseCode::from(close_codes::CURSOR_TOO_OLD),
                            reason: "cursor too old".into(),
                        })))
                        .await;
                    return Some(ConnectionOutcome::CursorTooOld(
                        resync_from_seq.unwrap_or(0),
                    ));
                }
                None
            }
        }
    }
}

/// Map a close frame to a `ConnectionOutcome`. Codes 4000/4001/4002/4005 are
/// terminal per relay-spec.md §Close Codes; 1xxx and the rest are transient.
fn classify_close(close_frame: Option<CloseFrame>) -> ConnectionOutcome {
    let Some(cf) = close_frame else {
        return ConnectionOutcome::Transient("ws closed without frame".into());
    };
    let code: u16 = cf.code.into();
    match code {
        close_codes::ADMISSION_INVALID => {
            ConnectionOutcome::Terminal(TransportError::AdmissionRejected)
        }
        close_codes::ROOM_DELETED => ConnectionOutcome::Terminal(TransportError::RoomDeleted),
        close_codes::ROOM_EXPIRED => ConnectionOutcome::Terminal(TransportError::RoomExpired),
        close_codes::CURSOR_TOO_OLD => {
            // We should only see 4005 *after* an error frame already classified
            // this as CursorTooOld; if not, surface the resync floor as 0.
            ConnectionOutcome::CursorTooOld(0)
        }
        close_codes::NORMAL => ConnectionOutcome::Transient(format!(
            "ws closed normally: {}",
            cf.reason
        )),
        close_codes::RATE_LIMIT => {
            ConnectionOutcome::Transient(format!("ws rate-limited: {}", cf.reason))
        }
        close_codes::PEER_CAP => {
            ConnectionOutcome::Transient(format!("ws peer cap reached: {}", cf.reason))
        }
        other => {
            ConnectionOutcome::Transient(format!("ws closed with code {other}: {}", cf.reason))
        }
    }
}

/// Map a terminal `TransportError` back to the relay-defined close code, used
/// to populate `TransportEvent::Disconnected.close_code`.
fn terminal_close_code(err: &TransportError) -> Option<u16> {
    match err {
        TransportError::AdmissionRejected => Some(close_codes::ADMISSION_INVALID),
        TransportError::RoomDeleted => Some(close_codes::ROOM_DELETED),
        TransportError::RoomExpired => Some(close_codes::ROOM_EXPIRED),
        TransportError::CursorTooOld(_) => Some(close_codes::CURSOR_TOO_OLD),
        _ => None,
    }
}

/// Sleep for `delay_ms` milliseconds OR until `cancel` flips to true.
/// Identical shape to the helper in `mod.rs::wait_or_cancel` — duplicated
/// here so this module does not depend on a `pub(super)` leak.
async fn wait_or_cancel(delay_ms: u64, cancel: &mut tokio::sync::watch::Receiver<bool>) -> bool {
    if *cancel.borrow() {
        return true;
    }
    let sleep = tokio::time::sleep(Duration::from_millis(delay_ms));
    tokio::select! {
        _ = sleep => false,
        res = cancel.changed() => res.is_err() || *cancel.borrow(),
    }
}

// ---------------------------------------------------------------------------
// Tests — drive the client against an in-process tokio-tungstenite server.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::crypto::kdf::derive_room_keys;
    use crate::review::crypto::signing::{DeviceSigningKey, DeviceVerifyingKey};
    use crate::review::ids::{DeviceId, RoomId};
    use crate::review::model::EnvelopeKind;
    use crate::review::store::ReviewStore;
    use crate::review::transport::inbound::{InboundPipeline, VerifyingKeyCache};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use futures_util::{SinkExt, StreamExt};
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::net::TcpListener;
    use tokio::sync::{RwLock, mpsc, watch};

    const TEST_ROOM: &str = "hjCfgOvsatNOUedgxhZpyw";
    const TEST_DEVICE: &str = "d-device-01";
    const TEST_ROOM_SECRET: [u8; 32] = [0x11u8; 32];
    const TEST_SIGNING_SEED: [u8; 32] = [0x22u8; 32];

    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("typed id deserializes")
    }

    fn fresh_store() -> (TempDir, Arc<ReviewStore>) {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"),
        );
        (tmp, store)
    }

    /// Build an `InboundPipeline` pre-loaded with the deterministic test
    /// signer so event envelopes encrypted+signed in the test mint with
    /// `TEST_SIGNING_SEED` round-trip cleanly.
    fn fresh_pipeline()
    -> (Arc<InboundPipeline>, Arc<ReviewStore>, DeviceVerifyingKey, TempDir) {
        let (tmp, store) = fresh_store();
        let keys = derive_room_keys(&TEST_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let snapshot_key = *keys.snapshot_key.as_bytes();
        let signaling_key = *keys.signaling_key.as_bytes();

        let signer = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let vk = signer.verifying_key();
        let keyid = vk.signing_key_id_base64url();
        let mut map: HashMap<String, DeviceVerifyingKey> = HashMap::new();
        map.insert(keyid, vk.clone());
        let cache: VerifyingKeyCache = Arc::new(RwLock::new(map));

        let pipeline = Arc::new(InboundPipeline::new(
            store.clone(),
            cache,
            event_key,
            snapshot_key,
            signaling_key,
        ));
        (pipeline, store, vk, tmp)
    }

    fn mint_event_envelope(event_key: [u8; 32], room_id: &RoomId) -> MailboxEnvelope {
        use crate::review::envelope::{AssembleInput, assemble_event_envelope};
        use crate::review::ids::{ContentHash, FileId, ParticipantId, SnapshotId};
        use crate::review::model::{Anchor, PositionAnchor, ReviewEventBody};

        let signer = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
        let input = AssembleInput {
            event_key,
            signing_key: signer,
            room_id: room_id.clone(),
            author_id: id::<ParticipantId>("p-author-01"),
            device_id: id::<DeviceId>("d-device-01"),
            created_at_ms: 1_700_000_000_000,
            expires_at_ms: 1_700_000_000_000 + 7 * 24 * 60 * 60 * 1000,
            parent_event_ids: vec![],
            snapshot_id: None,
            body: ReviewEventBody::CommentCreated {
                thread_id: "thread-1".to_string(),
                anchor: Anchor {
                    v: 2,
                    file_id: id::<FileId>("f-file-01"),
                    snapshot_id: id::<SnapshotId>("eQ7pDCC-mekpz-we7gDYag"),
                    base_hash: id::<ContentHash>(
                        "fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y",
                    ),
                    position: PositionAnchor {
                        byte_range: [0, 9],
                        line_range: [1, 1],
                        pm_range: None,
                    },
                    quote: None,
                    block: None,
                    context: None,
                    structure: None,
                },
                body: "hello".to_string(),
            },
            kind: EnvelopeKind::Event,
            client_nonce: None,
        };
        assemble_event_envelope(input).expect("assemble envelope")
    }

    fn sample_policy() -> Value {
        json!({
            "mode": "async",
            "maxPeers": 8,
            "maxSnapshotBytes": 5_242_880,
            "maxEventBytes": 262_144,
            "maxEvents": 500,
            "expiresAt": 1_700_000_000_000u64,
            "deleteEventsAfterOwnerAck": false,
            "allowBrowser": false,
            "allowRemoteAgents": false,
        })
    }

    /// Spin up a tokio-tungstenite server bound to 127.0.0.1:0. The handler
    /// closure is called with the upgraded WS stream and a 1-based connection
    /// number once per incoming connection. Returns `(http_base_url, join)` —
    /// the test calls `join.abort()` to stop accepting.
    ///
    /// The server negotiates the `attn.v2` subprotocol by echoing it back in
    /// the upgrade response. Without this, tungstenite's client treats the
    /// missing `Sec-WebSocket-Protocol` echo as a protocol violation and
    /// closes the socket immediately — which is why we route through
    /// `accept_hdr_async` instead of plain `accept_async`.
    async fn spawn_ws_server<F, Fut>(
        handler: F,
    ) -> (String, tokio::task::JoinHandle<()>)
    where
        F: Fn(
            tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
            usize,
        ) -> Fut
            + Send
            + Sync
            + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        use tokio_tungstenite::tungstenite::handshake::server::{
            ErrorResponse, Request, Response,
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let http_url = format!("http://{}", addr);

        let handler = Arc::new(handler);
        let handle = tokio::spawn(async move {
            let mut accept_count: usize = 0;
            loop {
                let (stream, _peer) = match listener.accept().await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                accept_count += 1;
                let n = accept_count;
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let callback = |req: &Request, mut resp: Response| -> Result<
                        Response,
                        ErrorResponse,
                    > {
                        // Echo back the canonical `attn.v2` subprotocol if the
                        // client offered it. Skipping the echo would have
                        // tungstenite close on the client side.
                        if let Some(proto_hdr) =
                            req.headers().get("Sec-WebSocket-Protocol")
                        {
                            if let Ok(proto_str) = proto_hdr.to_str() {
                                if proto_str
                                    .split(',')
                                    .any(|t| t.trim() == "attn.v2")
                                {
                                    resp.headers_mut().insert(
                                        "Sec-WebSocket-Protocol",
                                        "attn.v2".parse().unwrap(),
                                    );
                                }
                            }
                        }
                        Ok(resp)
                    };
                    let ws =
                        match tokio_tungstenite::accept_hdr_async(stream, callback).await {
                            Ok(ws) => ws,
                            Err(_) => return,
                        };
                    handler(ws, n).await;
                });
            }
        });
        (http_url, handle)
    }

    fn build_client(
        relay_url: String,
        pipeline: Arc<InboundPipeline>,
        store: Arc<ReviewStore>,
        events_tx: mpsc::UnboundedSender<TransportEvent>,
    ) -> MailboxWsClient {
        let cfg = Arc::new(MailboxConfig {
            relay_url,
            room_id: id::<RoomId>(TEST_ROOM),
            device_id: id::<DeviceId>(TEST_DEVICE),
            admission_key: [0x42u8; 32],
            pow_difficulty: 12,
        });
        MailboxWsClient::new(cfg, pipeline, store, events_tx)
    }

    fn build_client_with_policy(
        relay_url: String,
        pipeline: Arc<InboundPipeline>,
        store: Arc<ReviewStore>,
        events_tx: mpsc::UnboundedSender<TransportEvent>,
        policy: CursorRecoveryPolicy,
    ) -> MailboxWsClient {
        build_client(relay_url, pipeline, store, events_tx).with_recovery_policy(policy)
    }

    // ----------------------------------------------------------------
    // Test 1: subprotocol + URL builder produce the spec-shaped tokens.
    // ----------------------------------------------------------------

    #[test]
    fn subprotocol_starts_with_attn_v2_and_includes_base64url_hmac() {
        let header = build_subprotocol(
            &[0x42u8; 32],
            "GET",
            "/v2/rooms/room-1/socket",
            &[("device_id".to_string(), "d-1".to_string())],
        );
        assert!(header.starts_with("attn.v2, hmac."), "got: {header}");
        let tail = header.trim_start_matches("attn.v2, hmac.");
        let decoded = URL_SAFE_NO_PAD.decode(tail).expect("base64url");
        assert_eq!(decoded.len(), 32, "HMAC-SHA-256 produces 32 bytes");
    }

    #[test]
    fn ws_url_swaps_https_to_wss_and_includes_device_id_query() {
        let url = build_ws_url("https://relay.example", "room-1", "d-1");
        assert_eq!(url, "wss://relay.example/v2/rooms/room-1/socket?device_id=d-1");

        let url2 = build_ws_url("http://127.0.0.1:8787/", "room-1", "d-1");
        assert_eq!(url2, "ws://127.0.0.1:8787/v2/rooms/room-1/socket?device_id=d-1");
    }

    // ----------------------------------------------------------------
    // Test 2: happy connect → hello + 3 envelopes → import_event called.
    // ----------------------------------------------------------------

    #[tokio::test]
    async fn happy_path_hello_then_three_envelopes_imports_each() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let event_key = {
            let keys = derive_room_keys(&TEST_ROOM_SECRET);
            *keys.event_key.as_bytes()
        };
        let room_id: RoomId = id(TEST_ROOM);

        // Mint three distinct envelopes (differ by client_nonce via createdAt
        // would normally vary — here we just mint with different body
        // ciphertexts by perturbing the seed envelope's ciphertext bytes...
        // actually simpler: mint once but bump server_seq to 1/2/3). For the
        // store to consider them distinct EventIds we need different
        // assemble inputs — easiest is to vary the thread body slightly.
        let mut envelopes: Vec<MailboxEnvelope> = Vec::new();
        for i in 0..3 {
            use crate::review::envelope::{AssembleInput, assemble_event_envelope};
            use crate::review::ids::{ContentHash, FileId, ParticipantId, SnapshotId};
            use crate::review::model::{Anchor, PositionAnchor, ReviewEventBody};
            let signer = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
            let env = assemble_event_envelope(AssembleInput {
                event_key,
                signing_key: signer,
                room_id: room_id.clone(),
                author_id: id::<ParticipantId>("p-author-01"),
                device_id: id::<DeviceId>(TEST_DEVICE),
                created_at_ms: 1_700_000_000_000 + i as u64,
                expires_at_ms: 1_700_000_000_000 + 7 * 24 * 60 * 60 * 1000,
                parent_event_ids: vec![],
                snapshot_id: None,
                body: ReviewEventBody::CommentCreated {
                    thread_id: format!("thread-{i}"),
                    anchor: Anchor {
                        v: 2,
                        file_id: id::<FileId>("f-file-01"),
                        snapshot_id: id::<SnapshotId>("eQ7pDCC-mekpz-we7gDYag"),
                        base_hash: id::<ContentHash>(
                            "fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y",
                        ),
                        position: PositionAnchor {
                            byte_range: [0, 9],
                            line_range: [1, 1],
                            pm_range: None,
                        },
                        quote: None,
                        block: None,
                        context: None,
                        structure: None,
                    },
                    body: format!("hello {i}"),
                },
                kind: EnvelopeKind::Event,
                client_nonce: None,
            })
            .expect("assemble envelope");
            envelopes.push(env);
        }

        // Server: send hello, then 3 envelope frames, then close 1000.
        let envelopes_for_server = envelopes.clone();
        let (relay_url, server_handle) =
            spawn_ws_server(move |mut ws, _n| {
                let envelopes_for_server = envelopes_for_server.clone();
                async move {
                    // Drain the client's subscribe frame.
                    let _ = ws.next().await;
                    let hello = json!({
                        "type": "hello",
                        "serverSeq": 100u64,
                        "policy": sample_policy(),
                        "devices": [],
                        "missedSignalEnvelopeIds": [],
                    });
                    ws.send(Message::Text(hello.to_string().into())).await.unwrap();
                    for (i, env) in envelopes_for_server.iter().enumerate() {
                        let frame = json!({
                            "type": "envelope",
                            "envelope": env,
                            "serverSeq": 101 + i as u64,
                        });
                        ws.send(Message::Text(frame.to_string().into())).await.unwrap();
                    }
                    // Close normally — triggers Transient + reconnect loop.
                    let _ = ws
                        .send(Message::Close(Some(CloseFrame {
                            code: CloseCode::Normal,
                            reason: "done".into(),
                        })))
                        .await;
                }
            })
            .await;

        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline.clone(), store.clone(), events_tx);
        let (cancel_tx, cancel_rx) = watch::channel(false);

        let run_handle = tokio::spawn(async move {
            let _ = client.run(cancel_rx).await;
        });

        // Collect events with a timeout so a missing frame doesn't hang the
        // test indefinitely.
        let mut hello_seen = false;
        let mut envelope_count = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && envelope_count < 3 {
            let timeout = deadline - tokio::time::Instant::now();
            match tokio::time::timeout(timeout, events_rx.recv()).await {
                Ok(Some(TransportEvent::Hello { server_seq, .. })) => {
                    assert_eq!(server_seq, 100);
                    hello_seen = true;
                }
                Ok(Some(TransportEvent::Envelope { server_seq, .. })) => {
                    assert!(server_seq >= 101 && server_seq <= 103);
                    envelope_count += 1;
                }
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(_) => break,
            }
        }
        assert!(hello_seen, "Hello event must be emitted");
        assert_eq!(envelope_count, 3, "all 3 envelopes must be routed");

        // Verify the store actually got the appends — proves the inbound
        // pipeline was driven, not just that the events surfaced.
        let on_disk_events: Vec<_> = store
            .iter_events(&room_id)
            .expect("iter")
            .collect::<anyhow::Result<Vec<_>>>()
            .expect("decode");
        assert_eq!(on_disk_events.len(), 3, "InboundPipeline must have imported 3 events");

        // Cancel the run loop and wait for a clean exit.
        let _ = cancel_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), run_handle).await;
        server_handle.abort();
    }

    // ----------------------------------------------------------------
    // Test 3: ATTN_CURSOR_TOO_OLD error frame → TransportError::CursorTooOld.
    // ----------------------------------------------------------------

    #[tokio::test]
    async fn cursor_too_old_error_frame_surfaces_as_terminal_error() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        // Seed a cursor at 5 so the relay's response of "cursor too old,
        // resync from 42" represents the realistic mid-life scenario.
        let room_id: RoomId = id(TEST_ROOM);
        store
            .save_cursor(
                &room_id,
                &SyncCursor {
                    room_id: room_id.clone(),
                    device_id: id::<DeviceId>(TEST_DEVICE),
                    last_pulled_seq: 5,
                    imported_event_ids: vec![],
                    pending_outbound_envelope_ids: vec![],
                },
            )
            .expect("save_cursor");

        let (relay_url, server_handle) = spawn_ws_server(|mut ws, _n| async move {
            let _ = ws.next().await; // subscribe
            let err = json!({
                "type": "error",
                "code": "ATTN_CURSOR_TOO_OLD",
                "message": "cursor 5 < oldest_retained_seq 42",
                "resyncFromSeq": 42u64,
            });
            ws.send(Message::Text(err.to_string().into())).await.unwrap();
            // Server would close 4005 after — but the client initiates the
            // close itself on the error frame, so we just hold the socket.
            let _ = ws.next().await;
        })
        .await;

        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        // Manual policy so we observe the terminal error path without the
        // ResyncFromOldest auto-reconnect kicking in.
        let client = build_client_with_policy(
            relay_url,
            pipeline,
            store,
            events_tx,
            CursorRecoveryPolicy::Manual,
        );
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let run_res =
            tokio::time::timeout(Duration::from_secs(3), client.run(cancel_rx)).await;
        let err = match run_res {
            Ok(Err(e)) => e,
            Ok(Ok(())) => panic!("expected CursorTooOld error, got Ok"),
            Err(_) => panic!("client.run did not return in time"),
        };
        match err {
            TransportError::CursorTooOld(seq) => assert_eq!(seq, 42),
            other => panic!("expected CursorTooOld(42), got {other:?}"),
        }

        // The events channel must have emitted Error then Disconnected.
        let mut saw_error_event = false;
        let mut saw_disconnect = false;
        while let Ok(Some(ev)) =
            tokio::time::timeout(Duration::from_millis(50), events_rx.recv()).await
        {
            match ev {
                TransportEvent::Error { code, .. } => {
                    if code == "ATTN_CURSOR_TOO_OLD" {
                        saw_error_event = true;
                    }
                }
                TransportEvent::Disconnected { close_code, .. } => {
                    if close_code == Some(close_codes::CURSOR_TOO_OLD) {
                        saw_disconnect = true;
                    }
                }
                _ => {}
            }
        }
        assert!(saw_error_event, "Error event must be emitted for ATTN_CURSOR_TOO_OLD");
        assert!(saw_disconnect, "Disconnected event must carry close code 4005");
        server_handle.abort();
    }

    // ----------------------------------------------------------------
    // Test 4: close 4000 → AdmissionRejected, no reconnect attempted.
    // ----------------------------------------------------------------

    #[tokio::test]
    async fn close_4000_surfaces_admission_rejected_without_reconnect() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let connect_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let count_for_server = Arc::clone(&connect_count);
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, _n| {
            let count_for_server = Arc::clone(&count_for_server);
            async move {
                count_for_server.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = ws.next().await; // subscribe
                let _ = ws
                    .send(Message::Close(Some(CloseFrame {
                        code: CloseCode::from(4000),
                        reason: "admission invalid".into(),
                    })))
                    .await;
            }
        })
        .await;

        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline, store, events_tx);
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let res = tokio::time::timeout(Duration::from_secs(3), client.run(cancel_rx)).await;
        match res {
            Ok(Err(TransportError::AdmissionRejected)) => {}
            other => panic!("expected AdmissionRejected, got {other:?}"),
        }
        // The terminal close path returns immediately — only one accept.
        assert_eq!(
            connect_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "AdmissionRejected must not trigger reconnect"
        );
        server_handle.abort();
    }

    // ----------------------------------------------------------------
    // Test 5: network drop (server closes 1000) → reconnect with subscribe.
    // ----------------------------------------------------------------

    #[tokio::test]
    async fn network_drop_triggers_reconnect_with_resumed_subscribe() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let connect_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let last_subscribe_after = Arc::new(tokio::sync::Mutex::new(Vec::<u64>::new()));

        let count_for_server = Arc::clone(&connect_count);
        let after_for_server = Arc::clone(&last_subscribe_after);
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, n| {
            let count_for_server = Arc::clone(&count_for_server);
            let after_for_server = Arc::clone(&after_for_server);
            async move {
                count_for_server.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if let Some(Ok(Message::Text(payload))) = ws.next().await {
                    let v: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                    if let Some(after) = v.get("after").and_then(Value::as_u64) {
                        after_for_server.lock().await.push(after);
                    }
                }
                // First connection: send hello, then close normally.
                // Second connection: send hello again and hold the socket.
                let hello = json!({
                    "type": "hello",
                    "serverSeq": 0u64,
                    "policy": sample_policy(),
                    "devices": [],
                    "missedSignalEnvelopeIds": [],
                });
                ws.send(Message::Text(hello.to_string().into())).await.unwrap();
                if n == 1 {
                    let _ = ws
                        .send(Message::Close(Some(CloseFrame {
                            code: CloseCode::Normal,
                            reason: "drop".into(),
                        })))
                        .await;
                } else {
                    // Hold until the client cancels.
                    let _ = ws.next().await;
                }
            }
        })
        .await;

        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline, store, events_tx);
        let (cancel_tx, cancel_rx) = watch::channel(false);

        // Speed up the first reconnect by overriding the initial backoff via
        // a quick spawn: we rely on RECONNECT_INITIAL_MS = 1000 being short
        // enough that two hello frames arrive inside the 5s test window.
        let run_handle = tokio::spawn(async move {
            let _ = client.run(cancel_rx).await;
        });

        let mut hello_count = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        while tokio::time::Instant::now() < deadline && hello_count < 2 {
            let timeout = deadline - tokio::time::Instant::now();
            match tokio::time::timeout(timeout, events_rx.recv()).await {
                Ok(Some(TransportEvent::Hello { .. })) => hello_count += 1,
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
        assert_eq!(hello_count, 2, "client must reconnect after server-initiated 1000 close");

        let _ = cancel_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), run_handle).await;
        server_handle.abort();

        let connects = connect_count.load(std::sync::atomic::Ordering::SeqCst);
        assert!(connects >= 2, "expected at least 2 connect attempts, got {connects}");

        let after_seqs = last_subscribe_after.lock().await.clone();
        assert!(after_seqs.len() >= 2, "expected ≥2 subscribe frames, got {after_seqs:?}");
        // First subscribe is `after: 0`. Subsequent reconnect after a hello
        // with serverSeq=0 and no envelopes must still send `after: 0` (no
        // envelopes acked → cursor doesn't advance).
        assert_eq!(after_seqs[0], 0);
        assert_eq!(after_seqs[1], 0);
    }

    // ----------------------------------------------------------------
    // Test 6: cancel → clean disconnect via 1000.
    // ----------------------------------------------------------------

    #[tokio::test]
    async fn cancel_during_idle_closes_cleanly() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();

        let (relay_url, server_handle) = spawn_ws_server(|mut ws, _n| async move {
            let _ = ws.next().await; // subscribe
            let hello = json!({
                "type": "hello",
                "serverSeq": 0u64,
                "policy": sample_policy(),
                "devices": [],
                "missedSignalEnvelopeIds": [],
            });
            ws.send(Message::Text(hello.to_string().into())).await.unwrap();
            // Hold the socket; await client close.
            while let Some(Ok(msg)) = ws.next().await {
                if matches!(msg, Message::Close(_)) {
                    break;
                }
            }
        })
        .await;

        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline, store, events_tx);
        let (cancel_tx, cancel_rx) = watch::channel(false);

        let run_handle = tokio::spawn(async move { client.run(cancel_rx).await });

        // Wait for hello, then cancel.
        let mut got_hello = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && !got_hello {
            let timeout = deadline - tokio::time::Instant::now();
            match tokio::time::timeout(timeout, events_rx.recv()).await {
                Ok(Some(TransportEvent::Hello { .. })) => got_hello = true,
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
        assert!(got_hello, "must receive hello before cancelling");

        let _ = cancel_tx.send(true);
        let res = tokio::time::timeout(Duration::from_secs(3), run_handle).await;
        match res {
            Ok(Ok(Ok(()))) => {}
            other => panic!("expected clean Ok(()) exit on cancel, got {other:?}"),
        }
        server_handle.abort();
    }

    // ----------------------------------------------------------------
    // Test 7: ping → pong reply with matching ts.
    // ----------------------------------------------------------------

    #[tokio::test]
    async fn ping_frame_is_answered_with_pong_carrying_same_ts() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let observed_pong_ts = Arc::new(tokio::sync::Mutex::new(None::<i64>));

        let observed_for_server = Arc::clone(&observed_pong_ts);
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, _n| {
            let observed_for_server = Arc::clone(&observed_for_server);
            async move {
                let _ = ws.next().await; // subscribe
                let hello = json!({
                    "type": "hello",
                    "serverSeq": 0u64,
                    "policy": sample_policy(),
                    "devices": [],
                    "missedSignalEnvelopeIds": [],
                });
                ws.send(Message::Text(hello.to_string().into())).await.unwrap();

                // Send a ping with a recognizable ts.
                let ping = json!({ "type": "ping", "ts": 12345i64 });
                ws.send(Message::Text(ping.to_string().into())).await.unwrap();

                // Read the next frame; expect a pong with the same ts.
                if let Some(Ok(Message::Text(payload))) = ws.next().await {
                    let v: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                    if v.get("type").and_then(Value::as_str) == Some("pong") {
                        let ts = v.get("ts").and_then(Value::as_i64);
                        *observed_for_server.lock().await = ts;
                    }
                }

                // Close normally.
                let _ = ws
                    .send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Normal,
                        reason: "done".into(),
                    })))
                    .await;
            }
        })
        .await;

        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline, store, events_tx);
        let (cancel_tx, cancel_rx) = watch::channel(false);

        let run_handle = tokio::spawn(async move { client.run(cancel_rx).await });

        // Poll the observed ts; the server captures it inside its handler.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut found = None;
        while tokio::time::Instant::now() < deadline {
            if let Some(ts) = *observed_pong_ts.lock().await {
                found = Some(ts);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(found, Some(12345i64), "client must answer ping with pong ts=12345");

        let _ = cancel_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), run_handle).await;
        server_handle.abort();
    }

    // ----------------------------------------------------------------
    // attn-nnj.6.5 — cursor persistence + 4005 recovery
    // ----------------------------------------------------------------

    /// Mint `count` distinct event envelopes that the test pipeline can
    /// successfully import (same signer / room_id as `fresh_pipeline`).
    fn mint_event_envelopes(event_key: [u8; 32], room_id: &RoomId, count: usize) -> Vec<MailboxEnvelope> {
        use crate::review::envelope::{AssembleInput, assemble_event_envelope};
        use crate::review::ids::{ContentHash, FileId, ParticipantId, SnapshotId};
        use crate::review::model::{Anchor, PositionAnchor, ReviewEventBody};
        let mut envelopes = Vec::with_capacity(count);
        for i in 0..count {
            let signer = DeviceSigningKey::from_bytes(&TEST_SIGNING_SEED).unwrap();
            let env = assemble_event_envelope(AssembleInput {
                event_key,
                signing_key: signer,
                room_id: room_id.clone(),
                author_id: id::<ParticipantId>("p-author-01"),
                device_id: id::<DeviceId>(TEST_DEVICE),
                created_at_ms: 1_700_000_000_000 + i as u64,
                expires_at_ms: 1_700_000_000_000 + 7 * 24 * 60 * 60 * 1000,
                parent_event_ids: vec![],
                snapshot_id: None,
                body: ReviewEventBody::CommentCreated {
                    thread_id: format!("cursor-thread-{i}"),
                    anchor: Anchor {
                        v: 2,
                        file_id: id::<FileId>("f-file-01"),
                        snapshot_id: id::<SnapshotId>("eQ7pDCC-mekpz-we7gDYag"),
                        base_hash: id::<ContentHash>(
                            "fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y",
                        ),
                        position: PositionAnchor {
                            byte_range: [0, 9],
                            line_range: [1, 1],
                            pm_range: None,
                        },
                        quote: None,
                        block: None,
                        context: None,
                        structure: None,
                    },
                    body: format!("cursor-body-{i}"),
                },
                kind: EnvelopeKind::Event,
                client_nonce: None,
            })
            .expect("assemble envelope");
            envelopes.push(env);
        }
        envelopes
    }

    /// Test 8: cursor persists after import — importing 3 envelopes leaves
    /// the store at `last_pulled_seq = 3` (the highest serverSeq the relay
    /// stamped on the run).
    #[tokio::test]
    async fn cursor_persists_after_each_successful_import() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let event_key = {
            let keys = derive_room_keys(&TEST_ROOM_SECRET);
            *keys.event_key.as_bytes()
        };
        let room_id: RoomId = id(TEST_ROOM);
        let envelopes = mint_event_envelopes(event_key, &room_id, 3);

        let envelopes_for_server = envelopes.clone();
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, _n| {
            let envelopes_for_server = envelopes_for_server.clone();
            async move {
                let _ = ws.next().await; // subscribe
                let hello = json!({
                    "type": "hello",
                    "serverSeq": 0u64,
                    "policy": sample_policy(),
                    "devices": [],
                    "missedSignalEnvelopeIds": [],
                });
                ws.send(Message::Text(hello.to_string().into())).await.unwrap();
                for (i, env) in envelopes_for_server.iter().enumerate() {
                    let frame = json!({
                        "type": "envelope",
                        "envelope": env,
                        // serverSeq starts at 1; after 3 imports the cursor
                        // must land on 3 (the highest stamped seq).
                        "serverSeq": 1 + i as u64,
                    });
                    ws.send(Message::Text(frame.to_string().into())).await.unwrap();
                }
                // Hold the socket; the test cancels.
                let _ = ws.next().await;
            }
        })
        .await;

        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline, store.clone(), events_tx);
        let (cancel_tx, cancel_rx) = watch::channel(false);

        let run_handle = tokio::spawn(async move { let _ = client.run(cancel_rx).await; });

        // Drain envelopes until we've seen all 3.
        let mut envelope_count = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && envelope_count < 3 {
            let timeout = deadline - tokio::time::Instant::now();
            match tokio::time::timeout(timeout, events_rx.recv()).await {
                Ok(Some(TransportEvent::Envelope { .. })) => envelope_count += 1,
                Ok(Some(_)) => continue,
                _ => break,
            }
        }
        assert_eq!(envelope_count, 3, "all 3 envelopes must be routed");

        // Cursor must now be persisted at serverSeq=3.
        let cursor = store
            .load_cursor(&room_id)
            .expect("load_cursor")
            .expect("cursor must exist after imports");
        assert_eq!(
            cursor.last_pulled_seq, 3,
            "last_pulled_seq must equal the highest imported serverSeq"
        );
        assert_eq!(cursor.room_id, room_id);
        assert_eq!(cursor.device_id, id::<DeviceId>(TEST_DEVICE));

        let _ = cancel_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), run_handle).await;
        server_handle.abort();
    }

    /// Test 9: cursor reloaded on reconnect — a second client built against
    /// the same store + room starts its subscribe at `after=3` after the
    /// first run persisted the cursor.
    #[tokio::test]
    async fn cursor_reloaded_on_reconnect_seeds_subscribe_after_seq() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let room_id: RoomId = id(TEST_ROOM);
        // Pre-seed the cursor at 3 to simulate a prior session.
        store
            .save_cursor(
                &room_id,
                &SyncCursor {
                    room_id: room_id.clone(),
                    device_id: id::<DeviceId>(TEST_DEVICE),
                    last_pulled_seq: 3,
                    imported_event_ids: vec![],
                    pending_outbound_envelope_ids: vec![],
                },
            )
            .expect("save_cursor");

        let observed_after = Arc::new(tokio::sync::Mutex::new(None::<u64>));
        let observed_for_server = Arc::clone(&observed_after);
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, _n| {
            let observed_for_server = Arc::clone(&observed_for_server);
            async move {
                if let Some(Ok(Message::Text(payload))) = ws.next().await {
                    let v: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                    if let Some(after) = v.get("after").and_then(Value::as_u64) {
                        *observed_for_server.lock().await = Some(after);
                    }
                }
                let hello = json!({
                    "type": "hello",
                    "serverSeq": 3u64,
                    "policy": sample_policy(),
                    "devices": [],
                    "missedSignalEnvelopeIds": [],
                });
                ws.send(Message::Text(hello.to_string().into())).await.unwrap();
                let _ = ws.next().await;
            }
        })
        .await;

        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline, store, events_tx);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let run_handle = tokio::spawn(async move { let _ = client.run(cancel_rx).await; });

        // Poll for the captured `after` value.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut got: Option<u64> = None;
        while tokio::time::Instant::now() < deadline {
            if let Some(after) = *observed_after.lock().await {
                got = Some(after);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(
            got,
            Some(3u64),
            "client must subscribe with after=3 when store cursor is at 3"
        );

        let _ = cancel_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), run_handle).await;
        server_handle.abort();
    }

    /// Test 10: 4005 with ResyncFromOldest policy resets the cursor to
    /// `resyncFromSeq` and reconnects from there (NOT from 0).
    #[tokio::test]
    async fn cursor_too_old_with_resync_policy_resets_and_reconnects() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let room_id: RoomId = id(TEST_ROOM);

        // Pre-seed cursor at 5 (will be rejected by relay as too old).
        store
            .save_cursor(
                &room_id,
                &SyncCursor {
                    room_id: room_id.clone(),
                    device_id: id::<DeviceId>(TEST_DEVICE),
                    last_pulled_seq: 5,
                    imported_event_ids: vec![],
                    pending_outbound_envelope_ids: vec![],
                },
            )
            .expect("save_cursor");

        let captured_after = Arc::new(tokio::sync::Mutex::new(Vec::<u64>::new()));
        let captured_for_server = Arc::clone(&captured_after);
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, n| {
            let captured_for_server = Arc::clone(&captured_for_server);
            async move {
                if let Some(Ok(Message::Text(payload))) = ws.next().await {
                    let v: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                    if let Some(after) = v.get("after").and_then(Value::as_u64) {
                        captured_for_server.lock().await.push(after);
                    }
                }
                if n == 1 {
                    // First connect: reject with cursor-too-old, resync from 42.
                    let err = json!({
                        "type": "error",
                        "code": "ATTN_CURSOR_TOO_OLD",
                        "message": "cursor 5 < oldest 42",
                        "resyncFromSeq": 42u64,
                    });
                    ws.send(Message::Text(err.to_string().into())).await.unwrap();
                    let _ = ws.next().await; // wait for client close
                } else {
                    // Reconnect: send hello and hold.
                    let hello = json!({
                        "type": "hello",
                        "serverSeq": 42u64,
                        "policy": sample_policy(),
                        "devices": [],
                        "missedSignalEnvelopeIds": [],
                    });
                    ws.send(Message::Text(hello.to_string().into())).await.unwrap();
                    let _ = ws.next().await;
                }
            }
        })
        .await;

        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = build_client_with_policy(
            relay_url,
            pipeline,
            store.clone(),
            events_tx,
            CursorRecoveryPolicy::ResyncFromOldest,
        );
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let run_handle = tokio::spawn(async move { let _ = client.run(cancel_rx).await; });

        // Wait for the second hello (proving the auto-reconnect happened).
        let mut hello_count = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        while tokio::time::Instant::now() < deadline && hello_count < 1 {
            let timeout = deadline - tokio::time::Instant::now();
            match tokio::time::timeout(timeout, events_rx.recv()).await {
                Ok(Some(TransportEvent::Hello { server_seq: 42, .. })) => hello_count += 1,
                Ok(Some(_)) => continue,
                _ => break,
            }
        }
        assert_eq!(
            hello_count, 1,
            "ResyncFromOldest must reconnect and surface the post-resync hello"
        );

        // After the reset+reconnect, the persisted cursor must be at 42 (the
        // relay's oldest retained), NOT 0.
        let cursor = store
            .load_cursor(&room_id)
            .expect("load_cursor")
            .expect("cursor must exist");
        assert_eq!(
            cursor.last_pulled_seq, 42,
            "ResyncFromOldest must reset cursor to resyncFromSeq, not 0"
        );

        // The second subscribe MUST carry after=42.
        let after_seqs = captured_after.lock().await.clone();
        assert!(after_seqs.len() >= 2, "expected ≥2 subscribe frames, got {after_seqs:?}");
        assert_eq!(after_seqs[0], 5, "first subscribe used the seeded cursor");
        assert_eq!(after_seqs[1], 42, "second subscribe must use resyncFromSeq");

        let _ = cancel_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), run_handle).await;
        server_handle.abort();
    }

    /// Test 11: 4005 with Manual policy emits Error event and bails out —
    /// caller decides what to do, no auto-reconnect.
    #[tokio::test]
    async fn cursor_too_old_with_manual_policy_does_not_auto_reconnect() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let room_id: RoomId = id(TEST_ROOM);

        // Pre-seed cursor at 5.
        store
            .save_cursor(
                &room_id,
                &SyncCursor {
                    room_id: room_id.clone(),
                    device_id: id::<DeviceId>(TEST_DEVICE),
                    last_pulled_seq: 5,
                    imported_event_ids: vec![],
                    pending_outbound_envelope_ids: vec![],
                },
            )
            .expect("save_cursor");

        let connect_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count_for_server = Arc::clone(&connect_count);
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, _n| {
            let count_for_server = Arc::clone(&count_for_server);
            async move {
                count_for_server.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = ws.next().await; // subscribe
                let err = json!({
                    "type": "error",
                    "code": "ATTN_CURSOR_TOO_OLD",
                    "message": "cursor 5 < oldest 42",
                    "resyncFromSeq": 42u64,
                });
                ws.send(Message::Text(err.to_string().into())).await.unwrap();
                let _ = ws.next().await;
            }
        })
        .await;

        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = build_client_with_policy(
            relay_url,
            pipeline,
            store.clone(),
            events_tx,
            CursorRecoveryPolicy::Manual,
        );
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let run_res =
            tokio::time::timeout(Duration::from_secs(3), client.run(cancel_rx)).await;
        let err = match run_res {
            Ok(Err(e)) => e,
            other => panic!("expected CursorTooOld error, got {other:?}"),
        };
        match err {
            TransportError::CursorTooOld(seq) => assert_eq!(seq, 42),
            other => panic!("expected CursorTooOld(42), got {other:?}"),
        }

        // No auto-reconnect — exactly one accept on the server.
        assert_eq!(
            connect_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "Manual policy must NOT auto-reconnect"
        );

        // The persisted cursor must be UNCHANGED — Manual hands the
        // decision to the caller; the WS layer didn't touch the cursor.
        let cursor = store
            .load_cursor(&room_id)
            .expect("load_cursor")
            .expect("cursor exists");
        assert_eq!(
            cursor.last_pulled_seq, 5,
            "Manual policy must NOT reset the persisted cursor"
        );

        // The Error event must have been emitted with the relay's code.
        let mut saw_error = false;
        while let Ok(Some(ev)) =
            tokio::time::timeout(Duration::from_millis(50), events_rx.recv()).await
        {
            if let TransportEvent::Error { code, .. } = ev {
                if code == "ATTN_CURSOR_TOO_OLD" {
                    saw_error = true;
                }
            }
        }
        assert!(saw_error, "Manual policy must still emit the Error event");
        server_handle.abort();
    }

    /// Test 12: 4005 with RequestSnapshot policy logs + returns the typed
    /// error so the P2P orchestrator can initiate a snapshot dance.
    #[tokio::test]
    async fn cursor_too_old_with_request_snapshot_policy_returns_typed_error() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let room_id: RoomId = id(TEST_ROOM);
        store
            .save_cursor(
                &room_id,
                &SyncCursor {
                    room_id: room_id.clone(),
                    device_id: id::<DeviceId>(TEST_DEVICE),
                    last_pulled_seq: 7,
                    imported_event_ids: vec![],
                    pending_outbound_envelope_ids: vec![],
                },
            )
            .expect("save_cursor");

        let connect_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count_for_server = Arc::clone(&connect_count);
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, _n| {
            let count_for_server = Arc::clone(&count_for_server);
            async move {
                count_for_server.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = ws.next().await;
                let err = json!({
                    "type": "error",
                    "code": "ATTN_CURSOR_TOO_OLD",
                    "message": "too old",
                    "resyncFromSeq": 99u64,
                });
                ws.send(Message::Text(err.to_string().into())).await.unwrap();
                let _ = ws.next().await;
            }
        })
        .await;

        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let client = build_client_with_policy(
            relay_url,
            pipeline,
            store.clone(),
            events_tx,
            CursorRecoveryPolicy::RequestSnapshot,
        );
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let run_res =
            tokio::time::timeout(Duration::from_secs(3), client.run(cancel_rx)).await;
        match run_res {
            Ok(Err(TransportError::CursorTooOld(99))) => {}
            other => panic!("expected CursorTooOld(99), got {other:?}"),
        }
        assert_eq!(
            connect_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "RequestSnapshot must NOT auto-reconnect"
        );

        // Cursor unchanged — the orchestrator decides what to do next.
        let cursor = store.load_cursor(&room_id).expect("load_cursor").unwrap();
        assert_eq!(cursor.last_pulled_seq, 7);
        server_handle.abort();
    }

    /// Test 13: empty cursor on first connect → subscribe carries after=0.
    /// Confirms the load fallback path when no cursor exists on disk.
    #[tokio::test]
    async fn empty_cursor_on_first_connect_uses_after_seq_zero() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let room_id: RoomId = id(TEST_ROOM);
        // Confirm no cursor on disk.
        assert!(
            store.load_cursor(&room_id).expect("load_cursor").is_none(),
            "store should have no cursor pre-test"
        );

        let captured_after = Arc::new(tokio::sync::Mutex::new(None::<u64>));
        let captured_for_server = Arc::clone(&captured_after);
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, _n| {
            let captured_for_server = Arc::clone(&captured_for_server);
            async move {
                if let Some(Ok(Message::Text(payload))) = ws.next().await {
                    let v: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                    if let Some(after) = v.get("after").and_then(Value::as_u64) {
                        *captured_for_server.lock().await = Some(after);
                    }
                }
                let hello = json!({
                    "type": "hello",
                    "serverSeq": 0u64,
                    "policy": sample_policy(),
                    "devices": [],
                    "missedSignalEnvelopeIds": [],
                });
                ws.send(Message::Text(hello.to_string().into())).await.unwrap();
                let _ = ws.next().await;
            }
        })
        .await;

        let (events_tx, _events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline, store, events_tx);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let run_handle = tokio::spawn(async move { let _ = client.run(cancel_rx).await; });

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut got: Option<u64> = None;
        while tokio::time::Instant::now() < deadline {
            if let Some(after) = *captured_after.lock().await {
                got = Some(after);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(got, Some(0u64), "first connect must subscribe with after=0");

        let _ = cancel_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), run_handle).await;
        server_handle.abort();
    }

    /// Test 14: cursor save preserves existing `imported_event_ids` /
    /// `pending_outbound_envelope_ids`. The WS layer is responsible for
    /// `last_pulled_seq` only — overwriting the other lists would silently
    /// regress state owned by `ReviewManager`.
    #[tokio::test]
    async fn cursor_save_preserves_existing_lists() {
        let (pipeline, store, _vk, _tmp) = fresh_pipeline();
        let event_key = {
            let keys = derive_room_keys(&TEST_ROOM_SECRET);
            *keys.event_key.as_bytes()
        };
        let room_id: RoomId = id(TEST_ROOM);
        let prior_event_id: crate::review::ids::EventId = id("evt-prior-01");
        // Seed cursor with a non-empty imported_event_ids list.
        store
            .save_cursor(
                &room_id,
                &SyncCursor {
                    room_id: room_id.clone(),
                    device_id: id::<DeviceId>(TEST_DEVICE),
                    last_pulled_seq: 0,
                    imported_event_ids: vec![prior_event_id.clone()],
                    pending_outbound_envelope_ids: vec!["env-pending-01".to_string()],
                },
            )
            .expect("save_cursor");

        let envelopes = mint_event_envelopes(event_key, &room_id, 1);
        let envelopes_for_server = envelopes.clone();
        let (relay_url, server_handle) = spawn_ws_server(move |mut ws, _n| {
            let envelopes_for_server = envelopes_for_server.clone();
            async move {
                let _ = ws.next().await;
                let hello = json!({
                    "type": "hello",
                    "serverSeq": 0u64,
                    "policy": sample_policy(),
                    "devices": [],
                    "missedSignalEnvelopeIds": [],
                });
                ws.send(Message::Text(hello.to_string().into())).await.unwrap();
                for (i, env) in envelopes_for_server.iter().enumerate() {
                    let frame = json!({
                        "type": "envelope",
                        "envelope": env,
                        "serverSeq": 11 + i as u64,
                    });
                    ws.send(Message::Text(frame.to_string().into())).await.unwrap();
                }
                let _ = ws.next().await;
            }
        })
        .await;

        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = build_client(relay_url, pipeline, store.clone(), events_tx);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let run_handle = tokio::spawn(async move { let _ = client.run(cancel_rx).await; });

        // Wait for the envelope.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut got = false;
        while tokio::time::Instant::now() < deadline && !got {
            let timeout = deadline - tokio::time::Instant::now();
            if let Ok(Some(TransportEvent::Envelope { .. })) =
                tokio::time::timeout(timeout, events_rx.recv()).await
            {
                got = true;
            }
        }
        assert!(got, "envelope must be routed");

        let cursor = store.load_cursor(&room_id).expect("load_cursor").unwrap();
        assert_eq!(cursor.last_pulled_seq, 11, "last_pulled_seq must advance");
        assert_eq!(
            cursor.imported_event_ids,
            vec![prior_event_id],
            "imported_event_ids must be preserved across cursor saves"
        );
        assert_eq!(
            cursor.pending_outbound_envelope_ids,
            vec!["env-pending-01".to_string()],
            "pending_outbound_envelope_ids must be preserved across cursor saves"
        );

        let _ = cancel_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), run_handle).await;
        server_handle.abort();
    }

    /// Test 15: default policy is ResyncFromOldest. Locks the cross-module
    /// contract so changing the default forces a deliberate edit here.
    #[test]
    fn cursor_recovery_policy_default_is_resync_from_oldest() {
        assert_eq!(
            CursorRecoveryPolicy::default(),
            CursorRecoveryPolicy::ResyncFromOldest
        );
    }
}
