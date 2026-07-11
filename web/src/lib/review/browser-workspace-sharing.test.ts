import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  aeadOpen,
  base64UrlDecode,
  base64UrlEncode,
  deriveRoomId,
  deriveRoomKeys,
} from './browser-crypto';
import type { CreateOwnedRoomOptions, OwnedRoomBootstrap } from './browser-owner-bootstrap';
import {
  publishBrowserSnapshots,
  type BrowserSnapshotEntry,
  type PublishBrowserSnapshotsOptions,
} from './browser-snapshot-publisher';
import { BrowserStorage } from './browser-storage';
import { BrowserStorageError, StorageConflictError } from './browser-storage-errors';
import type { LeaseHandle } from './browser-workspace-lease';
import {
  BrowserWorkspaceSharingCoordinator,
  type BrowserWorkspaceShareOutbox,
  type BrowserWorkspaceShareRequest,
  type BrowserWorkspaceSharingDependencies,
} from './browser-workspace-sharing';
import type { MailboxEnvelope } from './browser-ws';
import type { ReviewEvent } from '../types';

Object.defineProperty(globalThis, 'IDBKeyRange', {
  configurable: true,
  value: IDBKeyRange,
});

interface Result { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<Result>> = [];

function test(name: string, run: () => Promise<void>): void {
  cases.push(async () => {
    try {
      await run();
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

function equal(actual: unknown, expected: unknown, message: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function rejectsConflict(run: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof StorageConflictError) return;
    throw new Error(`${message}: expected StorageConflictError, got ${String(error)}`);
  }
  throw new Error(`${message}: expected rejection`);
}

let databaseCounter = 0;
const NOW = 1_720_000_000_000;

async function openStorage(): Promise<BrowserStorage> {
  databaseCounter += 1;
  return BrowserStorage.open({
    indexedDB: new IDBFactory(),
    databaseName: `browser-workspace-sharing-${databaseCounter}`,
    createIfMissing: true,
    filesystem: null,
    navigator: null,
    now: () => NOW,
  });
}

async function seedWorkspace(
  storage: BrowserStorage,
  workspaceId: string,
): Promise<void> {
  await storage.workspaces.createWorkspace({
    workspaceId,
    name: workspaceId,
    storagePersisted: true,
    entry: {
      path: 'notes/main.md',
      kind: 'markdown',
      body: new TextEncoder().encode('# Main\n'),
    },
  });
  await storage.workspaces.createEntry({
    workspaceId,
    path: 'assets/image.png',
    kind: 'asset',
    mediaType: 'image/png',
    body: new Uint8Array([137, 80, 78, 71, 0, 255]),
  });
  await storage.workspaces.createEntry({
    workspaceId,
    path: 'assets/archive.bin',
    kind: 'asset',
    mediaType: 'application/octet-stream',
    body: new Uint8Array([0, 1, 2, 255]),
  });
  await storage.workspaces.createEntry({
    workspaceId,
    path: 'appendix.md',
    kind: 'markdown',
    body: new TextEncoder().encode('Appendix\n'),
  });
  await storage.workspaces.createEntry({
    workspaceId,
    path: 'caf\u00e9.md',
    kind: 'markdown',
    body: new TextEncoder().encode('Unicode path\n'),
  });
}

async function acquireFence(storage: BrowserStorage, workspaceId: string): Promise<LeaseHandle> {
  const leases = storage.leases({ channel: null });
  const fence = await leases.acquire(workspaceId, `${workspaceId}-owner`);
  leases.close();
  assert(fence, 'workspace fence acquired');
  return fence;
}

function bootstrapFromOptions(options: CreateOwnedRoomOptions): OwnedRoomBootstrap {
  assert(options.roomSecret, 'coordinator supplies prepared room secret');
  assert(options.identity, 'coordinator supplies prepared owner identity');
  assert(options.policy, 'coordinator supplies prepared room policy');
  const roomSecret = new Uint8Array(options.roomSecret);
  return {
    roomId: deriveRoomId(roomSecret),
    roomSecret,
    keys: deriveRoomKeys(roomSecret),
    identity: options.identity,
    policy: options.policy,
    created: true,
  };
}

class AckingOutbox implements BrowserWorkspaceShareOutbox {
  readonly envelopes: MailboxEnvelope[] = [];
  initialized = false;
  closed = false;

  constructor(
    private readonly storage: BrowserStorage,
    private readonly roomId: string,
    private readonly failFlush: boolean,
    private readonly beforeAck?: () => Promise<void>,
  ) {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async enqueueBatchDurably(envelopes: readonly MailboxEnvelope[]): Promise<number> {
    let inserted = 0;
    for (const envelope of envelopes) {
      const existing = this.envelopes.find((candidate) => candidate.envelopeId === envelope.envelopeId);
      if (existing) {
        equal(existing, envelope, 'an adopted pending envelope remains byte-exact');
      } else {
        this.envelopes.push(structuredClone(envelope));
        inserted += 1;
      }
    }
    return inserted;
  }

  async flushNow(): Promise<void> {
    await this.beforeAck?.();
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
    this.closed = true;
  }
}

function indexBuilder(markdown: Uint8Array) {
  return Promise.resolve({
    docHash: base64UrlEncode(sha256(markdown)),
    canonicalEncoding: 'utf8-bytes' as const,
    lineCount: new TextDecoder().decode(markdown).split('\n').length,
    blocks: [],
    headings: [],
  });
}

function decryptEvent(envelope: MailboxEnvelope, eventKey: Uint8Array): ReviewEvent {
  const plaintext = aeadOpen(
    eventKey,
    base64UrlDecode(envelope.nonce),
    base64UrlDecode(envelope.ciphertext),
    {
      v: 2,
      roomId: envelope.roomId!,
      envelopeId: envelope.envelopeId,
      kind: envelope.kind,
      authorId: envelope.authorId,
      deviceId: envelope.deviceId,
      createdAt: envelope.createdAt,
    },
  );
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as ReviewEvent;
  } finally {
    plaintext.fill(0);
  }
}

function deterministicRandom(): (length: number) => Uint8Array {
  let counter = 1;
  return (length) => new Uint8Array(length).fill(counter++);
}

function request(
  scopeKind: BrowserWorkspaceShareRequest['scopeKind'],
  paths: readonly string[],
): BrowserWorkspaceShareRequest {
  return {
    relayUrl: 'https://relay.example',
    browserReviewBase: 'https://attn.example/review',
    scopeKind,
    paths,
    ownerDisplayName: '  Workspace owner  ',
  };
}

test('prepares ownership before relay I/O and publishes exact owner genesis first', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-genesis';
    await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId);
    let createOptions: CreateOwnedRoomOptions | undefined;
    let publishOptions: PublishBrowserSnapshotsOptions | undefined;
    const outboxes: AckingOutbox[] = [];
    let coordinator: BrowserWorkspaceSharingCoordinator;
    coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => NOW,
      randomBytes: deterministicRandom(),
      createRoom: async (options) => {
        assert(options.roomSecret, 'coordinator supplies prepared room secret');
        assert(options.identity, 'coordinator supplies prepared owner identity');
        createOptions = {
          ...options,
          roomSecret: new Uint8Array(options.roomSecret),
          identity: {
            ...options.identity,
            signingSecret: new Uint8Array(options.identity.signingSecret),
            signingPublic: new Uint8Array(options.identity.signingPublic),
            encryptionSecret: new Uint8Array(options.identity.encryptionSecret),
            publicEncryptionKey: new Uint8Array(options.identity.publicEncryptionKey),
          },
        };
        const prepared = await storage.shares.listShares(workspaceId);
        equal(prepared.length, 1, 'prepared record exists before first network request');
        equal(prepared[0]?.publication, 'pending', 'prepared record is not exposed as published');
        const rootKey = await storage.getWorkspaceRootKey(workspaceId);
        assert(rootKey, 'workspace root key exists');
        const capability = await storage.shares.openShare(rootKey, workspaceId, prepared[0]!.capId);
        equal(
          capability.sharePaths,
          ['assets/image.png', 'notes/main.md'],
          'exact selected scope is sealed before relay I/O',
        );
        return bootstrapFromOptions(options);
      },
      publish: async (options) => {
        publishOptions = options;
        return publishBrowserSnapshots({ ...options, indexBuilder });
      },
      outboxFactory: ({ storage: outboxStorage, credentials }) => {
        const outbox = new AckingOutbox(outboxStorage, credentials.roomId, false, async () => {
          const pending = await coordinator.inspect('https://attn.example/review');
          assert(pending, 'prepared share remains inspectable during publish');
          equal(pending.publication, 'pending', 'relay ACK is the promotion boundary');
          equal(pending.invite, null, 'pending publication does not expose an invite');
        });
        outboxes.push(outbox);
        return outbox;
      },
    });

    const view = await coordinator.ensurePublished(
      request('entries', ['notes/main.md', 'assets/image.png']),
    );
    assert(createOptions?.identity, 'relay create observed owner identity');
    assert(createOptions.roomSecret, 'relay create observed room secret');
    assert(publishOptions, 'publisher invoked');
    assert(view.invite, 'invite appears only after durable ACK promotion');
    equal(view.publication, 'published', 'share promoted after ACK');
    equal(view.paths, ['assets/image.png', 'notes/main.md'], 'published view retains exact scope');

    const envelopes = outboxes[0]?.envelopes ?? [];
    equal(
      envelopes.slice(0, 3).map((envelope) => envelope.kind),
      ['event', 'event', 'snapshot_blob'],
      'RoomCreated and owner ParticipantJoined precede every snapshot',
    );
    const eventKey = deriveRoomKeys(createOptions.roomSecret).eventKey;
    const roomCreated = decryptEvent(envelopes[0]!, eventKey);
    const ownerJoined = decryptEvent(envelopes[1]!, eventKey);
    equal(roomCreated.body, {
      type: 'room_created',
      roomId: view.roomId,
      policy: createOptions.policy,
      createdBy: createOptions.identity.participantId,
    }, 'RoomCreated body exactly binds prepared policy and owner');
    equal(ownerJoined.body, {
      type: 'participant_joined',
      participant: {
        participantId: createOptions.identity.participantId,
        displayName: 'Workspace owner',
        kind: 'owner',
        publicSigningKey: base64UrlEncode(createOptions.identity.signingPublic),
        capabilities: [
          'room_admin',
          'read_snapshot',
          'write_comment',
          'write_suggestion',
          'resolve_comment',
          'accept_suggestion',
          'publish_snapshot',
        ],
      },
      device: {
        deviceId: createOptions.identity.deviceId,
        participantId: createOptions.identity.participantId,
        publicEncryptionKey: base64UrlEncode(createOptions.identity.publicEncryptionKey),
        publicSigningKey: base64UrlEncode(createOptions.identity.signingPublic),
        client: 'attn-browser',
        createdAt: NOW + 1,
      },
    }, 'owner ParticipantJoined body exactly advertises native authority');
    eventKey.fill(0);
  } finally {
    storage.close();
  }
});

