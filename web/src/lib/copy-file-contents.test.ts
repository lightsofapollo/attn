// The "Copy file contents" header button state machine.
//
// Run with:
//
//   cd web && npx tsx src/lib/copy-file-contents.test.ts

import {
  COPY_FILE_COPIED_TITLE,
  COPY_FILE_IDLE_TITLE,
  COPY_FILE_RESET_MS,
  copyFileTitle,
  createCopyFileController,
  type CopyFileState,
} from './copy-file-contents';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => void | Promise<void>): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** A hand-cranked clock: timers fire only when the test says so. */
function fakeClock() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = next++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.fn();
      }
    },
    pendingCount: (): number => pending.size,
    scheduledDelays: (): number[] => [...pending.values()].map((t) => t.at - now),
  };
}

function harness(opts: {
  source: () => Promise<string> | string;
  write?: (text: string) => Promise<void>;
}) {
  const clock = fakeClock();
  const states: CopyFileState[] = [];
  const written: string[] = [];
  const controller = createCopyFileController({
    source: opts.source,
    write: opts.write ?? (async (text) => { written.push(text); }),
    onChange: (state) => states.push(state),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, states, written, controller };
}

defineCase('success writes the source text and reports copied', async () => {
  const h = harness({ source: async () => '# Hello\n' });
  const result = await h.controller.copy();
  assert(result.kind === 'copied', `expected copied, got ${result.kind}`);
  assert(h.written.length === 1 && h.written[0] === '# Hello\n', 'clipboard must receive the exact text');
  assert(h.states.length === 1 && h.states[0]!.kind === 'copied', 'onChange must see the copied state');
});

defineCase('copied resets to idle after 1500 ms, not before', async () => {
  const h = harness({ source: () => 'text' });
  await h.controller.copy();
  const delays = h.clock.scheduledDelays();
  assert(delays.length === 1 && delays[0] === COPY_FILE_RESET_MS, `expected one ${COPY_FILE_RESET_MS}ms timer, got ${delays.join(',')}`);
  h.clock.advance(COPY_FILE_RESET_MS - 1);
  assert(h.states.at(-1)!.kind === 'copied', 'must still read copied one tick early');
  h.clock.advance(1);
  assert(h.states.at(-1)!.kind === 'idle', 'must be idle once the window closes');
  assert(h.states.length === 2, `expected exactly copied→idle, got ${h.states.map((s) => s.kind).join('→')}`);
});

defineCase('a failing source reports the error and keeps the copy glyph', async () => {
  const h = harness({ source: async () => { throw new Error('failed to fetch file: 404'); } });
  const result = await h.controller.copy();
  assert(result.kind === 'error', `expected error, got ${result.kind}`);
  assert(result.message === 'failed to fetch file: 404', `unexpected message: ${result.message}`);
  assert(h.written.length === 0, 'nothing may reach the clipboard on a read failure');
  assert(copyFileTitle(result).includes('failed to fetch file: 404'), 'the title must carry the reason');
  h.clock.advance(COPY_FILE_RESET_MS);
  assert(h.states.at(-1)!.kind === 'idle', 'errors clear on the same timer as copied');
});

defineCase('a failing clipboard writer reports the error', async () => {
  const h = harness({
    source: () => 'text',
    write: async () => { throw new DOMException('Write permission denied', 'NotAllowedError'); },
  });
  const result = await h.controller.copy();
  assert(result.kind === 'error', `expected error, got ${result.kind}`);
  assert(result.message === 'Write permission denied', `unexpected message: ${result.message}`);
});

defineCase('a second click restarts the reset window instead of stacking timers', async () => {
  const h = harness({ source: () => 'text' });
  await h.controller.copy();
  h.clock.advance(1000);
  await h.controller.copy();
  assert(h.clock.pendingCount() === 1, 'the earlier timer must be cancelled');
  h.clock.advance(1000);
  assert(h.states.at(-1)!.kind === 'copied', 'the first timer must not fire mid-window');
  h.clock.advance(500);
  assert(h.states.at(-1)!.kind === 'idle', 'the restarted timer resets at 1500ms from the second click');
});

defineCase('a slow read that lands after a newer click does not clobber it', async () => {
  let release: (() => void) | null = null;
  let calls = 0;
  const h = harness({
    source: () => {
      calls += 1;
      if (calls === 1) return new Promise<string>((resolve) => { release = () => resolve('old'); });
      return 'new';
    },
  });
  const first = h.controller.copy();
  await h.controller.copy();
  assert(h.written.length === 1 && h.written[0] === 'new', 'the newer click wins the clipboard');
  release!();
  await first;
  assert(h.states.length === 1, `the stale click must emit no state, got ${h.states.length}`);
});

defineCase('dispose cancels a pending reset', async () => {
  const h = harness({ source: () => 'text' });
  await h.controller.copy();
  h.controller.dispose();
  assert(h.clock.pendingCount() === 0, 'dispose must clear the timer');
  h.clock.advance(COPY_FILE_RESET_MS);
  assert(h.states.length === 1, 'no state may be emitted after dispose');
});

defineCase('titles name each state in words, not colour', () => {
  assert(copyFileTitle({ kind: 'idle' }) === COPY_FILE_IDLE_TITLE, 'idle title');
  assert(copyFileTitle({ kind: 'copied' }) === COPY_FILE_COPIED_TITLE, 'copied title');
  assert(copyFileTitle({ kind: 'error', message: 'nope' }) === "Couldn't copy: nope", 'error title');
});

let failed = 0;
for (const run of cases) {
  const result = await run();
  if (result.ok) {
    console.log(`PASS ${result.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${result.name}`);
    if (result.detail) console.error(`  ${result.detail}`);
  }
}

if (failed > 0) process.exit(1);
