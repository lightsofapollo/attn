# attn — Collaboration v2 Data Model And Sync

> **Status (2026-05-18)**: this document is the v2 design baseline. Several decisions described below have been finalized in [`amendments.md`](./amendments.md), which **overrides** this document where they conflict. Companion specs: [`relay-spec.md`](./relay-spec.md) (server contract), [`crypto-spec.md`](./crypto-spec.md) (cipher suite, key derivation, hashcash). All 16 previously-open questions are answered in `amendments.md` §Decisions Locked — read that first before treating any "TBD" language below as still-open.

## Summary

This plan replaces the earlier live-only relay design with a v2 collaboration model that supports:

- native `attn` users
- browser reviewers later
- local CLI agents
- live WebRTC sessions
- bounded async feedback
- end-to-end encrypted sync
- owner-controlled application of suggestions to a local markdown working copy

The core product is not shared live editing. It is shared review state over local markdown:

```text
owner working copy
  -> immutable encrypted snapshots
  -> encrypted review event log
  -> local anchor resolution into each participant's current document
  -> owner applies accepted suggestions locally
```

WebRTC, Cloudflare Durable Objects, and a future bounded mailbox are transports. They must not define the data model. The data model is:

```text
ReviewRoom
  Participants
  Capabilities
  Documents
  SnapshotGraph
  ReviewEvents
  SyncCursors
  LocalReplicas
```

## Product Modes

### Live

```text
attn owner <-> Cloudflare signaling <-> attn reviewer
attn owner <======== WebRTC DataChannel ========> attn reviewer
```

- Owner must be online.
- Snapshot and review events travel over WebRTC.
- Cloudflare sees only encrypted signaling.
- No server-side document storage.
- No TURN.
- Some networks fail, and the UI says so.

### Async

```text
owner uploads encrypted snapshot + bounded encrypted mailbox
reviewer opens later
reviewer submits encrypted feedback
owner imports later
```

- Owner can be offline.
- Server stores ciphertext only.
- Room has hard TTL and storage caps.
- Owner ACK can delete delivered events.

### Hybrid

Use WebRTC when both sides are online. Fall back to the encrypted mailbox for missed or offline events. The event model is identical in both modes.

## Non-Goals

- Google Docs-style live multi-user editing.
- Remote participants directly mutating the owner's working copy.
- Permanent document hosting.
- Unbounded event history.
- TURN in the default hosted product.
- Server-side markdown parsing, indexing, search, merge, or AI processing.

## Trust Model

The hosted service may see:

- room id
- peer ids
- connection timing
- source IPs
- encrypted payload sizes
- message counts
- expiry metadata

The hosted service must not see:

- markdown content
- file paths, unless a client chooses to leak them outside ciphertext
- comments
- suggestions
- patches
- WebRTC SDP or ICE candidates in plaintext
- agent findings

Every user-visible collaboration payload is encrypted on the client before leaving `attn` or the browser client.

### Capability tiers and their limits

V3 invites separate relay read admission from write admission. `view` carries
only the read capability; `comment` and `suggest` additionally carry the write
admission key plus an owner signature binding the exact room and tier. The
relay enforces route-level read/write possession and verifies device grants;
native and browser clients independently enforce event vocabulary
(`comment` cannot author `SuggestionCreated`). These are capability controls,
not DRM: anyone who receives a writable invite can copy its bearer material,
and a compromised client can reveal decrypted content.

The hosted browser remains a weaker endpoint than native `attn`: JavaScript in
the served origin receives the read capability and plaintext in memory. A
view-only native runtime is deliberately not implemented; native view links
direct users to the browser instead of silently registering a writable device.

Local Miniflare integration coverage exercises native comment propagation,
an opaque hostile comment-tier suggestion followed by a valid-event barrier,
and suggest/owner apply. The hosted Playwright stack drives Chromium against
that same relay contract and proves all three browser URLs render with their
explicit tier vocabulary; view uses anonymous read-only transport with zero
mutations, comment round-trips, and suggest reaches the native owner.

## Terms

### Review Room

A capability-scoped collaboration space.

```ts
type ReviewRoom = {
  v: 2;
  roomId: string;
  createdAt: number;
  createdBy: ParticipantId;
  policy: RoomPolicy;
  documents: Record<FileId, SharedDocument>;
  snapshots: Record<SnapshotId, SnapshotNode>;
  eventHeads: EventId[];
};

type RoomPolicy = {
  mode: "live" | "async" | "hybrid";
  maxPeers: number;
  maxSnapshotBytes: number;
  maxEventBytes: number;
  maxEvents: number;
  expiresAt: number;
  deleteEventsAfterOwnerAck: boolean;
  allowBrowser: boolean;
  allowRemoteAgents: boolean;
};
```

### Participant And Device

A participant is a person or agent. A device is one installed client instance.

