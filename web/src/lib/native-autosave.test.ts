// Desktop autosave never writes a file it was not allowed to write, and never
// forgets one it was (attn-yzsa.1).
//
// Run with:
//
//   cd web && npx tsx src/lib/native-autosave.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTOSAVE_HELD_DISK_CONFLICT,
  AUTOSAVE_OFF_DOCUMENT_CHANGED,
  AUTOSAVE_OFF_NOT_EDITING,
  AUTOSAVE_OFF_NOT_MARKDOWN,
  AUTOSAVE_OFF_NO_FILE,
  AUTOSAVE_OFF_REVIEWING_SNAPSHOT,
  NATIVE_AUTOSAVE_CEILING_MS,
  NATIVE_AUTOSAVE_DEBOUNCE_MS,
  NativeAutosave,
  resolveAutosaveGate,
  type AutosaveContext,
  type AutosaveGate,
} from './native-autosave';

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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ————————————————————————————————————————————————————————————————
// The gate
// ————————————————————————————————————————————————————————————————

const editing: AutosaveContext = {
  mode: 'edit',
  fileType: 'markdown',
  hasPath: true,
  isReviewerViewingSnapshot: false,
  collabActive: false,
  collabRole: 'owner',
  externalChangePending: false,
};

const ctx = (over: Partial<AutosaveContext>): AutosaveContext => ({ ...editing, ...over });

defineCase('editing a local markdown file arms autosave', () => {
  // The case that did not exist before this epic: no review room, no
  // keystroke, work reaches disk anyway.
  assert(resolveAutosaveGate(editing).status === 'armed', 'plain edit mode must autosave');
});

defineCase('the owner of a live room autosaves without being in edit mode', () => {
  // Collab makes the owner's document editable from the rendered view, which
  // is why the old collab-only timer did not consult `mode`. That behaviour is
  // preserved exactly — this module replaced that timer, it did not join it.
  const g = resolveAutosaveGate(ctx({ mode: 'read', collabActive: true, collabRole: 'owner' }));
  assert(g.status === 'armed', 'a co-typing owner writes back regardless of mode');
});

defineCase('a reviewer in a live room never writes the owner’s disk', () => {
  const viewing = resolveAutosaveGate(
    ctx({ isReviewerViewingSnapshot: true, collabActive: true, collabRole: 'reviewer' }),
  );
  assert(viewing.status === 'off', 'a snapshot has no local file underneath it');
  assert(
    viewing.status === 'off' && viewing.reason === AUTOSAVE_OFF_REVIEWING_SNAPSHOT,
    'and says which surface it is',
  );
  const reading = resolveAutosaveGate(
    ctx({ mode: 'read', collabActive: true, collabRole: 'reviewer' }),
  );
  assert(reading.status === 'off', 'a reviewer outside edit mode has no write path either');
});

defineCase('reading, non-markdown and no-file are all off, each for its own reason', () => {
  const reading = resolveAutosaveGate(ctx({ mode: 'read' }));
  assert(
    reading.status === 'off' && reading.reason === AUTOSAVE_OFF_NOT_EDITING,
    'reading is not editing',
  );
  const image = resolveAutosaveGate(ctx({ fileType: 'image' }));
  assert(
    image.status === 'off' && image.reason === AUTOSAVE_OFF_NOT_MARKDOWN,
    'only markdown has a save path',
  );
  const none = resolveAutosaveGate(ctx({ hasPath: false }));
  assert(
    none.status === 'off' && none.reason === AUTOSAVE_OFF_NO_FILE,
    'nothing open, nothing to write',
  );
});

