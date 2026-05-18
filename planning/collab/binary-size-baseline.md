# Binary-size baseline (post crypto crates, pre webrtc-rs)

Captured for `attn-nnj.1.1`. This is the reference point the Phase 4 webrtc-rs
issue (`attn-nnj.7.1`) compares against to keep the WebRTC dependency cost
visible.

## Snapshot

- **Date**: 2026-05-18
- **Commit (rebased onto)**: `bb7cd140b96eeb32a30472292e819a10b25d8f00` (collab)
- **Platform**: `Darwin arm64` (aarch64-apple-darwin host)
- **Rust profile defaults**: as committed (no LTO, no `strip`)

## Binary sizes

| Profile | Path                  | Size (bytes) | Size (human) |
| ------- | --------------------- | ------------ | ------------ |
| release | `target/release/attn` | 26,360,016   | 26 MB        |
| debug   | `target/debug/attn`   | 37,060,968   | 36 MB        |

Measured via `ls -la target/{release,debug}/attn`.

## Dependency count

- **Unique crates (full tree)**: 166 — `cargo tree | grep -oE '[a-z0-9_-]+ v[0-9]+' | sort -u | wc -l`
- **`cargo tree -e features --no-default-features` line count**: 4,541
- **`cargo tree -e features --no-default-features` unique entry lines**: 4,389

## Crypto crates added in this issue

```
sha2 = "0.10"
hkdf = "0.12"
chacha20poly1305 = "0.10"
ed25519-dalek = "2"
base64 = "0.22"
getrandom = "0.2"
zeroize = { version = "1", features = ["derive"] }
```

No code consumes them yet — wrappers land in `attn-nnj.1.3` through `attn-nnj.1.8`.

## Notes for Phase 4 comparison (`attn-nnj.7.1`)

When `webrtc-rs` is added, re-run the same measurements on the same host with
the same profile defaults. Expected deltas to track:

- Release binary growth (webrtc-rs is the largest dep on the critical path).
- New unique crate count (webrtc + its sub-crates are significant).
- Compile-time delta (not captured here — capture clean `cargo build --release`
  wall-clock at that point to make the impact concrete).
