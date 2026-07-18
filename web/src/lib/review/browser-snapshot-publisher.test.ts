import { decompressSnapshotIfNeeded } from './snapshot-compression';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { sha256 } from '@noble/hashes/sha2.js';
import { aeadOpen, base64UrlDecode, base64UrlEncode, contentHash, deriveFileId, deriveRoomKeys, deriveSnapshotId } from './browser-crypto';
import { generateBrowserIdentity } from './browser-session';
import {
  publishBrowserSnapshots,
  resumeBrowserSnapshotPublication,
  type SnapshotPublicationOutbox,
  type SnapshotPublicationSink,
  type SnapshotPublicationRevisionSource,
  type PublishedManifestPointer,
} from './browser-snapshot-publisher';
import type { MailboxEnvelope, RoomPolicy } from './browser-ws';
import type { WorkspaceFence } from './browser-workspace-store';
import { BrowserStorage } from './browser-storage';

Object.defineProperty(globalThis, 'IDBKeyRange', {
  configurable: true,
  value: IDBKeyRange,
});

interface Result { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<Result>> = [];
function test(name: string, fn: () => Promise<void>): void {
  cases.push(async () => {
    try { await fn(); return { name, ok: true }; }
    catch (error) { return { name, ok: false, detail: error instanceof Error ? error.stack : String(error) }; }
  });
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

class FakeOutbox implements SnapshotPublicationOutbox {
  readonly envelopes: MailboxEnvelope[] = [];
  failFlush = false;
  failBatch = false;
  flushes = 0;
  async enqueueBatchDurably(envelopes: readonly MailboxEnvelope[]): Promise<number> {
    if (this.failBatch) throw new Error('atomic batch failed');
    let inserted = 0;
    for (const envelope of envelopes) {
      const existing = this.envelopes.find((item) => item.envelopeId === envelope.envelopeId);
      if (existing) {
        equal(existing, envelope, 'duplicate ciphertext stays exact');
      } else {
        this.envelopes.push(structuredClone(envelope));
        inserted += 1;
      }
    }
    return inserted;
  }
  async flushNow(): Promise<void> {
    this.flushes += 1;
    if (this.failFlush) throw new Error('offline');
  }
}

class FakePublicationSink implements SnapshotPublicationSink {
  published?: PublishedManifestPointer;
  pending?: { pointer: PublishedManifestPointer; envelopes: MailboxEnvelope[] };
  commits = 0;
  async loadPublishedManifest(): Promise<PublishedManifestPointer | undefined> {
    return this.published === undefined ? undefined : structuredClone(this.published);
  }
  async stagePublication(
    _workspaceId: string,
    _capId: string,
    pointer: PublishedManifestPointer,
    envelopes: readonly MailboxEnvelope[],
    _fence: WorkspaceFence,
  ): Promise<void> {
    if (this.pending) throw new Error('pending publication exists');
    this.pending = {
      pointer: structuredClone(pointer),
      envelopes: envelopes.map((envelope) => structuredClone(envelope)),
    };
  }
  async loadPendingPublication(
    _workspaceId: string,
    _capId: string,
    _fence: WorkspaceFence,
  ): Promise<readonly MailboxEnvelope[]> {
    return structuredClone(this.pending?.envelopes ?? []);
  }
  async commitPublication(
    _workspaceId: string,
    _capId: string,
    _fence: WorkspaceFence,
  ): Promise<void> {
    if (!this.pending) throw new Error('no pending publication');
    this.published = this.pending.pointer;
    this.pending = undefined;
    this.commits += 1;
  }
}

const roomSecret = new Uint8Array(32).fill(7);
const keys = deriveRoomKeys(roomSecret);
const identity = generateBrowserIdentity();
const now = 1_700_000_000_000;
const fence: WorkspaceFence = { holderId: 'publisher-tab', fencingToken: 1 };
const revisionId = (fill: number): string => base64UrlEncode(new Uint8Array(16).fill(fill));
const policy: RoomPolicy = {
  mode: 'hybrid', maxPeers: 8, maxSnapshotBytes: 5 * 1024 * 1024,
  maxEventBytes: 256 * 1024, maxEvents: 500, expiresAt: now + 86_400_000,
  powBits: 12, deleteEventsAfterOwnerAck: false, allowBrowser: true,
  allowRemoteAgents: true,
};
let randomCounter = 1;
const randomBytes = (length: number): Uint8Array => new Uint8Array(length).fill(randomCounter++);
const indexBuilder = async (bytes: Uint8Array) => ({
  docHash: base64UrlEncode(sha256(bytes)), canonicalEncoding: 'utf8-bytes' as const,
  lineCount: new TextDecoder().decode(bytes).split('\n').length, blocks: [], headings: [],
});

function matchingRevisionSource(entries: Array<{
  path: string;
  revisionId: string;
  bytes: Uint8Array;
}>): SnapshotPublicationRevisionSource {
  const byId = new Map(entries.map((entry) => [entry.revisionId, entry]));
  return {
    getRevisionBody: async (_workspaceId, path, id) => {
      const entry = byId.get(id);
      if (!entry) throw new Error(`revision does not exist: ${id}`);
      if (entry.path !== path) throw new Error('revision belongs to a different workspace path');
      return new Uint8Array(entry.bytes);
    },
  };
}

async function open(envelope: MailboxEnvelope, key: Uint8Array): Promise<Record<string, unknown>> {
  const plaintext = aeadOpen(key, base64UrlDecode(envelope.nonce), base64UrlDecode(envelope.ciphertext), {
    v: 2, roomId: envelope.roomId!, envelopeId: envelope.envelopeId, kind: envelope.kind,
    authorId: envelope.authorId, deviceId: envelope.deviceId, createdAt: envelope.createdAt,
  });
  // Mirror of the receiver: snapshot plaintexts may arrive gzipped.
  const inflated = await decompressSnapshotIfNeeded(plaintext);
  try { return JSON.parse(new TextDecoder().decode(inflated)) as Record<string, unknown>; }
  finally { if (inflated !== plaintext) inflated.fill(0); plaintext.fill(0); }
}

test('file and snapshot IDs match the Rust byte composition from first principles', async () => {
  const enc = new TextEncoder();
  const path = 'nested/brief.md';
  const baseHash = 'hash-base64url';
  const fileInput = new Uint8Array(enc.encode('attn file v2').length + 32 + enc.encode(path).length + enc.encode(baseHash).length);
  let offset = 0;
  for (const part of [enc.encode('attn file v2'), roomSecret, enc.encode(path), enc.encode(baseHash)]) {
    fileInput.set(part, offset); offset += part.length;
  }
  const expectedFile = base64UrlEncode(sha256(fileInput).subarray(0, 16));
  equal(deriveFileId(roomSecret, path, baseHash), expectedFile, 'FileId');
  const pieces = ['snapshot v2', 'room-id', expectedFile, baseHash, String(now)].map((part) => enc.encode(part));
  const snapshotInput = new Uint8Array(pieces.reduce((sum, part) => sum + part.length, 0));
  offset = 0;
  for (const part of pieces) { snapshotInput.set(part, offset); offset += part.length; }
  equal(deriveSnapshotId('room-id', expectedFile, baseHash, now), base64UrlEncode(sha256(snapshotInput).subarray(0, 16)), 'SnapshotId');
  fileInput.fill(0); snapshotInput.fill(0);
});

test('mailbox publishes blob before signed pointer and marks only after ACK', async () => {
  const outbox = new FakeOutbox();
  const sink = new FakePublicationSink();
  const markdown = '# Secret title\n\nBody only peers may read.\n';
  const source = {
    path: 'notes/brief.md',
    bytes: new TextEncoder().encode(markdown),
    docType: 'markdown' as const,
    revisionId: revisionId(61),
  };
  const [result] = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-publish', roomSecret, keys, identity, policy,
    entries: [source], indexBuilder,
    outbox, now: () => now, randomBytes,
    publication: {
      workspaceId: 'ws', capId: 'cap', sink, fence,
      revisionSource: matchingRevisionSource([source]),
    },
  });
  assert(result, 'publication result');
  equal(result.path, 'notes/brief.md', 'normalized owner path');
  equal(
    sink.published?.entries[0]?.revisionId,
    revisionId(61),
    'sealed pointer binds exact source revision',
  );
  equal(outbox.envelopes.map((e) => e.kind), ['snapshot_blob', 'event', 'snapshot_blob', 'event'], 'entry pair precedes manifest pair');
  equal(sink.commits, 1, 'published after successful flush');
  assert(!JSON.stringify(outbox.envelopes).includes('Secret title'), 'wire is content-blind');
  const snapshot = await open(outbox.envelopes[0]!, keys.snapshotKey);
  equal(snapshot.docType, 'markdown', 'snapshot doc type');
  equal(snapshot.content, markdown, 'snapshot content decrypts');
  const event = await open(outbox.envelopes[1]!, keys.eventKey);
  const body = event.body as Record<string, unknown>;
  equal(body.type, 'snapshot_created', 'signed pointer type');
  assert(!('inlineSnapshot' in body), 'plaintext is never inline');
  equal((body.encryptedBlobRef as Record<string, unknown>).blobId, result.blobRef.blobId, 'pointer binds blob');
  const manifest = await open(outbox.envelopes[2]!, keys.snapshotKey);
  equal(manifest.docType, 'workspace_manifest', 'manifest is the final blob');
  equal(((manifest.manifest as Record<string, unknown>).entries as unknown[]).length, 1, 'manifest lists entry');
});