```ts
type ParticipantId = string;
type DeviceId = string;

type Participant = {
  participantId: ParticipantId;
  displayName: string;
  kind: "owner" | "reviewer" | "agent";
  publicSigningKey: string;
  capabilities: Capability[];
};

type Device = {
  deviceId: DeviceId;
  participantId: ParticipantId;
  publicEncryptionKey: string;
  publicSigningKey: string;
  client: "attn-native" | "attn-browser" | "agent-cli";
  createdAt: number;
};

type Capability =
  | "room_admin"
  | "read_snapshot"
  | "write_comment"
  | "write_suggestion"
  | "resolve_comment"
  | "accept_suggestion"
  | "publish_snapshot";
```

Role grants are fixed for v2:

- owners receive every capability;
- human reviewers receive `read_snapshot`, `write_comment`,
  `write_suggestion`, and `resolve_comment`;
- agents receive `read_snapshot`, `write_comment`, and `write_suggestion`.

Resolving a comment closes a review discussion without mutating the owner's
working tree, so a human reviewer may resolve a thread. Agents cannot resolve
threads, accept suggestions, administer rooms, or publish snapshots.

The invite secret grants initial room access. After joining, the participant should create a signing keypair so events can be authenticated and replayed safely.

Inbound clients MUST authorize the decrypted event body before persistence or
UI application. They validate the device directory's Ed25519 `selfSignature`,
keep the `(participantId, deviceId, keys, client, kind)` registration immutable,
and derive grants from `kind` rather than trusting capabilities supplied by the
sender. A `ParticipantJoined` event must bind its participant and device fields
to the signing event metadata and that immutable registration, and its
capability set must exactly match the v2 role grants above. In particular, only
an owner registration may publish/supersede snapshots, accept/reject
suggestions, manually re-anchor, or end the session.

### Shared Document

A shared document is the review identity of a markdown file. It is not necessarily a path on every participant's machine.

```ts
type FileId = string;

type SharedDocument = {
  fileId: FileId;
  ownerDisplayPath: string;
  mediaType: "text/markdown";
  createdAt: number;
  latestSnapshotId: SnapshotId;
};
```

The owner keeps a private local mapping:

```ts
type LocalFileBinding = {
  fileId: FileId;
  absolutePath: string;
  projectRoot: string;
};
```

`fileId` should not be the absolute path:

```text
fileId = base64url(truncate_128_bits(sha256("attn file v2" || roomSecret || displayPath || firstSnapshotHash)))
```

## Snapshot Graph

Snapshots are immutable review bases. All comments and suggestions are anchored to a snapshot, not directly to a moving working copy.

```ts
type SnapshotId = string;

type SnapshotNode = {
  snapshotId: SnapshotId;
  fileId: FileId;
  parentSnapshotId?: SnapshotId;
  supersedesSnapshotId?: SnapshotId;
  createdAt: number;
  createdBy: ParticipantId;
  baseHash: ContentHash;
  byteLength: number;
  encryptedBlobRef?: BlobRef;
  plaintext?: SnapshotPlaintext;
};

type SnapshotPlaintext =
  | { docType: "markdown"; content: string; anchorIndex?: AnchorIndex }
  | { docType: "html"; content: string }
  | {
      docType: "asset";
      content: string; // unpadded base64url of arbitrary raw bytes
      mediaType: string;
      encoding: "base64url";
    }
  | {
      docType: "workspace_manifest";
      manifest: WorkspaceSnapshotManifest;
    };

type WorkspaceSnapshotManifest = {
  v: 1;
  kind: "attn_workspace_snapshot";
  scope: "file" | "entries" | "workspace";
  entries: Array<{
    fileId: FileId;
    snapshotId: SnapshotId;
    path: string;
    kind: "markdown" | "html" | "asset";
    mediaType?: string;
    byteLength: number;
    contentHash: ContentHash;
  }>;
};

type BlobRef = {
  storage: "inline" | "mailbox" | "r2";
  blobId: string;
  byteLength: number;
  contentHash: ContentHash;
};

type ContentHash = string;
```

Rules:

- `SnapshotNode.baseHash` hashes the raw document/asset bytes. For a workspace
  manifest it hashes the canonical JSON bytes of the nested `manifest` object,
  not the outer `SnapshotPlaintext` wrapper.
- Existing Markdown and HTML canonical JSON bytes remain unchanged. Markdown
  published by a browser carries the exact Rust/comrak `AnchorIndex` produced
  from the same bytes and `snapshotId`.
- Asset `content` is canonical unpadded base64url. `mediaType` is a MIME type
  without parameters; relays and R2 never inspect or persist either field in
  plaintext.
- Manifest paths are NFC-normalized, slash-separated, root-relative paths.
  Entries are unique and strictly sorted by UTF-8 path bytes; `fileId`,
  `snapshotId`, byte length, content hash, kind, and asset media type bind each
  entry to its previously published snapshot.
- A publication sends every entry snapshot before the synthetic manifest
  snapshot. The manifest file identity is
  `base64url(SHA-256("attn workspace manifest v1" || roomSecret)[:16])` and is
  stable across republishing. Publication state advances only after every
  encrypted blob and signed pointer is durably acknowledged.
