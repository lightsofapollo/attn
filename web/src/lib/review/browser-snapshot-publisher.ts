import type {
  AnchorIndex,
  BlobRef,
  ReviewEventBody,
  SnapshotPlaintext,
  WorkspaceManifestEntry,
  WorkspaceManifestEntryKind,
  WorkspaceManifestScope,
} from '../types';
import {
  base64UrlEncode,
  base64UrlDecode,
  contentHash,
  deriveFileId,
  deriveSnapshotId,
  deriveWorkspaceManifestFileId,
  toCanonicalBytes,
  type RoomKeys,
} from './browser-crypto';
import { assembleBrowserEvent, assembleSnapshotBlobEnvelope } from './browser-envelope';
import type { BrowserDeviceIdentity } from './browser-session';
import type { WorkspaceFence } from './browser-workspace-store';
import { compressSnapshotIfSmaller } from './snapshot-compression';
import {
  sealSnapshotR2Body,
  uploadBrowserR2Snapshot,
  type UploadBrowserR2SnapshotOptions,
} from './browser-snapshot-r2';
import {
  compareManifestPathsUtf8,
  createWorkspaceManifest,
  isValidSnapshotMediaType,
} from './browser-workspace-manifest';
import { normalizeEntryPath } from './browser-workspace-schema';
import type { MailboxEnvelope, RoomPolicy } from './browser-ws';

export const SNAPSHOT_MAILBOX_THRESHOLD_BYTES = 1024 * 1024;

interface BrowserSnapshotEntryBase {
  path: string;
  bytes: Uint8Array;
  /** Reuse this identity across edits and renames. */
  fileId?: string;
  /** Exact sealed workspace revision whose bytes are being published. */
  revisionId?: string;
}

export type BrowserSnapshotEntry =
  | (BrowserSnapshotEntryBase & { docType: 'markdown' })
  | (BrowserSnapshotEntryBase & { docType: 'html' })
  | (BrowserSnapshotEntryBase & { docType: 'asset'; mediaType: string });

export interface SnapshotPublicationOutbox {
  enqueueBatchDurably(envelopes: readonly MailboxEnvelope[]): Promise<number>;
  flushNow(): Promise<void>;
}

export interface PublishedManifestPointer {
  manifestSnapshotId: string;
  entries: Array<{
    path: string;
    fileId: string;
    snapshotId: string;
    contentHash: string;
    /** Added after v1 launch; absent legacy pointers remain readable. */
    revisionId?: string;
  }>;
}

export interface SnapshotPublicationSink {
  loadPublishedManifest(
    workspaceId: string,
    capId: string,
  ): Promise<PublishedManifestPointer | undefined>;
  stagePublication(
    workspaceId: string,
    capId: string,
    publishedManifest: PublishedManifestPointer,
    envelopes: readonly MailboxEnvelope[],
    fence: WorkspaceFence,
  ): Promise<unknown>;
  loadPendingPublication(
    workspaceId: string,
    capId: string,
    fence: WorkspaceFence,
  ): Promise<readonly MailboxEnvelope[]>;
  commitPublication(
    workspaceId: string,
    capId: string,
    fence: WorkspaceFence,
  ): Promise<unknown>;
}

export interface SnapshotPublicationRevisionSource {
  getRevisionBody(
    workspaceId: string,
    path: string,
    revisionId: string,
  ): Promise<Uint8Array>;
}

export interface BrowserSnapshotPublicationResult {
  kind: WorkspaceManifestEntryKind | 'workspace_manifest';
  path?: string;
  fileId: string;
  snapshotId: string;
  baseHash: string;
  blobRef: BlobRef;
}