test('owner genesis prefix is journaled and flushed before initial snapshots', async () => {
  const outbox = new FakeOutbox();
  const sink = new FakePublicationSink();
  const roomId = 'room-prefix';
  const prefix: MailboxEnvelope[] = [1, 2].map((fill) => ({
    v: 2,
    roomId,
    envelopeId: base64UrlEncode(new Uint8Array(16).fill(fill)),
    authorId: identity.participantId,
    deviceId: identity.deviceId,
    createdAt: now - 3 + fill,
    expiresAt: policy.expiresAt,
    kind: 'event',
    nonce: base64UrlEncode(new Uint8Array(24).fill(fill)),
    ciphertext: base64UrlEncode(new Uint8Array(32).fill(fill)),
    ciphertextBytes: 32,
  }));
  const source = {
    path: 'genesis.md',
    bytes: new TextEncoder().encode('# Initial publication'),
    docType: 'markdown' as const,
    revisionId: revisionId(62),
  };
  await publishBrowserSnapshots({
    relayUrl: 'https://relay.example',
    roomId,
    roomSecret,
    keys,
    identity,
    policy,
    entries: [source],
    prefixEnvelopes: prefix,
    indexBuilder,
    outbox,
    now: () => now,
    randomBytes,
    publication: {
      workspaceId: 'ws-prefix',
      capId: 'cap-prefix',
      sink,
      fence,
      revisionSource: matchingRevisionSource([source]),
    },
  });
  equal(
    outbox.envelopes.slice(0, 2).map((envelope) => envelope.envelopeId),
    prefix.map((envelope) => envelope.envelopeId),
    'RoomCreated and owner ParticipantJoined retain prefix order',
  );
  equal(sink.commits, 1, 'prefix is inside the acknowledged publication boundary');
});