test('materializes current, selected, and whole-workspace scopes with mixed assets', async () => {
  const scenarios: Array<{
    scope: BrowserWorkspaceShareRequest['scopeKind'];
    paths: string[];
    expected: Array<[string, BrowserSnapshotEntry['docType'], string | undefined]>;
  }> = [
    {
      scope: 'file',
      paths: ['notes/main.md'],
      expected: [['notes/main.md', 'markdown', undefined]],
    },
    {
      scope: 'entries',
      paths: ['notes/main.md', 'assets/archive.bin', 'assets/image.png', 'cafe\u0301.md'],
      expected: [
        ['assets/archive.bin', 'asset', 'application/octet-stream'],
        ['assets/image.png', 'asset', 'image/png'],
        ['caf\u00e9.md', 'markdown', undefined],
        ['notes/main.md', 'markdown', undefined],
      ],
    },
    {
      scope: 'workspace',
      paths: [],
      expected: [
        ['appendix.md', 'markdown', undefined],
        ['assets/archive.bin', 'asset', 'application/octet-stream'],
        ['assets/image.png', 'asset', 'image/png'],
        ['caf\u00e9.md', 'markdown', undefined],
        ['notes/main.md', 'markdown', undefined],
      ],
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const storage = await openStorage();
    try {
      const workspaceId = `ws-scope-${index}`;
      await seedWorkspace(storage, workspaceId);
      const fence = await acquireFence(storage, workspaceId);
      let captured: Array<[string, BrowserSnapshotEntry['docType'], string | undefined]> = [];
      const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
        now: () => NOW,
        randomBytes: deterministicRandom(),
        createRoom: async (options) => bootstrapFromOptions(options),
        publish: async (options) => {
          captured = options.entries.map((entry) => [
            entry.path,
            entry.docType,
            entry.docType === 'asset' ? entry.mediaType : undefined,
          ]);
          return publishBrowserSnapshots({ ...options, indexBuilder });
        },
        outboxFactory: ({ storage: outboxStorage, credentials }) =>
          new AckingOutbox(outboxStorage, credentials.roomId, false),
      });
      const view = await coordinator.ensurePublished(request(scenario.scope, scenario.paths));
      equal(captured, scenario.expected, `${scenario.scope} source materialization`);
      equal(view.paths, scenario.expected.map(([path]) => path), `${scenario.scope} sealed paths`);
    } finally {
      storage.close();
    }
  }
});