- Live mode can send the same application-layer encrypted snapshot envelope
  over the DataChannel; no plaintext transport exception exists.
- Async mode stores the encrypted snapshot blob in the bounded mailbox.
- A new snapshot does not rewrite old anchors. It creates a new node in the snapshot graph.
- Review events always record the `snapshotId` they were authored against.

This allows:

```text
snapshot A
  reviewer comment A1
  owner edits local file
snapshot B supersedes A
  reviewer still submits A2
owner resolves both A1 and A2 into current local file
```

## Local Replicas

Each client has a local view of each shared document.

```ts
type DocumentReplica = {
  roomId: string;
  participantId: ParticipantId;
  deviceId: DeviceId;
  fileId: FileId;
  boundPath?: string;
  baseSnapshotId: SnapshotId;
  currentHash: ContentHash;
  currentMarkdown: string;
  currentIndex: AnchorIndex;
  relationToSnapshot: ReplicaRelation;
  revisionJournal: LocalRevision[];
};

type ReplicaRelation =
  | { status: "same"; snapshotId: SnapshotId; confidence: 1.0 }
  | { status: "changed"; snapshotId: SnapshotId; confidence: number }
  | { status: "unrelated"; snapshotId: SnapshotId; confidence: number }
  | { status: "unknown"; snapshotId: SnapshotId };

type LocalRevision = {
  revisionId: string;
  parentHash: ContentHash;
  nextHash: ContentHash;
  createdAt: number;
  source:
    | "snapshot_loaded"
    | "prosemirror_edit"
    | "accepted_suggestion"
    | "external_file_change"
    | "manual_reanchor";
  pmSteps?: unknown[];
  patchText?: string;
};
```

The revision journal must be persisted locally. In-memory is not enough for full sync because `attn` may restart before importing feedback.

Suggested local store:

```text
~/.attn/reviews/
  rooms/<roomId>/room.json
  rooms/<roomId>/snapshots/<snapshotId>.json
  rooms/<roomId>/events.jsonl
  rooms/<roomId>/outbox.jsonl
  rooms/<roomId>/bindings.json
  rooms/<roomId>/revisions/<fileId>.jsonl
```

## Anchor Index

The anchor index is the bridge between a snapshot and changed local markdown.

```ts
type AnchorIndex = {
  docHash: ContentHash;
  canonicalEncoding: "utf8-bytes";
  lineCount: number;
  blocks: AnchorBlock[];
  headings: AnchorHeading[];
};

type AnchorBlock = {
  snapshotBlockId: string;
  contentFingerprint: string;
  kind:
    | "heading"
    | "paragraph"
    | "list_item"
    | "code_block"
    | "blockquote"
    | "table"
    | "thematic_break"
    | "html"
    | "math"
    | "mermaid"
    | "unknown";
  byteRange: [number, number];
  lineRange: [number, number];
  pmRange?: [number, number];
  headingPath: AnchorHeadingRef[];
  ordinalInParent: number;
  duplicateOrdinal: number;
  textHash: string;
  normalizedTextHash: string;
  previousBlockHash?: string;
  nextBlockHash?: string;
};

type AnchorHeading = {
  level: number;
  text: string;
  textHash: string;
  line: number;
  byteRange: [number, number];
  path: AnchorHeadingRef[];
};

type AnchorHeadingRef = {
  level: number;
  textHash: string;
  ordinalAtLevel: number;
};
```

Use UTF-8 byte offsets as the canonical persisted coordinate system. ProseMirror positions are useful locally but should be treated as derived coordinates because they are tied to the current editor document.

Do not make block identity depend on byte position:

```text
contentFingerprint = sha256(kind || normalizedText || headingPath || duplicateOrdinal)
snapshotBlockId = sha256(snapshotId || byteRange || contentFingerprint)
```

`snapshotBlockId` is exact within one snapshot. `contentFingerprint` is useful across changed replicas.

## Anchors

A review event carries layered anchors. The resolver uses the strongest available layer and falls back with decreasing confidence.

```ts
type Anchor = {
  v: 2;
  fileId: FileId;
  snapshotId: SnapshotId;
  baseHash: ContentHash;
  position: PositionAnchor;
  quote?: QuoteAnchor;
  block?: BlockAnchor;
  context?: ContextAnchor;
  structure?: StructureAnchor;
};

type PositionAnchor = {
  byteRange: [number, number];
  lineRange: [number, number];
  pmRange?: [number, number];
};

type QuoteAnchor = {
  exact: string;
  exactHash: string;
  normalized: string;
  normalizedHash: string;
};

type BlockAnchor = {
  snapshotBlockId: string;
  contentFingerprint: string;
  kind: AnchorBlock["kind"];
  offsetInBlockBytes: [number, number];
  blockByteRange: [number, number];
  blockLineRange: [number, number];
};

type ContextAnchor = {
  prefix: string;
  suffix: string;
  prefixHash: string;
  suffixHash: string;
  previousBlockHash?: string;
  nextBlockHash?: string;
};

type StructureAnchor = {
  headingPath: AnchorHeadingRef[];
  ordinalInParent: number;
};
```

