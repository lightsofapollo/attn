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

---

## After webrtc-rs (Phase 4 issue 7.1)

**Verdict: GATE FAIL — needs a decision before Phase 4 can proceed.**

Captured for `attn-nnj.7.1`. Compares the same toolchain on the same host
against the original baseline above. Adds `webrtc = "0.11"` to `Cargo.toml`
with no consumer code in `src/`.

### Snapshot

- **Date**: 2026-05-18
- **Commit (HEAD before 7.1 changes)**: `501500e2551375685dbfe72ad74f15a66924a1ec`
- **Worktree branch**: `worktree-agent-a19282141ed3176b3` (rebased onto `collab`)
- **Platform**: `Darwin arm64` (aarch64-apple-darwin host)
- **Toolchain**: `rustc 1.94.1 (e408947bf 2026-03-25)`
- **Rust profile defaults**: as committed (no LTO, no `strip`)
- **`webrtc` crate**: `0.11.0`

### Binary sizes — three measurements

The release binary's size changes dramatically depending on whether real
code references the WebRTC crate, because release-mode dead-code elimination
strips unreferenced dependencies. Three measurements are reported so the
implications of (a) adding the dep and (b) actually using the dep are both
explicit.

| Scenario                                    | Path                  | Size (bytes) | Size (MiB) | vs 25 MiB gate |
| ------------------------------------------- | --------------------- | ------------ | ---------- | -------------- |
| **Baseline — pre-webrtc, this host**        | `target/release/attn` | 26,643,440   | **25.41**  | **FAIL by 0.41 MiB** |
| **As committed — webrtc dep, no consumer**  | `target/release/attn` | 26,643,568   | **25.41**  | **FAIL by 0.41 MiB** (+128 bytes vs pre-webrtc) |
| **Probe — peer-connection + data-channel**  | `target/release/attn` | 31,507,536   | **30.05**  | **FAIL by 5.05 MiB** (+4.64 MiB vs pre-webrtc) |

The "Probe" measurement was taken with a temporary `src/webrtc_probe.rs`
module that ran (under a local tokio runtime) `APIBuilder::new() +
new_peer_connection() + create_data_channel() + create_offer()` — the surface
the real `attn-nnj.7.2+` Rust transport will exercise. The probe was reverted
before commit; the as-committed binary does not link any webrtc symbols
(verified via `strings target/release/attn | grep webrtc`).

### Baseline-doc discrepancy investigation

- The original baseline (above) reports `26,360,016 bytes` = **25.14 MiB**
  (binary MiB), which the doc rendered as "26 MB" (decimal MB). Both are
  factually accurate, just different units. The 25 MiB gate is MiB.
- The `attn-nnj.7.1` issue description references "11.3's script reports
  18.62 MiB". That figure could not be reproduced on this host — `cargo build
  --release` on `collab` at `501500e` consistently produces a 25.14 MiB
  binary (matching the recorded baseline). The 18.62 figure may have come
  from a build with LTO/strip overrides, a different toolchain, or an
  earlier commit that has since gained additional deps (reqwest+rustls,
  comrak, etc.). The 25.14 MiB figure is what the gate sees today.
- **The pre-webrtc binary already fails the 25 MiB gate by 0.41 MiB on
  `collab @ 501500e`.** This means the gate (introduced by `attn-nnj.11.3`)
  is *already* tripping before any Phase 4 work lands. The webrtc canary
  finds an existing regression in collab as a side effect.

### Dependency count delta

| Metric                                                                      | Pre-webrtc | Post-webrtc | Delta  |
| --------------------------------------------------------------------------- | ---------- | ----------- | ------ |
| Unique crates (full tree, `cargo tree \| grep -oE '[a-z0-9_-]+ v[0-9]+' \| sort -u \| wc -l`) | **244**    | **329**     | **+85**    |
| `cargo tree -e features --no-default-features --no-dev-dependencies` lines | **4,946**  | **6,331**   | **+1,385** |
| Same, unique entry lines                                                    | **2,195**  | **3,308**   | **+1,113** |
| `cargo tree -p webrtc` lines (subtree only)                                | n/a        | **578**     | n/a    |

The webrtc-rs umbrella crate pulls in (top-level): `arc-swap`,
`async-trait`, `bytes`, `cfg-if`, `hex`, `interceptor`, `log`,
`portable-atomic`, `rand` family, `rcgen`, `regex`, `ring`, `rtcp`, `rtp`,
`rustls`, `sct`, `sctp`, `sdp`, `srtp`, `stun`, `time`, `tokio-util`,
`turn`, `webrtc-data`, `webrtc-dtls`, `webrtc-ice`, `webrtc-mdns`,
`webrtc-media`, `webrtc-sctp`, `webrtc-srtp`, `webrtc-util`, `x509-parser`,
plus 50+ transitives.

### Compile time

- `cargo build --release` (cold from clean target): ~2m18s. Re-build after
  touching `src/main.rs` only: ~5s. The webrtc-rs sub-crates compile in
  parallel; the linker is the hot path on incrementals (single-threaded
  on macOS).

### `cargo check` / `cargo test`

- `cargo check`: PASS
- `cargo test`: PASS (267 tests, 3 ignored — no regressions from the dep
  addition; webrtc-rs adds zero test-time slowdown because nothing
  instantiates a peer connection in unit tests)

### Gate result

```
$ scripts/check-binary-size.sh
Binary size check
  binary : target/release/attn
  size   : 25.41 MiB (26643568 bytes)
  budget : 25.00 MiB (26214400 bytes)

