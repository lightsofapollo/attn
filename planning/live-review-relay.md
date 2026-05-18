# attn — Native Live Review Relay

## Summary

Build a native-to-native live review mode for markdown files. The first version should validate the collaboration UX with the least possible hosted infrastructure:

```text
attn owner <-> Cloudflare signaling room <-> attn reviewer
attn owner <======== direct WebRTC DataChannel ========> attn reviewer
```

The Cloudflare service is a signaling relay only. It does not store markdown, comments, suggestions, patches, SDP, or ICE candidates in plaintext. It does not provide TURN. If direct peer-to-peer connection fails, the product says so and offers a retry.

The review model is not shared live editing in v1. The owner shares an ephemeral snapshot of the active markdown document over the direct channel, reviewers submit comments and suggestions over the same direct channel, and only the owner can apply changes to the local working copy.

## Goals

- Native `attn` on both sides for the first working version.
- End-to-end encryption at the application layer, regardless of transport.
- No server-side document storage in v1.
- No TURN relay in v1.
- No async mailbox in v1.
- A hosted relay cheap enough to leave running without meaningful cost anxiety.
- A protocol that can later support a bounded encrypted mailbox without redesigning review events.

## Non-Goals

- Browser invite support.
- Google Docs-style multi-user text editing.
- CRDT/OT for the markdown document.
- Remote writes directly into the owner's working copy.
- Offline review submission.
- Accounts, billing, organization management, or permissions beyond invite capability secrets.

## User Experience

Owner starts a live review:

```bash
attn review live README.md
```

The running daemon opens or focuses `README.md`, starts a review room, and shows an invite:

```text
attn review join attn://review/live/<room-id>#key=<secret>
```

Reviewer joins:

```bash
attn review join "attn://review/live/<room-id>#key=<secret>"
```

Expected UI states:

- `Creating room`
- `Waiting for reviewer`
- `Connecting directly`
- `Connected`
- `Direct connection failed`
- `Peer disconnected`

Reviewer capabilities:

- Read the shared snapshot.
- Select text and leave a comment.
- Submit an inline suggestion.
- Send document-level feedback.

Owner capabilities:

- See reviewer presence.
- See comments and suggestions arrive live.
- Resolve comments.
- Accept, reject, or edit suggestions before applying them locally.
- End the session.

## Trust Model

The relay can see:

- Room id.
- Peer connection timing.
- Source IPs.
- WebSocket connection count.
- Ciphertext sizes and message counts.

The relay must not see:

- Markdown content.
- File paths, except if the client explicitly includes them in encrypted payloads.
- Comments.
- Suggestions.
- Patches.
- WebRTC SDP or ICE candidates in plaintext.

Anyone with the invite secret can join and decrypt the review session. The invite secret is the capability.

Browser E2EE is deferred because a hosted browser client weakens the trust story: the server serves the JavaScript that performs decryption. Native `attn` keeps decrypting code local and versioned with the installed app.

## Invite And Keys

The owner generates a random high-entropy room secret locally.

```text
secret = random 32 bytes
room_id = base64url(truncate_128_bits(sha256("attn room" || secret)))
signaling_key = hkdf(secret, "attn signaling v1")
review_key = hkdf(secret, "attn review events v1")
```

The room id is safe to send to the relay. The secret is kept in the URL fragment or CLI argument and never sent to the relay in plaintext.

```text
attn://review/live/<room-id>#key=<base64url-secret>
```

Signaling messages sent through Cloudflare are encrypted with `signaling_key`. Review events sent over the DataChannel are encrypted with `review_key` even though WebRTC already encrypts the transport. This keeps the payload protocol consistent with a future mailbox.

## Relay Design

Use Cloudflare Workers plus one Durable Object per room.

Public endpoints:

```text
GET /health
GET /v1/rooms/:room_id/socket?peer_id=:peer_id
```

