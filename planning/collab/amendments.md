# attn Collaboration v2 — Plan Amendments

This document amends `data-model.md` with corrections, missing decisions, and codebase realities surfaced by the audit. The original plan is the design baseline; this document overrides it where they conflict.

## Codebase Corrections

### `architecture.md` is stale; the plan is correct on the editor

The plan references **ProseMirror** throughout (`pmRange`, `pmSteps`, `web/src/lib/prosemirror/review.ts`, "ProseMirror selection, decorations, local step journal"). This is correct. The current `web/src/lib/Editor.svelte` and `package.json` use ProseMirror — eleven `prosemirror-*` packages, no CodeMirror. `planning/architecture.md` lines 13 / 66 / 84-91 incorrectly describe a CodeMirror 6 edit mode that does not exist; update `architecture.md` separately, not the collab plan.

Action: track `architecture.md` correction as its own task. Not on the collab critical path.

### `main.rs` is 1207 lines, not a thin CLI

The plan implies `src/main.rs` is "CLI parsing and daemon startup." In reality it also owns: the wry window setup, theme injection, the full tao event loop, the custom `attn://` URL scheme handler, the screenshot/automation path, the project switching state machine, and the initial tree-snapshot loader.

Action: the new `ReviewManager` integrates into the *existing* event loop, not a new one. Expect a `UserEvent::Review(ReviewUpdate)` arm added to the `event_loop.run` match in main.rs, with handlers that call `evaluate_script(window, "window.__attn__.reviewEvent(...)")`. Do not factor out a new event loop in this phase.

### `watcher.rs` does more than reload

Plan says "file watcher events only tell the frontend to reload." False — `UserEvent` has 15+ variants including `OpenPath`, `SwitchProject`, `LoadChildren`, `SearchFiles`, `ChildrenLoaded`, `SearchResults`, `FontScaleIncrease/Decrease/Reset`, `InstallCliAlias`, `Screenshot`, `Info`, `Eval`, `OpenDevtools`, `DragWindow`, `ShowWindow`, `HideWindow`, `Quit`.

Action: collaboration-aware watcher integration adds new variants alongside the existing ones. The self-write-vs-external distinction goes into the `FsChanged` handler specifically, not into a wholesale rewrite.

### Tabs and projects are first-class; the plan's `AppState` is wrong

The plan proposes:

```rust
pub struct AppState {
    pub active_path: PathBuf,
    pub active_project_root: PathBuf,
    pub active_tab_id: Option<String>,
    pub file_bindings: HashMap<FileId, PathBuf>,
    pub review_rooms: Vec<RoomId>,
}
```

Reality: the frontend manages multi-tab state with per-project scoping (`web/src/lib/tabs.ts`, `web/src/App.svelte` `scopedTabsByProject` map). The Rust side has a `ProjectRegistry` (`src/projects.rs`). A user can have two tabs open in different projects pointing at unrelated files, plus background daemon connections to multiple review rooms.

**Decision**: review rooms are keyed by `RoomId`, not by tab or by file. A single file may participate in zero or one review room at a time (the binding is one-to-one). A single review room is scoped to one logical document but may be visible across multiple tabs (e.g., owner has the file open in two splits).

Revised `AppState`:

```rust
pub struct AppState {
    pub active_path: PathBuf,
    pub active_project_root: PathBuf,
    pub active_tab_id: Option<String>,
    pub review_rooms: HashMap<RoomId, RoomRuntimeHandle>,
    pub file_to_room: HashMap<PathBuf, RoomId>, // owner-side binding
}
```

The heavy state stays in `ReviewManager` as the original plan intended. `AppState` is routing/lookup context, not storage.

### Crypto crate dependencies must be named in Cargo.toml early

Plan does not name the crates. To avoid a surprise during `cargo build` on a downstream contributor's machine:

```toml
[dependencies]
sha2 = "0.10"
hkdf = "0.12"
chacha20poly1305 = "0.10"
ed25519-dalek = "2"
base64 = "0.22"
getrandom = "0.2"
zeroize = { version = "1", features = ["derive"] }
```