Bounded plaintext fields inside encrypted events:

- `quote.exact`: selected text, capped.
- `context.prefix`: up to 160 characters.
- `context.suffix`: up to 160 characters.

For a block-level comment, omit `quote` and anchor to `block`.

## Anchor Resolution

Resolve anchors independently on each client.

```ts
type ResolvedAnchor =
  | {
      status: "exact";
      confidence: 1.0;
      currentRange: PositionAnchor;
      reason: "base_hash_match" | "mapped_through_local_steps";
    }
  | {
      status: "remapped";
      confidence: number;
      currentRange: PositionAnchor;
      reason:
        | "quote_match"
        | "block_fingerprint_match"
        | "structure_quote_match"
        | "context_match"
        | "fuzzy_quote_match";
    }
  | {
      status: "ambiguous";
      candidates: ResolvedAnchorCandidate[];
      reason: string;
    }
  | {
      status: "stale";
      reason: string;
    };

type ResolvedAnchorCandidate = {
  confidence: number;
  currentRange: PositionAnchor;
  reason: string;
  preview: string;
};
```

Resolution order:

1. If `replica.currentHash === anchor.baseHash`, use `anchor.position`.
2. If local ProseMirror step maps exist from `baseHash` to `currentHash`, map the range through those steps.
3. Search for a unique exact quote match.
4. Search for matching `contentFingerprint`.
5. Search within matching `headingPath`.
6. Match prefix/quote/suffix context.
7. Run bounded fuzzy matching inside likely blocks.
8. Fall back to line proximity only as low-confidence.

Suggested confidence:

```text
base hash exact:              1.00
mapped through local steps:   0.98
unique exact quote:           0.90
block fingerprint match:      0.85
structure + quote:            0.80
context match:                0.70
fuzzy quote match:            0.50-0.75
line proximity only:          <=0.35
```

UI states:

- `exact`: normal inline highlight.
- `remapped`: inline highlight plus "moved" state in panel.
- `ambiguous`: owner chooses among candidates.
- `stale`: panel-only until manually resolved.

## Review Events

All collaboration state is an append-only event log. Events are idempotent and signed.

```ts
type EventId = string;

type ReviewEvent = {
  meta: EventMeta;
  body: ReviewEventBody;
  auth: EventAuth;
};

type EventMeta = {
  v: 2;
  eventId: EventId;
  roomId: string;
  authorId: ParticipantId;
  deviceId: DeviceId;
  createdAt: number;
  parentEventIds: EventId[];
  snapshotId?: SnapshotId;
};

type EventAuth = {
  signature: string;
  signingKeyId: string;
};

type ReviewEventBody =
  | RoomCreated
  | ParticipantJoined
  | SnapshotCreated
  | SnapshotSuperseded
  | CommentCreated
  | CommentResolved
  | SuggestionCreated
  | SuggestionAccepted
  | SuggestionRejected
  | AnchorManuallyResolved
  | PresenceUpdated
  | SessionEnded;
```

### Snapshot Events

```ts
type SnapshotCreated = {
  type: "snapshot_created";
  fileId: FileId;
  snapshotId: SnapshotId;
  parentSnapshotId?: SnapshotId;
  baseHash: ContentHash;
  encryptedBlobRef?: BlobRef;
  inlineSnapshot?: {
    markdown: string;
    anchorIndex: AnchorIndex;
  };
};

type SnapshotSuperseded = {
  type: "snapshot_superseded";
  fileId: FileId;
  oldSnapshotId: SnapshotId;
  newSnapshotId: SnapshotId;
};
```

### Comment Events

```ts
type CommentCreated = {
  type: "comment_created";
  threadId: string;
  anchor: Anchor;
  body: string;
};

type CommentResolved = {
  type: "comment_resolved";
  threadId: string;
  resolvedBy: ParticipantId;
};
```

### Suggestion Events

Suggestions must be conservative. They should include expected text and an operation, not just a replacement string.

```ts
type SuggestionCreated = {
  type: "suggestion_created";
  suggestionId: string;
  anchor: Anchor;
  operation: SuggestionOperation;
  note?: string;
};

type SuggestionOperation =
  | {
      kind: "replace";
      expectedText: string;
      replacement: string;
    }
  | {
      kind: "insert_before" | "insert_after";
      text: string;
    }
  | {
      kind: "delete";
      expectedText: string;
    };

type SuggestionAccepted = {
  type: "suggestion_accepted";
  suggestionId: string;
  appliedRevisionId: string;
  resultingHash: ContentHash;
};

type SuggestionRejected = {
  type: "suggestion_rejected";
  suggestionId: string;
  reason?: string;
};
```

Apply flow:

