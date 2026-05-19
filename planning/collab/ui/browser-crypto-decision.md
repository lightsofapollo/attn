# Browser Crypto Sourcing — WASM vs Hand-Written TypeScript

Status: design proposal — awaiting human review (attn-nnj.9.1).
Blocks: Phase 6 browser review client (`https://attn.dev/review/<roomId>#key=...`).
Owner of decision: pending human reviewer; this doc carries an opinionated recommendation.

References:

- `planning/collab/amendments.md` §Decision #4 — locked cipher suite
  (XChaCha20-Poly1305 + Ed25519 + HKDF-SHA-256 + RFC 8785 JCS + base64url-no-pad).
- `planning/collab/amendments.md` §Decision #1 + §Phase 6 — Phase 6 browser
  path is mailbox-only by design (no `RTCPeerConnection` in browser JS).
- `planning/collab/crypto-spec.md` — full primitive list, corpus layout
  (`planning/collab/test-vectors/{kdf,canonical-json,event-signature,event-id,aead,envelope,pow}.json`).
- `src/review/crypto/{canonical,kdf,aead,signing,ids,pow}.rs` — the Rust
  implementations that pass the corpus today.
- `planning/collab/binary-size-baseline.md` — measurement methodology precedent.

---

## 1. Context

The native client (Phases 0–5) does **all** crypto in Rust: `ReviewManager`
owns the room keys, decrypts envelopes from `transport.rs`, verifies Ed25519
signatures, mints PoW, and emits typed `ReviewUpdate` events to Svelte over
the wry IPC bridge. The frontend in the native app **never sees ciphertext**,
never holds `rootKey`/`eventKey`/`snapshotKey`/`signalingKey`/`admissionKey`.

The Phase 6 hosted browser client at `https://attn.dev/review/<roomId>#key=...`
has the opposite shape: JS parses `#key=` (Decision #13 — memory-only,
immediately `replaceState`-stripped), derives the room key tree, calls the
relay over `fetch`+WebSocket with `admissionKey` HMAC, decrypts inbound
envelopes (XChaCha20-Poly1305), verifies Ed25519 signatures, signs outbound
events, and mints hashcash PoW tokens (on a Web Worker).

So Phase 6 is the **only place TypeScript-side crypto must live**. The
choice between options below shapes whether the TS package boundary is
"thin wrappers over WASM exports" or "real TS modules", and the corpus
work needs to land before the browser client can mock-render events:

- **(a)** Compile `src/review/crypto/*` to WASM via `wasm-pack` +
  `wasm-bindgen`, ship `.wasm` + ESM glue alongside the bundle.
- **(b)** Write a hand-rolled TS implementation of the same primitives,
  validated against the existing corpus.

---

## 2. Option A — Compile Rust attn-collab-crypto to WASM

### What gets compiled

Only the pure-crypto subset of `src/review/crypto/`: `canonical`, `kdf`,
`aead`, `signing`, `ids`, and the `pow` mint/verify loop (its `TokenPool`
uses `tokio::sync::Mutex` and must be fenced out — see below).

The browser does **NOT** need (and these MUST NOT be in the WASM build):
`src/review/envelope.rs` (wire framing; TS handles it), `src/review/transport/`
(`reqwest`, `tokio`, `webrtc` — browser uses `fetch`/`WebSocket` natively),
and `src/review/{manager,store,watcher_state,working_copy,apply,bootstrap,ipc}.rs`
plus `anchors/` — anything that touches the filesystem, the wry IPC, or
the daemon lifecycle.

So the WASM module is a **carved-out crypto crate** (the seven crypto
files plus the typed-id + `EventMeta`/`ReviewEventBody` `serde` shapes
from `src/review/{ids,model}.rs`), not "compile all of attn to wasm."

### Required Cargo restructure

Needs a workspace member, not just a build flag: the current crate is
a binary pulling in `tao`/`wry`/`webrtc` (none of which compile to
`wasm32-unknown-unknown`); `crypto::pow::TokenPool` uses `tokio::sync::Mutex`
which must be fenced out; `crypto::signing` and `crypto::ids` depend on
`crate::review::model` and `crate::review::ids` which need to come along.

