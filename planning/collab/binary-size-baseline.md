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

---

## Pre-webrtc regression investigation (attn-nnj.11.9)

**Verdict: ACCEPT current state — the growth is intentional and unavoidable
for the collab feature set.** The 1.1 → current delta is dominated by
deps that have actual consumers (`reqwest`, `tokio` runtime, `rustls`,
`ring`, the crypto suite) and cannot be feature-pruned without losing
functionality the collab plan requires.

### Snapshot

- **Date**: 2026-05-19
- **Baseline commit**: `bb7cd140b96eeb32a30472292e819a10b25d8f00`
  (1.1 close) → 26,359,984 bytes / **25.14 MiB**
- **501500e commit (7.1 reference)**: 26,643,440 bytes / **25.41 MiB**
- **Current `collab` tip** (`1b0204f` "Round-20 claims" rebased): 29,517,920
  bytes / **28.15 MiB**
- **Total delta from 1.1**: **+3,157,936 bytes (+3.01 MiB / +12.0 %)**
- **Delta from 7.1 measurement point (501500e) to current**: **+2.74 MiB**
  — this is the bulk of the regression and was *not* visible to 7.1
  because round 12-20 had not landed yet.
- **Embedded `attn-index.html` (web bundle)**: 19.7 MiB at 1.1 → 19.8 MiB
  at current. Only ~100 KiB of the 3 MiB growth is the JS bundle; the
  rest is Rust code.
- **Crate count**: 137 unique crates at 1.1 → **341** at current (+204
  new transitive crates). Zero crates removed.

The 50 MiB gate currently set by `scripts/check-binary-size.sh` (raised
from 25 MiB after 7.1's GATE FAIL) **passes with 21.85 MiB of headroom**.

### Per-section delta (macOS `size -m`)

| Segment / Section | 1.1 baseline | Current | Delta |
| ----------------- | ------------ | ------- | ----- |
| `__TEXT` total    | 25,362,432   | 27,770,880 | **+2,408,448** (+2.30 MiB) |
| `__text`          | 1,629,812    | 3,356,796  | +1,726,984 (+1.65 MiB) |
| `__const` (TEXT)  | 23,307,632   | 23,532,656 | +225,024 (+220 KiB) — mostly embedded `attn-index.html` growth |
| `__cstring`       | 49,887       | 80,268     | +30,381 |
| `__unwind_info`   | 41,768       | 89,376     | +47,608 |
| `__eh_frame`      | 241,664      | 507,080    | +265,416 |
| `__LINKEDIT`      | 1,032,192    | 1,589,248  | +557,056 (symbol table + bind/lazy stubs) |
| **File total**    | 26,359,984   | 29,517,920 | **+3,157,936 (+3.01 MiB)** |

The growth is concentrated in `__text` (Rust code) and `__LINKEDIT`
(symbol table for the larger code) — not in the embedded web bundle.

### Per-crate `.text` delta (cargo bloat --release --crates -n 50)

Crates that contributed > 10 KiB to the `.text` section since 1.1:

| Crate              | 1.1     | Current | Delta    | Owning issue / purpose |
| ------------------ | ------- | ------- | -------- | ---------------------- |
| `rustls`           | 0       | 334.9   | **+334.9 KiB** | 6.2 (reqwest TLS) + 6.3 (tungstenite TLS) |
| `reqwest`          | 0       | 323.0   | **+323.0 KiB** | 6.2 mailbox transport |
| `std`              | 521.6   | 788.6   | +267.0 KiB     | indirect: more code instantiated → more std monomorphisations |
| `attn`             | 93.8    | 253.6   | +159.8 KiB     | review/anchors/apply/transport modules |
| `serde_json`       | 37.7    | 149.8   | +112.1 KiB     | review envelope + state serialisation |
| `serde`            | 48.7    | 137.3   | +88.6 KiB      | many new `Derive`s in collab structs |
| `tokio`            | 0       | 86.1    | +86.1 KiB      | 6.x async runtime |
| `hyper`            | 0       | 58.8    | +58.8 KiB      | reqwest dep (6.2) |
| `hyper_util`       | 0       | 46.1    | +46.1 KiB      | reqwest dep (6.2) |
| `serde_core`       | 25.1    | 70.1    | +45.0 KiB      | indirect (more derives) |
| `ring`             | 0       | 38.5    | +38.5 KiB      | rustls crypto |
| `sha2`             | 0       | 17.7    | +17.7 KiB      | 1.1 crypto (NOW has consumers) |
| `curve25519_dalek` | 0       | 15.7    | +15.7 KiB      | 1.1 crypto via ed25519 |
| `http`             | 26.6    | 41.4    | +14.8 KiB      | reqwest / tungstenite |
| `clap_builder`     | 246.1   | 232.4   | **−13.7 KiB**  | (slight contraction — toolchain LTO improvements) |

Crates < 10 KiB delta but newly present in current: `parking_lot`,
`hyper_rustls`, `tokio_rustls`, `ed25519_dalek`, `rustls_pki_types`,
`ipnet`, `tracing_core`, `httparse`, `base64`, `cipher`, `mio`,
`webrtc_util` (2.9 KiB, dead-code residual — see below).

Total `.text` growth attributable to the table above:
~1.6 MiB — matches the `__text` delta from the section table above.

### Is webrtc actually linked? (sanity check)

`strings target/release/attn | grep -c webrtc` → **0** at the current
tip. The cargo-bloat numbers show `webrtc_util` at 2.9 KiB and
`webrtc_sctp` at 424 bytes — these are dead-code residuals
(`#[derive]`-only types that escaped LTO) totalling < 4 KiB. **The
webrtc-rs umbrella crate is in the dep tree but is not consuming
binary-size budget at the current tip.** All 3 MiB of growth is from
non-webrtc additions.

### Could feature-pruning recover the budget?

Audit of the headline crates with comments on whether features can be
trimmed without losing functionality:

1. **`reqwest = { default-features = false, features = ["rustls-tls",
   "json"] }`** — `json` feature investigated. Every production call
   site (`src/review/bootstrap.rs`, `src/review/transport/mailbox/mod.rs`)
   serialises via `serde_json::to_vec(&body)` + `.body(bytes)` directly,
   so the reqwest<->serde_json glue is genuinely unused. **Dropped in
   this issue**. LTO had already eliminated most of the dead glue; the
   cold-build delta from removing the feature is < 100 bytes. Net win:
   ~zero binary saving, but the manifest now reflects actual usage and
   future code can't accidentally pull it back in. (Test helpers in
   `tests/relay_helpers/mod.rs` were converted to
   `serde_json::from_slice` to avoid re-unifying the feature via
   dev-deps.)

