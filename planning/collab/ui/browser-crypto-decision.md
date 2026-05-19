# Browser Crypto Sourcing — WASM vs Hand-Written TypeScript

Status: design proposal — awaiting human review (attn-nnj.9.1).
Blocks: Phase 6 browser review client (`https://attn.dev/review/<roomId>#key=...`).
Owner of decision: pending human reviewer; this doc carries an opinionated recommendation.

References:

- `planning/collab/amendments.md` §Decision #4 — locked cipher suite
  (XChaCha20-Poly1305 + Ed25519 + HKDF-SHA-256 + RFC 8785 JCS + base64url-no-pad).
- `planning/collab/amendments.md` §Phase 6 (line 281) — browser client scope.
- `planning/collab/amendments.md` §Decision #1 — `webrtc-rs` ownership in Rust;
  Phase 6 browser path is **mailbox-only** by design (no `RTCPeerConnection`
  in browser JS).
- `planning/collab/crypto-spec.md` — full primitive list, test-vector corpus
  layout (`planning/collab/test-vectors/{kdf,canonical-json,event-signature,event-id,aead,envelope,pow}.json`).
- `src/review/crypto/{canonical,kdf,aead,signing,ids,pow}.rs` — the Rust
  implementations that pass the corpus today.
- `planning/collab/binary-size-baseline.md` — measurement methodology
  (also a precedent for "measure twice, decide once").

---

## 1. Context

### The trust boundary changes for Phase 6

The native client (Phases 0–5) does **all** crypto in Rust:
`ReviewManager` owns the room keys, decrypts every envelope from
`transport.rs`, verifies Ed25519 signatures, mints PoW, and only then
emits typed `ReviewUpdate` events to Svelte over the wry IPC bridge.
The web frontend in the native app **never sees ciphertext**, never holds
`rootKey`/`eventKey`/`snapshotKey`/`signalingKey`/`admissionKey`.

The Phase 6 hosted browser client at `https://attn.dev/review/<roomId>#key=...`
has the opposite shape:

1. The user opens the URL in a normal web browser.
2. JS in that page parses `#key=` (Decision #13 — memory-only, immediately
   `replaceState`-stripped), derives the room key tree.
3. JS calls the relay over plain `fetch` + WebSocket using the
   `admissionKey` HMAC.
4. JS decrypts inbound `event`/`snapshot_blob` envelopes (XChaCha20-Poly1305),
   verifies Ed25519 signatures, and signs outbound events with the device's
   Ed25519 keypair.
5. JS mints hashcash PoW tokens on the main thread or a Web Worker.

So Phase 6 is the **only place TypeScript-side crypto must live**. It cannot
be deferred to "a future native client behind the browser tab" — the whole
point of the hosted entry is that the reviewer has no native binary.

### What this decision picks

How the Phase 6 bundle obtains its implementation of the locked cipher suite:

- **(a)** Compile the existing Rust `src/review/crypto/*` to WASM via
  `wasm-pack` + `wasm-bindgen`, ship the resulting `.wasm` + ESM glue
  alongside the Svelte/PM bundle.
- **(b)** Write a hand-rolled TypeScript implementation that targets the
  same primitives, validate it against the test-vector corpus at
  `planning/collab/test-vectors/`.

This is an "ahead of Phase 6 work" decision because the test-vector corpus,
the canonical-JSON helper, the AEAD vectors, and the PoW miner all need to
land in *some* TS shape before the browser client can even mock-render
events, and the choice between (a) and (b) shapes whether the TS package
boundary is "thin wrappers over WASM exports" or "real TS modules."

---

## 2. Option A — Compile Rust attn-collab-crypto to WASM

### What gets compiled

The existing `src/review/crypto/` re-exports six submodules. Of these, the
browser only needs the **pure crypto** subset:

| Module | Browser needs? | Notes |
|---|---|---|
| `crypto::canonical` | Yes | Used for AAD bytes, signature input, ID hashing |
| `crypto::kdf` | Yes | HKDF derivation of all room subkeys |
| `crypto::aead` | Yes | XChaCha20-Poly1305 seal/open |
| `crypto::signing` | Yes | Ed25519 sign/verify, `signingKeyId` |
| `crypto::ids` | Yes | EventId/EnvelopeId/SnapshotId/FileId derivation |
| `crypto::pow` | Mostly | Mint loop + verify. The `TokenPool` (tokio::sync::Mutex) does **not** compile to WASM cleanly — see below. |

