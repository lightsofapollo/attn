//! Canonical JSON per RFC 8785 (JCS subset).
//!
//! Used for everything that is signed, hashed-into-an-ID, or used as AEAD AAD.
//! See `planning/collab/crypto-spec.md` §Canonical JSON for the exact rules.
//!
//! Summary of the rules this module enforces:
//! 1. Object keys are sorted ASCII-ascending at every nesting level
//!    (capital letters before lowercase).
//! 2. No insignificant whitespace.
//! 3. UTF-8 encoded, no BOM (Rust `String` is UTF-8 by definition).
//! 4. String escapes are minimal: `\u00XX` for control chars (U+0000..U+001F),
//!    `\"` for U+0022, `\\` for U+005C. Non-ASCII characters (BMP and
//!    supplementary, including emoji) are emitted as raw UTF-8 bytes — no
//!    `\uXXXX` escapes, no surrogate-pair escapes.
//! 5. Numbers go through `serde_json`'s own formatter. In v2 signed payloads
//!    we restrict ourselves to integers (timestamps are integer ms, counts are
//!    integers) so we don't touch float-format edge cases.
//! 6. `null` is `null`, but in OBJECTS absent fields are *omitted* — they must
//!    not appear as `"key": null`. For typed input the caller's
//!    `#[serde(skip_serializing_if = "Option::is_none")]` handles this; for
//!    `serde_json::Value` input we drop `Null` entries from objects recursively.
//!    (Nulls inside ARRAYS are preserved — dropping them would change array
//!    length and break index-sensitive semantics.)

use std::fmt::{self, Write as _};

use serde::Serialize;
use serde_json::{Map, Value};

/// Errors returned by the canonical-JSON helpers.
#[derive(Debug)]
pub enum CanonError {
    /// `serde_json` could not serialize the value to its in-memory `Value`
    /// representation (e.g. a `Serialize` impl returned an error, or the
    /// value contained a non-finite float).
    Serialize(serde_json::Error),
    /// A number was encountered that cannot be represented in JSON
    /// (NaN or +/-Infinity). We bubble this up rather than silently
    /// emit `null` like `serde_json` does by default.
    NonFiniteNumber,
}

impl fmt::Display for CanonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialize(e) => write!(f, "canonical-json serialize error: {e}"),
            Self::NonFiniteNumber => write!(f, "canonical-json: non-finite number (NaN/Infinity)"),
        }
    }
}

impl std::error::Error for CanonError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Serialize(e) => Some(e),
            Self::NonFiniteNumber => None,
        }
    }
}

impl From<serde_json::Error> for CanonError {
    fn from(e: serde_json::Error) -> Self {
        Self::Serialize(e)
    }
}

/// Serialize any `Serialize` value to canonical JSON bytes.
///
/// Equivalent to [`to_canonical_string`] followed by `.into_bytes()`, but
/// expressed as a thin wrapper so signers, hashers, and AEAD code can take
/// `&[u8]` without an extra allocation in the caller.
pub fn to_canonical_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, CanonError> {
    to_canonical_string(value).map(String::into_bytes)
}

/// Serialize any `Serialize` value to a canonical JSON `String`.
///
/// The value is first lowered to `serde_json::Value` so the canonicalizer has
/// random access to object entries (needed for key sorting) and so we can
/// apply the drop-null-in-object rule uniformly.
///
/// This intentionally relies on the caller's serde annotations
/// (`skip_serializing_if = "Option::is_none"`) for typed structs — if a caller
/// forgets that annotation, the resulting `null` entry will be DROPPED here
/// to keep the canonical form consistent. (`canonicalize_value` does the same
/// for raw `Value` input.)
pub fn to_canonical_string<T: Serialize>(value: &T) -> Result<String, CanonError> {
    let v = serde_json::to_value(value)?;
    let mut out = String::new();
    write_value(&v, &mut out)?;
    Ok(out)
}

/// Re-canonicalize a `serde_json::Value` (useful when the caller already has
/// parsed JSON in hand — for instance, when verifying a signature on bytes
/// received over the wire).
///
/// This applies the same rules as [`to_canonical_string`], including the
/// drop-null-in-object recursion.
pub fn canonicalize_value(value: &Value) -> Result<String, CanonError> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