The socket endpoint upgrades to WebSocket and routes the connection to the Durable Object named by `room_id`.

The Durable Object is intentionally small:

- Accept WebSocket connections.
- Keep an in-memory set of connected peers.
- Enforce caps.
- Forward opaque encrypted frames to the other peers in the same room.
- Close empty rooms after an idle window.
- Store no durable room state in v1.

Use the Durable Objects WebSocket Hibernation API so idle sockets do not keep the object billed for wall-clock duration. Cloudflare recommends the hibernation API for WebSocket Durable Objects, and their pricing docs specifically call out hibernation as the way to avoid duration charges for idle connections.

References:

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/

## Relay Frame Shape

Outer frame visible to the relay:

```json
{
  "v": 1,
  "type": "signal",
  "from": "peer_abc",
  "to": "peer_def",
  "nonce": "base64url",
  "ciphertext": "base64url"
}
```

Encrypted signaling payload:

```json
{
  "type": "offer",
  "sdp": "...",
  "createdAt": 1780000000000
}
```

Other encrypted signaling payload types:

- `answer`
- `ice_candidate`
- `peer_hello`
- `peer_goodbye`
- `restart_ice`

The relay never inspects encrypted payloads.

## Relay Limits

Hard caps are part of the product, not an afterthought.

Initial defaults:

- Max peers per room: `2`
- Max WebSocket frame size: `32 KiB`
- Max incoming messages per peer: `120/min`
- Max room lifetime while non-empty: `4h`
- Empty room cleanup: `60s`
- Max new rooms per IP: configurable, low default
- No persistent storage
- No TURN
- No mailbox

These caps keep Cloudflare usage bounded and make abuse boring to handle.

The relay should log only aggregate operational metadata by default:

- room created
- room closed
- peer count
- close/error codes
- rate-limit events

Do not log ciphertext payloads unless a local development flag is enabled.

## WebRTC Constraints

No TURN means some connections will fail. That is acceptable in v1.

Use STUN only for candidate discovery. STUN does not relay document traffic, so it is not the cost risk. The STUN server list should be configurable; the default can use public STUN for the prototype.

The first technical spike must verify WebRTC support inside production `attn`:

- `RTCPeerConnection` available in Wry/WKWebView.
- `RTCDataChannel` works from the `attn://` custom protocol origin.
- `crypto.subtle` works from the same origin.
- Behavior is acceptable in both embedded production UI and Vite dev mode.

If WebRTC is unreliable in Wry, move WebRTC into Rust using a native WebRTC crate and keep the Svelte app as the review UI only. That is a larger dependency and async-runtime decision, so the webview spike should happen first.

## Document Model

The review session must not assume both peers are looking at the same mutable document. The owner has a live working copy. The reviewer has a snapshot that may become stale immediately after it is sent.

Use three distinct concepts:

- `WorkingDocument`: the owner's current file on disk.
- `ReviewSnapshot`: an immutable markdown snapshot shared at a point in time.
- `ReviewEvent`: a comment/suggestion/presence event anchored to a snapshot.

```ts
type WorkingDocument = {
  fileId: string;
  absolutePath: string;
  displayPath: string;
  markdown: string;
  currentHash: string;
  contentMtimeMs?: number;
  contentBytes?: number;
};

type ReviewSnapshot = {
  sessionId: string;
  fileId: string;
  snapshotId: string;
  baseHash: string;
  displayPath: string;
  createdAt: number;
  markdown: string;
  index: AnchorIndex;
};
```

`fileId` is not the absolute path. It should be stable inside one session and safe to share. For v1:

```text
fileId = base64url(truncate_128_bits(sha256("attn file" || room_secret || display_path || baseHash)))
```

The owner can keep a local map from `fileId` to absolute path. Reviewers only need `displayPath`.

## Divergent Replica Model

Do not try to directly align two mutable files:

```text
owner working copy <----?> reviewer working copy
```

