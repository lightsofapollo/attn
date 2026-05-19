// End-to-end test of the live co-typing controller through its wire envelope.
//
// This is the closest-to-production test that stays in-process: two
// CollabControllers (owner + reviewer) exchange CollabWireMessage JSON over
// simulated signal queues — exactly the strings the daemon shuttles as
// SignalingPayload::Collab. Proves role logic + the submit/broadcast envelope
// converge the two editors.
//
// Run: npx tsx src/lib/prosemirror/collab-controller.test.ts

import { collab } from 'prosemirror-collab';
import { EditorState } from 'prosemirror-state';

import { schema } from '../schema';
import { CollabController } from './collab-controller';
import type { EditorBridge } from './collab-session';

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

function makeEditor(clientID: string, text: string) {
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
    doc: () => state.doc,
    type(pos: number, t: string) {
      state = state.apply(state.tr.insertText(t, pos));
    },
    get text() {
      return state.doc.textContent;
    },
  };
}

function makeSession(initial: string) {
  const ownerEd = makeEditor('owner', initial);
  const reviewerEd = makeEditor('reviewer', initial);

  // Broadcast bus: each side's send() reaches the OTHER side's onInbound.
  const toReviewer: string[] = [];
  const toOwner: string[] = [];

  const owner = new CollabController({
    bridge: ownerEd.bridge,
    isOwner: true,
    initialDoc: docWithText(initial),
    send: (p) => toReviewer.push(p),
  });
  const reviewer = new CollabController({
    bridge: reviewerEd.bridge,
    isOwner: false,
    initialDoc: docWithText(initial),
    send: (p) => toOwner.push(p),
  });

  function pump(): void {
    for (let guard = 0; guard < 200; guard++) {
      let moved = false;
      while (toOwner.length > 0) {
        owner.onInbound(toOwner.shift()!);
        moved = true;
      }
      while (toReviewer.length > 0) {
        reviewer.onInbound(toReviewer.shift()!);
        moved = true;
      }
      if (!moved) return;
    }
    throw new Error('pump did not settle');
  }

  return { ownerEd, reviewerEd, owner, reviewer, pump };
}

defineCase('owner edit reaches reviewer through the wire envelope', () => {
  const s = makeSession('hello');
  s.ownerEd.type(1, 'O');
  s.owner.onLocalChange();
  s.pump();
  assert(s.ownerEd.text === 'Ohello', `owner ${s.ownerEd.text}`);
  assert(s.reviewerEd.text === 'Ohello', `reviewer ${s.reviewerEd.text}`);
});

defineCase('reviewer edit reaches owner through the wire envelope', () => {
  const s = makeSession('hello');
  s.reviewerEd.type(6, 'R');
  s.reviewer.onLocalChange();
  s.pump();
  assert(s.reviewerEd.text === 'helloR', `reviewer ${s.reviewerEd.text}`);
  assert(s.ownerEd.text === 'helloR', `owner ${s.ownerEd.text}`);
});

defineCase('concurrent owner + reviewer edits converge', () => {
  const s = makeSession('hello');
  s.ownerEd.type(1, 'OO');
  s.reviewerEd.type(6, 'RR');
  s.owner.onLocalChange();
  s.reviewer.onLocalChange();
  s.pump();
  assert(s.ownerEd.text === s.reviewerEd.text, `diverge owner=${s.ownerEd.text} reviewer=${s.reviewerEd.text}`);
  assert(s.ownerEd.text.includes('OO') && s.ownerEd.text.includes('RR'), `lost edit: ${s.ownerEd.text}`);
});

defineCase('owner ignores its own broadcast echo; reviewer ignores stray submits', () => {
  const s = makeSession('hi');
  // Feed the owner a broadcast (its own echo shape) → must be ignored (no throw, no change).
  const before = s.ownerEd.text;
  s.owner.onInbound(JSON.stringify({ kind: 'broadcast', broadcast: { startVersion: 0, steps: [], clientIDs: [] } }));
  assert(s.ownerEd.text === before, 'owner must ignore broadcast echoes');
  // Feed the reviewer a submit → must be ignored (reviewer isn't the authority).
  const rbefore = s.reviewerEd.text;
  s.reviewer.onInbound(JSON.stringify({ kind: 'submit', submission: { clientID: 'x', version: 0, steps: [] } }));
  assert(s.reviewerEd.text === rbefore, 'reviewer must ignore submits');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
