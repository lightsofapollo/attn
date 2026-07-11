import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  aeadOpen,
  base64UrlDecode,
  base64UrlEncode,
  deriveRoomIdV3,
  deriveRoomKeyTreeV3,
  deriveShareLinkKeys,
} from './browser-crypto';
import type { CreateOwnedRoomOptions, OwnedRoomBootstrapV3 } from './browser-owner-bootstrap';
import { assembleBrowserEvent } from './browser-envelope';
import {
  publishBrowserSnapshots,
  type PublishBrowserSnapshotsOptions,
} from './browser-snapshot-publisher';
import {
  BrowserShareOwnerRelayError,
  digestShareSnapshotManifest,
  type BrowserShareRelayRecord,
  type BrowserShareUpsertRequest,
  type ManagedShareSnapshotRef,
} from './browser-share-owner';
import { BrowserStorage } from './browser-storage';
import { BrowserStorageError, StorageConflictError } from './browser-storage-errors';
import {
  buildRegisterDeviceBodyV3,
  canonicalDeviceGrantV3,
  generateBrowserIdentity,
  ownerCredentialsV3FromInviteCapability,
  type RegisterDeviceBodyV3,
} from './browser-session';
import type { LeaseHandle } from './browser-workspace-lease';
import {
  BrowserWorkspaceSharingCoordinator,
  type BrowserShareOwnerRelayPort,
  type BrowserWorkspaceShareOutbox,
  type BrowserWorkspaceShareRequest,
} from './browser-workspace-sharing';
import type { MailboxEnvelope } from './browser-ws';
import type { ReviewEvent } from '../types';

Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });

