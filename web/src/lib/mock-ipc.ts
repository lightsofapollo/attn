import type {
  Anchor,
  CommentCreatedBody,
  ContentPayload,
  EventAuth,
  EventId,
  EventMeta,
  FileId,
  InitPayload,
  IpcMessage,
  ParticipantId,
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ReviewEventBody,
  ReviewShareReady,
  ReviewSnapshot,
  ReviewStatus,
  RoomId,
  RoomPolicy,
  SnapshotId,
  SuggestionAcceptedBody,
  SuggestionCreatedBody,
  SuggestionDraft,
  UpdatePayload,
} from './types';
import type { InviteTierV3 } from './review/browser-invite';
import {
  deliverLocalPath,
  hasLocalFiles,
  localMarkdown,
  localShareableFiles,
} from './local-file-source';
// The real thing, not a mock: see `publishMockSnapshots`. A snapshot is the one
// payload in this file whose content has to be genuine, so it borrows the same
// hasher and the same canonical Rust/comrak indexer the hosted browser
// publisher uses.
import { buildCanonicalAnchorIndex } from './review/browser-anchor-index';
import { contentHash } from './review/browser-crypto';
import {
  mockFileIdFor,
  mockSnapshotIdFor,
  pathWithinRoot,
  sharedMarkdownPaths,
} from './mock-share-snapshot';

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
type ReviewShareReadyFn = (payload: import('../lib/types').ReviewShareReady) => void;
type ReviewEventFn = (payload: ReviewEvent) => void;
type ReviewSnapshotFn = (snapshot: ReviewSnapshot) => void;
type ReviewAnchorResolutionFn = (update: ReviewAnchorResolutionUpdate) => void;
type ReviewPresenceFn = (payload: import('../lib/types').ReviewPresenceChanged) => void;
type ReviewConnectionFn = (payload: import('../lib/types').ReviewConnectionChanged) => void;
type ReviewUnreadFn = (payload: import('../lib/types').ReviewUnreadChanged) => void;
type ReviewNotificationMuteFn = (payload: import('../lib/types').ReviewNotificationMuteChanged) => void;
type ReviewCollabFn = (payload: import('../lib/types').ReviewCollabSignal) => void;

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
   * Pushed by Rust right after a Share completes, carrying the minted invite
   * URL + verify-key fingerprint inputs so the dialog can render the URL
   * reactively without a follow-up round-trip.
   */
  reviewShareReady?: ReviewShareReadyFn;
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
  /**
   * Push a live presence delta (relay `hello`/`presence` frames). Feeds
   * `reviewStore.peers` → PeerStrip face chips. Optional: only the daemon
   * emits it; the mock harness leaves it unset.
   */
  reviewPresence?: ReviewPresenceFn;
  /**
   * Push a live transport connection-state change (`mailbox`/`offline`).
   * Drives the ShareChip status. Optional: only the daemon emits it.
   */
  reviewConnection?: ReviewConnectionFn;
  /** Push the daemon-owned durable unread count for one room. */
  reviewUnread?: ReviewUnreadFn;
  /** Push the persisted per-room native notification preference. */
  reviewNotificationMute?: ReviewNotificationMuteFn;
  /**
   * Push inbound live co-typing traffic (prosemirror-collab steps) to the
   * webview's collab controller. Optional: only the daemon emits it.
   */
  reviewCollab?: ReviewCollabFn;
  /**
   * Optional: focus the margin card whose underlying root event matches
   * `eventId`. Implemented by attn-nnj.4.3's ReviewMargin via
   * `reviewStore.setFocusEventId`; exposed on the bridge so 10.2's
   * editor ↔ surface focus sync can call it from highlight-click
   * handlers and so E2E tests can drive focus without poking the store.
   * @see planning/collab/ui/review-panel-design.md §6
   */
  reviewFocusCard?: (eventId: string) => void;
}