defineCase('a file changed on disk HOLDS autosave rather than turning it off', () => {
  // THE CASE THIS MODULE EXISTS TO GET RIGHT. An agent rewrites the file the
  // user is editing; App.svelte defers the reload because the buffer is dirty.
  // Firing the timer here overwrites the newer file with a stale buffer — data
  // loss caused by a feature sold as protection against data loss.
  const g = resolveAutosaveGate(ctx({ externalChangePending: true }));
  assert(g.status === 'held', 'a deferred external change pauses the timer');
  assert(g.status === 'held' && g.reason === AUTOSAVE_HELD_DISK_CONFLICT, 'and explains itself');
});

defineCase('held is never reported on a surface where the user could not resolve it', () => {
  // `held` promises "⌘S resolves this". On a reviewer's snapshot or a
  // non-markdown tab it would not, so the structural refusals must win even
  // when a stale deferred-reload flag is also set.
  const surfaces: Array<Partial<AutosaveContext>> = [
    { isReviewerViewingSnapshot: true },
    { hasPath: false },
    { fileType: 'image' },
    { mode: 'read' },
  ];
  for (const over of surfaces) {
    const g = resolveAutosaveGate(ctx({ ...over, externalChangePending: true }));
    assert(g.status === 'off', `${JSON.stringify(over)} must be off, not held`);
  }
});

defineCase('every refusal carries a sentence', () => {
  const contexts: AutosaveContext[] = [
    ctx({ isReviewerViewingSnapshot: true }),
    ctx({ hasPath: false }),
    ctx({ fileType: 'image' }),
    ctx({ mode: 'read' }),
    ctx({ externalChangePending: true }),
  ];
  for (const c of contexts) {
    const g = resolveAutosaveGate(c);
    assert(g.status !== 'armed', 'these are all refusals');
    assert(g.reason.trim().length > 12, `${JSON.stringify(c)} must explain itself`);
  }
});

// ————————————————————————————————————————————————————————————————
// The clock
// ————————————————————————————————————————————————————————————————

/**
 * A virtual clock. The controller takes `now` and `schedule` precisely so its
 * timing can be tested without waiting 8 real seconds for the ceiling — the
 * alternative is a suite that either sleeps or lies.
 */
function fakeClock() {
  let clock = 0;
  let pending: { at: number; fn: () => void } | null = null;
  return {
    now: (): number => clock,
    schedule: (fn: () => void, ms: number): (() => void) => {
      const mine = { at: clock + ms, fn };
      pending = mine;
      return () => {
        if (pending === mine) pending = null;
      };
    },
    /** Advance virtual time, running every timer that comes due. */
    advance: (ms: number): void => {
      const target = clock + ms;
      // Loop rather than fire-once: a timer may schedule another one from
      // inside its own callback, and that follow-up is often the behaviour
      // under test (the ceiling re-arming mid-burst).
      for (;;) {
        const due = pending;
        if (due === null || due.at > target) break;
        clock = due.at;
        pending = null;
        due.fn();
      }
      clock = target;
    },
  };
}

interface Harness {
  autosave: NativeAutosave;
  advance: (ms: number) => void;
  /** A method, not a getter: `assert` is an assertion function, so a property
   *  read gets narrowed to the literal it was just compared against and every
   *  later comparison in the same case becomes a type error. */
  commits: () => number;
  skipped: () => AutosaveGate[];
  setGate: (gate: AutosaveGate) => void;
  /** Move the editor to another document, the way a tab switch does. */
  setIdentity: (id: string) => void;
}

function harness(over: Partial<{ debounceMs: number; maxPendingMs: number }> = {}): Harness {
  const clock = fakeClock();
  let gate: AutosaveGate = { status: 'armed' };
  let commits = 0;
  const skipped: AutosaveGate[] = [];
  let identity = 'a.md';
  const autosave = new NativeAutosave({
    ...over,
    commit: () => {
      commits += 1;
    },
    gate: () => gate,
    identity: () => identity,
    onSkipped: (g) => skipped.push(g),
    now: clock.now,
    schedule: clock.schedule,
  });
  return {
    autosave,
    advance: clock.advance,
    commits: () => commits,
    skipped: () => skipped,
    setGate: (g) => {
      gate = g;
    },
    setIdentity: (id) => {
      identity = id;
    },
  };
}

