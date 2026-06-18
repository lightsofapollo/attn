// Manual harness for the scripted mock-IPC scenario player
// (planning issue attn-nnj.4.1). Pattern mirrors `review/store.test.ts` —
// no test framework yet (`web/` does not configure vitest).
//
// Run with:
//
//   cd web && npx tsx src/lib/mock-ipc-scenarios.test.ts
//
// Why tsx and not Vite: this harness exercises the same bridge surface
// (`window.__attn__.review*`) that the App.svelte wiring drives in
// production. We bypass `import.meta.glob` (Vite-only) by reading the
// scenario JSON files from disk and registering them with the scenario
// index via `__registerScenarioForTesting`. The player code path itself
// is unchanged.
//
// IMPORTANT: this test must not import `store.svelte.ts` directly — that
// module uses Svelte 5 runes (`$state`) which only compile inside the
// Vite + svelte plugin pipeline. We use a tiny stub store that mirrors
// the one-line `apply*` contracts from `store.svelte.ts`.

// Node built-ins are accessed via dynamic import + narrow structural shapes
// because `web/` does not include `@types/node` in its tsconfig (matches the
// `globalThis.process` dodge in `review/resolver.test.ts`). Real production
// code paths in this folder never touch fs — this is harness-only wiring.

import {
  __registerScenarioForTesting,
  installMockIpc,
  loadScenario,
  playScenario,
  type MockScenario,
} from './mock-ipc';
import type {
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ReviewSnapshot,
  ReviewStatus,
  SuggestionCreatedBody,
} from './types';