1. Resolve anchor into the current owner replica.
2. For replace/delete, verify current text equals `expectedText`.
3. If text differs, show a three-way apply UI.
4. Owner confirms.
5. `attn` writes the local file.
6. `attn` records a `LocalRevision`.
7. `attn` emits `SuggestionAccepted`.

## Encrypted Envelopes

The server stores and routes envelopes. It never sees `ReviewEvent` plaintext.

```ts
type MailboxEnvelope = {
  v: 2;
  roomId: string;
  envelopeId: string;
  serverSeq?: number;
  authorId: ParticipantId;
  deviceId: DeviceId;
  createdAt: number;
  expiresAt: number;
  kind: "event" | "snapshot_blob" | "signal";
  target?: null | { deviceId: DeviceId };
  signalClass?: "presence";
  signalGeneration?: number;
  deviceSignature?: string;
  nonce: string;
  ciphertext: string;
  ciphertextBytes: number;
};
```

`serverSeq` is only a delivery cursor. It is not event causality. Event causality lives in `ReviewEvent.meta.parentEventIds`.

For V3 cursor/view messages, `signalClass: "presence"` is signed cleartext
routing metadata. The encrypted payload remains opaque. Current clients send
these envelopes only over the unordered, zero-retransmit `attn-presence`
WebRTC DataChannel; they never enter a mailbox outbox or relay sequence. A
missing direct path drops the sample, receivers expire it after five seconds,
and senders refresh stationary state every two seconds. The relay rejects
legacy V3 presence uploads before any mutable rate, replay, ordering, alarm,
or latest-state accounting. Other signals retain their documented durability.

## Sync Cursors And ACKs

Each device tracks what it has imported and what the owner has acknowledged for deletion.

```ts
type SyncCursor = {
  roomId: string;
  deviceId: DeviceId;
  lastPulledSeq: number;
  importedEventIds: EventId[];
  pendingOutboundEnvelopeIds: string[];
};

type DeliveryAck = {
  roomId: string;
  deviceId: DeviceId;
  ackedEnvelopeIds: string[];
  importedEventIds: EventId[];
  createdAt: number;
};
```

Rules:

- Import is idempotent by `eventId`.
- Upload is idempotent by `envelopeId`.
- Owner ACK may delete delivered feedback when room policy allows it.
- Expiry deletes envelopes even if they were not ACKed.
- Clients keep local copies of imported events after server deletion.

## Transport Model

### WebRTC DataChannel

Use for low-latency live sessions:

- encrypted signaling via Cloudflare WebSocket
- direct DataChannel for snapshots and events
- no TURN
- STUN only, configurable

DataChannel messages carry the same encrypted event frames used by mailbox mode.

### Cloudflare Signaling

Use Durable Objects with WebSocket Hibernation.

Endpoints:

```text
GET /health
GET /v2/rooms/:roomId/socket?device_id=:deviceId
POST /v2/rooms/:roomId/envelopes
GET /v2/rooms/:roomId/envelopes?after=:serverSeq
POST /v2/rooms/:roomId/acks
```

### Cloudflare Mailbox

For v2 async support, the Durable Object can store bounded encrypted envelopes. If encrypted snapshots exceed the Durable Object storage target, move snapshot blobs to R2 behind the same room policy. Start with strict caps before adding R2.

Initial caps:

- max peers per room: `8`
- default room TTL: `7d`
- live-only room TTL: `4h`
- max encrypted snapshot: `5 MiB`
- max room storage: `25 MiB`
- max event size: `256 KiB`
- max events: `500`
- max incoming messages per device: `120/min`

No server-side markdown parsing. No full-text index. No merge logic.

## Key Model

Room invite:

```text
roomSecret = random 32 bytes
roomId = base64url(truncate_128_bits(sha256("attn room" || roomSecret)))
rootKey = hkdf(roomSecret, "attn room root v2")
eventKey = hkdf(rootKey, "event encryption")
snapshotKey = hkdf(rootKey, "snapshot encryption")
signalingKey = hkdf(rootKey, "signaling encryption")
```

Native invite:

```text
attn://review/<roomId>#key=<base64url-roomSecret>
```

Browser invite later:

```text
https://attn.dev/review/<roomId>#key=<base64url-roomSecret>
```

The browser route remains a convenience path with a weaker trust model because hosted JavaScript performs decryption.

## UI/UX Changes

The UI needs to make shared state visible. Otherwise sync bugs will look like missing comments.

### Owner UI

- Share button in toolbar.
- Room mode selector: `Live`, `Async 24h`, `Async 7d`.
- Connection badge: `Live direct`, `Mailbox`, `Offline`, `Direct failed`.
- Peer strip with humans and agents.
- Review panel with threads grouped by file/snapshot.
- Snapshot badge: `Snapshot current`, `Snapshot superseded`, `Reviewer on older snapshot`.
- Inline highlights for exact/remapped comments.
- Ambiguous anchor picker.
- Stale comment panel state.
- Suggestion card with accept/reject/edit.
- Three-way apply UI for stale suggestions.

