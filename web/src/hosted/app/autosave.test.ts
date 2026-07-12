import { AutosaveController } from './autosave';
import type { SaveState } from './types';

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** Manual clock + scheduler so timing is fully deterministic. */
class ManualScheduler {
  time = 0;
  private tasks: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;

  schedule = (fn: () => void, ms: number): (() => void) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.push({ at: this.time + ms, fn, id });
    return () => {
      this.tasks = this.tasks.filter((task) => task.id !== id);
    };
  };

  now = (): number => this.time;

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.time = due.at;
      this.tasks = this.tasks.filter((task) => task.id !== due.id);
      due.fn();
      // Let promise chains settle between timer firings.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
  }
}

interface Harness {
  scheduler: ManualScheduler;
  states: SaveState[];
  commits: string[];
  controller: AutosaveController;
  failNext: { on: boolean };
  resolveGate?: () => void;
}

function makeHarness(options: { gated?: boolean } = {}): Harness {
  const scheduler = new ManualScheduler();
  const states: SaveState[] = [];
  const commits: string[] = [];
  const failNext = { on: false };
  const harness: Partial<Harness> = { scheduler, states, commits, failNext };
  const controller = new AutosaveController({
    debounceMs: 1_000,
    maxPendingMs: 5_000,
    schedule: scheduler.schedule,
    now: scheduler.now,
    onState: (state) => states.push(state),
    commit: async (text) => {
      if (options.gated) {
        await new Promise<void>((resolve) => {
          harness.resolveGate = resolve;
        });
      }
      if (failNext.on) {
        failNext.on = false;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      commits.push(text);
    },
  });
  harness.controller = controller;
  return harness as Harness;
}

defineCase('debounce: rapid changes collapse to one durable commit', async () => {
  const h = makeHarness();
  h.controller.noteChange('a');
  assertEqual(h.states.at(-1), 'Saving…', 'pending text is reported immediately');
  await h.scheduler.advance(400);
  h.controller.noteChange('ab');
  await h.scheduler.advance(400);
  h.controller.noteChange('abc');
  assertEqual(h.commits.length, 0, 'nothing committed during typing');
  await h.scheduler.advance(1_000);
  assertEqual(h.commits.length, 1, 'one commit');
  assertEqual(h.commits[0], 'abc', 'latest text wins');
  assertEqual(h.states.at(-1), 'Saved on this device', 'saved only after commit');
});

defineCase('bounded debounce: continuous typing still commits', async () => {
  const h = makeHarness();
  for (let step = 0; step < 12; step += 1) {
    h.controller.noteChange(`text-${step}`);
    await h.scheduler.advance(500); // always inside the 1s debounce window
  }
  assert(h.commits.length >= 1, 'maxPendingMs forces a commit under continuous typing');
});

defineCase('flush commits immediately (visibility/pagehide path)', async () => {
  const h = makeHarness();
  h.controller.noteChange('draft');
  await h.controller.flush();
  assertEqual(h.commits.length, 1, 'flush committed');
  assertEqual(h.states.at(-1), 'Saved on this device', 'state settled');
  await h.controller.flush();
  assertEqual(h.commits.length, 1, 'clean flush is a no-op');
});

defineCase('failure keeps text pending, reports attention, and retries', async () => {
  const h = makeHarness();
  h.failNext.on = true;
  h.controller.noteChange('precious');
  await h.scheduler.advance(1_000);
  assertEqual(h.commits.length, 0, 'failed commit wrote nothing');
  assertEqual(h.states.at(-1), 'Storage needs attention', 'honest failure state');
  assert(h.controller.dirty, 'text is still pending');
  await h.scheduler.advance(1_000); // automatic retry
  assertEqual(h.commits.length, 1, 'retry committed');
  assertEqual(h.commits[0], 'precious', 'no text lost');
  assertEqual(h.states.at(-1), 'Saved on this device', 'recovered');
});

defineCase('changes during an in-flight commit recommit afterwards', async () => {
  const pump = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  };
  const h = makeHarness({ gated: true });
  h.controller.noteChange('first');
  await h.scheduler.advance(1_000); // starts the gated commit
  h.controller.noteChange('second'); // arrives mid-flight
  h.resolveGate?.();
  await pump(); // commit A settles and reschedules
  await h.scheduler.advance(2_000); // fires the rescheduled commit (gated)
  h.resolveGate?.();
  await pump();
  assertEqual(h.commits.length, 2, 'both commits landed');
  assertEqual(h.commits[1], 'second', 'newest text committed last');
});

defineCase('flush waits for an in-flight commit and drains the newest text', async () => {
  const pump = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const h = makeHarness({ gated: true });
  h.controller.noteChange('first');
  await h.scheduler.advance(1_000);
  h.controller.noteChange('second');

  const flushed = h.controller.flush();
  let settled = false;
  void flushed.then(() => { settled = true; });
  await pump();
  assertEqual(settled, false, 'flush remains pending behind the first commit');

  h.resolveGate?.();
  await pump();
  assertEqual(settled, false, 'flush starts the newer commit without a debounce delay');
  h.resolveGate?.();
  assertEqual(await flushed, true, 'both durable commits completed');
  assertEqual(h.commits.length, 2, 'both revisions committed');
  assertEqual(h.commits[1], 'second', 'flush drained the newest revision');
  assertEqual(h.controller.dirty, false, 'controller is clean after the drain');
});

defineCase('flush reports a durability failure and leaves text pending', async () => {
  const h = makeHarness();
  h.failNext.on = true;
  h.controller.noteChange('must stay');
  assertEqual(await h.controller.flush(), false, 'caller learns the write did not land');
  assert(h.controller.dirty, 'failed text remains pending');
  assertEqual(h.states.at(-1), 'Storage needs attention', 'failure state stays honest');
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`autosave: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