test('resumes the exact pending ciphertext without recreating or re-encrypting', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-resume';
    await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId);
    let creates = 0;
    let publishes = 0;
    const outboxes: AckingOutbox[] = [];
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => NOW,
      randomBytes: deterministicRandom(),
      createRoom: async (options) => {
        creates += 1;
        return bootstrapFromOptions(options);
      },
      publish: async (options) => {
        publishes += 1;
        return publishBrowserSnapshots({ ...options, indexBuilder });
      },
      outboxFactory: ({ storage: outboxStorage, credentials }) => {
        const outbox = new AckingOutbox(outboxStorage, credentials.roomId, outboxes.length === 0);
        outboxes.push(outbox);
        return outbox;
      },
    });

    let failed = false;
    try {
      await coordinator.ensurePublished(request('file', ['notes/main.md']));
    } catch (error) {
      failed = error instanceof Error && error.message === 'relay offline';
    }
    assert(failed, 'first publication stops at simulated relay outage');
    const pending = await coordinator.inspect('https://attn.example/review');
    assert(pending, 'pending share survives failed flush');
    equal(pending.publication, 'pending', 'failed flush stays pending');
    equal(pending.invite, null, 'failed flush never materializes invite');
    const exact = JSON.stringify(outboxes[0]?.envelopes);

    const resumed = await coordinator.ensurePublished(request('workspace', []));
    equal(creates, 1, 'resume does not recreate the room');
    equal(publishes, 1, 'resume does not assemble fresh ciphertext');
    equal(JSON.stringify(outboxes[1]?.envelopes), exact, 'resume adopts exact journaled ciphertext');
    equal(resumed.roomId, pending.roomId, 'resume retains prepared room');
    equal(resumed.capId, pending.capId, 'resume retains prepared capability');
    assert(resumed.invite, 'invite appears after resumed batch ACK');
  } finally {
    storage.close();
  }
});

