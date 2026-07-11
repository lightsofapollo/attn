// Orchestration tests for the live co-typing session controllers.
//
// One level above collab-authority.test.ts: this drives the real CollabHost +
// CollabClient controllers through a simulated async wire (queues + a pump),
// exercising the "one batch in flight / resubmit after rebase" discipline and
// the owner-as-its-own-client path. If this converges, the only thing left is
// to replace the in-process queues with encrypted signal envelopes.
//
// Run: npx tsx src/lib/prosemirror/collab-session.test.ts

import { collab, getVersion } from 'prosemirror-collab';
import { EditorState } from 'prosemirror-state';

import { schema } from '../schema';
import {
  CollabAuthority,
  deserializeSteps,
  type CollabBroadcast,
  type CollabSubmission,
} from './collab-authority';
import { CollabClient, CollabHost, type EditorBridge } from './collab-session';

let passed = 0;
let failed = 0;
const asyncCases: Array<{ name: string; fn: () => Promise<void> }> = [];

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

function defineAsyncCase(name: string, fn: () => Promise<void>): void {
  asyncCases.push({ name, fn });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function docWithText(text: string) {
  return schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text(text)]),
  ]);
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
  const host = new CollabHost(authority, (b) => {
    toReviewer.push(b);
  });

  // Owner's own editor: submissions go straight to the host in-process.
  const ownerClient = new CollabClient(owner.bridge, (sub) =>
    host.onSubmission(sub),
  );
  host.attachOwnerClient(ownerClient);

  // Reviewer: submissions cross the wire to the owner.
  const reviewerClient = new CollabClient(reviewer.bridge, (sub) =>
    toOwner.push(sub),
  );

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
  assert(
    s.owner.text === s.reviewer.text,
    `divergence owner=${s.owner.text} reviewer=${s.reviewer.text}`,
  );
  assert(
    s.owner.text === s.authority.doc.textContent,
    `owner=${s.owner.text} != authority=${s.authority.doc.textContent}`,
  );
  assert(
    s.owner.text.includes('OOO') && s.owner.text.includes('RRR'),
    `lost edit: ${s.owner.text}`,
  );
});

defineCase('rapid interleaved edits across two rounds stay converged', () => {
  const s = makeSession('start');
  s.owner.type(1, 'a');
  s.reviewer.type(6, 'b');
  s.ownerClient.syncUp();
  s.reviewerClient.syncUp();
  s.pump();
  const round1 = s.authority.doc.textContent;
  assert(
    s.owner.text === round1 && s.reviewer.text === round1,
    `round1 diverge: ${s.owner.text}/${s.reviewer.text}`,
  );
  // Second round of concurrent edits on the shared doc.
  s.owner.type(2, 'c');
  s.reviewer.type(1, 'd');
  s.ownerClient.syncUp();
  s.reviewerClient.syncUp();
  s.pump();
  const round2 = s.authority.doc.textContent;
  assert(
    s.owner.text === round2 && s.reviewer.text === round2,
    `round2 diverge: ${s.owner.text}/${s.reviewer.text}`,
  );
});

defineCase('synchronous submit failure does not leave the client inflight', () => {
  const editor = makeBridge('reviewer', 'hello');
  let attempts = 0;
  const client = new CollabClient(editor.bridge, () => {
    attempts += 1;
    throw new Error('transport closed during send');
  });
  editor.type(1, 'R');
  client.syncUp();
  client.syncUp();
  assert(attempts === 2, `client remained stuck after ${attempts} submit attempt(s)`);
});

defineCase('obsolete catch-up cannot clear a newer inflight generation', () => {
  const editor = makeBridge('reviewer', 'hello');
  const client = new CollabClient(editor.bridge, () => undefined);
  const other = makeBridge('owner', 'hello');
  let submission: CollabSubmission | null = null;
  const otherClient = new CollabClient(other.bridge, (next) => {
    submission = next;
  });
  other.type(1, 'O');
  otherClient.syncUp();
  const authority = new CollabAuthority(docWithText('hello'));
  void authority.receiveSteps(
    submission!.version,
    deserializeSteps(submission!.steps),
    submission!.clientID,
  );
  assert(client.receive(authority.stepsSince(0)), 'initial broadcast applies');
  assert(
    !client.receive({ startVersion: 0, steps: [], clientIDs: [] }),
    'obsolete catch-up was treated as current',
  );
});

