import { createFrameInvalidator } from './frame-invalidator';

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
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function fakeFrames() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    request(callback: FrameRequestCallback): number {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle: number): void {
      callbacks.delete(handle);
    },
    flushOne(): void {
      const first = callbacks.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!first) return;
      callbacks.delete(first[0]);
      first[1](0);
    },
    get pending(): number {
      return callbacks.size;
    },
  };
}

defineCase('coalesces a file-switch burst into one later invalidation', () => {
  const frames = fakeFrames();
  let invalidations = 0;
  const invalidator = createFrameInvalidator(
    () => { invalidations += 1; },
    frames.request,
    frames.cancel,
  );

  for (let index = 0; index < 2_000; index += 1) invalidator.request();

  assert(invalidations === 0, 'invalidation must not run inside the requesting flush');
  assert(frames.pending === 1, `expected one queued frame, got ${frames.pending}`);
  frames.flushOne();
  assert(invalidations === 1, `expected one invalidation, got ${invalidations}`);
});

defineCase('an invalidation can request the next frame without synchronous recursion', () => {
  const frames = fakeFrames();
  let invalidations = 0;
  let invalidator: ReturnType<typeof createFrameInvalidator>;
  invalidator = createFrameInvalidator(
    () => {
      invalidations += 1;
      if (invalidations < 3) invalidator.request();
    },
    frames.request,
    frames.cancel,
  );

  invalidator.request();
  frames.flushOne();
  assert(invalidations === 1, 'the next request must remain queued for another frame');
  assert(frames.pending === 1, 'expected a second frame after the first invalidation');
  frames.flushOne();
  frames.flushOne();
  assert(invalidations === 3, `expected three frame-separated invalidations, got ${invalidations}`);
});

defineCase('cancel drops a queued invalidation during component teardown', () => {
  const frames = fakeFrames();
  let invalidations = 0;
  const invalidator = createFrameInvalidator(
    () => { invalidations += 1; },
    frames.request,
    frames.cancel,
  );

  invalidator.request();
  invalidator.cancel();
  frames.flushOne();
  assert(invalidations === 0, 'cancelled invalidation must not run');
});

let failed = 0;
for (const run of cases) {
  const result = run();
  if (result.ok) {
    console.log(`  ok  ${result.name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${result.name}: ${result.detail}`);
  }
}

if (failed > 0) process.exitCode = 1;