### Reviewer UI

- Clear banner when reviewing a snapshot instead of a local file.
- Snapshot age and superseded notice.
- Comment composer from selected text.
- Suggestion composer from selected text.
- Outbox indicator for pending feedback.
- "Owner offline, feedback will be delivered later" state in async mode.

### Agent UI/CLI

Local agents should integrate through `attn`, not the relay:

```bash
attn review current --json
attn review submit-comment comment.json
attn review submit-suggestion suggestion.json
attn review inbox --json
```

Remote agents join like participants and see only the shared encrypted snapshot.

## Codebase Integration

Rust entry points:

- `src/main.rs`: CLI parsing and daemon startup.
- `src/daemon.rs`: local Unix socket commands.
- `src/ipc.rs`: webview-to-Rust commands.
- `src/watcher.rs`: event loop messages.
- new `src/review.rs`: local session store, file bindings, snapshot creation, apply flow.

Frontend entry points:

- `web/src/App.svelte`: active document and panel state.
- `web/src/lib/Editor.svelte`: ProseMirror selection, decorations, local step journal.
- `web/src/lib/ipc.ts`: review IPC wrappers.
- `web/src/lib/types.ts`: shared app payloads.

New frontend modules:

- `web/src/lib/review/model.ts`
- `web/src/lib/review/crypto.ts`
- `web/src/lib/review/store.ts`
- `web/src/lib/review/anchors.ts`
- `web/src/lib/review/resolver.ts`
- `web/src/lib/review/signaling.ts`
- `web/src/lib/review/webrtc.ts`
- `web/src/lib/review/mailbox.ts`
- `web/src/lib/prosemirror/review.ts`
- `web/src/lib/ReviewPanel.svelte`

## Rust Architecture Changes

The current Rust side assumes the app is a local viewer/editor:

- `ipc::AppState` stores only one active `file_path`.
- `EditSave` writes directly to that path.
- checkbox toggles rewrite the file by line number.
- file watcher events only tell the frontend to reload.
- daemon socket messages are path-oriented.
- Rust-to-frontend messages are ad hoc `setContent` / `updateContent` calls.

That is workable for a single-user markdown viewer, but it makes collaboration hard because there is no backend concept of:

- document identity separate from path
- content hash
- snapshot
- local revision
- review room
- event import/export
- pending outbox
- suggestion apply safety

The Rust side should become the owner of durable collaboration state and working-copy mutation. The frontend should own selection, rendering, ProseMirror decorations, and some anchor construction, but it should not be the only place that knows the session/event model.

### New Rust Modules

```text
src/
  review/
    mod.rs
    ids.rs
    model.rs
    crypto.rs
    store.rs
    working_copy.rs
    manager.rs
    transport.rs
    apply.rs
    ipc.rs
```

Responsibilities:

- `model.rs`: serde types for rooms, participants, snapshots, events, envelopes, cursors.
- `ids.rs`: typed wrappers for `RoomId`, `FileId`, `SnapshotId`, `EventId`, `DeviceId`.
- `crypto.rs`: room key derivation, envelope encryption/decryption, signing/verification.
- `store.rs`: persistent local room store under the attn runtime directory.
- `working_copy.rs`: path binding, content hashing, snapshot creation, safe writes, local revision recording.
- `manager.rs`: in-memory room runtime, event import/export, status updates, outbox processing.
- `transport.rs`: mailbox/WebSocket client traits and implementations.
- `apply.rs`: suggestion resolution and guarded write flow.
- `ipc.rs`: typed frontend-facing review commands/events.

### Typed IDs And Hashes

Avoid passing raw strings everywhere in Rust. Use typed newtypes so path ids, snapshot ids, and event ids cannot be mixed accidentally.

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RoomId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FileId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SnapshotId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EventId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContentHash(String);
```

Every file write and snapshot creation should compute `ContentHash` from canonical UTF-8 bytes.

### Working Copy Service

Replace direct `std::fs::write` calls from IPC handlers with a working-copy service.

Current pattern:

```rust
IpcMessage::EditSave { content } => {
    std::fs::write(&state.file_path, &content)
}
```

Target pattern:

```rust
WorkingCopyService::save(SaveRequest {
    path,
    content,
    expected_hash,
    source: SaveSource::UserEdit,
})
```

```rust
pub struct SaveRequest {
    pub path: PathBuf,
    pub content: String,
    pub expected_hash: Option<ContentHash>,
    pub source: SaveSource,
}

pub enum SaveSource {
    UserEdit,
    CheckboxToggle,
    AcceptedSuggestion { room_id: RoomId, suggestion_id: EventId },
}