test('fenced publication requires an exact source revision', async () => {
  const sink = new FakePublicationSink();
  sink.published = {
    manifestSnapshotId: base64UrlEncode(new Uint8Array(16).fill(70)),
    entries: [{
      path: 'legacy.md',
      fileId: base64UrlEncode(new Uint8Array(16).fill(71)),
      snapshotId: base64UrlEncode(new Uint8Array(16).fill(72)),
      contentHash: base64UrlEncode(new Uint8Array(32).fill(73)),
    }],
  };
  let failed = false;
  try {
    await publishBrowserSnapshots({
      relayUrl: 'https://relay.example',
      roomId: 'room-revision-required',
      roomSecret,
      keys,
      identity,
      policy,
      entries: [{
        path: 'legacy.md',
        bytes: new TextEncoder().encode('new bytes'),
        docType: 'markdown',
      }],
      outbox: new FakeOutbox(),
      publication: {
        workspaceId: 'ws', capId: 'cap', sink, fence,
        revisionSource: matchingRevisionSource([]),
      },
      now: () => now,
      randomBytes,
      indexBuilder,
    });
  } catch {
    failed = true;
  }
  assert(failed, 'new fenced publication accepted no exact source revision');
});

test('real workspace revision source rejects wrong revision, wrong path, and tampered bytes', async () => {
  const storage = await BrowserStorage.open({
    indexedDB: new IDBFactory(),
    databaseName: 'snapshot-publisher-real-revision-source',
    createIfMissing: true,
    filesystem: null,
    navigator: null,
    now: () => now,
  });
  try {
    const workspaceId = 'ws-real-revision-source';
    const path = 'verified.md';
    const bytes = new TextEncoder().encode('verified revision bytes');
    const created = await storage.workspaces.createWorkspace({
      workspaceId,
      name: 'Revision source',
      storagePersisted: true,
      entry: { path, kind: 'markdown', body: bytes },
    });
    const attempt = async (entry: {
      path: string;
      revisionId: string;
      bytes: Uint8Array;
    }): Promise<{ failed: boolean; sink: FakePublicationSink; outbox: FakeOutbox }> => {
      const sink = new FakePublicationSink();
      const outbox = new FakeOutbox();
      let failed = false;
      try {
        await publishBrowserSnapshots({
          relayUrl: 'https://relay.example',
          roomId: 'room-real-revision-source',
          roomSecret,
          keys,
          identity,
          policy,
          entries: [{ ...entry, docType: 'markdown' }],
          outbox,
          publication: {
            workspaceId,
            capId: 'cap-real',
            sink,
            fence,
            revisionSource: storage.workspaces,
          },
          now: () => now,
          randomBytes,
          indexBuilder,
        });
      } catch {
        failed = true;
      }
      return { failed, sink, outbox };
    };

    const missing = await attempt({
      path,
      revisionId: revisionId(91),
      bytes,
    });
    assert(missing.failed, 'unknown revision was accepted');
    equal(missing.outbox.envelopes.length, 0, 'unknown revision assembled no envelopes');

    const wrongPath = await attempt({
      path: 'other.md',
      revisionId: created.revision.revisionId,
      bytes,
    });
    assert(wrongPath.failed, 'revision bound to another path was accepted');
    equal(wrongPath.outbox.envelopes.length, 0, 'wrong path assembled no envelopes');

    const tampered = await attempt({
      path,
      revisionId: created.revision.revisionId,
      bytes: new TextEncoder().encode('tampered caller bytes'),
    });
    assert(tampered.failed, 'tampered bytes were accepted');
    equal(tampered.outbox.envelopes.length, 0, 'tampered bytes assembled no envelopes');

    const valid = await attempt({ path, revisionId: created.revision.revisionId, bytes });
    assert(!valid.failed, 'exact stored revision was rejected');
    assert(valid.sink.published, 'exact stored revision was published');
  } finally {
    storage.close();
  }
});

