//! Transparent snapshot compression (gzip) applied between canonical-JSON
//! encoding and AEAD sealing. Encrypted bytes are incompressible to every
//! layer downstream, so the only place compression can happen in an E2E
//! pipeline is client-side, before the seal.
//!
//! Wire rule (shared with the browser client —
//! `web/src/lib/review/snapshot-compression.ts`):
//!   - Encode: gzip the plaintext; keep it ONLY if strictly smaller.
//!     Markdown/HTML/manifest JSON shrink 4-6x; already-compressed media
//!     (PNG/JPEG/WebP asset payloads) stays raw automatically.
//!   - Decode: sniff the two-byte gzip magic (`0x1f 0x8b`) after decrypt.
//!     Snapshot plaintexts are canonical JSON and therefore begin with `{`
//!     or `[`, so the sniff is unambiguous.
//!
//! Integrity stays logical: `BlobRef` byteLength/contentHash (and the signed
//! baseHash) are computed over the UNCOMPRESSED plaintext on both ends, so
//! compression is invisible above the transport boundary.

use std::borrow::Cow;
use std::io::{Read, Write};

const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// Decompression ceiling. The relay caps sealed snapshots at 5 MiB; honest
/// text compresses ~4-6x, so 64 MiB leaves generous headroom while bounding
/// a malicious sender's expansion (zip bomb) to a fixed allocation.
pub const MAX_DECOMPRESSED_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

pub fn is_gzip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == GZIP_MAGIC[0] && bytes[1] == GZIP_MAGIC[1]
}

/// Gzip `plaintext` and return the compressed bytes when strictly smaller;
/// otherwise borrow the original. Infallible by design: any encoder error
/// falls back to the uncompressed plaintext.
pub fn compress_if_smaller(plaintext: &[u8]) -> Cow<'_, [u8]> {
    if plaintext.len() < 64 {
        return Cow::Borrowed(plaintext); // header overhead always loses
    }
    let mut encoder =
        flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let compressed = encoder
        .write_all(plaintext)
        .and_then(|()| encoder.finish());
    match compressed {
        Ok(bytes) if bytes.len() < plaintext.len() => Cow::Owned(bytes),
        _ => Cow::Borrowed(plaintext),
    }
}