interface Result { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<Result>> = [];
function test(name: string, run: () => Promise<void>): void {
  cases.push(async () => {
    try { await run(); return { name, ok: true }; }
    catch (error) { return { name, ok: false, detail: error instanceof Error ? error.stack ?? error.message : String(error) }; }
  });
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function required<T>(value: unknown, message: string): T { assert(value, message); return value as T; }
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

let databaseCounter = 0;
const NOW = 1_720_000_000_000;
async function openStorage(): Promise<BrowserStorage> {
  return BrowserStorage.open({
    indexedDB: new IDBFactory(), databaseName: `browser-workspace-sharing-v3-${++databaseCounter}`,
    createIfMissing: true, filesystem: null, navigator: null, now: () => NOW,
  });
}
async function seedWorkspace(storage: BrowserStorage, workspaceId: string): Promise<void> {
  await storage.workspaces.createWorkspace({ workspaceId, name: workspaceId, storagePersisted: true,
    entry: { path: 'notes/main.md', kind: 'markdown', body: new TextEncoder().encode('# Main\n') } });
  await storage.workspaces.createEntry({ workspaceId, path: 'assets/image.png', kind: 'asset',
    mediaType: 'image/png', body: new Uint8Array([137, 80, 78, 71, 0, 255]) });
  await storage.workspaces.createEntry({ workspaceId, path: 'appendix.md', kind: 'markdown',
    body: new TextEncoder().encode('Appendix\n') });
}
async function acquireFence(storage: BrowserStorage, workspaceId: string): Promise<LeaseHandle> {
  const leases = storage.leases({ channel: null });
  const fence = await leases.acquire(workspaceId, `${workspaceId}-owner`); leases.close();
  assert(fence, 'workspace fence acquired'); return fence;
}
function deterministicRandom(): (length: number) => Uint8Array {
  let counter = 1; return (length) => new Uint8Array(length).fill(counter++);
}
function request(scopeKind: BrowserWorkspaceShareRequest['scopeKind'], paths: readonly string[]): BrowserWorkspaceShareRequest {
  return { relayUrl: 'https://relay.example', browserReviewBase: 'https://attn.sh', scopeKind, paths,
    ownerDisplayName: '  Workspace owner  ' };
}

function bootstrapFromOptions(options: CreateOwnedRoomOptions): OwnedRoomBootstrapV3 {
  assert(options.roomSecret && options.identity && options.policy, 'prepared v3 bootstrap inputs');
  const roomSecret = new Uint8Array(options.roomSecret);
  return {
    roomId: deriveRoomIdV3(roomSecret), roomSecret, keys: deriveRoomKeyTreeV3(roomSecret),
    identity: options.identity, policy: options.policy,
    commentGrantSignature: base64UrlEncode(new Uint8Array(64).fill(3)),
    suggestGrantSignature: base64UrlEncode(new Uint8Array(64).fill(5)), created: true,
  };
}

class AckingOutbox implements BrowserWorkspaceShareOutbox {
  readonly envelopes: MailboxEnvelope[] = [];
  constructor(private readonly storage: BrowserStorage, private readonly roomId: string, private failFlush = false) {}
  async initialize(): Promise<void> {}
  async enqueueBatchDurably(envelopes: readonly MailboxEnvelope[]): Promise<number> {
    for (const envelope of envelopes) {
      if (!this.envelopes.some(candidate => candidate.envelopeId === envelope.envelopeId)) {
        this.envelopes.push(structuredClone(envelope));
      }
    }
    return envelopes.length;
  }
  async flushNow(): Promise<void> {
    if (this.failFlush) { this.failFlush = false; throw new Error('relay offline'); }
    await this.storage.acknowledge(this.roomId, this.envelopes,
      this.envelopes.map((envelope, index) => ({ envelopeId: envelope.envelopeId, serverSeq: index + 1 })));
  }
  close(): void {}
}

class MemoryShareRelay implements BrowserShareOwnerRelayPort {
  record: BrowserShareRelayRecord | null = null;
  readonly upserts: BrowserShareUpsertRequest[] = [];
  revoked = false;
  readonly mailItems: Array<{
    seq: number; envelopeId: string; bytes: number; payload: unknown;
    epoch: number; bundleId: string; tier: 'comment' | 'suggest';
  }> = [];
  ackedThrough = 0;
  async upsert(request: BrowserShareUpsertRequest): Promise<BrowserShareRelayRecord> {
    this.upserts.push(structuredClone(request));
    this.record = {
      v: 3, shareId: this.shareId, ownerSigningKey: request.ownerSigningKey,
      epoch: request.epoch, revision: request.revision,
      ...(request.currentRoomId === null ? {} : { currentRoomId: request.currentRoomId }),
      snapshots: structuredClone(request.snapshots), placeholders: structuredClone(request.placeholders),
      manifestDigest: digestShareSnapshotManifest(request.snapshots), updatedAt: NOW,
      expiresAt: NOW + 90 * 24 * 60 * 60 * 1000,
      mailbox: { count: 0, bytes: 0, latestSeq: 0 },
    };
    return structuredClone(this.record);
  }
  constructor(private readonly shareId: string) {}
  async fetchWithViewCapability(): Promise<BrowserShareRelayRecord> {
    if (!this.record || this.revoked) throw new BrowserShareOwnerRelayError(404, 'fetch');
    return structuredClone(this.record);
  }
  async uploadSnapshot(fileId: string, snapshotId: string, ciphertext: Uint8Array): Promise<ManagedShareSnapshotRef> {
    assert(this.record, 'dark share exists before retained upload');
    const ref = { fileId, snapshotId, ciphertextBytes: ciphertext.length,
      ciphertextSha256: base64UrlEncode(sha256(ciphertext)), uploadedAt: NOW + this.record.revision + 1 };
    const snapshots = this.record.snapshots.filter(item => item.fileId !== fileId); snapshots.push(ref);
    snapshots.sort((a, b) => a.fileId.localeCompare(b.fileId));
    this.record = { ...this.record, snapshots, revision: this.record.revision + 1,
      manifestDigest: digestShareSnapshotManifest(snapshots) };
    return structuredClone(ref);
  }
  async deleteSnapshot(fileId: string): Promise<void> {
    assert(this.record, 'share exists');
    const snapshots = this.record.snapshots.filter(item => item.fileId !== fileId);
    if (snapshots.length !== this.record.snapshots.length) {
      this.record = { ...this.record, snapshots, revision: this.record.revision + 1,
      manifestDigest: digestShareSnapshotManifest(snapshots) };
    }
  }
  async fetchMailbox(shareSecret: Uint8Array, tier: 'comment' | 'suggest', after: number) {
    const keys = deriveShareLinkKeys(shareSecret, tier);
    try {
      const items = this.mailItems.filter(item => item.tier === tier && item.seq > after);
      return { items: structuredClone(items), nextAfter: items.at(-1)?.seq ?? after,
        bundle: { bundleId: keys.bundleId, tier, sealedBundle: 'selected' } };
    } finally {
      keys.linkSecret.fill(0); keys.bundleKey.fill(0); keys.readAdmissionKey.fill(0); keys.writeAdmissionKey?.fill(0);
    }
  }
  async ackMailbox(through: number): Promise<void> {
    this.ackedThrough = through;
    const remaining = this.mailItems.filter(item => item.seq > through);
    this.mailItems.splice(0, this.mailItems.length, ...remaining);
    if (this.record) this.record = { ...this.record, mailbox: {
      count: remaining.length, bytes: remaining.reduce((sum, item) => sum + item.bytes, 0),
      latestSeq: this.record.mailbox.latestSeq,
    } };
  }
  async revoke(): Promise<void> { this.revoked = true; }
}

function indexBuilder(markdown: Uint8Array) {
  return Promise.resolve({ docHash: base64UrlEncode(sha256(markdown)), canonicalEncoding: 'utf8-bytes' as const,
    lineCount: new TextDecoder().decode(markdown).split('\n').length, blocks: [], headings: [] });
}
function decryptEvent(envelope: MailboxEnvelope, eventKey: Uint8Array): ReviewEvent {
  const plaintext = aeadOpen(eventKey, base64UrlDecode(envelope.nonce), base64UrlDecode(envelope.ciphertext), {
    v: 2, roomId: envelope.roomId!, envelopeId: envelope.envelopeId, kind: envelope.kind,
    authorId: envelope.authorId, deviceId: envelope.deviceId, createdAt: envelope.createdAt,
  });
  try { return JSON.parse(new TextDecoder().decode(plaintext)) as ReviewEvent; }
  finally { plaintext.fill(0); }
}

test('publishes one dark ShareDO projection, retained snapshot, then stable tier links', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-v3-genesis'; await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId); let relay: MemoryShareRelay | null = null;
    let createOptions: CreateOwnedRoomOptions | null = null; let outbox: AckingOutbox | null = null;
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => NOW, randomBytes: deterministicRandom(),
      createRoom: async options => {
        createOptions = { ...options, roomSecret: new Uint8Array(options.roomSecret!) };
        return bootstrapFromOptions(options);
      },
      publish: options => publishBrowserSnapshots({ ...options, indexBuilder }),
      indexBuilder,
      outboxFactory: ({ storage: db, credentials }) => (outbox = new AckingOutbox(db, credentials.roomId)),
      shareRelayFactory: options => (relay ??= new MemoryShareRelay(options.shareId)),
    });
    const view = await coordinator.ensurePublished(request('entries', ['notes/main.md', 'assets/image.png']));
    assert(view.invite, 'v3 share completed');
    const observedCreate = required<CreateOwnedRoomOptions>(createOptions, 'create observed');
    const observedOutbox = required<AckingOutbox>(outbox, 'outbox observed');
    const observedRelay = required<MemoryShareRelay>(relay, 'share relay observed');
    assert(view.shareId === view.capId, 'stable share id is sealed binding id');
    assert(view.roomId === deriveRoomIdV3(observedCreate.roomSecret!), 'ordinary epoch room is v3-derived');
    assert(observedRelay.upserts[0]!.currentRoomId === null, 'first projection is dark');
    assert(observedRelay.upserts.at(-1)!.currentRoomId === view.roomId, 'final projection flips room pointer');
    assert(observedRelay.record!.snapshots.length === 1, 'markdown retained while binary remains live-room inert');
    const urls = [view.invite.view.browserUrl, view.invite.comment.browserUrl, view.invite.suggest.browserUrl];
    assert(urls.every(url => url.startsWith(`https://attn.sh/s/${view.shareId}#key=`)), 'stable /s links');
    assert(new Set(urls).size === 3, 'tier bearers are independent');
    const tree = deriveRoomKeyTreeV3(observedCreate.roomSecret!);
    const roomCreated = decryptEvent(observedOutbox.envelopes[0]!, tree.readKeys.eventKey);
    assert(roomCreated.body.type === 'room_created', 'owner genesis leads publication');
  } finally { storage.close(); }
});

