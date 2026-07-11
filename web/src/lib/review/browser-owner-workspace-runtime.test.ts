import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { assembleBrowserEvent, type AssembledBrowserEvent } from './browser-envelope';
import {
  base64UrlEncode,
  contentHash,
  deriveRoomId,
  deriveRoomKeys,
} from './browser-crypto';
import {
  BrowserOwnerWorkspaceRuntime,
  type BrowserOwnerWorkspaceAuthority,
  type BrowserOwnerWorkspaceRuntimeOptions,
} from './browser-owner-workspace-runtime';
import type {
  BrowserOwnerAuthorityFile,
  BrowserOwnerAuthorityOptions,
  BrowserOwnerAuthorityState,
  BrowserPublishedEpochTransition,
  BrowserPublishedEpochTransitionPhases,
} from './browser-owner-authority';
import { BrowserStorage } from './browser-storage';
import { generateBrowserIdentity } from './browser-session';
import { inviteCapabilityFrom } from './browser-workspace-share';
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

async function seedLocal(storage: BrowserStorage, workspaceId: string, text = 'hello') {
  return storage.workspaces.createWorkspace({
    workspaceId,
    name: workspaceId,
    storagePersisted: true,
    entry: { path: 'notes.md', kind: 'markdown', body: new TextEncoder().encode(text) },
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
  async replyToComment(_anchor: Anchor, _body: string, _threadId: string): Promise<ReviewEvent> {
    throw new Error('not used');
  }
  async resolveComment(_threadId: string): Promise<ReviewEvent> { throw new Error('not used'); }
  async retryOutbox(): Promise<void> {}

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
      publicationOutbox: {
        enqueueBatchDurably: async () => 0,
        flushNow: async () => undefined,
      },
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
  equal(first.getState().liveEditingAvailable, false, 'local-only collab disabled');
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