Concretely: introduce `crates/attn-collab-crypto/` as a workspace member
holding the seven crypto files + the typed-id and event-model `serde`
shapes, with no runtime deps. Main `attn` depends on the leaf; the leaf
compiles to both `aarch64-apple-darwin` (daemon) and `wasm32-unknown-unknown`
(browser).

### Crate-level compile cleanliness on `wasm32-unknown-unknown`

Audit of the dep set: `sha2`, `hkdf`, `chacha20poly1305`, `ed25519-dalek` (via
`curve25519-dalek`), `base64`, `zeroize`, `serde_json` — all pure-Rust and
wasm-clean. **`getrandom = "0.2"` needs `features = ["js"]`** on `wasm32`
to route to `crypto.getRandomValues` instead of the default panicking
backend (this is the single most common WASM crypto gotcha). **`tokio`**
is only pulled in by `pow::TokenPool`'s `tokio::sync::Mutex` and must
be fenced via `#[cfg(not(target_arch = "wasm32"))]` — the mint loop
itself uses only `sha2`+`getrandom`+`base64` and compiles fine. Ed25519
stays inside the WASM (no detour through async `crypto.subtle`).

The WASM build is a five-line `Cargo.toml` change + the `getrandom` feature
flag + a `TokenPool` fence. The hard work is structural (splitting the
crate), not technical.

### Bundle size — estimated

No measured number yet. Reasoned back-of-envelope based on community
comparables (`-Oz` + `wasm-opt`, ESM-bundled, gzip):

- `ed25519-dalek` + `curve25519-dalek`: ~55–75 KiB.
- `chacha20poly1305` + `chacha20` + `poly1305`: ~10–14 KiB.
- `sha2` + `hkdf` + `getrandom`: ~6–9 KiB.
- `serde_json` + `wasm-bindgen` glue + canonical helper: ~25–40 KiB.
  Wasm-bindgen glue is the surprise cost.
- ID derivation + PoW mint: negligible on top of sha2.

**Best-case estimate: ~95–140 KiB gzipped** for the carved-out crypto
WASM + JS glue. **Must be measured during the spike** — if the real
number is ≥ 250 KiB gzip we are spending almost half the Phase 6 bundle
budget on crypto, which changes the calculus.

### Performance

- AEAD seal/open: WASM ChaCha20-Poly1305 ~200–400 MiB/s vs `@noble/ciphers`
  ~80–150 MiB/s. For events (1–4 KiB) and inline snapshots (≤ 100 KiB),
  both sub-ms — irrelevant to UX.
- Ed25519 sign: ~50–100 µs WASM vs ~200–500 µs `@noble/curves`. Below
  human perception either way.
- **PoW mint, 16 leading zero bits**: median ~65k SHA-256 attempts.
  WASM `sha2` benches ~80–150 MH/s → median mint **~50ms** (matches
  the spec figure). `@noble/hashes/sha256` benches ~5–15 MH/s →
  **~150–300 ms** median. Web Worker either way.
- Snapshot decrypt (100 KiB): WASM ~0.5 ms; JS ~2–4 ms. Both fine.

Only PoW mint is in the "user notices" range, and the spec already
calls for token-pool pre-mint that flattens this — `TokenPool` absorbs
the cost during idle.

### Trust profile

WASM in a hosted-JS context has **exactly the same** trust profile as
hosted JS — same origin (`https://attn.dev/...`), same CSP, same network
visibility, same ability to exfiltrate `roomSecret` if the origin is
compromised. Decision #13 (URL fragment memory-only) caps the worst case
to in-tab JS for the session.

The native client's "frontend never sees keys" property **cannot** be
replicated in a browser — there is no non-JS layer to retreat to.
Picking WASM does NOT recover the native trust posture; it just shifts
where the crypto code is loaded from. Important to be honest about.

### Maintenance

WASM = one implementation, byte-identical across targets. Spec change in
`src/review/crypto/*` propagates to the browser on the next bundle build.
Corpus tests become belt-and-suspenders rather than primary guarantee.

### Compile / build complexity