/// Recursively emit a value in canonical form into `out`.
fn write_value(value: &Value, out: &mut String) -> Result<(), CanonError> {
    match value {
        Value::Null => {
            out.push_str("null");
            Ok(())
        }
        Value::Bool(b) => {
            out.push_str(if *b { "true" } else { "false" });
            Ok(())
        }
        Value::Number(n) => write_number(n, out),
        Value::String(s) => {
            write_string(s, out);
            Ok(())
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                // Nulls in arrays are preserved — removing them would change
                // array indices and break index-sensitive semantics.
                write_value(item, out)?;
            }
            out.push(']');
            Ok(())
        }
        Value::Object(map) => write_object(map, out),
    }
}

/// Emit an object: drop `Null` entries, then sort the remaining keys
/// ASCII-ascending and recurse.
fn write_object(map: &Map<String, Value>, out: &mut String) -> Result<(), CanonError> {
    // Collect non-null entries.
    let mut entries: Vec<(&str, &Value)> = map
        .iter()
        .filter(|(_, v)| !matches!(v, Value::Null))
        .map(|(k, v)| (k.as_str(), v))
        .collect();

    // ASCII-ascending sort. `str::cmp` on Rust strings compares byte-by-byte,
    // and since JSON object keys are UTF-8 the bytewise order matches the
    // codepoint order — which for ASCII keys is the ASCII order required by
    // the spec ('A' = 0x41 < 'a' = 0x61). For non-ASCII keys (rare in our
    // schemas, but legal) this gives a stable, deterministic order that any
    // other JCS-conformant implementation will also produce.
    entries.sort_unstable_by(|(a, _), (b, _)| a.as_bytes().cmp(b.as_bytes()));

    out.push('{');
    for (i, (k, v)) in entries.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(k, out);
        out.push(':');
        write_value(v, out)?;
    }
    out.push('}');
    Ok(())
}