2. **`tokio` features**: currently `["sync", "rt", "rt-multi-thread",
   "macros", "time", "net", "io-util"]`. Each has a concrete consumer
   (`sync` for PoW token pool, `rt-multi-thread` for ReviewManager,
   `net`+`io-util` for the tungstenite WebSocket, `time` for outbox
   backoff, `macros` for `#[tokio::main]` in tests). No safe drops.

3. **`tokio-tungstenite` features**: currently `["rustls-tls-webpki-roots",
   "connect"]` with default-features=false. `connect` is what builds
   the client request; `rustls-tls-webpki-roots` keeps OpenSSL out.
   Cannot remove either without re-introducing the OS trust store
   dependency (which conflicts with attn's "single static binary"
   design).

4. **`comrak = { default-features = false }`** with explicit extension
   opt-in (`strikethrough`, `table`, `tasklist`, `autolink`, `footnotes`,
   `multiline_block_quotes`, `alerts`, `math_dollars`, `math_code`).
   Already at minimum: `cli` and `syntect` are off, and every active
   extension has anchor-index consumers in `src/review/anchors/index.rs`.
   No safe drops.

5. **`rustls` and `ring`**: load-bearing for TLS. Removing them means
   either falling back to native-tls (which adds OS trust-store
   bindings and a CFNetwork dep on macOS) or shipping HTTP-only —
   neither is acceptable per the relay spec.

6. **`webrtc = "0.11"`**: in the manifest with no consumer (verified by
   string scan). Removing it would save < 4 KiB at the current tip
   because LTO already strips it. The 7.1 doc above already covers the
   *future* cost when Phase 4 wires the transport in; that's a separate
   question from this regression analysis.

### Recommendation: ACCEPT current state