test('binary asset with NUL publishes base64url and canonical metadata without UTF-8 decoding', async () => {
  const outbox = new FakeOutbox();
  const bytes = new Uint8Array([0, 255, 128, 65, 0]);
  const results = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-assets', roomSecret, keys, identity, policy,
    entries: [{ path: 'assets/raw.bin', bytes, docType: 'asset', mediaType: 'application/octet-stream' }],
    outbox, now: () => now, randomBytes, indexBuilder,
  });
  equal(results.map((result) => result.kind), ['asset', 'workspace_manifest'], 'asset then manifest');
  const asset = await open(outbox.envelopes[0]!, keys.snapshotKey);
  equal(asset.content, base64UrlEncode(bytes), 'arbitrary bytes use unpadded base64url');
  equal(asset.encoding, 'base64url', 'encoding is explicit');
  equal(asset.mediaType, 'application/octet-stream', 'media type retained');
  const manifest = await open(outbox.envelopes[2]!, keys.snapshotKey);
  const entry = ((manifest.manifest as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0]!;
  equal(entry.byteLength, bytes.length, 'manifest hashes raw byte length');
  equal(entry.contentHash, contentHash(bytes), 'manifest hashes raw bytes');
});

test('failure before ACK stays pending and resume marks without republishing', async () => {
  const outbox = new FakeOutbox();
  outbox.failFlush = true;
  const sink = new FakePublicationSink();
  const source = {
    path: 'a.md', bytes: new TextEncoder().encode('retry secret'), docType: 'markdown' as const,
    revisionId: revisionId(62),
  };
  const publication = {
    workspaceId: 'ws', capId: 'cap', sink, fence,
    revisionSource: matchingRevisionSource([source]),
  };
  let failed = false;
  try {
    await publishBrowserSnapshots({
      relayUrl: 'https://relay.example', roomId: 'room-retry', roomSecret, keys, identity, policy,
      entries: [source],
      outbox, now: () => now, randomBytes, publication, indexBuilder,
    });
  } catch { failed = true; }
  assert(failed, 'flush failure surfaces');
  equal(sink.commits, 0, 'publication not advanced before ACK');
  const exact = JSON.stringify(outbox.envelopes);
  outbox.failFlush = false;
  await resumeBrowserSnapshotPublication(outbox, publication);
  equal(JSON.stringify(outbox.envelopes), exact, 'resume reuses exact sealed ciphertext');
  equal(sink.commits, 1, 'resume advances after ACK');
});

