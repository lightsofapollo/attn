import { sha256 } from '@noble/hashes/sha2.js';
import { aeadOpen, base64UrlDecode, base64UrlEncode, contentHash, deriveFileId, deriveRoomKeys, deriveSnapshotId } from './browser-crypto';
import { generateBrowserIdentity } from './browser-session';
import {
  publishBrowserSnapshots,
  resumeBrowserSnapshotPublication,
  type SnapshotPublicationOutbox,
  type SnapshotPublicationSink,
  type PublishedManifestPointer,
} from './browser-snapshot-publisher';
import type { MailboxEnvelope, RoomPolicy } from './browser-ws';

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
  ): Promise<void> {
    if (this.pending) throw new Error('pending publication exists');
    this.pending = {
      pointer: structuredClone(pointer),
      envelopes: envelopes.map((envelope) => structuredClone(envelope)),
    };
  }
  async loadPendingPublication(): Promise<readonly MailboxEnvelope[]> {
    return structuredClone(this.pending?.envelopes ?? []);
  }
  async commitPublication(): Promise<void> {
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

function open(envelope: MailboxEnvelope, key: Uint8Array): Record<string, unknown> {
  const plaintext = aeadOpen(key, base64UrlDecode(envelope.nonce), base64UrlDecode(envelope.ciphertext), {
    v: 2, roomId: envelope.roomId!, envelopeId: envelope.envelopeId, kind: envelope.kind,
    authorId: envelope.authorId, deviceId: envelope.deviceId, createdAt: envelope.createdAt,
  });
  try { return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>; }
  finally { plaintext.fill(0); }
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
  const [result] = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-publish', roomSecret, keys, identity, policy,
    entries: [{ path: 'notes/brief.md', bytes: new TextEncoder().encode(markdown), docType: 'markdown' }], indexBuilder,
    outbox, now: () => now, randomBytes,
    publication: { workspaceId: 'ws', capId: 'cap', sink },
  });
  assert(result, 'publication result');
  equal(result.path, 'notes/brief.md', 'normalized owner path');
  equal(outbox.envelopes.map((e) => e.kind), ['snapshot_blob', 'event', 'snapshot_blob', 'event'], 'entry pair precedes manifest pair');
  equal(sink.commits, 1, 'published after successful flush');
  assert(!JSON.stringify(outbox.envelopes).includes('Secret title'), 'wire is content-blind');
  const snapshot = open(outbox.envelopes[0]!, keys.snapshotKey);
  equal(snapshot.docType, 'markdown', 'snapshot doc type');
  equal(snapshot.content, markdown, 'snapshot content decrypts');
  const event = open(outbox.envelopes[1]!, keys.eventKey);
  const body = event.body as Record<string, unknown>;
  equal(body.type, 'snapshot_created', 'signed pointer type');
  assert(!('inlineSnapshot' in body), 'plaintext is never inline');
  equal((body.encryptedBlobRef as Record<string, unknown>).blobId, result.blobRef.blobId, 'pointer binds blob');
  const manifest = open(outbox.envelopes[2]!, keys.snapshotKey);
  equal(manifest.docType, 'workspace_manifest', 'manifest is the final blob');
  equal(((manifest.manifest as Record<string, unknown>).entries as unknown[]).length, 1, 'manifest lists entry');
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
  const asset = open(outbox.envelopes[0]!, keys.snapshotKey);
  equal(asset.content, base64UrlEncode(bytes), 'arbitrary bytes use unpadded base64url');
  equal(asset.encoding, 'base64url', 'encoding is explicit');
  equal(asset.mediaType, 'application/octet-stream', 'media type retained');
  const manifest = open(outbox.envelopes[2]!, keys.snapshotKey);
  const entry = ((manifest.manifest as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0]!;
  equal(entry.byteLength, bytes.length, 'manifest hashes raw byte length');
  equal(entry.contentHash, contentHash(bytes), 'manifest hashes raw bytes');
});

test('failure before ACK stays pending and resume marks without republishing', async () => {
  const outbox = new FakeOutbox();
  outbox.failFlush = true;
  const sink = new FakePublicationSink();
  const publication = { workspaceId: 'ws', capId: 'cap', sink };
  let failed = false;
  try {
    await publishBrowserSnapshots({
      relayUrl: 'https://relay.example', roomId: 'room-retry', roomSecret, keys, identity, policy,
      entries: [{ path: 'a.md', bytes: new TextEncoder().encode('retry secret'), docType: 'markdown' }],
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
  const large = new Uint8Array(1024 * 1024 + 64).fill(65);
  const firstOutbox = new FakeOutbox();
  let uploaded = 0;
  const [first] = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-r2', roomSecret, keys, identity, policy,
    entries: [{ path: 'large.md', bytes: large, docType: 'markdown' }], outbox: firstOutbox,
    now: () => now, randomBytes, indexBuilder,
    uploadR2: async (input) => { uploaded += 1; assert(input.sealedBody.length > large.length, 'R2 body sealed'); },
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
  const results = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-stable', roomSecret, keys, identity, policy,
    entries: [{ path: 'same.md', bytes: new TextEncoder().encode('edited'), docType: 'markdown' }],
    outbox, now: () => now, randomBytes, indexBuilder,
    publication: { workspaceId: 'ws', capId: 'cap', sink },
  });
  equal(results[0]?.fileId, priorFileId, 'same path reuses sealed prior FileId automatically');

  const renamedOutbox = new FakeOutbox();
  const renamedSink = new FakePublicationSink();
  const renamed = await publishBrowserSnapshots({
    relayUrl: 'https://relay.example', roomId: 'room-stable', roomSecret, keys, identity, policy,
    entries: [{
      path: 'renamed.md', bytes: new TextEncoder().encode('edited again'), docType: 'markdown',
      fileId: priorFileId,
    }],
    outbox: renamedOutbox, now: () => now + 1, randomBytes, indexBuilder,
    publication: { workspaceId: 'ws', capId: 'cap', sink: renamedSink },
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
