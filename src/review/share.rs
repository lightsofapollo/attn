//! Durable-share URL forms and strict fragment parsing.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use zeroize::Zeroize;

use crate::review::crypto::kdf::derive_share_epoch_room_secret;

const NATIVE_PREFIX: &str = "attn://share/";
const BROWSER_PATH_PREFIX: &str = "/s/";

pub struct ParsedShareInvite {
    pub share_id: String,
    pub share_secret: [u8; 32],
}

impl Drop for ParsedShareInvite {
    fn drop(&mut self) {
        self.share_secret.zeroize();
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
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "share secret must be canonical base64url".to_string())?;
    let share_secret: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| "share secret must decode to 32 bytes".to_string())?;
    if URL_SAFE_NO_PAD.encode(share_secret) != encoded {
        return Err("share secret must be canonical base64url".into());
    }
    Ok(ParsedShareInvite {
        share_id: share_id.to_string(),
        share_secret,
    })
}

fn validate_share_id(share_id: &str) -> Result<(), String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(share_id)
        .map_err(|_| "shareId must be canonical base64url".to_string())?;
    if decoded.len() != 16 || URL_SAFE_NO_PAD.encode(decoded) != share_id {
        return Err("shareId must be canonical base64url for 16 bytes".into());
    }
    Ok(())
}

pub fn build_native_share_invite(
    share_id: &str,
    share_secret: &[u8; 32],
) -> Result<String, String> {
    validate_share_id(share_id)?;
    Ok(format!(
        "{NATIVE_PREFIX}{share_id}#key={}",
        URL_SAFE_NO_PAD.encode(share_secret)
    ))
}

pub fn build_browser_share_invite(
    base_origin: &str,
    share_id: &str,
    share_secret: &[u8; 32],
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
        URL_SAFE_NO_PAD.encode(share_secret)
    )));
    Ok(url.to_string())
}

pub fn derive_epoch_room_secret(invite: &ParsedShareInvite, epoch: u64) -> [u8; 32] {
    *derive_share_epoch_room_secret(&invite.share_secret, epoch).as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

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
                .share_secret,
            secret
        );
        assert_eq!(
            parse_share_invite(&browser)
                .expect("parse browser")
                .share_secret,
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
    fn epochs_are_stable_and_distinct() {
        let invite = ParsedShareInvite {
            share_id: SHARE_ID.into(),
            share_secret: [0; 32],
        };
        assert_ne!(
            derive_epoch_room_secret(&invite, 0),
            derive_epoch_room_secret(&invite, 1)
        );
        assert_eq!(
            derive_epoch_room_secret(&invite, 0),
            derive_epoch_room_secret(&invite, 0)
        );
    }
}
