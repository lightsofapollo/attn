//! Mailbox transport — HTTP outbox processor against the Cloudflare relay.
//!
//! This module owns the **outbound** half of the Mailbox `Transport` impl: it
//! drains the on-disk outbox written by `ReviewManager` (`store.append_outbox`
//! / `store.iter_outbox` from attn-nnj.2.3) and posts batches to
//! `POST /v2/rooms/:roomId/envelopes` on the relay, attaching the
//! `Attn-Admission` HMAC (relay-spec.md §Identity / §Admission Key) and an
//! `Attn-PoW` token drawn from a `TokenPool` (attn-nnj.1.7).
//!
//! Spec:
//!   - `planning/collab/relay-spec.md` §`POST /v2/rooms/:roomId/envelopes`
//!   - `planning/collab/crypto-spec.md` §Hashcash Proof-of-Work
//!     §Envelope Batch Cap (32 envelopes per request)
//!
//! The WebSocket subscribe path lives in `mailbox::ws` (attn-nnj.6.3); the
//! inbound decrypt + verify pipeline lives in `super::inbound` (attn-nnj.6.4).
//! This module deliberately stays narrowly focused on the outbound path so
//! the two halves can ship in parallel.

#![allow(dead_code)]

pub mod ws;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::review::crypto::pow::{PowError, TokenPool};
use crate::review::ids::{DeviceId, RoomId};
use crate::review::model::MailboxEnvelope;
use crate::review::store::ReviewStore;
use crate::review::transport::{EnvelopeAck, TransportError};

/// Path component for the envelopes endpoint, parameterized on `roomId`.
///
/// Single source of truth for the (method, path) tuple consumed by:
///   - the admission HMAC canonicalRequest builder,
///   - the PoW resource binding (`request_path_hash` in pow.rs).
fn envelopes_path(room_id: &RoomId) -> String {
    format!("/v2/rooms/{}/envelopes", room_id.as_str())
}

/// HTTP method used for the envelopes endpoint. Hoisted to a constant so the
/// admission builder, PoW minter, and reqwest call all read from the same
/// string.
const ENVELOPES_METHOD: &str = "POST";

/// Per crypto-spec.md §Envelope Batch Cap — the relay caps batches at 32
/// envelopes per `POST /envelopes` call. Larger batches return
/// `400 ATTN_BATCH_TOO_LARGE`; the processor splits proactively.
pub const MAX_BATCH_SIZE: usize = 32;

/// Initial exponential-backoff delay on transient network failures.
pub const BACKOFF_INITIAL_MS: u64 = 1_000;

/// Maximum exponential-backoff delay on transient network failures.
pub const BACKOFF_MAX_MS: u64 = 60_000;

/// Static configuration for the mailbox transport — relay URL, room/device
/// binding, and the per-room admission key + PoW difficulty.
///
/// All fields are immutable for the life of an `OutboxProcessor`; rotating
/// any of them requires a new processor instance. Tracked separately from
/// the processor itself so other halves of the mailbox transport (WS
/// subscribe in 6.3, inbound pipeline in 6.4) can share the same config.
#[derive(Debug, Clone)]
pub struct MailboxConfig {
    /// Base URL of the relay (e.g. `https://relay.attn.dev`). No trailing slash.
    pub relay_url: String,
    pub room_id: RoomId,
    pub device_id: DeviceId,
    /// 32-byte per-room admission key (`hkdf(rootKey, "attn relay admission v2")`).
    /// See relay-spec.md §Admission Key.
    pub admission_key: [u8; 32],
    /// Server-clamped PoW difficulty for this room
    /// (relay-spec.md §Proof of Work / crypto-spec.md §Difficulty).
    pub pow_difficulty: u32,
}

/// How the WS client reacts when the relay surfaces an
/// `ATTN_CURSOR_TOO_OLD` error (close code 4005, see relay-spec.md §Close
/// Codes and §Stale-cursor recovery).
///
/// The relay sends `error { code: "ATTN_CURSOR_TOO_OLD", resyncFromSeq }`
/// followed by close `4005` when the client's `after` cursor is older than
/// the relay's `meta:oldest_retained_seq`. The recovery decision is
/// policy-dependent:
///
/// - `ResyncFromOldest` — async path: discard the local cursor, reset it to
///   `resyncFromSeq` (the relay's oldest retained), and reconnect. This
///   accepts that any envelopes between the old cursor and `resyncFromSeq`
///   are permanently lost (deleted by owner ACK or expiry).
/// - `RequestSnapshot` — live (P2P) path: emit an Error event and let the
///   higher-level orchestrator initiate a `RequestSnapshot` over WebRTC
///   (Phase 4). The client does NOT auto-reconnect — the caller must call
///   `run` again after the snapshot lands.
/// - `Manual` — the caller decides what to do via the emitted Error event;
///   the client does not auto-reconnect. Used in tests and for owner-side
///   UI flows where a human is in the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorRecoveryPolicy {
    /// Reset cursor to `resyncFromSeq` and reconnect. Default.
    ResyncFromOldest,
    /// Emit an error, do not reconnect — caller initiates a P2P snapshot.
    RequestSnapshot,
    /// Emit an error, do not reconnect — caller drives the next step.
    Manual,
}

