import type {
  Anchor,
  CommentCreatedBody,
  ContentPayload,
  EventAuth,
  EventId,
  EventMeta,
  InitPayload,
  IpcMessage,
  ParticipantId,
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ReviewEventBody,
  ReviewSnapshot,
  ReviewStatus,
  RoomId,
  RoomPolicy,
  SuggestionAcceptedBody,
  SuggestionCreatedBody,
  SuggestionDraft,
  UpdatePayload,
} from './types';

const SAMPLE_MARKDOWN = `# Project Plan

## Phase 1: Setup

- [x] Initialize repository
- [x] Set up CI/CD pipeline
- [ ] Configure linting rules

## Phase 2: Core Features

- [ ] Implement user authentication
- [ ] Build dashboard view
- [x] Create database schema

## Notes

This is a **sample markdown** document with ~~strikethrough~~ for development.

### Code Example

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

### Links

See [the docs](https://example.com) for more info.

> This is a blockquote with some important context
> that spans multiple lines.

---

| Feature | Status |
|---------|--------|
| Auth    | Done   |
| API     | WIP    |
| UI      | Todo   |
`;

type SetContentFn = (data: ContentPayload) => void;
type UpdateContentFn = (data: UpdatePayload) => void;
type FontScaleFn = () => void;
type ReviewStatusFn = (payload: ReviewStatus) => void;
type ReviewEventFn = (payload: ReviewEvent) => void;
type ReviewSnapshotFn = (snapshot: ReviewSnapshot) => void;
type ReviewAnchorResolutionFn = (update: ReviewAnchorResolutionUpdate) => void;

interface AttnBridge {
  setContent: SetContentFn;
  updateContent: UpdateContentFn;
  increaseFontScale?: FontScaleFn;
  decreaseFontScale?: FontScaleFn;
  resetFontScale?: FontScaleFn;
  /**
   * Push transport/connection status for one review room. No-op stub today —
   * wired to the review store later (see attn-nnj.12.10 / Phase 2).
   * @see planning/collab/data-model.md §Webview IPC Changes
   */
  reviewStatus: ReviewStatusFn;
  /**
   * Push an append-only review-log event into the webview. No-op stub today —
   * wired to the review store later (see attn-nnj.12.10 / Phase 2).
   * @see planning/collab/data-model.md §Review Events
   */
  reviewEvent: ReviewEventFn;
  /**
   * Push a newly imported snapshot payload to the webview. No-op stub today —
   * wired to the review store later (see attn-nnj.12.10 / Phase 2).
   * @see planning/collab/data-model.md §Snapshot Graph
   */
  reviewSnapshot: ReviewSnapshotFn;
  /**
   * Push a per-event anchor-resolution update to the webview. No-op stub
   * today — wired to the review store later (see attn-nnj.12.10 / Phase 2).
   * @see planning/collab/data-model.md §Anchor Resolution
   */
  reviewAnchorResolution: ReviewAnchorResolutionFn;
}

/** Kinds of review callback the test helper can fire into the bridge. */
export type MockReviewEmitKind = 'status' | 'event' | 'snapshot' | 'anchor_resolution';

declare global {
  interface Window {
    __attn__?: AttnBridge;
    __attn_init__?: InitPayload;
    __attn_native_shortcuts__?: boolean;
    /**
     * E2E helper: dispatch a synthetic review callback through the bridge.
     * Exposed only when the mock IPC is installed (i.e. dev builds without a
     * wry host). Wired up in `installMockIpc`. See attn-nnj.12.6.
     */
    __mockEmitReview?: (kind: MockReviewEmitKind, payload: unknown) => void;
  }
}

// ---------------------------------------------------------------------------
// Mock review helpers
//
// These helpers produce *placeholder* review payloads so the frontend dev
// loop can verify wiring (IPC -> bridge -> reviewStore) without booting the
// Rust ReviewManager. They explicitly skip everything the real flow does:
//
//   - No Ed25519 signatures (attn-nnj.1.6) — `EventAuth` carries fake strings.
//   - No deterministic ID derivation (attn-nnj.1.8) — IDs are
//     `mock-${kind}-${Date.now()}-${counter}` so they're unique within a
//     session but obviously synthetic.
//   - No PoW / token admission (attn-nnj.1.7 / 5.x) — the mock just acks.
//   - No envelope encryption (attn-nnj.1.5) — payloads ride as plain objects.
//
// Phase 2 issue 4.1 ("mock-ipc scenario stream") will layer scripted scenario
// playback on top of this; 12.6 only adds the bare command-accept + minimal
// echo so a dev poking at the UI sees the store update.
// ---------------------------------------------------------------------------

