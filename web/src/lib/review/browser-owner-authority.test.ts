import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';

import { parseCollabWireMessage } from '../prosemirror/collab-controller';
import { schema } from '../schema';
import type { Anchor, FileId, ReviewEvent, ReviewEventBody } from '../types';
import { contentHash } from './browser-crypto';
import type { AssembledBrowserEvent } from './browser-envelope';
import type { BrowserCollabCheckpoint } from './browser-collab-checkpoint';
import {
  BrowserOwnerAuthorityService,
  type BrowserOwnerAuthorityFile,
  type BrowserPublishedEpochTerminalPort,
  type BrowserOwnerAuthorityLeaseManager,
  type BrowserOwnerAuthorityRollover,
  type BrowserOwnerAuthorityState,
  type BrowserOwnerAuthorityStorage,
  type BrowserOwnerSession,
} from './browser-owner-authority';
import type {
  BrowserOwnerCredentials,
  BrowserSessionOptions,
  BrowserSessionState,
} from './browser-session';
import type { LeaseHandle } from './browser-workspace-lease';
import type { MailboxEnvelope } from './browser-ws';

interface CaseResult { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => void | Promise<void>): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition did not become true');
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const ROOM_ID = 'room-owner-authority';
const FILE_ID = 'file-owner-authority' as FileId;
const EPOCH = 'snapshot-owner-authority';
const PATH = 'notes.md';
const REVISION = 'revision-owner-authority';
const BASE_BYTES = new TextEncoder().encode('hello');
const HASH = contentHash(BASE_BYTES);
const BINDING = { fileId: FILE_ID, path: PATH, revisionId: REVISION, contentHash: HASH, epoch: EPOCH };
const SECOND_FILE_ID = 'file-owner-authority-second' as FileId;
const SECOND_PATH = 'second.md';
const SECOND_BYTES = new TextEncoder().encode('second');
const SECOND_HASH = contentHash(SECOND_BYTES);
const SECOND_BINDING = {
  fileId: SECOND_FILE_ID,
  path: SECOND_PATH,
  revisionId: 'revision-owner-authority-second',
  contentHash: SECOND_HASH,
  epoch: 'snapshot-owner-authority-second',
};
const BASE = schema.node('doc', null, [
  schema.node('paragraph', null, [schema.text('hello')]),
]);

function owner(): BrowserOwnerCredentials {
  return {
    roomId: ROOM_ID,
    roomSecret: new Uint8Array(32).fill(1),
    keys: {
      rootKey: new Uint8Array(32).fill(2),
      eventKey: new Uint8Array(32).fill(3),
      snapshotKey: new Uint8Array(32).fill(4),
      signalingKey: new Uint8Array(32).fill(5),
      admissionKey: new Uint8Array(32).fill(6),
    },
    identity: {
      deviceId: 'owner-device',
      participantId: 'owner-participant',
      signingSecret: new Uint8Array(32).fill(7),
      signingPublic: new Uint8Array(32).fill(8),
      encryptionSecret: new Uint8Array(32).fill(9),
      publicEncryptionKey: new Uint8Array(32).fill(10),
    },
    policy: {
      mode: 'live',
      maxPeers: 8,
      maxSnapshotBytes: 5_000_000,
      maxEventBytes: 262_144,
      maxEvents: 1_000,
      expiresAt: 2_000_000_000_000,
      powBits: 12,
      deleteEventsAfterOwnerAck: false,
      allowBrowser: true,
      allowRemoteAgents: false,
    },
  };
}

function sessionState(status: BrowserSessionState['status'] = 'connected'): BrowserSessionState {
  return {
    principal: 'owner',
    ownerOnline: true,
    peers: [],
    liveEditingAvailable: true,
    status,
    connection: 'mailbox',
    directError: null,
    roomId: ROOM_ID as BrowserSessionState['roomId'],
    snapshotContent: null,
    snapshotDocType: 'markdown',
    snapshotId: null,
    fileId: null,
    error: null,
    authoringReady: true,
    grantTier: 'suggest',
    outboxPending: 0,
    authoringError: null,
    persistence: 'ephemeral',
    storagePersisted: null,
    canRemember: true,
  };
}

