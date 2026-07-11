import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  aeadOpen,
  base64UrlDecode,
  base64UrlEncode,
  deriveRoomIdV3,
  deriveRoomKeyTreeV3,
} from './browser-crypto';
import type { CreateOwnedRoomOptions, OwnedRoomBootstrapV3 } from './browser-owner-bootstrap';
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
  async upsert(request: BrowserShareUpsertRequest): Promise<BrowserShareRelayRecord> {
    this.upserts.push(structuredClone(request));
    this.record = {
      v: 3, shareId: this.shareId, ownerSigningKey: request.ownerSigningKey,
      epoch: request.epoch, revision: request.revision,
      ...(request.currentRoomId === null ? {} : { currentRoomId: request.currentRoomId }),
      snapshots: structuredClone(request.snapshots), placeholders: structuredClone(request.placeholders),
      manifestDigest: digestShareSnapshotManifest(request.snapshots), updatedAt: NOW,
      expiresAt: NOW + 90 * 24 * 60 * 60 * 1000,
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
