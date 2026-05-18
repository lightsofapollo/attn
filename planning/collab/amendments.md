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

### Phase 4 WebRTC-in-wry must be a Phase 0.5 spike

The plan puts WebRTC validation in Phase 4 ("Verify WebRTC and WebCrypto in `attn://`"). This is a research spike whose outcome determines the entire transport architecture:

- If WebRTC + WebCrypto work in WKWebView under `wry` with a custom `attn://` scheme → frontend owns `RTCPeerConnection`.
- If they don't → Rust must use `webrtc-rs` (a multi-week project of its own), and the frontend just renders.

This must happen **before** Phase 0 locks in any transport assumption.

Spike deliverable (timeboxed to 3 days):

- A standalone branch with a minimal `wry` window that loads a page from `attn://` and successfully:
  1. Generates an Ed25519 keypair via `crypto.subtle`.
  2. AES-GCM seals + opens a message via `crypto.subtle` (XChaCha20 is via npm package, not WebCrypto).
  3. Establishes an `RTCPeerConnection` to a public STUN server, opens a DataChannel to a second instance (loopback or two-machine test).
  4. Sends and receives a few KB across the DataChannel.
- Result documented in `planning/collab/webrtc-spike-result.md`.
- If any step fails on macOS or expected platforms, the failure becomes a blocker for the original plan's transport architecture and must be resolved (workaround, polyfill, or pivot to Rust transport) before Phase 0 starts.

## Phasing Override

Original `data-model.md` "Implementation Phases" (lines 1166-1217) collapses too much into Phase 0 and underestimates Phase 3. The Rust-side phasing on lines 1126-1136 is more realistic. Use this combined sequence:

### Phase 0.5: WebRTC + WebCrypto Spike

(See above. Timeboxed. Gates everything else.)

### Phase 0a: Crypto Foundations

- Land `Cargo.toml` crypto crates.
- Build canonical JSON helpers (Rust + TS).
- Write the `test-vectors/` corpus.
- Implement KDF, AEAD, Ed25519, ID helpers in both languages and pass the corpus.
- No `ReviewManager` yet, no IPC yet.

Deliverable: a Rust `attn-collab-crypto` mod + a TS `web/src/lib/review/crypto.ts` that interop on the corpus.

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

### Phase 4: WebRTC Live Transport

- Only after Phase 0.5 spike validated.
- Encrypted signaling over the relay (or Rust if spike pivots).
- DataChannel envelope round-trip identical to mailbox envelope format.
- Surface direct-connection failures honestly in UI (no silent fallback unless `mode: "hybrid"`).

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

## Top 5 Decisions This Document Pins

1. **Owner identity is cryptographically bound** to `ownerSigningKey` registered at room creation; relay enforces this on `POST /devices` with `kind: "owner"` and on every owner-only operation (ACK-with-delete, DELETE room). See `crypto-spec.md` §Signing-Key Publication.
2. **Cipher suite is XChaCha20-Poly1305 + Ed25519 + HKDF-SHA-256**, canonical JSON per RFC 8785, IDs are deterministic and content-addressed. See `crypto-spec.md`.
3. **Anchor resolver runs all steps and combines candidates** instead of falling through on first match. Ambiguity threshold: top two candidates within 0.10 of each other. See above.
4. **Multi-device for owner is not solved at protocol level in v2**; `deleteEventsAfterOwnerAck` defaults to `false` to prevent silent data loss; UI calls this out.
5. **WebRTC-in-wry validation is Phase 0.5**, not Phase 4. Outcome determines whether the frontend or Rust owns transport. Gate the rest of phasing on the spike result.

## Open Questions Still Unresolved

- Confidence calibration corpus (post Phase 1, low priority).
- Browser secret persistence beyond memory — currently "no persistence." May need to revisit when the browser client lands in Phase 6.
- Proof-of-work for relay abuse — currently "v2 ships without it." Revisit if abuse becomes real.
- Snapshot version-cleanup policy on the relay — current spec keeps all snapshots until TTL; revisit if rooms run hot.
- `prosemirror-tables`, math, and mermaid block kinds in `AnchorBlock.kind` — currently fall through to `"unknown"`. Add `"math"` and `"mermaid"` enum entries during Phase 1 to keep anchor fingerprints stable inside those nodes.