pub struct SaveResult {
    pub previous_hash: ContentHash,
    pub next_hash: ContentHash,
    pub revision_id: String,
}
```

Benefits:

- all writes record a local revision
- accepted suggestions can emit `SuggestionAccepted`
- stale writes can be detected before overwriting a changed file
- file watcher events can distinguish self-writes from external changes

### File Watcher Integration

The watcher should become collaboration-aware. When a watched markdown file changes:

1. compute the new content hash
2. check whether the change was a known self-write
3. if self-write, attach it to the existing `LocalRevision`
4. if external, record `LocalRevision { source: ExternalFileChange }`
5. notify frontend with both normal content metadata and review replica status

This avoids treating every save as an opaque reload. It gives anchor resolution a revision trail.

### Local Review Store

Rust should persist collaboration state even if the UI is closed.

```text
runtime_dir/reviews/
  rooms/<roomId>/
    room.json
    participants.json
    devices.json
    bindings.json
    snapshots/<snapshotId>.json
    events.jsonl
    outbox.jsonl
    cursors.json
    revisions/<fileId>.jsonl
```

Store rules:

- append events atomically
- dedupe imported events by `EventId`
- dedupe uploaded envelopes by `EnvelopeId`
- write temp file then rename for JSON state
- keep schema version in every top-level file
- tolerate missing/corrupt optional files by surfacing room repair UI

This does not need SQLite for v2. JSON plus JSONL is easier to inspect, sync, and debug. Add SQLite only if query patterns demand it.

### Review Manager

`ReviewManager` should be the daemon-owned service that connects working copy, store, UI, and transport.

```rust
pub struct ReviewManager {
    store: ReviewStore,
    working_copy: WorkingCopyService,
    rooms: HashMap<RoomId, RoomRuntime>,
}

pub enum ReviewCommand {
    Share { path: PathBuf, mode: ShareMode, ttl: Option<Duration> },
    Join { invite: String },
    Pull { room_id: Option<RoomId> },
    Stop { room_id: Option<RoomId> },
    ImportEnvelope { envelope: MailboxEnvelope },
    CreateComment { room_id: RoomId, anchor: Anchor, body: String },
    CreateSuggestion { room_id: RoomId, suggestion: SuggestionDraft },
    AcceptSuggestion { room_id: RoomId, suggestion_id: EventId },
}

pub enum ReviewUpdate {
    RoomStatusChanged(RoomStatus),
    EventImported(ReviewEvent),
    SnapshotCreated(SnapshotNode),
    AnchorResolutionChanged(ResolvedAnchorSummary),
    OutboxChanged(OutboxSummary),
}
```

The Tao event loop should receive `UserEvent::ReviewUpdate(...)` and forward it to the frontend through `window.__attn__.reviewEvent(...)` / `reviewStatus(...)`.

### Daemon Socket Commands

The local daemon socket should evolve from "open this path" to "send a typed command to the running daemon."

```rust
pub enum SocketMessage {
    Open { path: String },
    ReviewShare { path: String, mode: String, ttl: Option<String> },
    ReviewJoin { invite: String },
    ReviewPull { room_id: Option<String> },
    ReviewStop { room_id: Option<String> },
    ReviewInbox,
    Info,
}
```

This makes CLI agents first-class without forcing them through the UI:

```bash
attn review current --json
attn review submit-comment comment.json
attn review submit-suggestion suggestion.json
attn review inbox --json
```

### Webview IPC Changes

Frontend-to-Rust messages should be explicit review commands, not generic blobs:

```ts
{ type: "review_share", path: string, mode: "live" | "async" | "hybrid", ttl?: string }
{ type: "review_join", invite: string }
{ type: "review_create_comment", roomId: string, anchor: Anchor, body: string }
{ type: "review_create_suggestion", roomId: string, draft: SuggestionDraft }
{ type: "review_accept_suggestion", roomId: string, suggestionId: string }
{ type: "review_resolve_anchor", roomId: string, eventId: string, range: PositionAnchor }
```

Rust-to-frontend callbacks:

```ts
window.__attn__.reviewStatus(status)
window.__attn__.reviewEvent(event)
window.__attn__.reviewSnapshot(snapshot)
window.__attn__.reviewAnchorResolution(update)
```

### Transport Ownership

The cleanest long-term split:

- Rust owns encryption, event persistence, mailbox sync, snapshot storage, and safe file apply.
- Frontend owns ProseMirror selection, decorations, and WebRTC capability spike.

If WebRTC works reliably in Wry, the frontend can own the `RTCPeerConnection`, but DataChannel payloads should still be handed to Rust for persistence/import before the UI treats them as durable.

```text
DataChannel receives encrypted envelope
  -> frontend forwards envelope to Rust
  -> Rust decrypts/verifies/imports/dedupes
  -> Rust emits ReviewUpdate
  -> frontend renders imported event
