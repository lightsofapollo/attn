import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { sha256 } from '@noble/hashes/sha2.js';

import { assembleBrowserEvent, type AssembledBrowserEvent } from './browser-envelope';
import {
  base64UrlEncode,
  contentHash,
  deriveRoomId,
  deriveRoomIdV3,
  deriveRoomKeyTreeV3,
  deriveRoomKeys,
} from './browser-crypto';
import {
  BrowserOwnerWorkspaceRuntime,
  type BrowserOwnerWorkspaceAuthority,
  type BrowserOwnerWorkspaceRuntimeOptions,
} from './browser-owner-workspace-runtime';
import type { CreateOwnedRoomOptions, OwnedRoomBootstrapV3 } from './browser-owner-bootstrap';
import type {
  BrowserOwnerAuthorityFile,
  BrowserOwnerAuthorityOptions,
  BrowserOwnerAuthorityState,
  BrowserPublishedEpochTransition,
  BrowserPublishedEpochTransitionPhases,
} from './browser-owner-authority';
import { BrowserStorage } from './browser-storage';
import { generateBrowserIdentity, type BrowserSessionState } from './browser-session';
import {
  publishBrowserSnapshots,
  type PublishBrowserSnapshotsOptions,
  type SnapshotPublicationOutbox,
} from './browser-snapshot-publisher';
import { inviteCapabilityFrom } from './browser-workspace-share';
import {
  BrowserShareOwnerRelayError,
  digestShareSnapshotManifest,
  type BrowserShareRelayRecord,
  type BrowserShareUpsertRequest,
  type ManagedShareSnapshotRef,
} from './browser-share-owner';
import type {
  BrowserShareOwnerRelayPort,
  BrowserWorkspaceShareOutbox,
  BrowserWorkspaceShareRequest,
} from './browser-workspace-sharing';
import type { MailboxEnvelope, RoomPolicy } from './browser-ws';
import type { Anchor, ReviewEvent } from '../types';

Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });

interface CaseResult { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void>): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.stack : String(error) };
    }
  });
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

let databaseCounter = 0;
async function openStorage(now: () => number): Promise<BrowserStorage> {
  databaseCounter += 1;
  return BrowserStorage.open({
    indexedDB: new IDBFactory(),
    databaseName: `attn-owner-runtime-${databaseCounter}`,
    createIfMissing: true,
    filesystem: null,
    navigator: null,
    now,
  });
}

const POLICY: RoomPolicy = {
  mode: 'hybrid',
  maxPeers: 8,
  maxSnapshotBytes: 5 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxEvents: 500,
  expiresAt: 1_900_000_000_000,
  powBits: 12,
  deleteEventsAfterOwnerAck: false,
  allowBrowser: true,
  allowRemoteAgents: true,
};

function opaque(fill: number): string {
  return base64UrlEncode(new Uint8Array(16).fill(fill));
}

function bootstrapFromOptions(options: CreateOwnedRoomOptions): OwnedRoomBootstrapV3 {
  assert(options.roomSecret, 'sharing coordinator supplies its prepared room secret');
  assert(options.identity, 'sharing coordinator supplies its prepared owner identity');
  assert(options.policy, 'sharing coordinator supplies its prepared room policy');
  const roomSecret = new Uint8Array(options.roomSecret);
  return {
    roomId: deriveRoomIdV3(roomSecret),
    roomSecret,
    keys: deriveRoomKeyTreeV3(roomSecret),
    identity: options.identity,
    policy: options.policy,
    commentGrantSignature: base64UrlEncode(new Uint8Array(64).fill(3)),
    suggestGrantSignature: base64UrlEncode(new Uint8Array(64).fill(5)),
    created: true,
  };
}

class MemoryShareRelay implements BrowserShareOwnerRelayPort {
  private record: BrowserShareRelayRecord | null = null;
  constructor(private readonly shareId: string) {}
  async upsert(request: BrowserShareUpsertRequest): Promise<BrowserShareRelayRecord> {
    this.record = { v: 3, shareId: this.shareId, ownerSigningKey: request.ownerSigningKey,
      epoch: request.epoch, revision: request.revision,
      ...(request.currentRoomId === null ? {} : { currentRoomId: request.currentRoomId }),
      snapshots: structuredClone(request.snapshots), placeholders: [],
      manifestDigest: digestShareSnapshotManifest(request.snapshots), manifestDigestValid: true, updatedAt: 1_800_000_000_000,
      expiresAt: 1_900_000_000_000, mailbox: { count: 0, bytes: 0, latestSeq: 0 } };
    return structuredClone(this.record);
  }
  async fetchWithViewCapability(): Promise<BrowserShareRelayRecord> {
    if (!this.record) throw new BrowserShareOwnerRelayError(404, 'fetch');
    return structuredClone(this.record);
  }
  // Staging contract: uploads return a ref without touching the public
  // record; the commit upsert is the only observable mutation.
  async uploadSnapshot(fileId: string, snapshotId: string, ciphertext: Uint8Array): Promise<ManagedShareSnapshotRef> {
    assert(this.record, 'dark share exists');
    return { fileId, snapshotId, ciphertextBytes: ciphertext.length,
      ciphertextSha256: base64UrlEncode(sha256(ciphertext)), uploadedAt: 1_800_000_000_001 };
  }
  async fetchMailbox(): Promise<never> { throw new Error('empty mailbox must not be fetched'); }
  async ackMailbox(): Promise<void> { throw new Error('empty mailbox must not be ACKed'); }
  async revoke(): Promise<void> { this.record = null; }
}

function memoryShareRelayFactory() {
  let relay: MemoryShareRelay | null = null;
  return (options: { shareId: string }) => (relay ??= new MemoryShareRelay(options.shareId));
}

const testIndexBuilder = async (markdown: Uint8Array) => ({
  docHash: base64UrlEncode(sha256(markdown)), canonicalEncoding: 'utf8-bytes' as const,
  lineCount: new TextDecoder().decode(markdown).split('\n').length, blocks: [], headings: [],
});

class AckingShareOutbox implements BrowserWorkspaceShareOutbox {
  readonly envelopes: MailboxEnvelope[] = [];

  constructor(
    private readonly storage: BrowserStorage,
    private readonly roomId: string,
    private readonly events: string[],
    private readonly failFlush = false,
  ) {}

  async initialize(): Promise<void> {
    this.events.push('outbox-initialize');
  }

  async enqueueBatchDurably(envelopes: readonly MailboxEnvelope[]): Promise<number> {
    for (const envelope of envelopes) {
      const existing = this.envelopes.find((item) => item.envelopeId === envelope.envelopeId);
      if (!existing) this.envelopes.push(structuredClone(envelope));
    }
    this.events.push('outbox-adopt');
    return envelopes.length;
  }

  async flushNow(): Promise<void> {
    this.events.push('outbox-flush');
    if (this.failFlush) throw new Error('relay offline');
    await this.storage.acknowledge(
      this.roomId,
      this.envelopes,
      this.envelopes.map((envelope, index) => ({
        envelopeId: envelope.envelopeId,
        serverSeq: index + 1,
      })),
    );
  }

  close(): void {
    this.events.push('outbox-close');
  }
}