class FakeSession implements BrowserOwnerSession {
  readonly sent: string[] = [];
  started = false;
  closed = false;
  adopted: MailboxEnvelope[] = [];
  durableReviewCalls: string[] = [];
  sendGate: Promise<void> | null = null;
  constructor(readonly options: BrowserSessionOptions, private readonly events: string[]) {}
  async start(): Promise<void> {
    this.events.push('session:start');
    this.started = true;
    this.options.onState?.(sessionState());
  }
  close(): void {
    this.events.push('session:close');
    this.closed = true;
  }
  async sendCollab(payload: string): Promise<void> {
    this.events.push('session:send');
    this.sent.push(payload);
    await this.sendGate;
  }
  getState(): BrowserSessionState {
    return sessionState(this.closed ? 'terminated' : 'connected');
  }
  prepareTerminalEvent(_body: ReviewEventBody): AssembledBrowserEvent {
    return { event: {} as AssembledBrowserEvent['event'], envelope: {} as MailboxEnvelope };
  }
  async adoptDurableEnvelope(envelope: MailboxEnvelope): Promise<void> {
    this.adopted.push(envelope);
  }
  async createComment(_anchor: Anchor, _body: string): Promise<ReviewEvent> {
    this.durableReviewCalls.push('create');
    return {} as ReviewEvent;
  }
  async announceProfile(): Promise<void> {
    this.durableReviewCalls.push('announce');
  }
  async replyToComment(_anchor: Anchor, _body: string, threadId: string): Promise<ReviewEvent> {
    this.durableReviewCalls.push(`reply:${threadId}`);
    return {} as ReviewEvent;
  }
  async resolveComment(threadId: string): Promise<ReviewEvent> {
    this.durableReviewCalls.push(`resolve:${threadId}`);
    return {} as ReviewEvent;
  }
  async retryOutbox(): Promise<void> { this.durableReviewCalls.push('retry'); }
  async enqueuePublicationBatch(_envelopes: readonly MailboxEnvelope[]): Promise<number> {
    return 0;
  }
  async flushPublicationOutbox(): Promise<void> {}
}

class FakeStorage implements BrowserOwnerAuthorityStorage {
  readonly gets: string[] = [];
  readonly puts: Array<{
    checkpoint: BrowserCollabCheckpoint;
    fence: LeaseHandle;
    expectedVersion: number;
  }> = [];
  checkpoint: BrowserCollabCheckpoint | null = null;
  manifest = { manifestSnapshotId: 'manifest', entries: [{
    path: PATH, fileId: FILE_ID, snapshotId: EPOCH, contentHash: HASH, revisionId: REVISION,
  }] };
  revisionBytes = new Uint8Array(BASE_BYTES);
  readonly revisionBodies = new Map<string, Uint8Array>();
  putGate: Promise<void> | null = null;
  constructor(private readonly events: string[]) {}
  async loadPublishedManifest(): Promise<typeof this.manifest> {
    this.events.push('manifest:load');
    return structuredClone(this.manifest);
  }
  async getRevisionBody(_workspaceId: string, path: string): Promise<Uint8Array> {
    this.events.push('revision:load');
    return new Uint8Array(this.revisionBodies.get(path) ?? this.revisionBytes);
  }
  async getCollabCheckpoint(
    _workspaceId: string,
    _roomId: string,
    fileId: string,
    epoch: string,
  ): Promise<BrowserCollabCheckpoint | null> {
    this.events.push('checkpoint:load');
    this.gets.push(`${fileId}:${epoch}`);
    return this.checkpoint;
  }
  async putCollabCheckpoint(
    _workspaceId: string,
    checkpoint: BrowserCollabCheckpoint,
    options: { fence: LeaseHandle; expectedVersion: number },
  ): Promise<void> {
    this.events.push('checkpoint:put');
    this.puts.push({ checkpoint, fence: { ...options.fence, workspaceId: 'workspace' }, expectedVersion: options.expectedVersion });
    await this.putGate;
  }
}

class FakeLeases implements BrowserOwnerAuthorityLeaseManager {
  acquired = 0;
  heartbeats = 0;
  releases = 0;
  rejectHeartbeat = false;
  handle: LeaseHandle = {
    workspaceId: 'workspace',
    holderId: 'tab-owner',
    fencingToken: 7,
    expiresAt: 2_000,
  };
  async acquire(): Promise<LeaseHandle> {
    this.acquired += 1;
    return { ...this.handle };
  }
  async heartbeat(handle: LeaseHandle): Promise<LeaseHandle> {
    this.heartbeats += 1;
    if (this.rejectHeartbeat) throw new Error('lease takeover');
    this.handle = { ...handle, expiresAt: handle.expiresAt + 1_000 };
    return { ...this.handle };
  }
  async release(): Promise<boolean> {
    this.releases += 1;
    return true;
  }
}

interface Scheduled { callback: () => void; delay: number; cancelled: boolean }