test('R2 spill seals body, queues wrapper, and republish reuses FileId', async () => {
  // Near-incompressible on purpose: compression now runs before the R2
  // spill decision, so a compressible fixture would (correctly) stay in
  // the mailbox. Deterministic xorshift bytes mapped to a base64 alphabet
  // stay valid UTF-8 markdown while gzip only shaves ~25%; 2 MiB of it
  // stays comfortably above the 1 MiB spill threshold after compression.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const large = new Uint8Array(2 * 1024 * 1024);
  let seed = 0x9e3779b9;
  for (let i = 0; i < large.length; i += 1) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    large[i] = alphabet.charCodeAt(seed & 63);
  }
  const firstOutbox = new FakeOutbox();
  let uploaded = 0;
  const [first] = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-r2', roomSecret, keys, identity, policy,
    entries: [{ path: 'large.md', bytes: large, docType: 'markdown' }], outbox: firstOutbox,
    now: () => now, randomBytes, indexBuilder,
    uploadR2: async (input) => { uploaded += 1; assert(input.sealedBody.length > 1024 * 1024, 'R2 body sealed above the spill threshold (compressed wire)'); },
  });
  assert(first, 'first result');
  equal(first.blobRef.storage, 'r2', 'R2 selected above threshold');
  equal(firstOutbox.envelopes.map((e) => e.kind), ['snapshot_blob', 'event', 'snapshot_blob', 'event'], 'entry precedes manifest');
  equal(uploaded, 1, 'one presign/PUT operation');

  const secondOutbox = new FakeOutbox();
  const [second] = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-r2', roomSecret, keys, identity, policy,
    entries: [{ path: 'large.md', bytes: new TextEncoder().encode('changed'), docType: 'markdown', fileId: first.fileId }],
    outbox: secondOutbox, now: () => now + 1, randomBytes, indexBuilder,
  });
  assert(second, 'second result');
  equal(second.fileId, first.fileId, 'republish keeps stable file identity');
  assert(second.snapshotId !== first.snapshotId, 'republish mints a new snapshot identity');
});