That becomes ambiguous as soon as either side edits. Instead, every peer aligns its local state to the immutable `ReviewSnapshot`:

```text
                  ReviewSnapshot(baseHash)
                    /                 \
owner current file /                   \ reviewer current view/file
```

V1 reviewers do not need a local file at all; they can review the snapshot inside `attn`. Later, if a reviewer joins with their own checkout, their `attn` can map the session `fileId` to a local path and run the same resolver against their local file.

```ts
type DocumentReplica = {
  peerId: string;
  fileId: string;
  snapshotId: string;
  baseHash: string;
  localPath?: string;
  currentHash: string;
  currentMarkdown: string;
  currentIndex: AnchorIndex;
  relationToSnapshot: ReplicaRelation;
  revisionsFromSnapshot: LocalRevision[];
};

type ReplicaRelation =
  | { status: "same"; confidence: 1.0 }
  | { status: "changed"; confidence: number }
  | { status: "unrelated"; confidence: number }
  | { status: "unknown" };

type LocalRevision = {
  revisionId: string;
  parentHash: string;
  nextHash: string;
  createdAt: number;
  source:
    | "prosemirror_edit"
    | "accepted_suggestion"
    | "external_file_change"
    | "snapshot_loaded";
  pmSteps?: unknown[];
  patchText?: string;
};
```

The important invariant:

```text
ReviewEvent.anchor.baseHash always points to the snapshot hash, not to either peer's current file hash.
```

That means an event created by a reviewer can be rendered exactly in the reviewer snapshot, then independently resolved into the owner working copy when the owner receives it.

For edits made inside `attn`, keep an in-memory `LocalRevision` journal so anchors can be mapped through ProseMirror step maps. For edits detected by the file watcher, record an `external_file_change` revision without step maps and fall back to anchor resolution.

## Anchor Index

Each snapshot should include an anchor index derived from the markdown. This is the data structure that lets a comment on a snippet in the reviewer snapshot map back to the owner's changed document.

```ts
type AnchorIndex = {
  docHash: string;
  lineCount: number;
  blocks: AnchorBlock[];
  headings: AnchorHeading[];
};

type AnchorBlock = {
  blockId: string;
  kind:
    | "heading"
    | "paragraph"
    | "list_item"
    | "code_block"
    | "blockquote"
    | "table"
    | "thematic_break"
    | "html"
    | "unknown";
  lineRange: [number, number];
  charRange: [number, number];
  pmRange?: [number, number];
  headingPath: AnchorHeadingRef[];
  ordinalInParent: number;
  textHash: string;
  normalizedTextHash: string;
  prefixHash?: string;
  suffixHash?: string;
  previousBlockHash?: string;
  nextBlockHash?: string;
};

type AnchorHeading = {
  level: number;
  text: string;
  textHash: string;
  line: number;
  path: AnchorHeadingRef[];
};

type AnchorHeadingRef = {
  level: number;
  textHash: string;
  ordinalAtLevel: number;
};
```

`blockId` is snapshot-local. It is not expected to survive arbitrary edits.

```text
blockId = base64url(truncate_128_bits(sha256(kind || charRange || normalizedTextHash || headingPath)))
```

For v1, the index can be derived in TypeScript from the ProseMirror document because the editor is already the primary markdown surface. Later, if needed, Rust can produce the same index in headless paths.

## Review Anchors

A review event should carry multiple anchor strategies. No single strategy is enough:

- position: where the selection was in the original snapshot
- quote: what text was selected
- block: what markdown block contained the selection
- context: what surrounded the selected text/block
- structure: what heading/list/table region contained it