impl Default for CursorRecoveryPolicy {
    fn default() -> Self {
        CursorRecoveryPolicy::ResyncFromOldest
    }
}

/// Drains the on-disk outbox and posts batches to the relay.
///
/// Owns:
///   - `store` — the durable outbox (`outbox.jsonl`) + the
///     `outbox-sent.jsonl` shadow log used to skip already-acked envelopes.
///   - `config` — relay URL + admission/PoW material.
///   - `token_pool` — pre-minted PoW tokens for the envelopes endpoint.
///   - `http_client` — a long-lived `reqwest::Client` so we reuse the
///     connection pool across batches.
///
/// Stateless across calls — every `process_once` reads the current outbox
/// from disk, filters out sent ids, and writes new acks to the sent log.
/// This means a restart (or a parallel processor — which we deliberately
/// don't spawn yet) recovers cleanly.
pub struct OutboxProcessor {
    store: Arc<ReviewStore>,
    config: Arc<MailboxConfig>,
    token_pool: Arc<TokenPool>,
    http_client: reqwest::Client,
    /// Coarse-grained guard against `process_once` racing itself. Most callers
    /// drive the processor from a single task, but the manager IPC layer can
    /// call `process_once` on demand alongside the background `run` loop.
    process_lock: Arc<Mutex<()>>,
}

impl OutboxProcessor {
    /// Construct a processor bound to the supplied store + relay config.
    ///
    /// The `http_client` is built with a short connect timeout so a wedged
    /// relay surface as `TransportError::Io` quickly rather than blocking the
    /// runtime for the OS-default minute-plus.
    pub fn new(
        store: Arc<ReviewStore>,
        config: Arc<MailboxConfig>,
        token_pool: Arc<TokenPool>,
    ) -> Result<Self> {
        let http_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .context("build reqwest client")?;
        Ok(Self {
            store,
            config,
            token_pool,
            http_client,
            process_lock: Arc::new(Mutex::new(())),
        })
    }

    /// Test-only constructor that lets tests inject a pre-built reqwest client
    /// (useful for pointing it at a wiremock server without TLS / with a
    /// short timeout).
    #[cfg(test)]
    fn with_http_client(
        store: Arc<ReviewStore>,
        config: Arc<MailboxConfig>,
        token_pool: Arc<TokenPool>,
        http_client: reqwest::Client,
    ) -> Self {
        Self {
            store,
            config,
            token_pool,
            http_client,
            process_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Borrow the active config (used by integration code that needs to know
    /// the room / device the processor is bound to).
    pub fn config(&self) -> &MailboxConfig {
        &self.config
    }

    /// Enqueue a fresh envelope to the outbox. Idempotent on `envelopeId`
    /// (relies on `ReviewStore::append_outbox` dedup).
    ///
    /// Returns `Ok(())` whether or not the envelope was a duplicate — the
    /// caller's contract is "the envelope is durable in the outbox" and that
    /// holds either way.
    pub fn enqueue(&self, envelope: MailboxEnvelope) -> Result<(), TransportError> {
        self.store
            .append_outbox(&self.config.room_id, &envelope)
            .map(|_| ())
            .map_err(|e| TransportError::Io(format!("outbox append: {e}")))
    }
}

// ---------------------------------------------------------------------------
// Sent-log shadow file
// ---------------------------------------------------------------------------
//
// `ReviewStore::iter_outbox` is the persisted truth of "what we ever
// enqueued"; we never delete from it (it's the audit log of outbound
// activity). To remember which envelopes have been ACKed by the relay we
// write a tiny shadow file at `outbox-sent.jsonl` alongside it. Each line
// records a single ack so `process_once` can filter on next iteration.

/// On-disk record written to `outbox-sent.jsonl` once the relay accepts an
/// envelope. The same struct is emitted to callers as `EnvelopeAck`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SentRecord {
    envelope_id: String,
    server_seq: u64,
}

impl SentRecord {
    fn into_ack(self) -> EnvelopeAck {
        EnvelopeAck {
            envelope_id: self.envelope_id,
            server_seq: self.server_seq,
        }
    }
}

/// Path of the sent-log for the room the processor is bound to.
fn sent_log_path(store_root: &std::path::Path, room_id: &RoomId) -> PathBuf {
    store_root
        .join("rooms")
        .join(room_id.as_str())
        .join("outbox-sent.jsonl")
}

/// Load the set of envelope ids already acked from the sent-log. Returns an
/// empty set when the file does not yet exist.
fn load_sent_ids(
    store_root: &std::path::Path,
    room_id: &RoomId,
) -> Result<std::collections::HashSet<String>> {
    let path = sent_log_path(store_root, room_id);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(std::collections::HashSet::new());
        }
        Err(err) => {
            return Err(err).with_context(|| format!("read {}", path.display()));
        }
    };
    let mut out = std::collections::HashSet::new();
    for line in bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let rec: SentRecord = serde_json::from_slice(line)
            .with_context(|| format!("decode {}", path.display()))?;
        out.insert(rec.envelope_id);
    }
    Ok(out)
}