New workspace member; `wasm-pack build --target web` in the web build
step; `vite-plugin-wasm` (or `@rollup/plugin-wasm`); a local-package
`devDependency` on `crates/attn-collab-crypto/pkg`; CI installs
`wasm32-unknown-unknown` + `wasm-pack`. Production build inlines the
`.wasm` (one request) or serves it with the right Content-Type.
HMR with `task dev` must rebuild WASM on Rust crypto edits — `cargo build
-p attn-collab-crypto --target wasm32-unknown-unknown` is ~1–2s
incremental, ~15–25s clean. Mitigation: a `wasm-pack build --dev`
watcher alongside Vite; only release runs `-Oz` + `wasm-opt`.

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

- **`@noble/hashes`** — SHA-256 + HKDF. Audited, zero-deps, MIT.
- **`@noble/ciphers/chacha`** — `xchacha20poly1305`. Audited, zero-deps;
  `crypto-spec.md` line 34 already names this package.
- **`@noble/curves/ed25519`** — Ed25519 sign/verify. Audited. Browser-native
  `crypto.subtle.sign({name:"Ed25519"})` is an alternative (Chrome 113+,
  Safari 17+, Firefox 129+) but its `Promise<ArrayBuffer>` shape forces
  `async` through `signing.ts` + `ids.ts`. Using `@noble/curves` keeps
  call sites symmetric with Rust (matches spec line 35).
- **`crypto.getRandomValues`** for entropy (no library).
- **In-house canonical-JSON helper** — port of `canonical.rs`, ~200 LOC.
  Same omission/sorting/escape rules; Rust test suite mirrored line-for-line.
- **In-house base64url-no-pad helper** — ~30 LOC, no dep.

No build-step gymnastics. `npm install` and code.

### Bundle size — estimated

- `@noble/hashes/sha256` tree-shaken: ~6–9 KiB gz.
- `@noble/hashes/hkdf`: ~1–2 KiB gz.
- `@noble/ciphers/chacha` (xchacha20poly1305 only, tree-shaken): ~10–14 KiB gz.
- `@noble/curves/ed25519` (sign + verify, tree-shaken): ~30–45 KiB gz.
- In-house canonical-JSON + base64url + IDs + PoW + AEAD wrapper: ~5–10 KiB gz.

**Best-case estimate: ~55–80 KiB gzipped** for the full crypto layer.

This is **smaller** than the WASM estimate by ~40–60 KiB gzip in the
median case — tree-shaking is more aggressive on `@noble/*` than WASM
(`wasm-bindgen` glue is a fixed tax) and we skip `serde_json` overhead.

### Performance

PoW mint is the only meaningful concern: JS `@noble/hashes/sha256` benches
~5–15 MH/s → median ~150–300 ms in a Web Worker, 3–6× slower than WASM.
For a single submit, invisible (token pool pre-mint amortizes). For a
bursty 20-event agent, the pool needs ~20 pre-minted tokens — the spec
already calls for this (crypto-spec.md §Client Implementation, line 187).
TS is slower but in the same ballpark; the pool flattens the worst case.

### Trust profile

Identical to WASM — same origin, same JS environment. A small lean in
TS's favor: `vite build` output is minified-but-readable while
`wasm-pack --release` output is opaque without source maps, so
"can a security reviewer verify the deployed bundle?" is slightly easier.
Marginal for an open-source spec where source is on GitHub regardless.

### Maintenance

Two implementations means **two implementations**. The corpus is the
contract; it works, but every spec change requires two commits/two
reviews. JS oddities (UTF-16 indexing, `Number` vs `BigInt` for ms
timestamps, JSON.stringify ordering) won't be caught by Rust tests —
they'll surface the first time the browser talks to a Rust client.
The canonical-JSON port is the highest-risk surface: RFC 8785 has enough
edge cases (control chars, trailing newline policy, escape rules) that
a hand-port can diverge without a finite corpus catching it.

Mitigation: a fuzz harness comparing Rust and TS canonical-JSON output
on random `serde_json::Value` inputs, run in CI. Cheap, catches most drift.

### Compile / build complexity

`npm install @noble/{hashes,ciphers,curves}` and write code. No new
build step, no new toolchain, no new CI matrix entry. Vite handles it.

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