// ---------------------------------------------------------------------------
// Tiny harness (matches resolver.test.ts / store.test.ts conventions)
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void | string> | void | string): void {
  cases.push(async () => {
    try {
      const note = await fn();
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
// Stub review store. The real store (store.svelte.ts) is one-line
// passthroughs into `$state` records — exercising the bridge with these
// stubs covers the same `mock-ipc → bridge → apply*` wire path that
// production uses.
// ---------------------------------------------------------------------------

interface StubReviewStore {
  status: ReviewStatus | null;
  events: ReviewEvent[];
  snapshots: ReviewSnapshot[];
  anchorResolutions: Record<string, ReviewAnchorResolutionUpdate>;
}

function makeStubStore(): StubReviewStore {
  return {
    status: null,
    events: [],
    snapshots: [],
    anchorResolutions: {},
  };
}

// ---------------------------------------------------------------------------
// Minimal DOM stub so mock-ipc can attach its window hooks. tsx/node give
// us nothing webby out of the box.
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
  __attnMockScenario?: {
    available: readonly string[];
    load: (name: string) => Promise<MockScenario>;
    play: (name: string, opts?: { speed?: number }) => Promise<MockScenario>;
  };
  ipc?: { postMessage: (m: string) => void };
}

const fakeWindow = globalThis as unknown as { window?: FakeWindow } & FakeWindow;
if (!fakeWindow.window) {
  fakeWindow.window = fakeWindow as FakeWindow;
}

const stubStore = makeStubStore();

fakeWindow.__attn__ = {
  setContent: () => {},
  updateContent: () => {},
  reviewStatus: (payload: ReviewStatus) => {
    stubStore.status = payload;
  },
  reviewEvent: (payload: ReviewEvent) => {
    stubStore.events.push(payload);
  },
  reviewSnapshot: (payload: ReviewSnapshot) => {
    stubStore.snapshots.push(payload);
  },
  reviewAnchorResolution: (payload: ReviewAnchorResolutionUpdate) => {
    stubStore.anchorResolutions[payload.eventId] = payload;
  },
};

installMockIpc();

assert(
  typeof fakeWindow.__attnMockScenario === 'object',
  'installMockIpc must expose window.__attnMockScenario',
);

// ---------------------------------------------------------------------------
// Bridge the on-disk JSON scenarios into the scenario index. Production
// uses `import.meta.glob` (Vite); tsx does not provide it, so we read +
// register here. This still exercises `loadScenario` and `playScenario`
// against the same JSON the daemon would load.
// ---------------------------------------------------------------------------

interface NodeFs {
  readFileSync: (path: string, encoding: string) => string;
}
interface NodePath {
  dirname: (p: string) => string;
  resolve: (...parts: string[]) => string;
}
interface NodeUrl {
  fileURLToPath: (url: string) => string;
}

// node:* import resolves at runtime via Node's ESM loader; types narrowed via `as unknown as`
const fs = (await import('node:fs')) as unknown as NodeFs;
const path = (await import('node:path')) as unknown as NodePath;
const url = (await import('node:url')) as unknown as NodeUrl;

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCENARIO_DIR = path.resolve(__dirname, './mock-ipc-scenarios');

function readScenario(name: string): MockScenario {
  const raw = fs.readFileSync(path.resolve(SCENARIO_DIR, `${name}.json`), 'utf8');
  return JSON.parse(raw) as MockScenario;
}

const SCENARIO_NAMES = [
  'comment-survives-edit',
  'ambiguous-anchor',
  'stale-suggestion',
  'three-way-drift',
] as const;

for (const name of SCENARIO_NAMES) {
  __registerScenarioForTesting(name, readScenario(name));
}

function resetStore(): void {
  stubStore.status = null;
  stubStore.events = [];
  stubStore.snapshots = [];
  stubStore.anchorResolutions = {};
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

defineCase('loadScenario resolves all four bundled scenarios', async () => {
  for (const name of SCENARIO_NAMES) {
    const scenario = await loadScenario(name);
    assert(scenario.version === 1, `expected version=1 for ${name}`);
    assert(scenario.name === name, `expected scenario.name=${name}, got ${scenario.name}`);
    assert(
      Array.isArray(scenario.steps) && scenario.steps.length > 0,
      `expected ${name} to have at least one step`,
    );
  }
  return `${SCENARIO_NAMES.length} scenarios loaded`;
});

defineCase('comment-survives-edit drives status/snapshot/event/resolution', async () => {
  resetStore();
  await playScenario('comment-survives-edit', { speed: Infinity });

  assert(stubStore.status !== null, 'expected status payload to have fired');
  assert(
    stubStore.status?.roomId === 'scenario-room-1',
    `expected roomId=scenario-room-1, got ${stubStore.status?.roomId}`,
  );
  assert(
    stubStore.snapshots.length === 2,
    `expected 2 snapshots (initial + post-edit), got ${stubStore.snapshots.length}`,
  );
  assert(
    stubStore.events.length === 1,
    `expected 1 comment_created event, got ${stubStore.events.length}`,
  );
  const event = stubStore.events[0]!;
  assert(
    event.body.type === 'comment_created',
    `expected comment_created body, got ${event.body.type}`,
  );

  const resolved = stubStore.anchorResolutions['evt-comment-1'];
  assert(resolved !== undefined, 'expected anchor resolution for evt-comment-1');
  assert(
    resolved.resolved.status === 'remapped',
    `expected remapped resolution, got ${resolved.resolved.status}`,
  );
  if (resolved.resolved.status === 'remapped') {
    assert(
      resolved.resolved.reason === 'quote_match',
      `expected reason=quote_match, got ${resolved.resolved.reason}`,
    );
  }
});

defineCase('ambiguous-anchor emits a resolution with multiple candidates', async () => {
  resetStore();
  await playScenario('ambiguous-anchor', { speed: Infinity });

  const resolved = stubStore.anchorResolutions['evt-comment-amb-1'];
  assert(resolved !== undefined, 'expected anchor resolution for evt-comment-amb-1');
  assert(
    resolved.resolved.status === 'ambiguous',
    `expected ambiguous status, got ${resolved.resolved.status}`,
  );
  if (resolved.resolved.status === 'ambiguous') {
    assert(
      resolved.resolved.candidates.length >= 2,
      `expected >=2 candidates, got ${resolved.resolved.candidates.length}`,
    );
    const firstReason = resolved.resolved.candidates[0]?.reason;
    assert(
      firstReason === 'quote_match',
      `expected first candidate reason=quote_match, got ${firstReason}`,
    );
  }
});

defineCase('stale-suggestion emits resolution with status=stale', async () => {
  resetStore();
  await playScenario('stale-suggestion', { speed: Infinity });

  const resolved = stubStore.anchorResolutions['evt-suggestion-stale-1'];
  assert(resolved !== undefined, 'expected anchor resolution for evt-suggestion-stale-1');
  assert(
    resolved.resolved.status === 'stale',
    `expected stale status, got ${resolved.resolved.status}`,
  );
  // The suggestion_created event should still have been delivered ahead of
  // the snapshot that deleted its target — order matters for the UI.
  const suggestionEvent = stubStore.events.find(
    (e) => e.body.type === 'suggestion_created',
  );
  assert(suggestionEvent !== undefined, 'expected suggestion_created event to have fired');
});

defineCase('three-way-drift fires a suggestion whose expectedText drifts vs the current snapshot', async () => {
  resetStore();
  await playScenario('three-way-drift', { speed: Infinity });

  const suggestionEvent = stubStore.events.find(
    (e): e is ReviewEvent & { body: SuggestionCreatedBody } =>
      e.body.type === 'suggestion_created',
  );
  assert(suggestionEvent !== undefined, 'expected suggestion_created event');
  const op = suggestionEvent.body.operation;
  assert(
    op.kind === 'replace',
    `expected replace operation, got ${op.kind}`,
  );

  const latestSnapshot = stubStore.snapshots[stubStore.snapshots.length - 1];
  assert(latestSnapshot !== undefined, 'expected a current snapshot');
  const currentMarkdown = latestSnapshot.content ?? '';

  if (op.kind === 'replace') {
    assert(
      !currentMarkdown.includes(op.expectedText),
      `expected drift — operation.expectedText should NOT appear in current snapshot. expected=${op.expectedText}`,
    );
  }

  // Anchor still remaps (status=remapped) so the suggestion's anchor can
  // be shown in the right rail — drift is detected at *accept* time via
  // the operation.expectedText mismatch above.
  const resolved = stubStore.anchorResolutions['evt-suggestion-drift-1'];
  assert(resolved !== undefined, 'expected anchor resolution for evt-suggestion-drift-1');
  assert(
    resolved.resolved.status === 'remapped',
    `expected remapped status, got ${resolved.resolved.status}`,
  );
});

defineCase('window.__attnMockScenario.play() drives the bridge end-to-end', async () => {
  resetStore();
  const api = fakeWindow.__attnMockScenario;
  assert(api !== undefined, 'expected window.__attnMockScenario to be installed');
  await api.play('comment-survives-edit', { speed: Infinity });
  assert(
    stubStore.snapshots.length === 2 && stubStore.events.length === 1,
    `expected 2 snapshots + 1 event via window.__attnMockScenario, got ${stubStore.snapshots.length}/${stubStore.events.length}`,
  );
});

defineCase('loadScenario rejects unknown names with a helpful error', async () => {
  let threw = false;
  let message = '';
  try {
    await loadScenario('does-not-exist');
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  assert(threw, 'expected loadScenario to throw on unknown name');
  assert(
    message.includes('does-not-exist'),
    `expected error message to mention the unknown name, got: ${message}`,
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

async function runAllCases(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
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

void runAllCases();