test('pending ordinary ciphertext resumes exactly before ShareDO promotion', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-v3-resume'; await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId); const outboxes: AckingOutbox[] = [];
    let creates = 0; let publishes = 0; let relay: MemoryShareRelay | null = null;
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => NOW, randomBytes: deterministicRandom(),
      createRoom: async options => { creates += 1; return bootstrapFromOptions(options); },
      publish: options => { publishes += 1; return publishBrowserSnapshots({ ...options, indexBuilder }); },
      indexBuilder,
      outboxFactory: ({ storage: db, credentials }) => {
        const value = new AckingOutbox(db, credentials.roomId, outboxes.length === 0); outboxes.push(value); return value;
      },
      shareRelayFactory: options => (relay ??= new MemoryShareRelay(options.shareId)),
    });
    let failed = false;
    try { await coordinator.ensurePublished(request('file', ['notes/main.md'])); }
    catch (error) { failed = error instanceof Error && error.message === 'relay offline'; }
    assert(failed, 'first relay flush fails');
    const pending = await coordinator.inspect('https://attn.sh'); assert(pending?.resumable, 'pending is resumable');
    const exact = JSON.stringify(outboxes[0]!.envelopes);
    const active = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    assert(active.invite, 'stable links appear after resume');
    assert(publishes === 1, 'resume does not re-encrypt');
    assert(creates === 2, 'room rejoin is idempotently retried');
    assert(JSON.stringify(outboxes[1]!.envelopes) === exact, 'exact ciphertext adopted');
  } finally { storage.close(); }
});