function fixture(overrides: {
  checkpoint?: BrowserCollabCheckpoint | null;
  rollover?: {
    maxSteps: number;
    onRequired: NonNullable<BrowserOwnerAuthorityRollover['onRequired']>;
  };
  attachedLease?: LeaseHandle;
  files?: readonly BrowserOwnerAuthorityFile[];
  revisionBodies?: ReadonlyMap<string, Uint8Array>;
  now?: () => number;
  onState?: (state: BrowserOwnerAuthorityState, session: FakeSession | null) => void;
} = {}) {
  const events: string[] = [];
  const storage = new FakeStorage(events);
  const files = overrides.files ?? [BINDING];
  storage.manifest.entries = files.map((file) => ({
    path: file.path,
    fileId: file.fileId,
    snapshotId: file.epoch,
    contentHash: file.contentHash,
    revisionId: file.revisionId,
  }));
  for (const [path, bytes] of overrides.revisionBodies ?? []) {
    storage.revisionBodies.set(path, new Uint8Array(bytes));
  }
  storage.checkpoint = overrides.checkpoint ?? null;
  const leases = new FakeLeases();
  const scheduled: Scheduled[] = [];
  let fakeSession: FakeSession | null = null;
  const service = new BrowserOwnerAuthorityService({
    workspaceId: 'workspace',
    holderId: 'tab-owner',
    roomId: ROOM_ID,
    capId: 'cap-owner',
    owner: owner(),
    files,
    storage,
    leaseManager: leases,
    ...(overrides.attachedLease ? { attachedLease: overrides.attachedLease } : {}),
    heartbeatIntervalMs: 10,
    now: overrides.now ?? (() => 1_000),
    schedule: (callback, delay) => {
      const item = { callback, delay, cancelled: false };
      scheduled.push(item);
      return item;
    },
    cancelScheduled: (handle) => { (handle as Scheduled).cancelled = true; },
    sessionFactory: (options) => {
      fakeSession = new FakeSession(options, events);
      return fakeSession;
    },
    collab: {
      selfClientId: 'owner-client',
      selfLabel: 'Owner',
      selfColor: '#000000',
    },
    rollover: overrides.rollover ?? {
      onRequired: () => { throw new Error('unexpected rollover'); },
    },
    ...(overrides.onState
      ? { onState: (state) => overrides.onState!(state, fakeSession) }
      : {}),
  });
  return {
    service,
    storage,
    leases,
    scheduled,
    events,
    session: () => {
      assert(fakeSession, 'session was not constructed');
      return fakeSession;
    },
    runHeartbeat: () => {
      const timer = scheduled.find((item) => !item.cancelled && item.delay === 10);
      assert(timer, 'heartbeat timer was not scheduled');
      timer.cancelled = true;
      timer.callback();
    },
  };
}

function insertStep(text = 'R', position = 6): unknown {
  return new ReplaceStep(
    position,
    position,
    new Slice(Fragment.from(schema.text(text)), 0, 0),
  ).toJSON();
}

function collabDelivery(envelopeId: string, payload: string) {
  return {
    envelopeId,
    source: 'network' as const,
    payload,
    sender: {
      deviceId: 'reviewer-device', participantId: 'reviewer',
      publicEncryptionKey: 'key', publicSigningKey: 'key', selfSignature: 'signature',
      client: 'attn-browser' as const, kind: 'reviewer' as const,
    },
  };
}

defineCase('acquires once, preloads the epoch checkpoint before transport, heartbeats, and releases', async () => {
  const checkpoint: BrowserCollabCheckpoint = {
    v: 1,
    kind: 'collab_authority_checkpoint',
    roomId: ROOM_ID,
    fileId: FILE_ID,
    epoch: EPOCH,
    base: { kind: 'snapshot', id: EPOCH },
    version: 1,
    steps: [insertStep() as BrowserCollabCheckpoint['steps'][number]],
    clientIDs: ['reviewer'],
  };
  const f = fixture({ checkpoint });
  assertEqual(await f.service.start(), true, 'authority started');
  assertEqual(f.leases.acquired, 1, 'one lease acquired');
  assert(
    f.events.indexOf('checkpoint:load') < f.events.indexOf('session:start'),
    'transport opened before checkpoint preload',
  );
  await f.session().options.onCollab?.({
    envelopeId: 'envelope',
    source: 'network',
    payload: JSON.stringify({ kind: 'resync', fileId: FILE_ID, epoch: EPOCH }),
    sender: {
      deviceId: 'reviewer-device', participantId: 'reviewer',
      publicEncryptionKey: 'key', publicSigningKey: 'key', selfSignature: 'signature',
      client: 'attn-browser', kind: 'reviewer',
    },
  });
  await waitFor(() => f.session().sent.length === 1);
  const broadcast = parseCollabWireMessage(f.session().sent[0]!);
  assert(broadcast?.kind === 'broadcast', 'preloaded authority did not answer resync');
  assertEqual(broadcast.broadcast.steps.length, 1, 'checkpoint log restored before traffic');
  f.runHeartbeat();
  await waitFor(() => f.leases.heartbeats === 1);
  assertEqual(f.service.getState().lease?.fencingToken, 7, 'heartbeat retained fence');
  await f.service.close();
  assert(f.session().closed, 'transport closed on service close');
  assertEqual(f.leases.releases, 1, 'owned lease released once');
});

