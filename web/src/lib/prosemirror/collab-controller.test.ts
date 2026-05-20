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
import { CollabController, type RemoteCursor } from './collab-controller';
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

  const ownerCursors: RemoteCursor[][] = [];
  const reviewerCursors: RemoteCursor[][] = [];
  const owner = new CollabController({
    bridge: ownerEd.bridge,
    isOwner: true,
    initialDoc: docWithText(initial),
    send: (p) => toReviewer.push(p),
    selfClientId: 'owner',
    selfLabel: 'Owner',
    selfColor: '#d97706',
    onRemoteCursors: (c) => ownerCursors.push(c),
  });
  const reviewer = new CollabController({
    bridge: reviewerEd.bridge,
    isOwner: false,
    initialDoc: docWithText(initial),
    send: (p) => toOwner.push(p),
    selfClientId: 'reviewer',
    selfLabel: 'Reviewer',
    selfColor: '#2563eb',
    onRemoteCursors: (c) => reviewerCursors.push(c),
  });

  // Messages in toOwner came FROM the reviewer; messages in toReviewer came
  // FROM the owner. The daemon stamps that sender deviceId on each signal.
  function pump(): void {
    for (let guard = 0; guard < 200; guard++) {
      let moved = false;
      while (toOwner.length > 0) {
        owner.onInbound(toOwner.shift()!, 'reviewer-device');
        moved = true;
      }
      while (toReviewer.length > 0) {
        reviewer.onInbound(toReviewer.shift()!, 'owner-device');
        moved = true;
      }
      if (!moved) return;
    }
    throw new Error('pump did not settle');
  }

  return { ownerEd, reviewerEd, owner, reviewer, pump, ownerCursors, reviewerCursors };
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
  s.owner.onInbound(JSON.stringify({ kind: 'broadcast', broadcast: { startVersion: 0, steps: [], clientIDs: [] } }), 'owner-device');
  assert(s.ownerEd.text === before, 'owner must ignore broadcast echoes');
  // Feed the reviewer a submit → must be ignored (reviewer isn't the authority).
  const rbefore = s.reviewerEd.text;
  s.reviewer.onInbound(JSON.stringify({ kind: 'submit', submission: { clientID: 'x', version: 0, steps: [] } }), 'owner-device');
  assert(s.reviewerEd.text === rbefore, 'reviewer must ignore submits');
});

defineCase('cursor broadcast reaches the other peer, not self', () => {
  const s = makeSession('hello');
  s.reviewer.broadcastCursor(3);
  s.pump();
  // Owner should now see the reviewer's caret; reviewer should not see its own.
  const lastOwner = s.ownerCursors[s.ownerCursors.length - 1] ?? [];
  assert(lastOwner.length === 1, `owner expected 1 remote cursor, got ${lastOwner.length}`);
  assert(lastOwner[0].clientID === 'reviewer' && lastOwner[0].head === 3, `wrong cursor: ${JSON.stringify(lastOwner[0])}`);
  assert(lastOwner[0].label === 'Reviewer', `wrong label: ${lastOwner[0].label}`);
  assert(s.reviewerCursors.length === 0, 'reviewer must not record its own cursor');
});

defineCase('a departed peer\'s caret is cleared on leave', () => {
  const s = makeSession('hello');
  s.reviewer.broadcastCursor(3);
  s.pump();
  assert((s.ownerCursors.at(-1) ?? []).length === 1, 'owner should see the reviewer caret first');
  // The reviewer's signals arrived FROM 'reviewer-device' (see pump). When
  // presence reports that device offline, its caret must disappear.
  s.owner.removeCursorsForDevice('reviewer-device');
  assert((s.ownerCursors.at(-1) ?? []).length === 0, 'owner caret set should be empty after leave');
  // Removing an unrelated device is a no-op (no spurious callback churn).
  const callbackCount = s.ownerCursors.length;
  s.owner.removeCursorsForDevice('someone-else-device');
  assert(s.ownerCursors.length === callbackCount, 'no-op leave must not fire onRemoteCursors');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