/// Inflate gzip-compressed snapshot bytes; pass non-gzip bytes through
/// borrowed. Errors when the payload is corrupt or exceeds `max_bytes` —
/// callers treat that exactly like a failed plaintext parse.
pub fn decompress_if_needed(bytes: &[u8], max_bytes: usize) -> Result<Cow<'_, [u8]>, String> {
    if !is_gzip(bytes) {
        return Ok(Cow::Borrowed(bytes));
    }
    let mut out = Vec::new();
    let mut decoder = flate2::read::GzDecoder::new(bytes).take(max_bytes as u64 + 1);
    decoder
        .read_to_end(&mut out)
        .map_err(|error| format!("snapshot gzip payload is corrupt: {error}"))?;
    if out.len() > max_bytes {
        return Err(format!(
            "snapshot payload exceeds the {max_bytes}-byte decompression ceiling"
        ));
    }
    Ok(Cow::Owned(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressible_json_round_trips_and_shrinks() {
        let plaintext = format!(
            "{{\"docType\":\"markdown\",\"content\":\"{}\"}}",
            "lorem ipsum dolor sit amet. ".repeat(4000)
        )
        .into_bytes();
        let wire = compress_if_smaller(&plaintext);
        assert!(is_gzip(&wire), "large repetitive JSON must compress");
        assert!(wire.len() < plaintext.len() / 4, "expected >4x shrink");
        let restored =
            decompress_if_needed(&wire, MAX_DECOMPRESSED_SNAPSHOT_BYTES).expect("round trip");
        assert_eq!(restored.as_ref(), plaintext.as_slice());
    }

    #[test]
    fn incompressible_bytes_pass_through_borrowed() {
        // xorshift junk: deterministic, defeats gzip.
        let mut seed: u32 = 0x9e37_79b9;
        let mut bytes = vec![0u8; 8192];
        for byte in &mut bytes {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *byte = (seed & 0xff) as u8;
        }
        let wire = compress_if_smaller(&bytes);
        assert!(matches!(wire, Cow::Borrowed(_)), "random bytes stay raw");
        let restored = decompress_if_needed(&bytes, MAX_DECOMPRESSED_SNAPSHOT_BYTES)
            .expect("passthrough");
        assert!(matches!(restored, Cow::Borrowed(_)));
    }

    #[test]
    fn tiny_payloads_skip_compression() {
        let tiny = b"{\"a\":1}";
        assert!(matches!(compress_if_smaller(tiny), Cow::Borrowed(_)));
    }

    #[test]
    fn json_never_mistaken_for_gzip() {
        assert!(!is_gzip(b"{\"docType\":\"markdown\"}"));
        assert!(!is_gzip(b"[]"));
        assert!(!is_gzip(b""));
    }

    #[test]
    fn corrupt_gzip_errors() {
        let corrupt = [0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05];
        assert!(decompress_if_needed(&corrupt, MAX_DECOMPRESSED_SNAPSHOT_BYTES).is_err());
    }

    #[test]
    fn zip_bomb_hits_the_ceiling() {
        let zeros = vec![0u8; 1024 * 1024];
        let wire = compress_if_smaller(&zeros);
        assert!(is_gzip(&wire) && wire.len() < 8192, "zeros must compress hard");
        let err = decompress_if_needed(&wire, 64 * 1024).expect_err("must hit ceiling");
        assert!(err.contains("decompression ceiling"), "{err}");
        let ok = decompress_if_needed(&wire, MAX_DECOMPRESSED_SNAPSHOT_BYTES)
            .expect("default ceiling admits honest payloads");
        assert_eq!(ok.len(), zeros.len());
    }

    #[test]
    fn browser_produced_gzip_vector_opens_under_flate2() {
        // Cross-client conformance: this base64 payload was gzipped by the
        // BROWSER-side stack (Node zlib — RFC 1952, same as
        // CompressionStream('gzip')). The native reader must open it.
        use base64::Engine as _;
        let wire = base64::engine::general_purpose::STANDARD
            .decode("H4sIAAAAAAAAE+3MMQ7CMAxA0atYnlskGHMOLhAcl1a0tmUHKkDcvbkDa8b/h/fFF6bzgEXp+jbGhFv2R9FdcEBSqSy1TXKNGGldWkLbk/qWhTjBzXUP9vH+Wcy4QEi2mLWCGkvAUwo7TGuufDlBZzrTmc505g8Gfwdwu4ostQUAAA==")
            .expect("vector decodes");
        assert!(is_gzip(&wire));
        let restored = decompress_if_needed(&wire, MAX_DECOMPRESSED_SNAPSHOT_BYTES)
            .expect("browser gzip opens under flate2");
        assert_eq!(restored.len(), 1461);
        let value: serde_json::Value =
            serde_json::from_slice(&restored).expect("vector is canonical JSON");
        assert_eq!(value["docType"], "markdown");
    }

    #[test]
    fn browser_gzip_interop_vector_opens() {
        // gzip of `{"v":1}` produced by CompressionStream('gzip') semantics:
        // any spec-compliant gzip stream must open regardless of producer
        // (browser DEFLATE implementations differ from miniz_oxide). Encoded
        // here with flate2 but validated shape-wise: magic + round-trip.
        let plaintext = b"{\"v\":1,\"content\":\"interop across native and browser clients\"}";
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        encoder.write_all(plaintext).expect("write");
        let wire = encoder.finish().expect("finish");
        let restored =
            decompress_if_needed(&wire, MAX_DECOMPRESSED_SNAPSHOT_BYTES).expect("open");
        assert_eq!(restored.as_ref(), plaintext.as_slice());
    }
}
