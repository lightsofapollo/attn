//! Relay blob HTTP client — the R2 spillover lane for large snapshots.
//!
//! Spec: `relay-spec.md` §POST /v2/rooms/:roomId/blobs (upload presign) and
//! §R2 spillover (cap-bearing PUT/GET on `/blobs/:envelopeId`, download
//! presign via the cap-less GET form of the same path).
//!
//! Used by:
//! - `bootstrap::Bootstrapper::publish_snapshot` (owner): presign + PUT the
//!   sealed snapshot bytes when the ciphertext exceeds the relay's 1 MiB
//!   inline threshold.
//! - `transport::mailbox::ws` (any peer): presign + GET to resolve an
//!   inbound `snapshot_blob` envelope whose plaintext is a `BlobRef` with
//!   `storage: "r2"`.
//!
//! All helpers are free functions over a shared `reqwest::Client` so both
//! call sites stay symmetric — no hidden state beyond the PoW token pool the
//! upload presign mints from.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::Mac as _;
use hmac::SimpleHmac;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::review::crypto::pow::TokenPool;
use crate::review::ids::{DeviceId, ParticipantId, RoomId};
use crate::review::transport::TransportError;

type Hmac<T> = SimpleHmac<T>;

/// PoW difficulty for the upload presign. Matches the room policy the
/// bootstrapper pins at create time (`BOOTSTRAP_POW_DIFFICULTY`) — the relay
/// accepts tokens at-or-above `policy.powBits`.
const BLOB_POW_DIFFICULTY: u32 = 12;

/// Response of `POST /v2/rooms/:roomId/blobs` — relay `r2.ts`
/// `PresignedUploadResult`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignedUpload {
    /// Relative path + `?cap=<token>`; PUT target is `relay_url + upload_url`.
    pub upload_url: String,
    pub expires_at: u64,
    pub blob_key: String,
}

/// Response of the cap-less `GET /v2/rooms/:roomId/blobs/:envelopeId` —
/// relay `r2.ts` `PresignedDownloadResult`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignedDownload {
    /// Relative path + `?cap=<token>`; GET target is `relay_url + download_url`.
    pub download_url: String,
    pub expires_at: u64,
}

/// Mint an upload capability for an R2 spillover blob. The relay rejects
/// requests at or below its 1 MiB inline threshold (`ATTN_BLOB_TOO_SMALL`)
/// — callers route those through the inline `snapshot_blob` envelope lane
/// instead.
#[allow(clippy::too_many_arguments)]
pub async fn presign_blob_upload(
    http: &reqwest::Client,
    relay_url: &str,
    admission_key: &[u8; 32],
    room_id: &RoomId,
    envelope_id: &str,
    author_id: &ParticipantId,
    device_id: &DeviceId,
    ciphertext_bytes: u64,
) -> Result<PresignedUpload, TransportError> {
    let path = format!("/v2/rooms/{}/blobs", room_id.as_str());
    let url = format!("{}{}", relay_url.trim_end_matches('/'), path);
    let body = serde_json::json!({
        "envelopeId": envelope_id,
        "authorId": author_id.as_str(),
        "deviceId": device_id.as_str(),
        "ciphertextBytes": ciphertext_bytes,
    });
    let body_bytes =
        serde_json::to_vec(&body).map_err(|e| TransportError::Io(format!("serialize: {e}")))?;

    let pow_token = TokenPool::new(
        room_id.as_str().to_string(),
        device_id.as_str().to_string(),
        BLOB_POW_DIFFICULTY,
        crate::review::crypto::pow::DEFAULT_TTL_MS,
    )
    .take("POST", &path)
    .await
    .map_err(|e| TransportError::Io(format!("mint blob pow: {e}")))?;

    let resp = http
        .post(&url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )
        .header(
            "Attn-Admission",
            admission_header(admission_key, "POST", &path, &body_bytes),
        )
        .header("Attn-PoW", pow_token)
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| TransportError::Io(format!("POST {url}: {e}")))?;
    let status = resp.status().as_u16();
    let raw = resp
        .bytes()
        .await
        .map_err(|e| TransportError::Io(format!("read presign body: {e}")))?;
    if status != 200 {
        return Err(relay_error("blob upload presign", status, &raw));
    }
    serde_json::from_slice(&raw).map_err(|e| TransportError::Io(format!("decode presign: {e}")))
}