test('single-active invariant and lease fences reject passive and stale mutations', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-fence';
    await seedWorkspace(storage, workspaceId);
    const rootKey = await storage.getWorkspaceRootKey(workspaceId);
    assert(rootKey, 'workspace root key exists');
    const active = await acquireFence(storage, workspaceId);
    const identity = (await import('./browser-session')).generateBrowserIdentity();
    const capability = (await import('./browser-workspace-share')).inviteCapabilityFrom({
      roomSecret: new Uint8Array(32).fill(7),
      ownerSigningSecret: identity.signingSecret,
      ownerEncryptionSecret: identity.encryptionSecret,
      ownerDeviceId: identity.deviceId,
      ownerParticipantId: identity.participantId,
      policy: { mode: 'hybrid' },
      sharePaths: ['notes/main.md'],
    });
    await storage.shares.bindShareFenced(rootKey, {
      workspaceId,
      capId: 'cap-active',
      roomId: 'room-active',
      scopeKind: 'file',
      relayUrl: 'https://relay.example',
      capability,
    }, active);
    await rejectsConflict(
      () => storage.shares.bindShareFenced(rootKey, {
        workspaceId,
        capId: 'cap-second',
        roomId: 'room-second',
        scopeKind: 'file',
        relayUrl: 'https://relay.example',
        capability,
      }, active),
      'same owner cannot create a second active share',
    );
    await rejectsConflict(
      () => storage.shares.forgetShareFenced(
        workspaceId,
        'cap-active',
        { holderId: 'passive-tab', fencingToken: active.fencingToken },
      ),
      'passive tab cannot erase ownership',
    );

    const leases = storage.leases({ channel: null });
    assert(await leases.release(active), 'active lease released');
    const takeover = await leases.acquire(workspaceId, 'takeover-tab');
    leases.close();
    assert(takeover, 'new tab takes the workspace lease');
    await rejectsConflict(
      () => storage.shares.forgetShareFenced(workspaceId, 'cap-active', active),
      'stale holder cannot erase ownership',
    );
    assert(
      await storage.shares.forgetShareFenced(workspaceId, 'cap-active', takeover),
      'current holder can erase the binding',
    );
  } finally {
    storage.close();
  }
});

