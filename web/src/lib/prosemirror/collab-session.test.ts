// Orchestration tests for the live co-typing session controllers.
//
// One level above collab-authority.test.ts: this drives the real CollabHost +
// CollabClient controllers through a simulated async wire (queues + a pump),
// exercising the "one batch in flight / resubmit after rebase" discipline and
// the owner-as-its-own-client path. If this converges, the only thing left is
// to replace the in-process queues with encrypted signal envelopes.
//
// Run: npx tsx src/lib/prosemirror/collab-session.test.ts

import { collab } from 'prosemirror-collab';
import { EditorState } from 'prosemirror-state';

import { schema } from '../schema';
import { CollabAuthority, type CollabBroadcast, type CollabSubmission } from './collab-authority';
import { CollabClient, CollabHost, type EditorBridge } from './collab-session';

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

function docWithText(text: string) {
  return schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]);
}

/** A DOM-free EditorBridge over a mutable EditorState. */
function makeBridge(clientID: string, text: string) {
  let state = EditorState.create({
    doc: docWithText(text),
    plugins: [collab({ version: 0, clientID })],
  });
  const bridge: EditorBridge = {
    getState: () => state,
    apply: (tr) => {
      state = state.apply(tr);
    },
  };
  return {
    bridge,
    type(pos: number, t: string) {
      state = state.apply(state.tr.insertText(t, pos));
    },
    get text() {
      return state.doc.textContent;
    },
  };
}

/**
 * Build a full owner + reviewer session over simulated async queues. The
 * owner runs the host (and is its own client); reviewer submissions cross a
 * queue to the host; host broadcasts cross a queue to the reviewer.
 */
function makeSession(initial: string) {
  const owner = makeBridge('owner', initial);
  const reviewer = makeBridge('reviewer', initial);

  const toOwner: CollabSubmission[] = [];
  const toReviewer: CollabBroadcast[] = [];

  const authority = new CollabAuthority(docWithText(initial));
  const host = new CollabHost(authority, (b) => toReviewer.push(b));

  // Owner's own editor: submissions go straight to the host in-process.
  const ownerClient = new CollabClient(owner.bridge, (sub) => host.onSubmission(sub));
  host.attachOwnerClient(ownerClient);

  // Reviewer: submissions cross the wire to the owner.
  const reviewerClient = new CollabClient(reviewer.bridge, (sub) => toOwner.push(sub));

  /** Drain both queues until quiescent. */
  function pump(): void {
    for (let guard = 0; guard < 200; guard++) {
      let moved = false;
      while (toOwner.length > 0) {
        host.onSubmission(toOwner.shift()!);
        moved = true;
      }
      while (toReviewer.length > 0) {
        reviewerClient.receive(toReviewer.shift()!);
        moved = true;
      }
      if (!moved) return;
    }
    throw new Error('pump did not settle');
  }

  return { owner, reviewer, ownerClient, reviewerClient, authority, pump };
}

defineCase('owner local edit propagates to reviewer', () => {
  const s = makeSession('hello');
  s.owner.type(1, 'O');
  s.ownerClient.syncUp();
  s.pump();
  assert(s.owner.text === 'Ohello', `owner: ${s.owner.text}`);
  assert(s.reviewer.text === 'Ohello', `reviewer: ${s.reviewer.text}`);
});

defineCase('reviewer local edit propagates to owner', () => {
  const s = makeSession('hello');
  s.reviewer.type(6, 'R');
  s.reviewerClient.syncUp();
  s.pump();
  assert(s.reviewer.text === 'helloR', `reviewer: ${s.reviewer.text}`);
  assert(s.owner.text === 'helloR', `owner: ${s.owner.text}`);
});

defineCase('concurrent owner + reviewer edits converge', () => {
  const s = makeSession('hello');
  // Both edit from the same base before any sync.
  s.owner.type(1, 'OOO');
  s.reviewer.type(6, 'RRR');
  s.ownerClient.syncUp();
  s.reviewerClient.syncUp();
  s.pump();
  assert(s.owner.text === s.reviewer.text, `divergence owner=${s.owner.text} reviewer=${s.reviewer.text}`);
  assert(s.owner.text === s.authority.doc.textContent,
    `owner=${s.owner.text} != authority=${s.authority.doc.textContent}`);
  assert(s.owner.text.includes('OOO') && s.owner.text.includes('RRR'), `lost edit: ${s.owner.text}`);
});

defineCase('rapid interleaved edits across two rounds stay converged', () => {
  const s = makeSession('start');
  s.owner.type(1, 'a');
  s.reviewer.type(6, 'b');
  s.ownerClient.syncUp();
  s.reviewerClient.syncUp();
  s.pump();
  const round1 = s.authority.doc.textContent;
  assert(s.owner.text === round1 && s.reviewer.text === round1, `round1 diverge: ${s.owner.text}/${s.reviewer.text}`);
  // Second round of concurrent edits on the shared doc.
  s.owner.type(2, 'c');
  s.reviewer.type(1, 'd');
  s.ownerClient.syncUp();
  s.reviewerClient.syncUp();
  s.pump();
  const round2 = s.authority.doc.textContent;
  assert(s.owner.text === round2 && s.reviewer.text === round2, `round2 diverge: ${s.owner.text}/${s.reviewer.text}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