test('active stable share renews ShareDO without republishing a live epoch room', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-v3-renew'; await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId); let relay: MemoryShareRelay | null = null;
    let creates = 0; let publishes = 0; let clock = NOW;
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => clock, randomBytes: deterministicRandom(),
      createRoom: async options => {
        creates += 1;
        return { ...bootstrapFromOptions(options), created: creates === 1 };
      },
      publish: options => { publishes += 1; return publishBrowserSnapshots({ ...options, indexBuilder }); },
      indexBuilder,
      outboxFactory: ({ storage: db, credentials }) => new AckingOutbox(db, credentials.roomId),
      shareRelayFactory: options => (relay ??= new MemoryShareRelay(options.shareId)),
    });
    const first = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    const firstUpserts = required<MemoryShareRelay>(relay, 'share relay').upserts.length;
    clock += 60_000;
    const renewed = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    assert(renewed.shareId === first.shareId && renewed.roomId === first.roomId, 'renewal preserves stable and epoch ids');
    assert(creates === 2, 'renewal reasserts the ordinary room');
    assert(publishes === 1, 'live room renewal does not republish unchanged snapshots');
    assert(required<MemoryShareRelay>(relay, 'share relay').upserts.length === firstUpserts + 1,
      'renewal touches ShareDO even when its projection is unchanged');
    const rootKey = await storage.getWorkspaceRootKey(workspaceId); assert(rootKey, 'root key');
    const capability = await storage.shares.openShare(rootKey, workspaceId, first.capId);
    assert((capability.policy as { expiresAt: number }).expiresAt === clock + 24 * 60 * 60 * 1000,
      'renewal seals the refreshed ordinary-room policy');
  } finally { storage.close(); }
});

test('missing ordinary epoch room republishes under the same stable links', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-v3-room-recreate'; await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId); let relay: MemoryShareRelay | null = null;
    let publishes = 0; let clock = NOW;
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => clock, randomBytes: deterministicRandom(),
      createRoom: async options => bootstrapFromOptions(options),
      publish: options => { publishes += 1; return publishBrowserSnapshots({ ...options, indexBuilder }); },
      indexBuilder,
      outboxFactory: ({ storage: db, credentials }) => new AckingOutbox(db, credentials.roomId),
      shareRelayFactory: options => (relay ??= new MemoryShareRelay(options.shareId)),
    });
    const first = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    const firstRevision = required<MemoryShareRelay>(relay, 'share relay').record!.revision;
    clock += 60_000;
    const recovered = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    assert(recovered.shareId === first.shareId && recovered.roomId === first.roomId,
      'same epoch recovery leaves every public URL stable');
    assert(publishes === 2, 'a recreated ordinary room receives a fresh canonical publication');
    assert(required<MemoryShareRelay>(relay, 'share relay').record!.revision > firstRevision,
      'retained projection advances and rebinds its sealed bundles after recovery');
  } finally { storage.close(); }
});