The browser does **NOT** need (and these MUST NOT be in the WASM build):

- `src/review/envelope.rs` — wire framing; the browser handles framing in TS.
- `src/review/transport/` — `mailbox/`, `webrtc.rs`, `signaling.rs`, `selector.rs`
  pull in `reqwest`, `tokio`, `webrtc`. The browser uses `fetch`/`WebSocket`
  natively.
- `src/review/manager.rs`, `store.rs`, `watcher_state.rs`, `working_copy.rs`,
  `apply.rs`, `anchors/`, `bootstrap.rs`, `ipc.rs` — everything that touches
  the filesystem, the wry IPC, or the daemon lifecycle.

So the WASM module is a **carved-out crypto crate**, not "compile all of attn
to wasm." It's effectively the file set `src/review/crypto/{mod,canonical,
kdf,aead,signing,ids,pow}.rs` plus the typed-id and event-model `serde` types
they reference from `src/review/{ids,model}.rs`.

### Required Cargo restructure

This needs a workspace member, not just a build flag, because:

1. The current crate is a binary (`src/main.rs` brings in `tao`/`wry`/`webrtc`
   transitively — none of which compile to `wasm32-unknown-unknown`).
2. `crypto::pow` currently imports `tokio::sync::Mutex` for `TokenPool`.
   That has to move out of the WASM-shared module — the browser uses its
   own promise-based pool.
3. `crypto::signing` and `crypto::ids` depend on `crate::review::model` and
   `crate::review::ids`, which means the WASM crate has to either pull
   those in or have them re-vendored as a leaf crate.

Concretely: introduce a new workspace member `attn-collab-crypto` at
`crates/attn-collab-crypto/` (or similar) that owns the seven crypto
files + the typed-id + event-model `serde` types they need, with no
runtime deps. The main `attn` crate depends on this leaf and the leaf
compiles to both `aarch64-apple-darwin` (for the daemon) and
`wasm32-unknown-unknown` (for the browser).

### Crate-level compile cleanliness on `wasm32-unknown-unknown`

Audit of the current dep set:

| Crate | wasm clean? | Notes |
|---|---|---|
| `sha2 = "0.10"` | Yes | Pure Rust, no_std-friendly. |
| `hkdf = "0.12"` | Yes | Pure Rust, no `std::time`. |
| `chacha20poly1305 = "0.10"` | Yes | Pure Rust, RustCrypto. Same impl on native and WASM. |
| `ed25519-dalek = "2"` | Yes | Pure Rust; uses `curve25519-dalek`. Browser-native Ed25519 (`crypto.subtle.sign({name:"Ed25519"})`) is **not** an option from inside WASM because `crypto.subtle` is async + JS-only. We keep dalek inside the WASM and skip the WebCrypto detour. |
| `base64 = "0.22"` | Yes | Pure Rust. |
| `getrandom = "0.2"` | **Needs `js` feature** | On `wasm32-unknown-unknown` getrandom defaults to a panicking backend. We must enable `features = ["js"]` so it routes to `crypto.getRandomValues`. This is the single most common WASM crypto gotcha and is well-documented. |
| `zeroize = "1"` | Yes | Pure Rust. |
| `serde_json` | Yes | Pure Rust. |
| `tokio` (only used in `pow::TokenPool`) | **No** | Must be removed from the WASM-shared module. The mint loop itself uses only `sha2` + `getrandom` + `base64` and compiles fine; only the pool wrapper needs to be host-specific. |

So the WASM build is a five-line `Cargo.toml` change plus a `getrandom`
feature flag plus a fence around `TokenPool`. The hard work is structural
(splitting the crate), not technical.

### Bundle size — estimated

There is no measured number yet (writing this doc, not implementing it).
Reasoned estimate based on community comparables:

- `curve25519-dalek` + `ed25519-dalek` compiled to wasm32 with `-O3 -Os`
  and `wasm-opt`: ~140–180 KiB raw, ~55–75 KiB gzip in published crates
  ([dalek-cryptography/curve25519-dalek#522](https://github.com/dalek-cryptography/curve25519-dalek/issues/522)
  reports ~170 KiB raw for `ed25519-dalek` with default features).
- `chacha20poly1305` + `chacha20` + `poly1305`: ~25–35 KiB raw, ~10–14 KiB gzip.
- `sha2` + `hkdf` + `getrandom`: ~15–25 KiB raw, ~6–9 KiB gzip.
- `serde_json` + `wasm-bindgen` glue + canonical-JSON helper: ~60–100 KiB
  raw, ~25–40 KiB gzip. `wasm-bindgen` glue is the surprise cost
  ([discussion](https://github.com/rustwasm/wasm-bindgen/issues/2531)).
- ID derivation + PoW mint: negligible on top of sha2.

**Best-case estimate: ~95–140 KiB gzipped** for the carved-out crypto WASM
+ JS glue, after `wasm-opt -Oz` and ESM-bundled.

This is the back-of-envelope. **It must be measured during the spike** — if
the real number is ≥ 250 KiB gzip we are spending almost half the Phase 6
bundle budget on crypto, which changes the calculus.

### Performance

- **AEAD seal/open**: WASM ChaCha20-Poly1305 runs at roughly 200–400 MiB/s
  on modern x86 / Apple Silicon (vs ~80–150 MiB/s for `@noble/ciphers`
  in pure JS). For our payload sizes (events: ~1–4 KiB; snapshot blobs:
  up to ~100 KiB inline, larger via R2) this is irrelevant to UX —
  both finish in sub-millisecond.
- **Ed25519 sign**: ~50–100 µs WASM vs ~200–500 µs `@noble/curves`.
  Verifies similar. Below human perception either way.
- **PoW mint, 16 leading zero bits**: median ~65k SHA-256 iterations.
  `sha2`-via-WASM benches at ~80–150 MH/s on Apple Silicon, so the median
  mint is **~50 ms** — matches the Rust-native figure used in spec
  (crypto-spec.md §Difficulty). In pure JS via `@noble/hashes/sha256`
  the same workload runs at ~5–15 MH/s, giving **~150–300 ms** median.
  Browser Worker, off the main thread, either way.
- **Snapshot decrypt** (100 KiB ciphertext): WASM ~0.5 ms; JS ~2–4 ms.
  Both fine.

The performance win for WASM is real but only the PoW mint is in the
"user notices" range, and even then only on bursty submits (the
`TokenPool` pre-mints during idle so the wait is amortized).

### Trust profile

WASM in a hosted-JS context has **exactly the same** trust profile as
hosted JS:

- Both come from `https://attn.dev/...`.
- Both execute under the same origin, with the same CSP, the same network
  visibility, and the same ability to send `roomSecret` to the server if
  the attn.dev origin is compromised.