Add to `Cargo.toml` in Phase 0 before any review-module code lands. Confirms `build.rs` still works on both debug and release.

### Mock IPC must be extended for parallel frontend dev

`web/src/lib/mock-ipc.ts` is 100 lines; the frontend uses it for UI iteration without a live Rust daemon. The plan's new `window.__attn__.reviewStatus(...)`, `reviewEvent(...)`, `reviewSnapshot(...)`, `reviewAnchorResolution(...)` callbacks need mock generators here, with a small replayable event stream, so frontend work in Phase 2 ("Review UI without network") is not blocked on Rust crates landing.

### Custom `attn://` scheme handler

`src/main.rs` already registers a custom protocol for serving local files via `attn://localhost/...`. The invite URL `attn://review/<roomId>#key=...` collides with this. Pin the path-prefix convention:

- `attn://localhost/...` — file serving (existing)
- `attn://review/...` — invite handling (new)
- `attn://localhost/review/...` — reserved, do not use

The custom-scheme handler in `main.rs` must route `attn://review/...` to the daemon's `ReviewJoin` socket command before falling through to file serving.

### Existing automation flags affect ReviewManager design

Debug builds support `--screenshot`, `--eval`, `--click`, `--wait-for`, `--query`, `--fill`. These are useful for E2E testing the review UI. The `ReviewManager` should expose enough state through `--eval`-reachable globals (e.g., `window.__attn__.reviewState()`) that an E2E test can assert "comment appeared," "anchor resolved as remapped," etc., without screenshotting.

## Missing Design Decisions (Pinned)

### Snapshot creation cadence

Original plan: undefined. Pinned:

- **On share**: first `share` creates the initial snapshot from the current working copy.
- **On owner save**, if `time-since-last-snapshot > 30s` AND `bytes-changed-since-last-snapshot > 256` AND `there is at least one open thread`, create a new snapshot superseding the prior. Otherwise the working copy advances under the same snapshot via the `LocalRevision` journal.
- **On owner explicit "publish snapshot"** action in the UI.
- **Never** per-keystroke. Per-keystroke would blow the 500-event cap immediately.

`parentSnapshotId` vs `supersedesSnapshotId` — pinned:

- `parentSnapshotId` always points to the immediately previous snapshot of the same `fileId` (linear chain; branches are not modeled in v2).
- `supersedesSnapshotId` is set only on a "rolling forward" snapshot that obsoletes its parent for the purpose of the *next* round of reviewer attention. UI displays "snapshot superseded" badge on the old one. Without `supersedesSnapshotId`, both snapshots remain "current" for review (e.g., owner published an intermediate snapshot but isn't asking reviewers to switch yet).

In v2, every owner-side snapshot creation also emits `SnapshotSuperseded` for the previous snapshot. The dual-event model is preserved for forward compat (when branches are added in v3) but the v2 UX is linear.

### Anchor resolver disagreement policy

Original plan: 8 steps fall through. Reality: real markdown often satisfies steps 3, 4, and 5 with different candidate ranges.

Pinned algorithm:

1. Run **all** resolution steps that can produce a candidate (don't short-circuit on first hit).
2. Each step emits zero or more `ResolvedAnchorCandidate`s with the step's confidence.
3. Combine into a single candidate set, deduplicated by `currentRange`.
4. If exactly one candidate has confidence ≥ 0.70 → emit `status: "remapped"` (or `"exact"` if 1.00).
5. If two or more candidates have confidence ≥ 0.70 and the top two are within 0.10 of each other → emit `status: "ambiguous"` with all candidates above 0.50.
6. Else if any candidate has confidence ≥ 0.35 → emit `status: "remapped"` with the top one.
7. Else → emit `status: "stale"`.

UI cutoffs:

- ≥ 0.90 → inline highlight, no "moved" badge
- 0.70–0.89 → inline highlight + "moved" badge in panel
- `ambiguous` → panel-only with picker
- `stale` → panel-only, requires manual re-anchor

The confidence numbers in `data-model.md` lines 491-502 are starting values. Treat them as tunable; calibrate against a markdown edit corpus once the engine is buildable. Add a `confidence-calibration.md` task post-Phase 1.

### Multi-device replication of a participant's own events

Original plan: silent failure mode. With `deleteEventsAfterOwnerAck`, owner Device A imports and acks → server deletes → owner Device B never sees it.

**Pinned for v2**: not solved at the protocol layer. Documented as a known limitation:

- The owner is expected to do review intake on a primary device.
- If owner has multiple devices, owner uses `deleteEventsAfterOwnerAck: false` in the room policy.
- When the room ends, all owner devices share state via the local `~/.attn/reviews/rooms/<roomId>/` directory, which is a candidate for user-initiated sync via existing file-sync tools (iCloud, Syncthing) — out of scope for v2 to manage.

Add to room creation UI: a checkbox "I only use one device for review" that controls the default of `deleteEventsAfterOwnerAck`. Default is **false** (safer) so multi-device users don't lose data by surprise.

This decision is a deliberate v2 simplification. v3 may add device-to-device sync via published `publicEncryptionKey`.

### Snapshots are never auto-deleted on the relay

Independent of the events policy: `snapshot_blob` envelopes are kept until room TTL, regardless of ACKs. The motivation is recovery — a rejoined client with a wiped local store can re-pull the latest snapshot and resume.

This adds a constraint to `relay-spec.md` caps: `maxRoomBytes` must accommodate `maxSnapshotBytes × ~3` (one current + a couple superseded) on top of the event log. Current cap of 25 MiB is fine.

### Recovery from local-store loss

Pinned protocol:

1. Client rejoins room with `roomSecret`.
2. Client calls `GET /devices` to learn peers and verify owner key.
3. Client calls `GET /envelopes?after=0` to backfill (subject to `410 ATTN_CURSOR_TOO_OLD` if events are gone).
4. Client filters for the latest `snapshot_created` event per `fileId`, fetches the snapshot blob (inline or via R2).
5. Client rebuilds local replicas from the snapshot + remaining events.
6. If the latest snapshot is *also* gone (only possible if owner exceeded `maxRoomBytes` and old snapshots were evicted — not the current design) → emit `RoomState::Unrecoverable`, surface "this room can no longer be recovered" UI, suggest the owner re-share.

In live mode, recovery may also happen P2P via a `RequestSnapshot` signaling message (a new `kind: "request_snapshot"` signal envelope, content = `{ fileId, sinceSnapshotId? }`; owner responds with a fresh `SnapshotCreated` event over the DataChannel).

### Outbox mutability and freezing

A drafted event sits in `outbox.jsonl` until first send-attempt. Before send, the user may edit (`Edit` rewrites the existing line). After the first send-attempt, the entry is **frozen** — its `EnvelopeId` is committed, so the relay can dedupe retries. Subsequent edits create a new outbox entry with a new `EnvelopeId` and the old one is marked `superseded` locally (still sent for correctness; receivers handle ordering via `parentEventIds`).

### Agent CLI key handling

Pinned:

- Local agents driven by `attn review submit-comment` and friends use the **owner's daemon identity** by default. A finding by a local agent is attributed to the owner participant unless explicitly registered.
- `attn review register-agent <name>` creates a new agent participant with its own Ed25519 keypair persisted under `~/.attn/agents/<name>/identity.json`. Subsequent `attn review --as-agent <name> submit-comment ...` signs with that key.
- Remote agents (different machines or hosted) join the room as `kind: "agent"` participants and are first-class members with their own keys, registered via `POST /devices` like any reviewer.

### Inline snapshot encryption over DataChannel

The original plan inlines `SnapshotCreated.inlineSnapshot.markdown` as plaintext, justified by "DataChannel is DTLS-encrypted." Pinned override: **always encrypt at the application layer**. `SnapshotCreated.encryptedBlobRef` is the only transport for snapshot bytes, both for live (where the BlobRef can point to "inline" with a Base64 ciphertext payload in the event itself, up to the event cap) and async (BlobRef points to a mailbox envelope or R2). This makes the trust boundary identical across modes and avoids a future "transcript-log-to-disk" feature accidentally leaking plaintext.

Inline path: `BlobRef { storage: "inline", contentHash, byteLength, blobId == eventId }` where the ciphertext bytes live inside the same `SnapshotCreated` event body (encrypted under `snapshotKey` with the event's AAD). For small markdown (≤ 100 KiB-ish) this fits in the event cap. For larger files, use `storage: "mailbox"` or `storage: "r2"`.

### Snapshot-blob ciphertext lives outside the event envelope's AEAD

When a snapshot is large enough to need R2:

- The snapshot bytes are encrypted under `snapshotKey` independently (random nonce, no AAD — the BlobRef carries an integrity hash).
- The R2 object body is `nonce || ciphertext || tag`.
- The `SnapshotCreated` event carries the (now-small) BlobRef.
- The BlobRef itself is part of the event body, AEAD-protected under `eventKey` like any other event field.

This double-encryption is intentional: the BlobRef's existence is event-log content (signed, replicated, AAD-bound to author), while the bulk bytes are bulk storage.

### Phase 4 WebRTC: Rust-owned (Decision #1)

Originally this section called for a Phase 0.5 spike to validate WebRTC + WebCrypto in `wry`/WKWebView under `attn://`. **That approach was overridden.** Decision #1 commits to Rust `webrtc-rs` upfront — the frontend never owns an `RTCPeerConnection`. The spike, the `attn://` WebRTC path, and `planning/collab/webrtc-spike-result.md` are no longer needed.

Tradeoffs accepted:

- `webrtc-rs` is a large crate (transitively brings tokio, rcgen, sctp, dtls, openssl-sys or rustls). Run `cargo tree -e features --no-default-features --no-dev-dependencies` before merging to confirm the binary stays under the **30 MiB** target. If it doesn't, evaluate feature flags or revisit. **(Revised 25 → 30 MiB:** with `webrtc-rs` landed, a fully size-optimized release build — `opt-level="s"`, `lto="fat"`, `strip` — is ~29 MiB; the P2P transport stack makes 25 unrealistic, so the budget was raised to 30. The gate enforces 30 in `scripts/check-binary-size.sh`.)
- No exploration of the browser WebRTC path. Phase 6 browser client will need a separate WebRTC story (or skip WebRTC entirely and use mailbox-only for browser, which is consistent with the trust model).
- Single language for transport (Rust) means one codepath for mailbox + DataChannel, one place for AEAD, one place for envelope import. Simpler.

## Phasing Override

Original `data-model.md` "Implementation Phases" (lines 1166-1217) collapses too much into Phase 0 and underestimates Phase 3. The Rust-side phasing on lines 1126-1136 is more realistic. Use this combined sequence:

### ~~Phase 0.5: WebRTC + WebCrypto Spike~~ (removed)

Decision #1 made this unnecessary. Skip to Phase 0a.

### Phase 0a: Crypto Foundations

- Land `Cargo.toml` crypto crates (see Codebase Corrections above) plus `webrtc-rs` (per Decision #1) — checking the binary-size impact early avoids a Phase 4 surprise.
- Build canonical JSON helpers (Rust + TS).
- Write the `test-vectors/` corpus, including `pow.json` for hashcash.
- Implement KDF, AEAD, Ed25519, hashcash mint+verify, ID helpers in both languages and pass the corpus.
- No `ReviewManager` yet, no IPC yet.

Deliverable: a Rust `attn-collab-crypto` mod + a TS `web/src/lib/review/crypto.ts` that interop on the corpus. PoW miner runs off-thread (Rust: `spawn_blocking`; TS: Web Worker) from day one.

### Phase 0b: Local Data Model + Working Copy

- Typed IDs and serde types in Rust.
- JSON/JSONL store under `~/.attn/reviews/`.
- `WorkingCopyService` replacing direct `std::fs::write` in `ipc.rs`.
- Revision journal with `LocalRevision`.
- Watcher self-write distinction.
- Empty `ReviewManager` (no rooms yet, just lifecycle and event-loop integration).
- Update `AppState` to the revised shape above.

Deliverable: `cargo test` covers store dedupe and revision journal. UI unchanged.

### Phase 1: Anchor Engine

- `AnchorIndex` build from the existing ProseMirror schema.
- Anchor construction from selection.
- Anchor resolution implementing the pinned disagreement policy.
- Unit-tested against a hand-curated markdown-edit corpus (~50 cases covering exact/remapped/ambiguous/stale).

Decision required before starting: anchor index computed in Rust (canonical, slower) or in the browser (faster, drift risk). **Pinned: Rust.** The canonical bytes the snapshot is hashed from must produce the canonical anchor index, and both go through the same comrak pipeline. The browser receives the AnchorIndex pre-computed in `SnapshotCreated` events.

### Phase 2: Review UI With Mocked Transport

- Review panel in Svelte.
- Comment/suggestion decorations.
- Extended `mock-ipc.ts` emits review events and statuses.
- Demonstrate a comment surviving owner edits using only the local anchor engine.

No relay code yet.

### Phase 3a: Relay Spec → Worker Skeleton

- Implement `relay/` from `relay-spec.md` against Miniflare.
- Conformance corpus: a JSON file of HTTP calls + expected responses, run by both `wrangler dev` integration tests AND the Rust client's transport tests.

### Phase 3b: Rust Transport Client (Mailbox)

- Implement `src/review/transport.rs` against the conformance corpus.
- Outbox processing.
- Pull cursor / 410 recovery.

### Phase 4: Rust WebRTC Transport

- Add `webrtc-rs` to `Cargo.toml` and confirm binary size impact (target: stay under 25 MiB release).
- Implement WebRTC arm of `src/review/transport.rs` alongside the mailbox arm from Phase 3b.
- Encrypted signaling envelopes (`kind: "signal"`) flow via the relay WebSocket; decrypted SDP/ICE handled in Rust against `signalingKey`.
- DataChannel envelope format is **identical** to mailbox envelopes — same AEAD under `eventKey`/`snapshotKey`, same routing semantics, same import path. Just a different wire.
- In `policy.mode == "hybrid"`, mailbox is the always-on fallback; DataChannel is opportunistic. In `live` mode, surface direct-connection failure explicitly (no silent mailbox fallback).
- Frontend never sees raw transport — only typed `ReviewUpdate` events emitted by `ReviewManager` after decrypt+signature-verify+import.

### Phase 5: Owner Apply Flow

- Three-way apply UI.
- Suggestion resolution against current owner file using anchor engine.
- Expected-text verification.
- Write through `WorkingCopyService` so a `LocalRevision` is recorded.
- Emit `SuggestionAccepted`.

### Phase 6: Browser And Remote Agents

- Browser review client (parses the `https://attn.dev/review/...` URL form).
- Browser-specific docs in the trust model section.
- Remote agent participant type.

## Decisions Locked (2026-05-18)

All previously-open questions have been answered. The decisions below are the v2 baseline and supersede any earlier "TBD" or "open question" language in `data-model.md`, `relay-spec.md`, or `crypto-spec.md`. Each decision lists the rationale and the doc(s) it pins.

The product is reframed as **agentic collaboration** — primary use case is an agent (e.g., a coding assistant) reviewing a markdown plan, leaving comments and suggestions, and the owner accepting them locally. Most rooms last minutes to an hour. Human-to-human review is a supported secondary use case with a longer TTL via explicit opt-in.

### Architecture (decisions 1–4)

**1. WebRTC transport lives in Rust.** No Phase 0.5 spike. Rust uses `webrtc-rs` for the DataChannel arm of `src/review/transport.rs`; the frontend never holds an `RTCPeerConnection`. Decrypted/verified events flow up through `ReviewUpdate` to Svelte. Tradeoff: `webrtc-rs` is a large crate — verify binary stays under 25 MiB before merging. Pins: `data-model.md` Transport Ownership, `relay-spec.md` Signaling, `amendments.md` Phase 4.

**2. Relay admission is URL-as-bearer + HMAC.** No device-token issuance. `admissionKey = HKDF(rootKey, "attn relay admission v2")` HMACs every request. Threat model documents that URL possession = admission. Rationale: matches the E2E "client holds the only secret" framing; per-device tokens would require server state and asymmetric room-creator-vs-joiner flows. Pins: `relay-spec.md` Admission Key, `crypto-spec.md` Key Derivation.

**3. Owner identity is cryptographically bound** to `ownerSigningKey` registered at `POST /v2/rooms/:roomId`. Privileged ops (`POST /acks` with delete, `DELETE /v2/rooms/:roomId`) require `Attn-Owner-Signature` (Ed25519 over `canonicalRequest`). Reviewers cannot impersonate the owner even with the URL. Pins: `relay-spec.md` Owner Distinction, `crypto-spec.md` Signing-Key Publication.

**4. Cipher suite is locked.** XChaCha20-Poly1305 (AEAD, 24-byte random nonce, AAD-bound metadata) + Ed25519 (signatures) + HKDF-SHA-256 (key derivation, fixed `info` strings) + canonical JSON per RFC 8785 + base64url-no-pad. No agility in v2; v3 will re-derive distinct keys from the same `roomSecret` if the suite changes. Pins: `crypto-spec.md` Primitives.

### Transport & Auth (decisions 5–7)

**5. WebSocket only** for envelope delivery. `GET /v2/rooms/:roomId/envelopes` removed entirely; backfill flows through the WS `hello` + `envelope` frames. Stale-cursor recovery is signaled via `error` frame + close code `4005`. Rationale: dropping long-poll halves the relay endpoint surface area and matches reality (the Rust client is the only first-class client in v2). Pins: `relay-spec.md` removed `GET /envelopes`, added close code `4005`.

**6. Hashcash proof-of-work on every write.** `POST /devices`, `POST /envelopes`, `POST /acks`, `POST /blobs`, `DELETE` all require `Attn-PoW`. Default difficulty 16 leading zero bits (~50ms client cost). Per-room override via `policy.powBits` in `[12, 24]`. **No exemption** for local, daemon-driven, browser, or agent clients — symmetric treatment defeats an attacker who can run the daemon binary. Tokens bind `(roomId, deviceId, method, path)` with 5-minute expiry, full replay protection. Pins: `crypto-spec.md` §Hashcash, `relay-spec.md` §Anti-Abuse + per-endpoint headers.

**7. `POST /envelopes` batch cap = 32.** Larger batches → `400 ATTN_BATCH_TOO_LARGE`. Single PoW token covers the whole batch. Sized to bulk-catchup (200 events = 7 round trips) without monopolizing the DO event loop. Pins: `relay-spec.md` upload behavior.

### Lifecycle (decisions 8–11)

**8. Room TTL = 1h idle + 24h hard-max (default).** Two DO alarms; first to fire wins. `policy.expiresAt` clamped to `createdAt + 24h` unless `policy.longSession == true`, in which case clamped to `createdAt + 7d` (for human review). `policy.idleTimeoutMs` defaults to 1h, min 1m, max equal to wall-clock TTL. Tuned for agentic collab where most rooms last minutes. Pins: `relay-spec.md` Alarms + Caps table.

**9. R2 lifecycle TTL = 7 days** (matches max wall-clock room TTL with `longSession`). Safety net only; DO alarm is primary cleanup. With default 24h rooms, ~7× headroom. Mitigation against alarm slippage near TTL: every WS connect runs `cleanup_check()` if the room is within 1h of `expiresAt`. Pins: `relay-spec.md` R2 Integration.

**10. Snapshot eviction: keep all snapshots until room TTL.** Snapshots (and comments anchored to them) are preserved against `maxRoomBytes` (25 MiB accommodates 3-5 medium snapshots plus an event log). A wiped client rejoining can re-pull any snapshot a comment anchored to and replay events. Pins: `data-model.md` Snapshot Graph, `relay-spec.md` Caps.

**11. Snapshot creation cadence: heuristic + explicit.** Cadence: on share, on save if `time-since-last-snapshot > 30s` AND `bytes-changed > 256` AND `at least one open thread`, on explicit `attn review snapshot`. Agents that want per-iteration checkpoints call the CLI explicitly. Per-keystroke snapshots would blow the 500-event cap immediately. Pins: above §Missing Design Decisions.

### Trust & Data (decisions 12–14)

**12. Multi-device owner is not solved at protocol level in v2.** `deleteEventsAfterOwnerAck` defaults to **false** to prevent silent data loss for multi-device owners. UI exposes an opt-in checkbox for single-device users who want auto-delete. Cross-device replication of a single participant's events is deferred to v3 (will use `publicEncryptionKey`). Pins: `relay-spec.md` POST /acks defaults, `data-model.md` RoomPolicy.

**13. Browser secret persistence: memory-only.** URL fragment (`#key=`) parsed once on load, immediately stripped via `history.replaceState`, held only in JS heap. Reload requires re-paste. No `sessionStorage`, no `IndexedDB`, no cookies. Accepts a slightly worse UX in exchange for the tightest possible trust profile for a hosted-JS context. Pins: `crypto-spec.md` Invite URLs.

**14. No plaintext over DataChannel.** All snapshot bytes always application-layer encrypted under `snapshotKey`, regardless of transport. `inlineSnapshot` carries AEAD ciphertext with snapshot AAD-binding; the data-model's plaintext-inline-snapshot pathway is rescinded. Makes the trust boundary identical across live, mailbox, and R2 paths. Pins: above §Missing Design Decisions, `data-model.md` Snapshot Events.

### Resolver (decisions 15–16)

**15. Anchor resolver disagreement policy: run-all + combine.** All 8 resolution steps that can produce a candidate run; candidates dedup by `currentRange`. Emit `ambiguous` when the top two candidates are within 0.10 confidence of each other. Confidence weights from `data-model.md` ship as starting values; calibrate post-Phase 1 against a real markdown-edit corpus. Pins: above §Missing Design Decisions.

**16. `AnchorBlock.kind` gains `math` and `mermaid`** in addition to the original eight variants. Required for stable anchor fingerprints inside ProseMirror's math and mermaid nodeviews (currently fall through to `"unknown"` which breaks fingerprint stability). Pins: `data-model.md` AnchorBlock.

  - **Implementation note (Phase 1, attn-nnj.3.1 / 3.2):** the `math` kind is only emitted from `comrak` when math appears at the document AST's block level. In practice that means a ```` ```math ```` fenced code block. Comrak emits both inline math (`$x$`) and *display math* (`$$ ... $$`) as `NodeValue::Math` **inline** nodes nested inside a `Paragraph`, so a display-math run on its own line is currently absorbed into a `paragraph` block (its literal still flows through `extract_text` into the paragraph's normalized text, so the resolver still has something stable to fingerprint). Authors who need math addressable as its own anchorable block must use the ```` ```math ```` fence today. Promoting bare `$$ ... $$` into a first-class block kind would require either a comrak patch or a post-parse rewrite and is intentionally out of scope for v2.

### Inconsistencies Fixed

- `data-model.md` line 202: `"attn file"` → `"attn file v2"` to match the v2-suffix convention used everywhere else in the key derivation tree (`crypto-spec.md` uses the v2 form).

---

**Total: 16 decisions, all previously-open questions closed.** Open implementation work is now bounded by the work itself, not by undecided design.