```ts
type Anchor = {
  v: 1;
  fileId: string;
  snapshotId: string;
  baseHash: string;

  position: PositionAnchor;
  quote?: QuoteAnchor;
  block?: BlockAnchor;
  context?: ContextAnchor;
  structure?: StructureAnchor;
};

type PositionAnchor = {
  lineRange: [number, number];
  charRange: [number, number];
  pmRange?: [number, number];
};

type QuoteAnchor = {
  exact: string;
  exactHash: string;
  normalized: string;
  normalizedHash: string;
};

type BlockAnchor = {
  blockId: string;
  kind: AnchorBlock["kind"];
  blockTextHash: string;
  blockNormalizedTextHash: string;
  offsetInBlock: [number, number];
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

`QuoteAnchor.exact` and context snippets are encrypted as part of the review event. They are never visible to the relay. Keeping the actual quote, not only the hash, is important because fuzzy re-anchoring needs text.

Use bounded snippets:

- `quote.exact`: selected text, capped to a reasonable size.
- `context.prefix`: up to 160 characters before the selection.
- `context.suffix`: up to 160 characters after the selection.

For comments on a whole block with no text selection, omit `quote` and anchor to `block`.

## Why This Matters

Example:

```text
T0 owner shares snapshot:
  line 42: The system stores feedback forever.

T1 reviewer comments on "stores feedback forever".

T2 owner edits locally before seeing the comment:
  line 42: The system keeps encrypted feedback for seven days.
```

The incoming comment cannot rely on line 42. The resolver should still find the best target by combining:

- same `baseHash`? If yes, exact position works.
- same selected quote? Not in this example.
- same paragraph/block hash? Maybe no.
- same heading path and nearby block context? Likely yes.
- fuzzy match between old quote and edited sentence? Likely yes.

The UI should then mark the anchor as remapped with confidence, not pretend it was exact.

## Anchor Resolution

When the owner receives a review event, resolve its `Anchor` against the current working document.

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
        | "block_hash_match"
        | "context_match"
        | "heading_context_match"
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

1. **Exact snapshot match**
   If `working.currentHash === anchor.baseHash`, use `position` directly.

2. **Local step mapping**
   If the owner has ProseMirror steps or saved patch metadata from `baseHash` to `currentHash`, map the original `pmRange` through those steps. This is the best long-term path, but v1 does not need it to exist before comments work.

3. **Exact quote search**
   Search the current markdown for `quote.exact`. If there is exactly one match, resolve there.

4. **Block hash search**
   Build a fresh `AnchorIndex` for the current document. If a block with the same `blockNormalizedTextHash` exists, use `offsetInBlock` inside that block.

5. **Structure-constrained quote search**
   Find the current region matching `structure.headingPath`, then search for the quote inside that region.

6. **Context match**
   Search for the closest match to `context.prefix + quote + context.suffix`, allowing the selected quote to have changed.

7. **Fuzzy quote match**
   Use a bounded fuzzy match against candidate blocks in the same heading region. Score by text similarity, heading path match, ordinal proximity, and previous/next block hash matches.

8. **Line proximity fallback**
   Use original `lineRange` only as a low-confidence fallback and show it as stale/ambiguous unless no better candidate exists.

Suggested confidence scoring:

```text
base hash exact:              1.00
mapped through local steps:   0.98
unique exact quote:           0.90
block hash match:             0.85
structure + quote:            0.80
context match:                0.70
fuzzy quote match:            0.50-0.75
line proximity only:          <=0.35
```

UI behavior:

- `exact`: normal comment highlight.
- `remapped`: normal highlight with subtle "moved" state in the panel.
- `ambiguous`: show candidates and ask the owner to pick one.
- `stale`: keep the comment in the panel but do not attach it inline.

## Suggestions Need Stronger Guards

A suggestion must include the text it expected to replace. Accepting a stale suggestion should never blindly edit the file.

```ts
type SuggestionCreated = {
  type: "suggestion_created";
  id: string;
  anchor: Anchor;
  expectedText: string;
  replacement: string;
  note?: string;
  author: PeerSummary;
  createdAt: number;
};
```

Apply flow:

1. Resolve the anchor against the current document.
2. If exact or high-confidence remapped, verify the current text equals `expectedText`.
3. If the text differs, show a three-way apply UI:
   - original expected text
   - current owner text
   - reviewer replacement
4. Only write to disk after owner confirmation.

This keeps comments forgiving and suggestions conservative.

## Review Protocol

The collaboration payload is an append-only event stream. V1 carries these events over the direct DataChannel.

Session events:

```ts
type ReviewEvent =
  | SnapshotShared
  | CommentCreated
  | SuggestionCreated
  | CommentResolved
  | SuggestionAccepted
  | SuggestionRejected
  | PresenceUpdated
  | SessionEnded;