defineCase('a quiet period after the last change triggers the write', () => {
  const h = harness();
  h.autosave.noteChange();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS - 1);
  assert(h.commits() === 0, 'still inside the quiet period');
  assert(h.autosave.pending, 'and the change is still owed');
  h.advance(2);
  assert(h.commits() === 1, 'the quiet period elapsed, so the file is written');
  assert(!h.autosave.pending, 'and nothing is owed any more');
});

defineCase('each change renews the quiet period', () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) {
    h.autosave.noteChange();
    h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS - 200);
  }
  assert(h.commits() === 0, 'a steady stream of keystrokes never sits quiet');
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS);
  assert(h.commits() === 1, 'one write covers the whole burst');
});

defineCase('continuous typing still commits at the ceiling', () => {
  // The failure a naive debounce hides: it only shows up for the people typing
  // fastest, and it shows up as "I wrote for four minutes and lost all of it".
  const h = harness();
  for (let elapsed = 0; elapsed < NATIVE_AUTOSAVE_CEILING_MS * 2; elapsed += 100) {
    h.autosave.noteChange();
    h.advance(100);
  }
  assert(h.commits() >= 2, `an unbroken burst must still reach disk (got ${h.commits()})`);
});

defineCase('the ceiling is measured from the first change of the burst', () => {
  const h = harness({ debounceMs: 1_000, maxPendingMs: 3_000 });
  for (let i = 0; i < 30; i += 1) {
    h.autosave.noteChange();
    h.advance(100);
  }
  // 3s of continuous typing: exactly one ceiling-forced write, not one per
  // keystroke and not zero.
  assert(h.commits() === 1, `expected one ceiling write in 3s, got ${h.commits()}`);
});

defineCase('the gate is asked when the write is due, not when it was scheduled', () => {
  // THE ORDERING BUG THIS PREVENTS. The file changes on disk DURING the
  // debounce window. A controller that captured "armed" at schedule time would
  // write anyway and clobber it.
  const h = harness();
  h.autosave.noteChange();
  h.setGate({ status: 'held', reason: AUTOSAVE_HELD_DISK_CONFLICT });
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS + 1);
  assert(h.commits() === 0, 'a conflict that appeared mid-debounce must stop the write');
  assert(h.skipped().length === 1 && h.skipped()[0].status === 'held', 'and it is reported as held');
});

defineCase('a held change is kept, not dropped', () => {
  const h = harness();
  h.setGate({ status: 'held', reason: AUTOSAVE_HELD_DISK_CONFLICT });
  h.autosave.noteChange();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 10);
  assert(h.commits() === 0, 'held means held');
  assert(h.autosave.pending, 'but the edit is still owed — losing it would be the same data loss');
  // The user resolves the conflict (⌘S writes their version and clears the
  // deferred reload); the next keystroke picks straight back up.
  h.setGate({ status: 'armed' });
  h.autosave.noteChange();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS + 1);
  assert(h.commits() === 1, 'autosave resumes once the conflict is resolved');
});

defineCase('held does not spin: one refusal, not one per tick', () => {
  const h = harness();
  h.setGate({ status: 'held', reason: AUTOSAVE_HELD_DISK_CONFLICT });
  h.autosave.noteChange();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 20);
  assert(h.skipped().length === 1, `a held write must not retry on a timer (got ${h.skipped().length})`);
});

defineCase('an off surface drops the pending write instead of holding it', () => {
  // Left edit mode / switched to a non-markdown tab. Whatever changed the
  // surface owns the buffer now; firing later would write the wrong file.
  const h = harness();
  h.autosave.noteChange();
  h.setGate({ status: 'off', reason: AUTOSAVE_OFF_NOT_EDITING });
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS + 1);
  assert(h.commits() === 0, 'no write');
  assert(!h.autosave.pending, 'and nothing left armed to fire against a different file later');
});