test('browser owner validates, forwards, and ACKs an offline stable-link comment', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-v3-mailbox-drain'; await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId); let relay: MemoryShareRelay | null = null;
    let creates = 0; let publishes = 0; const registrations: RegisterDeviceBodyV3[] = [];
    const outboxes: AckingOutbox[] = [];
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => NOW, randomBytes: deterministicRandom(),
      createRoom: async options => {
        creates += 1;
        return { ...bootstrapFromOptions(options), created: creates === 1 };
      },
      publish: options => { publishes += 1; return publishBrowserSnapshots({ ...options, indexBuilder }); },
      indexBuilder,
      outboxFactory: ({ storage: db, credentials }) => {
        const outbox = new AckingOutbox(db, credentials.roomId); outboxes.push(outbox); return outbox;
      },
      shareRelayFactory: options => (relay ??= new MemoryShareRelay(options.shareId)),
      registerFrozenDevice: async input => { registrations.push(structuredClone(input.registration)); },
    });
    const first = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    const rootKey = await storage.getWorkspaceRootKey(workspaceId); assert(rootKey, 'root key');
    const capability = await storage.shares.openShare(rootKey, workspaceId, first.capId);
    const credentials = ownerCredentialsV3FromInviteCapability(capability, first.roomId);
    const reviewer = generateBrowserIdentity();
    try {
      const grant = base64UrlEncode(ed25519.sign(
        canonicalDeviceGrantV3(first.roomId, 'comment'),
        credentials.identity.signingSecret,
      ));
      const registration = buildRegisterDeviceBodyV3(reviewer, 'comment', grant);
      const common = {
        eventKey: credentials.keys.eventKey,
        signingSecret: reviewer.signingSecret,
        signingPublic: reviewer.signingPublic,
        roomId: first.roomId,
        authorId: reviewer.participantId,
        deviceId: reviewer.deviceId,
        expiresAt: (capability.policy as { expiresAt: number }).expiresAt,
      } as const;
      const joined = assembleBrowserEvent({ ...common, createdAt: NOW + 10, body: {
        type: 'participant_joined',
        participant: { participantId: reviewer.participantId, displayName: 'Offline reviewer', kind: 'reviewer',
          publicSigningKey: base64UrlEncode(reviewer.signingPublic),
          capabilities: ['read_snapshot', 'write_comment', 'resolve_comment'] },
        device: { deviceId: reviewer.deviceId, participantId: reviewer.participantId,
          publicEncryptionKey: base64UrlEncode(reviewer.publicEncryptionKey),
          publicSigningKey: base64UrlEncode(reviewer.signingPublic), client: 'attn-browser', createdAt: NOW + 10 },
      } });
      const comment = assembleBrowserEvent({ ...common, createdAt: NOW + 11, body: {
        type: 'comment_created', threadId: 'offline-thread', anchor: {
          v: 2, fileId: 'offline-file', snapshotId: 'offline-snapshot', baseHash: 'offline-hash',
          position: { byteRange: [0, 1], lineRange: [1, 1] },
        }, body: 'offline browser comment',
      } });
      const link = deriveShareLinkKeys(credentials.shareSecret, 'comment');
      try {
        const envelopeId = base64UrlEncode(new Uint8Array(16).fill(91));
        const payload = { v: 3, envelopeId, type: 'review_submission', shareId: first.shareId,
          epoch: credentials.epoch, roomId: first.roomId, tier: 'comment',
          deviceRegistration: registration, envelopes: [joined.envelope, comment.envelope] };
        const memoryRelay = required<MemoryShareRelay>(relay, 'share relay');
        memoryRelay.mailItems.push({ seq: 1, envelopeId, bytes: JSON.stringify(payload).length,
          payload, epoch: credentials.epoch, bundleId: link.bundleId, tier: 'comment' });
        memoryRelay.record = { ...memoryRelay.record!, mailbox: {
          count: 1, bytes: JSON.stringify(payload).length, latestSeq: 1,
        } };
      } finally {
        link.linkSecret.fill(0); link.bundleKey.fill(0); link.readAdmissionKey.fill(0); link.writeAdmissionKey?.fill(0);
      }
      await coordinator.ensurePublished(request('file', ['notes/main.md']));
      assert(registrations.length === 1 && registrations[0]!.deviceId === reviewer.deviceId,
        'owner forwards the exact preflighted visitor registration');
      assert(outboxes[1]!.envelopes.some(item => item.envelopeId === comment.envelope.envelopeId),
        'owner forwards the exact encrypted comment envelope to RoomDO');
      assert(required<MemoryShareRelay>(relay, 'share relay').ackedThrough === 1,
        'ShareDO prefix is ACKed only after ordinary-room forwarding');
      const after = await storage.shares.openShare(rootKey, workspaceId, first.capId);
      assert(after.durableShare?.drainCursor === 1, 'mailbox cursor is sealed for crash-safe replay');
      assert(publishes === 1, 'mailbox drain does not republish a live room');
    } finally {
      credentials.shareSecret.fill(0); credentials.roomSecret.fill(0);
      credentials.identity.signingSecret.fill(0); reviewer.signingSecret.fill(0);
    }
  } finally { storage.close(); }
});