export interface PublishBrowserSnapshotsOptions {
  protocolVersion?: 2 | 3;
  relayUrl: string;
  roomId: string;
  roomSecret: Uint8Array;
  keys: RoomKeys;
  identity: BrowserDeviceIdentity;
  policy: RoomPolicy;
  entries: readonly BrowserSnapshotEntry[];
  /** One-time room genesis events, atomically journaled before initial snapshots. */
  prefixEnvelopes?: readonly MailboxEnvelope[];
  scope?: WorkspaceManifestScope;
  outbox: SnapshotPublicationOutbox;
  publication?: {
    sink: SnapshotPublicationSink;
    workspaceId: string;
    capId: string;
    fence: WorkspaceFence;
    /** Opens the exact workspace revision before any envelope is assembled. */
    revisionSource: SnapshotPublicationRevisionSource;
  };
  /** Test seam; production always resolves the canonical Rust/comrak WASM builder. */
  indexBuilder?: (markdown: Uint8Array, snapshotId: string) => Promise<AnchorIndex>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  uploadR2?: (options: UploadBrowserR2SnapshotOptions) => Promise<void>;
}

/** Publish entry blobs/pointers first and the canonical workspace manifest last. */
export async function publishBrowserSnapshots(
  options: PublishBrowserSnapshotsOptions,
): Promise<BrowserSnapshotPublicationResult[]> {
  validateOptions(options);
  const createdAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error('publication clock must return a positive safe integer');
  }
  const random = options.randomBytes ?? secureRandom;
  const sources = options.entries
    .map((source) => ({ ...source, path: normalizeEntryPath(source.path) }))
    .sort((a, b) => compareManifestPathsUtf8(a.path, b.path));
  for (let i = 1; i < sources.length; i += 1) {
    if (sources[i - 1]!.path === sources[i]!.path) {
      throw new Error(`duplicate snapshot entry path: ${sources[i]!.path}`);
    }
  }

  const previous = options.publication
    ? await options.publication.sink.loadPublishedManifest(
        options.publication.workspaceId,
        options.publication.capId,
      )
    : undefined;
  if (previous) validatePublishedPointerForReuse(previous);
  const previousByPath = new Map(previous?.entries.map((entry) => [entry.path, entry]));
  const resolved = await Promise.all(sources.map(async (source) => {
    const baseHash = contentHash(source.bytes);
    const fileId = source.fileId ?? previousByPath.get(source.path)?.fileId
      ?? deriveFileId(options.roomSecret, source.path, baseHash);
    requireCanonicalId(fileId, 16, `snapshot entry fileId for ${source.path}`);
    if (source.revisionId !== undefined) {
      requireCanonicalId(source.revisionId, 16, `source revisionId for ${source.path}`);
    }
    if (options.publication) {
      const revisionId = source.revisionId!;
      const stored = await options.publication.revisionSource.getRevisionBody(
        options.publication.workspaceId,
        source.path,
        revisionId,
      );
      if (!(stored instanceof Uint8Array)) {
        throw new Error(`revision source returned invalid bytes: ${source.path}`);
      }
      try {
        const storedHash = contentHash(stored);
        if (storedHash !== baseHash || !sameBytes(stored, source.bytes)) {
          throw new Error(`snapshot bytes do not match workspace revision: ${source.path}`);
        }
      } finally {
        stored.fill(0);
      }
    }
    return { source, baseHash, fileId };
  }));
  const fileIds = new Set<string>();
  for (const item of resolved) {
    if (fileIds.has(item.fileId)) throw new Error(`duplicate snapshot entry fileId: ${item.fileId}`);
    fileIds.add(item.fileId);
  }

  const results: BrowserSnapshotPublicationResult[] = [];
  const manifestEntries: WorkspaceManifestEntry[] = [];
  const envelopes: MailboxEnvelope[] = (options.prefixEnvelopes ?? []).map((envelope) =>
    structuredClone(envelope)
  );

  for (const { source, baseHash, fileId } of resolved) {
    const snapshotId = deriveSnapshotId(options.roomId, fileId, baseHash, createdAt);
    const plaintext = await entryPlaintext(source, snapshotId, options.indexBuilder);
    const published = await prepareSnapshot(options, plaintext, fileId, snapshotId, baseHash, createdAt, random, source.path);
    envelopes.push(...published.envelopes);
    results.push({ kind: source.docType, path: source.path, fileId, snapshotId, baseHash, blobRef: published.blobRef });
    manifestEntries.push({
      fileId,
      snapshotId,
      path: source.path,
      kind: source.docType,
      ...(source.docType === 'asset' ? { mediaType: source.mediaType } : {}),
      byteLength: source.bytes.length,
      contentHash: baseHash,
    });
  }

  const manifest = createWorkspaceManifest(options.scope ?? 'workspace', manifestEntries);
  const manifestPlaintext: SnapshotPlaintext = { docType: 'workspace_manifest', manifest };
  const manifestBytes = toCanonicalBytes(manifest);
  const manifestBaseHash = contentHash(manifestBytes);
  manifestBytes.fill(0);
  const manifestFileId = deriveWorkspaceManifestFileId(options.roomSecret);
  const manifestSnapshotId = deriveSnapshotId(
    options.roomId,
    manifestFileId,
    manifestBaseHash,
    createdAt,
  );
  const publishedManifest = await prepareSnapshot(
    options,
    manifestPlaintext,
    manifestFileId,
    manifestSnapshotId,
    manifestBaseHash,
    createdAt,
    random,
  );
  envelopes.push(...publishedManifest.envelopes);
  results.push({
    kind: 'workspace_manifest',
    fileId: manifestFileId,
    snapshotId: manifestSnapshotId,
    baseHash: manifestBaseHash,
    blobRef: publishedManifest.blobRef,
  });

  const resolvedByPath = new Map(resolved.map((item) => [item.source.path, item]));
  const pointer: PublishedManifestPointer = {
    manifestSnapshotId,
    entries: manifest.entries.map(({ path, fileId, snapshotId, contentHash: hash }) => {
      const revisionId = resolvedByPath.get(path)?.source.revisionId;
      return {
        path,
        fileId,
        snapshotId,
        contentHash: hash,
        ...(revisionId === undefined ? {} : { revisionId }),
      };
    }),
  };
  // For browser-owned rooms stagePublication atomically seals the pointer and
  // installs the complete ciphertext batch in the durable outbox. The outbox
  // call then adopts those exact rows into this live instance (idempotently).
  if (options.publication) {
    await options.publication.sink.stagePublication(
      options.publication.workspaceId,
      options.publication.capId,
      pointer,
      envelopes,
      options.publication.fence,
    );
  }
  await options.outbox.enqueueBatchDurably(envelopes);
  await resumeBrowserSnapshotPublication(options.outbox, options.publication);
  return results;
}