/// Append a single sent-record (`{envelopeId, serverSeq}`) to the sent-log,
/// creating the file (and parent directory) on first write.
fn append_sent_record(
    store_root: &std::path::Path,
    room_id: &RoomId,
    record: &SentRecord,
) -> Result<()> {
    use std::io::Write as _;
    let path = sent_log_path(store_root, room_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }
    let mut line = serde_json::to_string(record)
        .with_context(|| format!("serialize sent record for {}", path.display()))?;
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))?;
    f.write_all(line.as_bytes())
        .with_context(|| format!("append {}", path.display()))?;
    f.flush()
        .with_context(|| format!("flush {}", path.display()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Canonical-request + admission HMAC
// ---------------------------------------------------------------------------

/// Build the canonical-request bytes that get HMAC-signed under
/// `admissionKey`, exactly matching the relay's `canonicalRequest` in
/// `relay/src/admission.ts`:
///
/// ```text
/// METHOD || "\n" || URL_PATH || "\n" || CANONICAL_QUERY || "\n" || SHA-256(body)
/// ```
///
/// We only post to `POST /v2/rooms/:roomId/envelopes`, so the query string is
/// always empty and we never need full URL-canonicalization. If a later
/// caller passes a query string we percent-encode and sort it here so the
/// admission HMAC matches the relay's `canonicalizeQuery`.
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

/// Sort the query params by raw key then raw value, percent-encode each, and
/// join with `&`. Mirrors the relay's `canonicalizeQuery` so the HMAC binds
/// to the same byte string both ends.
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

/// Percent-encode per RFC 3986 §2.3 unreserved set:
/// `ALPHA / DIGIT / "-" / "." / "_" / "~"`. Everything else becomes `%XX`.
fn rfc3986_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let is_unreserved = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'.' | b'_' | b'~');
        if is_unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Build the `Attn-Admission: v2.<base64url(hmac)>` header value for a
/// fully-formed (method, path, body) request.
fn admission_header_value(
    admission_key: &[u8; 32],
    method: &str,
    url_path: &str,
    query_pairs: &[(String, String)],
    body: &[u8],
) -> String {
    let canonical = canonical_request_bytes(method, url_path, query_pairs, body);
    let mut mac = <Hmac<Sha256>>::new_from_slice(admission_key)
        .expect("HMAC accepts any key length");
    mac.update(&canonical);
    let tag = mac.finalize().into_bytes();
    format!("v2.{}", URL_SAFE_NO_PAD.encode(tag))
}

// ---------------------------------------------------------------------------
// HTTP wire shapes
// ---------------------------------------------------------------------------

/// `POST /v2/rooms/:roomId/envelopes` request body — see relay-spec.md
/// §`POST /v2/rooms/:roomId/envelopes`.
#[derive(Debug, Serialize)]
struct EnvelopesBody<'a> {
    envelopes: &'a [MailboxEnvelope],
}

/// Success response: one server-assigned `serverSeq` per accepted envelope.
#[derive(Debug, Deserialize)]
struct EnvelopesResponse {
    accepted: Vec<AcceptedEnvelope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedEnvelope {
    envelope_id: String,
    server_seq: u64,
}

/// Error response: see relay-spec.md §Wire Conventions. `retryAfterMs` is
/// surfaced inside the JSON body for 429 / 507; `429` ALSO mirrors it as a
/// `Retry-After` header (which we consult first because it can survive a
/// non-JSON body).
#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    retry_after_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// process_once + send_batch
// ---------------------------------------------------------------------------

impl OutboxProcessor {
    /// Drain pending envelopes and post them in batches of up to 32. Returns
    /// the cumulative list of accepted envelopes (server_seq stamped) across
    /// every batch in this invocation.
    ///
    /// On terminal errors (`401`, `507`, repeated PoW failure) the call
    /// short-circuits with the corresponding `TransportError` — the caller is
    /// responsible for deciding whether to retry or surface to the UI. Any
    /// envelopes already accepted in earlier batches of this call are still
    /// persisted to the sent-log before the error returns.
    pub async fn process_once(&self) -> Result<Vec<EnvelopeAck>, TransportError> {
        let _guard = self.process_lock.lock().await;

        let store_root = self.store.root().to_path_buf();
        let sent_ids = load_sent_ids(&store_root, &self.config.room_id)
            .map_err(|e| TransportError::Io(format!("load sent-log: {e}")))?;

        let mut pending: Vec<MailboxEnvelope> = Vec::new();
        for entry in self
            .store
            .iter_outbox(&self.config.room_id)
            .map_err(|e| TransportError::Io(format!("iter_outbox: {e}")))?
        {
            let env = entry.map_err(|e| TransportError::Io(format!("decode outbox: {e}")))?;
            if sent_ids.contains(&env.envelope_id) {
                continue;
            }
            pending.push(env);
        }

        if pending.is_empty() {
            return Ok(Vec::new());
        }

        let mut all_acks: Vec<EnvelopeAck> = Vec::new();
        for chunk in pending.chunks(MAX_BATCH_SIZE) {
            let acks = self.send_batch(chunk).await?;
            // Persist sent records BEFORE returning so a panic between
            // batches can't double-send.
            for ack in &acks {
                let rec = SentRecord {
                    envelope_id: ack.envelope_id.clone(),
                    server_seq: ack.server_seq,
                };
                append_sent_record(&store_root, &self.config.room_id, &rec)
                    .map_err(|e| TransportError::Io(format!("write sent-log: {e}")))?;
            }
            all_acks.extend(acks);
        }
        Ok(all_acks)
    }