test('stop journals revoke, kills stable share and epoch room, then crypto-erases locally', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-v3-stop'; await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId); let relay: MemoryShareRelay | null = null; let roomDeletes = 0;
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => NOW, randomBytes: deterministicRandom(), createRoom: async options => bootstrapFromOptions(options),
      deleteRoom: async () => { roomDeletes += 1; return true; },
      publish: options => publishBrowserSnapshots({ ...options, indexBuilder }),
      indexBuilder,
      outboxFactory: ({ storage: db, credentials }) => new AckingOutbox(db, credentials.roomId),
      shareRelayFactory: options => (relay ??= new MemoryShareRelay(options.shareId)),
    });
    const first = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    const stopped = await coordinator.deleteRemote();
    assert(required<MemoryShareRelay>(relay, 'share relay').revoked && roomDeletes === 1, 'stable pointer and cached epoch both revoked');
    const rootKey = await storage.getWorkspaceRootKey(workspaceId); assert(rootKey, 'root key');
    const sealed = await storage.shares.openShare(rootKey, workspaceId, stopped.capId);
    assert(sealed.durableShare?.lifecycle === 'revoke_pending', 'revoke intent is durable before erasure');
    await coordinator.eraseLocal(stopped);
    assert((await storage.shares.listShares(workspaceId)).length === 0, 'owner secrets crypto-erased');
    relay = null;
    const recreated = await coordinator.ensurePublished(request('file', ['notes/main.md']));
    assert(recreated.shareId !== first.shareId && recreated.roomId !== first.roomId, 'recreate mints fresh ownership');
  } finally { storage.close(); }
});

test('scope and lease validation fail before network or stale mutation', async () => {
  const storage = await openStorage();
  try {
    const workspaceId = 'ws-v3-fence'; await seedWorkspace(storage, workspaceId);
    const fence = await acquireFence(storage, workspaceId); let network = 0;
    const coordinator = new BrowserWorkspaceSharingCoordinator(storage, workspaceId, fence, {
      now: () => NOW, randomBytes: deterministicRandom(),
      createRoom: async options => { network += 1; return bootstrapFromOptions(options); },
    });
    for (const invalid of [request('entries', ['missing.md']), request('entries', ['assets/image.png'])]) {
      let rejected = false; try { await coordinator.ensurePublished(invalid); } catch (error) { rejected = error instanceof BrowserStorageError; }
      assert(rejected, 'invalid scope rejected');
    }
    assert(network === 0, 'scope validation performs no relay work');
    let fenced = false;
    try { await storage.shares.forgetShareFenced(workspaceId, 'missing', { holderId: 'other', fencingToken: fence.fencingToken }); }
    catch (error) { fenced = error instanceof StorageConflictError; }
    assert(fenced, 'passive tab is fenced');
  } finally { storage.close(); }
});

const results = await Promise.all(cases.map(run => run()));
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? `\n${result.detail}` : ''}`);
const failures = results.filter(result => !result.ok);
console.log(`browser-workspace-sharing: ${results.length - failures.length} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