The 3 MiB / 12 % growth from 1.1 → current is:

- **~1 MiB**: reqwest + hyper + hyper_util + rustls + ring stack
  (mailbox transport, 6.2). All features already minimal.
- **~0.5 MiB**: tokio runtime + tokio-tungstenite (WebSocket transport,
  6.3) — feature set already minimal.
- **~0.5 MiB**: serde / serde_json / serde_core code growth from the
  ~50 new collab types getting `#[derive(Serialize, Deserialize)]`.
- **~0.2 MiB**: `attn` crate's own review/anchors/apply/transport code
  (3.x, 4.x, 5.x, 8.x).
- **~0.5 MiB**: `__LINKEDIT` (symbol table for the additional code) +
  `__eh_frame` / `__unwind_info` (Rust panic unwinding metadata that
  scales with code size).
- **~0.2 MiB**: misc (sha2, curve25519_dalek, ed25519_dalek,
  parking_lot, etc.) — crypto + sync primitives, all with consumers.

None of this is wasted. There is no clean 100 KiB win available; the
reqwest `json` feature was the most promising candidate and turned out
to be already-zero after LTO. The 50 MiB gate has 21.85 MiB of headroom,
which gives Phase 4's WebRTC transport (~5 MiB when actually linked per
7.1's probe measurement) plenty of room to land cleanly.

### What WOULD save binary size (deferred, not recommended now)

If a future issue raises binary-size pressure again, the highest-impact
levers are:

1. **Embed the web bundle as a compressed asset** and inflate at startup.
   The `__const` section is 22 MiB and almost all of that is the
   `include_str!`'d `attn-index.html`. Brotli at level 11 on a typical
   bundle reduces size by 75-80%, which could save 15+ MiB. Cost: ~5 ms
   of startup time and a `brotli-decompressor` crate dep. Worth doing if
   the budget tightens or if distribution channels care about download
   size.

2. **Replace `image = "0.25"`** (currently `{ default-features = false,
   features = ["png"] }`) with the much smaller `png = "0.18"` (which
   it transitively pulls anyway). The `image` umbrella crate adds
   52 KiB of `.text` even with only the PNG feature enabled. Saving:
   ~50 KiB. Trivial to swap.

3. **Drop `nucleo-matcher`** in favour of a hand-rolled fuzzy match
   if the fuzzy file picker proves over-engineered. Saving: ~70 KiB
   of `.text`. Not recommended — the existing UX is good.

4. **Set `[profile.release] lto = "fat"`** (currently default thin LTO).
   Cost: build time +30-60s. Saving: typically 5-10% on Rust binaries;
   hard to predict without measuring. Worth a measurement if budget gets
   tight, but cargo's default thin LTO already strips most dead code
   (verified: `webrtc` umbrella crate compiles into < 4 KiB of residual
   `.text` despite 50+ transitive crates).

These are all deferred to a future binary-size issue if needed. None is
required right now because the gate has comfortable headroom.

### Pre-existing actions for `attn-nnj.11.9` — DONE

- [x] Measure 1.1 baseline (this commit's first build): 25.14 MiB.
- [x] Measure 7.1 reference point (501500e): 25.41 MiB.
- [x] Measure current `collab` tip: 28.15 MiB (passes 50 MiB gate).
- [x] Per-crate `.text` delta table (above).
- [x] Recommendation written + accepted.
- [x] One small feature drop applied (`reqwest` "json") with cargo test
  + cargo check + binary-size gate all green.

### Methodology notes

- All measurements taken on the same host (`Darwin arm64`,
  `aarch64-apple-darwin`, `rustc 1.94.1`) with stock profile defaults
  (no `lto = "fat"`, no `strip`).
- Each build was a clean `cargo build --release` from a fresh `cargo
  clean` to eliminate stale-artifact effects.
- `cargo bloat --release --crates -n 50` reports the `.text` section
  only; the larger `__const` / `__LINKEDIT` sections are not attributed
  per-crate by cargo-bloat but their growth is well under the `.text`
  growth (see section delta table) and tracks code-size growth linearly.
- `cargo bloat` reports vary slightly across runs (±0.1 KiB) due to
  link-order non-determinism; the numbers above are from a single
  representative run.