function deterministicRandom(): (length: number) => Uint8Array {
  let counter = 1;
  return (length) => new Uint8Array(length).fill(counter++);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function shareRequest(paths = ['notes.md']): BrowserWorkspaceShareRequest {
  return {
    relayUrl: 'https://relay.example',
    browserReviewBase: 'https://attn.sh/review',
    scopeKind: 'file',
    paths,
  };
}

function snapshotPublisher(options: PublishBrowserSnapshotsOptions): Promise<unknown> {
  return publishBrowserSnapshots({
    ...options,
    indexBuilder: testIndexBuilder,
  });
}

async function seedLocal(storage: BrowserStorage, workspaceId: string, text = 'hello') {
  return storage.workspaces.createWorkspace({
    workspaceId,
    name: workspaceId,
    storagePersisted: true,
    entry: { path: 'notes.md', kind: 'markdown', body: new TextEncoder().encode(text) },
  });
}

async function seedHtmlLocal(storage: BrowserStorage, workspaceId: string) {
  return storage.workspaces.createWorkspace({
    workspaceId,
    name: workspaceId,
    storagePersisted: true,
    entry: {
      path: 'report.html',
      kind: 'html',
      body: new TextEncoder().encode('<main><h1>Quarterly report</h1></main>'),
    },
  });
}

async function seedPublished(storage: BrowserStorage, now: number) {
  const workspaceId = `workspace-${databaseCounter}`;
  const created = await seedLocal(storage, workspaceId);
  const rootKey = await storage.getWorkspaceRootKey(workspaceId);
  assert(rootKey, 'workspace root key');
  const identity = generateBrowserIdentity();
  const roomSecret = new Uint8Array(32).fill(databaseCounter + 7);
  const roomId = deriveRoomId(roomSecret);
  const roomKeys = deriveRoomKeys(roomSecret);
  const capId = opaque(21);
  await storage.shares.bindShare(rootKey, {
    workspaceId,
    capId,
    roomId,
    scopeKind: 'workspace',
    relayUrl: 'https://relay.example',
    capability: inviteCapabilityFrom({
      roomSecret,
      ownerSigningSecret: identity.signingSecret,
      ownerEncryptionSecret: identity.encryptionSecret,
      ownerDeviceId: identity.deviceId,
      ownerParticipantId: identity.participantId,
      policy: POLICY,
    }),
  });
  const pointer = {
    manifestSnapshotId: opaque(22),
    entries: [{
      path: 'notes.md',
      fileId: opaque(23),
      snapshotId: opaque(24),
      contentHash: contentHash(new TextEncoder().encode('hello')),
      revisionId: created.revision.revisionId,
    }],
  };
  const terminal = assembleBrowserEvent({
    eventKey: roomKeys.eventKey,
    signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic,
    roomId,
    authorId: identity.participantId,
    deviceId: identity.deviceId,
    createdAt: now,
    expiresAt: POLICY.expiresAt,
    body: { type: 'suggestion_rejected', suggestionId: 'seed-publication' },
  });
  const leases = storage.leases({ channel: null });
  const fence = await leases.acquire(workspaceId, 'seed-publisher');
  assert(fence, 'seed publication fence');
  await storage.shares.stagePublication(rootKey, workspaceId, capId, pointer, [terminal.envelope], fence);
  await storage.acknowledge(roomId, [terminal.envelope], [{
    envelopeId: terminal.envelope.envelopeId,
    serverSeq: 1,
  }]);
  await storage.shares.commitPublication(rootKey, workspaceId, capId, fence);
  await leases.release(fence);
  leases.close();
  return { workspaceId, roomId, capId, pointer, identity };
}

class FakeAuthority implements BrowserOwnerWorkspaceAuthority {
  private state: BrowserOwnerAuthorityState;
  private createdAt = 1_800_000_000_000;
  readonly controller = null;
  private sessionStorage: BrowserStorage | null = null;

  constructor(
    private readonly options: BrowserOwnerAuthorityOptions,
    private readonly storage: BrowserStorage,
    private readonly events: string[],
    private readonly startResult = true,
  ) {
    this.state = authorityState('idle', options.attachedLease ?? null);
  }

  async start(): Promise<boolean> {
    this.sessionStorage = await this.options.sessionOptions?.storageFactory?.(true) ?? null;
    this.state = authorityState(
      this.startResult ? 'active' : 'paused',
      this.options.attachedLease ?? null,
    );
    this.options.onState?.(this.state);
    return this.startResult;
  }

  async close(): Promise<void> {
    this.events.push('authority-close');
    this.sessionStorage?.close();
    this.sessionStorage = null;
    this.state = authorityState('closed', null);
    this.options.onState?.(this.state);
  }

  getState(): BrowserOwnerAuthorityState { return this.state; }

  prepareTerminalEvent(body: Parameters<BrowserOwnerWorkspaceAuthority['prepareTerminalEvent']>[0]): AssembledBrowserEvent {
    const owner = this.options.owner;
    return assembleBrowserEvent({
      eventKey: owner.keys.eventKey,
      signingSecret: owner.identity.signingSecret,
      signingPublic: owner.identity.signingPublic,
      roomId: owner.roomId,
      authorId: owner.identity.participantId,
      deviceId: owner.identity.deviceId,
      createdAt: this.createdAt++,
      expiresAt: owner.policy.expiresAt,
      body,
    });
  }

  async adoptDurableEnvelope(_envelope: MailboxEnvelope): Promise<void> {
    this.events.push('terminal-adopt');
  }
  async createComment(_anchor: Anchor, _body: string): Promise<ReviewEvent> {
    throw new Error('not used');
  }
  async announceProfile(): Promise<void> {}
  async replyToComment(_anchor: Anchor, _body: string, _threadId: string): Promise<ReviewEvent> {
    throw new Error('not used');
  }
  async resolveComment(_threadId: string): Promise<ReviewEvent> { throw new Error('not used'); }
  async retryOutbox(): Promise<void> {}

  /** Presence bridge seam (attn-37f9) — recorded for cursor-tee assertions. */
  readonly mirroredCursorPayloads: string[] = [];
  mirrorCursorToRoom(payload: string): void {
    this.mirroredCursorPayloads.push(payload);
  }

  /** Simulate the live transport dying under the authority (attn-hh9r):
   * pauseTransport('transport_failed') with the session's terminal error. */
  emitTransportPause(kind: 'room_expired' | 'room_deleted' | 'device_register' | 'network'): void {
    this.state = {
      ...authorityState('paused', this.options.attachedLease ?? null),
      pauseKind: 'transport_failed',
      pauseReason: 'room transport failed',
      session: erroredSession(kind),
    };
    this.options.onState?.(this.state);
  }

  async transitionPublishedEpoch(
    fileId: string,
    phases: BrowserPublishedEpochTransitionPhases,
  ): Promise<readonly BrowserOwnerAuthorityFile[]> {
    this.state = authorityState('transitioning', this.options.attachedLease ?? null);
    this.options.onState?.(this.state);
    const input: BrowserPublishedEpochTransition = {
      workspaceId: this.options.workspaceId,
      roomId: this.options.roomId,
      capId: this.options.capId,
      fileId,
      fence: this.options.attachedLease!,
      terminalPort: this,
      // A real acknowledging outbox: the actual snapshot publisher refuses to
      // commit a publication whose envelopes were never ACKed.
      publicationOutbox: new AckingShareOutbox(this.storage, this.options.roomId, this.events),
    };
    try {
      await phases.prepare?.(input);
      await phases.commit?.(input);
      if (phases.commit) this.events.push('action-committed');
      await phases.publish(input);
      this.events.push('authority-reseed');
      const previous = this.options.files.find((binding) => binding.fileId === fileId)!;
      const entry = await this.storage.workspaces.getEntry(this.options.workspaceId, previous.path);
      assert(entry, 'transition workspace entry');
      const body = await this.storage.workspaces.getRevisionBody(
        this.options.workspaceId,
        previous.path,
        entry.headRevisionId,
      );
      const binding = {
        ...previous,
        revisionId: entry.headRevisionId,
        contentHash: contentHash(body),
        epoch: opaque(31),
      };
      body.fill(0);
      this.state = authorityState('active', this.options.attachedLease ?? null);
      this.options.onState?.(this.state);
      return [binding];
    } catch (error) {
      this.state = {
        ...authorityState('paused', this.options.attachedLease ?? null),
        pauseKind: 'rollover_required',
        pauseReason: error instanceof Error ? error.message : String(error),
      };
      this.options.onState?.(this.state);
      throw error;
    }
  }
}

function erroredSession(
  kind: 'room_expired' | 'room_deleted' | 'device_register' | 'network',
): BrowserSessionState {
  return {
    principal: 'owner', ownerOnline: false, peers: [], liveEditingAvailable: false,
    status: 'error', connection: 'offline', directError: null, roomId: null,
    snapshotContent: null, snapshotDocType: 'markdown', snapshotId: null, fileId: null,
    error: { kind, message: 'room transport failed' }, authoringReady: false,
    grantTier: 'suggest', outboxPending: 0, authoringError: null,
    persistence: 'ephemeral', storagePersisted: null, canRemember: false,
  };
}

function authorityState(
  status: BrowserOwnerAuthorityState['status'],
  lease: BrowserOwnerAuthorityState['lease'],
): BrowserOwnerAuthorityState {
  return {
    status,
    pauseKind: null,
    pauseReason: null,
    pausedFileId: null,
    lease,
    session: null,
  };
}

function runtimeOptions(
  storage: BrowserStorage,
  workspaceId: string,
  extras: Partial<BrowserOwnerWorkspaceRuntimeOptions> = {},
): BrowserOwnerWorkspaceRuntimeOptions {
  return {
    storage,
    workspaceId,
    holderId: `holder-${workspaceId}`,
    collab: { selfClientId: 'self', selfLabel: 'You', selfColor: '#fff' },
    leaseOptions: { channel: null },
    ...extras,
  };
}

defineCase('local-only runtime owns one lease, stays writable, and releases exactly once', async () => {
  let now = 1_700_000_000_000;
  const storage = await openStorage(() => now);
  const workspaceId = 'local-only';
  const created = await seedLocal(storage, workspaceId);
  let pagehide: (() => void) | null = null;
  const first = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    schedule: () => 1,
    cancelScheduled: () => undefined,
    pagehideTarget: {
      addEventListener: (_type, listener) => { pagehide = listener; },
      removeEventListener: () => { pagehide = null; },
    },
  }));
  await first.start();
  equal(first.getState().leaseRole, 'owner', 'first lease role');
  equal(first.getState().writable, true, 'local-only writable');
  equal(first.getState().liveEditingAvailable, true, 'local-only runtime hosts multi-tab co-editing');
  equal(first.getState().localCollab, true, 'local co-editing flag reflects the hub');
  const second = new BrowserOwnerWorkspaceRuntime({
    ...runtimeOptions(storage, workspaceId),
    holderId: 'passive-tab',
  });
  await second.start();
  equal(second.getState().status, 'passive', 'second tab passive');
  const committed = await first.commit({
    path: 'notes.md',
    body: new TextEncoder().encode('local edit'),
    expectedHeadRevisionId: created.revision.revisionId,
  });
  assert(committed.revision.revisionId !== created.revision.revisionId, 'local commit advanced head');
  assert(pagehide, 'pagehide cleanup installed');
  (pagehide as unknown as () => void)();
  await waitFor(() => first.getState().status === 'closed');
  await first.close();
  const current = await storage.leases({ channel: null }).current(workspaceId);
  equal(current?.expiresAt, 0, 'lease released to tombstone');
  await second.close();
  storage.close();
  now += 1;
});