- Decision #13 (URL fragment is memory-only) caps the worst case to "what
  the in-tab JS sees during this session." WASM doesn't move that needle
  one way or the other.

The native client's trust model (decryption happens in Rust, frontend
never sees keys) **cannot** be replicated in a browser — there is no
"non-JS" layer to retreat to. Picking WASM does NOT recover the
native-client trust posture; it just shifts where the crypto code is
loaded from. This is important to be honest about.

### Maintenance

WASM = one implementation, byte-identical across both targets. Bug fixed
once. Spec change rolled through `src/review/crypto/*` automatically
propagates to the browser on the next bundle build.

The corpus tests in `planning/collab/test-vectors/` keep their meaning
but become belt-and-suspenders rather than the primary guarantee — both
targets ship the same compiled bytes, so a corpus failure on one is a
corpus failure on the other.

### Compile / build complexity

- New workspace member.
- `wasm-pack build --target web` or equivalent in the web build step.
- `web/vite.config.ts` needs a wasm plugin (`vite-plugin-wasm` or
  `@rollup/plugin-wasm`).
- `web/package.json` gets a dev-dependency on the local generated package
  (`"attn-collab-crypto": "file:../crates/attn-collab-crypto/pkg"`).
- CI needs `wasm32-unknown-unknown` target installed and `wasm-pack`.
- Vite production build must inline the `.wasm` (or fetch it with the
  right Content-Type) — both work, inline keeps it to one network request.
