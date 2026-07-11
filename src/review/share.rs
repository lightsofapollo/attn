//! Tier-safe durable-share links and sealed per-epoch room capabilities.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::review::crypto::canonical;
pub use crate::review::crypto::kdf::ShareLinkTier;

const NATIVE_PREFIX: &str = "attn://share/";
const BROWSER_PATH_PREFIX: &str = "/s/";

pub struct ParsedShareInvite {
    pub share_id: String,
    /// Tier-specific public bearer. The owner's share root is never in a URL.
    pub link_secret: [u8; 32],
}

impl Drop for ParsedShareInvite {
    fn drop(&mut self) {
        self.link_secret.zeroize();
    }
}

pub fn parse_share_invite(raw: &str) -> Result<ParsedShareInvite, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid share URL".to_string())?;
    if url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
    {
        return Err("share URL must not contain credentials, a port, or a query".into());
    }
    let share_id = if url.scheme() == "attn" && url.host_str() == Some("share") {
        url.path()
            .strip_prefix('/')
            .filter(|value| !value.is_empty() && !value.contains('/'))
            .ok_or_else(|| "native share URL must use attn://share/<shareId>".to_string())?
    } else if url.scheme() == "https" && url.host_str() == Some("attn.sh") {
        url.path()
            .strip_prefix(BROWSER_PATH_PREFIX)
            .filter(|value| !value.is_empty() && !value.contains('/'))
            .ok_or_else(|| "browser share URL must use /s/<shareId>".to_string())?
    } else {
        return Err("share URL must use attn://share or https://attn.sh".into());
    };
    let fragment = url
        .fragment()
        .ok_or_else(|| "missing share fragment".to_string())?;
    let canonical = if url.scheme() == "attn" {
        format!("{NATIVE_PREFIX}{share_id}#{fragment}")
    } else {
        format!("https://attn.sh{BROWSER_PATH_PREFIX}{share_id}#{fragment}")
    };
    if raw != canonical {
        return Err("share URL must use its exact canonical spelling".into());
    }
    parse_share_parts(share_id, fragment)
}

fn parse_share_parts(share_id: &str, fragment: &str) -> Result<ParsedShareInvite, String> {
    validate_share_id(share_id)?;
    let encoded = fragment
        .strip_prefix("key=")
        .ok_or_else(|| "share fragment must be exactly key=<secret>".to_string())?;
    if encoded.contains('&') || encoded.contains('=') {
        return Err("share fragment must contain one canonical key field".into());
    }
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "link secret must be canonical base64url".to_string())?,
    );
    let link_secret: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| "link secret must decode to 32 bytes".to_string())?;
    let canonical = Zeroizing::new(URL_SAFE_NO_PAD.encode(decoded.as_slice()));
    if canonical.as_str() != encoded {
        return Err("link secret must be canonical base64url".into());
    }
    Ok(ParsedShareInvite {
        share_id: share_id.to_string(),
        link_secret,
    })
}

fn validate_share_id(share_id: &str) -> Result<(), String> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(share_id)
            .map_err(|_| "shareId must be canonical base64url".to_string())?,
    );
    let canonical = Zeroizing::new(URL_SAFE_NO_PAD.encode(decoded.as_slice()));
    if decoded.len() != 16 || canonical.as_str() != share_id {
        return Err("shareId must be canonical base64url for 16 bytes".into());
    }
    Ok(())
}

pub fn build_native_share_invite(share_id: &str, link_secret: &[u8; 32]) -> Result<String, String> {
    validate_share_id(share_id)?;
    Ok(format!(
        "{NATIVE_PREFIX}{share_id}#key={}",
        URL_SAFE_NO_PAD.encode(link_secret)
    ))
}

pub fn build_browser_share_invite(
    base_origin: &str,
    share_id: &str,
    link_secret: &[u8; 32],
) -> Result<String, String> {
    validate_share_id(share_id)?;
    let mut url =
        reqwest::Url::parse(base_origin).map_err(|_| "invalid browser origin".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("attn.sh")
        || url.port().is_some()
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("browser origin must be a bare HTTPS origin".into());
    }
    url.set_path(&format!("/s/{share_id}"));
    url.set_fragment(Some(&format!(
        "key={}",
        URL_SAFE_NO_PAD.encode(link_secret)
    )));
    Ok(url.to_string())
}

