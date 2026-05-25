// End-to-end test of the live co-typing controller through its wire envelope.
//
// This is the closest-to-production test that stays in-process: CollabControllers
// (owner + reviewer) exchange CollabWireMessage JSON over simulated signal
// queues — exactly the strings the daemon shuttles as SignalingPayload::Collab.
// Proves role logic, the fileId-tagged submit/broadcast envelope, per-file
// isolation, the resync catch-up, and owner file-switching converge editors.
//
// Run: npx tsx src/lib/prosemirror/collab-controller.test.ts

import { collab } from 'prosemirror-collab';
import { EditorState } from 'prosemirror-state';

import { schema } from '../schema';
import { CollabController, type RemoteCursor } from './collab-controller';
import type { EditorBridge } from './collab-session';
import type { FileId } from '../types';

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

// A room with N independently co-edited files. `open(ctrl, who, fileId, text)`
// mounts a fresh editor for a participant on a file (fresh clientID per mount,
// mirroring App.svelte's re-seed-on-switch) and binds the controller to it.
function makeSession() {
  const toReviewer: string[] = [];
  const toOwner: string[] = [];
  const ownerCursors: RemoteCursor[][] = [];
  const reviewerCursors: RemoteCursor[][] = [];
  // Base (v0) text per file so the owner can seed an authority for a file a
  // reviewer reaches first (getSeedDoc), matching each peer's v0 editor doc.
  const base = new Map<string, string>();

  const owner = new CollabController({
    isOwner: true,
    send: (p) => toReviewer.push(p),
    selfClientId: 'owner',
    selfLabel: 'Owner',
    selfColor: '#d97706',
    getSeedDoc: (fileId) => {
      const t = base.get(fileId);
      return t === undefined ? null : docWithText(t);
    },
    onRemoteCursors: (c) => ownerCursors.push(c),
  });
  const reviewer = new CollabController({
    isOwner: false,
    send: (p) => toOwner.push(p),
    selfClientId: 'reviewer',
    selfLabel: 'Reviewer',
    selfColor: '#2563eb',
    onRemoteCursors: (c) => reviewerCursors.push(c),
  });

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

  let mountSeq = 0;
  function open(
    ctrl: CollabController,
    who: 'owner' | 'reviewer',
    fileId: string,
    text: string,
  ) {
    base.set(fileId, text);
    const ed = makeEditor(`${who}-${fileId}-${mountSeq++}`, text);
    ctrl.setActiveFile(fileId as FileId, ed.bridge);
    return ed;
  }

  return { owner, reviewer, pump, open, ownerCursors, reviewerCursors };
}

defineCase('owner edit reaches reviewer through the fileId-tagged envelope', () => {
  const s = makeSession();
  const ownerA = s.open(s.owner, 'owner', 'A', 'hello');
  const reviewerA = s.open(s.reviewer, 'reviewer', 'A', 'hello');
  s.pump(); // settle the reviewer's join resync
  ownerA.type(1, 'O');
  s.owner.onLocalChange();
  s.pump();
  assert(ownerA.text === 'Ohello', `owner ${ownerA.text}`);
  assert(reviewerA.text === 'Ohello', `reviewer ${reviewerA.text}`);
});

defineCase('reviewer edit reaches owner through the fileId-tagged envelope', () => {
  const s = makeSession();
  const ownerA = s.open(s.owner, 'owner', 'A', 'hello');
  const reviewerA = s.open(s.reviewer, 'reviewer', 'A', 'hello');
  s.pump();
  reviewerA.type(6, 'R');
  s.reviewer.onLocalChange();
  s.pump();
  assert(reviewerA.text === 'helloR', `reviewer ${reviewerA.text}`);
  assert(ownerA.text === 'helloR', `owner ${ownerA.text}`);
});

defineCase('concurrent owner + reviewer edits on the same file converge', () => {
  const s = makeSession();
  const ownerA = s.open(s.owner, 'owner', 'A', 'hello');
  const reviewerA = s.open(s.reviewer, 'reviewer', 'A', 'hello');
  s.pump();
  ownerA.type(1, 'OO');
  reviewerA.type(6, 'RR');
  s.owner.onLocalChange();
  s.reviewer.onLocalChange();
  s.pump();
  assert(ownerA.text === reviewerA.text, `diverge owner=${ownerA.text} reviewer=${reviewerA.text}`);
  assert(ownerA.text.includes('OO') && ownerA.text.includes('RR'), `lost edit: ${ownerA.text}`);
});

defineCase('per-file isolation: a reviewer on B never perturbs the owner on A', () => {
  const s = makeSession();
  const ownerA = s.open(s.owner, 'owner', 'A', 'aaa');
  const reviewerB = s.open(s.reviewer, 'reviewer', 'B', 'bbb');
  s.pump();
  // Reviewer edits B (owner has never opened B → host is lazily seeded).
  reviewerB.type(1, 'X');
  s.reviewer.onLocalChange();
  s.pump();
  assert(reviewerB.text === 'Xbbb', `reviewer B ${reviewerB.text}`);
  // The owner's editor (on A) is untouched by B's traffic.
  assert(ownerA.text === 'aaa', `owner A perturbed: ${ownerA.text}`);
  // When the owner switches to B, it sees the reviewer's edit (the headless
  // authority for B accepted it while the owner was on A).
  const ownerB = s.open(s.owner, 'owner', 'B', 'bbb');
  s.pump();
  assert(ownerB.text === 'Xbbb', `owner B did not catch up: ${ownerB.text}`);
});