defineCase('corrupt checkpoint fails before owner transport construction', async () => {
  const corrupt: BrowserCollabCheckpoint = {
    v: 1, kind: 'collab_authority_checkpoint', roomId: ROOM_ID, fileId: FILE_ID,
    epoch: EPOCH, base: { kind: 'snapshot', id: EPOCH }, version: 1,
    steps: [{ stepType: 'replace', from: 999, to: 999 }], clientIDs: ['bad'],
  };
  const f = fixture({ checkpoint: corrupt });
  assertEqual(await f.service.start(), false, 'corrupt checkpoint rejected');
  assert(!f.events.includes('session:start'), 'transport started before checkpoint reconstruction');
});

defineCase('an HTML authority binding starts durable review without a Markdown collab seed', async () => {
  const html = new TextEncoder().encode('<main><h1>Report</h1></main>');
  const binding: BrowserOwnerAuthorityFile = {
    fileId: 'file-owner-authority-html' as FileId,
    path: 'report.html',
    revisionId: 'revision-owner-authority-html',
    contentHash: contentHash(html),
    epoch: 'snapshot-owner-authority-html',
    docType: 'html',
  };
  const f = fixture({
    files: [binding],
    revisionBodies: new Map([[binding.path, html]]),
  });
  assertEqual(await f.service.start(), true, 'HTML review authority starts');
  assert(!f.events.includes('checkpoint:load'), 'HTML does not create a ProseMirror checkpoint');
  await f.service.createComment({} as Anchor, 'Pin this chart');
  assert(f.session().durableReviewCalls.includes('create'), 'HTML keeps durable comment authoring');
  await f.service.close();
});

defineCase('startup rejects a lease that expires across preload await', async () => {
  const f = fixture({ now: () => 2_000 });
  assertEqual(await f.service.start(), false, 'expired startup rejected');
  assert(!f.events.includes('session:start'), 'expired lease opened transport');
  assertEqual(f.service.getState().pauseKind, 'lease_lost', 'expiry surfaced as lease loss');
});

defineCase('attached coordinator lease is reused and never released by authority', async () => {
  const attached: LeaseHandle = {
    workspaceId: 'workspace', holderId: 'tab-owner', fencingToken: 9, expiresAt: 3_000,
  };
  const f = fixture({ attachedLease: attached });
  assertEqual(await f.service.start(), true, 'attached lease start');
  assertEqual(f.leases.acquired, 0, 'attached lease was reacquired');
  await f.service.close();
  assertEqual(f.leases.releases, 0, 'coordinator lease was released by authority');
});

defineCase('terminal preparation and durable adoption stay behind the live lease', async () => {
  const f = fixture();
  await f.service.start();
  f.service.prepareTerminalEvent({ type: 'suggestion_rejected', suggestionId: 'suggestion' });
  const envelope = { envelopeId: 'terminal' } as MailboxEnvelope;
  await f.service.adoptDurableEnvelope(envelope);
  assertEqual(f.session().adopted[0], envelope, 'exact durable envelope delegated');
  await f.service.close();
});

defineCase('durable owner review remains available while live authority is paused', async () => {
  const f = fixture();
  await f.service.start();
  try {
    await f.service.transitionPublishedEpoch(FILE_ID, {
      publish: () => { throw new Error('relay publication paused'); },
    });
  } catch { /* expected irreversible pause */ }
  assertEqual(f.service.getState().status, 'paused', 'live authority paused');
  await f.service.replyToComment({} as Anchor, 'reply', 'thread-1');
  await f.service.resolveComment('thread-1');
  await f.service.retryOutbox();
  assertEqual(
    f.session().durableReviewCalls.join(','),
    'reply:thread-1,resolve:thread-1,retry',
    'durable review delegated while collab paused',
  );
  await f.service.close();
});