FAIL: target/release/attn is 25.41 MiB — 0.41 MiB over the 25.00 MiB budget.
```

**The as-committed binary fails the gate by 0.41 MiB even though webrtc-rs
is not actually linked yet.** The realistic post-7.2 binary (extrapolating
from the probe measurement) is **~30 MiB — 5 MiB over the gate**.

### Recommendations / next steps (FAIL — decision required)

The 25 MiB target locked by `planning/collab/amendments.md` §Decision #1 is
not achievable with webrtc-rs in the default build of `attn` as it stands
today. Three viable paths, in order of preference:

1. **Feature-gate the WebRTC transport** *(recommended, smallest blast
   radius)*. Move `webrtc = "0.11"` into an optional dep behind a
   `webrtc` cargo feature, default-on for now or default-off depending on
   whether reviewers can rely on Mailbox transport alone. The
   `Box<dyn Transport>` shape from `attn-nnj.6.1` already allows the
   binary to ship without WebRTC and fall back to Mailbox. Default-off
   would bring the default binary back under 25 MiB; default-on would
   make the gate budget need to rise to ~30 MiB.

2. **Raise the budget to 30 MiB** *(simplest, breaks the decision)*.
   Acknowledged in §Decision #1 as the tradeoff for keeping WebRTC in
   Rust. Requires updating `scripts/check-binary-size.sh` default and
   the CLAUDE.md gate documentation. This effectively retires the 25 MiB
   line and replaces it with the post-WebRTC reality.

3. **Use a smaller crate set** *(invasive, defers the question)*. Pull
   only `webrtc-data` + `webrtc-sctp` + `webrtc-dtls` + `webrtc-ice`
   directly instead of the umbrella `webrtc` crate, hand-wire the
   pieces. Saves some — but the bulk of the size is `ring` + `rustls` +
   the DTLS/SCTP/SRTP state machines, all of which are mandatory for any
   real WebRTC DataChannel. Estimated saving: 1-2 MiB at the cost of
   significant Phase 4 implementation complexity.

4. **Pre-existing 0.41 MiB regression** *(independent of WebRTC)*. The
   pre-webrtc binary on `collab @ 501500e` is already 25.41 MiB. This
   needs its own investigation — likely caused by recent additions of
   `reqwest + rustls + hyper-rustls + tower-http` (issue 6.2) and the
   anchor/suggestion-resolver code paths (issues 3.x, 8.1). Independent
   of the webrtc decision, the gate is already broken on `collab`.

### Action required before Phase 4 proceeds

- Pick one of paths 1-3 above.
- File a follow-up issue for the pre-existing 0.41 MiB collab regression
  (cause: post-baseline additions to `collab`, not webrtc itself).
- Until a decision is made, `attn-nnj.7.2+` CANNOT merge cleanly — the
  binary-size gate will block them. The `webrtc = "0.11"` line in
  `Cargo.toml` from this issue is intentionally committed so the gate
  catches all of this *before* the WebRTC implementation lands and
  reviewers are surprised mid-PR.