- HMR with `task dev` must rebuild the WASM crate on Rust file changes
  (this is the development-loop friction — `cargo build -p attn-collab-crypto
  --target wasm32-unknown-unknown` is ~1–2s incremental, ~15–25s clean,
  so first-touch is slow but warm rebuilds are fine).

Mitigation: keep a `wasm-pack build --dev` watcher running alongside the
existing `task dev` Vite watcher; only the release pipeline runs the
`-Oz` + `wasm-opt` pass.

---

## 3. Option B — Hand-Written TypeScript Implementation

### What gets implemented

A `web/src/lib/review/crypto/` module mirroring `src/review/crypto/`:

```
web/src/lib/review/crypto/
  canonical.ts   // RFC 8785 JCS — in-house port (~150–250 LOC)
  kdf.ts         // HKDF-SHA-256 + room key derivation
  aead.ts        // XChaCha20-Poly1305 seal/open with AAD-binding
  signing.ts     // Ed25519 sign/verify + signingKeyId
  ids.ts         // EventId/EnvelopeId/SnapshotId/FileId derivations
  pow.ts         // Hashcash mint loop + verify; pool wrapper for Workers
```

Validated against the corpus at `planning/collab/test-vectors/` (already
specified by `crypto-spec.md` §Test Vectors as the cross-impl baseline).

### Dependency choices

- **`@noble/hashes`** for SHA-256 and HKDF. Audited, zero-deps,
  `MIT` license. The `sha256.create()` API maps directly to our usage.
- **`@noble/ciphers`** for XChaCha20-Poly1305 (`@noble/ciphers/chacha`
  exports `xchacha20poly1305`). Audited, zero-deps. Same `MIT` license.
  `crypto-spec.md` line 34 already names this package — the spec
  anticipated this path.
- **`@noble/curves`** for Ed25519 (`@noble/curves/ed25519`). Audited.
  An alternate is `crypto.subtle.sign({ name: "Ed25519" }, ...)` —
  browser-native in Chrome 113+, Safari 17+, Firefox 129+. But the
  per-event signing path is hot (verify on every inbound event, sign on
  every outbound), and `crypto.subtle`'s `Promise<ArrayBuffer>` shape
  forces every code path through `await`. Using `@noble/curves`
  synchronously keeps the call sites symmetric with Rust and avoids
  retrofitting `async` through `signing.ts` and `ids.ts`.
  Decision: use `@noble/curves/ed25519` (matches spec line 35).
- **`crypto.getRandomValues`** for entropy (no library needed).
- **In-house canonical-JSON helper** — port of `src/review/crypto/canonical.rs`,
  ~200 LOC. The Rust port has a clear test suite we can mirror line-for-line.
  Same omission/sorting/escape rules.
- **In-house base64url-no-pad helper** — ~30 LOC, no dep.

No build-step gymnastics. Just `npm install` and code.

### Bundle size — estimated

- `@noble/hashes/sha256` tree-shaken: ~6–9 KiB gzipped.
- `@noble/hashes/hkdf`: ~1–2 KiB gzipped.
- `@noble/ciphers/chacha` (xchacha20poly1305 only, tree-shaken):
  ~10–14 KiB gzipped.
- `@noble/curves/ed25519` (sign + verify only, tree-shaken):
  ~30–45 KiB gzipped (the curve operations are the bulk; `@noble/curves`
  publishes ~150 KiB ungzipped, ~45 KiB gz, with `ed25519` being the
  largest single module).
- In-house canonical-JSON + base64url + IDs + PoW + AEAD wrapper:
  ~5–10 KiB gzipped.

**Best-case estimate: ~55–80 KiB gzipped** for the full crypto layer in
hand-written TS.

This is **smaller** than the WASM estimate by ~40–60 KiB gzip in the
median case — partly because tree-shaking is more aggressive on
`@noble/*` than WASM (the `wasm-bindgen` glue is a fixed tax) and partly
because we skip the `serde_json` / `wasm-bindgen` overhead.

### Performance

Already covered above. The only meaningful performance concern is the
PoW mint:

- JS `@noble/hashes/sha256`: ~5–15 MH/s.
- Median mint at 16 bits: ~150–300 ms in a Web Worker.