defineCase('flush writes immediately and reports whether it did', () => {
  const h = harness();
  assert(h.autosave.flush() === false, 'nothing pending is not a write');
  h.autosave.noteChange();
  assert(h.autosave.flush() === true, 'a pending change flushes on demand');
  assert(h.commits() === 1, 'and the file is written now, not in 1.2s');
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 2);
  assert(h.commits() === 1, 'the cancelled timer must not fire a second write');
});

defineCase('flush respects the gate', () => {
  const h = harness();
  h.autosave.noteChange();
  h.setGate({ status: 'held', reason: AUTOSAVE_HELD_DISK_CONFLICT });
  assert(h.autosave.flush() === false, 'a file switch cannot force a write over a disk conflict');
  assert(h.autosave.pending, 'and the edit stays owed');
});

defineCase('cancel drops the pending write without writing', () => {
  // ⌘S and Escape both route here: one already wrote via the app's own save
  // function, the other threw the edits away. Either way the timer must not
  // fire a second, redundant write afterwards.
  const h = harness();
  h.autosave.noteChange();
  h.autosave.cancel();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 5);
  assert(h.commits() === 0, 'no write');
  assert(!h.autosave.pending, 'nothing owed');
});

defineCase('a save that re-enters noteChange keeps the new edit', () => {
  // `commit` runs the app's real save, which re-serializes the document; any
  // transaction that produces calls straight back in. Clearing pending AFTER
  // the commit would swallow that keystroke.
  const clock = fakeClock();
  let inner: NativeAutosave | null = null;
  let commits = 0;
  inner = new NativeAutosave({
    commit: () => {
      commits += 1;
      if (commits === 1) inner!.noteChange();
    },
    gate: () => ({ status: 'armed' }),
    identity: () => 'a.md',
    now: clock.now,
    schedule: clock.schedule,
  });
  inner.noteChange();
  clock.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 4);
  assert(commits === 2, `the re-entrant change must also be written (got ${commits})`);
});

defineCase('dispose stops the clock for good', () => {
  const h = harness();
  h.autosave.noteChange();
  h.autosave.dispose();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 5);
  assert(h.commits() === 0, 'a disposed controller never writes');
  h.autosave.noteChange();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 5);
  assert(h.commits() === 0, 'and cannot be re-armed');
  assert(h.autosave.flush() === false, 'nor flushed');
});

// ————————————————————————————————————————————————————————————————
// The caller actually spends the decision
// ————————————————————————————————————————————————————————————————

const appSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../App.svelte'),
  'utf8',
);
const saveChipSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'SaveChip.svelte'),
  'utf8',
);

defineCase('App.svelte drives one autosave path, not two', () => {
  assert(appSource.includes('new NativeAutosave('), 'the native window must own a controller');
  assert(
    appSource.includes('resolveAutosaveGate('),
    'and it must consult the gate rather than re-deciding inline',
  );
  // The old collab-only debounce. Two timers writing the same file is how you
  // get interleaved writes; it was replaced, not supplemented.
  assert(
    !appSource.includes('collabSaveTimer'),
    'the collab-only save timer must be gone, not running beside autosave',
  );
});

defineCase('a write is never fired against a different document', () => {
  // THE CORRUPTION CASE (Codex review, 2026-08-10). `edit_save` carries only
  // content — the daemon writes it to ITS active_path — so a timer that
  // outlives a tab switch does not save the old file late, it saves the OLD
  // BUFFER'S TEXT INTO THE NEW FILE. The frontend cannot retarget the write,
  // so the only safe move is to not make it.
  const h = harness();
  h.autosave.noteChange();
  h.setIdentity('b.md');
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 4);
  assert(h.commits() === 0, 'the stranded write must NOT land in the new document');
  assert(!h.autosave.pending, 'and it must not linger to fire again later');
  const last = h.skipped().at(-1);
  assert(
    last?.status === 'off' && last.reason === AUTOSAVE_OFF_DOCUMENT_CHANGED,
    'the drop is reported as a document change, not as an ordinary surface refusal',
  );
});