async function openBackgroundResumeHarness(workspaceId: string) {
  let tick = 1_725_000_000_000;
  const now = (): number => (tick += 1);
  const storage = await openStorage(now);
  const created = await seedLocal(storage, workspaceId);
  const events: string[] = [];
  const roomGate = deferred();
  const createdRooms = new Set<string>();
  let createCalls = 0;
  let failResume = false;
  const authorities: FakeAuthority[] = [];
  const sharing: NonNullable<BrowserOwnerWorkspaceRuntimeOptions['sharing']> = {
    now,
    randomBytes: deterministicRandom(),
    createRoom: async (options) => {
      createCalls += 1;
      if (createCalls === 2) {
        await roomGate.promise;
        if (failResume) throw new TypeError('Failed to fetch');
      }
      const bootstrap = bootstrapFromOptions(options);
      const wasCreated = !createdRooms.has(bootstrap.roomId);
      createdRooms.add(bootstrap.roomId);
      return { ...bootstrap, created: wasCreated };
    },
    publish: snapshotPublisher,
    indexBuilder: testIndexBuilder,
    shareRelayFactory: memoryShareRelayFactory(),
    outboxFactory: ({ storage: outboxStorage, credentials }) =>
      new AckingShareOutbox(outboxStorage, credentials.roomId, events),
  };
  const first = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    now,
    sharing,
    authorityFactory: (options) => new FakeAuthority(options, storage, events),
  }));
  await first.start();
  await first.ensureShare(shareRequest());
  await first.close();
  equal(createCalls, 1, 'initial publish prepared the shared room once');

  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    holderId: `${workspaceId}-background-owner`,
    now,
    sharing,
    publisher: snapshotPublisher,
    backgroundShareResume: true,
    authorityFactory: (options) => {
      const authority = new FakeAuthority(options, storage, events);
      authorities.push(authority);
      return authority;
    },
  }));
  return {
    runtime,
    storage,
    created,
    roomGate,
    authorities,
    failNextResume: () => { failResume = true; },
    createCalls: () => createCalls,
  };
}

defineCase('background share resume never gates local owner editing on a stalled room POST', async () => {
  const harness = await openBackgroundResumeHarness('background-resume-stalled');
  await harness.runtime.start();
  await waitFor(() => harness.createCalls() === 2);
  equal(harness.runtime.getState().status, 'active', 'local runtime is active while room POST is pending');
  equal(harness.runtime.getState().writable, true, 'local runtime is writable before relay settles');
  equal(harness.runtime.getState().roomId, null, 'published authority is not claimed before resume');

  const committed = await harness.runtime.commit({
    path: 'notes.md',
    body: new TextEncoder().encode('saved while relay POST was stalled'),
    expectedHeadRevisionId: harness.created.revision.revisionId,
  });
  assert(committed.revision.revisionId !== harness.created.revision.revisionId,
    'local commit completed independently of the stalled share resume');

  harness.roomGate.resolve();
  await waitFor(() => {
    const state = harness.runtime.getState();
    return harness.authorities.length === 1
      && state.roomId !== null
      && state.status === 'active'
      && state.liveEditingAvailable;
  }, 3000);
  equal(harness.runtime.getState().writable, true, 'authority upgrade preserves local writability');
  equal(harness.runtime.getState().status, 'active', 'successful background resume activates sharing');
  await harness.runtime.close();
  harness.storage.close();
});