const BUNDLE_PURPOSE: &str = "attn share capability bundle v3";
const BUNDLE_AAD_PREFIX: &[u8] = b"attn share sealed bundle v3\0";
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareCapabilityBundle {
    pub v: u8,
    pub purpose: String,
    pub bundle_id: String,
    pub owner_signing_key: String,
    pub share_id: String,
    pub epoch: u64,
    pub revision: u64,
    pub manifest_digest: String,
    pub tier: ShareLinkTier,
    pub room_id: String,
    pub read_capability_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_admission_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_signature: Option<String>,
}

impl Drop for ShareCapabilityBundle {
    fn drop(&mut self) {
        self.owner_signing_key.zeroize();
        self.bundle_id.zeroize();
        self.share_id.zeroize();
        self.room_id.zeroize();
        self.read_capability_key.zeroize();
        self.manifest_digest.zeroize();
        if let Some(value) = self.write_admission_key.as_mut() {
            value.zeroize();
        }
        if let Some(value) = self.grant_signature.as_mut() {
            value.zeroize();
        }
    }
}

fn canonical_b64_len(value: &str, bytes: usize, label: &str) -> Result<(), String> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| format!("{label} must be canonical base64url"))?,
    );
    let canonical = Zeroizing::new(URL_SAFE_NO_PAD.encode(decoded.as_slice()));
    if decoded.len() != bytes || canonical.as_str() != value {
        return Err(format!("{label} must encode exactly {bytes} bytes"));
    }
    Ok(())
}

fn validate_bundle(bundle: &ShareCapabilityBundle) -> Result<(), String> {
    if bundle.v != 3 || bundle.purpose != BUNDLE_PURPOSE {
        return Err("capability bundle version or purpose is invalid".into());
    }
    if bundle.revision > MAX_JSON_SAFE_INTEGER {
        return Err("capability bundle revision exceeds the JSON safe-integer range".into());
    }
    validate_share_id(&bundle.share_id)?;
    canonical_b64_len(&bundle.bundle_id, 16, "bundleId")?;
    canonical_b64_len(&bundle.manifest_digest, 32, "manifestDigest")?;
    canonical_b64_len(&bundle.room_id, 16, "roomId")?;
    canonical_b64_len(&bundle.owner_signing_key, 32, "ownerSigningKey")?;
    canonical_b64_len(&bundle.read_capability_key, 32, "readCapabilityKey")?;
    match bundle.tier {
        ShareLinkTier::View => {
            if bundle.write_admission_key.is_some() || bundle.grant_signature.is_some() {
                return Err("view bundle must not contain write capability or grant".into());
            }
        }
        ShareLinkTier::Comment | ShareLinkTier::Suggest => {
            canonical_b64_len(
                bundle
                    .write_admission_key
                    .as_deref()
                    .ok_or_else(|| "writable bundle missing write capability".to_string())?,
                32,
                "writeAdmissionKey",
            )?;
            canonical_b64_len(
                bundle
                    .grant_signature
                    .as_deref()
                    .ok_or_else(|| "writable bundle missing grant".to_string())?,
                64,
                "grantSignature",
            )?;
        }
    }
    Ok(())
}

fn bundle_aad(share_id: &str, bundle_id: &str) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(BUNDLE_AAD_PREFIX.len() + share_id.len() + bundle_id.len() + 1);
    aad.extend_from_slice(BUNDLE_AAD_PREFIX);
    aad.extend_from_slice(share_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(bundle_id.as_bytes());
    aad
}

/// Deterministic seam for vectors. Production callers must supply a fresh
/// CSPRNG nonce; the wire value is base64url(nonce || ciphertext || tag).
pub fn seal_capability_bundle_with_nonce(
    bundle_key: &[u8; 32],
    bundle_id: &str,
    bundle: &ShareCapabilityBundle,
    nonce: &[u8; 24],
) -> Result<String, String> {
    canonical_b64_len(bundle_id, 16, "bundleId")?;
    validate_bundle(bundle)?;
    if bundle.bundle_id != bundle_id {
        return Err("capability bundle id mismatch".into());
    }
    let plaintext =
        Zeroizing::new(canonical::to_canonical_bytes(bundle).map_err(|error| error.to_string())?);
    let cipher = XChaCha20Poly1305::new(bundle_key.into());
    let ciphertext = cipher
        .encrypt(
            nonce.into(),
            Payload {
                msg: &plaintext,
                aad: &bundle_aad(&bundle.share_id, bundle_id),
            },
        )
        .map_err(|_| "capability bundle seal failed".to_string())?;
    let mut sealed = Vec::with_capacity(24 + ciphertext.len());
    sealed.extend_from_slice(nonce);
    sealed.extend_from_slice(&ciphertext);
    Ok(URL_SAFE_NO_PAD.encode(sealed))
}