This is 3–6× slower than the WASM path. For a single submit, invisible
(amortized by token pool pre-mint). For an agent burst of 20 events,
the pool would need to be larger (~20 tokens pre-minted across the four
write endpoints), but the spec already calls for a token pool for both
Rust and TS clients (crypto-spec.md §Client Implementation, line 187).

So: TS is slower but in the same ballpark, and the pool flattens the
worst case to "small one-time mint on first submit after idle."

### Trust profile

Identical to WASM — same origin, same JS environment, same network
visibility. The lack of a WASM step neither helps nor hurts trust.

One small lean in favor of TS: the `@noble/*` packages are audited and
many security researchers can read TS more easily than Rust+WASM
binary output. The output of `wasm-pack build --release` is opaque
without source maps; the output of `vite build` is at worst minified.
This is a marginal consideration for an open-source spec where the
source is on GitHub regardless, but it does matter for the
"can-a-security-reviewer-verify-the-deployed-bundle?" question.

### Maintenance

Two implementations means **two implementations**. The corpus at
`planning/collab/test-vectors/` is the contract that keeps them
in sync, and it works — every primitive in `src/review/crypto/*.rs`
has corresponding corpus files. **But**:

- Every spec change (e.g., a future v3 cipher suite, additional
  `info` strings, a new ID derivation) requires two commits, two
  reviews, two test runs.
- Subtle bugs from JS oddities (UTF-16 indexing, `Number` vs `BigInt`
  for the timestamp ms field, JSON.stringify order quirks) won't be
  caught by the Rust test suite. They'll show up the first time the
  browser actually talks to a Rust client.
- The canonical-JSON port is the highest-risk surface — RFC 8785 has
  enough edge cases (sub-second-precision floats, control chars,
  trailing newline policy) that a hand-port can diverge from Rust
  without the corpus catching it (the corpus is finite).

Mitigation: a fuzz harness that compares Rust and TS canonical-JSON
output on random `serde_json::Value` inputs, run in CI. Cheap to write,
catches most drift.

### Compile / build complexity

`npm install @noble/hashes @noble/ciphers @noble/curves` and write code.
No new build step, no new toolchain, no new CI matrix entry. Vite
handles it natively.

---

## 4. Bundle-size target

The Phase 6 amendments don't pin an explicit hosted-JS budget, but the
spirit of the binary-size discipline applied in `binary-size-baseline.md`
suggests we should pick one **before** Phase 6 work starts.

Proposed target: **≤ 500 KiB gzipped** for the full hosted browser
bundle at `https://attn.dev/review/...`. Rationale:

- The native app's frontend bundle today is ~280 KiB gzip (ProseMirror
  + Svelte + reviewer-panel components). The browser variant inherits
  most of that.
- Crypto adds 55–140 KiB gzip depending on the choice in this doc.
- Browser-only paths (`browser-invite.ts`, mailbox transport over `fetch`,
  WebSocket handlers, optional `crypto.subtle` fallbacks) add another
  ~30–60 KiB gzip.
- Headroom for future deltas: ~100 KiB.

Sum: native-shared (~280) + crypto (~70–140) + browser-only (~50) +
headroom (~100) = ~500 KiB gzip total. Tight but reachable.

Concrete check: the spike that proves which option to pick **must**
include a measured gzip number, not estimates. Add a CI gate at
`web/scripts/check-bundle-size.sh` once the spike completes, modeled
on `scripts/check-binary-size.sh`.

---

## 5. Recommendation

**Pick Option B — hand-written TypeScript.**

Three reasons, in order of weight:

### 5.1 The trust posture is identical either way

The native client gets a categorical safety property: "JS cannot reach
the room keys." Phase 6 cannot replicate this. Whether the crypto runs
as WASM-compiled-from-Rust or as TS-running-`@noble`, the browser tab's
JS runtime has full access to `eventKey`, `snapshotKey`, etc. The
"single source of truth" appeal of WASM does not buy a trust upgrade
for browsers — it only matters in arguments about implementation
correctness, and the corpus tests address those directly.

This collapses the case for WASM from "essential" to "convenient." And
"convenient" is not enough to justify the build-system surface area.

### 5.2 The bundle-size delta favors TS

Best-case TS estimate: 55–80 KiB gzip.
Best-case WASM estimate: 95–140 KiB gzip.