/**
 * Kinds of review callback the test helper can fire into the bridge.
 *
 * `share_ready` is the browser stand-in for the daemon's
 * `ReviewUpdate::ShareReady`, pushed by Rust right after `Bootstrapper::share`
 * succeeds. Keep it in step with the Rust side: `build_invite_url_v3` /
 * `build_browser_invite_url_v3` (src/review/bootstrap.rs) mint the URLs and
 * `ReviewManager` (src/review/manager.rs) sends them; here they are
 * synthesised. Same callback (`window.__attn__.reviewShareReady`), same
 * payload shape (`ReviewShareReady` in types.ts), same consumer
 * (`applyShareReady` in review/store.svelte.ts).
 *
 * Without it the share sheet could not complete in this loop at all: there is
 * no relay client here, so `review_share` produced a status and nothing else,
 * no invite URL ever reached the dialog, and the sheet pended until its 15s
 * deadline and then reported a failure (attn-bw2h.6).
 */
export type MockReviewEmitKind = 'status' | 'event' | 'snapshot' | 'anchor_resolution' | 'share_ready';

/**
 * One scripted entry in a mock-IPC scenario file. Mirrors the
 * `__mockEmitReview` argument shape so the loader can dispatch each step
 * by routing `kind` → `emit{Kind}` against the bridge. `delayMs` is the
 * pre-event wait used by `playScenario` (scaled by `opts.speed`).
 *
 * Payload typing is `unknown` because scenarios live in JSON and the
 * downstream consumers (review store + components) re-validate as
 * needed. The mock makes no shape guarantees beyond the variant tag.
 *
 * @see web/src/lib/mock-ipc-scenarios/*.json
 */
export interface MockScenarioStep {
  kind: MockReviewEmitKind;
  payload: unknown;
  /** Delay (ms) before this step fires, relative to the previous step. */
  delayMs?: number;
  /** Optional human-readable note for debugging logs / E2E traces. */
  note?: string;
}

/**
 * Top-level shape of a JSON scenario in `web/src/lib/mock-ipc-scenarios/`.
 * `version` is pinned to `1` for now; loaders reject anything else so we
 * can evolve the wire format without silent breakage.
 */
export interface MockScenario {
  version: 1;
  name: string;
  description?: string;
  /** Fallback delay (ms) applied when a step omits `delayMs`. */
  defaultDelayMs?: number;
  steps: MockScenarioStep[];
}

/** Optional playback knobs for `playScenario`. */
export interface PlayScenarioOptions {
  /**
   * Playback rate. `speed=1` plays scenario delays as authored;
   * `speed=2` halves them; `speed=0` collapses delays to zero (useful
   * for unit tests that drive scenarios synchronously).
   */
  speed?: number;
  /** Receive each step + its index after it fires. Useful for tests. */
  onStep?: (step: MockScenarioStep, index: number) => void;
}

/**
 * Public surface exposed on `window.__attnMockScenario`. Daemon E2E
 * tests call into it via `attn --eval "window.__attnMockScenario.play(...)"`.
 */
export interface MockScenarioApi {
  /** List of bundled scenario names (resolves at install time). */
  available: readonly string[];
  /** Load a scenario file by short name. */
  load: (name: string) => Promise<MockScenario>;
  /**
   * Load + replay a scenario sequentially. Returns the resolved scenario
   * once the final step has fired so callers can chain `await` cleanly.
   */
  play: (name: string, opts?: PlayScenarioOptions) => Promise<MockScenario>;
}