test('sealed publication journal automatically preserves FileId and explicit rename identity', async () => {
  const priorFileId = base64UrlEncode(new Uint8Array(16).fill(31));
  const sink = new FakePublicationSink();
  sink.published = {
    manifestSnapshotId: base64UrlEncode(new Uint8Array(16).fill(30)),
    entries: [{
      path: 'same.md',
      fileId: priorFileId,
      snapshotId: base64UrlEncode(new Uint8Array(16).fill(32)),
      contentHash: base64UrlEncode(new Uint8Array(32).fill(33)),
    }],
  };
  const outbox = new FakeOutbox();
  const sameSource = {
    path: 'same.md', bytes: new TextEncoder().encode('edited'), docType: 'markdown' as const,
    revisionId: revisionId(63),
  };
  const results = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-stable', roomSecret, keys, identity, policy,
    entries: [sameSource],
    outbox, now: () => now, randomBytes, indexBuilder,
    publication: {
      workspaceId: 'ws', capId: 'cap', sink, fence,
      revisionSource: matchingRevisionSource([sameSource]),
    },
  });
  equal(results[0]?.fileId, priorFileId, 'same path reuses sealed prior FileId automatically');

  const renamedOutbox = new FakeOutbox();
  const renamedSink = new FakePublicationSink();
  const renamedSource = {
    path: 'renamed.md', bytes: new TextEncoder().encode('edited again'),
    docType: 'markdown' as const, fileId: priorFileId, revisionId: revisionId(64),
  };
  const renamed = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-stable', roomSecret, keys, identity, policy,
    entries: [renamedSource],
    outbox: renamedOutbox, now: () => now + 1, randomBytes, indexBuilder,
    publication: {
      workspaceId: 'ws', capId: 'cap', sink: renamedSink, fence,
      revisionSource: matchingRevisionSource([renamedSource]),
    },
  });
  equal(renamed[0]?.fileId, priorFileId, 'durable local identity survives rename');
});

test('invalid or duplicate supplied FileIds fail before any R2 upload or durable enqueue', async () => {
  let uploads = 0;
  const outbox = new FakeOutbox();
  let failed = false;
  try {
    await publishBrowserSnapshots({
      relayUrl: 'https://relay.example', roomId: 'room-invalid-id', roomSecret, keys, identity, policy,
      entries: [{
        path: 'large.md', bytes: new Uint8Array(1024 * 1024 + 1), docType: 'markdown', fileId: 'bad',
      }],
      outbox, now: () => now, randomBytes, indexBuilder,
      uploadR2: async () => { uploads += 1; },
    });
  } catch { failed = true; }
  assert(failed, 'invalid supplied id rejected');
  equal(uploads, 0, 'no upload before identifier validation');
  equal(outbox.envelopes.length, 0, 'no durable enqueue before identifier validation');

  const duplicate = base64UrlEncode(new Uint8Array(16).fill(44));
  failed = false;
  try {
    await publishBrowserSnapshots({
      relayUrl: 'https://relay.example', roomId: 'room-duplicate-id', roomSecret, keys, identity, policy,
      entries: [
        { path: 'a.md', bytes: new TextEncoder().encode('a'), docType: 'markdown', fileId: duplicate },
        { path: 'b.md', bytes: new TextEncoder().encode('b'), docType: 'markdown', fileId: duplicate },
      ],
      outbox, now: () => now, randomBytes, indexBuilder,
    });
  } catch { failed = true; }
  assert(failed, 'duplicate file identity rejected');
  equal(outbox.envelopes.length, 0, 'duplicate fails before durable enqueue');
});

const results = await Promise.all(cases.map((run) => run()));
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? `\n${result.detail}` : ''}`);
const failures = results.filter((result) => !result.ok);
console.log(`browser-snapshot-publisher: ${results.length - failures.length} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
