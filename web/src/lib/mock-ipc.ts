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

// `import.meta.glob('./mock-ipc-scenarios/*.json', { eager: false })` returns
// a map of relative path → lazy loader. The cast threads the loader's
// dynamic-import shape through TypeScript without leaking `any` into the
// public API (lint rule: no `any` types).
type ScenarioModule = { default: MockScenario };
type ScenarioGlobMap = Record<string, () => Promise<ScenarioModule>>;

interface ImportMetaWithGlob {
  glob?: (pattern: string) => Record<string, () => Promise<ScenarioModule>>;
}

// Vite injects `import.meta.glob` at build time. Under raw tsx (manual test
// harness) it is undefined, so we fall back to an empty loader map and let
// the test inject scenarios explicitly via `__registerScenarioForTesting`.
function discoverScenarioLoaders(): ScenarioGlobMap {
  const meta = import.meta as unknown as ImportMetaWithGlob;
  if (typeof meta.glob === 'function') {
    return meta.glob('./mock-ipc-scenarios/*.json') as ScenarioGlobMap;
  }
  return {};
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

  // Expose the scripted scenario API (attn-nnj.4.1). E2E callers do:
  //   attn --eval "window.__attnMockScenario.play('comment-survives-edit')"
  // and watch the review store for the resulting events.
  window.__attnMockScenario = buildScenarioApi();
}