The 500 KiB budget has roughly 100 KiB of headroom in either world,
but TS leaves that headroom for product features, while WASM consumes
it on `wasm-bindgen` glue and `serde_json`. If a measured spike shows
both options well under 100 KiB this argument weakens — but the
direction is clear.

### 5.3 The build complexity is lopsided

WASM requires:

- a new workspace member,
- `wasm-pack` + `wasm-bindgen` in CI,
- a Vite plugin,
- a feature-fence around `getrandom` and `tokio::sync::Mutex`,
- a development-loop story for HMR on Rust-side crypto edits.

TS requires:

- `npm install @noble/{hashes,ciphers,curves}`.

This is a Phase 6 doc, not a Phase 0 doc — by the time we're here, the
team has been shipping Rust for five phases and the appetite for "yet
another build target" is low. Every WASM cost above is paid in
addition to the Rust work that must continue.

### What this recommendation explicitly accepts

- Two implementations of the cipher suite must be maintained against
  the corpus. The corpus has been the spec-level guarantee from
  `crypto-spec.md` line 5 since the start; this just makes us honest
  about leaning on it.
- PoW mint is 3–6× slower in the browser than in WASM. The token-pool
  pattern already specified for both languages flattens this for the
  bursty agent case; the worst case is a 150–300ms mint on a cold
  submit, which is acceptable for a hosted reviewer.
- A fuzz harness comparing Rust and TS canonical-JSON output must
  ship alongside the TS implementation, run in CI, and gate browser
  bundle releases.

---

## 6. Implementation outline (Option B)

Sequence inside attn-nnj.9.x once this decision is ratified:

1. **Add deps** to `web/package.json`:
   ```json
   "@noble/hashes": "^1.x",
   "@noble/ciphers": "^1.x",
   "@noble/curves": "^1.x"
   ```
   Pin to whichever majors are current; these packages do semver
   conservatively.

2. **Port `canonical.ts`** from `src/review/crypto/canonical.rs`.
   Run against `planning/collab/test-vectors/canonical-json.jsonl` —
   100% pass required before any other file is written. The rules
   the Rust port enforces (sorted keys, omitted nulls in objects but
   preserved in arrays, `\uXXXX` only for control chars) translate
   directly.

3. **Port `kdf.ts`** using `@noble/hashes/hkdf` + `@noble/hashes/sha256`.
   Run against `kdf.json`. The `info` strings in `kdf.rs`
   (`INFO_ROOT`, `INFO_EVENT`, `INFO_SNAPSHOT`, `INFO_SIGNALING`,
   `INFO_ADMISSION`) become exported byte arrays in
   `web/src/lib/review/crypto/kdf.ts`.

4. **Port `aead.ts`** using `@noble/ciphers/chacha` (`xchacha20poly1305`).
   The AAD-bind struct (canonical JSON of `{v, roomId, envelopeId, kind,
   authorId, deviceId, createdAt}`) goes through `canonical.ts`.
   Run against `aead.json`.

5. **Port `signing.ts`** using `@noble/curves/ed25519`. Implement
   `signingKeyId = base64url(SHA-256(publicSigningKey))`. Implement
   `signEvent({meta, body})` and `verifyEvent` that build the same
   signed bytes Rust produces. Run against `event-signature.json`.

6. **Port `ids.ts`** — `EventId`, `EnvelopeId` (both forms, the
   `clientNonce` and the event-derived shortcut), `SnapshotId`,
   `FileId`, `ContentHash`. Run against `event-id.json` and the
   matching corpus files.

7. **Port `pow.ts`** with the same token format and a `TokenPool`
   class that pre-mints in a Web Worker. The mint loop is exactly
   the algorithm from `crypto-spec.md` §Client Implementation.
   Run against `pow.json`.

8. **End-to-end envelope test** — assemble an event in TS, encrypt,
   verify it round-trips through the Rust `envelope.rs` (and
   vice-versa). Lock this with the `envelope.json` corpus and a
   round-trip integration test.

9. **Fuzz harness**: a `cargo test` + `vitest` pair that generate
   random `serde_json::Value`s, canonicalize on both sides, and
   compare bytes. Add to CI.

10. **Bundle-size CI gate** at `web/scripts/check-bundle-size.sh`
    enforcing the 500 KiB gzip budget on a `vite build` of the
    Phase 6 entry point.

