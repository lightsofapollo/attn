//! Hashcash proof-of-work for relay write authentication.
//!
//! See `planning/collab/crypto-spec.md` §Hashcash Proof-of-Work for the
//! canonical token format, hash algorithm, and validation rules.
//!
//! Token format (verbatim):
//!
//! ```text
//! attn-pow:v2:<difficulty>:<expiresAt>:<resource>:<rand>:<counter>
//! ```
//!
//! where `resource = <roomId>:<deviceId>:<requestPathHash>` and
//! `requestPathHash = base64url-no-pad(first 8 bytes of SHA-256(METHOD || " " || PATH))`.
//!
//! Mint is CPU-bound; callers MUST invoke `mint` from
//! `tokio::task::spawn_blocking` (or another OS thread) to avoid stalling the
//! Tokio runtime. `TokenPool` does this for you.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

/// Default difficulty per crypto-spec.md §Difficulty (16 leading zero bits,
/// median ~65k SHA-256 attempts).
pub const DEFAULT_DIFFICULTY: u32 = 16;

/// Minimum difficulty the spec allows (clamp floor — server uses `max(policy, 12)`).
pub const MIN_DIFFICULTY: u32 = 12;

/// Maximum difficulty the spec allows.
pub const MAX_DIFFICULTY: u32 = 24;

/// Default token TTL: 5 minutes (server tolerates +5 more for skew).
pub const DEFAULT_TTL_MS: u64 = 5 * 60 * 1000;

/// Server's clock-skew window: tokens are accepted up to `now + TTL + 5min`
/// (i.e. expiresAt may be up to `now + 10min`). See crypto-spec.md §Server
/// Validation step 4.
pub const SERVER_SKEW_MS: u64 = 5 * 60 * 1000;

/// Tokens within this window of `expiresAt` are considered stale and will be
/// discarded by the pool to avoid request-time-of-flight expiry.
pub const POOL_EXPIRY_BUFFER_MS: u64 = 30 * 1000;

/// Cancellation poll cadence inside the mint loop (every 1024 iterations).
const CANCEL_POLL_STRIDE: u64 = 1024;

/// Default pool size per (method, path) slot. Small — the goal is to absorb
/// short bursts, not pre-mint forever.
pub const DEFAULT_POOL_SIZE: usize = 4;

/// Token prefix — the literal `attn-pow:v2:` we prepend to every minted token.
const TOKEN_PREFIX: &str = "attn-pow:v2:";

/// Number of colon-separated segments in a valid token.
/// `attn-pow` | `v2` | `difficulty` | `expiresAt` | `roomId` | `deviceId`
/// | `requestPathHash` | `rand` | `counter`  = 9.
const TOKEN_SEGMENTS: usize = 9;

#[derive(Debug, thiserror::Error)]
pub enum PowError {
    #[error("rng: {0}")]
    Random(String),
    #[error("token parse: {0}")]
    Parse(String),
    #[error("verify failed: {0}")]
    Verify(String),
    #[error("cancelled")]
    Cancelled,
    #[error("clock: system time is before unix epoch")]
    Clock,
    #[error("difficulty {0} outside allowed range [{1}, {2}]")]
    InvalidDifficulty(u32, u32, u32),
}

/// Maps (METHOD, PATH) into the resource hash component.
///
/// Per crypto-spec.md:
/// `requestPathHash = base64url(first 8 bytes of SHA-256(METHOD || " " || PATH))`.
pub fn request_path_hash(method: &str, path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(method.as_bytes());
    hasher.update(b" ");
    hasher.update(path.as_bytes());
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(&digest[..8])
}

/// Build the resource string: `<roomId>:<deviceId>:<requestPathHash>`.
pub fn resource_string(room_id: &str, device_id: &str, method: &str, path: &str) -> String {
    format!("{room_id}:{device_id}:{}", request_path_hash(method, path))
}

/// Count leading zero bits in a byte slice (high bit of byte 0 first).
#[inline]
fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut count = 0u32;
    for &b in bytes {
        if b == 0 {
            count += 8;
        } else {
            count += b.leading_zeros();
            break;
        }
    }
    count
}

/// Compute `SHA-256(token)` as a 32-byte array.
#[inline]
fn token_sha256(token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.finalize().into()
}

/// Current unix-millis timestamp.
fn now_ms() -> Result<u64, PowError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .map_err(|_| PowError::Clock)
}