declare global {
  interface Window {
    __attn__?: AttnBridge;
    __attn_init__?: InitPayload;
    __attn_native_shortcuts__?: boolean;
    /**
     * True only when this page is running WITHOUT a wry host — i.e. the mock
     * shim below is standing in for the daemon. Surfaces that can only work
     * one way or the other read it to choose: `OpenLocalFiles.svelte` offers
     * the browser file picker on the strength of this flag, because in the
     * native window a picked File carries no path the daemon could open.
     */
    __attnMockIpc?: boolean;
    /**
     * E2E helper: dispatch a synthetic review callback through the bridge.
     * Exposed only when the mock IPC is installed (i.e. dev builds without a
     * wry host). Wired up in `installMockIpc`. See attn-nnj.12.6.
     */
    __mockEmitReview?: (kind: MockReviewEmitKind, payload: unknown) => void;
    /**
     * E2E helper: load and replay a scripted mock-IPC review scenario.
     * Exposed by `installMockIpc` so the daemon `--eval` channel can drive
     * Phase 2 review surfaces without booting the Rust ReviewManager.
     * See attn-nnj.4.1.
     */
    __attnMockScenario?: MockScenarioApi;
    /**
     * E2E helper: the live `reviewStore` instance. Exposed by App.svelte so
     * the daemon `--eval` channel can call store methods directly (e.g.
     * `__attn_review_store__.setCurrentFile('scenario-file-1')`). See
     * `scripts/test-review-e2e.sh` (attn-nnj.4.14).
     */
    __attn_review_store__?: unknown;
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

// Fake key material for the synthesised invites (attn-bw2h.6). Correct
// base64url charset and correct LENGTHS — 43 chars for a 32-byte key, 86 for a
// 64-byte Ed25519 signature — so anything that eyeballs or parses an invite in
// this loop sees a realistic shape. The values are fixed nonsense; nothing
// here derives from a secret and no verifier must ever accept them, exactly
// like `mockAuth`'s 'mock-signature'.
const MOCK_READ_CAPABILITY_KEY = '2r_JM_YJOpt85UeVcDTMc_6PCjhosdMZFORQNZxx7Yo';
const MOCK_WRITE_ADMISSION_KEY = 'fS2m-CamUJ3w_YzSh6R50QBgWlWd5ef-H9ri-CkDdi8';
const MOCK_OWNER_SIGNING_KEY = '2v50b1M1T8i2A5qJzJZxtnH7y0_d9HNNBtCZD7dR_Ng';
/**
 * Per-tier owner grants. The read and write keys are shared across tiers
 * because both derive from the one room secret; the GRANT is what differs, and
 * it is a signature over `{grantTier, purpose, roomId, v}` (see
 * `canonical_device_grant_v3` in src/review/bootstrap.rs). That is what makes
 * comment-vs-suggest a cryptographic boundary rather than a label a joiner
 * could edit, so the mock reproduces the distinction instead of emitting three
 * interchangeable URLs.
 */
const MOCK_TIER_GRANTS: Record<'comment' | 'suggest', string> = {
  comment:
    'U63wyrpCLZt_AyNd7jsTuKXnnJJZxlRLdEiReFEmZVtDb-c_LW8xt42BXRbuIvPx7_8otW5HX51sRqeISLxPXA',
  suggest:
    'ZXp12_pwQggKR7J25unrHIQInsaeJ9dTTvf4oi-MIG_DJ5FsgjDUznedQ2o2bS6PsFhH63IfYUHJAZJSoaHtGw',
};
/** Matches `DEFAULT_BROWSER_REVIEW_URL` in src/review/bootstrap.rs. */
const MOCK_BROWSER_REVIEW_BASE = 'https://attn.sh/review';

/**
 * Build a v3 invite fragment the way `build_invite_fragment_v3`
 * (src/review/bootstrap.rs) does — field order included, since the Rust parser
 * rejects noncanonical ordering. `view` carries the read key only; a writable
 * tier adds the write admission key and the owner's grant.
 */
function mockInviteFragment(tier: InviteTierV3): string {
  const read = `#v=3&tier=${tier}&read=${MOCK_READ_CAPABILITY_KEY}`;
  if (tier === 'view') return read;
  return `${read}&write=${MOCK_WRITE_ADMISSION_KEY}&grant=${MOCK_TIER_GRANTS[tier]}`;
}

/** `attn://review/<roomId>#…` — the deep link installed reviewers use. */
function mockNativeInvite(tier: InviteTierV3): string {
  return `attn://review/${MOCK_ROOM_ID}${mockInviteFragment(tier)}`;
}

/** The hosted HTTPS form. Same fragment; only the base differs. */
function mockBrowserInvite(tier: InviteTierV3): string {
  return `${MOCK_BROWSER_REVIEW_BASE}/${MOCK_ROOM_ID}${mockInviteFragment(tier)}`;
}

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

function mockEventMeta(eventId: EventId, snapshotId?: SnapshotId): EventMeta {
  return {
    v: 2,
    eventId,
    roomId: MOCK_ROOM_ID,
    authorId: MOCK_AUTHOR_ID,
    deviceId: MOCK_DEVICE_ID,
    createdAt: Date.now(),
    parentEventIds: [],
    // The snapshot the event was authored against. This used to be the fixed
    // `MOCK_SNAPSHOT_ID` unconditionally, which was harmless only while no real
    // snapshot existed; now that shares publish per-file snapshots
    // (attn-64iy.1), naming an id that was never published would leave every
    // event pointing at a snapshot nothing can look up. Callers pass the id
    // their anchor actually targets; the constant is the last resort for
    // synthetic events with no anchor of their own.
    snapshotId: snapshotId ?? MOCK_SNAPSHOT_ID,
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

function mockReviewEvent(
  body: ReviewEventBody,
  eventId: EventId,
  snapshotId?: SnapshotId,
): ReviewEvent {
  return {
    meta: mockEventMeta(eventId, snapshotId),
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

function emitShareReady(payload: ReviewShareReady): void {
  // Optional on the bridge interface, unlike `reviewStatus`/`reviewEvent`.
  window.__attn__?.reviewShareReady?.(payload);
}

function emitSnapshot(snapshot: ReviewSnapshot): void {
  window.__attn__?.reviewSnapshot(snapshot);
}

function emitAnchorResolution(update: ReviewAnchorResolutionUpdate): void {
  window.__attn__?.reviewAnchorResolution(update);
}

/** First share mints; re-sharing is idempotent, as it is against the daemon. */
let mockRoomMinted = false;

function handleReviewShare(msg: Extract<IpcMessage, { type: 'review_share' }>): void {
  // Real flow: Rust ReviewManager (attn-nnj.2.8) mints a room, derives keys,
  // and reports back live/direct connection status.
  //
  // ShareReady is the half that used to be missing (attn-bw2h.6). Emitting the
  // status alone left the sheet with no invite URL to render, so it pended for
  // its full 15s deadline and then reported a failure — on every share, in
  // every browser tab, with no way to reach the ready state at all. ShareReady
  // goes FIRST because it is what carries the room: the daemon's own ordering,
  // and it means the ReviewBar and the dialog agree on the room id before any
  // connection state arrives.
  const newlyCreated = !mockRoomMinted;
  mockRoomMinted = true;
  const shareReady: ReviewShareReady = {
    kind: 'share_ready',
    roomId: MOCK_ROOM_ID,
    inviteUrl: mockNativeInvite('comment'),
    browserInviteUrl: mockBrowserInvite('comment'),
    viewInviteUrl: mockNativeInvite('view'),
    suggestInviteUrl: mockNativeInvite('suggest'),
    browserViewInviteUrl: mockBrowserInvite('view'),
    browserSuggestInviteUrl: mockBrowserInvite('suggest'),
    // The path the owner shared — the dialog matches this against its target
    // to recognise its own room, so a share rooted at a folder must report the
    // folder, not the focused file.
    ownerDisplayPath: msg.path || msg.primaryPath || '',
    ownerSigningKey: MOCK_OWNER_SIGNING_KEY,
    mode: msg.mode,
    expiresAt: mockPolicy(msg.mode).expiresAt,
    newlyCreated,
  };
  setTimeout(() => {
    emitShareReady(shareReady);
    emitStatus(mockStatus(msg.mode));
    // Snapshots come AFTER the room, for the same reason ShareReady precedes
    // status: a snapshot is scoped to a room and the store drops one that
    // arrives for a room it has never heard of.
    void publishMockSnapshots(msg);
  }, 200);
}

/**
 * Fallback content for a share of something the session store does not hold.
 *
 * With no files picked, the browser loop still renders `SAMPLE_MARKDOWN` from
 * the mock init payload, and sharing that document should snapshot what is on
 * screen. Anything else is unshareable — returning `null` publishes nothing for
 * it, which is honest, rather than a snapshot of "" that would read as the
 * user's file having been emptied.
 */
function currentMockMarkdown(path: string): string | null {
  if (hasLocalFiles()) return null;
  return path ? SAMPLE_MARKDOWN : null;
}

/**
 * Publish one snapshot per shared markdown file — the half of the mock share
 * that was missing (attn-64iy.1).
 *
 * WHY THIS EXISTS. `handleReviewShare` used to emit ShareReady and a status and
 * stop. With no snapshot, `reviewStore.snapshots` stayed empty, so
 * `ownerFileIdForPath` in App.svelte could never resolve the open document to a
 * FileId, so `currentFileId` was pinned at null, so
 * `resolveActiveSnapshotForCompose` returned null and `openCommentComposer`
 * returned silently. The user-visible symptom was the whole reason this issue
 * exists: "I highlight text but nothing appears."
 *
 * WHY THE CONTENT AND INDEX ARE REAL. Everything else in this file is
 * deliberately fake — signatures, keys, ids. A snapshot cannot be. The anchor
 * resolver maps an anchor's authored `baseHash` onto the document actually on
 * screen, so a snapshot holding invented text (or a hand-rolled index) yields
 * comments that resolve nowhere and margin cards with no position. So the bytes
 * come from the session store the user picked from, the hash is the same
 * `contentHash` the hosted publisher uses, and the index is built by
 * `buildCanonicalAnchorIndex` — the identical Rust/comrak indexer the real
 * browser publisher calls, not a JS approximation of it.
 */
async function publishMockSnapshots(
  msg: Extract<IpcMessage, { type: 'review_share' }>,
): Promise<void> {
  const createdAt = Date.now();
  for (const path of sharedMarkdownPaths(msg, localShareableFiles())) {
    try {
      // A path the store does not hold is not shareable — better to publish
      // nothing for it than a snapshot of an empty document, which would look
      // like the user's file had been wiped.
      const markdown = (await localMarkdown(path)) ?? currentMockMarkdown(path);
      if (markdown === null) continue;

      const bytes = new TextEncoder().encode(markdown);
      const baseHash = contentHash(bytes);
      const fileId = mockFileIdFor(path);
      const snapshotId = mockSnapshotIdFor(fileId, baseHash);
      const anchorIndex = await buildCanonicalAnchorIndex(bytes, snapshotId);

      emitSnapshot({
        roomId: MOCK_ROOM_ID,
        fileId,
        snapshotId,
        // The store matches this against the open document's path to resolve a
        // FileId (`ownerFileIdForPath`), so it has to be the path as the app
        // knows it — not a basename, not a relative form.
        ownerDisplayPath: path,
        createdAt,
        createdBy: MOCK_AUTHOR_ID,
        baseHash,
        byteLength: bytes.byteLength,
        docType: 'markdown',
        content: markdown,
        anchorIndex,
      });
    } catch (err) {
      // A failed index build must not take the whole share down with it: the
      // other files are still publishable, and a silent total failure here is
      // exactly the class of bug this issue is fixing.
      console.error('[attn] mock snapshot failed for', path, err);
    }
  }
}

function handleReviewJoin(_msg: Extract<IpcMessage, { type: 'review_join' }>): void {
  // Real flow: parse invite, run admission handshake (attn-nnj.5.2), import
  // mailbox snapshot. Mock just acks with a default live status to confirm
  // the inbound command was accepted.
  setTimeout(() => {
    emitStatus(mockStatus('live'));
  }, 200);
}

function handleReviewStop(msg: Extract<IpcMessage, { type: 'review_stop' }>): void {
  // Stopping drops the room, so the next share mints a new one.
  mockRoomMinted = false;
  setTimeout(() => {
    emitStatus({
      roomId: msg.roomId ?? MOCK_ROOM_ID,
      status: 'Stopped',
      mode: 'live',
      connection: 'offline',
      peers: [],
      outboxPending: 0,
    });
  }, 50);
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

/**
 * Browser stand-in for the daemon's shareable-file scan. Keep it in step with
 * the Rust side: `IpcMessage::ReviewListShareableFiles` (src/ipc.rs) →
 * `files::list_shareable_files` → the `shareableFiles` payload pushed through
 * `updateContent` (src/main.rs). Same message, same reply shape, same channel.
 *
 * Without this the share picker never finishes loading. `App.svelte` sets
 * `shareableFilesLoading = true` and clears it only on this reply, so an
 * uploaded folder left the file list spinning forever and nothing could be
 * selected or shared (attn-vlmz.1.1).
 *
 * The daemon walks the filesystem below `rootPath`; the session store is all
 * the filesystem there is here, so we filter it to the requested root the way
 * a scan rooted there would have.
 */
function handleReviewListShareableFiles(
  msg: Extract<IpcMessage, { type: 'review_list_shareable_files' }>,
): void {
  const items = localShareableFiles().filter((item) => pathWithinRoot(item.path, msg.rootPath));
  // Answer asynchronously like every other mock reply: the app must round-trip
  // through its loading state, not skip it.
  setTimeout(() => {
    window.__attn__?.updateContent({ shareableFiles: { rootPath: msg.rootPath, items } });
  }, 50);
}

function handleReviewCreateComment(
  msg: Extract<IpcMessage, { type: 'review_create_comment' }>,
): void {
  const eventId = mockEventId('comment');
  // The anchor already names the snapshot it was authored against — echo that
  // rather than a constant, so the event and its anchor agree (attn-64iy.1).
  const event = mockReviewEvent(
    commentBody(msg.anchor, msg.body, eventId),
    eventId,
    msg.anchor.snapshotId,
  );
  setTimeout(() => emitEvent(event), 50);
}

function handleReviewCreateSuggestion(
  msg: Extract<IpcMessage, { type: 'review_create_suggestion' }>,
): void {
  const suggestionId = mockEventId('suggestion');
  const event = mockReviewEvent(
    suggestionCreatedBody(msg.draft, suggestionId),
    suggestionId,
    msg.draft.anchor.snapshotId,
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
    // `ReviewResolveAnchorMessage` carries no fileId, so there is nothing here
    // to derive a real one from. Inert in practice: `applyAnchorResolution`
    // keys resolutions by `eventId` alone and never reads this field. Left as
    // the constant rather than guessed at — a plausible-looking wrong id would
    // be worse than an obviously synthetic one.
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
    case 'review_stop':
      handleReviewStop(msg);
      return;
    case 'review_list_shareable_files':
      handleReviewListShareableFiles(msg);
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
    case 'share_ready':
      emitShareReady(payload as ReviewShareReady);
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

// ---------------------------------------------------------------------------
// Scripted scenario loader / player (attn-nnj.4.1)
//
// Scenarios live under `web/src/lib/mock-ipc-scenarios/*.json` and are
// resolved at build time via Vite's `import.meta.glob`. Each scenario is an
// ordered list of `{ kind, payload, delayMs }` steps which we replay
// sequentially into the bridge using the same `emit*` helpers that back
// `__mockEmitReview`.
//
// The player is intentionally tolerant: it does not validate payload shapes
// (consumers re-validate) and it swallows unknown kinds rather than
// throwing, so a partially-typo'd scenario still drives whatever steps it
// got right. Hard errors (bad `version`, missing file) still surface so
// authoring mistakes are obvious.
// ---------------------------------------------------------------------------

// Static scenario imports. We previously used `import.meta.glob` here, but
// `vite-plugin-singlefile` does not inline glob-imported JSON in the
// production bundle (the JSON files end up as dynamic chunks that singlefile
// drops). Static `import` statements are inlined deterministically by Vite,
// so the daemon webview always sees the same scenario list as the dev
// browser. Add a new entry here whenever you add a JSON under
// `./mock-ipc-scenarios/`.
import scenarioAmbiguousAnchor from './mock-ipc-scenarios/ambiguous-anchor.json';
import scenarioCommentSurvivesEdit from './mock-ipc-scenarios/comment-survives-edit.json';
import scenarioStaleSuggestion from './mock-ipc-scenarios/stale-suggestion.json';
import scenarioThreeWayDrift from './mock-ipc-scenarios/three-way-drift.json';

type ScenarioModule = { default: MockScenario };
type ScenarioGlobMap = Record<string, () => Promise<ScenarioModule>>;
type ScenarioEagerGlobMap = Record<string, ScenarioModule>;

interface ImportMetaWithGlob {
  glob?: (
    pattern: string,
    opts?: { eager?: boolean },
  ) => Record<string, unknown>;
}

/**
 * Static fallback used when `import.meta.glob` is not available (tsx
 * harness) AND when the production singlefile bundle drops glob-loaded
 * JSON. Mirrors the four JSONs under `./mock-ipc-scenarios/`.
 */
function staticScenarioLoaders(): ScenarioGlobMap {
  // The JSON imports above are typed by Vite as `any` at the boundary;
  // we cast through `MockScenario` so consumers see a typed shape.
  const fixed: Array<[string, unknown]> = [
    ['./mock-ipc-scenarios/ambiguous-anchor.json', scenarioAmbiguousAnchor],
    ['./mock-ipc-scenarios/comment-survives-edit.json', scenarioCommentSurvivesEdit],
    ['./mock-ipc-scenarios/stale-suggestion.json', scenarioStaleSuggestion],
    ['./mock-ipc-scenarios/three-way-drift.json', scenarioThreeWayDrift],
  ];
  const out: ScenarioGlobMap = {};
  for (const [path, mod] of fixed) {
    const m = mod as MockScenario;
    out[path] = () => Promise.resolve({ default: m });
  }
  return out;
}

// Vite injects `import.meta.glob` at build time. Under raw tsx (manual test
// harness) it is undefined; under singlefile builds it returns an empty
// map. We use the static loader either way so production and dev paths
// stay aligned. The `import.meta.glob` probe is kept so the no-op branch
// remains under coverage for the comment above.
function discoverScenarioLoaders(): ScenarioGlobMap {
  void (import.meta as unknown as ImportMetaWithGlob).glob;
  return staticScenarioLoaders();
}

const scenarioLoaders: ScenarioGlobMap = discoverScenarioLoaders();

/**
 * Short-name → loader map. Short names strip the directory prefix and
 * `.json` suffix so callers say `'comment-survives-edit'`, not the full
 * relative path.
 */
const scenarioIndex: Map<string, () => Promise<ScenarioModule>> = (() => {
  const m = new Map<string, () => Promise<ScenarioModule>>();
  for (const path of Object.keys(scenarioLoaders)) {
    const filename = path.split('/').pop() ?? path;
    const name = filename.replace(/\.json$/, '');
    const loader = scenarioLoaders[path];
    if (loader) m.set(name, loader);
  }
  return m;
})();

/**
 * Test-only escape hatch for environments without Vite's `import.meta.glob`
 * (raw tsx harnesses). Production code paths use the glob result and never
 * touch this. Re-registering an existing name overwrites the previous
 * loader so a test can swap fixtures cheaply.
 */
export function __registerScenarioForTesting(
  name: string,
  scenario: MockScenario,
): void {
  scenarioIndex.set(name, () => Promise.resolve({ default: scenario }));
}

/**
 * Resolve a scenario JSON file by short name (e.g. `'comment-survives-edit'`).
 * Throws when the name is unknown or the loaded JSON fails the basic
 * `version === 1` + `Array.isArray(steps)` shape check.
 */
export async function loadScenario(name: string): Promise<MockScenario> {
  const loader = scenarioIndex.get(name);
  if (!loader) {
    const known = Array.from(scenarioIndex.keys()).join(', ') || '<none>';
    throw new Error(`mock-ipc: unknown scenario '${name}' (known: ${known})`);
  }
  const mod = await loader();
  const scenario = mod.default;
  if (!scenario || scenario.version !== 1) {
    throw new Error(
      `mock-ipc: scenario '${name}' has unsupported version (expected 1)`,
    );
  }
  if (!Array.isArray(scenario.steps)) {
    throw new Error(`mock-ipc: scenario '${name}' is missing .steps[]`);
  }
  return scenario;
}

/** List of bundled scenarios. Stable order based on filesystem glob result. */
export function listScenarios(): string[] {
  return Array.from(scenarioIndex.keys()).sort();
}

function applyStep(step: MockScenarioStep): void {
  // Unknown kinds are tolerated (logged) rather than thrown so a partial
  // scenario still fires its valid steps.
  switch (step.kind) {
    case 'status':
    case 'event':
    case 'snapshot':
    case 'anchor_resolution':
      emitMockReview(step.kind, step.payload);
      return;
    default:
      console.warn('[attn] mock scenario: unknown step kind', step);
      return;
  }
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load `name` and fire its steps in order against the bridge. Sequential —
 * each step waits for its `delayMs` (scaled by `opts.speed`) before firing,
 * so consumers see callbacks in the same order they were authored.
 *
 * Returns the loaded `MockScenario` once playback completes. Errors during
 * loading propagate; errors inside a single step are caught + logged so
 * playback continues (the goal is "make Phase 2 features testable", not
 * "be a strict validator").
 */
export async function playScenario(
  name: string,
  opts: PlayScenarioOptions = {},
): Promise<MockScenario> {
  const scenario = await loadScenario(name);
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const fallbackDelay = scenario.defaultDelayMs ?? 0;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    const rawDelay = step.delayMs ?? fallbackDelay;
    const scaledDelay = speed === Infinity ? 0 : Math.max(0, rawDelay / speed);
    await wait(scaledDelay);
    try {
      applyStep(step);
    } catch (err) {
      console.error('[attn] mock scenario step failed', { step, err });
    }
    opts.onStep?.(step, i);
  }
  return scenario;
}

/** Build the public scenario API attached to `window.__attnMockScenario`. */
function buildScenarioApi(): MockScenarioApi {
  return {
    available: listScenarios(),
    load: loadScenario,
    play: playScenario,
  };
}

/**
 * Always-on E2E helpers. Installs the `__mockEmitReview` and
 * `__attnMockScenario` hooks on `window` even when the real wry IPC is
 * present, so the daemon's `--eval` channel can drive scripted review
 * scenarios in builds that talk to the real ReviewManager too. These hooks
 * only mutate `window.__attn__.review*` (the bridge surface) — they never
 * touch `window.ipc` or override the real ReviewManager, so they are safe
 * to leave installed alongside production code paths.
 *
 * Lives outside `installMockIpc` (which early-returns under wry) because
 * `scripts/test-review-e2e.sh` (attn-nnj.4.14) needs the scenario API
 * available even when the daemon is the host. Tracking note: the helpers
 * are debug-only via `debug_assertions` on the Rust side — release builds
 * strip `--eval`, so this is not a release-surface concern.
 *
 * @see planning/collab/data-model.md §Webview IPC Changes
 */
export function installScenarioBridge(): void {
  if (!window.__mockEmitReview) {
    window.__mockEmitReview = __mockEmitReview;
  }
  if (!window.__attnMockScenario) {
    window.__attnMockScenario = buildScenarioApi();
  }
}

export function installMockIpc(): void {
  // Even under wry we still want the scripted-scenario API + bridge helper
  // available so the daemon E2E suite can drive review surfaces via --eval.
  installScenarioBridge();

  // Only install the mock `window.ipc` shim and the dev-mode init payload
  // when the real wry IPC is absent (raw browser dev loop).
  if (window.ipc) return;

  console.log('[attn] Dev mode: installing mock IPC');
  window.__attnMockIpc = true;

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
        return;
      }
      // Sidebar clicks and tab switches send `navigate`; with no daemon to
      // answer, the app would swap the tab and then sit on stale content.
      // Serve it out of whatever the user picked or dropped this session.
      if (parsed.type === 'navigate') {
        void deliverLocalPath(parsed.path);
      }
    },
  };

  // Expose the E2E helpers (also installed unconditionally by
  // `installScenarioBridge` above; re-call here is a no-op since the
  // helpers already check for prior installation).
  installScenarioBridge();
}
