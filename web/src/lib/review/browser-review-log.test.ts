// Manual test harness for `browser-review-log.ts` (attn-dgya).
//
// Exercises the durable review-log hydration used by every hosted workspace
// tab regardless of lease role:
//
//   - replay populates the store from committed inbound envelopes, through
//     the verified decrypt/signature pipeline, idempotently.
//   - watchWorkspaceReviewLog discovers the real published share record,
//     hydrates immediately, and re-replays on the REVIEW_INBOUND doorbell.
//   - a closed watcher stops reacting; an unshared workspace no-ops.
//
// Run with:
//
//   cd web && npx tsx src/lib/review/browser-review-log.test.ts

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  discoverReviewLogRoom,
  openWorkspaceReviewProjection,
  replayReviewLogIntoStore,
  type ReviewLogRoomKeys,
} from './browser-review-log';
import { BrowserStorage } from './browser-storage';
import { inviteCapabilityFrom } from './browser-workspace-share';
import {
  aeadSeal,
  base64UrlEncode,
  contentHash,
  deriveEventId,
  deriveRoomId,
  deriveRoomKeys,
  toCanonicalBytes,
  type EnvelopeAad,
  type SignableMetaShape,
} from './browser-crypto';
import { REVIEW_INBOUND_CHANNEL_PREFIX } from '../tab-channels';
import type { BrowserDeviceIdentity, ReviewStoreSink } from './browser-session';
import type { Device, MailboxEnvelope, RoomPolicy } from './browser-ws';
import type {
  FileId,
  ReviewEvent,
  ReviewSnapshot,
  RoomId,
  SnapshotId,
} from '../types';

Object.defineProperty(globalThis, 'IDBKeyRange', {
  configurable: true,
  value: IDBKeyRange,
});

// ---------------------------------------------------------------------------
// Harness (same defineCase/runner idiom as browser-session.test.ts).
// ---------------------------------------------------------------------------

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

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM_SECRET = new Uint8Array(32).fill(0xa7);
const ROOM_ID = deriveRoomId(ROOM_SECRET);
const KEYS = deriveRoomKeys(ROOM_SECRET);

const POLICY: RoomPolicy = {
  mode: 'live',
  maxPeers: 8,
  maxSnapshotBytes: 5 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxEvents: 1000,
  expiresAt: 1_900_000_000_000,
  powBits: 12,
  deleteEventsAfterOwnerAck: false,
  allowBrowser: true,
  allowRemoteAgents: false,
};

function ownerIdentity(): BrowserDeviceIdentity {
  const signingSecret = new Uint8Array(32).fill(0x51);
  const encryptionSecret = new Uint8Array(32).fill(0x61);
  return {
    deviceId: 'browser-owner-device',
    participantId: 'browser-owner-participant',
    signingSecret,
    signingPublic: ed25519.getPublicKey(signingSecret),
    encryptionSecret,
    publicEncryptionKey: x25519.getPublicKey(encryptionSecret),
  };
}

function ownerDevice(identity: BrowserDeviceIdentity): Device {
  const unsigned = {
    deviceId: identity.deviceId,
    participantId: identity.participantId,
    publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
    publicSigningKey: base64UrlEncode(identity.signingPublic),
    client: 'attn-browser' as const,
    kind: 'owner' as const,
    registeredAt: 1_700_000_000_000,
  };
  const canonical = toCanonicalBytes({
    client: unsigned.client,
    deviceId: unsigned.deviceId,
    kind: unsigned.kind,
    participantId: unsigned.participantId,
    publicEncryptionKey: unsigned.publicEncryptionKey,
    publicSigningKey: unsigned.publicSigningKey,
  });
  return {
    ...unsigned,
    selfSignature: base64UrlEncode(ed25519.sign(canonical, identity.signingSecret)),
  };
}