    /// Run the processor on a loop until `cancel` flips to `true`. Mostly a
    /// convenience for the daemon — production code drives this from
    /// `ReviewManager`. Each iteration: drain the outbox, then sleep with
    /// exponential-backoff on transient errors.
    pub async fn run(&self, mut cancel: tokio::sync::watch::Receiver<bool>) {
        let mut backoff_ms = BACKOFF_INITIAL_MS;
        loop {
            if *cancel.borrow() {
                return;
            }
            match self.process_once().await {
                Ok(_acks) => {
                    backoff_ms = BACKOFF_INITIAL_MS;
                }
                Err(TransportError::RateLimited(delay_ms)) => {
                    // Respect the relay's retryAfterMs verbatim.
                    if wait_or_cancel(delay_ms, &mut cancel).await {
                        return;
                    }
                    continue;
                }
                Err(TransportError::StorageCapReached) => {
                    // Leave envelopes in the outbox; back off and try again
                    // (storage cap may be transient as TTL'd events expire).
                    if wait_or_cancel(backoff_ms, &mut cancel).await {
                        return;
                    }
                    backoff_ms = (backoff_ms * 2).min(BACKOFF_MAX_MS);
                    continue;
                }
                Err(TransportError::AdmissionRejected)
                | Err(TransportError::RoomDeleted)
                | Err(TransportError::RoomExpired)
                | Err(TransportError::RoomNotFound) => {
                    // Fatal — bail out of the run loop. Caller is expected to
                    // surface the error via `process_once` separately.
                    return;
                }
                Err(_) => {
                    // Network/IO/Cursor — exponential backoff and retry.
                    if wait_or_cancel(backoff_ms, &mut cancel).await {
                        return;
                    }
                    backoff_ms = (backoff_ms * 2).min(BACKOFF_MAX_MS);
                }
            }
            // Quick yield between successful drains so the cancel signal is
            // honored promptly. The realistic cadence is driven by the
            // outbox notifier (attn-nnj.6.5) once it lands.
            if wait_or_cancel(50, &mut cancel).await {
                return;
            }
        }
    }

    /// POST a single batch (caller-chunked to ≤ MAX_BATCH_SIZE). Picks up a
    /// fresh PoW token for the (method, path), retries once on
    /// `400 ATTN_POW_INVALID`, and maps every other status to a typed
    /// `TransportError`.
    async fn send_batch(
        &self,
        envelopes: &[MailboxEnvelope],
    ) -> Result<Vec<EnvelopeAck>, TransportError> {
        debug_assert!(
            envelopes.len() <= MAX_BATCH_SIZE,
            "send_batch caller must chunk to <= {MAX_BATCH_SIZE}",
        );
        let body = EnvelopesBody { envelopes };
        let body_bytes = serde_json::to_vec(&body)
            .map_err(|e| TransportError::Io(format!("serialize envelopes: {e}")))?;
        let path = envelopes_path(&self.config.room_id);
        let url = format!("{}{}", self.config.relay_url.trim_end_matches('/'), path);

        // First attempt; on ATTN_POW_INVALID retry once with a freshly minted
        // token (spec.md §Server Validation rules out client clock skew /
        // stale pool entries).
        match self
            .post_envelopes_attempt(&url, &path, &body_bytes)
            .await?
        {
            BatchOutcome::Accepted(acks) => Ok(acks),
            BatchOutcome::PowInvalid => {
                // Replenish at least one fresh token before retry. The pool
                // already drops stale entries on take, so a single new mint
                // is enough.
                let _ = self
                    .token_pool
                    .replenish(ENVELOPES_METHOD, &path, 1)
                    .await
                    .map_err(map_pow_err)?;
                match self
                    .post_envelopes_attempt(&url, &path, &body_bytes)
                    .await?
                {
                    BatchOutcome::Accepted(acks) => Ok(acks),
                    BatchOutcome::PowInvalid => Err(TransportError::Io(
                        "relay rejected PoW token twice (ATTN_POW_INVALID)".to_string(),
                    )),
                }
            }
        }
    }

