// The reload policy behind a chunk that never arrived (attn-ze60.1).
//
//   cd web && npx tsx src/hosted/app/chunk-reload.test.ts
//
// The dangerous half of "reload when the editor's code is missing" is the
// second reload. A page that reloads on every failure and fails on every load
// is a loop the person cannot escape, because the loop starts before anything
// they can click has rendered. These cases pin the ceiling — one per tab — and
// the two ways storage can be unavailable, both of which must resolve to "do
// not reload" rather than "reload freely".

import {
  CHUNK_RELOAD_KEY,
  clearChunkReload,
  takeChunkReload,
  type ReloadMemory,
} from './chunk-reload';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void): void {
  cases.push(() => {
    try {
      fn();
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function memory(): ReloadMemory {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** Private browsing and blocked site data: every access throws. */
const throwingMemory: ReloadMemory = {
  getItem: () => {
    throw new Error('site data blocked');
  },
  setItem: () => {
    throw new Error('site data blocked');
  },
  removeItem: () => {
    throw new Error('site data blocked');
  },
};

/** A rarer shape: readable, but out of quota, so the attempt goes unrecorded. */
const readOnlyMemory: ReloadMemory = {
  getItem: () => null,
  setItem: () => {
    throw new Error('quota exceeded');
  },
  removeItem: () => undefined,
};

defineCase('the first failure gets a reload', () => {
  assert(takeChunkReload(memory()), 'the first attempt is granted');
});

defineCase('the second failure does not — the loop stops at one', () => {
  const store = memory();
  assert(takeChunkReload(store), 'first');
  assert(!takeChunkReload(store), 'second is refused');
  assert(!takeChunkReload(store), 'and stays refused');
});

defineCase('a chunk that arrives gives the tab its reload back', () => {
  const store = memory();
  assert(takeChunkReload(store), 'first');
  clearChunkReload(store);
  assert(
    takeChunkReload(store),
    'an unrelated failure later in the same tab is not the same failure',
  );
});

defineCase('no storage means no reload, never a free one', () => {
  // Nowhere to record the attempt is exactly the case where reloading loops.
  assert(!takeChunkReload(null), 'absent storage refuses');
  assert(!takeChunkReload(throwingMemory), 'throwing storage refuses');
  assert(!takeChunkReload(readOnlyMemory), 'unwritable storage refuses');
});

defineCase('clearing never throws, whatever the storage does', () => {
  clearChunkReload(null);
  clearChunkReload(throwingMemory);
});

defineCase('the key is namespaced to attn', () => {
  // sessionStorage is shared with anything else on the origin.
  assert(CHUNK_RELOAD_KEY.startsWith('attn:'), `unnamespaced key: ${CHUNK_RELOAD_KEY}`);
});

function runAllCases(): void {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}`);
    } else {
      failures.push(result.name);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`chunk-reload: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

runAllCases();