All steps map 1:1 to `crypto-spec.md` §Implementation Order. The same
ordering applies — corpus first, primitive second, no consumer code
before the corpus passes.

### If the recommendation is overridden and WASM is chosen instead

The carve-out plan from §2 still applies. The minimal viable steps:

1. Create `crates/attn-collab-crypto/` workspace member.
2. Move `src/review/crypto/{canonical,kdf,aead,signing,ids,pow}.rs`
   into it (keep PoW's `TokenPool` host-specific via a `#[cfg(not(target_arch = "wasm32"))]` fence).
3. Move the minimal subset of `src/review/{ids,model}.rs` it depends on
   into the same crate (just the typed-id newtypes and the `EventMeta` /
   `ReviewEventBody` `serde` shapes — not the apply/manager/store types).
4. Add `getrandom = { version = "0.2", features = ["js"] }` under
   `[target.'cfg(target_arch = "wasm32")'.dependencies]`.
5. Set up `wasm-pack build --target web --release` + `wasm-opt -Oz`.
6. Add a Vite plugin (`vite-plugin-wasm` is the lightest).
7. Run the same corpus tests from JS-side, this time as a thin
   `expect(roundTrip).toEqual(corpus.expected)` wrapper around the
   WASM exports.
8. Add a bundle-size CI gate.

The work is well-scoped and the existing Rust code base is structured
to support this carve-out (the crypto module already takes no
runtime/IO deps except for `tokio` in `TokenPool`). It is **not**
"hard" — it's "more pieces moving than the recommended path."

---

## 7. Open questions (flagged for human review)

1. **Should the corpus interop test be a Phase 0a deliverable or a
   Phase 6 deliverable?** Today the corpus is generated by Rust and
   the Rust side validates against it; there is no other implementation
   to cross-check until this decision lands. If we ratify Option B,
   the corpus interop test (TS reads Rust-generated vectors and asserts
   identical bytes) becomes a meaningful gate — and it could land in
   Phase 0a as a smoke check rather than waiting for Phase 6 UI work.
   The argument for "earlier" is that it forces us to confront
   canonical-JSON drift before any product surface depends on it. The
   argument for "with Phase 6" is YAGNI — until there's a browser
   client, the TS layer has no consumer. Recommend: Phase 0a smoke
   test, full Phase 6 integration. Confirm with reviewer.

2. **Hashcash difficulty: same 16 bits in the browser, or lower?**
   `crypto-spec.md` §Difficulty pins 16 bits across all clients with
   per-room `policy.powBits` in `[12, 24]`. Browser median mint at
   16 bits is 150–300ms (TS) or ~50ms (WASM). The mailbox-only Phase 6
   flow does write less often than a native owner (no snapshot
   creation, no `RoomCreated`, just `ParticipantJoined` + comments +
   suggestions), so 16 bits is probably fine — but if reviewer UX
   feels sluggish on cold submits, a 14-bit browser tier (still
   ≥ the spec's clamp floor of 12) is a possible escape valve.
   Decision deferred to "measure once a real Phase 6 reviewer flow
   exists." Don't pre-optimize.

3. **(WASM path only, contingent.) Streaming compile vs ahead-of-time
   bundling.** If the human reviewer overrides the recommendation
   toward WASM, there's a sub-decision: do we use
   `WebAssembly.instantiateStreaming(fetch("/crypto.wasm"))` (two
   network requests, parallel parse-while-download) or inline the
   `.wasm` as base64 in the JS bundle (one request, slower cold
   parse)? Streaming wins on cold-load latency but adds a CDN
   Content-Type configuration burden for `attn.dev/review/`. Inline
   wins on simplicity. Default recommendation if this path is
   chosen: inline for v1, switch to streaming if the cold-load
   number exceeds the budget. Not relevant if the primary
   recommendation (TS) stands.

---

**Total decision surface**: WASM vs hand-written TS for the Phase 6
hosted browser client's cipher-suite implementation.

**Recommendation**: hand-written TS against `@noble/{hashes,ciphers,curves}`
plus an in-house canonical-JSON helper, validated against the existing
`planning/collab/test-vectors/` corpus and a fuzz harness.

**Awaiting**: human ratification + open-question disposition.