/// Emit a JSON string with the minimal-escape rules from the spec.
///
/// Only the following characters are escaped:
/// - U+0022 QUOTATION MARK  → `\"`
/// - U+005C REVERSE SOLIDUS → `\\`
/// - U+0000..U+001F         → `\u00XX` (lowercase hex)
///
/// Everything else — including DEL (U+007F), all non-ASCII characters, and
/// emoji — is emitted as raw UTF-8.
fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                // \u00XX with lowercase hex digits.
                // RFC 8785 §3.2.2.2 mandates lowercase hex.
                write!(out, "\\u{:04x}", c as u32).expect("write to String is infallible");
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Emit a JSON number. We defer to `serde_json::Number`'s own formatter,
/// which already produces the shortest round-trip representation for both
/// integers and floats. We reject NaN/Infinity explicitly (though serde_json
/// already refuses to construct a `Number` from non-finite floats, this is
/// defensive — `as_f64` could return non-finite if a future serde_json
/// version relaxes its invariants).
fn write_number(n: &serde_json::Number, out: &mut String) -> Result<(), CanonError> {
    if let Some(f) = n.as_f64()
        && !f.is_finite()
    {
        return Err(CanonError::NonFiniteNumber);
    }
    // serde_json formats integers as plain digits ("42", "-1", "9007199254740991")
    // and floats per ECMA-404. We never re-format ourselves — that's where
    // implementations typically diverge.
    write!(out, "{n}").expect("write to String is infallible");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;
    use serde_json::json;

    // ---- basic shapes ---------------------------------------------------

    #[test]
    fn empty_object() {
        assert_eq!(canonicalize_value(&json!({})).unwrap(), "{}");
    }

    #[test]
    fn empty_array() {
        assert_eq!(canonicalize_value(&json!([])).unwrap(), "[]");
    }

    #[test]
    fn primitives() {
        assert_eq!(canonicalize_value(&json!(null)).unwrap(), "null");
        assert_eq!(canonicalize_value(&json!(true)).unwrap(), "true");
        assert_eq!(canonicalize_value(&json!(false)).unwrap(), "false");
        assert_eq!(canonicalize_value(&json!(0)).unwrap(), "0");
        assert_eq!(canonicalize_value(&json!("")).unwrap(), "\"\"");
    }

    // ---- key sorting (the bedrock invariant) ----------------------------

    #[test]
    fn keys_sort_ascii_ascending_capitals_before_lowercase() {
        // 'A' (0x41) sorts before 'a' (0x61), which sorts before 'b' (0x62).
        let v = json!({"b": 1, "A": 2, "a": 3});
        assert_eq!(canonicalize_value(&v).unwrap(), "{\"A\":2,\"a\":3,\"b\":1}");
    }

    #[test]
    fn nested_objects_keys_sorted_at_each_level() {
        let v = json!({
            "b": 2,
            "a": {"y": [3, 2, 1], "x": "hi"},
        });
        assert_eq!(
            canonicalize_value(&v).unwrap(),
            "{\"a\":{\"x\":\"hi\",\"y\":[3,2,1]},\"b\":2}"
        );
    }

    // ---- string escaping ------------------------------------------------

    #[test]
    fn string_embedded_quote_and_backslash() {
        // Input string is the 5 characters:  x  "  y  \  z
        let v = json!("x\"y\\z");
        assert_eq!(canonicalize_value(&v).unwrap(), "\"x\\\"y\\\\z\"");
    }

    #[test]
    fn string_with_newline_uses_unicode_escape_not_shorthand() {
        // RFC 8785 mandates \u00XX form for all control chars — never \n / \t / \r.
        let v = json!("a\nb");
        assert_eq!(canonicalize_value(&v).unwrap(), "\"a\\u000ab\"");
    }

    #[test]
    fn string_with_tab_carriage_return_and_null_byte() {
        // Tab = U+0009, CR = U+000D, NUL = U+0000 — all rendered as \u00XX.
        let v = json!("\t\r\u{0000}");
        assert_eq!(canonicalize_value(&v).unwrap(), "\"\\u0009\\u000d\\u0000\"");
    }

    #[test]
    fn string_with_unit_separator_uses_unicode_escape() {
        // U+001F is the highest codepoint that JCS still escapes — boundary case.
        let v = json!("\u{001F}");
        assert_eq!(canonicalize_value(&v).unwrap(), "\"\\u001f\"");
    }

    #[test]
    fn string_emoji_emitted_as_raw_utf8() {
        // Emoji is U+1F680 (4 UTF-8 bytes). It must NOT be escaped.
        let v = json!("hello 🚀");
        assert_eq!(canonicalize_value(&v).unwrap(), "\"hello \u{1F680}\"");
    }

    #[test]
    fn string_non_ascii_accents_emitted_raw() {
        // Greek letters are above the ASCII range; they stay raw UTF-8.
        let v = json!("αβγ");
        assert_eq!(canonicalize_value(&v).unwrap(), "\"αβγ\"");
    }

    #[test]
    fn string_del_byte_is_not_a_control_char_for_jcs() {
        // DEL (U+007F) is technically a control character in the Unicode
        // sense, but JCS §3.2.2.2 only escapes U+0000..U+001F. DEL passes
        // through as a raw byte.
        let v = json!("\u{007F}");
        assert_eq!(canonicalize_value(&v).unwrap(), "\"\u{007F}\"");
    }

    // ---- null dropping in objects (rule #6) -----------------------------

    #[test]
    fn object_null_value_dropped_via_canonicalize_value() {
        let v = json!({"x": null, "y": 1});
        assert_eq!(canonicalize_value(&v).unwrap(), "{\"y\":1}");
    }

    #[test]
    fn nested_object_nulls_dropped_recursively() {
        let v = json!({"a": {"b": null, "c": 2}});
        assert_eq!(canonicalize_value(&v).unwrap(), "{\"a\":{\"c\":2}}");
    }

    #[test]
    fn object_all_null_becomes_empty_object() {
        let v = json!({"a": null, "b": null});
        assert_eq!(canonicalize_value(&v).unwrap(), "{}");
    }

    #[test]
    fn array_nulls_preserved() {
        // Arrays must NOT drop nulls — index semantics matter.
        let v = json!([1, null, 2]);
        assert_eq!(canonicalize_value(&v).unwrap(), "[1,null,2]");
    }

    #[test]
    fn typed_struct_with_skip_serializing_if_drops_null() {
        #[derive(Serialize)]
        struct Meta {
            id: &'static str,
            #[serde(skip_serializing_if = "Option::is_none")]
            snapshot_id: Option<&'static str>,
        }
        let m = Meta {
            id: "evt-1",
            snapshot_id: None,
        };
        assert_eq!(to_canonical_string(&m).unwrap(), "{\"id\":\"evt-1\"}");
    }

    #[test]
    fn typed_struct_without_skip_still_drops_null_via_post_process() {
        // Even if a caller forgets `skip_serializing_if`, the canonicalizer
        // still drops the resulting null entry — keeps the canonical form
        // consistent regardless of the input path.
        #[derive(Serialize)]
        struct Meta {
            id: &'static str,
            snapshot_id: Option<&'static str>,
        }
        let m = Meta {
            id: "evt-1",
            snapshot_id: None,
        };
        assert_eq!(to_canonical_string(&m).unwrap(), "{\"id\":\"evt-1\"}");
    }

    // ---- numbers --------------------------------------------------------

    #[test]
    fn integer_never_gets_decimal_point() {
        assert_eq!(canonicalize_value(&json!(42)).unwrap(), "42");
        assert_eq!(canonicalize_value(&json!(-1)).unwrap(), "-1");
        assert_eq!(canonicalize_value(&json!(0)).unwrap(), "0");
    }

    #[test]
    fn max_safe_integer_formatted_as_plain_decimal() {
        // 2^53 - 1, the largest integer JS can represent exactly. We must
        // emit it verbatim — no exponent form.
        assert_eq!(
            canonicalize_value(&json!(9_007_199_254_740_991_i64)).unwrap(),
            "9007199254740991"
        );
    }

    // ---- to_canonical_bytes wrapper ------------------------------------

    #[test]
    fn to_canonical_bytes_matches_to_canonical_string() {
        let v = json!({"b": 1, "a": 2});
        let s = to_canonical_string(&v).unwrap();
        let b = to_canonical_bytes(&v).unwrap();
        assert_eq!(b, s.into_bytes());
    }

    #[test]
    fn output_is_valid_utf8_with_no_bom() {
        let v = json!({"emoji": "🚀"});
        let bytes = to_canonical_bytes(&v).unwrap();
        // No UTF-8 BOM (EF BB BF) at the start.
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        // Round-trips through UTF-8.
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(s.contains("🚀"));
    }

    // ---- cross-implementation test-vector corpus ------------------------

    /// Compile-time-embedded corpus shared with the (future) TS/WASM client.
    /// See `planning/collab/test-vectors/canonical-json.jsonl` and the
    /// neighboring README for the format contract.
    const CORPUS: &str = include_str!("../../../planning/collab/test-vectors/canonical-json.jsonl");

    #[test]
    fn test_vector_corpus_round_trip() {
        let mut checked = 0usize;
        for (lineno, line) in CORPUS.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("corpus line {} is not JSON: {e}", lineno + 1));
            // Skip the schema header.
            if v.get("_schema").is_some() {
                continue;
            }
            let canonical = v
                .get("canonical")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("corpus line {} missing `canonical`", lineno + 1));
            let input = v
                .get("input")
                .unwrap_or_else(|| panic!("corpus line {} missing `input`", lineno + 1));
            let actual = canonicalize_value(input).unwrap_or_else(|e| {
                panic!("corpus line {} failed to canonicalize: {e}", lineno + 1)
            });
            // Pending entries are explicitly excluded from byte equality but
            // we still assert the input canonicalizes without error.
            if canonical == "__PENDING__" {
                continue;
            }
            assert_eq!(
                actual,
                canonical,
                "corpus line {} ({}) — canonical mismatch",
                lineno + 1,
                v.get("name").and_then(Value::as_str).unwrap_or("<no name>")
            );
            checked += 1;
        }
        // The corpus must contain at least 8 real (non-pending) entries
        // — fewer means we've lost regression coverage.
        assert!(
            checked >= 8,
            "expected >= 8 non-pending corpus entries, got {checked}"
        );
    }
}