```

If WebRTC does not work reliably in Wry, move transport into Rust later without changing the store/event/apply model.

### App State Shape

`ipc::AppState { file_path }` should become an application model that knows active tab/path plus review state.

```rust
pub struct AppState {
    pub active_path: PathBuf,
    pub active_project_root: PathBuf,
    pub active_tab_id: Option<String>,
    pub file_bindings: HashMap<FileId, PathBuf>,
    pub review_rooms: Vec<RoomId>,
}
```

The actual heavy state should live in `ReviewManager`, not in the UI mutex. `AppState` should be routing context.

### Phasing The Rust Work

1. Add typed review model and local store without network.
2. Route `edit_save` and checkbox toggles through `WorkingCopyService`.
3. Record local revisions for user edits and external file changes.
4. Add daemon/socket and IPC review commands.
5. Add snapshot creation and event import/export.
6. Add frontend mock UI over Rust-local review state.
7. Add mailbox transport.
8. Add WebRTC transport.
9. Add safe suggestion apply.

This order prevents a common mistake: building networking first, then discovering the local app has nowhere coherent to put the events.

## CLI Shape

```bash
attn review share <path> --mode live
attn review share <path> --mode async --ttl 7d
attn review join <invite>
attn review inbox
attn review pull
attn review stop
```

Daemon socket messages:

```rust
SocketMessage::ReviewShare { path: String, mode: String, ttl: Option<String> }
SocketMessage::ReviewJoin { invite: String }
SocketMessage::ReviewPull { room_id: Option<String> }
SocketMessage::ReviewStop { room_id: Option<String> }
```

Webview callbacks:

```ts
window.__attn__.reviewEvent(payload)
window.__attn__.reviewStatus(payload)
```

## Implementation Phases

### Phase 0: Model And Local Store

- Define TypeScript types for rooms, snapshots, events, envelopes, cursors.
- Add local session store.
- Add event import/export/idempotency tests.
- Add snapshot creation from active markdown.

### Phase 1: Anchor Engine

- Build `AnchorIndex` from ProseMirror/markdown.
- Create anchors from selection.
- Resolve anchors into changed markdown.
- Add tests for exact, remapped, ambiguous, stale.

### Phase 2: Review UI Without Network

- Add review panel.
- Add comment/suggestion decorations.
- Add mocked peers and mocked remote events.
- Demonstrate a comment surviving owner edits.

### Phase 3: Cloudflare Relay And Mailbox

- Add `relay/` Worker + Durable Object.
- Implement encrypted envelope storage with TTL/caps.
- Implement pull cursors and ACK/delete.
- No plaintext payload logging.

### Phase 4: WebRTC Live Transport

- Verify WebRTC and WebCrypto in `attn://`.
- Implement encrypted signaling.
- Establish DataChannel.
- Sync the same event envelopes over DataChannel.
- Surface direct connection failures honestly.

### Phase 5: Owner Apply Flow

- Resolve suggestions against current owner file.
- Verify expected text.
- Add three-way apply UI.
- Write accepted suggestions through existing save flow.
- Emit `SuggestionAccepted`.

### Phase 6: Browser And Remote Agents

- Add browser review client only after native model is stable.
- Keep browser trust language explicit.
- Add remote agent participant type.

## Cloudflare Cost Strategy

Keep costs bounded by design:

- No TURN.
- No unbounded rooms.
- No permanent storage.
- No server-side document processing.
- No per-keystroke sync.
- Hard TTL.
- Hard bytes-per-room.
- Hard events-per-room.
- WebSocket Hibernation for idle sockets.

References:

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/

## Open Questions

- Should async encrypted snapshots be enabled by default, or require explicit opt-in?
- Should v2 support multiple files per room immediately?
- Should snapshot blobs use Durable Object storage first, or R2 from day one?
- Should room invites distinguish read-only reviewers from suggestion-capable reviewers?
- Should agent output use the same `CommentCreated` and `SuggestionCreated` events, or separate `FindingCreated` events?
- Should mailbox upload require proof-of-work or signed room admission to reduce abuse?
# V3 Device Grants and Import Authority

V3 non-owner device registration carries `grantTier` (`comment` or `suggest`)
and an owner `grantSignature` over exactly:

```json
{"grantTier":"comment|suggest","purpose":"attn device grant v3","roomId":"<roomId>","v":3}
```

The device `selfSignature` also covers both grant fields, binding the device to
the owner's grant. Owners forbid grant fields and retain all room authority.
For non-owners, effective authority comes only from the verified device
directory record: reviewer/comment may read, comment, and resolve; reviewer/
suggest additionally suggests; agent/comment may read and comment; agent/
suggest additionally suggests. Legacy v2 records and agents without an
explicit tier default to `suggest` for compatibility.

`ParticipantJoined.capabilities` remains encrypted descriptive attestation,
not an authority source. Native and browser import pipelines reject out-of-tier
events before persistence even though the relay cannot inspect encrypted event
bodies. This is policy enforcement at authenticated peers, not cryptographic
content enforcement by the relay: a hostile comment-tier client can upload a
valid signed and encrypted `SuggestionCreated`, but conformant peers discard it.
Anonymous view-only WebSockets use a fresh `viewer_id` plus the read proof;
they never register a device, signal, announce presence, acknowledge, or write.
Registered v3 device sockets require both read and write proofs.