/// Validate difficulty falls inside the spec-allowed range.
fn check_difficulty(difficulty: u32) -> Result<(), PowError> {
    if !(MIN_DIFFICULTY..=MAX_DIFFICULTY).contains(&difficulty) {
        return Err(PowError::InvalidDifficulty(
            difficulty,
            MIN_DIFFICULTY,
            MAX_DIFFICULTY,
        ));
    }
    Ok(())
}

/// Generate the 16-byte `rand` field as base64url-no-pad.
fn fresh_rand() -> Result<String, PowError> {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).map_err(|e| PowError::Random(e.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// Mint a PoW token. **CPU-bound** — call from `tokio::task::spawn_blocking`
/// (or another OS thread) to avoid stalling the Tokio runtime.
///
/// `cancel` is consulted every ~1024 hash attempts; if it returns true the
/// loop exits with `PowError::Cancelled`. Tokens within
/// `POOL_EXPIRY_BUFFER_MS` of expiry are NOT minted here — that's the pool's
/// concern.
pub fn mint(
    room_id: &str,
    device_id: &str,
    method: &str,
    path: &str,
    difficulty: u32,
    ttl_ms: u64,
    cancel: impl Fn() -> bool,
) -> Result<String, PowError> {
    check_difficulty(difficulty)?;
    let expires_at = now_ms()?.saturating_add(ttl_ms);
    let resource = resource_string(room_id, device_id, method, path);
    let rand = fresh_rand()?;

    // Pre-format the invariant prefix once; only the counter changes per iter.
    let prefix = format!("{TOKEN_PREFIX}{difficulty}:{expires_at}:{resource}:{rand}:");

    let mut counter: u64 = 0;
    loop {
        if counter & (CANCEL_POLL_STRIDE - 1) == 0 && counter != 0 && cancel() {
            return Err(PowError::Cancelled);
        }
        let token = format!("{prefix}{counter}");
        let hash = token_sha256(&token);
        if leading_zero_bits(&hash) >= difficulty {
            return Ok(token);
        }
        counter = counter.wrapping_add(1);
        // Defensive: if we somehow wrap, something is catastrophically wrong.
        if counter == 0 {
            return Err(PowError::Verify(
                "counter wrapped without finding a valid hash".to_string(),
            ));
        }
    }
}

/// Parsed view of a token's fields. All fields borrow from the original token
/// string to keep parsing allocation-free.
#[derive(Debug, Clone)]
struct ParsedToken<'a> {
    difficulty: u32,
    expires_at: u64,
    room_id: &'a str,
    device_id: &'a str,
    request_path_hash: &'a str,
    rand: &'a str,
    counter: &'a str,
}

fn parse_token(token: &str) -> Result<ParsedToken<'_>, PowError> {
    // Split into the fixed number of colon segments. We use splitn to avoid
    // pathological inputs producing huge Vecs, then verify count exactly.
    let parts: Vec<&str> = token.splitn(TOKEN_SEGMENTS + 1, ':').collect();
    if parts.len() != TOKEN_SEGMENTS {
        return Err(PowError::Parse(format!(
            "expected {TOKEN_SEGMENTS} colon-separated segments, got {}",
            parts.len()
        )));
    }
    if parts[0] != "attn-pow" {
        return Err(PowError::Parse("missing 'attn-pow' magic".to_string()));
    }
    if parts[1] != "v2" {
        return Err(PowError::Parse(format!(
            "unsupported version: {}",
            parts[1]
        )));
    }
    let difficulty: u32 = parts[2]
        .parse()
        .map_err(|e| PowError::Parse(format!("difficulty not u32: {e}")))?;
    let expires_at: u64 = parts[3]
        .parse()
        .map_err(|e| PowError::Parse(format!("expiresAt not u64: {e}")))?;
    let room_id = parts[4];
    let device_id = parts[5];
    let request_path_hash = parts[6];
    let rand = parts[7];
    let counter = parts[8];

    // counter must be a non-negative decimal integer (strings to be safe for
    // values > 2^53 in JSON). We accept any non-empty digit string.
    if counter.is_empty() || !counter.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PowError::Parse("counter must be decimal digits".to_string()));
    }
    if room_id.is_empty() || device_id.is_empty() || request_path_hash.is_empty() {
        return Err(PowError::Parse(
            "resource components must be non-empty".to_string(),
        ));
    }
    if rand.is_empty() {
        return Err(PowError::Parse("rand must be non-empty".to_string()));
    }

    Ok(ParsedToken {
        difficulty,
        expires_at,
        room_id,
        device_id,
        request_path_hash,
        rand,
        counter,
    })
}