    /// Single round-trip — mint/take a PoW token, build the admission HMAC,
    /// POST, classify the response. Returns `BatchOutcome::PowInvalid` so
    /// `send_batch` can decide whether to retry; every other terminal status
    /// surfaces as a typed `TransportError`.
    async fn post_envelopes_attempt(
        &self,
        url: &str,
        path: &str,
        body: &[u8],
    ) -> Result<BatchOutcome, TransportError> {
        let pow_token = self
            .token_pool
            .take(ENVELOPES_METHOD, path)
            .await
            .map_err(map_pow_err)?;

        let admission = admission_header_value(
            &self.config.admission_key,
            ENVELOPES_METHOD,
            path,
            &[],
            body,
        );

        let resp = self
            .http_client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header("Attn-Admission", admission)
            .header("Attn-PoW", pow_token)
            .body(body.to_vec())
            .send()
            .await
            .map_err(|e| TransportError::Io(format!("POST {url}: {e}")))?;

        let status = resp.status();
        // Pull the Retry-After header (in seconds per RFC 7231) before we
        // consume the body — wiremock and some routers strip headers when
        // you read the body.
        let retry_after_header = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .map(|secs| secs * 1000);

        let raw_body = resp
            .bytes()
            .await
            .map_err(|e| TransportError::Io(format!("read response body: {e}")))?;

        match status.as_u16() {
            200 | 201 => {
                let parsed: EnvelopesResponse = serde_json::from_slice(&raw_body)
                    .map_err(|e| TransportError::Io(format!("decode 2xx body: {e}")))?;
                let acks: Vec<EnvelopeAck> = parsed
                    .accepted
                    .into_iter()
                    .map(|a| EnvelopeAck {
                        envelope_id: a.envelope_id,
                        server_seq: a.server_seq,
                    })
                    .collect();
                Ok(BatchOutcome::Accepted(acks))
            }
            400 => {
                let err = parse_error_body(&raw_body);
                if err.error.code == "ATTN_POW_INVALID" {
                    Ok(BatchOutcome::PowInvalid)
                } else if err.error.code == "ATTN_BATCH_TOO_LARGE" {
                    // Defensive: we already chunk to MAX_BATCH_SIZE.
                    // Surface as Io so callers see the spec violation.
                    Err(TransportError::Io(format!(
                        "relay reports ATTN_BATCH_TOO_LARGE: {}",
                        err.error.message
                    )))
                } else {
                    Err(TransportError::Io(format!(
                        "relay 400 {}: {}",
                        err.error.code, err.error.message
                    )))
                }
            }
            401 => Err(TransportError::AdmissionRejected),
            404 => Err(TransportError::RoomNotFound),
            410 => {
                let err = parse_error_body(&raw_body);
                if err.error.code == "ATTN_ROOM_DELETED" {
                    Err(TransportError::RoomDeleted)
                } else if err.error.code == "ATTN_ROOM_EXPIRED" {
                    Err(TransportError::RoomExpired)
                } else {
                    Err(TransportError::Io(format!(
                        "relay 410 {}: {}",
                        err.error.code, err.error.message
                    )))
                }
            }
            429 => {
                let err = parse_error_body(&raw_body);
                // Prefer the JSON body field; fall back to the header; default 1s.
                let retry_ms = err
                    .error
                    .retry_after_ms
                    .or(retry_after_header)
                    .unwrap_or(1_000);
                Err(TransportError::RateLimited(retry_ms))
            }
            507 => Err(TransportError::StorageCapReached),
            _ => Err(TransportError::Io(format!(
                "relay {} (body: {} bytes)",
                status,
                raw_body.len()
            ))),
        }
    }
}

/// Outcome of a single POST attempt, internal to `send_batch`.
#[derive(Debug)]
enum BatchOutcome {
    Accepted(Vec<EnvelopeAck>),
    PowInvalid,
}

/// Parse a relay error body, falling back to a synthetic `ATTN_UNKNOWN`
/// payload when the body is not the expected `{error: {...}}` shape. The
/// relay always emits well-formed errors, but we don't want a malformed body
/// to mask the underlying status code.
fn parse_error_body(bytes: &[u8]) -> ErrorResponse {
    match serde_json::from_slice::<ErrorResponse>(bytes) {
        Ok(parsed) => parsed,
        Err(_) => ErrorResponse {
            error: ErrorBody {
                code: "ATTN_UNKNOWN".to_string(),
                message: String::from_utf8_lossy(bytes).into_owned(),
                retry_after_ms: None,
            },
        },
    }
}

/// Translate a `PowError` into a `TransportError`. Cancellation is mapped to
/// `Io` rather than a dedicated variant — cancellation only happens on
/// shutdown, at which point the run loop already exited.
fn map_pow_err(e: PowError) -> TransportError {
    TransportError::Io(format!("pow: {e}"))
}

/// Sleep for `delay_ms` milliseconds OR until `cancel` flips to true,
/// whichever comes first. Returns `true` iff cancellation triggered.
async fn wait_or_cancel(delay_ms: u64, cancel: &mut tokio::sync::watch::Receiver<bool>) -> bool {
    if *cancel.borrow() {
        return true;
    }
    let sleep = tokio::time::sleep(Duration::from_millis(delay_ms));
    tokio::select! {
        _ = sleep => false,
        res = cancel.changed() => {
            // `changed()` resolves to Err once the sender has dropped, which
            // we also treat as cancellation.
            res.is_err() || *cancel.borrow()
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::crypto::pow::DEFAULT_TTL_MS;
    use crate::review::ids::ParticipantId;
    use crate::review::model::EnvelopeKind;
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::sync::Arc;
    use tempfile::TempDir;
    use wiremock::matchers::{header_exists, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    // Difficulty kept low so the tests stay quick — production uses 16.
    const TEST_DIFFICULTY: u32 = 12;
    const TEST_ROOM: &str = "room-1";
    const TEST_DEVICE: &str = "device-1";

    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("id deserializes")
    }

    fn fresh_store() -> (TempDir, Arc<ReviewStore>) {
        let tmp = TempDir::new().expect("tempdir");
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("open store");
        (tmp, Arc::new(store))
    }

    fn build_processor(store: Arc<ReviewStore>, relay_url: String) -> OutboxProcessor {
        let cfg = Arc::new(MailboxConfig {
            relay_url,
            room_id: id::<RoomId>(TEST_ROOM),
            device_id: id::<DeviceId>(TEST_DEVICE),
            admission_key: [0x42u8; 32],
            pow_difficulty: TEST_DIFFICULTY,
        });
        let pool = Arc::new(TokenPool::new(
            TEST_ROOM.to_string(),
            TEST_DEVICE.to_string(),
            TEST_DIFFICULTY,
            DEFAULT_TTL_MS,
        ));
        let http_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()
            .expect("client");
        OutboxProcessor::with_http_client(store, cfg, pool, http_client)
    }

    fn sample_envelope(envelope_id: &str) -> MailboxEnvelope {
        MailboxEnvelope {
            v: 2,
            room_id: id::<RoomId>(TEST_ROOM),
            envelope_id: envelope_id.to_string(),
            server_seq: None,
            author_id: id::<ParticipantId>("p-1"),
            device_id: id::<DeviceId>(TEST_DEVICE),
            created_at: 1_700_000_000_000,
            expires_at: 1_700_000_086_400,
            kind: EnvelopeKind::Event,
            target: None,
            nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
            ciphertext: "Y2lwaGVy".to_string(), // base64url("cipher")
            ciphertext_bytes: 6,
        }
    }

    /// Build a wiremock response that echoes the request envelopes back as
    /// accepted with monotonically increasing serverSeqs.
    fn echo_accept_response(start_seq: u64) -> impl Fn(&Request) -> ResponseTemplate + Send + Sync + 'static {
        move |req: &Request| {
            let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
            let envelopes = body
                .get("envelopes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let accepted: Vec<Value> = envelopes
                .iter()
                .enumerate()
                .map(|(i, env)| {
                    let id_str = env
                        .get("envelopeId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    json!({
                        "envelopeId": id_str,
                        "serverSeq": start_seq + i as u64,
                    })
                })
                .collect();
            ResponseTemplate::new(200).set_body_json(json!({ "accepted": accepted }))
        }
    }

    // -- enqueue + process_once happy path --------------------------------

    #[tokio::test]
    async fn enqueue_writes_to_store_and_process_once_posts() {
        let server = MockServer::start().await;
        let (_tmp, store) = fresh_store();
        let processor = build_processor(store.clone(), server.uri());

        // Wiremock mock: accept POSTs that carry both admission + pow headers.
        Mock::given(method("POST"))
            .and(path(format!("/v2/rooms/{TEST_ROOM}/envelopes")))
            .and(header_exists("Attn-Admission"))
            .and(header_exists("Attn-PoW"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accepted": [{ "envelopeId": "env-1", "serverSeq": 1 }],
            })))
            .expect(1)
            .mount(&server)
            .await;

        processor.enqueue(sample_envelope("env-1")).expect("enqueue");

        // Verify the store has it (so a restart would replay).
        let on_disk: Vec<MailboxEnvelope> = store
            .iter_outbox(&id::<RoomId>(TEST_ROOM))
            .expect("iter")
            .collect::<Result<_>>()
            .expect("decode");
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0].envelope_id, "env-1");

        let acks = processor.process_once().await.expect("process_once");
        assert_eq!(acks.len(), 1);
        assert_eq!(acks[0].envelope_id, "env-1");
        assert_eq!(acks[0].server_seq, 1);

        // Calling process_once again should be a no-op: the sent-log filters
        // out the already-acked envelope.
        let acks2 = processor.process_once().await.expect("process_once 2");
        assert!(acks2.is_empty());
    }

    // -- batch of 5 -> single POST with 5 envelopes -----------------------

    #[tokio::test]
    async fn batch_of_five_posts_in_single_request() {
        let server = MockServer::start().await;
        let (_tmp, store) = fresh_store();
        let processor = build_processor(store.clone(), server.uri());

        Mock::given(method("POST"))
            .and(path(format!("/v2/rooms/{TEST_ROOM}/envelopes")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accepted": [
                    { "envelopeId": "env-1", "serverSeq": 1 },
                    { "envelopeId": "env-2", "serverSeq": 2 },
                    { "envelopeId": "env-3", "serverSeq": 3 },
                    { "envelopeId": "env-4", "serverSeq": 4 },
                    { "envelopeId": "env-5", "serverSeq": 5 },
                ],
            })))
            .expect(1)
            .mount(&server)
            .await;

        for i in 1..=5 {
            processor
                .enqueue(sample_envelope(&format!("env-{i}")))
                .expect("enqueue");
        }

        let acks = processor.process_once().await.expect("process_once");
        assert_eq!(acks.len(), 5);
        // serverSeqs assigned in order.
        for (i, ack) in acks.iter().enumerate() {
            assert_eq!(ack.server_seq, (i + 1) as u64);
        }

        let requests = server.received_requests().await.expect("requests");
        assert_eq!(requests.len(), 1, "five envelopes must batch into one POST");
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        let envelopes = body["envelopes"].as_array().expect("envelopes array");
        assert_eq!(envelopes.len(), 5);
    }

    // -- batch of 33 -> split into 32 + 1 ---------------------------------

    #[tokio::test]
    async fn batch_of_33_splits_into_two_posts() {
        let server = MockServer::start().await;
        let (_tmp, store) = fresh_store();
        let processor = build_processor(store.clone(), server.uri());

        Mock::given(method("POST"))
            .and(path(format!("/v2/rooms/{TEST_ROOM}/envelopes")))
            .respond_with(echo_accept_response(1))
            .expect(2)
            .mount(&server)
            .await;

        for i in 1..=33 {
            processor
                .enqueue(sample_envelope(&format!("env-{i:02}")))
                .expect("enqueue");
        }

        let acks = processor.process_once().await.expect("process_once");
        assert_eq!(acks.len(), 33, "all 33 must be acked across the two batches");

        let requests = server.received_requests().await.expect("requests");
        assert_eq!(requests.len(), 2, "33 envelopes must split into 32 + 1");
        let body_one: Value = serde_json::from_slice(&requests[0].body).unwrap();
        let body_two: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(body_one["envelopes"].as_array().unwrap().len(), 32);
        assert_eq!(body_two["envelopes"].as_array().unwrap().len(), 1);
    }

    // -- 429 with retryAfterMs -------------------------------------------

    #[tokio::test]
    async fn rate_limited_response_surfaces_retry_after_ms() {
        let server = MockServer::start().await;
        let (_tmp, store) = fresh_store();
        let processor = build_processor(store.clone(), server.uri());

        Mock::given(method("POST"))
            .and(path(format!("/v2/rooms/{TEST_ROOM}/envelopes")))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "error": {
                    "code": "ATTN_RATE_LIMITED",
                    "message": "slow down",
                    "retryAfterMs": 2500,
                },
            })))
            .mount(&server)
            .await;

        processor.enqueue(sample_envelope("env-1")).expect("enqueue");
        let err = processor.process_once().await.expect_err("rate limit");
        match err {
            TransportError::RateLimited(ms) => assert_eq!(ms, 2500),
            other => panic!("expected RateLimited(2500), got {other:?}"),
        }

        // Envelope remains in the outbox (no sent-record was written).
        let sent = load_sent_ids(store.root(), &id::<RoomId>(TEST_ROOM)).expect("load sent");
        assert!(sent.is_empty());
    }

    // -- 401 -> AdmissionRejected ----------------------------------------

    #[tokio::test]
    async fn admission_failure_surfaces_admission_rejected() {
        let server = MockServer::start().await;
        let (_tmp, store) = fresh_store();
        let processor = build_processor(store.clone(), server.uri());

        Mock::given(method("POST"))
            .and(path(format!("/v2/rooms/{TEST_ROOM}/envelopes")))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "error": { "code": "ATTN_ADMISSION_INVALID", "message": "bad hmac" },
            })))
            .mount(&server)
            .await;

        processor.enqueue(sample_envelope("env-1")).expect("enqueue");
        let err = processor.process_once().await.expect_err("401");
        assert!(
            matches!(err, TransportError::AdmissionRejected),
            "expected AdmissionRejected, got {err:?}"
        );
    }

    // -- 507 -> StorageCapReached, envelope stays in outbox --------------

    #[tokio::test]
    async fn storage_cap_response_leaves_envelopes_in_outbox() {
        let server = MockServer::start().await;
        let (_tmp, store) = fresh_store();
        let processor = build_processor(store.clone(), server.uri());

        Mock::given(method("POST"))
            .and(path(format!("/v2/rooms/{TEST_ROOM}/envelopes")))
            .respond_with(ResponseTemplate::new(507).set_body_json(json!({
                "error": { "code": "ATTN_ROOM_STORAGE_FULL", "message": "full" },
            })))
            .mount(&server)
            .await;

        processor.enqueue(sample_envelope("env-1")).expect("enqueue");
        let err = processor.process_once().await.expect_err("507");
        assert!(matches!(err, TransportError::StorageCapReached));

        // Envelope still present, sent-log still empty.
        let on_disk: Vec<MailboxEnvelope> = store
            .iter_outbox(&id::<RoomId>(TEST_ROOM))
            .expect("iter")
            .collect::<Result<_>>()
            .expect("decode");
        assert_eq!(on_disk.len(), 1);
        let sent = load_sent_ids(store.root(), &id::<RoomId>(TEST_ROOM)).expect("load sent");
        assert!(sent.is_empty());
    }

    // -- ATTN_POW_INVALID -> refresh token + retry once ------------------

    #[tokio::test]
    async fn pow_invalid_triggers_single_retry() {
        let server = MockServer::start().await;
        let (_tmp, store) = fresh_store();
        let processor = build_processor(store.clone(), server.uri());

        // First call: reject with ATTN_POW_INVALID.
        Mock::given(method("POST"))
            .and(path(format!("/v2/rooms/{TEST_ROOM}/envelopes")))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": { "code": "ATTN_POW_INVALID", "message": "expired" },
            })))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;

        // Second call: accept.
        Mock::given(method("POST"))
            .and(path(format!("/v2/rooms/{TEST_ROOM}/envelopes")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accepted": [{ "envelopeId": "env-1", "serverSeq": 1 }],
            })))
            .expect(1)
            .mount(&server)
            .await;

        processor.enqueue(sample_envelope("env-1")).expect("enqueue");
        let acks = processor.process_once().await.expect("process_once");
        assert_eq!(acks.len(), 1);
        assert_eq!(acks[0].server_seq, 1);

        let requests = server.received_requests().await.expect("requests");
        assert_eq!(
            requests.len(),
            2,
            "PoW-invalid should trigger exactly one retry"
        );
    }

    // -- admission HMAC value matches canonical-request format ----------

    #[test]
    fn admission_header_matches_canonical_request_format() {
        let body = br#"{"envelopes":[]}"#;
        let header = admission_header_value(
            &[0x42u8; 32],
            "POST",
            "/v2/rooms/room-1/envelopes",
            &[],
            body,
        );
        // Header MUST start with the v2 prefix.
        assert!(header.starts_with("v2."), "got: {header}");
        // After the dot we have base64url-no-pad of a 32-byte HMAC.
        let tail = header.trim_start_matches("v2.");
        let decoded = URL_SAFE_NO_PAD.decode(tail).expect("base64url");
        assert_eq!(decoded.len(), 32, "HMAC-SHA-256 is 32 bytes");

        // Recompute the canonical bytes manually and HMAC them — they must
        // match. (Self-consistency check; the cross-impl assertion against
        // the TS relay is owned by the integration tests in 6.6.)
        let body_hash = Sha256::digest(body);
        let mut canonical = Vec::new();
        canonical.extend_from_slice(b"POST\n/v2/rooms/room-1/envelopes\n\n");
        canonical.extend_from_slice(&body_hash);
        let mut mac = <Hmac<Sha256>>::new_from_slice(&[0x42u8; 32]).unwrap();
        mac.update(&canonical);
        let expected = mac.finalize().into_bytes();
        assert_eq!(decoded.as_slice(), expected.as_slice());
    }

    // -- canonical query sorts + percent-encodes ------------------------

    #[test]
    fn canonicalize_query_sorts_and_percent_encodes() {
        let q = canonicalize_query(&[
            ("b".to_string(), "two".to_string()),
            ("a".to_string(), "one space".to_string()),
            ("a".to_string(), "0".to_string()),
        ]);
        assert_eq!(q, "a=0&a=one%20space&b=two");
    }
}
