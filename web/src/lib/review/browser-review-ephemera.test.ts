// Browser workspace ephemera bus (attn-whdh).
//
// Run: npx tsx src/lib/review/browser-review-ephemera.test.ts

import {
  BrowserReviewEphemeraBus,
  parseBrowserReviewEphemeraMessage,
  type BrowserReviewEphemeraChannel,
  type BrowserReviewEphemeraMessage,
} from './browser-review-ephemera';

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => void }> = [];

function defineCase(name: string, fn: () => void): void {
  cases.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Delivers only to other endpoints, like browser BroadcastChannel. */
class FakeBus {
  private readonly endpoints = new Set<FakeChannel>();

  connect(): FakeChannel {
    const channel = new FakeChannel(this);
    this.endpoints.add(channel);
    return channel;
  }

  deliver(source: FakeChannel, value: unknown): void {
    for (const endpoint of this.endpoints) {
      if (endpoint !== source && !endpoint.closed) endpoint.onmessage?.({ data: value });
    }
  }

  remove(channel: FakeChannel): void {
    this.endpoints.delete(channel);
  }
}

class FakeChannel implements BrowserReviewEphemeraChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(private readonly bus: FakeBus) {}

  postMessage(value: unknown): void {
    if (!this.closed) this.bus.deliver(this, value);
  }

  close(): void {
    this.closed = true;
    this.bus.remove(this);
  }
}

const cursorPayload = JSON.stringify({
  kind: 'cursor',
  cursor: { clientID: 'reviewer-tab', head: 4, label: 'Reviewer', color: '#765432' },
});

defineCase('delivers bounded presence and cursor variants without durable state', () => {
  const wire = new FakeBus();
  const owner = new BrowserReviewEphemeraBus({
    workspaceId: 'workspace-1', senderId: 'owner-tab', channel: wire.connect(),
  });
  const follower = new BrowserReviewEphemeraBus({
    workspaceId: 'workspace-1', senderId: 'follower-tab', channel: wire.connect(),
  });
  const ownerMessages: BrowserReviewEphemeraMessage[] = [];
  const followerMessages: BrowserReviewEphemeraMessage[] = [];
  const localMessages: BrowserReviewEphemeraMessage[] = [];
  owner.subscribe((message) => ownerMessages.push(message));
  follower.subscribe((message) => followerMessages.push(message));
  owner.subscribe((message) => localMessages.push(message));

  owner.publish({
    kind: 'presence',
    peers: [{ participantId: 'reviewer', deviceId: 'device-r', kind: 'reviewer', online: true }],
  });
  assert(followerMessages.length === 1, 'follower did not receive room roster');
  assert(followerMessages[0]!.signal.kind === 'presence', 'wrong presence signal kind');
  assert(localMessages.length === 1, 'same-tab presence subscriber was not notified');

  follower.publish({ kind: 'cursor', source: 'local-tab', payload: cursorPayload });
  assert(ownerMessages.length === 2, 'owner did not receive local-tab cursor');
  const cursor = ownerMessages.at(-1)!;
  assert(cursor.senderId === 'follower-tab', 'cursor sender id lost');
  assert(cursor.signal.kind === 'cursor' && cursor.signal.source === 'local-tab', 'cursor source lost');
  assert(cursor.signal.kind === 'cursor' && cursor.signal.payload === cursorPayload, 'cursor payload changed');

  owner.close();
  follower.close();
});

defineCase('rejects foreign, oversized, and non-cursor payloads before subscribers', () => {
  const wire = new FakeBus();
  const owner = new BrowserReviewEphemeraBus({
    workspaceId: 'workspace-1', senderId: 'owner-tab', channel: wire.connect(),
  });
  const rogue = wire.connect();
  let received = 0;
  owner.subscribe(() => { received += 1; });

  rogue.postMessage({
    v: 1,
    workspaceId: 'different-workspace',
    senderId: 'rogue',
    signal: { kind: 'cursor', source: 'room', payload: cursorPayload },
  });
  rogue.postMessage({
    v: 1,
    workspaceId: 'workspace-1',
    senderId: 'rogue',
    signal: { kind: 'cursor', source: 'room', payload: '{"kind":"submit"}' },
  });
  rogue.postMessage({
    v: 1,
    workspaceId: 'workspace-1',
    senderId: 'rogue',
    signal: {
      kind: 'presence',
      peers: Array.from({ length: 65 }, () => ({
        participantId: 'p', deviceId: 'd', kind: 'reviewer', online: true,
      })),
    },
  });
  assert(received === 0, 'invalid ephemera reached a subscriber');
  assert(
    parseBrowserReviewEphemeraMessage({
      v: 1,
      workspaceId: 'workspace-1',
      senderId: 'owner-tab',
      signal: { kind: 'cursor', source: 'room', payload: cursorPayload },
    }, 'workspace-1')?.signal.kind === 'cursor',
    'valid bounded cursor was rejected',
  );
  owner.close();
  rogue.close();
});

for (const { name, fn } of cases) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${(error as Error).message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