defineCase('flush is subject to the same interlock', () => {
  // A caller that flushes AFTER swapping the document has already lost the
  // buffer; the flush must not turn that mistake into a cross-file write.
  const h = harness();
  h.autosave.noteChange();
  h.setIdentity('b.md');
  assert(h.autosave.flush() === false, 'flush must refuse a stranded write');
  assert(h.commits() === 0, 'nothing written');
});

defineCase('identity is snapshotted per burst, not per keystroke', () => {
  // The snapshot is taken when a burst BEGINS pending. Later keystrokes in the
  // same burst belong to the same document, and re-snapshotting on each one
  // would quietly re-point a burst that began elsewhere.
  const h = harness();
  h.autosave.noteChange();
  h.advance(10);
  h.autosave.noteChange();
  h.setIdentity('b.md');
  h.autosave.noteChange();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 4);
  assert(h.commits() === 0, 'the burst still belongs to the document it started in');
});

defineCase('returning to the original document does not resurrect a dropped write', () => {
  const h = harness();
  h.autosave.noteChange();
  h.setIdentity('b.md');
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 4);
  h.setIdentity('a.md');
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 4);
  assert(h.commits() === 0, 'the pending state was dropped at the mismatch, not parked');
});

defineCase('a normal edit still writes once the identity holds', () => {
  // The interlock must not be so eager that ordinary editing stops working.
  const h = harness();
  h.autosave.noteChange();
  h.advance(NATIVE_AUTOSAVE_DEBOUNCE_MS * 4);
  assert(h.commits() === 1, 'unchanged document writes exactly once');
});

defineCase('every document-replacing call site funnels through replaceDocument', () => {
  // The buffer belongs to one path, and `edit_save` carries only content — the
  // daemon writes it to ITS active_path. So a code path that swaps the open
  // document without discharging the pending write either strands the edits or
  // lands them in the file being opened.
  //
  // Grepping source is a blunt instrument, and it is used here on purpose:
  // "this function changes which document is open" is not a property the type
  // system can see, so the alternative is remembering. This is the list Codex
  // found unguarded on 2026-08-10.
  assert(appSource.includes('function replaceDocument('), 'the funnel must exist');
  for (const site of [
    'switchTabNow',
    'closeTabNow',
    'openPathNow',
    'handleProjectSwitch',
    'applySetContent',
  ]) {
    const at = appSource.indexOf(`function ${site}(`);
    assert(at !== -1, `${site} still exists (rename? then update this list)`);
    // The guard belongs at the TOP of the function — after the buffer has been
    // replaced there is nothing left to flush.
    const head = appSource.slice(at, at + 900);
    assert(head.includes('replaceDocument()'), `${site} must guard the document swap`);
  }
});

defineCase('the save chip says the thing this epic made true', () => {
  assert(
    appSource.includes("from './lib/SaveChip.svelte'"),
    'the native header must use the shared save chip',
  );
  assert(
    !appSource.includes("editorDirty ? 'Unsaved changes' : 'Saved on this device'"),
    'the old per-surface copy must be gone',
  );
  // The sentence has to be REAL text inside role="status": a `role="status"`
  // announces the CONTENT that changed, and an aria-label is not content, so
  // an aria-label-only chip flips state in total silence.
  assert(
    saveChipSource.includes('class="sr-only"') && saveChipSource.includes('data-slot={`${dataSlot}-label`}'),
    'the sr-only live-region text must survive the copy change',
  );
});

let failed = 0;
for (const run of cases) {
  const result = run();
  if (result.ok) {
    console.log(`PASS ${result.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${result.name}`);
    if (result.detail) console.error(`  ${result.detail}`);
  }
}

if (failed > 0) process.exit(1);