defineAsyncCase(
  'checkpoint persistence completes before authority commit and broadcast',
  async () => {
    const editor = makeBridge('reviewer', 'hello');
    let submission: CollabSubmission | null = null;
    const client = new CollabClient(editor.bridge, (next) => {
      submission = next;
    });
    editor.type(1, 'R');
    client.syncUp();
    assert(submission !== null, 'expected reviewer submission');

    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authority = new CollabAuthority(docWithText('hello'), 'snapshot-1');
    const host = new CollabHost(
      authority,
      () => {
        order.push('broadcast');
      },
      async () => {
        order.push('persist-start');
        await gate;
        order.push('persist-end');
      },
    );
    const pending = host.onSubmission(submission!);
    await Promise.resolve();
    assert(
      authority.version === 0,
      'authority advanced before persistence completed',
    );
    assert(
      order.join(',') === 'persist-start',
      `unexpected pre-release order: ${order}`,
    );
    release();
    const result = await pending;
    assert(result.status === 'accepted', `unexpected result ${result.status}`);
    assert(authority.version === 1, 'authority did not commit persisted batch');
    assert(
      order.join(',') === 'persist-start,persist-end,broadcast',
      `wrong order: ${order}`,
    );
  },
);

defineAsyncCase(
  'persistence failure leaves authority unchanged and pauses later submissions',
  async () => {
    const editor = makeBridge('reviewer', 'hello');
    let submission: CollabSubmission | null = null;
    const client = new CollabClient(editor.bridge, (next) => {
      submission = next;
    });
    editor.type(1, 'R');
    client.syncUp();
    const authority = new CollabAuthority(docWithText('hello'), 'snapshot-1');
    const host = new CollabHost(
      authority,
      () => undefined,
      async () => {
        throw new Error('sealed checkpoint write failed');
      },
    );
    const first = await host.onSubmission(submission!);
    assert(
      first.status === 'paused',
      `persistence failure returned ${first.status}`,
    );
    assert(host.paused, 'host did not enter paused state');
    assert(
      authority.version === 0 && authority.doc.textContent === 'hello',
      'failed persistence mutated authority',
    );
    const second = await host.onSubmission(submission!);
    assert(second.status === 'paused', 'paused host accepted later traffic');
    assert(authority.version === 0, 'paused host advanced');
  },
);

defineAsyncCase(
  'repeated stale submission receives catch-up without duplicate application',
  async () => {
    const editor = makeBridge('reviewer', 'hello');
    let submission: CollabSubmission | null = null;
    const client = new CollabClient(editor.bridge, (next) => {
      submission = next;
    });
    editor.type(6, 'R');
    client.syncUp();
    const broadcasts: CollabBroadcast[] = [];
    const authority = new CollabAuthority(docWithText('hello'), 'snapshot-1');
    const host = new CollabHost(authority, (broadcast) => {
      broadcasts.push(broadcast);
    });
    assert(
      (await host.onSubmission(submission!)).status === 'accepted',
      'first submission rejected',
    );
    assert(
      (await host.onSubmission(submission!)).status === 'catchup',
      'repeat did not receive catch-up',
    );
    assert(
      authority.version === 1,
      `repeat advanced authority to ${authority.version}`,
    );
    assert(
      authority.doc.textContent === 'helloR',
      `repeat applied twice: ${authority.doc.textContent}`,
    );
    const catchup = broadcasts.at(-1)!;
    assert(
      catchup.startVersion === 0 && catchup.steps.length === 1,
      'catch-up did not replay accepted step',
    );
  },
);

defineAsyncCase(
  'broadcast failure cannot strand the owner editor after durable commit',
  async () => {
    const owner = makeBridge('owner', 'hello');
    let accepted: Promise<unknown> | null = null;
    const authority = new CollabAuthority(docWithText('hello'), 'snapshot-1');
    const host = new CollabHost(
      authority,
      async () => {
        throw new Error('transport unavailable');
      },
      async () => undefined,
    );
    const ownerClient = new CollabClient(owner.bridge, (submission) => {
      accepted = host.onSubmission(submission);
    });
    host.attachOwnerClient(ownerClient);
    owner.type(1, 'O');
    ownerClient.syncUp();
    await accepted;
    assert(authority.version === 1, 'durable authority did not advance');
    assert(
      getVersion(owner.bridge.getState()) === 1,
      'owner editor remained unconfirmed',
    );
    assert(owner.text === 'Ohello', `owner editor diverged: ${owner.text}`);
  },
);

for (const test of asyncCases) {
  try {
    await test.fn();
    passed++;
    console.log(`  ok  ${test.name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${test.name}`);
    console.log(`       ${(err as Error).message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
