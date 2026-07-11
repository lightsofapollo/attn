use std::io::{self, Read};

fn main() {
    let snapshot_id = std::env::args()
        .nth(1)
        .expect("usage: native-anchor-index <snapshot-id>");
    let mut markdown = Vec::new();
    io::stdin()
        .read_to_end(&mut markdown)
        .expect("read markdown from stdin");
    match attn_anchor_wasm::build_anchor_index_json_native(&markdown, &snapshot_id) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