function mintCommentEnvelope(
  identity: BrowserDeviceIdentity,
  envelopeId: string,
  createdAt: number,
  commentBody: string,
  threadId: string,
): MailboxEnvelope {
  const meta: SignableMetaShape = {
    v: 2,
    eventId: '',
    roomId: ROOM_ID,
    authorId: identity.participantId,
    deviceId: identity.deviceId,
    createdAt,
    parentEventIds: [],
  };
  const body = {
    type: 'comment_created',
    threadId,
    anchor: {
      v: 2,
      fileId: 'file-dgya',
      snapshotId: 'snap-dgya',
      baseHash: 'hash-dgya',
      position: { byteRange: [0, 5], lineRange: [1, 1], pmRange: [1, 6] },
    },
    body: commentBody,
  };
  meta.eventId = deriveEventId(meta, body);
  const signableMeta: Record<string, unknown> = {
    v: meta.v,
    roomId: meta.roomId,
    authorId: meta.authorId,
    deviceId: meta.deviceId,
    createdAt: meta.createdAt,
    parentEventIds: [],
  };
  const signed = toCanonicalBytes({ body, meta: signableMeta });
  const auth = {
    signature: base64UrlEncode(ed25519.sign(signed, identity.signingSecret)),
    signingKeyId: base64UrlEncode(sha256(identity.signingPublic)),
  };
  const plaintextBytes = toCanonicalBytes({ auth, body, meta: { ...meta } });
  const nonce = new Uint8Array(24);
  for (let i = 0; i < nonce.length; i++) nonce[i] = 0x2a + i;
  const aad: EnvelopeAad = {
    v: 2,
    roomId: ROOM_ID,
    envelopeId,
    kind: 'event',
    authorId: identity.participantId,
    deviceId: identity.deviceId,
    createdAt,
  };
  const ct = aeadSeal(KEYS.eventKey, nonce, plaintextBytes, aad);
  return {
    v: 2,
    roomId: ROOM_ID,
    envelopeId,
    authorId: identity.participantId,
    deviceId: identity.deviceId,
    createdAt,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
    kind: 'event',
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ct),
    ciphertextBytes: ct.length,
  };
}

interface StubStore extends ReviewStoreSink {
  events: ReviewEvent[];
  snapshots: ReviewSnapshot[];
  roles: Array<{ roomId: RoomId; role: 'owner' | 'reviewer' }>;
}

function makeStubStore(): StubStore {
  const s: StubStore = {
    events: [],
    snapshots: [],
    roles: [],
    currentRoomId: null,
    currentFileId: null,
    applyEvent(event: ReviewEvent) {
      if (
        s.events.some(
          (existing) =>
            existing.meta.roomId === event.meta.roomId
            && existing.meta.eventId === event.meta.eventId,
        )
      ) return;
      s.events = [...s.events, event];
    },
    applySnapshot(snapshot: ReviewSnapshot) {
      s.snapshots = [...s.snapshots, snapshot];
    },
    setCurrentFile(fileId: FileId | null) {
      s.currentFileId = fileId;
    },
    setCurrentSnapshot(_snapshotId: SnapshotId | null) {},
    noteRoomRole(roomId: RoomId, role: 'owner' | 'reviewer') {
      s.roles = [...s.roles, { roomId, role }];
    },
    leaveRoom(roomId: RoomId) {
      s.events = s.events.filter((event) => event.meta.roomId !== roomId);
      s.snapshots = s.snapshots.filter((snapshot) => snapshot.roomId !== roomId);
      if (s.currentRoomId === roomId) s.currentRoomId = null;
    },
    adoptRoom(roomId: RoomId, role: 'owner' | 'reviewer') {
      s.roles = [...s.roles, { roomId, role }];
      s.currentRoomId = roomId;
    },
  };
  return s;
}

let counter = 0;

async function openStorage(): Promise<BrowserStorage> {
  counter += 1;
  return BrowserStorage.open({
    createIfMissing: true,
    databaseName: `attn-review-log-test-${counter}`,
    indexedDB: new IDBFactory(),
    crypto,
    navigator: null,
  });
}

/** Workspace with one active published share bound to ROOM_ID. */
async function seedSharedWorkspace(storage: BrowserStorage, identity: BrowserDeviceIdentity): Promise<string> {
  const created = await storage.workspaces.createWorkspace({
    name: 'dgya',
    storagePersisted: false,
    entry: { path: 'untitled.md', kind: 'markdown', body: new Uint8Array(0) },
  });
  const workspaceId = created.workspace.workspaceId;
  const rootKey = await storage.getWorkspaceRootKey(workspaceId);
  assert(rootKey, 'workspace root key exists');
  const id = (fill: number) => base64UrlEncode(new Uint8Array(16).fill(fill));
  await storage.shares.bindShare(rootKey, {
    workspaceId,
    capId: 'cap-dgya',
    roomId: ROOM_ID,
    scopeKind: 'file',
    relayUrl: 'https://relay.example',
    capability: inviteCapabilityFrom({
      roomSecret: ROOM_SECRET,
      ownerSigningSecret: identity.signingSecret,
      ownerEncryptionSecret: identity.encryptionSecret,
      ownerDeviceId: identity.deviceId,
      ownerParticipantId: identity.participantId,
      policy: structuredClone(POLICY),
      publishedManifest: {
        manifestSnapshotId: id(1),
        entries: [{
          path: 'untitled.md',
          fileId: id(2),
          snapshotId: id(3),
          contentHash: contentHash(new Uint8Array(0)),
          revisionId: created.revision.revisionId,
        }],
      },
    }),
  });
  return workspaceId;
}