defineCase('epoch commit receives a scoped terminal port backed by the captured live session', async () => {
  const f = fixture();
  await f.service.start();
  let leakedPort: BrowserPublishedEpochTerminalPort | null = null;
  await f.service.transitionPublishedEpoch(FILE_ID, {
    commit: async ({ terminalPort }) => {
      leakedPort = terminalPort;
      const prepared = terminalPort.prepareTerminalEvent({
        type: 'suggestion_rejected', suggestionId: 'suggestion',
      });
      await terminalPort.adoptDurableEnvelope(prepared.envelope);
    },
    publish: () => undefined,
  });
  assertEqual(f.session().adopted.length, 1, 'commit terminal envelope adoption');
  let leakedRejected = false;
  try {
    leakedPort!.prepareTerminalEvent({ type: 'suggestion_rejected', suggestionId: 'late' });
  } catch { leakedRejected = true; }
  assert(leakedRejected, 'transition terminal port escaped its commit scope');
  await f.service.close();
});

defineCase('transition inbound waits through reversible rollback and routes on the rebuilt controller', async () => {
  const f = fixture();
  await f.service.start();
  const prepareGate = deferred();
  let prepareStarted = false;
  const transitionResult = f.service.transitionPublishedEpoch(FILE_ID, {
    prepare: async () => {
      prepareStarted = true;
      await prepareGate.promise;
      throw new Error('reversible prepublication failure');
    },
    publish: () => undefined,
  }).then(() => false, () => true);
  await waitFor(() => prepareStarted);
  let deliverySettled = false;
  const delivery = Promise.resolve(f.session().options.onCollab?.(collabDelivery(
    'rollback-resync',
    JSON.stringify({ kind: 'resync', fileId: FILE_ID, epoch: EPOCH }),
  ))).then(() => { deliverySettled = true; });
  await Promise.resolve();
  assert(!deliverySettled, 'transition inbound resolved before rollback completed');
  prepareGate.resolve();
  assert(await transitionResult, 'reversible transition unexpectedly succeeded');
  await delivery;
  await waitFor(() => f.session().sent.length === 1);
  const replay = parseCollabWireMessage(f.session().sent[0]!);
  assert(replay?.kind === 'broadcast', 'rollback inbound did not reach rebuilt authority');
  assertEqual(replay.epoch, EPOCH, 'rollback inbound routed to wrong epoch');
  await f.service.close();
});

defineCase('transition inbound waits for full reseed and routes against the promoted epoch', async () => {
  const f = fixture();
  await f.service.start();
  const publishGate = deferred();
  let publishStarted = false;
  const nextBytes = new TextEncoder().encode('hello next');
  const nextHash = contentHash(nextBytes);
  const nextEpoch = 'snapshot-inbound-next';
  const transition = f.service.transitionPublishedEpoch(FILE_ID, {
    publish: async () => {
      publishStarted = true;
      await publishGate.promise;
      f.storage.manifest.entries = [{
        path: PATH, fileId: FILE_ID, snapshotId: nextEpoch,
        contentHash: nextHash, revisionId: 'revision-inbound-next',
      }];
      f.storage.revisionBytes = nextBytes;
      f.storage.checkpoint = null;
    },
  });
  await waitFor(() => publishStarted);
  let deliverySettled = false;
  const delivery = Promise.resolve(f.session().options.onCollab?.(collabDelivery(
    'reseed-resync',
    JSON.stringify({ kind: 'resync', fileId: FILE_ID, epoch: nextEpoch }),
  ))).then(() => { deliverySettled = true; });
  await Promise.resolve();
  assert(!deliverySettled, 'transition inbound resolved before reseed completed');
  publishGate.resolve();
  await transition;
  await delivery;
  await waitFor(() => f.session().sent.length === 1);
  const replay = parseCollabWireMessage(f.session().sent[0]!);
  assert(replay?.kind === 'broadcast', 'reseed inbound did not reach fresh authority');
  assertEqual(replay.epoch, nextEpoch, 'reseed inbound routed to stale epoch');
  await f.service.close();
});

defineCase('irreversible transition pause rejects waiting inbound for durable retry', async () => {
  const f = fixture();
  await f.service.start();
  const publishGate = deferred();
  let publishStarted = false;
  const transitionResult = f.service.transitionPublishedEpoch(FILE_ID, {
    publish: async () => {
      publishStarted = true;
      await publishGate.promise;
      throw new Error('promotion outcome is unknown');
    },
  }).then(() => false, () => true);
  await waitFor(() => publishStarted);
  const deliveryResult = Promise.resolve(f.session().options.onCollab?.(collabDelivery(
    'paused-resync',
    JSON.stringify({ kind: 'resync', fileId: FILE_ID, epoch: EPOCH }),
  ))).then(() => false, () => true);
  publishGate.resolve();
  assert(await transitionResult, 'irreversible transition unexpectedly succeeded');
  assert(await deliveryResult, 'waiting inbound was marked dispatched on pause');
  assertEqual(f.service.getState().status, 'paused', 'irreversible failure did not pause authority');
  assertEqual(f.session().sent.length, 0, 'paused transition routed waiting inbound');
  await f.service.close();
});

