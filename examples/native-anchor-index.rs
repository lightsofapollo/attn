//! Test helper that proves the browser WASM output against the main native
//! `attn` library target rather than against the bridge crate itself.

use std::io::{self, Read};

use attn::review::anchors::build_anchor_index;
use attn::review::ids::SnapshotId;

fn main() {
    let snapshot_id = std::env::args()
        .nth(1)
        .expect("usage: native-anchor-index <snapshot-id>");
    let snapshot_id: SnapshotId =
        serde_json::from_value(serde_json::Value::String(snapshot_id)).expect("snapshot id");
    let mut markdown = Vec::new();
    io::stdin()
        .read_to_end(&mut markdown)
        .expect("read markdown from stdin");
    match build_anchor_index(&markdown, &snapshot_id) {
        Ok(index) => println!(
            "{}",
            serde_json::to_string(&index).expect("serialize anchor index")
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