function roomKeysFixture(identity: BrowserDeviceIdentity): ReviewLogRoomKeys {
  return {
    roomId: ROOM_ID,
    deviceId: identity.deviceId,
    protocolVersion: 2,
    eventKey: new Uint8Array(KEYS.eventKey),
    snapshotKey: new Uint8Array(KEYS.snapshotKey),
    signalingKey: new Uint8Array(KEYS.signalingKey),
    bindings: [],
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

defineCase('replay populates the store from the durable log, idempotently', async () => {
  const storage = await openStorage();
  try {
    const identity = ownerIdentity();
    await storage.putDevice(ROOM_ID, ownerDevice(identity));
    await storage.commitInbound(
      ROOM_ID,
      identity.deviceId,
      mintCommentEnvelope(identity, 'env-log-1', 1_700_000_100_000, 'FIRST-THREAD', 'thread-1'),
      1,
    );
    await storage.commitInbound(
      ROOM_ID,
      identity.deviceId,
      mintCommentEnvelope(identity, 'env-log-2', 1_700_000_200_000, 'SECOND-THREAD', 'thread-2'),
      2,
    );
    const store = makeStubStore();
    const room = roomKeysFixture(identity);
    await replayReviewLogIntoStore({ storage, room, store });
    assertEq(store.events.length, 2, 'both committed comments hydrate');
    assertEq(store.currentRoomId, ROOM_ID as RoomId, 'room selected for thread scoping');
    assertEq(store.roles[0]?.role, 'owner', 'owner role recorded');
    const bodies = store.events.map((event) =>
      event.body.type === 'comment_created' ? event.body.body : '',
    );
    assertEq(bodies.join(','), 'FIRST-THREAD,SECOND-THREAD', 'serverSeq replay order');
    // A second full replay — live delivery racing a doorbell ring — must
    // not duplicate a single thread.
    await replayReviewLogIntoStore({ storage, room, store });
    assertEq(store.events.length, 2, 'replay is idempotent by (roomId, eventId)');
  } finally {
    storage.close();
  }
});

defineCase('WorkspaceReviewProjection discovers the published share and follows the doorbell', async () => {
  const storage = await openStorage();
  const ring = new BroadcastChannel(REVIEW_INBOUND_CHANNEL_PREFIX + ROOM_ID);
  let projectionClose: (() => void) | null = null;
  try {
    const identity = ownerIdentity();
    const workspaceId = await seedSharedWorkspace(storage, identity);
    await storage.putDevice(ROOM_ID, ownerDevice(identity));
    await storage.commitInbound(
      ROOM_ID,
      identity.deviceId,
      mintCommentEnvelope(identity, 'env-watch-1', 1_700_000_100_000, 'WATCH-ONE', 'thread-w1'),
      1,
    );

    // Discovery is real: no seams, straight from the sealed share record.
    const discovered = await discoverReviewLogRoom(storage, workspaceId);
    assertEq(discovered?.roomId, ROOM_ID, 'share record resolves the room');

    const store = makeStubStore();
    const projection = await openWorkspaceReviewProjection({ storage, workspaceId, store });
    projectionClose = () => projection.close();
    assertEq(projection.getState().roomId, ROOM_ID, 'projection bound to the discovered room');
    assertEq(store.events.length, 1, 'initial hydration completed before open() resolved');

    // Leader commits a new inbound event, then rings — every tab replays.
    await storage.commitInbound(
      ROOM_ID,
      identity.deviceId,
      mintCommentEnvelope(identity, 'env-watch-2', 1_700_000_200_000, 'WATCH-TWO', 'thread-w2'),
      2,
    );
    ring.postMessage({ roomId: ROOM_ID });
    for (let i = 0; i < 100 && store.events.length < 2; i += 1) await delay(10);
    assertEq(store.events.length, 2, 'doorbell ring re-replays the log');

    // A spurious ring with nothing new stays a no-op.
    ring.postMessage({ roomId: ROOM_ID });
    await delay(100);
    assertEq(store.events.length, 2, 'redundant ring never duplicates threads');

    // After close the projection must stop reacting.
    projection.close();
    projectionClose = null;
    await storage.commitInbound(
      ROOM_ID,
      identity.deviceId,
      mintCommentEnvelope(identity, 'env-watch-3', 1_700_000_300_000, 'WATCH-THREE', 'thread-w3'),
      3,
    );
    ring.postMessage({ roomId: ROOM_ID });
    await delay(150);
    assertEq(store.events.length, 2, 'closed projection ignores rings');
  } finally {
    projectionClose?.();
    ring.close();
    storage.close();
  }
});

defineCase('projection follows a room rotation: drops the old room, replays the new (attn-kobw)', async () => {
  const storage = await openStorage();
  try {
    const identity = ownerIdentity();
    const workspaceId = await seedSharedWorkspace(storage, identity);
    await storage.putDevice(ROOM_ID, ownerDevice(identity));
    await storage.commitInbound(
      ROOM_ID,
      identity.deviceId,
      mintCommentEnvelope(identity, 'env-rot-1', 1_700_000_100_000, 'BEFORE-ROTATION', 'thread-rot'),
      1,
    );

    // A room-B room-keys record sharing A's AEAD keys (B has no committed
    // envelopes, so its replay is empty — the test asserts the ROTATION
    // mechanics: leave A, adopt+replay B).
    const ROOM_B = 'room-b-reprovisioned';
    const roomKeys = (roomId: string): ReviewLogRoomKeys => ({
      roomId,
      deviceId: identity.deviceId,
      protocolVersion: 2,
      eventKey: new Uint8Array(KEYS.eventKey),
      snapshotKey: new Uint8Array(KEYS.snapshotKey),
      signalingKey: new Uint8Array(KEYS.signalingKey),
      bindings: [],
    });
    let currentRoom = ROOM_ID;
    const discover = async (): Promise<ReviewLogRoomKeys> => roomKeys(currentRoom);

    const store = makeStubStore();
    const projection = await openWorkspaceReviewProjection({ storage, workspaceId, store, discover });
    try {
      assertEq(projection.getState().roomId, ROOM_ID, 'projection starts on room A');
      assertEq(store.events.length, 1, 'room A event hydrated');
      assertEq(store.currentRoomId, ROOM_ID, 'store selected room A');

      // The share record rotates its roomId (re-provisioning). The share
      // doorbell fires refreshShareRecord; the projection must drop A and
      // replay B.
      currentRoom = ROOM_B;
      await projection.refreshShareRecord();
      assertEq(projection.getState().roomId, ROOM_B, 'projection followed to room B');
      assertEq(store.events.length, 0, "room A's threads dropped on rotation");
      assertEq(store.currentRoomId, ROOM_B, 'store selected room B');
    } finally {
      projection.close();
    }
  } finally {
    storage.close();
  }
});

defineCase('a workspace without an active published share no-ops', async () => {
  const storage = await openStorage();
  try {
    const created = await storage.workspaces.createWorkspace({
      name: 'unshared',
      storagePersisted: false,
      entry: { path: 'untitled.md', kind: 'markdown', body: new Uint8Array(0) },
    });
    const store = makeStubStore();
    const projection = await openWorkspaceReviewProjection({
      storage,
      workspaceId: created.workspace.workspaceId,
      store,
    });
    assertEq(projection.getState().roomId, null, 'nothing to hydrate from');
    assertEq(store.events.length, 0, 'store untouched');
    projection.close();
    projection.close(); // close is safe to repeat
  } finally {
    storage.close();
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  interface NodeProcessShape {
    exit?: (code: number) => void;
  }
  const nodeProcess: NodeProcessShape | undefined =
    (globalThis as unknown as { process?: NodeProcessShape }).process;
  if (failed > 0) nodeProcess?.exit?.(1);
})().catch((err) => {
  console.error(err);
  interface NodeProcessShape {
    exit?: (code: number) => void;
  }
  const nodeProcess: NodeProcessShape | undefined =
    (globalThis as unknown as { process?: NodeProcessShape }).process;
  nodeProcess?.exit?.(1);
});