pub struct ShareBundleContext<'a> {
    pub bundle_id: &'a str,
    pub share_id: &'a str,
    pub epoch: u64,
    pub revision: u64,
    pub manifest_digest: &'a str,
    pub tier: ShareLinkTier,
}

pub fn open_capability_bundle(
    bundle_key: &[u8; 32],
    expected: &ShareBundleContext<'_>,
    sealed_bundle: &str,
) -> Result<ShareCapabilityBundle, String> {
    canonical_b64_len(expected.bundle_id, 16, "bundleId")?;
    canonical_b64_len(expected.manifest_digest, 32, "manifestDigest")?;
    validate_share_id(expected.share_id)?;
    let sealed = URL_SAFE_NO_PAD
        .decode(sealed_bundle)
        .map_err(|_| "sealed bundle must be canonical base64url".to_string())?;
    if sealed.len() < 24 + 16 || URL_SAFE_NO_PAD.encode(&sealed) != sealed_bundle {
        return Err("sealed bundle is truncated or noncanonical".into());
    }
    let (nonce, ciphertext) = sealed.split_at(24);
    let cipher = XChaCha20Poly1305::new(bundle_key.into());
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                nonce.into(),
                Payload {
                    msg: ciphertext,
                    aad: &bundle_aad(expected.share_id, expected.bundle_id),
                },
            )
            .map_err(|_| "capability bundle open failed".to_string())?,
    );
    let bundle: ShareCapabilityBundle = serde_json::from_slice(&plaintext)
        .map_err(|_| "capability bundle plaintext is invalid".to_string())?;
    validate_bundle(&bundle)?;
    if bundle.bundle_id != expected.bundle_id
        || bundle.share_id != expected.share_id
        || bundle.epoch != expected.epoch
        || bundle.revision != expected.revision
        || bundle.manifest_digest != expected.manifest_digest
        || bundle.tier != expected.tier
    {
        return Err("capability bundle context mismatch".into());
    }
    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::crypto::kdf::{ShareLinkKeys, derive_share_link_keys};

    const SHARE_ID: &str = "AAECAwQFBgcICQoLDA0ODw";

    #[test]
    fn native_and_browser_urls_round_trip_exactly() {
        let secret = [0x42; 32];
        let native = build_native_share_invite(SHARE_ID, &secret).expect("native");
        let browser =
            build_browser_share_invite("https://attn.sh", SHARE_ID, &secret).expect("browser");
        assert_eq!(
            parse_share_invite(&native)
                .expect("parse native")
                .link_secret,
            secret
        );
        assert_eq!(
            parse_share_invite(&browser)
                .expect("parse browser")
                .link_secret,
            secret
        );
        assert_eq!(
            browser,
            format!(
                "https://attn.sh/s/{SHARE_ID}#key={}",
                URL_SAFE_NO_PAD.encode(secret)
            )
        );
    }

    #[test]
    fn rejects_noncanonical_or_ambiguous_forms() {
        let secret = URL_SAFE_NO_PAD.encode([7u8; 32]);
        for invalid in [
            format!("attn://share/short#key={secret}"),
            format!("attn://share/{SHARE_ID}#other={secret}"),
            format!("attn://share/{SHARE_ID}#key={secret}&x=1"),
            format!("http://attn.sh/s/{SHARE_ID}#key={secret}"),
            format!("https://attn.sh/s/{SHARE_ID}/extra#key={secret}"),
            format!("https://evil.example/s/{SHARE_ID}#key={secret}"),
            format!("https://attn.sh/s/{SHARE_ID}?ignored=1#key={secret}"),
            format!("attn://user:pass@share/{SHARE_ID}#key={secret}"),
            format!("attn://share/{SHARE_ID}?ignored=1#key={secret}"),
            format!("attn://share/{SHARE_ID}?#key={secret}"),
            format!("https://attn.sh:443/s/{SHARE_ID}#key={secret}"),
        ] {
            assert!(parse_share_invite(&invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn fragment_is_a_link_secret_not_the_owner_share_root() {
        let link_secret = [0x31; 32];
        let invite =
            parse_share_invite(&build_native_share_invite(SHARE_ID, &link_secret).expect("invite"))
                .expect("parse");
        assert_eq!(invite.link_secret, link_secret);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CapabilityCorpus {
        version: u8,
        share_secret: String,
        share_id: String,
        epoch: u64,
        vectors: Vec<CapabilityVector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CapabilityVector {
        tier: ShareLinkTier,
        link_secret: String,
        bundle_key: String,
        bundle_id: String,
        read_admission_key: String,
        write_admission_key: Option<String>,
        nonce: Option<String>,
        bundle: Option<ShareCapabilityBundle>,
        sealed_bundle: Option<String>,
    }

    fn assert_link_vector(keys: &ShareLinkKeys, vector: &CapabilityVector) {
        assert_eq!(
            URL_SAFE_NO_PAD.encode(keys.link_secret.as_bytes()),
            vector.link_secret
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(keys.bundle_key.as_bytes()),
            vector.bundle_key
        );
        assert_eq!(keys.bundle_id, vector.bundle_id);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(keys.read_admission_key.as_bytes()),
            vector.read_admission_key
        );
        assert_eq!(
            keys.write_admission_key
                .as_ref()
                .map(|key| URL_SAFE_NO_PAD.encode(key.as_bytes())),
            vector.write_admission_key,
        );
    }

    #[test]
    fn shared_capability_corpus_matches_kdf_and_sealed_bytes() {
        let corpus: CapabilityCorpus = serde_json::from_str(include_str!(
            "../../planning/collab/test-vectors/share-capabilities-v3.json"
        ))
        .expect("share capability corpus");
        assert_eq!(corpus.version, 2);
        assert_eq!(corpus.vectors.len(), 3);
        let root: [u8; 32] = URL_SAFE_NO_PAD
            .decode(&corpus.share_secret)
            .expect("share root")
            .try_into()
            .expect("32 byte share root");
        for vector in corpus.vectors {
            let keys = derive_share_link_keys(&root, vector.tier);
            assert_link_vector(&keys, &vector);
            if let (Some(nonce), Some(bundle), Some(expected_sealed)) =
                (&vector.nonce, &vector.bundle, &vector.sealed_bundle)
            {
                let nonce: [u8; 24] = URL_SAFE_NO_PAD
                    .decode(nonce)
                    .expect("nonce")
                    .try_into()
                    .expect("24 byte nonce");
                let sealed = seal_capability_bundle_with_nonce(
                    keys.bundle_key.as_bytes(),
                    &keys.bundle_id,
                    bundle,
                    &nonce,
                )
                .expect("seal vector");
                assert_eq!(&sealed, expected_sealed);
                let context = ShareBundleContext {
                    bundle_id: &keys.bundle_id,
                    share_id: &corpus.share_id,
                    epoch: corpus.epoch,
                    revision: bundle.revision,
                    manifest_digest: &bundle.manifest_digest,
                    tier: vector.tier,
                };
                let opened = open_capability_bundle(keys.bundle_key.as_bytes(), &context, &sealed)
                    .expect("open vector");
                assert_eq!(opened.room_id, bundle.room_id);
                assert_eq!(opened.read_capability_key, bundle.read_capability_key);
                assert_eq!(opened.write_admission_key, bundle.write_admission_key);
                assert_eq!(opened.grant_signature, bundle.grant_signature);
            }
        }
    }

    #[test]
    fn bundle_revision_must_fit_the_cross_runtime_safe_integer_range() {
        let mut corpus: CapabilityCorpus = serde_json::from_str(include_str!(
            "../../planning/collab/test-vectors/share-capabilities-v3.json"
        ))
        .expect("share capability corpus");
        let vector = corpus
            .vectors
            .iter_mut()
            .find(|vector| vector.bundle.is_some())
            .expect("writable vector");
        let bundle = vector.bundle.as_mut().expect("bundle");
        bundle.revision = MAX_JSON_SAFE_INTEGER + 1;
        let key = [0u8; 32];
        let nonce = [0u8; 24];
        assert!(
            seal_capability_bundle_with_nonce(&key, &vector.bundle_id, bundle, &nonce,).is_err()
        );
    }
}