defineCase('transition inbound waiter bound fails visibly without dispatching overflow', async () => {
  const f = fixture();
  await f.service.start();
  const prepareGate = deferred();
  let prepareStarted = false;
  const transitionResult = f.service.transitionPublishedEpoch(FILE_ID, {
    prepare: async () => {
      prepareStarted = true;
      await prepareGate.promise;
    },
    publish: () => undefined,
  }).then(() => false, () => true);
  await waitFor(() => prepareStarted);
  const payload = JSON.stringify({ kind: 'resync', fileId: FILE_ID, epoch: EPOCH });
  const waiters: Promise<boolean>[] = [];
  for (let index = 0; index < 64; index += 1) {
    waiters.push(Promise.resolve(f.session().options.onCollab?.(
      collabDelivery(`bounded-${index}`, payload),
    )).then(() => false, () => true));
  }
  const overflowRejected = await Promise.resolve(f.session().options.onCollab?.(
    collabDelivery('bounded-overflow', payload),
  )).then(() => false, () => true);
  assert(overflowRejected, 'transition waiter overflow was accepted');
  assertEqual(f.service.getState().status, 'paused', 'waiter overflow was not surfaced');
  prepareGate.resolve();
  assert(await transitionResult, 'overflowed transition unexpectedly completed');
  assert((await Promise.all(waiters)).every(Boolean), 'bounded waiters were marked dispatched on pause');
  assertEqual(f.session().sent.length, 0, 'overflowed transition routed waiting inbound');
  await f.service.close();
});

defineCase('epoch transition rebuilds after prepare failure but pauses after commit is entered', async () => {
  const first = fixture();
  await first.service.start();
  const old = first.service.controller;
  let precommitFailed = false;
  try {
    await first.service.transitionPublishedEpoch(FILE_ID, {
      prepare: () => { throw new Error('validation before publish'); },
      publish: () => { throw new Error('publish must not run'); },
    });
  } catch { precommitFailed = true; }
  assert(precommitFailed, 'precommit failure did not surface');
  assert(first.service.controller !== old, 'stale prepublish controller was restored');
  assert(first.service.controller, 'prepublish failure did not rebuild authority');
  assertEqual(first.service.getState().status, 'active', 'precommit failure stayed paused');
  await first.service.close();

  const second = fixture();
  await second.service.start();
  let committedFailed = false;
  let publishRan = false;
  try {
    await second.service.transitionPublishedEpoch(FILE_ID, {
      commit: () => { throw new Error('action failed after possible commit'); },
      publish: () => { publishRan = true; },
    });
  } catch { committedFailed = true; }
  assert(committedFailed, 'committed transition failure did not surface');
  assert(!publishRan, 'publication ran after the action commit failed');
  assertEqual(second.service.controller, null, 'committed failure exposed stale controller');
  assertEqual(second.service.getState().status, 'paused', 'committed failure did not pause');
  await second.service.close();

  const third = fixture();
  await third.service.start();
  try {
    await third.service.transitionPublishedEpoch(FILE_ID, {
      publish: () => { throw new Error('publication failed after possible promotion'); },
    });
  } catch { /* expected */ }
  assertEqual(third.service.controller, null, 'publish failure exposed stale controller');
  assertEqual(third.service.getState().status, 'paused', 'publish failure did not pause');
  await third.service.close();
});

defineCase('persists accepted authority steps with the live fence and expectedVersion before broadcast', async () => {
  const f = fixture();
  await f.service.start();
  f.service.controller!.onInbound(JSON.stringify({
    kind: 'submit',
    fileId: FILE_ID,
    epoch: EPOCH,
    submission: { clientID: 'reviewer', version: 0, steps: [insertStep()] },
  }), 'reviewer-device');
  await waitFor(() => f.storage.puts.length === 1 && f.session().sent.length === 1);
  const put = f.storage.puts[0]!;
  assertEqual(put.expectedVersion, 0, 'checkpoint CAS version');
  assertEqual(put.fence.holderId, 'tab-owner', 'checkpoint fence holder');
  assertEqual(put.fence.fencingToken, 7, 'checkpoint fencing token');
  assertEqual(put.checkpoint.version, 1, 'next checkpoint version');
  assert(
    f.events.indexOf('checkpoint:put') < f.events.findIndex((event) => event === 'session:send'),
    'checkpoint was not durable before broadcast',
  );
  await f.service.close();
});