```

Snapshot:

```ts
type SnapshotShared = {
  type: "snapshot_shared";
  sessionId: string;
  fileId: string;
  snapshotId: string;
  displayPath: string;
  baseHash: string;
  markdown: string;
  index: AnchorIndex;
};
```

Comment:

```ts
type CommentCreated = {
  type: "comment_created";
  id: string;
  anchor: Anchor;
  body: string;
  author: PeerSummary;
  createdAt: number;
};
```

Suggestion:

```ts
type SuggestionCreated = {
  type: "suggestion_created";
  id: string;
  anchor: Anchor;
  expectedText: string;
  replacement: string;
  note?: string;
  author: PeerSummary;
  createdAt: number;
};
```

## Owner-Authoritative Apply Flow

Reviewer suggestions do not mutate the owner's markdown file.

```text
reviewer creates suggestion
  -> owner receives suggestion
  -> owner accepts/rejects/edits
  -> owner attn applies local patch
  -> existing save/watch flow updates the file and UI
```

This fits current `attn` behavior, where the frontend serializes markdown and Rust writes the active file through `edit_save`.

## Codebase Integration

Rust entry points:

- `src/main.rs`: CLI parsing and daemon startup.
- `src/daemon.rs`: local Unix socket commands from later CLI invocations.
- `src/ipc.rs`: webview-to-Rust commands.
- `src/watcher.rs`: cross-thread `UserEvent` bus into the Tao event loop.

Frontend entry points:

- `web/src/App.svelte`: active document state, tabs, IPC payload handling.
- `web/src/lib/Editor.svelte`: ProseMirror integration.
- `web/src/lib/ipc.ts`: frontend-to-native IPC wrapper.
- `web/src/lib/types.ts`: shared UI payload types.

New modules/components:

- `src/review.rs`: native review session state, CLI/socket command handling, and bridge events.
- `web/src/lib/review/crypto.ts`: invite parsing, HKDF, encrypt/decrypt helpers.
- `web/src/lib/review/signaling.ts`: Cloudflare WebSocket signaling client.
- `web/src/lib/review/webrtc.ts`: WebRTC peer and DataChannel handling.
- `web/src/lib/review/protocol.ts`: review event types and validation.
- `web/src/lib/prosemirror/review.ts`: comment/suggestion decorations.
- `web/src/lib/ReviewPanel.svelte`: thread list and suggestion controls.

## CLI And IPC Shape

CLI:

```bash
attn review live <path>
attn review join <invite>
attn review stop
```

Daemon socket messages:

```rust
SocketMessage::ReviewLive { path: String }
SocketMessage::ReviewJoin { invite: String }
SocketMessage::ReviewStop
```

Webview IPC messages:

```ts
{ type: "review_live_start" }
{ type: "review_join", invite: string }
{ type: "review_stop" }
{ type: "review_event", event: EncryptedReviewEvent }
```

Rust-to-webview callbacks:

```ts
window.__attn__.reviewEvent(payload)
```

For the first implementation, it is acceptable for WebRTC and the relay WebSocket to live in the Svelte layer if the webview spike passes. Rust still owns working-copy reads/writes and CLI orchestration.

## Cloudflare Deployment

Repository layout:

```text
relay/
  package.json
  wrangler.toml
  src/index.ts
