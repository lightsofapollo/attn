use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;

use super::canonical::{CanonError, to_canonical_bytes};
use super::signing::{DeviceSigningKey, DeviceVerifyingKey, SignError};

pub const DEVICE_WS_PROOF_PURPOSE_V3: &str = "attn device websocket proof v3";
pub const DEVICE_SIGNAL_PROOF_PURPOSE_V3: &str = "attn device signal proof v3";
pub const DEVICE_PROOF_LIFETIME_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceWebSocketProofV3 {
    pub expires_at: u64,
    pub nonce: String,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalDeviceWebSocketProofV3<'a> {
    device_id: &'a str,
    expires_at: u64,
    method: &'static str,
    nonce: &'a str,
    path: &'a str,
    purpose: &'static str,
    room_id: &'a str,
    v: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalDeviceSignalProofV3<'a> {
    author_id: &'a str,
    ciphertext: &'a str,
    ciphertext_bytes: u64,
    created_at: u64,
    device_id: &'a str,
    envelope_id: &'a str,
    expires_at: u64,
    generation: u64,
    nonce: &'a str,
    purpose: &'static str,
    room_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_class: Option<&'a str>,
    target_device_id: Option<&'a str>,
    v: u32,
}

#[allow(clippy::too_many_arguments)]
pub fn canonical_device_signal_proof_v3(
    room_id: &str,
    envelope_id: &str,
    author_id: &str,
    device_id: &str,
    target_device_id: Option<&str>,
    signal_class: Option<&str>,
    generation: u64,
    created_at: u64,
    expires_at: u64,
    nonce: &str,
    ciphertext: &str,
    ciphertext_bytes: u64,
) -> Result<Vec<u8>, CanonError> {
    to_canonical_bytes(&CanonicalDeviceSignalProofV3 {
        author_id,
        ciphertext,
        ciphertext_bytes,
        created_at,
        device_id,
        envelope_id,
        expires_at,
        generation,
        nonce,
        purpose: DEVICE_SIGNAL_PROOF_PURPOSE_V3,
        room_id,
        signal_class,
        target_device_id,
        v: 3,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn sign_device_signal_proof_v3(
    signing_key: &DeviceSigningKey,
    room_id: &str,
    envelope_id: &str,
    author_id: &str,
    device_id: &str,
    target_device_id: Option<&str>,
    signal_class: Option<&str>,
    generation: u64,
    created_at: u64,
    expires_at: u64,
    nonce: &str,
    ciphertext: &str,
    ciphertext_bytes: u64,
) -> Result<String, CanonError> {
    let canonical = canonical_device_signal_proof_v3(
        room_id,
        envelope_id,
        author_id,
        device_id,
        target_device_id,
        signal_class,
        generation,
        created_at,
        expires_at,
        nonce,
        ciphertext,
        ciphertext_bytes,
    )?;
    Ok(URL_SAFE_NO_PAD.encode(signing_key.sign_protocol_bytes(&canonical)))
}

#[allow(clippy::too_many_arguments)]
pub fn verify_device_signal_proof_v3(
    verifying_key: &DeviceVerifyingKey,
    signature: &str,
    room_id: &str,
    envelope_id: &str,
    author_id: &str,
    device_id: &str,
    target_device_id: Option<&str>,
    signal_class: Option<&str>,
    generation: u64,
    created_at: u64,
    expires_at: u64,
    nonce: &str,
    ciphertext: &str,
    ciphertext_bytes: u64,
) -> Result<(), String> {
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|error| format!("signal signature base64url: {error}"))?;
    let signature: [u8; 64] = signature_bytes.try_into().map_err(|bytes: Vec<u8>| {
        format!("signal signature must be 64 bytes, got {}", bytes.len())
    })?;
    let canonical = canonical_device_signal_proof_v3(
        room_id,
        envelope_id,
        author_id,
        device_id,
        target_device_id,
        signal_class,
        generation,
        created_at,
        expires_at,
        nonce,
        ciphertext,
        ciphertext_bytes,
    )
    .map_err(|error| format!("signal proof canonicalization: {error}"))?;
    verifying_key
        .verify_protocol_bytes(&canonical, &signature)
        .map_err(|error: SignError| format!("signal device signature: {error}"))
}

pub fn canonical_device_websocket_proof_v3(
    room_id: &str,
    device_id: &str,
    path: &str,
    expires_at: u64,
    nonce: &str,
) -> Result<Vec<u8>, CanonError> {
    to_canonical_bytes(&CanonicalDeviceWebSocketProofV3 {
        device_id,
        expires_at,
        method: "GET",
        nonce,
        path,
        purpose: DEVICE_WS_PROOF_PURPOSE_V3,
        room_id,
        v: 3,
    })
}

pub fn create_device_websocket_proof_v3(
    signing_key: &DeviceSigningKey,
    room_id: &str,
    device_id: &str,
    path: &str,
    now_ms: u64,
    nonce_bytes: &[u8; 16],
) -> Result<DeviceWebSocketProofV3, CanonError> {
    let expires_at = now_ms.saturating_add(DEVICE_PROOF_LIFETIME_MS);
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let canonical =
        canonical_device_websocket_proof_v3(room_id, device_id, path, expires_at, &nonce)?;
    Ok(DeviceWebSocketProofV3 {
        expires_at,
        nonce,
        signature: URL_SAFE_NO_PAD.encode(signing_key.sign_protocol_bytes(&canonical)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_shape_and_signature_are_pinned() {
        let key = DeviceSigningKey::from_bytes(&[0x11; 32]).unwrap();
        let proof = create_device_websocket_proof_v3(
            &key,
            "room-vector",
            "device-vector",
            "/v3/rooms/room-vector/socket",
            1_700_000_000_000,
            &[0x22; 16],
        )
        .unwrap();
        assert_eq!(proof.expires_at, 1_700_000_060_000);
        assert_eq!(proof.nonce, "IiIiIiIiIiIiIiIiIiIiIg");
        assert_eq!(
            proof.signature,
            "WoSwnColLautRZzjGUU2M9h0Fj2Tjz1uS2d2kqEISDfl-xLs8YpjBBQZG5ddK4EsRdCblGiio6QlT8qjMDMcCQ"
        );
        let canonical = canonical_device_websocket_proof_v3(
            "room-vector",
            "device-vector",
            "/v3/rooms/room-vector/socket",
            proof.expires_at,
            &proof.nonce,
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(canonical).unwrap(),
            "{\"deviceId\":\"device-vector\",\"expiresAt\":1700000060000,\"method\":\"GET\",\"nonce\":\"IiIiIiIiIiIiIiIiIiIiIg\",\"path\":\"/v3/rooms/room-vector/socket\",\"purpose\":\"attn device websocket proof v3\",\"roomId\":\"room-vector\",\"v\":3}"
        );
    }

    #[test]
    fn signal_vector_matches_browser_and_binds_target_and_key() {
        let key = DeviceSigningKey::from_bytes(&[0x11; 32]).unwrap();
        let signature = sign_device_signal_proof_v3(
            &key,
            "room-vector",
            "envelope-vector",
            "author-vector",
            "device-vector",
            Some("target-vector"),
            None,
            7,
            1_700_000_000_000,
            1_700_003_600_000,
            "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
            "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
            32,
        )
        .unwrap();
        assert_eq!(
            signature,
            "PbzT2GYKbUkXTMr8VdpNa-cGkfLXk8vZPOLF4C3fDZJij83iE7Aea4lQbhA1BFJlZGg-tRI2Fr_IgbNK4jzXAQ"
        );
        let verify = |verifying_key: &DeviceVerifyingKey, target: Option<&str>| {
            verify_device_signal_proof_v3(
                verifying_key,
                &signature,
                "room-vector",
                "envelope-vector",
                "author-vector",
                "device-vector",
                target,
                None,
                7,
                1_700_000_000_000,
                1_700_003_600_000,
                "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
                "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
                32,
            )
        };
        verify(&key.verifying_key(), Some("target-vector")).unwrap();
        assert!(verify(&key.verifying_key(), Some("rewritten")).is_err());
        let wrong = DeviceSigningKey::from_bytes(&[0x44; 32]).unwrap();
        assert!(verify(&wrong.verifying_key(), Some("target-vector")).is_err());
    }

    #[test]
    fn signal_proof_binds_replaceable_presence_class() {
        let key = DeviceSigningKey::from_bytes(&[0x21; 32]).unwrap();
        let signature = sign_device_signal_proof_v3(
            &key,
            "room-presence",
            "envelope-presence",
            "author-presence",
            "device-presence",
            None,
            Some("presence"),
            9,
            1_700_000_000_009,
            1_700_003_600_009,
            "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
            "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
            32,
        )
        .unwrap();
        assert_eq!(
            signature,
            "abvJIj3s-e19-N7f0ZH9B7skWw1YbrDGePpkeiOxr-aTSts2jRoiltjAmigTlV57HlLL6QGsWCGnIjuJh3TpDA"
        );
        verify_device_signal_proof_v3(
            &key.verifying_key(),
            &signature,
            "room-presence",
            "envelope-presence",
            "author-presence",
            "device-presence",
            None,
            Some("presence"),
            9,
            1_700_000_000_009,
            1_700_003_600_009,
            "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
            "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
            32,
        )
        .unwrap();
        assert!(
            verify_device_signal_proof_v3(
                &key.verifying_key(),
                &signature,
                "room-presence",
                "envelope-presence",
                "author-presence",
                "device-presence",
                None,
                None,
                9,
                1_700_000_000_009,
                1_700_003_600_009,
                "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi",
                "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
                32,
            )
            .is_err()
        );
    }
}