/// Verify a token client-side (sanity check before sending).
///
/// Returns `Ok(())` iff the token parses, claims at least `expected_difficulty`
/// difficulty, and its SHA-256 actually has at least `expected_difficulty`
/// leading zero bits. Does NOT check resource binding against an actual
/// request — that's `verify_full`.
pub fn verify_local(token: &str, expected_difficulty: u32) -> Result<(), PowError> {
    let parsed = parse_token(token)?;
    if parsed.difficulty < expected_difficulty {
        return Err(PowError::Verify(format!(
            "token claims difficulty {} but {} required",
            parsed.difficulty, expected_difficulty
        )));
    }
    let bits = leading_zero_bits(&token_sha256(token));
    if bits < expected_difficulty {
        return Err(PowError::Verify(format!(
            "token hash has {bits} leading zero bits, need {expected_difficulty}"
        )));
    }
    Ok(())
}

/// Full server-side verification. Mirrors the relay's check order (see
/// crypto-spec.md §Server Validation, minus replay protection which is
/// owned by the relay).
///
/// Steps:
/// 1. Parses; v == v2; all fields present.
/// 2. `difficulty >= min_difficulty`.
/// 3. `expires_at > now_ms`.
/// 4. `expires_at <= now_ms + 10min` (clock-skew window).
/// 5. `(room_id, device_id, requestPathHash(method, path))` matches the
///    token's resource fields.
/// 6. `SHA-256(token)` has at least `difficulty` leading zero bits.
pub fn verify_full(
    token: &str,
    room_id: &str,
    device_id: &str,
    method: &str,
    path: &str,
    min_difficulty: u32,
    now_ms: u64,
) -> Result<(), PowError> {
    let parsed = parse_token(token)?;

    if parsed.difficulty < min_difficulty {
        return Err(PowError::Verify(format!(
            "token difficulty {} below required {}",
            parsed.difficulty, min_difficulty
        )));
    }

    if now_ms >= parsed.expires_at {
        return Err(PowError::Verify(format!(
            "token expired (expiresAt={}, now={})",
            parsed.expires_at, now_ms
        )));
    }
    let max_expires = now_ms.saturating_add(DEFAULT_TTL_MS + SERVER_SKEW_MS);
    if parsed.expires_at > max_expires {
        return Err(PowError::Verify(format!(
            "expiresAt {} beyond clock-skew window (now + {}ms)",
            parsed.expires_at,
            DEFAULT_TTL_MS + SERVER_SKEW_MS
        )));
    }

    if parsed.room_id != room_id {
        return Err(PowError::Verify(format!(
            "room_id mismatch: token={} request={}",
            parsed.room_id, room_id
        )));
    }
    if parsed.device_id != device_id {
        return Err(PowError::Verify(format!(
            "device_id mismatch: token={} request={}",
            parsed.device_id, device_id
        )));
    }
    let expected_path_hash = request_path_hash(method, path);
    if parsed.request_path_hash != expected_path_hash {
        return Err(PowError::Verify(format!(
            "method/path mismatch: token hash={} request hash={} ({} {})",
            parsed.request_path_hash, expected_path_hash, method, path
        )));
    }

    let bits = leading_zero_bits(&token_sha256(token));
    if bits < parsed.difficulty {
        return Err(PowError::Verify(format!(
            "token hash has {bits} leading zero bits, claims {}",
            parsed.difficulty
        )));
    }

    Ok(())
}

/// Inspect the `expiresAt` field of a token without doing any crypto.
/// Used by the pool to decide whether to discard a near-expiry token.
fn token_expires_at(token: &str) -> Result<u64, PowError> {
    Ok(parse_token(token)?.expires_at)
}

/// Per-(method, path) pool of pre-minted PoW tokens. Concurrent-safe.
///
/// `take` returns a fresh token (minting on demand if the pool is empty);
/// `replenish` mints in the background to keep slots topped up.
///
/// Pool entries that are within `POOL_EXPIRY_BUFFER_MS` of `expiresAt` are
/// discarded on retrieval to avoid request-time-of-flight failures.
pub struct TokenPool {
    inner: Mutex<HashMap<(String, String), VecDeque<String>>>,
    room_id: Arc<String>,
    device_id: Arc<String>,
    difficulty: u32,
    ttl_ms: u64,
    target_size: usize,
}