```

Cloudflare pieces:

- Worker handles HTTP routing and WebSocket upgrade.
- Durable Object class owns one room.
- Binding name: `ROOMS`.
- No R2, KV, D1, Queues, or Workers AI in v1.
- Custom domain later, for example `signal.attn.dev`.

Wrangler environment variables:

```text
MAX_PEERS_PER_ROOM=2
MAX_FRAME_BYTES=32768
MAX_MESSAGES_PER_MINUTE=120
ROOM_MAX_AGE_SECONDS=14400
EMPTY_ROOM_TTL_SECONDS=60
```

Deployment commands:

```bash
cd relay
npm install
npx wrangler dev
npx wrangler deploy
```

Keep the relay OSS and easy to self-host. Hosted Cloudflare is the default path, not a lock-in.

## Cost Strategy

The cost strategy is to avoid the expensive categories entirely:

- No TURN bandwidth.
- No stored document blobs.
- No durable message history.
- No per-keystroke sync.
- No always-on VM.
- No database writes in the hot path.

Cloudflare Durable Objects are available on Workers Free, and pricing docs list a free daily request tier. Durable Objects bill for requests and compute duration; WebSocket hibernation is the important feature because idle hibernatable sockets avoid duration charges.

The risk to watch is message count, not bandwidth. Keep signaling sparse:

- SDP offer/answer once.
- ICE candidates during connection setup.
- Presence changes.
- Retry/reconnect messages.

Review comments and suggestions should travel over the DataChannel after connection, not through Cloudflare.

## Implementation Phases

### Phase 0: Webview Capability Spike

- Verify WebRTC and DataChannel in `attn://` production mode.
- Verify WebCrypto HKDF/AES-GCM in production mode.
- Verify Vite dev mode behavior.
- Decide whether WebRTC lives in Svelte or Rust.

### Phase 1: Local Relay Prototype

- Add `relay/` package with local WebSocket room router.
- Forward opaque frames only.
- Enforce max two peers and frame size.
- Add a small local test harness.

### Phase 2: Cloudflare Relay

- Port the room router to Worker + Durable Object.
- Use hibernatable WebSockets.
- Add rate limits and caps.
- Deploy to a Cloudflare dev route.

### Phase 3: Native Session Plumbing

- Add `attn review live <path>`.
- Add `attn review join <invite>`.
- Extend daemon socket messages.
- Add review state and status events.

### Phase 4: Direct Peer Connection

- Implement encrypted signaling.
- Establish direct DataChannel.
- Send owner snapshot to reviewer.
- Send presence and connection status both ways.

### Phase 5: Review UI

- Add right-side review panel.
- Add text selection to comment flow.
- Add comment range highlights.
- Add suggestion events without applying them automatically.
- Add owner accept/reject controls.

### Phase 6: Hardening

- Reconnect and ICE restart.
- Clear failure states.
- Local pending outbox while disconnected.
- Better anchors and re-anchoring.
- Basic smoke tests for relay and protocol.

### Future: Bounded Mailbox

Add async later as a second transport for the same encrypted review events.

```text
encrypted snapshot blob: optional, TTL-bound
encrypted event mailbox: bounded, TTL-bound
owner import ACK: deletes delivered events
```

This should be a product mode, not the default v1:

- `Live`: owner must be online, no server storage.
- `Async 24h`: encrypted snapshot and mailbox expire tomorrow.
- `Async 7d`: encrypted snapshot and mailbox expire in one week.

## Open Questions

- Should v1 allow more than two peers, or keep pair review only?
- Should the owner share only the active file or a set of markdown files?
- Should display paths be encrypted only, or is relative path disclosure acceptable in native-only sessions?
- Should the relay require a lightweight proof-of-work or signed room token to reduce room spam?
- Should the app use public STUN defaults or require explicit STUN configuration?
- Should review events be validated with a schema library in TypeScript before rendering?