defineCase('failed background share resume keeps local editing writable and surfaces the error', async () => {
  const harness = await openBackgroundResumeHarness('background-resume-failed');
  harness.failNextResume();
  await harness.runtime.start();
  await waitFor(() => harness.createCalls() === 2);

  const committed = await harness.runtime.commit({
    path: 'notes.md',
    body: new TextEncoder().encode('safe local edit during quota failure'),
    expectedHeadRevisionId: harness.created.revision.revisionId,
  });
  assert(committed.revision.revisionId !== harness.created.revision.revisionId,
    'quota failure cannot hold the local commit queue');

  harness.roomGate.resolve();
  await waitFor(() => harness.runtime.getState().status === 'error', 3000);
  equal(harness.runtime.getState().writable, true, 'failed sharing resume preserves local writes');
  equal(harness.runtime.getState().localCollab, true, 'failed sharing resume keeps local tab collaboration');
  assert(harness.runtime.getState().reason?.includes('Failed to fetch'), 'relay failure is visible');
  await harness.runtime.close();
  harness.storage.close();
});

defineCase('local heartbeat loss becomes passive and close cannot release the takeover lease', async () => {
  let now = 100;
  let heartbeat: (() => void) | null = null;
  const storage = await openStorage(() => now);
  const workspaceId = 'lease-loss';
  await seedLocal(storage, workspaceId);
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    leaseOptions: { channel: null, leaseDurationMs: 50 },
    heartbeatIntervalMs: 10,
    schedule: (callback) => { heartbeat = callback; return 1; },
    cancelScheduled: () => undefined,
  }));
  await runtime.start();
  now = 200;
  const takeoverManager = storage.leases({ channel: null, leaseDurationMs: 50, now: () => now });
  const takeover = await takeoverManager.acquire(workspaceId, 'takeover-tab');
  assert(takeover, 'takeover acquired expired lease');
  assert(heartbeat, 'local heartbeat scheduled');
  (heartbeat as unknown as () => void)();
  await waitFor(() => runtime.getState().leaseRole === 'passive');
  equal(runtime.getState().writable, false, 'lost runtime fenced');
  await runtime.close();
  equal((await takeoverManager.current(workspaceId))?.holderId, 'takeover-tab', 'close preserved winner');
  takeoverManager.close();
  storage.close();
});

defineCase('ensureShare activates authority on the runtime-owned lease without reacquiring', async () => {
  const now = 1_720_000_000_000;
  const storage = await openStorage(() => now);
  const workspaceId = 'share-activate-attached-lease';
  await seedLocal(storage, workspaceId);
  const events: string[] = [];
  const attachedLeases: BrowserOwnerAuthorityOptions['attachedLease'][] = [];
  const randomBytes = deterministicRandom();
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    now: () => now,
    authorityFactory: (options) => {
      attachedLeases.push(options.attachedLease);
      return new FakeAuthority(options, storage, events);
    },
    sharing: {
      now: () => now,
      randomBytes,
      createRoom: async (options) => bootstrapFromOptions(options),
      publish: snapshotPublisher,
      indexBuilder: testIndexBuilder,
      shareRelayFactory: memoryShareRelayFactory(),
      outboxFactory: ({ storage: outboxStorage, credentials }) =>
        new AckingShareOutbox(outboxStorage, credentials.roomId, events),
    },
  }));
  await runtime.start();
  const ownedFence = runtime.fence;
  assert(ownedFence, 'runtime owns a workspace lease before sharing');

  const view = await runtime.ensureShare(shareRequest());
  assert(view.invite, 'published share exposes its invite');
  equal(attachedLeases.length, 1, 'one authority instance activated');
  equal(
    attachedLeases[0]?.fencingToken,
    ownedFence.fencingToken,
    'authority receives the existing runtime fence',
  );
  equal(runtime.fence?.fencingToken, ownedFence.fencingToken, 'share activation preserves fence token');
  equal(runtime.fence?.holderId, ownedFence.holderId, 'share activation preserves lease holder');
  equal(runtime.getState().roomId, view.roomId, 'active runtime exposes published room');
  equal(runtime.getState().liveEditingAvailable, true, 'live authority becomes available');

  const competing = storage.leases({ channel: null });
  equal(
    await competing.acquire(workspaceId, 'competing-tab'),
    null,
    'runtime continues to own the sole workspace lease',
  );
  competing.close();
  await runtime.close();
  storage.close();
});

defineCase('an HTML-only share starts durable review but never exposes Markdown collab', async () => {
  const now = 1_720_000_000_000;
  const storage = await openStorage(() => now);
  const workspaceId = 'share-html-only-runtime';
  await seedHtmlLocal(storage, workspaceId);
  const events: string[] = [];
  const authorityFiles: BrowserOwnerAuthorityFile[][] = [];
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    now: () => now,
    authorityFactory: (options) => {
      authorityFiles.push([...options.files]);
      return new FakeAuthority(options, storage, events);
    },
    sharing: {
      now: () => now,
      randomBytes: deterministicRandom(),
      createRoom: async (options) => bootstrapFromOptions(options),
      publish: snapshotPublisher,
      indexBuilder: testIndexBuilder,
      shareRelayFactory: memoryShareRelayFactory(),
      outboxFactory: ({ storage: outboxStorage, credentials }) =>
        new AckingShareOutbox(outboxStorage, credentials.roomId, events),
    },
  }));
  await runtime.start();
  const view = await runtime.ensureShare(shareRequest(['report.html']));
  assert(view.invite, 'HTML publication mints a review invite');
  equal(authorityFiles[0]?.[0]?.docType, 'html', 'authority recognizes the review-only document');
  equal(runtime.getState().bindings[0]?.docType, 'html', 'runtime retains the HTML binding');
  equal(await runtime.getCollabSeed('report.html'), null, 'HTML never opts into Markdown co-editing');
  await runtime.close();
  storage.close();
});