test('remote stop succeeds before local erasure and recreate mints fresh ownership', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-stop-recreate';
    await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId);
    let deleteSucceeds = false;
    let deletes = 0;
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => NOW,
      randomBytes: deterministicRandom(),
      createRoom: async (options) => bootstrapFromOptions(options),
      deleteRoom: async () => {
        deletes += 1;
        return deleteSucceeds;
      },
      publish: async (options) => publishBrowserSnapshots({ ...options, indexBuilder }),
      outboxFactory: ({ storage: outboxStorage, credentials }) =>
        new AckingOutbox(outboxStorage, credentials.roomId, false),
    });
    const first = await coordinator.ensurePublished(request('file', ['notes/main.md']));

    let failed = false;
    try {
      await coordinator.deleteRemote();
    } catch (error) {
      failed = error instanceof Error && error.message.includes('existing link may still work');
    }
    assert(failed, 'failed authoritative delete is surfaced honestly');
    equal((await storage.shares.listShares(workspaceId)).length, 1, 'delete failure preserves local control');

    deleteSucceeds = true;
    const deleted = await coordinator.deleteRemote();
    equal(deletes, 2, 'remote deletion retried');
    equal((await storage.shares.listShares(workspaceId)).length, 1, 'remote success alone retains local capability');
    await coordinator.eraseLocal(deleted);
    equal((await storage.shares.listShares(workspaceId)).length, 0, 'local capability erased after remote success');

    const recreated = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    assert(recreated.roomId !== first.roomId, 'recreate uses a fresh room secret and room ID');
    assert(recreated.capId !== first.capId, 'recreate uses a fresh capability ID');
  } finally {
    storage.close();
  }
});

test('expired ownership is authoritatively retired before creating a fresh room', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-expired-recreate';
    await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId);
    let now = NOW;
    let deletes = 0;
    const randomBytes = deterministicRandom();
    const dependencies: BrowserWorkspaceSharingDependencies = {
      now: () => now,
      randomBytes,
      createRoom: async (options: CreateOwnedRoomOptions) => bootstrapFromOptions(options),
      deleteRoom: async () => {
        deletes += 1;
        return true;
      },
      publish: async (options: PublishBrowserSnapshotsOptions) =>
        publishBrowserSnapshots({ ...options, indexBuilder }),
      outboxFactory: ({ storage: outboxStorage, credentials }) =>
        new AckingOutbox(outboxStorage, credentials.roomId, false),
    };
    const coordinator = new BrowserWorkspaceSharingCoordinator(
      storage,
      workspaceId,
      fence,
      dependencies,
    );
    const first = await coordinator.ensurePublished({
      ...request('file', ['notes/main.md']),
      ttlMs: 60 * 60 * 1000,
    });
    now += 60 * 60 * 1000 + 1;
    const expired = await coordinator.inspect('https://attn.example/review');
    assert(expired?.expired, 'the prior room is visibly expired');
    equal(expired.invite, null, 'an expired capability is never materialized as an invite');

    const recreated = await coordinator.ensurePublished(
      request('file', ['notes/main.md']),
    );
    equal(deletes, 1, 'expired room is owner-deleted before replacement');
    assert(recreated.roomId !== first.roomId, 'replacement uses a fresh room ID');
    assert(recreated.capId !== first.capId, 'replacement uses a fresh capability ID');
    equal((await storage.shares.listShares(workspaceId)).length, 1, 'only replacement ownership remains');
  } finally {
    storage.close();
  }
});

test('scope validation rejects stale paths, duplicates, and asset-only selections before network', async () => {
  const attempts: BrowserWorkspaceShareRequest[] = [
    request('entries', ['notes/missing.md']),
    request('entries', ['notes/main.md', 'notes/main.md']),
    request('entries', ['assets/image.png']),
  ];
  for (const [index, invalid] of attempts.entries()) {
    const storage = await openStorage();
    try {
      const workspaceId = `ws-invalid-scope-${index}`;
      await seedWorkspace(storage, workspaceId);
      const fence = await acquireFence(storage, workspaceId);
      let networkCalls = 0;
      const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
        now: () => NOW,
        randomBytes: deterministicRandom(),
        createRoom: async (options) => {
          networkCalls += 1;
          return bootstrapFromOptions(options);
        },
      });
      let rejected = false;
      try {
        await coordinator.ensurePublished(invalid);
      } catch (error) {
        rejected = error instanceof BrowserStorageError;
      }
      assert(rejected, 'invalid scope rejected');
      equal(networkCalls, 0, 'invalid scope causes no relay request');
      equal((await storage.shares.listShares(workspaceId)).length, 0, 'invalid scope leaves no prepared record');
    } finally {
      storage.close();
    }
  }
});

const results = await Promise.all(cases.map((run) => run()));
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? `\n${result.detail}` : ''}`);
}
const failures = results.filter((result) => !result.ok);
console.log(`browser-workspace-sharing: ${results.length - failures.length} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
