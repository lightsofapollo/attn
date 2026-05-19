// Convergence tests for the owner-as-authority collab loop.
//
// Proves the core invariant of live co-typing: two editors making CONCURRENT
// edits, routed through a single CollabAuthority (the owner's webview) with
// steps crossing the wire as JSON, converge to the exact same document — and
// that document equals the authority's. This is the hard part of the design;
// if this holds, the rest is transport plumbing.
//
// Run: npx tsx src/lib/prosemirror/collab-authority.test.ts

import { collab, getVersion, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import { EditorState } from 'prosemirror-state';

import { schema } from '../schema';
import {
  CollabAuthority,
  deserializeSteps,
  serializeSteps,
  type CollabSubmission,
} from './collab-authority';

let passed = 0;
let failed = 0;

function defineCase(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${(err as Error).message}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Build a single-paragraph doc from text. */
function docWithText(text: string) {
  return schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])]);
}

/** A simulated participant editor with the collab plugin installed. */
function makeClient(clientID: string, doc = docWithText('hello')) {
  let state = EditorState.create({
    doc,
    plugins: [collab({ version: 0, clientID })],
  });
  return {
    clientID,
    get state() {
      return state;
    },
    get version() {
      return getVersion(state);
    },
    get text() {
      return state.doc.textContent;
    },
    /** Apply a local edit (insert `text` at `pos`). */
    type(pos: number, text: string) {
      state = state.apply(state.tr.insertText(text, pos));
    },
    /** The wire submission for any unconfirmed local steps, or null. */
    submission(): CollabSubmission | null {
      const sendable = sendableSteps(state);
      if (!sendable) return null;
      return {
        clientID: sendable.clientID,
        version: sendable.version,
        steps: serializeSteps(sendable.steps),
      };
    },
    /** Apply an authoritative broadcast (rebasing local unconfirmed steps). */
    receive(steps: unknown[], clientIDs: Array<string | number>) {
      const tr = receiveTransaction(state, deserializeSteps(steps), clientIDs);
      state = state.apply(tr);
    },
  };
}

/**
 * Drive the full owner-authority loop to quiescence: repeatedly catch every
 * client up to the authority version, then accept any pending submissions,
 * until no client has unconfirmed steps and all are at the latest version.
 * This mirrors the real push loop (broadcast on accept; clients resubmit
 * after rebasing).
 */
function syncToQuiescence(
  authority: CollabAuthority,
  clients: ReturnType<typeof makeClient>[],
): void {
  for (let guard = 0; guard < 100; guard++) {
    let progressed = false;

    // 1. Catch every client up to the authority (the broadcast path).
    for (const client of clients) {
      if (client.version < authority.version) {
        const batch = authority.stepsSince(client.version);
        client.receive(batch.steps, batch.clientIDs);
        progressed = true;
      }
    }

    // 2. Accept one pending submission (the submit path). A stale submission
    //    is rejected; that client will catch up on the next loop and resubmit.
    for (const client of clients) {
      const sub = client.submission();
      if (!sub) continue;
      const result = authority.receiveSteps(
        sub.version,
        deserializeSteps(sub.steps),
        sub.clientID,
      );
      if (result.accepted) progressed = true;
    }

    const allCaughtUp = clients.every(
      (c) => c.version === authority.version && c.submission() === null,
    );
    if (!progressed && allCaughtUp) return;
  }
  throw new Error('loop did not reach quiescence within guard limit');
}

defineCase('serialize → deserialize round-trips a step exactly', () => {
  const start = docWithText('hello');
  const client = makeClient('A', start);
  client.type(1, 'X'); // "Xhello"
  const sub = client.submission();
  assert(sub !== null, 'expected a submission after a local edit');
  const steps = deserializeSteps(sub!.steps);
  assert(steps.length === 1, `expected 1 step, got ${steps.length}`);
  const applied = steps[0].apply(start);
  assert(applied.doc?.textContent === 'Xhello', `round-trip wrong: ${applied.doc?.textContent}`);
});

defineCase('authority rejects a stale-version submission', () => {
  const authority = new CollabAuthority(docWithText('hello'));
  const a = makeClient('A');
  const b = makeClient('B');
  a.type(1, 'A');
  b.type(6, 'B');
  // A submits first at version 0 → accepted.
  const subA = a.submission()!;
  assert(authority.receiveSteps(subA.version, deserializeSteps(subA.steps), subA.clientID).accepted,
    'A should be accepted at v0');
  // B submits, still at version 0, but authority moved on → rejected.
  const subB = b.submission()!;
  assert(!authority.receiveSteps(subB.version, deserializeSteps(subB.steps), subB.clientID).accepted,
    'B should be rejected as stale');
});

defineCase('two concurrent editors converge to the same doc as the authority', () => {
  const authority = new CollabAuthority(docWithText('hello'));
  const a = makeClient('A');
  const b = makeClient('B');
  // Concurrent edits from the SAME base version (0): A prepends, B appends.
  a.type(1, 'AAA'); // "AAAhello"
  b.type(6, 'BBB'); // "helloBBB"
  syncToQuiescence(authority, [a, b]);
  assert(a.text === b.text, `A (${a.text}) != B (${b.text})`);
  assert(a.text === authority.doc.textContent, `A (${a.text}) != authority (${authority.doc.textContent})`);
  assert(a.version === authority.version, `version mismatch A=${a.version} auth=${authority.version}`);
  // Both edits survived (order is authority-decided but both substrings present).
  assert(a.text.includes('AAA') && a.text.includes('BBB'), `lost an edit: ${a.text}`);
});

defineCase('three editors with interleaved edits all converge', () => {
  const authority = new CollabAuthority(docWithText('start'));
  const a = makeClient('A', docWithText('start'));
  const b = makeClient('B', docWithText('start'));
  const c = makeClient('C', docWithText('start'));
  a.type(1, '1');
  b.type(6, '2');
  c.type(3, '3');
  syncToQuiescence(authority, [a, b, c]);
  const auth = authority.doc.textContent;
  assert(a.text === auth && b.text === auth && c.text === auth,
    `divergence: A=${a.text} B=${b.text} C=${c.text} auth=${auth}`);
  // A second round of concurrent edits on the now-shared doc.
  a.type(1, 'x');
  c.type(2, 'y');
  syncToQuiescence(authority, [a, b, c]);
  const auth2 = authority.doc.textContent;
  assert(a.text === auth2 && b.text === auth2 && c.text === auth2,
    `round 2 divergence: A=${a.text} B=${b.text} C=${c.text} auth=${auth2}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