impl TokenPool {
    pub fn new(room_id: String, device_id: String, difficulty: u32, ttl_ms: u64) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            room_id: Arc::new(room_id),
            device_id: Arc::new(device_id),
            difficulty,
            ttl_ms,
            target_size: DEFAULT_POOL_SIZE,
        }
    }

    /// Customize the per-slot target pool size (default `DEFAULT_POOL_SIZE`).
    pub fn with_target_size(mut self, size: usize) -> Self {
        self.target_size = size;
        self
    }

    /// Take one token for `(method, path)`. Pops a fresh pooled token if
    /// available; otherwise mints on the calling thread.
    ///
    /// Callers wanting to keep the runtime alive should `spawn_blocking` the
    /// surrounding closure when on-demand minting is the likely path.
    pub async fn take(&self, method: &str, path: &str) -> Result<String, PowError> {
        let key = (method.to_string(), path.to_string());
        let now = now_ms()?;

        {
            let mut map = self.inner.lock().await;
            if let Some(slot) = map.get_mut(&key) {
                while let Some(token) = slot.pop_front() {
                    match token_expires_at(&token) {
                        Ok(exp) if exp > now.saturating_add(POOL_EXPIRY_BUFFER_MS) => {
                            return Ok(token);
                        }
                        // Stale or unparseable — drop and try the next one.
                        _ => continue,
                    }
                }
            }
        }

        // No fresh pooled token; mint inline. The caller is responsible for
        // wrapping the whole `.take(...)` in `spawn_blocking` if they need to
        // keep the runtime responsive — this mirrors how the outbox
        // processor (attn-nnj.6.2) will drive minting.
        mint(
            &self.room_id,
            &self.device_id,
            method,
            path,
            self.difficulty,
            self.ttl_ms,
            || false,
        )
    }

    /// Background-mint up to `target_size` tokens for `(method, path)` while
    /// idle. Safe to fire-and-forget. Returns the number of new tokens added.
    pub async fn replenish(
        &self,
        method: &str,
        path: &str,
        target_size: usize,
    ) -> Result<usize, PowError> {
        let key = (method.to_string(), path.to_string());

        let needed = {
            let mut map = self.inner.lock().await;
            // First, prune stale entries so we don't double-count near-expiry
            // tokens against `target_size`.
            let now = now_ms()?;
            if let Some(slot) = map.get_mut(&key) {
                slot.retain(|tok| match token_expires_at(tok) {
                    Ok(exp) => exp > now.saturating_add(POOL_EXPIRY_BUFFER_MS),
                    Err(_) => false,
                });
            }
            let have = map.get(&key).map(VecDeque::len).unwrap_or(0);
            target_size.saturating_sub(have)
        };

        if needed == 0 {
            return Ok(0);
        }

        let mut minted = 0usize;
        for _ in 0..needed {
            let token = mint(
                &self.room_id,
                &self.device_id,
                method,
                path,
                self.difficulty,
                self.ttl_ms,
                || false,
            )?;
            let mut map = self.inner.lock().await;
            map.entry(key.clone()).or_default().push_back(token);
            minted += 1;
        }
        Ok(minted)
    }

    /// Read-only snapshot of the current size of a slot. Mostly useful for
    /// tests and metrics.
    pub async fn slot_len(&self, method: &str, path: &str) -> usize {
        let key = (method.to_string(), path.to_string());
        let map = self.inner.lock().await;
        map.get(&key).map(VecDeque::len).unwrap_or(0)
    }

    /// Per-slot target size used by `replenish` callers that want the default.
    pub fn target_size(&self) -> usize {
        self.target_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    // Use difficulty=12 throughout: median ~4k SHA-256 attempts, well under
    // 10ms — keeps the suite snappy. The real default in production is 16
    // (per crypto-spec.md §Difficulty).
    const TEST_DIFFICULTY: u32 = 12;
    const TEST_TTL: u64 = 5 * 60 * 1000;

    fn no_cancel() -> impl Fn() -> bool {
        || false
    }

    // -- request_path_hash determinism -----------------------------------

    #[test]
    fn request_path_hash_is_deterministic() {
        let a = request_path_hash("POST", "/v2/rooms/R/envelopes");
        let b = request_path_hash("POST", "/v2/rooms/R/envelopes");
        assert_eq!(a, b);
        // base64url-no-pad of 8 bytes = 11 chars.
        assert_eq!(a.len(), 11);
    }

    #[test]
    fn request_path_hash_differs_by_method() {
        let a = request_path_hash("POST", "/v2/rooms/R/envelopes");
        let b = request_path_hash("DELETE", "/v2/rooms/R/envelopes");
        assert_ne!(a, b);
    }

    #[test]
    fn request_path_hash_differs_by_path() {
        let a = request_path_hash("POST", "/v2/rooms/R/envelopes");
        let b = request_path_hash("POST", "/v2/rooms/R/acks");
        assert_ne!(a, b);
    }

    // -- mint + verify roundtrip -----------------------------------------

    #[test]
    fn mint_produces_token_meeting_difficulty() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .expect("mint");
        let bits = leading_zero_bits(&token_sha256(&token));
        assert!(
            bits >= TEST_DIFFICULTY,
            "expected >= {TEST_DIFFICULTY} leading zero bits, got {bits}"
        );
        assert!(token.starts_with("attn-pow:v2:"));
    }

    #[test]
    fn verify_local_accepts_fresh_token() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        verify_local(&token, TEST_DIFFICULTY).expect("verify_local");
    }

    #[test]
    fn verify_local_rejects_higher_difficulty_demand() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        // Demand much higher than minted — should reject either on the
        // claimed-difficulty check or the hash-bits check.
        let err = verify_local(&token, 24).unwrap_err();
        assert!(matches!(err, PowError::Verify(_)));
    }

    // -- verify_full binding ---------------------------------------------

    #[test]
    fn verify_full_accepts_matching_resource() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        let now = now_ms().unwrap();
        verify_full(
            &token,
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            now,
        )
        .expect("verify_full");
    }

    #[test]
    fn verify_full_rejects_wrong_method() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        let now = now_ms().unwrap();
        let err = verify_full(
            &token,
            "ROOM",
            "DEVICE",
            "DELETE",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            now,
        )
        .unwrap_err();
        assert!(matches!(err, PowError::Verify(_)));
    }

    #[test]
    fn verify_full_rejects_wrong_path() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        let now = now_ms().unwrap();
        let err = verify_full(
            &token,
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/acks",
            TEST_DIFFICULTY,
            now,
        )
        .unwrap_err();
        assert!(matches!(err, PowError::Verify(_)));
    }

    #[test]
    fn verify_full_rejects_wrong_room_id() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        let now = now_ms().unwrap();
        let err = verify_full(
            &token,
            "OTHER_ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            now,
        )
        .unwrap_err();
        assert!(matches!(err, PowError::Verify(_)));
    }

    #[test]
    fn verify_full_rejects_past_expiry() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        // Pretend a long time has passed.
        let later = now_ms().unwrap() + 2 * TEST_TTL;
        let err = verify_full(
            &token,
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            later,
        )
        .unwrap_err();
        match err {
            PowError::Verify(msg) => assert!(msg.contains("expired"), "got: {msg}"),
            other => panic!("expected Verify error, got {other:?}"),
        }
    }

    #[test]
    fn verify_full_rejects_below_min_difficulty() {
        let token = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        let now = now_ms().unwrap();
        let err = verify_full(
            &token,
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY + 4,
            now,
        )
        .unwrap_err();
        match err {
            PowError::Verify(msg) => {
                assert!(msg.contains("below required"), "got: {msg}");
            }
            other => panic!("expected Verify error, got {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_wrong_segment_count() {
        let err = parse_token("attn-pow:v2:12:1700000000000").unwrap_err();
        assert!(matches!(err, PowError::Parse(_)));
    }

    #[test]
    fn parse_rejects_v1() {
        // Construct a token that LOOKS like a real token but with v1.
        let real = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            TEST_DIFFICULTY,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap();
        // Swap "v2" → "v1" in the prefix.
        let tampered = real.replacen("attn-pow:v2:", "attn-pow:v1:", 1);
        let err = parse_token(&tampered).unwrap_err();
        match err {
            PowError::Parse(msg) => assert!(msg.contains("v1"), "got: {msg}"),
            other => panic!("expected Parse error, got {other:?}"),
        }
    }

    #[test]
    fn mint_invalid_difficulty_below_floor() {
        let err = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            11,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap_err();
        assert!(matches!(err, PowError::InvalidDifficulty(11, 12, 24)));
    }

    #[test]
    fn mint_invalid_difficulty_above_cap() {
        let err = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            25,
            TEST_TTL,
            no_cancel(),
        )
        .unwrap_err();
        assert!(matches!(err, PowError::InvalidDifficulty(25, 12, 24)));
    }

    // -- cancellation -----------------------------------------------------

    #[test]
    fn mint_cancels_when_signal_set() {
        // difficulty=24 means median ~16M attempts (~10s on a fast core).
        // With cancel = always-true, we should bail in well under a second.
        let start = std::time::Instant::now();
        let err = mint(
            "ROOM",
            "DEVICE",
            "POST",
            "/v2/rooms/R/envelopes",
            MAX_DIFFICULTY,
            TEST_TTL,
            || true,
        )
        .unwrap_err();
        let elapsed = start.elapsed();
        assert!(matches!(err, PowError::Cancelled), "got {err:?}");
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "cancel took too long: {elapsed:?}"
        );
    }

    // -- token pool -------------------------------------------------------

    #[tokio::test]
    async fn token_pool_take_returns_fresh_tokens() {
        let pool = TokenPool::new(
            "ROOM".into(),
            "DEVICE".into(),
            TEST_DIFFICULTY,
            TEST_TTL,
        );
        let token = pool.take("POST", "/v2/rooms/R/envelopes").await.unwrap();
        verify_local(&token, TEST_DIFFICULTY).expect("token from pool verifies");
    }

    #[tokio::test]
    async fn token_pool_replenish_fills_slot() {
        let pool = TokenPool::new(
            "ROOM".into(),
            "DEVICE".into(),
            TEST_DIFFICULTY,
            TEST_TTL,
        );
        let minted = pool
            .replenish("POST", "/v2/rooms/R/envelopes", 3)
            .await
            .unwrap();
        assert_eq!(minted, 3);
        assert_eq!(pool.slot_len("POST", "/v2/rooms/R/envelopes").await, 3);

        // Take one; size drops to 2.
        let _ = pool.take("POST", "/v2/rooms/R/envelopes").await.unwrap();
        assert_eq!(pool.slot_len("POST", "/v2/rooms/R/envelopes").await, 2);
    }

    #[tokio::test]
    async fn token_pool_replenish_is_idempotent_when_full() {
        let pool = TokenPool::new(
            "ROOM".into(),
            "DEVICE".into(),
            TEST_DIFFICULTY,
            TEST_TTL,
        );
        let first = pool
            .replenish("POST", "/v2/rooms/R/envelopes", 2)
            .await
            .unwrap();
        assert_eq!(first, 2);
        let second = pool
            .replenish("POST", "/v2/rooms/R/envelopes", 2)
            .await
            .unwrap();
        assert_eq!(second, 0, "no new tokens minted when slot is full");
    }

    #[tokio::test]
    async fn token_pool_separates_method_path_slots() {
        let pool = TokenPool::new(
            "ROOM".into(),
            "DEVICE".into(),
            TEST_DIFFICULTY,
            TEST_TTL,
        );
        pool.replenish("POST", "/v2/rooms/R/envelopes", 1)
            .await
            .unwrap();
        pool.replenish("POST", "/v2/rooms/R/acks", 1)
            .await
            .unwrap();
        assert_eq!(pool.slot_len("POST", "/v2/rooms/R/envelopes").await, 1);
        assert_eq!(pool.slot_len("POST", "/v2/rooms/R/acks").await, 1);
        assert_eq!(pool.slot_len("DELETE", "/v2/rooms/R/envelopes").await, 0);
    }

    // -- helpers ----------------------------------------------------------

    #[test]
    fn leading_zero_bits_counts_correctly() {
        assert_eq!(leading_zero_bits(&[]), 0);
        assert_eq!(leading_zero_bits(&[0xFF]), 0);
        assert_eq!(leading_zero_bits(&[0x80]), 0);
        assert_eq!(leading_zero_bits(&[0x40]), 1);
        assert_eq!(leading_zero_bits(&[0x01]), 7);
        assert_eq!(leading_zero_bits(&[0x00]), 8);
        assert_eq!(leading_zero_bits(&[0x00, 0x80]), 8);
        assert_eq!(leading_zero_bits(&[0x00, 0x40]), 9);
        assert_eq!(leading_zero_bits(&[0x00, 0x00, 0x10]), 19);
        assert_eq!(leading_zero_bits(&[0x00, 0x00, 0x00, 0x00]), 32);
    }

    // -- vector generation helper -----------------------------------------

    /// Helper to regenerate the canned values in `pow.json`. Not run by
    /// default — invoke with:
    ///
    /// ```sh
    /// cargo test review::crypto::pow::tests::generate_corpus_vectors \
    ///   -- --ignored --nocapture
    /// ```
    ///
    /// Then hand-copy the printed JSON into `planning/collab/test-vectors/pow.json`.
    #[test]
    #[ignore]
    fn generate_corpus_vectors() {
        struct EndpointSpec {
            name: &'static str,
            method: &'static str,
            path_template: &'static str,
            path_substituted: &'static str,
            room_id: &'static str,
            device_id: &'static str,
            rand_seed: u8,
            expires_at: u64,
            difficulty: u32,
        }

        let specs = [
            EndpointSpec {
                name: "POST /v2/rooms/:roomId/devices — device join",
                method: "POST",
                path_template: "/v2/rooms/:roomId/devices",
                path_substituted: "/v2/rooms/EXAMPLE_ROOM/devices",
                room_id: "EXAMPLE_ROOM",
                device_id: "EXAMPLE_DEVICE",
                rand_seed: 0x10,
                expires_at: 1_700_000_300_000,
                difficulty: 12,
            },
            EndpointSpec {
                name: "POST /v2/rooms/:roomId/envelopes — write batch",
                method: "POST",
                path_template: "/v2/rooms/:roomId/envelopes",
                path_substituted: "/v2/rooms/EXAMPLE_ROOM/envelopes",
                room_id: "EXAMPLE_ROOM",
                device_id: "EXAMPLE_DEVICE",
                rand_seed: 0x20,
                expires_at: 1_700_000_300_000,
                difficulty: 12,
            },
            EndpointSpec {
                name: "POST /v2/rooms/:roomId/acks — ack-with-delete",
                method: "POST",
                path_template: "/v2/rooms/:roomId/acks",
                path_substituted: "/v2/rooms/EXAMPLE_ROOM/acks",
                room_id: "EXAMPLE_ROOM",
                device_id: "EXAMPLE_DEVICE",
                rand_seed: 0x30,
                expires_at: 1_700_000_300_000,
                difficulty: 12,
            },
            EndpointSpec {
                name: "POST /v2/rooms/:roomId/blobs — large snapshot upload",
                method: "POST",
                path_template: "/v2/rooms/:roomId/blobs",
                path_substituted: "/v2/rooms/EXAMPLE_ROOM/blobs",
                room_id: "EXAMPLE_ROOM",
                device_id: "EXAMPLE_DEVICE",
                rand_seed: 0x40,
                expires_at: 1_700_000_300_000,
                difficulty: 12,
            },
            EndpointSpec {
                name: "DELETE /v2/rooms/:roomId — owner-initiated room delete",
                method: "DELETE",
                path_template: "/v2/rooms/:roomId",
                path_substituted: "/v2/rooms/EXAMPLE_ROOM",
                room_id: "EXAMPLE_ROOM",
                device_id: "EXAMPLE_DEVICE",
                rand_seed: 0x50,
                expires_at: 1_700_000_300_000,
                difficulty: 12,
            },
            EndpointSpec {
                name: "POST /v2/rooms/:roomId — room create (owner bootstrap)",
                method: "POST",
                path_template: "/v2/rooms/:roomId",
                path_substituted: "/v2/rooms/EXAMPLE_ROOM",
                room_id: "EXAMPLE_ROOM",
                device_id: "EXAMPLE_DEVICE",
                rand_seed: 0x60,
                expires_at: 1_700_000_300_000,
                difficulty: 12,
            },
        ];

        for spec in &specs {
            // Deterministic rand from seed for reproducibility.
            let rand_bytes: [u8; 16] = [
                spec.rand_seed,
                spec.rand_seed ^ 0xAA,
                spec.rand_seed.wrapping_add(1),
                spec.rand_seed.wrapping_add(2),
                spec.rand_seed.wrapping_add(3),
                spec.rand_seed.wrapping_add(4),
                spec.rand_seed.wrapping_add(5),
                spec.rand_seed.wrapping_add(6),
                spec.rand_seed.wrapping_add(7),
                spec.rand_seed.wrapping_add(8),
                spec.rand_seed.wrapping_add(9),
                spec.rand_seed.wrapping_add(10),
                spec.rand_seed.wrapping_add(11),
                spec.rand_seed.wrapping_add(12),
                spec.rand_seed.wrapping_add(13),
                spec.rand_seed.wrapping_add(14),
            ];
            let rand_b64 = URL_SAFE_NO_PAD.encode(rand_bytes);
            let resource = resource_string(
                spec.room_id,
                spec.device_id,
                spec.method,
                spec.path_substituted,
            );
            let request_hash = request_path_hash(spec.method, spec.path_substituted);
            let prefix = format!(
                "attn-pow:v2:{}:{}:{}:{}:",
                spec.difficulty, spec.expires_at, resource, rand_b64
            );

            let mut counter: u64 = 0;
            let token = loop {
                let token = format!("{prefix}{counter}");
                let hash = token_sha256(&token);
                if leading_zero_bits(&hash) >= spec.difficulty {
                    break token;
                }
                counter += 1;
            };

            let hash_hex = token_sha256(&token)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();

            // Print a JSON fragment to stderr for hand-copying.
            eprintln!(
                "    {{
      \"name\": \"{}\",
      \"inputs\": {{
        \"method\": \"{}\",
        \"path\": \"{}\",
        \"pathSubstituted\": \"{}\",
        \"roomId\": \"{}\",
        \"deviceId\": \"{}\",
        \"rand\": \"{}\",
        \"expiresAt\": {},
        \"difficulty\": {}
      }},
      \"expected\": {{
        \"requestPathHash\": \"{}\",
        \"resource\": \"{}\",
        \"counter\": \"{}\",
        \"tokenHashHex\": \"{}\",
        \"token\": \"{}\"
      }}
    }},",
                spec.name,
                spec.method,
                spec.path_template,
                spec.path_substituted,
                spec.room_id,
                spec.device_id,
                rand_b64,
                spec.expires_at,
                spec.difficulty,
                request_hash,
                resource,
                counter,
                hash_hex,
                token,
            );
        }
    }

    // -- corpus replay ----------------------------------------------------

    /// Compile-time-embedded corpus shared with the (future) TS/WASM client.
    /// See `planning/collab/test-vectors/pow.json` and the README in that
    /// directory for the format contract.
    const POW_CORPUS: &str = include_str!("../../../planning/collab/test-vectors/pow.json");

    fn b64_decode(s: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(s).expect("base64url decode")
    }

    #[test]
    fn corpus_replay_request_path_hash() {
        let v: Value = serde_json::from_str(POW_CORPUS).expect("parse pow.json");
        let vectors = v["vectors"].as_array().expect("vectors array");
        assert!(
            vectors.len() >= 5,
            "expected >= 5 corpus vectors (one per PoW endpoint), got {}",
            vectors.len()
        );
        for entry in vectors {
            let name = entry["name"].as_str().unwrap_or("<no name>");
            let method = entry["inputs"]["method"].as_str().unwrap();
            let path = entry["inputs"]["pathSubstituted"].as_str().unwrap();
            let expected = entry["expected"]["requestPathHash"].as_str().unwrap();
            if expected == "__PENDING__" {
                continue;
            }
            assert_eq!(
                request_path_hash(method, path),
                expected,
                "{name}: requestPathHash mismatch"
            );
        }
    }

    #[test]
    fn corpus_replay_full_token_verifies() {
        let v: Value = serde_json::from_str(POW_CORPUS).expect("parse pow.json");
        let vectors = v["vectors"].as_array().expect("vectors array");
        let mut checked = 0usize;
        for entry in vectors {
            let name = entry["name"].as_str().unwrap_or("<no name>");
            let token = entry["expected"]["token"].as_str().unwrap();
            if token == "__PENDING__" {
                continue;
            }
            let difficulty = entry["inputs"]["difficulty"].as_u64().unwrap() as u32;
            let expected_hash_hex = entry["expected"]["tokenHashHex"].as_str().unwrap();

            // Sanity: the hash field matches what we recompute.
            let actual_hash = token_sha256(token);
            let actual_hex = actual_hash
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            assert_eq!(
                actual_hex, expected_hash_hex,
                "{name}: tokenHashHex mismatch"
            );

            // verify_local should accept the canned token at the canned
            // difficulty.
            verify_local(token, difficulty)
                .unwrap_or_else(|e| panic!("{name}: verify_local failed: {e}"));

            // verify_full with the same inputs should also pass.
            let room_id = entry["inputs"]["roomId"].as_str().unwrap();
            let device_id = entry["inputs"]["deviceId"].as_str().unwrap();
            let method = entry["inputs"]["method"].as_str().unwrap();
            let path = entry["inputs"]["pathSubstituted"].as_str().unwrap();
            let expires_at = entry["inputs"]["expiresAt"].as_u64().unwrap();
            // Pin "now" to (expires_at - 1min) so the token is still in-window.
            let now = expires_at.saturating_sub(60_000);
            verify_full(token, room_id, device_id, method, path, difficulty, now)
                .unwrap_or_else(|e| panic!("{name}: verify_full failed: {e}"));

            // Sanity check that the recorded `rand` matches the token field.
            let parsed = parse_token(token).unwrap();
            let expected_rand = entry["inputs"]["rand"].as_str().unwrap();
            assert_eq!(parsed.rand, expected_rand, "{name}: rand mismatch");
            // And `rand` decodes to exactly 16 bytes.
            assert_eq!(
                b64_decode(parsed.rand).len(),
                16,
                "{name}: rand must decode to 16 bytes"
            );

            checked += 1;
        }
        assert!(
            checked >= 5,
            "expected >= 5 non-pending vectors, got {checked}"
        );
    }
}