defineCase('authenticated hostile remote submit cannot advance owner authority or durable state', async () => {
  const f = fixture();
  await f.service.start();
  const beforeRevision = new Uint8Array(f.storage.revisionBytes);
  const beforeVersion = f.service.controller?.version ?? -1;
  await f.session().options.onCollab?.(collabDelivery('hostile-submit', JSON.stringify({
    kind: 'submit',
    fileId: FILE_ID,
    epoch: EPOCH,
    submission: { clientID: 'forged-reviewer', version: 0, steps: [insertStep()] },
  })));
  await Promise.resolve();
  assertEqual(f.service.controller?.version, beforeVersion, 'remote submit advanced authority');
  assertEqual(f.storage.puts.length, 0, 'remote submit persisted a checkpoint');
  assertEqual(f.session().sent.length, 0, 'remote submit produced an owner broadcast');
  assertEqual(
    new TextDecoder().decode(f.storage.revisionBytes),
    new TextDecoder().decode(beforeRevision),
    'remote submit changed the owner workspace revision',
  );
  await f.service.close();
});

defineCase('epoch transition drains old-generation checkpoint and send work before publication', async () => {
  const f = fixture();
  await f.service.start();
  const staleController = f.service.controller!;
  const putGate = deferred();
  const sendGate = deferred();
  f.storage.putGate = putGate.promise;
  f.session().sendGate = sendGate.promise;
  staleController.onInbound(JSON.stringify({
    kind: 'submit',
    fileId: FILE_ID,
    epoch: EPOCH,
    submission: { clientID: 'reviewer', version: 0, steps: [insertStep()] },
  }), 'reviewer-device');
  await waitFor(() => f.storage.puts.length === 1);

  let publishEntered = false;
  const nextBytes = new TextEncoder().encode('helloR');
  const nextHash = contentHash(nextBytes);
  const transition = f.service.transitionPublishedEpoch(FILE_ID, {
    publish: () => {
      publishEntered = true;
      f.storage.manifest.entries = [{
        path: PATH,
        fileId: FILE_ID,
        snapshotId: 'snapshot-after-drain',
        contentHash: nextHash,
        revisionId: 'revision-after-drain',
      }];
      f.storage.revisionBytes = nextBytes;
      f.storage.checkpoint = null;
    },
  });
  await Promise.resolve();
  assert(!publishEntered, 'publication raced an in-flight checkpoint');

  putGate.resolve();
  await waitFor(() => f.session().sent.length === 1);
  assert(!publishEntered, 'publication raced the old-generation broadcast');
  sendGate.resolve();
  await transition;
  assert(publishEntered, 'publication did not start after generation drain');
  assert(f.service.controller !== staleController, 'stale controller was reattached');

  staleController.broadcastCursor(1);
  await Promise.resolve();
  assertEqual(f.session().sent.length, 1, 'stale controller sent after generation replacement');
  await f.service.close();
});

defineCase('heartbeat lease loss closes transport before pause is surfaced', async () => {
  let closeObservedAtPause = false;
  const f = fixture({
    onState: (state, session) => {
      if (state.pauseKind === 'lease_lost') closeObservedAtPause = session?.closed === true;
    },
  });
  await f.service.start();
  f.leases.rejectHeartbeat = true;
  f.runHeartbeat();
  await waitFor(() => f.service.getState().pauseKind === 'lease_lost');
  assert(f.session().closed, 'transport remained open after lease loss');
  assert(closeObservedAtPause, 'pause observer ran before transport close');
  assertEqual(f.service.session, null, 'lost session remained externally reachable');
  assertEqual(f.service.controller, null, 'fenced controller remained externally reachable');
  assertEqual(f.service.getState().lease, null, 'lost fence removed');
  await f.service.close();
});

