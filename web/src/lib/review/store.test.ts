// Manual smoke harness for the `window.__attn__.reviewAnchorResolution`
// dispatch path (issue attn-nnj.3.8). Pattern mirrors `resolver.test.ts` —
// no framework yet (`web/` has no vitest config).
//
// Run with:
//
//   cd web && npx tsx src/lib/review/store.test.ts
//
// IMPORTANT: this test cannot import `store.svelte.ts` directly — that
// module uses Svelte 5 runes (`$state`) which only compile inside the
// Vite + svelte plugin pipeline. Raw tsx evaluates them as bare identifiers
// and throws `$state is not defined`. So we exercise the same wire surface
// the App.svelte bridge uses (mock-ipc → `window.__attn__.reviewAnchorResolution`
// → user-supplied apply fn) with a tiny in-test stand-in for the store.
// The real store's `applyAnchorResolution` is one line — it just writes to
// the map — so the contract under test is "the bridge calls our handler
// with the unmodified ReviewAnchorResolutionUpdate payload".

import { installMockIpc } from '../mock-ipc';
import type {
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ReviewSnapshot,
  ReviewStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Tiny harness (matches resolver.test.ts conventions)
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// In-test stand-in for the runes-backed reviewStore. Mirrors the exact
// `applyAnchorResolution` contract from store.svelte.ts so this assertion
// would still hold if the real wiring was used.
// ---------------------------------------------------------------------------

interface StubStore {
  anchorResolutions: Record<string, ReviewAnchorResolutionUpdate>;
  applyAnchorResolution(update: ReviewAnchorResolutionUpdate): void;
}

function makeStubStore(): StubStore {
  return {
    anchorResolutions: {},
    applyAnchorResolution(update: ReviewAnchorResolutionUpdate): void {
      this.anchorResolutions = {
        ...this.anchorResolutions,
        [update.eventId]: update,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal DOM stub so mock-ipc can attach `window.__mockEmitReview` and the
// bridge can hang `window.__attn__.review*` callbacks. tsx/node give us
// nothing webby out of the box.
// ---------------------------------------------------------------------------

interface FakeWindow {
  __attn__?: {
    reviewStatus: (p: ReviewStatus) => void;
    reviewEvent: (p: ReviewEvent) => void;
    reviewSnapshot: (p: ReviewSnapshot) => void;
    reviewAnchorResolution: (p: ReviewAnchorResolutionUpdate) => void;
    setContent: (...args: unknown[]) => void;
    updateContent: (...args: unknown[]) => void;
  };
  __attn_init__?: unknown;
  __mockEmitReview?: (kind: string, payload: unknown) => void;
  ipc?: { postMessage: (m: string) => void };
}

const fakeWindow = globalThis as unknown as { window?: FakeWindow } & FakeWindow;
if (!fakeWindow.window) {
  fakeWindow.window = fakeWindow as FakeWindow;
}

const stubStore = makeStubStore();

// Install the App.svelte bridge mapping ahead of installMockIpc. App.svelte
// delegates each `review*` callback to `reviewStore.apply*` — we substitute
// the stub but call the same one-line apply method, so the assertion below
// covers the production wire path: mock-ipc → bridge → applyAnchorResolution.
fakeWindow.__attn__ = {
  setContent: () => {},
  updateContent: () => {},
  reviewStatus: () => {},
  reviewEvent: () => {},
  reviewSnapshot: () => {},
  reviewAnchorResolution: (payload: ReviewAnchorResolutionUpdate) =>
    stubStore.applyAnchorResolution(payload),
};

installMockIpc();

assert(
  typeof fakeWindow.__mockEmitReview === 'function',
  'installMockIpc must expose window.__mockEmitReview',
);

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

defineCase('applyAnchorResolution stores resolved payload per eventId', () => {
  const update: ReviewAnchorResolutionUpdate = {
    roomId: 'room-1',
    fileId: 'file-1',
    eventId: 'evt-direct',
    resolved: {
      status: 'exact',
      confidence: 1.0,
      currentRange: {
        byteRange: [0, 5],
        lineRange: [1, 1],
      },
      reason: 'base_hash_match',
    },
  };

  stubStore.applyAnchorResolution(update);

  const got = stubStore.anchorResolutions['evt-direct'];
  assert(got !== undefined, 'expected stored anchor resolution');
  assert(got.eventId === 'evt-direct', `expected eventId=evt-direct, got ${got.eventId}`);
  assert(
    got.resolved.status === 'exact',
    `expected resolved.status=exact, got ${got.resolved.status}`,
  );
});

defineCase('__mockEmitReview(anchor_resolution, …) routes through bridge → store', () => {
  // This is the path Rust will drive in production via
  // `evaluate_script("window.__attn__.reviewAnchorResolution(...)")`. The
  // mock helper just calls the same bridge function for tests.
  const update: ReviewAnchorResolutionUpdate = {
    roomId: 'room-2',
    fileId: 'file-2',
    eventId: 'evt-via-mock',
    resolved: {
      status: 'remapped',
      confidence: 0.85,
      currentRange: {
        byteRange: [10, 25],
        lineRange: [3, 4],
      },
      reason: 'quote_match',
    },
  };

  fakeWindow.__mockEmitReview!('anchor_resolution', update);

  const got = stubStore.anchorResolutions['evt-via-mock'];
  assert(got !== undefined, 'expected store to contain mock-emitted resolution');
  assert(got.roomId === 'room-2', `expected roomId=room-2, got ${got.roomId}`);
  assert(
    got.resolved.status === 'remapped',
    `expected status=remapped, got ${got.resolved.status}`,
  );
  if (got.resolved.status === 'remapped') {
    assert(
      got.resolved.reason === 'quote_match',
      `expected reason=quote_match, got ${got.resolved.reason}`,
    );
  }
});

defineCase('later resolution for same eventId replaces the earlier one', () => {
  const eventId = 'evt-replace';
  const first: ReviewAnchorResolutionUpdate = {
    roomId: 'room-3',
    fileId: 'file-3',
    eventId,
    resolved: { status: 'stale', reason: 'low_confidence' },
  };
  const second: ReviewAnchorResolutionUpdate = {
    roomId: 'room-3',
    fileId: 'file-3',
    eventId,
    resolved: {
      status: 'exact',
      confidence: 1.0,
      currentRange: { byteRange: [0, 3], lineRange: [1, 1] },
      reason: 'base_hash_match',
    },
  };

  stubStore.applyAnchorResolution(first);
  stubStore.applyAnchorResolution(second);

  const got = stubStore.anchorResolutions[eventId];
  assert(got !== undefined, 'expected stored resolution after replace');
  assert(
    got.resolved.status === 'exact',
    `expected latest write to win (status=exact), got ${got.resolved.status}`,
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// Dodge `@types/node` (web/ tsconfig doesn't include it) by reading
// `globalThis.process` through a narrow structural shape — same dodge
// `resolver.test.ts` uses.
interface NodeProcessShape {
  exit?: (code: number) => void;
}

function runAllCases(): void {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
    nodeProcess?.exit?.(1);
  }
}

runAllCases();