defineCase('ensureShare resumes persisted pending ciphertext before activating authority', async () => {
  const now = 1_720_000_000_000;
  const storage = await openStorage(() => now);
  const workspaceId = 'share-pending-runtime-resume';
  await seedLocal(storage, workspaceId);
  const events: string[] = [];
  const outboxes: AckingShareOutbox[] = [];
  let createCalls = 0;
  let publishCalls = 0;
  const sharing: NonNullable<BrowserOwnerWorkspaceRuntimeOptions['sharing']> = {
    now: () => now,
    randomBytes: deterministicRandom(),
    createRoom: async (options) => {
      createCalls += 1;
      return bootstrapFromOptions(options);
    },
    publish: async (options) => {
      publishCalls += 1;
      return snapshotPublisher(options);
    },
    indexBuilder: testIndexBuilder,
    shareRelayFactory: memoryShareRelayFactory(),
    outboxFactory: ({ storage: outboxStorage, credentials }) => {
      const outbox = new AckingShareOutbox(
        outboxStorage,
        credentials.roomId,
        events,
        outboxes.length === 0,
      );
      outboxes.push(outbox);
      return outbox;
    },
  };
  const first = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    holderId: 'pending-first-tab',
    now: () => now,
    sharing,
  }));
  await first.start();
  let failed = false;
  try {
    await first.ensureShare(shareRequest());
  } catch (error) {
    failed = error instanceof Error && error.message === 'relay offline';
  }
  assert(failed, 'initial publication stops at the simulated relay outage');
  const pending = await first.inspectShare('https://attn.sh/review');
  assert(pending, 'pending ownership remains inspectable');
  equal(pending.publication, 'pending', 'failed publication remains pending');
  equal(pending.invite, null, 'pending publication does not expose an invite');
  equal(first.getState().roomId, null, 'authority does not start before promotion');
  const exactPendingBatch = JSON.stringify(outboxes[0]?.envelopes);
  await first.close();

  let authorityStarts = 0;
  const second = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    holderId: 'pending-resume-tab',
    now: () => now,
    sharing,
    authorityFactory: (options) => {
      authorityStarts += 1;
      return new FakeAuthority(options, storage, events);
    },
  }));
  await second.start();
  const resumed = await second.inspectShare('https://attn.sh/review');
  assert(resumed, 'route startup promotes the recoverable share');
  equal(createCalls, 2, 'persisted resume idempotently rejoins the same relay room');
  equal(publishCalls, 1, 'persisted resume does not assemble fresh ciphertext');
  equal(JSON.stringify(outboxes[1]?.envelopes), exactPendingBatch, 'resume adopts exact pending batch');
  equal(resumed.roomId, pending.roomId, 'resume keeps prepared room identity');
  equal(resumed.capId, pending.capId, 'resume keeps prepared capability identity');
  assert(resumed.invite, 'invite appears after resumed publication promotes');
  equal(authorityStarts, 1, 'authority starts after automatic resumed promotion');
  equal(second.getState().liveEditingAvailable, true, 'resumed runtime activates live authority');
  await second.close();
  storage.close();
});

defineCase('stopShare tears down authority, resets runtime state, and recreates fresh ownership', async () => {
  const now = 1_720_000_000_000;
  const storage = await openStorage(() => now);
  const workspaceId = 'share-stop-recreate-runtime';
  await seedLocal(storage, workspaceId);
  const events: string[] = [];
  let authorityInstances = 0;
  let deleteCalls = 0;
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    now: () => now,
    authorityFactory: (options) => {
      authorityInstances += 1;
      return new FakeAuthority(options, storage, events);
    },
    sharing: {
      now: () => now,
      randomBytes: deterministicRandom(),
      createRoom: async (options) => bootstrapFromOptions(options),
      deleteRoom: async () => {
        deleteCalls += 1;
        events.push('relay-delete');
        return true;
      },
      publish: snapshotPublisher,
      indexBuilder: testIndexBuilder,
      shareRelayFactory: memoryShareRelayFactory(),
      outboxFactory: ({ storage: outboxStorage, credentials }) =>
        new AckingShareOutbox(outboxStorage, credentials.roomId, events),
    },
  }));
  await runtime.start();
  const first = await runtime.ensureShare(shareRequest());
  equal(authorityInstances, 1, 'first share starts one authority');

  await runtime.stopShare();
  equal(deleteCalls, 1, 'stop performs one owner-authorized relay deletion');
  assert(
    events.indexOf('relay-delete') < events.indexOf('authority-close'),
    'relay deletion succeeds before local authority shuts down',
  );
  equal((await storage.shares.listShares(workspaceId)).length, 0, 'stop erases local capability');
  equal(runtime.getState().status, 'active', 'local-only runtime remains active after stop');
  equal(runtime.getState().leaseRole, 'owner', 'runtime retains workspace lease after stop');
  equal(runtime.getState().writable, true, 'local authoring remains writable after stop');
  equal(runtime.getState().liveEditingAvailable, true, 'stop falls back to local multi-tab co-editing');
  equal(runtime.getState().localCollab, true, 'local co-editing hub hosts after stop');
  equal(runtime.getState().roomId, null, 'stopped room identity is cleared');
  equal(runtime.getState().capId, null, 'stopped capability identity is cleared');
  equal(runtime.getState().bindings.length, 0, 'stopped share bindings are cleared');
  equal(runtime.getState().authority, null, 'stopped authority state is cleared');

  const recreated = await runtime.ensureShare(shareRequest());
  assert(recreated.roomId !== first.roomId, 'recreate mints a fresh room secret and room ID');
  assert(recreated.capId !== first.capId, 'recreate mints a fresh capability ID');
  equal(authorityInstances, 2, 'recreate starts a fresh authority instance');
  equal(runtime.getState().roomId, recreated.roomId, 'recreated runtime exposes new room');
  equal(runtime.getState().liveEditingAvailable, true, 'recreated authority is live');
  await runtime.close();
  storage.close();
});

defineCase('accepted action commits before snapshot publication and authority reseed', async () => {
  const now = 1_700_000_000_000;
  const storage = await openStorage(() => now);
  const seeded = await seedPublished(storage, now);
  const events: string[] = [];
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, seeded.workspaceId, {
    now: () => now,
    authorityFactory: (options) => new FakeAuthority(options, storage, events),
    publisher: async (options) => {
      const live = await storage.workspaces.getEntry(seeded.workspaceId, 'notes.md');
      assert(live, 'published live entry');
      equal(options.entries[0]?.revisionId, live.headRevisionId, 'publisher used accepted head');
      events.push('snapshot-published');
    },
  }));
  await runtime.start();
  const seed = await runtime.getCollabSeed('notes.md');
  equal(seed?.markdown, 'hello', 'collab seed uses exact published revision');
  equal(seed?.epoch, seeded.pointer.entries[0]!.snapshotId, 'collab seed epoch');
  const head = await storage.workspaces.getEntry(seeded.workspaceId, 'notes.md');
  assert(head, 'initial head');
  const result = await runtime.accept({
    path: 'notes.md',
    suggestionId: 'suggestion-1',
    operation: { kind: 'replace', expectedText: 'hello', replacement: 'hi' },
    resolvedAnchor: {
      status: 'exact', confidence: 1,
      currentRange: { byteRange: [0, 5], lineRange: [0, 0] },
      reason: 'base_hash_match',
    },
  });
  equal(result.status, 'committed', 'accept committed');
  assert(events.indexOf('action-committed') < events.indexOf('snapshot-published'), 'action before publish');
  assert(events.indexOf('snapshot-published') < events.indexOf('authority-reseed'), 'publish before reseed');
  equal(await storage.workspaces.getHeadBody(seeded.workspaceId, 'notes.md').then((bytes) => {
    const text = new TextDecoder().decode(bytes); bytes.fill(0); return text;
  }), 'hi', 'accepted body durable');
  await runtime.commit({
    path: 'notes.md',
    body: new TextEncoder().encode('owner follow-up'),
  });
  equal(await storage.workspaces.getHeadBody(seeded.workspaceId, 'notes.md').then((bytes) => {
    const text = new TextDecoder().decode(bytes); bytes.fill(0); return text;
  }), 'owner follow-up', 'autosave continues from the action-advanced head');
  await runtime.close();
  assert(await storage.workspaces.getWorkspace(seeded.workspaceId), 'authority close kept app storage open');
  storage.close();
});