const MOCK_ROOM_ID: RoomId = 'mock-room-1';
const MOCK_FILE_ID = 'mock-file-1';
const MOCK_SNAPSHOT_ID = 'mock-snapshot-1';
const MOCK_BASE_HASH = 'mock-hash-0000';
const MOCK_AUTHOR_ID: ParticipantId = 'mock-author-1';
const MOCK_DEVICE_ID = 'mock-device-1';
const MOCK_SIGNING_KEY_ID = 'mock-signing-key-1';

let mockEventCounter = 0;
function mockEventId(prefix: string): EventId {
  mockEventCounter += 1;
  return `mock-${prefix}-${Date.now()}-${mockEventCounter}`;
}

function mockPolicy(mode: RoomPolicy['mode']): RoomPolicy {
  return {
    mode,
    maxPeers: 8,
    maxSnapshotBytes: 1_000_000,
    maxEventBytes: 64_000,
    maxEvents: 10_000,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    deleteEventsAfterOwnerAck: false,
    allowBrowser: true,
    allowRemoteAgents: false,
  };
}

function mockStatus(mode: RoomPolicy['mode']): ReviewStatus {
  return {
    roomId: MOCK_ROOM_ID,
    mode,
    connection: 'live_direct',
    peers: [],
    outboxPending: 0,
  };
}

function mockEventMeta(eventId: EventId): EventMeta {
  return {
    v: 2,
    eventId,
    roomId: MOCK_ROOM_ID,
    authorId: MOCK_AUTHOR_ID,
    deviceId: MOCK_DEVICE_ID,
    createdAt: Date.now(),
    parentEventIds: [],
    snapshotId: MOCK_SNAPSHOT_ID,
  };
}

function mockAuth(): EventAuth {
  // Real flow: signature comes from Ed25519 over canonical bytes
  // (attn-nnj.1.3 / 1.6). Mock uses a fixed placeholder so the wire shape
  // type-checks; verifiers must never accept this string.
  return {
    signature: 'mock-signature',
    signingKeyId: MOCK_SIGNING_KEY_ID,
  };
}

function mockReviewEvent(body: ReviewEventBody, eventId: EventId): ReviewEvent {
  return {
    meta: mockEventMeta(eventId),
    body,
    auth: mockAuth(),
  };
}

function emitStatus(status: ReviewStatus): void {
  window.__attn__?.reviewStatus(status);
}

function emitEvent(event: ReviewEvent): void {
  window.__attn__?.reviewEvent(event);
}

function emitSnapshot(snapshot: ReviewSnapshot): void {
  window.__attn__?.reviewSnapshot(snapshot);
}

function emitAnchorResolution(update: ReviewAnchorResolutionUpdate): void {
  window.__attn__?.reviewAnchorResolution(update);
}

function handleReviewShare(msg: Extract<IpcMessage, { type: 'review_share' }>): void {
  // Real flow: Rust ReviewManager (attn-nnj.2.8) mints a room, derives keys,
  // and reports back live/direct connection status. Mock just emits a single
  // synthetic status payload after a short delay so the store visibly
  // populates.
  setTimeout(() => {
    emitStatus(mockStatus(msg.mode));
  }, 200);
}

function handleReviewJoin(_msg: Extract<IpcMessage, { type: 'review_join' }>): void {
  // Real flow: parse invite, run admission handshake (attn-nnj.5.2), import
  // mailbox snapshot. Mock just acks with a default live status to confirm
  // the inbound command was accepted.
  setTimeout(() => {
    emitStatus(mockStatus('live'));
  }, 200);
}

function commentBody(anchor: Anchor, body: string, eventId: EventId): CommentCreatedBody {
  return {
    type: 'comment_created',
    threadId: `mock-thread-${eventId}`,
    anchor,
    body,
  };
}

function suggestionCreatedBody(
  draft: SuggestionDraft,
  suggestionId: string,
): SuggestionCreatedBody {
  return {
    type: 'suggestion_created',
    suggestionId,
    anchor: draft.anchor,
    operation: draft.operation,
    note: draft.note,
  };
}

function suggestionAcceptedBody(suggestionId: EventId): SuggestionAcceptedBody {
  return {
    type: 'suggestion_accepted',
    suggestionId,
    appliedRevisionId: `mock-revision-${suggestionId}`,
    resultingHash: MOCK_BASE_HASH,
  };
}

function handleReviewCreateComment(
  msg: Extract<IpcMessage, { type: 'review_create_comment' }>,
): void {
  const eventId = mockEventId('comment');
  const event = mockReviewEvent(commentBody(msg.anchor, msg.body, eventId), eventId);
  setTimeout(() => emitEvent(event), 50);
}

