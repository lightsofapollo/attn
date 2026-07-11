//! Browser bridge for attn's canonical Rust/comrak anchor indexer.
//!
//! The indexing algorithm is compiled directly from
//! `src/review/anchors/index.rs`. The modules below are deliberately small
//! compatibility shims for the native types that source file consumes.

#![allow(unused_imports)]

use wasm_bindgen::prelude::*;

pub mod review {
    pub mod ids {
        use serde::{Deserialize, Serialize};

        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub struct SnapshotId(String);

        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub struct ContentHash(String);
    }

    pub mod crypto {
        pub mod ids {
            use base64::Engine;
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            use serde::Deserialize;
            use sha2::{Digest, Sha256};

            use crate::review::ids::ContentHash;

            fn id_from_string<T: for<'de> Deserialize<'de>>(value: String) -> T {
                serde_json::from_value(serde_json::Value::String(value))
                    .expect("base64url content hash deserializes")
            }

            pub fn content_hash(canonical_bytes: &[u8]) -> ContentHash {
                let digest = Sha256::digest(canonical_bytes);
                id_from_string(URL_SAFE_NO_PAD.encode(digest))
            }
        }
    }

    pub mod model {
        use serde::{Deserialize, Serialize};

        use crate::review::ids::ContentHash;

        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct AnchorIndex {
            pub doc_hash: ContentHash,
            pub canonical_encoding: CanonicalEncoding,
            pub line_count: u32,
            pub blocks: Vec<AnchorBlock>,
            pub headings: Vec<AnchorHeading>,
        }

        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum CanonicalEncoding {
            #[serde(rename = "utf8-bytes")]
            Utf8Bytes,
        }

        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct AnchorBlock {
            pub snapshot_block_id: String,
            pub content_fingerprint: String,
            pub kind: AnchorBlockKind,
            pub byte_range: [u64; 2],
            pub line_range: [u32; 2],
            #[serde(skip_serializing_if = "Option::is_none")]
            pub pm_range: Option<[u32; 2]>,
            pub heading_path: Vec<AnchorHeadingRef>,
            pub ordinal_in_parent: u32,
            pub duplicate_ordinal: u32,
            pub text_hash: String,
            pub normalized_text_hash: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            pub previous_block_hash: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            pub next_block_hash: Option<String>,
        }

        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum AnchorBlockKind {
            Heading,
            Paragraph,
            ListItem,
            CodeBlock,
            Blockquote,
            Table,
            ThematicBreak,
            Html,
            Math,
            Mermaid,
            Unknown,
        }

        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct AnchorHeading {
            pub level: u32,
            pub text: String,
            pub text_hash: String,
            pub line: u32,
            pub byte_range: [u64; 2],
            pub path: Vec<AnchorHeadingRef>,
        }

        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct AnchorHeadingRef {
            pub level: u32,
            pub text_hash: String,
            pub ordinal_at_level: u32,
        }
    }
}

// Keep this at crate root so the path is resolved from this file while the
// included source continues resolving `crate::review::*` exactly as native.
#[path = "../../../src/review/anchors/index.rs"]
pub mod native_anchor_index;

use review::ids::SnapshotId;

/// Host-callable form used by the native/WASM equivalence test.
pub fn build_anchor_index_json_native(
    markdown_bytes: &[u8],
    snapshot_id: &str,
) -> Result<String, String> {
    let snapshot_id =
        serde_json::from_value::<SnapshotId>(serde_json::Value::String(snapshot_id.to_owned()))
            .map_err(|error| format!("invalid snapshot id: {error}"))?;
    let index = native_anchor_index::build_anchor_index(markdown_bytes, &snapshot_id)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&index).map_err(|error| format!("serialize anchor index: {error}"))
}

/// Build the canonical native `AnchorIndex` and return its exact wire JSON.
#[wasm_bindgen]
pub fn build_anchor_index_json(
    markdown_bytes: &[u8],
    snapshot_id: &str,
) -> Result<String, JsValue> {
    build_anchor_index_json_native(markdown_bytes, snapshot_id)
        .map_err(|error| JsValue::from_str(&error))
}

#[cfg(test)]
mod bridge_tests {
    use super::build_anchor_index_json_native;

    #[test]
    fn bridge_rejects_invalid_utf8() {
        let error = build_anchor_index_json_native(&[0xff, 0xfe], "snapshot-test")
            .expect_err("invalid UTF-8 must fail");
        assert_eq!(error, "invalid UTF-8 in markdown bytes");
    }
}