defineCase('paused shared startup keeps durable room identity visible', async () => {
  const now = 1_700_000_000_000;
  const storage = await openStorage(() => now);
  const seeded = await seedPublished(storage, now);
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, seeded.workspaceId, {
    now: () => now,
    authorityFactory: (options) => new FakeAuthority(options, storage, [], false),
  }));
  await runtime.start();
  equal(runtime.getState().status, 'paused', 'shared authority paused');
  equal(runtime.getState().roomId, seeded.roomId, 'durable room identity retained');
  equal(runtime.getState().capId, seeded.capId, 'durable capability identity retained');
  equal(runtime.getState().bindings.length, 1, 'published binding retained');
  equal(runtime.getState().writable, true, 'local owner editing remains writable');
  equal(runtime.getState().liveEditingAvailable, false, 'live editing stays unavailable');
  await runtime.close();
  storage.close();
});

defineCase('post-commit publication failure returns durable acceptance as pending', async () => {
  const now = 1_700_000_000_000;
  const storage = await openStorage(() => now);
  const seeded = await seedPublished(storage, now);
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, seeded.workspaceId, {
    now: () => now,
    authorityFactory: (options) => new FakeAuthority(options, storage, []),
    publisher: async () => { throw new Error('relay unavailable'); },
  }));
  await runtime.start();
  const head = await storage.workspaces.getEntry(seeded.workspaceId, 'notes.md');
  assert(head, 'initial head');
  const result = await runtime.accept({
    path: 'notes.md', suggestionId: 'suggestion-pending',
    operation: { kind: 'replace', expectedText: 'hello', replacement: 'durable' },
    resolvedAnchor: {
      status: 'exact', confidence: 1,
      currentRange: { byteRange: [0, 5], lineRange: [0, 0] },
      reason: 'base_hash_match',
    },
  });
  equal(result.status, 'committed', 'durable result returned');
  assert(result.status === 'committed' && result.deliveryPending, 'publication failure surfaced pending');
  assert(result.status === 'committed' && result.deliveryError?.includes('relay unavailable'), 'pending reason');
  equal(runtime.getState().writable, true, 'local editor remains writable after authority pause');
  equal(runtime.getState().liveEditingAvailable, false, 'live authority paused');
  await runtime.close();
  storage.close();
});

defineCase('reviewed three-way context stays runtime-owned until explicit apply', async () => {
  const now = 1_700_000_000_000;
  const storage = await openStorage(() => now);
  const seeded = await seedPublished(storage, now);
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, seeded.workspaceId, {
    now: () => now,
    authorityFactory: (options) => new FakeAuthority(options, storage, []),
    publisher: async () => undefined,
  }));
  await runtime.start();
  const prepared = await runtime.accept({
    path: 'notes.md', suggestionId: 'suggestion-reviewed',
    operation: { kind: 'replace', expectedText: 'different', replacement: 'proposed' },
    resolvedAnchor: {
      status: 'exact', confidence: 1,
      currentRange: { byteRange: [0, 5], lineRange: [0, 0] },
      reason: 'base_hash_match',
    },
  });
  equal(prepared.status, 'needs_review', 'semantic drift requires review');
  assert(prepared.status === 'needs_review' && prepared.verdict.kind === 'requires_three_way', 'three-way verdict');
  const applied = await runtime.applySuggestion({
    path: 'notes.md', suggestionId: 'suggestion-reviewed', replacement: 'merged',
  });
  equal(applied.status, 'committed', 'reviewed replacement committed');
  const bytes = await storage.workspaces.getHeadBody(seeded.workspaceId, 'notes.md');
  equal(new TextDecoder().decode(bytes), 'merged', 'explicit reviewed replacement applied');
  bytes.fill(0);
  await runtime.close();
  storage.close();
});

defineCase('owner commits republish the durable share so /s/ reviewers refresh', async () => {
  const now = 1_720_000_000_000;
  const storage = await openStorage(() => now);
  const workspaceId = 'share-republish-on-commit';
  await seedLocal(storage, workspaceId);
  const events: string[] = [];
  const uploaded: string[] = [];
  let relay: MemoryShareRelay | null = null;
  const shareRelayFactory = (options: { shareId: string }) => {
    if (!relay) {
      relay = new MemoryShareRelay(options.shareId);
      const original = relay.uploadSnapshot.bind(relay);
      relay.uploadSnapshot = async (fileId, snapshotId, ciphertext) => {
        uploaded.push(`${fileId}@${snapshotId}`);
        return original(fileId, snapshotId, ciphertext);
      };
    }
    return relay;
  };
  const scheduled: (() => void)[] = [];
  const cancelled: unknown[] = [];
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    now: () => now,
    schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
    cancelScheduled: (handle) => { cancelled.push(handle); },
    authorityFactory: (options) => new FakeAuthority(options, storage, events),
    publisher: snapshotPublisher,
    sharing: {
      now: () => now,
      randomBytes: deterministicRandom(),
      // Idempotent rejoin like the real relay: only the first create per room
      // reports `created`, so mid-session reconciles do not republish genesis.
      createRoom: (() => {
        const createdRooms = new Set<string>();
        return async (options: Parameters<typeof bootstrapFromOptions>[0]) => {
          const bootstrap = bootstrapFromOptions(options);
          const created = !createdRooms.has(bootstrap.roomId);
          createdRooms.add(bootstrap.roomId);
          return { ...bootstrap, created };
        };
      })(),
      publish: snapshotPublisher,
      indexBuilder: testIndexBuilder,
      shareRelayFactory,
      outboxFactory: ({ storage: outboxStorage, credentials }) =>
        new AckingShareOutbox(outboxStorage, credentials.roomId, events),
    },
  }));
  await runtime.start();
  await runtime.ensureShare(shareRequest());
  const publishedUploads = uploaded.length;
  assert(publishedUploads > 0, 'publication uploads the initial durable snapshot');

  const scheduledBeforeCommit = scheduled.length;
  await runtime.commit({
    path: 'notes.md',
    body: new TextEncoder().encode('owner keeps typing after sharing'),
  });
  assert(scheduled.length > scheduledBeforeCommit, 'commit schedules a debounced republish');
  // Trailing debounce: a second commit cancels and replaces the pending run.
  const cancelledBefore = cancelled.length;
  await runtime.commit({ path: 'notes.md', body: new TextEncoder().encode('typed tail') });
  assert(cancelled.length > cancelledBefore, 'a commit burst reschedules the pending republish');
  // Mid-session flush must NOT rotate the epoch for plain typing — the live
  // room carries it; only accept-advanced manifests mirror here.
  scheduled[scheduled.length - 1]!();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  equal(uploaded.length, publishedUploads, 'mid-session typing does not republish the durable share');

  // Owner leaves: close() publishes the moved heads as a fresh generation and
  // mirrors it, so late/offline reviewers get the final content.
  await runtime.commit({ path: 'notes.md', body: new TextEncoder().encode('final content') });
  await runtime.close();
  await waitFor(() => uploaded.length > publishedUploads);
  storage.close();
});

// attn-3wgd helpers: force the exact race the promotion gates guard against —
// a co-editing tab commits a fresh head between the publication's staging and
// its promotion (the outbox flush sits exactly between those two steps).
interface HeadMover { remaining: number; commits: number }