defineCase('resync: a reviewer joining a file mid-session catches up to current', () => {
  const s = makeSession();
  const ownerA = s.open(s.owner, 'owner', 'A', 'start');
  s.pump();
  // Owner makes several edits BEFORE the reviewer ever opens the file.
  ownerA.type(1, '1');
  s.owner.onLocalChange();
  s.pump();
  ownerA.type(1, '2');
  s.owner.onLocalChange();
  s.pump();
  assert(ownerA.text === '21start', `owner ${ownerA.text}`);
  // Reviewer opens A now (seeds at v0, requests resync) → must reach current.
  const reviewerA = s.open(s.reviewer, 'reviewer', 'A', 'start');
  s.pump();
  assert(reviewerA.text === '21start', `reviewer did not resync: ${reviewerA.text}`);
  // And live edits keep flowing after the resync.
  reviewerA.type(reviewerA.text.length + 1, 'Z');
  s.reviewer.onLocalChange();
  s.pump();
  assert(ownerA.text === '21startZ', `post-resync owner ${ownerA.text}`);
});

defineCase('owner switches A→B→A: each file keeps its own state', () => {
  const s = makeSession();
  const ownerA = s.open(s.owner, 'owner', 'A', 'A0');
  const reviewerB = s.open(s.reviewer, 'reviewer', 'B', 'B0');
  s.pump();
  // Owner edits A.
  ownerA.type(1, 'a');
  s.owner.onLocalChange();
  s.pump();
  // Owner switches to B, edits B; reviewer (on B) sees it.
  const ownerB = s.open(s.owner, 'owner', 'B', 'B0');
  s.pump();
  ownerB.type(1, 'b');
  s.owner.onLocalChange();
  s.pump();
  assert(reviewerB.text === 'bB0', `reviewer B ${reviewerB.text}`);
  // Owner switches back to A — A still has its edit, not B's.
  const ownerA2 = s.open(s.owner, 'owner', 'A', 'A0');
  s.pump();
  assert(ownerA2.text === 'aA0', `owner back on A ${ownerA2.text}`);
});

defineCase('owner ignores broadcast echoes; reviewer ignores stray submits', () => {
  const s = makeSession();
  const ownerA = s.open(s.owner, 'owner', 'A', 'hi');
  const reviewerA = s.open(s.reviewer, 'reviewer', 'A', 'hi');
  s.pump();
  const before = ownerA.text;
  s.owner.onInbound(
    JSON.stringify({ kind: 'broadcast', fileId: 'A', broadcast: { startVersion: 0, steps: [], clientIDs: [] } }),
    'owner-device',
  );
  assert(ownerA.text === before, 'owner must ignore broadcast echoes');
  const rbefore = reviewerA.text;
  s.reviewer.onInbound(
    JSON.stringify({ kind: 'submit', fileId: 'A', submission: { clientID: 'x', version: 0, steps: [] } }),
    'owner-device',
  );
  assert(reviewerA.text === rbefore, 'reviewer must ignore submits');
});

defineCase('cursor broadcast reaches the other peer, not self', () => {
  const s = makeSession();
  s.open(s.owner, 'owner', 'A', 'hello');
  s.open(s.reviewer, 'reviewer', 'A', 'hello');
  s.pump();
  const cursorsBefore = s.ownerCursors.length;
  s.reviewer.broadcastCursor(3);
  s.pump();
  const lastOwner = s.ownerCursors[s.ownerCursors.length - 1] ?? [];
  assert(lastOwner.length === 1, `owner expected 1 remote cursor, got ${lastOwner.length}`);
  assert(lastOwner[0].clientID === 'reviewer' && lastOwner[0].head === 3, `wrong cursor: ${JSON.stringify(lastOwner[0])}`);
  assert(lastOwner[0].label === 'Reviewer', `wrong label: ${lastOwner[0].label}`);
  assert(s.ownerCursors.length > cursorsBefore, 'owner should have recorded the reviewer caret');
  assert(s.reviewerCursors.length === 0, 'reviewer must not record its own cursor');
});

defineCase("a departed peer's caret is cleared on leave", () => {
  const s = makeSession();
  s.open(s.owner, 'owner', 'A', 'hello');
  s.open(s.reviewer, 'reviewer', 'A', 'hello');
  s.pump();
  s.reviewer.broadcastCursor(3);
  s.pump();
  assert((s.ownerCursors.at(-1) ?? []).length === 1, 'owner should see the reviewer caret first');
  s.owner.removeCursorsForDevice('reviewer-device');
  assert((s.ownerCursors.at(-1) ?? []).length === 0, 'owner caret set should be empty after leave');
  const callbackCount = s.ownerCursors.length;
  s.owner.removeCursorsForDevice('someone-else-device');
  assert(s.ownerCursors.length === callbackCount, 'no-op leave must not fire onRemoteCursors');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