function handleReviewCreateSuggestion(
  msg: Extract<IpcMessage, { type: 'review_create_suggestion' }>,
): void {
  const suggestionId = mockEventId('suggestion');
  const event = mockReviewEvent(
    suggestionCreatedBody(msg.draft, suggestionId),
    suggestionId,
  );
  setTimeout(() => emitEvent(event), 50);
}

function handleReviewAcceptSuggestion(
  msg: Extract<IpcMessage, { type: 'review_accept_suggestion' }>,
): void {
  const eventId = mockEventId('suggestion-accepted');
  const event = mockReviewEvent(suggestionAcceptedBody(msg.suggestionId), eventId);
  setTimeout(() => emitEvent(event), 50);
}

function handleReviewResolveAnchor(
  msg: Extract<IpcMessage, { type: 'review_resolve_anchor' }>,
): void {
  // Real flow: ReviewManager runs the anchor resolver and broadcasts an
  // update with confidence + reason. Mock echoes a confident `exact` result
  // built from the position payload the caller supplied.
  const update: ReviewAnchorResolutionUpdate = {
    roomId: msg.roomId,
    fileId: MOCK_FILE_ID,
    eventId: msg.eventId,
    resolved: {
      status: 'exact',
      confidence: 1.0,
      currentRange: msg.range,
      reason: 'base_hash_match',
    },
  };
  setTimeout(() => emitAnchorResolution(update), 50);
}

function dispatchReviewCommand(msg: IpcMessage): void {
  switch (msg.type) {
    case 'review_share':
      handleReviewShare(msg);
      return;
    case 'review_join':
      handleReviewJoin(msg);
      return;
    case 'review_create_comment':
      handleReviewCreateComment(msg);
      return;
    case 'review_create_suggestion':
      handleReviewCreateSuggestion(msg);
      return;
    case 'review_accept_suggestion':
      handleReviewAcceptSuggestion(msg);
      return;
    case 'review_resolve_anchor':
      handleReviewResolveAnchor(msg);
      return;
    default:
      // Non-review messages are simply logged by the caller.
      return;
  }
}

function isReviewMessage(msg: IpcMessage): boolean {
  return msg.type.startsWith('review_');
}

function emitMockReview(kind: MockReviewEmitKind, payload: unknown): void {
  switch (kind) {
    case 'status':
      emitStatus(payload as ReviewStatus);
      return;
    case 'event':
      emitEvent(payload as ReviewEvent);
      return;
    case 'snapshot':
      emitSnapshot(payload as ReviewSnapshot);
      return;
    case 'anchor_resolution':
      emitAnchorResolution(payload as ReviewAnchorResolutionUpdate);
      return;
  }
}

/**
 * E2E test helper. Drives the same bridge callbacks Rust would invoke, so the
 * review store can be exercised from the daemon's `--eval` channel without
 * standing up the real transport. Exported for `scripts/test-review-e2e.sh`
 * (attn-nnj.11.4) to flip its PEND assertions to PASS.
 *
 * Payload typing is `unknown` at the boundary because the helper is invoked
 * via stringified JSON from the daemon CLI; downstream consumers (store,
 * components) re-validate as needed. The mock makes no shape guarantees.
 */
export function __mockEmitReview(kind: MockReviewEmitKind, payload: unknown): void {
  emitMockReview(kind, payload);
}

export function installMockIpc(): void {
  // Only install if not running inside wry (no native ipc)
  if (window.ipc) return;

  console.log('[attn] Dev mode: installing mock IPC');

  // Set up mock init payload — now sends raw markdown, ProseMirror renders it
  window.__attn_init__ = {
    markdown: SAMPLE_MARKDOWN,
    structure: {
      phases: [
        { title: 'Phase 1: Setup', progress: { done: 2, total: 3 } },
        { title: 'Phase 2: Core Features', progress: { done: 1, total: 3 } },
      ],
      tasks: [
        { line: 5, text: 'Initialize repository', checked: true },
        { line: 6, text: 'Set up CI/CD pipeline', checked: true },
        { line: 7, text: 'Configure linting rules', checked: false },
        { line: 11, text: 'Implement user authentication', checked: false },
        { line: 12, text: 'Build dashboard view', checked: false },
        { line: 13, text: 'Create database schema', checked: true },
      ],
      file_refs: [],
    },
    theme: 'light',
  };

  // Mock window.ipc.postMessage
  window.ipc = {
    postMessage(message: string) {
      const parsed = JSON.parse(message) as IpcMessage;
      console.log('[attn] IPC out:', parsed);
      if (isReviewMessage(parsed)) {
        dispatchReviewCommand(parsed);
      }
    },
  };

  // Expose the E2E helper. Stays on `window` so the daemon `--eval` channel
  // can drive it without bundling a separate test entry point.
  window.__mockEmitReview = __mockEmitReview;
}