function headMovingPublisher(
  storage: BrowserStorage,
  mover: HeadMover,
): (options: PublishBrowserSnapshotsOptions) => Promise<unknown> {
  return (options) => {
    const publication = options.publication;
    assert(publication, 'runtime publication context is always present');
    const inner = options.outbox;
    const outbox: SnapshotPublicationOutbox = {
      enqueueBatchDurably: (envelopes) => inner.enqueueBatchDurably(envelopes),
      flushNow: async () => {
        if (mover.remaining !== 0) {
          mover.remaining -= 1;
          mover.commits += 1;
          await storage.workspaces.commitRevision({
            workspaceId: publication.workspaceId,
            path: 'notes.md',
            body: new TextEncoder().encode(`co-editing commit ${mover.commits}`),
            fence: publication.fence,
          });
        }
        await inner.flushNow();
      },
    };
    return snapshotPublisher({ ...options, outbox });
  };
}

async function moveHeadBeforeStartup(storage: BrowserStorage, workspaceId: string): Promise<void> {
  const leases = storage.leases({ channel: null });
  const fence = await leases.acquire(workspaceId, 'refresh-mover');
  assert(fence, 'pre-startup mover fence');
  await storage.workspaces.commitRevision({
    workspaceId,
    path: 'notes.md',
    body: new TextEncoder().encode('moved before the owner tab came back'),
    fence,
  });
  await leases.release(fence);
  leases.close();
}

defineCase('startup republish converges when heads move between staging and promotion (attn-3wgd)', async () => {
  const now = 1_700_000_000_000;
  const storage = await openStorage(() => now);
  const seeded = await seedPublished(storage, now);
  // The owner refreshed after commits landed: startup must republish.
  await moveHeadBeforeStartup(storage, seeded.workspaceId);
  // One more commit lands mid-flight — after staging, before promotion.
  const mover: HeadMover = { remaining: 1, commits: 0 };
  let publishCalls = 0;
  const publisher = headMovingPublisher(storage, mover);
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, seeded.workspaceId, {
    now: () => now,
    authorityFactory: (options) => new FakeAuthority(options, storage, []),
    publisher: (options) => {
      publishCalls += 1;
      return publisher(options);
    },
  }));
  await runtime.start();
  equal(runtime.getState().status, 'active', 'runtime converges to active despite the mid-flight head move');
  equal(runtime.getState().liveEditingAvailable, true, 'live authority available after retry');
  equal(runtime.getState().reason, null, 'no paused banner reason');
  equal(publishCalls, 2, 'exactly one head-moved retry re-stages from the fresh head');
  const rootKey = await storage.getWorkspaceRootKey(seeded.workspaceId);
  assert(rootKey, 'workspace root key');
  const promoted = await storage.shares.loadPromotedManifest(rootKey, seeded.workspaceId, seeded.capId);
  const entry = await storage.workspaces.getEntry(seeded.workspaceId, 'notes.md');
  assert(promoted && entry, 'promoted manifest and live entry exist');
  equal(promoted.entries[0]?.revisionId, entry.headRevisionId, 'promoted manifest reflects the NEW head');
  await runtime.close();
  storage.close();
});

defineCase('continuously moving heads exhaust the bounded retries and pause as before (attn-3wgd)', async () => {
  const now = 1_700_000_000_000;
  const storage = await openStorage(() => now);
  const seeded = await seedPublished(storage, now);
  await moveHeadBeforeStartup(storage, seeded.workspaceId);
  // remaining < 0 never reaches zero: a commit lands on EVERY flush.
  const mover: HeadMover = { remaining: -1, commits: 0 };
  let publishCalls = 0;
  const publisher = headMovingPublisher(storage, mover);
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, seeded.workspaceId, {
    now: () => now,
    authorityFactory: (options) => new FakeAuthority(options, storage, []),
    publisher: (options) => {
      publishCalls += 1;
      return publisher(options);
    },
  }));
  await runtime.start();
  equal(runtime.getState().status, 'paused', 'continuous movement still pauses the authority');
  equal(publishCalls, 3, 'retries are bounded — no infinite republish loop');
  equal(mover.commits, 3, 'each bounded attempt observed exactly one mid-flight commit');
  assert(
    runtime.getState().reason?.includes('published source revision moved before promotion'),
    'pause keeps the promotion gate’s reason',
  );
  equal(runtime.getState().writable, true, 'local editing stays writable while paused');
  equal(runtime.getState().liveEditingAvailable, false, 'live authority stays unavailable while paused');
  await runtime.close();
  storage.close();
});

// attn-hh9r: shared harness for the room-expiry recovery cases — a real
// coordinator/relay/publisher stack with a FakeAuthority whose transport can
// be killed on demand, plus a "wipe" seam (clearing createdRooms makes the
// next createRoom report created:true, exactly like a HARD_MAX_TTL-wiped DO).
interface RoomExpiryHarness {
  runtime: BrowserOwnerWorkspaceRuntime;
  storage: BrowserStorage;
  authorities: FakeAuthority[];
  upserts: Array<{ revision: number; currentRoomId: string | null | undefined }>;
  createdRooms: Set<string>;
  failures: { mailPendingUpserts: number; relayDown: boolean };
  probe: { result: boolean; calls: number };
  deletes: { calls: number };
}

async function openRoomExpiryHarness(workspaceId: string): Promise<RoomExpiryHarness> {
  // Ticking clock: the recovery republishes genesis + snapshots into the
  // recreated room, and envelope ids derive from createdAt — a frozen clock
  // would collide the second publication with the first one's durable
  // ciphertext, which real wall-clock time never does.
  let tick = 1_720_000_000_000;
  const now = (): number => (tick += 1);
  const storage = await openStorage(now);
  await seedLocal(storage, workspaceId);
  const events: string[] = [];
  const authorities: FakeAuthority[] = [];
  const upserts: RoomExpiryHarness['upserts'] = [];
  const createdRooms = new Set<string>();
  const failures = { mailPendingUpserts: 0, relayDown: false };
  const probe = { result: false, calls: 0 };
  const deletes = { calls: 0 };
  let relay: MemoryShareRelay | null = null;
  const runtime = new BrowserOwnerWorkspaceRuntime(runtimeOptions(storage, workspaceId, {
    now,
    roomGoneProbe: async () => { probe.calls += 1; return probe.result; },
    authorityFactory: (options) => {
      const authority = new FakeAuthority(options, storage, events);
      authorities.push(authority);
      return authority;
    },
    sharing: {
      now,
      randomBytes: deterministicRandom(),
      createRoom: async (options) => {
        const bootstrap = bootstrapFromOptions(options);
        const created = !createdRooms.has(bootstrap.roomId);
        createdRooms.add(bootstrap.roomId);
        return { ...bootstrap, created };
      },
      deleteRoom: async ({ roomId }) => {
        deletes.calls += 1;
        createdRooms.delete(roomId);
        return true;
      },
      publish: snapshotPublisher,
      indexBuilder: testIndexBuilder,
      shareRelayFactory: (options) => {
        if (!relay) {
          relay = new MemoryShareRelay(options.shareId);
          const originalUpsert = relay.upsert.bind(relay);
          relay.upsert = async (request) => {
            if (failures.relayDown) throw new BrowserShareOwnerRelayError(503, 'durable share request');
            if (failures.mailPendingUpserts > 0) {
              failures.mailPendingUpserts -= 1;
              throw new BrowserShareOwnerRelayError(409, 'durable share request', 'ATTN_SHARE_MAIL_PENDING');
            }
            upserts.push({ revision: request.revision, currentRoomId: request.currentRoomId });
            return originalUpsert(request);
          };
          const originalFetch = relay.fetchWithViewCapability.bind(relay);
          relay.fetchWithViewCapability = async () => {
            if (failures.relayDown) throw new BrowserShareOwnerRelayError(503, 'durable share request');
            return originalFetch();
          };
        }
        return relay;
      },
      outboxFactory: ({ storage: outboxStorage, credentials }) =>
        new AckingShareOutbox(outboxStorage, credentials.roomId, events),
    },
  }));
  await runtime.start();
  return { runtime, storage, authorities, upserts, createdRooms, failures, probe, deletes };
}