defineCase('epoch transition atomically reseeds every configured file from the promoted manifest', async () => {
  const initialBodies = new Map<string, Uint8Array>([
    [PATH, BASE_BYTES],
    [SECOND_PATH, SECOND_BYTES],
  ]);
  const f = fixture({
    files: [BINDING, SECOND_BINDING],
    revisionBodies: initialBodies,
  });
  await f.service.start();
  const nextFirstBytes = new TextEncoder().encode('first next');
  const nextSecondBytes = new TextEncoder().encode('second next');
  const nextFirst = {
    ...BINDING,
    revisionId: 'revision-first-next',
    contentHash: contentHash(nextFirstBytes),
    epoch: 'snapshot-first-next',
  };
  const nextSecond = {
    ...SECOND_BINDING,
    revisionId: 'revision-second-next',
    contentHash: contentHash(nextSecondBytes),
    epoch: 'snapshot-second-next',
  };
  const bindings = await f.service.transitionPublishedEpoch(FILE_ID, {
    publish: () => {
      f.storage.manifest.entries = [nextFirst, nextSecond].map((binding) => ({
        path: binding.path,
        fileId: binding.fileId,
        snapshotId: binding.epoch,
        contentHash: binding.contentHash,
        revisionId: binding.revisionId,
      }));
      f.storage.revisionBodies.set(PATH, nextFirstBytes);
      f.storage.revisionBodies.set(SECOND_PATH, nextSecondBytes);
      f.storage.checkpoint = null;
    },
  });
  assertEqual(bindings.length, 2, 'complete promoted binding count');
  assertEqual(bindings[1]?.epoch, nextSecond.epoch, 'sibling promoted epoch');
  await f.session().options.onCollab?.({
    envelopeId: 'second-resync',
    source: 'network',
    payload: JSON.stringify({
      kind: 'resync', fileId: SECOND_FILE_ID, epoch: nextSecond.epoch,
    }),
    sender: {
      deviceId: 'reviewer-device', participantId: 'reviewer',
      publicEncryptionKey: 'key', publicSigningKey: 'key', selfSignature: 'signature',
      client: 'attn-browser', kind: 'reviewer',
    },
  });
  await waitFor(() => f.session().sent.length === 1);
  const resync = parseCollabWireMessage(f.session().sent[0]!);
  assert(resync?.kind === 'broadcast', 'sibling authority did not use promoted generation');
  assertEqual(resync?.epoch, nextSecond.epoch, 'sibling broadcast epoch');
  await f.service.close();
});

defineCase('bounded rollover blocks old authority, proves promotion, and reseeds fresh epoch', async () => {
  const oldCheckpoint: BrowserCollabCheckpoint = {
    v: 1,
    kind: 'collab_authority_checkpoint',
    roomId: ROOM_ID,
    fileId: FILE_ID,
    epoch: EPOCH,
    base: { kind: 'snapshot', id: EPOCH },
    version: 1,
    steps: [insertStep() as BrowserCollabCheckpoint['steps'][number]],
    clientIDs: ['reviewer'],
  };
  let rollovers = 0;
  let proposedText = '';
  let proposedVersion = -1;
  const ordering: string[] = [];
  const nextBytes = new TextEncoder().encode('helloRS');
  const nextHash = contentHash(nextBytes);
  const nextBinding = {
    fileId: FILE_ID,
    path: PATH,
    revisionId: 'revision-next',
    contentHash: nextHash,
    epoch: 'snapshot-next',
  };
  const f = fixture({
    checkpoint: oldCheckpoint,
    rollover: {
      maxSteps: 2,
      onRequired: (input) => {
        ordering.push('publication');
        rollovers += 1;
        proposedText = input.doc.textContent;
        proposedVersion = input.checkpoint.version;
        f.storage.manifest.entries = [{
          path: PATH, fileId: FILE_ID, snapshotId: nextBinding.epoch,
          contentHash: nextHash, revisionId: nextBinding.revisionId,
        }];
        f.storage.revisionBytes = nextBytes;
        f.storage.checkpoint = null;
      },
    },
    onState: (state) => {
      if (state.status === 'transitioning') ordering.push('blocked');
      if (state.status === 'active' && ordering.includes('publication')) ordering.push('reseeded');
    },
  });
  await f.service.start();
  f.service.controller!.onInbound(JSON.stringify({
    kind: 'submit',
    fileId: FILE_ID,
    epoch: EPOCH,
    submission: { clientID: 'reviewer', version: 1, steps: [insertStep('S', 7)] },
  }), 'reviewer-device');
  await waitFor(() => f.service.getState().status === 'active' && rollovers === 1);
  assertEqual(rollovers, 1, 'rollover callback count');
  assertEqual(f.storage.puts.length, 0, 'threshold checkpoint was not committed');
  assertEqual(f.session().sent.length, 0, 'threshold batch was not broadcast');
  assertEqual(proposedText, 'helloRS', 'rollover received the exact proposed document');
  assertEqual(proposedVersion, 2, 'rollover received the exact proposed checkpoint');
  assertEqual(ordering.join(','), 'blocked,publication,reseeded', 'rollover transition ordering');
  assert(f.service.controller, 'fresh controller missing after reseed');
  assertEqual(f.service.getState().pausedFileId, null, 'rollover stayed paused after reseed');
  await f.service.close();
});

async function run(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const test of cases) {
    const result = await test();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? ''}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`browser-owner-authority: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

void run();