/** Recover exact durable ciphertext, flush it, then promote its sealed pointer. */
export async function resumeBrowserSnapshotPublication(
  outbox: SnapshotPublicationOutbox,
  publication?: PublishBrowserSnapshotsOptions['publication'],
): Promise<void> {
  if (publication) {
    const pending = await publication.sink.loadPendingPublication(
      publication.workspaceId,
      publication.capId,
      publication.fence,
    );
    await outbox.enqueueBatchDurably(pending);
  }
  await outbox.flushNow();
  if (publication) {
    await publication.sink.commitPublication(
      publication.workspaceId,
      publication.capId,
      publication.fence,
    );
  }
}

async function entryPlaintext(
  source: BrowserSnapshotEntry,
  snapshotId: string,
  injected?: PublishBrowserSnapshotsOptions['indexBuilder'],
): Promise<SnapshotPlaintext> {
  if (source.docType === 'asset') {
    return {
      docType: 'asset',
      content: base64UrlEncode(source.bytes),
      mediaType: source.mediaType,
      encoding: 'base64url',
    };
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
  if (source.docType === 'html') return { docType: 'html', content };
  const builder = injected ?? (await import('./browser-anchor-index')).buildCanonicalAnchorIndex;
  return { docType: 'markdown', content, anchorIndex: await builder(source.bytes, snapshotId) };
}

async function prepareSnapshot(
  options: PublishBrowserSnapshotsOptions,
  value: SnapshotPlaintext,
  fileId: string,
  snapshotId: string,
  baseHash: string,
  createdAt: number,
  random: (length: number) => Uint8Array,
  ownerDisplayPath?: string,
): Promise<{ blobRef: BlobRef; envelopes: [MailboxEnvelope, MailboxEnvelope] }> {
  const plaintext = toCanonicalBytes(value);
  // BlobRef integrity (byteLength/contentHash) is computed over the LOGICAL
  // plaintext; the compressed form below is transport-only and invisible
  // above the seal boundary.
  const blobHash = contentHash(plaintext);
  const wire = await compressSnapshotIfSmaller(plaintext);
  const clientNonce = randomExact(random, 16, 'client nonce');
  let sealedBody: Uint8Array | null = null;
  try {
    const candidate = assembleSnapshotBlobEnvelope({
      plaintext: wire,
      snapshotKey: options.keys.snapshotKey,
      roomId: options.roomId,
      authorId: options.identity.participantId,
      deviceId: options.identity.deviceId,
      clientNonce,
      createdAt,
      expiresAt: options.policy.expiresAt,
    });
    let wrapper = candidate;
    let storage: 'mailbox' | 'r2' = 'mailbox';
    if (candidate.ciphertextBytes > SNAPSHOT_MAILBOX_THRESHOLD_BYTES) {
      const refBytes = toCanonicalBytes({
        storage: 'r2',
        blobId: candidate.envelopeId,
        byteLength: plaintext.length,
        contentHash: blobHash,
      } satisfies BlobRef);
      try {
        wrapper = assembleSnapshotBlobEnvelope({
          plaintext: refBytes,
          snapshotKey: options.keys.snapshotKey,
          roomId: options.roomId,
          authorId: options.identity.participantId,
          deviceId: options.identity.deviceId,
          clientNonce,
          createdAt,
          expiresAt: options.policy.expiresAt,
        });
      } finally {
        refBytes.fill(0);
      }
      sealedBody = sealSnapshotR2Body({ snapshotKey: options.keys.snapshotKey, plaintext: wire, wrapper });
      if (sealedBody.length > options.policy.maxSnapshotBytes) {
        throw new Error('encrypted snapshot exceeds the room snapshot limit');
      }
      await (options.uploadR2 ?? uploadBrowserR2Snapshot)({
        protocolVersion: options.protocolVersion,
        relayUrl: options.relayUrl,
        roomId: options.roomId,
        admissionKey: options.keys.admissionKey,
        envelopeId: wrapper.envelopeId,
        authorId: options.identity.participantId,
        deviceId: options.identity.deviceId,
        sealedBody,
        powBits: options.policy.powBits,
      });
      storage = 'r2';
    }
    if (candidate.ciphertextBytes > options.policy.maxSnapshotBytes) {
      throw new Error('encrypted snapshot exceeds the room snapshot limit');
    }
    const blobRef: BlobRef = {
      storage,
      blobId: candidate.envelopeId,
      byteLength: plaintext.length,
      contentHash: blobHash,
    };
    const body: ReviewEventBody = {
      type: 'snapshot_created',
      fileId,
      snapshotId,
      ...(ownerDisplayPath === undefined ? {} : { ownerDisplayPath }),
      baseHash,
      encryptedBlobRef: blobRef,
    };
    const event = assembleBrowserEvent({
      eventKey: options.keys.eventKey,
      signingSecret: options.identity.signingSecret,
      signingPublic: options.identity.signingPublic,
      roomId: options.roomId,
      authorId: options.identity.participantId,
      deviceId: options.identity.deviceId,
      createdAt,
      expiresAt: options.policy.expiresAt,
      snapshotId,
      body,
    });
    return { blobRef, envelopes: [wrapper, event.envelope] };
  } finally {
    if (wire !== plaintext) wire.fill(0);
    plaintext.fill(0);
    clientNonce.fill(0);
    sealedBody?.fill(0);
  }
}

function validateOptions(options: PublishBrowserSnapshotsOptions): void {
  if (options.roomSecret.length !== 32) throw new Error('roomSecret must be 32 bytes');
  if (options.keys.eventKey.length !== 32 || options.keys.snapshotKey.length !== 32) {
    throw new Error('room event/snapshot keys must be 32 bytes');
  }
  if (options.entries.length === 0) throw new Error('at least one snapshot entry is required');
  if (
    options.publication &&
    typeof options.publication.revisionSource?.getRevisionBody !== 'function'
  ) {
    throw new Error('published workspace requires a revision source');
  }
  for (const entry of options.entries) {
    if (!(entry.bytes instanceof Uint8Array)) throw new Error('snapshot bytes must be Uint8Array');
    if (entry.docType !== 'markdown' && entry.docType !== 'html' && entry.docType !== 'asset') {
      throw new Error('snapshot entry docType is invalid');
    }
    if (entry.docType === 'asset' && !isValidSnapshotMediaType(entry.mediaType)) {
      throw new Error('asset mediaType is invalid');
    }
    if (options.publication && entry.revisionId === undefined) {
      throw new Error(`published workspace entry requires revisionId: ${entry.path}`);
    }
  }
  for (const envelope of options.prefixEnvelopes ?? []) {
    if (
      envelope.roomId !== options.roomId
      || envelope.deviceId !== options.identity.deviceId
      || envelope.authorId !== options.identity.participantId
      || envelope.kind !== 'event'
    ) {
      throw new Error('snapshot publication prefix envelope is not owner-room bound');
    }
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

function secureRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function randomExact(
  random: (length: number) => Uint8Array,
  length: number,
  label: string,
): Uint8Array {
  const bytes = random(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`${label} generator returned the wrong length`);
  }
  return new Uint8Array(bytes);
}

function requireCanonicalId(value: string, length: number, label: string): void {
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(value);
  } catch {
    throw new Error(`${label} is not canonical base64url`);
  }
  try {
    if (decoded.length !== length || base64UrlEncode(decoded) !== value) {
      throw new Error(`${label} must be ${length} canonical base64url bytes`);
    }
  } finally {
    decoded.fill(0);
  }
}

function validatePublishedPointerForReuse(pointer: PublishedManifestPointer): void {
  requireCanonicalId(pointer.manifestSnapshotId, 16, 'published manifest snapshotId');
  if (!Array.isArray(pointer.entries) || pointer.entries.length === 0) {
    throw new Error('published manifest entries are invalid');
  }
  const fileIds = new Set<string>();
  const snapshotIds = new Set<string>();
  let previousPath: string | undefined;
  for (const entry of pointer.entries) {
    if (normalizeEntryPath(entry.path) !== entry.path) {
      throw new Error('published manifest path is not normalized');
    }
    if (previousPath !== undefined && compareManifestPathsUtf8(previousPath, entry.path) >= 0) {
      throw new Error('published manifest paths are not uniquely sorted');
    }
    previousPath = entry.path;
    requireCanonicalId(entry.fileId, 16, `published fileId for ${entry.path}`);
    requireCanonicalId(entry.snapshotId, 16, `published snapshotId for ${entry.path}`);
    requireCanonicalId(entry.contentHash, 32, `published contentHash for ${entry.path}`);
    if (entry.revisionId !== undefined) {
      requireCanonicalId(entry.revisionId, 16, `published revisionId for ${entry.path}`);
    }
    if (fileIds.has(entry.fileId) || snapshotIds.has(entry.snapshotId)) {
      throw new Error('published manifest contains duplicate identities');
    }
    fileIds.add(entry.fileId);
    snapshotIds.add(entry.snapshotId);
  }
}