defineCase('authenticated expiry retires stale room metadata before same-epoch recovery', async () => {
  const harness = await openRoomExpiryHarness('share-room-expiry-stale-metadata');
  const view = await harness.runtime.ensureShare(shareRequest());
  const committedRevision = harness.upserts.at(-1)!.revision;

  // The hard deadline passed but the alarm could not clear Durable Object
  // metadata. The room still answers authenticated bootstrap with an expired
  // policy, so a plain idempotent create would return that policy forever.
  assert(harness.createdRooms.has(view.roomId), 'stale expired room still exists');
  harness.authorities[0]!.emitTransportPause('room_expired');
  await waitFor(() => harness.authorities.length === 2 && harness.runtime.getState().status === 'active', 3000);

  equal(harness.deletes.calls, 1, 'owner retires the stale expired generation exactly once');
  assert(harness.createdRooms.has(view.roomId), 'same epoch-derived room identity was recreated');
  equal(harness.runtime.getState().roomId, view.roomId, 'stable room identity survives generation reset');
  equal(harness.runtime.getState().liveEditingAvailable, true, 'fresh authority becomes live');
  assert(harness.upserts.at(-1)!.revision > committedRevision, 'stable share projection advances');
  await harness.runtime.close();
  harness.storage.close();
});

defineCase('mid-life room expiry re-provisions a fresh room under the same durable share (attn-hh9r)', async () => {
  const harness = await openRoomExpiryHarness('share-room-expiry-reprovision');
  const view = await harness.runtime.ensureShare(shareRequest());
  equal(harness.authorities.length, 1, 'initial share starts one authority');
  const committedRevision = harness.upserts.at(-1)!.revision;

  // The relay hard-wipes the 24h room out from under the live authority
  // (HARD_MAX_TTL): the session dies with the relay's own 4002 verdict.
  harness.createdRooms.clear();
  harness.probe.result = true;
  harness.authorities[0]!.emitTransportPause('room_expired');
  await waitFor(() => harness.authorities.length === 2 && harness.runtime.getState().status === 'active', 3000);
  equal(harness.probe.calls, 1, 'expired recovery distinguishes wiped from stale metadata');
  equal(harness.deletes.calls, 0, 'an already-wiped room is recreated without an opaque DELETE');
  equal(harness.runtime.getState().roomId, view.roomId, 're-provision keeps the share-derived room identity');
  equal(harness.runtime.getState().liveEditingAvailable, true, 're-provisioned authority is live');
  equal(harness.runtime.getState().reason, null, 'recovered runtime carries no paused reason');
  const final = harness.upserts.at(-1)!;
  assert(final.revision === committedRevision + 1, 're-provision must land at revision current + 1');
  equal(final.currentRoomId, view.roomId, 're-provision re-points the share record at its room');
  await harness.runtime.close();
  harness.storage.close();
});

defineCase('room re-provision drains and retries once on ATTN_SHARE_MAIL_PENDING (attn-hh9r)', async () => {
  const harness = await openRoomExpiryHarness('share-room-expiry-mail-pending');
  await harness.runtime.ensureShare(shareRequest());
  const committedRevision = harness.upserts.at(-1)!.revision;

  // Reviewer mail lands between the recovery's drain and its routing upsert:
  // the relay answers 409 ATTN_SHARE_MAIL_PENDING exactly once, and one full
  // reconcile retry (which drains first) must converge.
  harness.createdRooms.clear();
  harness.probe.result = true;
  harness.failures.mailPendingUpserts = 1;
  harness.authorities[0]!.emitTransportPause('room_expired');
  await waitFor(() => harness.authorities.length === 2 && harness.runtime.getState().status === 'active', 3000);
  equal(harness.failures.mailPendingUpserts, 0, 'mail-pending rejection was consumed');
  assert(harness.upserts.at(-1)!.revision > committedRevision, 'retried re-provision advanced the share revision');
  await harness.runtime.close();
  harness.storage.close();
});

defineCase('ambiguous failures are probe-gated and total failure pauses with the room-expired reason (attn-hh9r)', async () => {
  const harness = await openRoomExpiryHarness('share-room-expiry-honest-pause');
  await harness.runtime.ensureShare(shareRequest());

  // A genuine network failure (probe: relay unreachable or room alive) keeps
  // today's paused presentation and never tears the authority down.
  harness.probe.result = false;
  harness.authorities[0]!.emitTransportPause('network');
  await waitFor(() => harness.probe.calls === 1, 3000);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  equal(harness.authorities.length, 1, 'relay-down pause must not re-provision');
  equal(harness.runtime.getState().status, 'paused', 'relay-down pause is preserved');
  equal(harness.runtime.getState().reason, 'room transport failed', 'relay-down pause keeps its transport reason');

  // The probe now proves the room gone while the relay stays reachable, but
  // the re-provision itself fails end-to-end: the pause must say the room
  // expired instead of a generic transport error.
  harness.probe.result = true;
  harness.failures.relayDown = true;
  harness.createdRooms.clear();
  harness.authorities[0]!.emitTransportPause('device_register');
  await waitFor(() => (harness.runtime.getState().reason ?? '').includes('could not be re-provisioned'), 3000);
  equal(harness.runtime.getState().status, 'paused', 'failed re-provision parks in a paused state');
  assert(
    (harness.runtime.getState().reason ?? '').startsWith('The review room expired'),
    `pause reason must name the expired room: ${harness.runtime.getState().reason}`,
  );
  equal(harness.runtime.getState().writable, true, 'local editing stays writable after a failed re-provision');

  // The single banner's explicit recovery action retries in place; it does
  // not reload the document or mint a different public share.
  harness.failures.relayDown = false;
  await harness.runtime.recoverReview();
  await waitFor(() => harness.runtime.getState().status === 'active', 3000);
  equal(harness.runtime.getState().liveEditingAvailable, true, 'manual retry restores live review');
  equal(harness.deletes.calls, 0, 'already-gone recovery never depends on an opaque DELETE');
  await harness.runtime.close();
  harness.storage.close();
});

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition did not become true');
}

const results: CaseResult[] = [];
for (const run of cases) results.push(await run());
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}`);
  if (result.detail) console.error(result.detail);
}
const failures = results.filter((result) => !result.ok);
console.log(`browser-owner-workspace-runtime: ${results.length - failures.length} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
