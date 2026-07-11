import type { AnchorIndex, BlobRef, DocType, ReviewEventBody } from '../types';
import {
  contentHash,
  deriveFileId,
  deriveSnapshotId,
  toCanonicalBytes,
  type RoomKeys,
} from './browser-crypto';
import {
  assembleBrowserEvent,
  assembleSnapshotBlobEnvelope,
} from './browser-envelope';
import type { BrowserDeviceIdentity } from './browser-session';
import {
  sealSnapshotR2Body,
  uploadBrowserR2Snapshot,
  type UploadBrowserR2SnapshotOptions,
} from './browser-snapshot-r2';
import { normalizeEntryPath } from './browser-workspace-schema';
import type { MailboxEnvelope, RoomPolicy } from './browser-ws';

export const SNAPSHOT_MAILBOX_THRESHOLD_BYTES = 1024 * 1024;

export interface BrowserSnapshotEntry {
  path: string;
  bytes: Uint8Array;
  docType: DocType;
  anchorIndex?: AnchorIndex;
  /** Reuse this identity for every republish of an existing workspace entry. */
  fileId?: string;
}

export interface SnapshotPublicationOutbox {
  enqueueDurably(envelope: MailboxEnvelope): Promise<boolean>;
  flushNow(): Promise<void>;
}

export interface SnapshotPublicationSink {
  setPublication(
    workspaceId: string,
    capId: string,
    publication: 'published',
  ): Promise<unknown>;
}

export interface BrowserSnapshotPublicationResult {
  path: string;
  fileId: string;
  snapshotId: string;
  baseHash: string;
  blobRef: BlobRef;
}

export interface PublishBrowserSnapshotsOptions {
  relayUrl: string;
  roomId: string;
  roomSecret: Uint8Array;
  keys: RoomKeys;
  identity: BrowserDeviceIdentity;
  policy: RoomPolicy;
  entries: readonly BrowserSnapshotEntry[];
  outbox: SnapshotPublicationOutbox;
  publication?: {
    sink: SnapshotPublicationSink;
    workspaceId: string;
    capId: string;
  };
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  uploadR2?: (options: UploadBrowserR2SnapshotOptions) => Promise<void>;
}

/**
 * Publish native-compatible Markdown/HTML snapshot blobs and signed pointers.
 * Binary assets and the workspace manifest deliberately fail closed until the
 * coordinated native/browser protocol in attn-7xl.4.3.1 lands.
 */
export async function publishBrowserSnapshots(
  options: PublishBrowserSnapshotsOptions,
): Promise<BrowserSnapshotPublicationResult[]> {
  validateOptions(options);
  const createdAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error('publication clock must return a positive safe integer');
  }
  const random = options.randomBytes ?? secureRandom;
  const results: BrowserSnapshotPublicationResult[] = [];
  const envelopes: MailboxEnvelope[] = [];

  for (const source of options.entries) {
    const path = normalizeEntryPath(source.path);
    const baseHash = contentHash(source.bytes);
    const fileId = source.fileId ?? deriveFileId(options.roomSecret, path, baseHash);
    const snapshotId = deriveSnapshotId(options.roomId, fileId, baseHash, createdAt);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
    const plaintext = toCanonicalBytes({
      docType: source.docType,
      content,
      ...(source.docType === 'markdown' && source.anchorIndex !== undefined
        ? { anchorIndex: source.anchorIndex }
        : {}),
    });
    const blobHash = contentHash(plaintext);
    const clientNonce = randomExact(random, 16, 'client nonce');
    let sealedBody: Uint8Array | null = null;
    let wrapper: MailboxEnvelope | null = null;
    try {
      const candidate = assembleSnapshotBlobEnvelope({
        plaintext,
        snapshotKey: options.keys.snapshotKey,
        roomId: options.roomId,
        authorId: options.identity.participantId,
        deviceId: options.identity.deviceId,
        clientNonce,
        createdAt,
        expiresAt: options.policy.expiresAt,
      });

      let storage: 'mailbox' | 'r2';
      if (candidate.ciphertextBytes <= SNAPSHOT_MAILBOX_THRESHOLD_BYTES) {
        wrapper = candidate;
        storage = 'mailbox';
      } else {
        const r2Ref: BlobRef = {
          storage: 'r2',
          blobId: candidate.envelopeId,
          byteLength: plaintext.length,
          contentHash: blobHash,
        };
        const refBytes = toCanonicalBytes(r2Ref);
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
        sealedBody = sealSnapshotR2Body({
          snapshotKey: options.keys.snapshotKey,
          plaintext,
          wrapper,
        });
        if (sealedBody.length > options.policy.maxSnapshotBytes) {
          throw new Error('encrypted snapshot exceeds the room snapshot limit');
        }
        await (options.uploadR2 ?? uploadBrowserR2Snapshot)({
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
        ownerDisplayPath: path,
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
      // Do not expose a half-built multi-file publication to the durable
      // outbox. All entries must assemble (and any R2 bodies must land)
      // before the first bytes/pointer pair becomes sendable.
      envelopes.push(wrapper, event.envelope);
      results.push({ path, fileId, snapshotId, baseHash, blobRef });
    } finally {
      plaintext.fill(0);
      clientNonce.fill(0);
      sealedBody?.fill(0);
    }
  }

  for (const envelope of envelopes) await options.outbox.enqueueDurably(envelope);
  await resumeBrowserSnapshotPublication(options.outbox, options.publication);
  return results;
}

/** Flush only already-durable ciphertext, then advance local publication. */
export async function resumeBrowserSnapshotPublication(
  outbox: SnapshotPublicationOutbox,
  publication?: PublishBrowserSnapshotsOptions['publication'],
): Promise<void> {
  await outbox.flushNow();
  if (publication) {
    await publication.sink.setPublication(
      publication.workspaceId,
      publication.capId,
      'published',
    );
  }
}

function validateOptions(options: PublishBrowserSnapshotsOptions): void {
  if (options.roomSecret.length !== 32) throw new Error('roomSecret must be 32 bytes');
  if (options.keys.eventKey.length !== 32 || options.keys.snapshotKey.length !== 32) {
    throw new Error('room event/snapshot keys must be 32 bytes');
  }
  if (options.entries.length === 0) throw new Error('at least one snapshot entry is required');
  for (const entry of options.entries) {
    if (!(entry.bytes instanceof Uint8Array)) throw new Error('snapshot bytes must be Uint8Array');
    if (entry.docType !== 'markdown' && entry.docType !== 'html') {
      throw new Error('only markdown/html snapshots are supported until workspace manifest v1');
    }
    if (entry.docType === 'html' && entry.anchorIndex !== undefined) {
      throw new Error('HTML snapshots cannot carry an anchor index');
    }
  }
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