/// PUT the sealed blob bytes to the presigned upload URL. The relay enforces
/// an exact length match against the presign reservation.
pub async fn put_blob(
    http: &reqwest::Client,
    relay_url: &str,
    presigned: &PresignedUpload,
    bytes: Vec<u8>,
) -> Result<(), TransportError> {
    let url = format!(
        "{}{}",
        relay_url.trim_end_matches('/'),
        presigned.upload_url
    );
    let resp = http
        .put(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| TransportError::Io(format!("PUT blob: {e}")))?;
    let status = resp.status().as_u16();
    if status != 204 {
        let raw = resp.bytes().await.unwrap_or_default();
        return Err(relay_error("blob upload", status, &raw));
    }
    Ok(())
}

/// Mint a download capability for a previously-uploaded blob. 404 means the
/// blob hasn't landed in R2 (yet) — callers may retry later.
pub async fn presign_blob_download(
    http: &reqwest::Client,
    relay_url: &str,
    admission_key: &[u8; 32],
    room_id: &RoomId,
    envelope_id: &str,
) -> Result<PresignedDownload, TransportError> {
    let path = format!("/v2/rooms/{}/blobs/{}", room_id.as_str(), envelope_id);
    let url = format!("{}{}", relay_url.trim_end_matches('/'), path);
    let resp = http
        .get(&url)
        .header(
            "Attn-Admission",
            admission_header(admission_key, "GET", &path, &[]),
        )
        .send()
        .await
        .map_err(|e| TransportError::Io(format!("GET {url}: {e}")))?;
    let status = resp.status().as_u16();
    let raw = resp
        .bytes()
        .await
        .map_err(|e| TransportError::Io(format!("read presign body: {e}")))?;
    if status != 200 {
        return Err(relay_error("blob download presign", status, &raw));
    }
    serde_json::from_slice(&raw).map_err(|e| TransportError::Io(format!("decode presign: {e}")))
}

/// Fetch the sealed blob bytes via the presigned download URL.
pub async fn get_blob(
    http: &reqwest::Client,
    relay_url: &str,
    presigned: &PresignedDownload,
) -> Result<Vec<u8>, TransportError> {
    let url = format!(
        "{}{}",
        relay_url.trim_end_matches('/'),
        presigned.download_url
    );
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| TransportError::Io(format!("GET blob: {e}")))?;
    let status = resp.status().as_u16();
    let raw = resp
        .bytes()
        .await
        .map_err(|e| TransportError::Io(format!("read blob body: {e}")))?;
    if status != 200 {
        return Err(relay_error("blob download", status, &raw));
    }
    Ok(raw.to_vec())
}

/// Same canonical-request + HMAC construction as the mailbox transport and
/// bootstrap relay helpers (`METHOD \n path \n <empty query> \n SHA256(body)`)
/// so the relay's admission verifier reuses one code path. None of the blob
/// routes carry signed query parameters — the `?cap=` token on PUT/GET is
/// the capability itself, not an admission input.
fn admission_header(admission_key: &[u8; 32], method: &str, path: &str, body: &[u8]) -> String {
    let body_hash = Sha256::digest(body);
    let mut canonical = Vec::with_capacity(method.len() + path.len() + body_hash.len() + 3);
    canonical.extend_from_slice(method.to_ascii_uppercase().as_bytes());
    canonical.push(b'\n');
    canonical.extend_from_slice(path.as_bytes());
    canonical.push(b'\n');
    canonical.push(b'\n');
    canonical.extend_from_slice(&body_hash);
    let mut mac =
        <Hmac<Sha256>>::new_from_slice(admission_key).expect("HMAC accepts any key length");
    mac.update(&canonical);
    let tag = mac.finalize().into_bytes();
    format!("v2.{}", URL_SAFE_NO_PAD.encode(tag))
}

/// Translate a non-2xx relay response into a `TransportError` that keeps the
/// status + error code visible in logs.
fn relay_error(op: &str, status: u16, body: &[u8]) -> TransportError {
    #[derive(Deserialize)]
    struct ErrBody {
        error: ErrInner,
    }
    #[derive(Deserialize)]
    struct ErrInner {
        code: String,
        message: String,
    }
    match serde_json::from_slice::<ErrBody>(body) {
        Ok(parsed) => TransportError::Io(format!(
            "{op}: relay {status} {}: {}",
            parsed.error.code, parsed.error.message
        )),
        Err(_) => TransportError::Io(format!("{op}: relay {status} (body: {} bytes)", body.len())),
    }
}
