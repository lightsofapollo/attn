import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  INFO_ADMISSION,
  INFO_EVENT,
  INFO_SIGNALING,
  INFO_SNAPSHOT,
  base64UrlDecode,
  base64UrlEncode,
  toCanonicalBytes,
  toCanonicalString,
} from './browser-crypto';
import type { Device, MailboxEnvelope, RoomPolicy } from './browser-ws';
import {
  BrowserStorageError,
  MissingBrowserStorageError,
  StorageConflictError,
} from './browser-storage-errors';
import { isConstraintError, requestValue, transactionDone } from './browser-idb';
import {
  GC_CREATED_INDEX,
  MAX_SEALED_RECOVERY_BYTES,
  REVISION_HISTORY_INDEX,
  STORE_WORKSPACES,
  STORE_WORKSPACE_ENTRIES,
  STORE_WORKSPACE_GC,
  STORE_WORKSPACE_KEYS,
  STORE_WORKSPACE_LEASES,
  STORE_WORKSPACE_RECOVERY,
  STORE_WORKSPACE_REVISIONS,
  STORE_WORKSPACE_SHARE_CAPS,
  WORKSPACE_INDEX,
  WORKSPACE_RECORD_VERSION,
  WORKSPACE_UPDATED_INDEX,
  normalizeEntryPath,
  validateWorkspaceLeaseRecord,
  validateWorkspaceEntryRecord,
  validateWorkspaceRecoveryRecord,
  validateWorkspaceRecord,
  validateWorkspaceRevisionRecord,
  type WorkspaceEntryRecord,
  type WorkspaceLeaseRecord,
  type WorkspaceRecoveryRecord,
  type WorkspaceRecord,
  type WorkspaceRevisionRecord,
  type WorkspaceShareCapRecord,
} from './browser-workspace-schema';

import {
  generateWorkspaceRootKey,
  openRecovery,
  sealRecovery,
  validateWorkspaceRootKey,
} from './browser-workspace-crypto';
import {
  collabCheckpointRecoveryId,
  decodeBrowserCollabCheckpoint,
  encodeBrowserCollabCheckpoint,
  isCollabCheckpointRecoveryId,
  validateBrowserCollabCheckpoint,
  validateCollabCheckpointRoomId,
  type BrowserCollabCheckpoint,
} from './browser-collab-checkpoint';
import {
  WorkspaceStore,
  workspaceRevisionGcIntentId,
  type WorkspaceFence,
} from './browser-workspace-store';
import {
  browserReviewActionRecoveryId,
  decodeBrowserReviewActionReceipt,
  deriveBrowserReviewActionId,
  encodeBrowserReviewActionReceipt,
  type AtomicBrowserReviewActionCommit,
  type AtomicBrowserReviewActionStore,
  type BrowserReviewActionIdentity,
  type BrowserReviewActionReceipt,
} from './browser-review-actions';
import { WorkspaceShareStore } from './browser-workspace-share';
import {
  WorkspaceLeaseManager,
  type WorkspaceLeaseManagerOptions,
} from './browser-workspace-lease';

export { BrowserStorageError, MissingBrowserStorageError, StorageConflictError };

/** Stable origin-local database name. Change only with an explicit migration. */
export const BROWSER_STORAGE_DB_NAME = 'attn-browser-review';
/** v1 introduced room keys/metadata; v2 adds durable identity and envelope
 * stores; v3 adds browser-owned workspace stores (attn-7xl.2.1). */
export const BROWSER_STORAGE_SCHEMA_VERSION = 3;

const STORE_ROOM_KEYS = 'room_keys';
const STORE_ROOMS = 'rooms';
const STORE_DEVICES = 'devices';
const STORE_IDENTITIES = 'identities';
const STORE_INBOX = 'inbox';
const STORE_CURSORS = 'cursors';
const STORE_OUTBOX = 'outbox';
const STORE_HISTORY = 'history';
const ROOM_INDEX = 'by_room';
const INBOX_SEQUENCE_INDEX = 'by_room_sequence';
const OUTBOX_ORDER_INDEX = 'by_room_created';
const HISTORY_ORDER_INDEX = 'by_room_acked';
const LOCAL_IDENTITY_INFO = new TextEncoder().encode('attn local identity storage v1');
const LOCAL_IDENTITY_RECORD_VERSION = 1;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_REVIEW_ACTION_COMMIT_RETRIES = 8;

type StoreName =
  | typeof STORE_ROOM_KEYS
  | typeof STORE_ROOMS
  | typeof STORE_DEVICES
  | typeof STORE_IDENTITIES
  | typeof STORE_INBOX
  | typeof STORE_CURSORS
  | typeof STORE_OUTBOX
  | typeof STORE_HISTORY
  | typeof STORE_WORKSPACES
  | typeof STORE_WORKSPACE_KEYS
  | typeof STORE_WORKSPACE_ENTRIES
  | typeof STORE_WORKSPACE_REVISIONS
  | typeof STORE_WORKSPACE_SHARE_CAPS
  | typeof STORE_WORKSPACE_RECOVERY
  | typeof STORE_WORKSPACE_GC
  | typeof STORE_WORKSPACE_LEASES;

export interface BrowserStorageRoom {
  roomId: string;
  policy: RoomPolicy;
  /** Highest local event timestamp, used to preserve monotonic createdAt. */
  lastCreatedAt: number;
  /** Result of the last navigator.storage.persist() request. */
  storagePersisted: boolean;
  relayUrl?: string;
  participantId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface BrowserStorageRoomKeys {
  eventKey: Uint8Array;
  snapshotKey: Uint8Array;
  signalingKey: Uint8Array;
  admissionKey: Uint8Array;
}

/** The in-memory identity shape accepted by BrowserSession. */
export interface BrowserStorageDeviceIdentity {
  deviceId: string;
  participantId: string;
  signingSecret: Uint8Array;
  signingPublic: Uint8Array;
  encryptionSecret: Uint8Array;
  publicEncryptionKey: Uint8Array;
}

/** A decrypted identity returned only after its public keys are re-derived. */
export type BrowserStorageIdentity = BrowserStorageDeviceIdentity;

export interface StoredInboundEnvelope {
  envelope: MailboxEnvelope;
  serverSeq: number;
}

export interface OutboxAcceptedEnvelope {
  envelopeId: string;
  serverSeq: number;
}

export interface StoredSentEnvelope extends StoredInboundEnvelope {
  ackedAt: number;
}

export interface WorkspaceRecoverySummary {
  workspaceId: string;
  recoveryId: string;
  createdAt: number;
}

/** Narrow contract consumed by a durable BrowserWs integration. */
export interface BrowserInboxPersistence {
  commitInbound(
    roomId: string,
    deviceId: string,
    envelope: MailboxEnvelope,
    serverSeq: number,
  ): Promise<boolean>;
  getCursor(roomId: string, deviceId: string): Promise<number>;
  replayInbound(roomId: string): Promise<StoredInboundEnvelope[]>;
}

/** Narrow contract consumed by BrowserOutbox; all values remain sealed. */
export interface BrowserOutboxPersistence {
  putOutbox(roomId: string, envelope: MailboxEnvelope): Promise<boolean>;
  putOutboxBatch(roomId: string, envelopes: readonly MailboxEnvelope[]): Promise<number>;
  listOutbox(roomId: string, deviceId: string): Promise<MailboxEnvelope[]>;
  acknowledge(
    roomId: string,
    batch: readonly MailboxEnvelope[],
    accepted: readonly OutboxAcceptedEnvelope[],
  ): Promise<number>;
}

/** Files receive only already-sealed bytes and opaque hash-derived paths. */
export interface SealedBlobFileSystem {
  write(path: string, sealedBytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  delete(path: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface BrowserStorageEstimate {
  usage?: number;
  quota?: number;
  usageDetails?: Record<string, number>;
}

export interface BrowserStorageNavigator {
  storage?: {
    persist?: () => Promise<boolean>;
    persisted?: () => Promise<boolean>;
    estimate?: () => Promise<BrowserStorageEstimate>;
    getDirectory?: () => Promise<OpfsDirectoryHandle>;
  };
}

export interface BrowserStorageOpenOptions {
  /** False probes/opens an existing database and never creates an absent one. */
  createIfMissing: boolean;
  databaseName?: string;
  indexedDB?: IDBFactory;
  crypto?: Crypto;
  filesystem?: SealedBlobFileSystem | null;
  navigator?: BrowserStorageNavigator | null;
  now?: () => number;
}

interface RoomKeyRecord {
  roomId: string;
  rootKey: CryptoKey;
}

interface RoomRecord extends BrowserStorageRoom {
  /** Opaque owner for an in-progress/completed explicit remember operation. */
  rememberClaimId?: string;
}

interface IdentityRecord {
  roomId: string;
  deviceId: string;
  participantId: string;
  publicSigningKey: string;
  publicEncryptionKey: string;
  nonce: string;
  ciphertext: string;
  v: number;
}

interface InboxRecord {
  roomId: string;
  envelopeId: string;
  serverSeq: number;
  envelope: MailboxEnvelope;
}

interface CursorRecord {
  roomId: string;
  deviceId: string;
  serverSeq: number;
}

interface OutboxRecord {
  roomId: string;
  envelopeId: string;
  createdAt: number;
  envelope: MailboxEnvelope;
}

interface HistoryRecord extends OutboxRecord {
  serverSeq: number;
  ackedAt: number;
}

interface PublicationShareRecord extends WorkspaceShareCapRecord {
  publication?: 'pending' | 'published' | 'stopped';
  generation?: number;
  publicationCommit?: {
    envelopeIds: string[];
    nonce: string;
    ciphertext: string;
    /** Present on fenced legacy rollover journals; absent means v3 legacy. */
    holderId?: string;
    fencingToken?: number;
  };
}

interface CollabRecoveryRecord extends WorkspaceRecoveryRecord {
  collabEpoch: string;
  collabVersion: number;
}

interface ReviewActionRecoveryRecord extends WorkspaceRecoveryRecord {
  reviewActionId: string;
  reviewActionDisposition: BrowserReviewActionReceipt['disposition'];
}

interface PrivateIdentityPayload {
  v: number;
  signingSecret: string;
  encryptionSecret: string;
}

interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface OpfsFileHandle {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}

/**
 * Durable browser persistence. IndexedDB contains only sealed content, public
 * registration data, and a structured-cloned non-extractable HKDF root key.
 */
export class BrowserStorage implements
  BrowserInboxPersistence,
  BrowserOutboxPersistence,
  AtomicBrowserReviewActionStore
{
  private readonly db: IDBDatabase;
  private readonly databaseName: string;
  private readonly indexedDbFactory: IDBFactory;
  private readonly cryptoImpl: Crypto;
  private readonly filesystem: SealedBlobFileSystem | null;
  private readonly navigatorImpl: BrowserStorageNavigator | null;
  private readonly now: () => number;
  private workspaceStore: WorkspaceStore | null = null;
  private shareStore: WorkspaceShareStore | null = null;

  private constructor(
    db: IDBDatabase,
    options: Required<Pick<BrowserStorageOpenOptions, 'databaseName' | 'crypto' | 'now'>> &
      Pick<BrowserStorageOpenOptions, 'filesystem' | 'navigator'> & { indexedDB: IDBFactory },
  ) {
    this.db = db;
    this.databaseName = options.databaseName;
    this.indexedDbFactory = options.indexedDB;
    this.cryptoImpl = options.crypto;
    this.navigatorImpl = options.navigator ?? null;
    this.filesystem =
      options.filesystem === undefined
        ? makeOpfsFilesystem(this.navigatorImpl)
        : options.filesystem;
    this.now = options.now;
  }

  static async open(options: BrowserStorageOpenOptions): Promise<BrowserStorage> {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new BrowserStorageError('IndexedDB is unavailable');
    const cryptoImpl = options.crypto ?? globalThis.crypto;
    if (!cryptoImpl?.subtle) throw new BrowserStorageError('WebCrypto is unavailable');
    const databaseName = options.databaseName ?? BROWSER_STORAGE_DB_NAME;
    const db = await openDatabase(factory, databaseName, options.createIfMissing);
    return new BrowserStorage(db, {
      databaseName,
      indexedDB: factory,
      crypto: cryptoImpl,
      filesystem: options.filesystem,
      navigator: options.navigator ?? defaultNavigator(),
      now: options.now ?? Date.now,
    });
  }

  /**
   * Open an independently-owned connection to the same durable profile.
   * BrowserSession closes its connection on transport teardown, so hosted
   * owner authority must use this sibling rather than the app's shared handle.
   */
  async openSibling(createIfMissing = true): Promise<BrowserStorage> {
    return BrowserStorage.open({
      createIfMissing,
      databaseName: this.databaseName,
      indexedDB: this.indexedDbFactory,
      crypto: this.cryptoImpl,
      filesystem: this.filesystem,
      navigator: this.navigatorImpl,
      now: this.now,
    });
  }

  close(): void {
    this.db.close();
  }

  /** Cross-tab writer leases over this database (attn-7xl.2.6). */
  leases(options: WorkspaceLeaseManagerOptions = {}): WorkspaceLeaseManager {
    return new WorkspaceLeaseManager(this.db, { now: this.now, ...options });
  }

  /** Workspace share ownership + wrapped invite capabilities (attn-7xl.4.2). */
  get shares(): WorkspaceShareStore {
    if (!this.shareStore) {
      this.shareStore = new WorkspaceShareStore(this.db, this.cryptoImpl, this.now);
    }
    return this.shareStore;
  }

  /** Atomic workspace/file transaction APIs (attn-7xl.2.3/.2.4). */
  get workspaces(): WorkspaceStore {
    if (!this.workspaceStore) {
      this.workspaceStore = new WorkspaceStore(this.db, this.cryptoImpl, this.now, {
        filesystem: this.filesystem,
      });
    }
    return this.workspaceStore;
  }

  async putRoom(room: BrowserStorageRoom): Promise<void> {
    validateRoom(room);
    const tx = this.db.transaction(STORE_ROOMS, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_ROOMS);
    const existing = await requestValue<RoomRecord | undefined>(store.get(room.roomId));
    store.put({
      ...structuredClone(room),
      ...(existing?.rememberClaimId ? { rememberClaimId: existing.rememberClaimId } : {}),
    } satisfies RoomRecord);
    await done;
  }

  /**
   * Atomically reserve a room for one explicit remember attempt. IndexedDB
   * serializes readwrite transactions across tabs, so exactly one claimant
   * can mutate an absent room and later own any rollback.
   */
  async claimRoom(room: BrowserStorageRoom, rememberClaimId: string): Promise<boolean> {
    validateRoom(room);
    requireId(rememberClaimId, 'rememberClaimId');
    const tx = this.db.transaction(STORE_ROOMS, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_ROOMS);
    const existing = await requestValue<RoomRecord | undefined>(store.get(room.roomId));
    if (existing) {
      await done;
      return false;
    }
    store.add({ ...structuredClone(room), rememberClaimId } satisfies RoomRecord);
    await done;
    return true;
  }

  /** Publish a fully installed remembered room to fragmentless resume. */
  async completeRoomClaim(roomId: string, rememberClaimId: string): Promise<void> {
    requireId(roomId, 'roomId');
    requireId(rememberClaimId, 'rememberClaimId');
    const tx = this.db.transaction(STORE_ROOMS, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_ROOMS);
    const record = await requestValue<RoomRecord | undefined>(store.get(roomId));
    if (!record || record.rememberClaimId !== rememberClaimId) {
      tx.abort();
      await done.catch(() => undefined);
      throw new StorageConflictError('remember claim is no longer owned by this attempt');
    }
    const { rememberClaimId: _claim, ...completed } = record;
    store.put(completed);
    await done;
  }

  /** Ids of fully-remembered rooms (unfinished claims stay hidden). */
  async listRoomIds(): Promise<string[]> {
    const tx = this.db.transaction(STORE_ROOMS, 'readonly');
    const done = transactionDone(tx);
    const records = await requestValue<RoomRecord[]>(tx.objectStore(STORE_ROOMS).getAll());
    await done;
    return records
      .filter((record) => !record.rememberClaimId)
      .map((record) => record.roomId)
      .sort();
  }

  async getRoom(roomId: string): Promise<BrowserStorageRoom | null> {
    requireId(roomId, 'roomId');
    const record = await this.get<RoomRecord>(STORE_ROOMS, roomId);
    if (!record) return null;
    validateRoom(record);
    if (record.rememberClaimId) return null;
    const { rememberClaimId: _rememberClaimId, ...room } = record;
    return structuredClone(room);
  }

  /**
   * Derive and persist an opaque HKDF root key. roomSecret and derived bytes
   * are zeroed before return and are never written to IndexedDB.
   */
  async installRoomKey(roomId: string, rootKeyBytes: Uint8Array): Promise<CryptoKey> {
    requireId(roomId, 'roomId');
    if (!(rootKeyBytes instanceof Uint8Array) || rootKeyBytes.length !== 32) {
      throw new BrowserStorageError('rootKeyBytes must be 32 bytes');
    }
    const rootKey = await importOpaqueRootKey(this.cryptoImpl, rootKeyBytes);
    const existing = await this.getRoomRootKey(roomId);
    if (existing) {
      const [oldEvent, newEvent] = await Promise.all([
        deriveSubkey(this.cryptoImpl, existing, INFO_EVENT),
        deriveSubkey(this.cryptoImpl, rootKey, INFO_EVENT),
      ]);
      const same = equalBytes(oldEvent, newEvent);
      oldEvent.fill(0);
      newEvent.fill(0);
      if (!same) throw new StorageConflictError('room already has a different root key');
      return existing;
    }
    const tx = this.db.transaction(STORE_ROOM_KEYS, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_ROOM_KEYS).add({ roomId, rootKey } satisfies RoomKeyRecord);
    await done;
    return rootKey;
  }

  async getRoomRootKey(roomId: string): Promise<CryptoKey | null> {
    requireId(roomId, 'roomId');
    const record = await this.get<RoomKeyRecord>(STORE_ROOM_KEYS, roomId);
    if (!record) return null;
    validateRootKey(record.rootKey);
    return record.rootKey;
  }

  /** Derived subkeys are returned to the live session but are never stored. */
  async deriveRoomKeys(roomId: string): Promise<BrowserStorageRoomKeys> {
    const rootKey = await this.requireRoomRootKey(roomId);
    const [eventKey, snapshotKey, signalingKey, admissionKey] = await Promise.all([
      deriveSubkey(this.cryptoImpl, rootKey, INFO_EVENT),
      deriveSubkey(this.cryptoImpl, rootKey, INFO_SNAPSHOT),
      deriveSubkey(this.cryptoImpl, rootKey, INFO_SIGNALING),
      deriveSubkey(this.cryptoImpl, rootKey, INFO_ADMISSION),
    ]);
    return { eventKey, snapshotKey, signalingKey, admissionKey };
  }

  async putDevice(roomId: string, device: Device): Promise<void> {
    requireId(roomId, 'roomId');
    validateDevice(device);
    const record = { roomId, ...structuredClone(device) };
    const tx = this.db.transaction(STORE_DEVICES, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_DEVICES);
    const existing = await requestValue<Record<string, unknown> | undefined>(
      store.get([roomId, device.deviceId]),
    );
    if (existing && !sameDeviceRegistration(stripRoomId(existing), device)) {
      tx.abort();
      await done.catch(() => undefined);
      throw new StorageConflictError('immutable device registration changed');
    }
    if (!existing) store.add(record);
    await done;
  }

  async listDevices(roomId: string): Promise<Device[]> {
    requireId(roomId, 'roomId');
    const records = await this.getAllByRoom<(Device & { roomId: string })>(STORE_DEVICES, roomId);
    return records.map((record) => {
      const device = stripRoomId(record as unknown as Record<string, unknown>) as unknown as Device;
      validateDevice(device);
      return structuredClone(device);
    });
  }

  async saveIdentity(roomId: string, identity: BrowserStorageDeviceIdentity): Promise<void> {
    validateIdentity(identity);
    const rootKey = await this.requireRoomRootKey(roomId);
    const localKey = await deriveSubkey(this.cryptoImpl, rootKey, LOCAL_IDENTITY_INFO);
    const publicSigningKey = base64UrlEncode(identity.signingPublic);
    const publicEncryptionKey = base64UrlEncode(identity.publicEncryptionKey);
    const recordBase = {
      v: LOCAL_IDENTITY_RECORD_VERSION,
      roomId,
      deviceId: identity.deviceId,
      participantId: identity.participantId,
      publicSigningKey,
      publicEncryptionKey,
    };
    const aad = identityAad(this.databaseName, recordBase);
    const plaintext = toCanonicalBytes({
      v: LOCAL_IDENTITY_RECORD_VERSION,
      signingSecret: base64UrlEncode(identity.signingSecret),
      encryptionSecret: base64UrlEncode(identity.encryptionSecret),
    } satisfies PrivateIdentityPayload);
    const nonce = randomBytes(this.cryptoImpl, 24);
    let ciphertext: Uint8Array | null = null;
    try {
      ciphertext = xchacha20poly1305(localKey, nonce, aad).encrypt(plaintext);
      const record: IdentityRecord = {
        ...recordBase,
        nonce: base64UrlEncode(nonce),
        ciphertext: base64UrlEncode(ciphertext),
      };
      const tx = this.db.transaction(STORE_IDENTITIES, 'readwrite');
      const done = transactionDone(tx);
      const store = tx.objectStore(STORE_IDENTITIES);
      const existing = await requestValue<IdentityRecord | undefined>(
        store.get(roomId),
      );
      if (existing && !sameIdentityRegistration(existing, record)) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('room already contains a different local identity');
      }
      if (!existing) store.add(record);
      await done;
    } finally {
      localKey.fill(0);
      plaintext.fill(0);
      nonce.fill(0);
      ciphertext?.fill(0);
    }
  }

  async loadIdentity(roomId: string): Promise<BrowserStorageIdentity | null> {
    requireId(roomId, 'roomId');
    const record = await this.get<IdentityRecord>(STORE_IDENTITIES, roomId);
    if (!record) return null;
    validateIdentityRecord(record, roomId, record.deviceId);
    const rootKey = await this.requireRoomRootKey(roomId);
    const localKey = await deriveSubkey(this.cryptoImpl, rootKey, LOCAL_IDENTITY_INFO);
    const nonce = decodeLength(record.nonce, 24, 'identity nonce');
    const ciphertext = decodeAtLeast(record.ciphertext, 17, 'identity ciphertext');
    const aad = identityAad(this.databaseName, record);
    let plaintext: Uint8Array | null = null;
    try {
      plaintext = xchacha20poly1305(localKey, nonce, aad).decrypt(ciphertext);
      const payload = parsePrivateIdentity(plaintext);
      const signingSecret = decodeLength(payload.signingSecret, 32, 'Ed25519 private key');
      const encryptionSecret = decodeLength(payload.encryptionSecret, 32, 'X25519 private key');
      const signingPublic = decodeLength(record.publicSigningKey, 32, 'Ed25519 public key');
      const publicEncryptionKey = decodeLength(
        record.publicEncryptionKey,
        32,
        'X25519 public key',
      );
      if (!equalBytes(ed25519.getPublicKey(signingSecret), signingPublic)) {
        throw new BrowserStorageError('stored Ed25519 private/public keys do not match');
      }
      if (!equalBytes(x25519.getPublicKey(encryptionSecret), publicEncryptionKey)) {
        throw new BrowserStorageError('stored X25519 private/public keys do not match');
      }
      return {
        deviceId: record.deviceId,
        participantId: record.participantId,
        signingSecret,
        signingPublic,
        encryptionSecret,
        publicEncryptionKey,
      };
    } catch (error) {
      if (error instanceof BrowserStorageError) throw error;
      throw new BrowserStorageError('stored identity could not be authenticated');
    } finally {
      localKey.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
      plaintext?.fill(0);
    }
  }

  async commitInbound(
    roomId: string,
    deviceId: string,
    envelope: MailboxEnvelope,
    serverSeq: number,
  ): Promise<boolean> {
    requireId(deviceId, 'deviceId');
    validateEnvelope(roomId, envelope);
    validateServerSeq(serverSeq);
    if (envelope.serverSeq !== undefined && envelope.serverSeq !== serverSeq) {
      throw new BrowserStorageError('envelope serverSeq does not match committed sequence');
    }
    const record: InboxRecord = {
      roomId,
      envelopeId: envelope.envelopeId,
      serverSeq,
      envelope: structuredClone(envelope),
    };
    const tx = this.db.transaction([STORE_INBOX, STORE_CURSORS], 'readwrite');
    const done = transactionDone(tx);
    const inbox = tx.objectStore(STORE_INBOX);
    const existing = await requestValue<InboxRecord | undefined>(
      inbox.get([roomId, envelope.envelopeId]),
    );
    if (existing) {
      if (!sameInbound(existing, record)) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('inbound envelope id conflicts with stored sealed bytes');
      }
    } else {
      const sequenceOwner = await requestValue<IDBValidKey | undefined>(
        inbox.index(INBOX_SEQUENCE_INDEX).getKey([roomId, serverSeq]),
      );
      if (sequenceOwner !== undefined) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('server sequence is already bound to another envelope');
      }
      inbox.add(record);
    }
    const cursors = tx.objectStore(STORE_CURSORS);
    const cursor = await requestValue<CursorRecord | undefined>(cursors.get([roomId, deviceId]));
    if (!cursor || serverSeq > cursor.serverSeq) {
      cursors.put({ roomId, deviceId, serverSeq } satisfies CursorRecord);
    }
    try {
      await done;
    } catch (error) {
      if (isConstraintError(error)) {
        throw new StorageConflictError('server sequence is already bound to another envelope');
      }
      throw error;
    }
    return existing === undefined;
  }

  async getCursor(roomId: string, deviceId: string): Promise<number> {
    requireId(roomId, 'roomId');
    requireId(deviceId, 'deviceId');
    const cursor = await this.get<CursorRecord>(STORE_CURSORS, [roomId, deviceId]);
    if (!cursor) return 0;
    validateServerSeq(cursor.serverSeq, true);
    return cursor.serverSeq;
  }

  async replayInbound(roomId: string): Promise<StoredInboundEnvelope[]> {
    requireId(roomId, 'roomId');
    const tx = this.db.transaction(STORE_INBOX, 'readonly');
    const done = transactionDone(tx);
    const index = tx.objectStore(STORE_INBOX).index(INBOX_SEQUENCE_INDEX);
    const records = await requestValue<InboxRecord[]>(
      index.getAll(IDBKeyRange.bound([roomId, 0], [roomId, MAX_SEQUENCE])),
    );
    await done;
    return records.map((record) => {
      validateServerSeq(record.serverSeq);
      validateEnvelope(roomId, record.envelope);
      return { envelope: structuredClone(record.envelope), serverSeq: record.serverSeq };
    });
  }

  async putOutbox(roomId: string, envelope: MailboxEnvelope): Promise<boolean> {
    return (await this.putOutboxBatch(roomId, [envelope])) === 1;
  }

  /** Atomically persist a sealed batch, or persist none of it on conflict/failure. */
  async putOutboxBatch(roomId: string, envelopes: readonly MailboxEnvelope[]): Promise<number> {
    requireId(roomId, 'roomId');
    const records = envelopes.map((envelope) => {
      validateEnvelope(roomId, envelope);
      return {
        roomId,
        envelopeId: envelope.envelopeId,
        createdAt: envelope.createdAt,
        envelope: structuredClone(envelope),
      } satisfies OutboxRecord;
    });
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.envelopeId)) {
        throw new BrowserStorageError('outbox batch contains a duplicate envelope id');
      }
      ids.add(record.envelopeId);
    }
    const tx = this.db.transaction([STORE_OUTBOX, STORE_HISTORY], 'readwrite');
    const done = transactionDone(tx);
    const outbox = tx.objectStore(STORE_OUTBOX);
    const history = tx.objectStore(STORE_HISTORY);
    let inserted = 0;
    for (const record of records) {
      const existing = await requestValue<OutboxRecord | undefined>(
        outbox.get([roomId, record.envelopeId]),
      );
      const historical = await requestValue<HistoryRecord | undefined>(
        history.get([roomId, record.envelopeId]),
      );
      const prior = existing ?? historical;
      if (prior && !sameEnvelope(prior.envelope, record.envelope)) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('outbox envelope id conflicts with stored sealed bytes');
      }
      if (!prior) {
        outbox.add(record);
        inserted += 1;
      }
    }
    await done;
    return inserted;
  }

  async listOutbox(roomId: string, deviceId: string): Promise<MailboxEnvelope[]> {
    requireId(roomId, 'roomId');
    requireId(deviceId, 'deviceId');
    const tx = this.db.transaction(STORE_OUTBOX, 'readonly');
    const done = transactionDone(tx);
    const index = tx.objectStore(STORE_OUTBOX).index(OUTBOX_ORDER_INDEX);
    const records = await requestValue<OutboxRecord[]>(index.getAll(roomRange(roomId)));
    await done;
    records.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.envelopeId.localeCompare(b.envelopeId)
        : a.createdAt - b.createdAt,
    );
    return records.filter((record) => record.envelope.deviceId === deviceId).map((record) => {
      validateEnvelope(roomId, record.envelope);
      return structuredClone(record.envelope);
    });
  }

  async acknowledge(
    roomId: string,
    batch: readonly MailboxEnvelope[],
    accepted: readonly OutboxAcceptedEnvelope[],
  ): Promise<number> {
    requireId(roomId, 'roomId');
    const batchById = new Map<string, MailboxEnvelope>();
    for (const envelope of batch) {
      validateEnvelope(roomId, envelope);
      if (batchById.has(envelope.envelopeId)) {
        throw new BrowserStorageError('outbox acknowledgement batch contains a duplicate id');
      }
      batchById.set(envelope.envelopeId, envelope);
    }
    const acceptedById = new Map<string, OutboxAcceptedEnvelope>();
    for (const item of accepted) {
      requireId(item.envelopeId, 'accepted envelopeId');
      validateServerSeq(item.serverSeq);
      if (!batchById.has(item.envelopeId)) {
        throw new BrowserStorageError('acknowledgement contains an envelope outside the sent batch');
      }
      if (acceptedById.has(item.envelopeId)) {
        throw new BrowserStorageError('acknowledgement contains a duplicate envelope id');
      }
      acceptedById.set(item.envelopeId, item);
    }
    const ackedAt = this.now();
    requireTimestamp(ackedAt, 'ackedAt');
    const tx = this.db.transaction(
      [STORE_OUTBOX, STORE_HISTORY, STORE_WORKSPACE_SHARE_CAPS, STORE_WORKSPACE_LEASES],
      'readwrite',
    );
    const done = transactionDone(tx);
    const outbox = tx.objectStore(STORE_OUTBOX);
    const history = tx.objectStore(STORE_HISTORY);
    let moved = 0;
    for (const item of acceptedById.values()) {
      const envelope = batchById.get(item.envelopeId)!;
      const pending = await requestValue<OutboxRecord | undefined>(
        outbox.get([roomId, item.envelopeId]),
      );
      const prior = await requestValue<HistoryRecord | undefined>(
        history.get([roomId, item.envelopeId]),
      );
      if (!pending) {
        if (prior && (prior.serverSeq !== item.serverSeq || !sameEnvelope(prior.envelope, envelope))) {
          tx.abort();
          await done.catch(() => undefined);
          throw new StorageConflictError('acknowledgement conflicts with sent history');
        }
        continue;
      }
      if (!sameEnvelope(pending.envelope, envelope)) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('acknowledged batch differs from durable outbox');
      }
      if (prior && (!sameEnvelope(prior.envelope, pending.envelope) || prior.serverSeq !== item.serverSeq)) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('sent history conflicts with pending envelope');
      }
      if (!prior) {
        history.add({ ...pending, serverSeq: item.serverSeq, ackedAt } satisfies HistoryRecord);
      }
      outbox.delete([roomId, item.envelopeId]);
      moved += 1;
    }
    // Browser-owned publications pre-seal their final capability. The ACK
    // transaction promotes it when (and only when) every journaled envelope
    // is in sent history, eliminating an ACK->published crash window.
    const shares = tx.objectStore(STORE_WORKSPACE_SHARE_CAPS);
    const shareRecords = await requestValue<PublicationShareRecord[]>(shares.getAll());
    for (const share of shareRecords) {
      const promotion = share.publicationCommit;
      if (share.roomId !== roomId || share.publication !== 'pending' || !promotion) continue;
      if (!Array.isArray(promotion.envelopeIds) || promotion.envelopeIds.length === 0) {
        throw new BrowserStorageError('publication promotion journal is invalid');
      }
      const promotionIds = new Set<string>();
      for (const envelopeId of promotion.envelopeIds) {
        decodeLength(envelopeId, 16, 'publication envelope id').fill(0);
        if (promotionIds.has(envelopeId)) {
          throw new BrowserStorageError('publication promotion journal has duplicate envelopes');
        }
        promotionIds.add(envelopeId);
      }
      decodeLength(promotion.nonce, 24, 'publication promotion nonce').fill(0);
      decodeAtLeast(promotion.ciphertext, 16, 'publication promotion ciphertext').fill(0);
      const hasFenceMetadata =
        promotion.holderId !== undefined || promotion.fencingToken !== undefined;
      if (hasFenceMetadata) {
        if (
          typeof promotion.holderId !== 'string' ||
          promotion.holderId.length === 0 ||
          !Number.isSafeInteger(promotion.fencingToken) ||
          promotion.fencingToken! < 1
        ) {
          tx.abort();
          await done.catch(() => undefined);
          throw new BrowserStorageError('publication promotion fence metadata is invalid');
        }
        const lease = await requestValue<WorkspaceLeaseRecord | undefined>(
          tx.objectStore(STORE_WORKSPACE_LEASES).get(share.workspaceId),
        );
        try {
          validateActiveFence(
            lease,
            { holderId: promotion.holderId, fencingToken: promotion.fencingToken! },
            ackedAt,
          );
        } catch {
          // ACK durability is independent of authority. Leave the share
          // pending for the current fenced owner to promote explicitly.
          continue;
        }
      }
      let fullyAcknowledged = true;
      for (const envelopeId of promotion.envelopeIds) {
        const [stillQueued, sent] = await Promise.all([
          requestValue<OutboxRecord | undefined>(outbox.get([roomId, envelopeId])),
          requestValue<HistoryRecord | undefined>(history.get([roomId, envelopeId])),
        ]);
        if (stillQueued || !sent) {
          fullyAcknowledged = false;
          break;
        }
      }
      if (!fullyAcknowledged) continue;
      const next: PublicationShareRecord = {
        ...share,
        nonce: promotion.nonce,
        ciphertext: promotion.ciphertext,
        publication: 'published',
        generation: (Number.isSafeInteger(share.generation) ? share.generation! : 0) + 1,
        publicationCommit: undefined,
      };
      shares.put(next);
    }
    await done;
    // Deliberately does not touch STORE_CURSORS: sent serverSeq is not a
    // receive cursor and must never skip an inbound mailbox envelope.
    return moved;
  }

  async listHistory(roomId: string): Promise<StoredSentEnvelope[]> {
    requireId(roomId, 'roomId');
    const tx = this.db.transaction(STORE_HISTORY, 'readonly');
    const done = transactionDone(tx);
    const records = await requestValue<HistoryRecord[]>(
      tx.objectStore(STORE_HISTORY).index(HISTORY_ORDER_INDEX).getAll(roomRange(roomId)),
    );
    await done;
    records.sort((a, b) =>
      a.ackedAt === b.ackedAt
        ? a.envelopeId.localeCompare(b.envelopeId)
        : a.ackedAt - b.ackedAt,
    );
    return records.map((record) => {
      validateEnvelope(roomId, record.envelope);
      validateServerSeq(record.serverSeq);
      return {
        envelope: structuredClone(record.envelope),
        serverSeq: record.serverSeq,
        ackedAt: record.ackedAt,
      };
    });
  }

  async putSealedBlob(roomId: string, blobId: string, sealedBytes: Uint8Array): Promise<boolean> {
    requireId(roomId, 'roomId');
    requireId(blobId, 'blobId');
    if (!(sealedBytes instanceof Uint8Array) || sealedBytes.length < 16) {
      throw new BrowserStorageError('sealed blob must include an authentication tag');
    }
    if (!this.filesystem) return false;
    await this.filesystem.write(sealedBlobPath(roomId, blobId), new Uint8Array(sealedBytes));
    return true;
  }

  async getSealedBlob(roomId: string, blobId: string): Promise<Uint8Array | null> {
    requireId(roomId, 'roomId');
    requireId(blobId, 'blobId');
    if (!this.filesystem) return null;
    const bytes = await this.filesystem.read(sealedBlobPath(roomId, blobId));
    return bytes ? new Uint8Array(bytes) : null;
  }

  async deleteSealedBlob(roomId: string, blobId: string): Promise<boolean> {
    requireId(roomId, 'roomId');
    requireId(blobId, 'blobId');
    if (!this.filesystem) return false;
    return this.filesystem.delete(sealedBlobPath(roomId, blobId));
  }

  async requestPersistence(): Promise<boolean | null> {
    const persist = this.navigatorImpl?.storage?.persist;
    return persist ? persist.call(this.navigatorImpl!.storage) : null;
  }

  async estimateStorage(): Promise<BrowserStorageEstimate | null> {
    const estimate = this.navigatorImpl?.storage?.estimate;
    return estimate ? estimate.call(this.navigatorImpl!.storage) : null;
  }

  /**
   * Crypto-erasure is committed first. Cleanup happens only after the opaque
   * root key is gone, so interrupted cleanup cannot recover private content.
   */
  /**
   * Purge only the cached inbound log + replay cursors for a room, keeping
   * identity, keys, devices, and the outbox. Used when the relay room
   * INSTANCE rotated under a stable roomId (stop/re-share reuses ids; relay
   * eviction rebuilds rooms): the stale local (roomId, serverSeq) bindings
   * then belong to the dead instance and every fresh envelope fails its
   * durable commit before dispatch — the client goes permanently deaf in a
   * reconnect loop. Local history is a cache of the relay log; dropping it
   * and replaying from seq 0 is always safe.
   */
  async resetRoomInboundHistory(roomId: string): Promise<void> {
    requireId(roomId, 'roomId');
    for (const storeName of [STORE_INBOX, STORE_CURSORS] as const) {
      await deleteRoomRecords(this.db, storeName, roomId);
    }
  }

  async forgetRoom(roomId: string): Promise<void> {
    requireId(roomId, 'roomId');
    const keyTx = this.db.transaction(STORE_ROOM_KEYS, 'readwrite');
    const keyDone = transactionDone(keyTx);
    keyTx.objectStore(STORE_ROOM_KEYS).delete(roomId);
    await keyDone;

    const roomTx = this.db.transaction(STORE_ROOMS, 'readwrite');
    const roomDone = transactionDone(roomTx);
    roomTx.objectStore(STORE_ROOMS).delete(roomId);
    await roomDone;
    for (const storeName of [
      STORE_DEVICES,
      STORE_IDENTITIES,
      STORE_INBOX,
      STORE_OUTBOX,
      STORE_HISTORY,
      STORE_CURSORS,
    ] as const) {
      await deleteRoomRecords(this.db, storeName, roomId);
    }
    await this.filesystem?.deletePrefix(sealedBlobRoomPrefix(roomId));
  }

  /** Roll back only the records owned by one unfinished remember claim. */
  async forgetClaimedRoom(roomId: string, rememberClaimId: string): Promise<boolean> {
    requireId(roomId, 'roomId');
    requireId(rememberClaimId, 'rememberClaimId');
    const keyTx = this.db.transaction([STORE_ROOMS, STORE_ROOM_KEYS], 'readwrite');
    const keyDone = transactionDone(keyTx);
    const room = await requestValue<RoomRecord | undefined>(
      keyTx.objectStore(STORE_ROOMS).get(roomId),
    );
    if (!room || room.rememberClaimId !== rememberClaimId) {
      await keyDone;
      return false;
    }
    keyTx.objectStore(STORE_ROOM_KEYS).delete(roomId);
    await keyDone;

    const roomTx = this.db.transaction(STORE_ROOMS, 'readwrite');
    const roomDone = transactionDone(roomTx);
    const current = await requestValue<RoomRecord | undefined>(
      roomTx.objectStore(STORE_ROOMS).get(roomId),
    );
    if (!current || current.rememberClaimId !== rememberClaimId) {
      await roomDone;
      return false;
    }
    roomTx.objectStore(STORE_ROOMS).delete(roomId);
    await roomDone;
    for (const storeName of [
      STORE_DEVICES,
      STORE_IDENTITIES,
      STORE_INBOX,
      STORE_OUTBOX,
      STORE_HISTORY,
      STORE_CURSORS,
    ] as const) {
      await deleteRoomRecords(this.db, storeName, roomId);
    }
    await this.filesystem?.deletePrefix(sealedBlobRoomPrefix(roomId));
    return true;
  }

  /**
   * Generate and persist a fresh non-extractable workspace HKDF root. The
   * raw key bytes never exist outside generateWorkspaceRootKey. Exactly one
   * root may ever exist per workspace — a second create conflicts.
   */
  async createWorkspaceKey(workspaceId: string): Promise<CryptoKey> {
    requireId(workspaceId, 'workspaceId');
    const rootKey = await generateWorkspaceRootKey(this.cryptoImpl);
    const tx = this.db.transaction(STORE_WORKSPACE_KEYS, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_WORKSPACE_KEYS).add({ workspaceId, rootKey });
    try {
      await done;
    } catch (error) {
      if (isConstraintError(error)) {
        throw new StorageConflictError('workspace already has a root key');
      }
      throw error;
    }
    return rootKey;
  }

  async getWorkspaceRootKey(workspaceId: string): Promise<CryptoKey | null> {
    requireId(workspaceId, 'workspaceId');
    const record = await this.get<{ workspaceId: string; rootKey: CryptoKey }>(
      STORE_WORKSPACE_KEYS,
      workspaceId,
    );
    if (!record) return null;
    validateWorkspaceRootKey(record.rootKey);
    return record.rootKey;
  }

  /** Open the workspace-key-sealed terminal decision receipt for idempotent replay. */
  async getReviewActionReceipt(
    identity: BrowserReviewActionIdentity,
    actionId: string,
  ): Promise<BrowserReviewActionReceipt | null> {
    const workspaceId = identity.workspaceId;
    requireId(workspaceId, 'workspaceId');
    if (deriveBrowserReviewActionId(identity) !== actionId) {
      throw new StorageConflictError('review action id does not match its normalized identity');
    }
    const recoveryId = browserReviewActionRecoveryId(actionId);
    const bytes = await this.getWorkspaceRecovery(workspaceId, recoveryId);
    if (!bytes) return null;
    try {
      const receipt = decodeBrowserReviewActionReceipt(bytes);
      if (receipt.workspaceId !== workspaceId || receipt.actionId !== actionId) {
        throw new StorageConflictError('review action receipt routing metadata conflicts');
      }
      const [outbox, history] = await Promise.all([
        this.get<OutboxRecord>(STORE_OUTBOX, [receipt.roomId, receipt.terminalEnvelopeId]),
        this.get<HistoryRecord>(STORE_HISTORY, [receipt.roomId, receipt.terminalEnvelopeId]),
      ]);
      const durable = outbox?.envelope ?? history?.envelope;
      if (!durable || !sameEnvelope(durable, receipt.terminalEnvelope)) {
        throw new StorageConflictError('review action receipt has no identical durable envelope');
      }
      return receipt;
    } finally {
      bytes.fill(0);
    }
  }

  /**
   * Commit one owner terminal decision without a write-before-event window.
   * Revision/head, workspace clock, sealed receipt, and the exact ciphertext
   * outbox row share one fenced IndexedDB readwrite transaction.
   */
  async commitReviewAction(
    commit: AtomicBrowserReviewActionCommit,
  ): Promise<{ receipt: BrowserReviewActionReceipt; replayed: boolean }> {
    const { identity } = commit;
    requireId(identity.workspaceId, 'workspaceId');
    requireId(identity.roomId, 'roomId');
    requireId(identity.path, 'path');
    if (identity.path !== normalizeEntryPath(identity.path)) {
      throw new BrowserStorageError('review action path must be canonical');
    }
    requireId(identity.suggestionId, 'suggestionId');
    requireId(commit.expectedHeadRevisionId, 'expectedHeadRevisionId');
    browserReviewActionRecoveryId(commit.actionId);
    validateEnvelope(identity.roomId, commit.terminal.envelope);
    if (commit.terminal.event.meta.roomId !== identity.roomId) {
      throw new BrowserStorageError('review action terminal event routing is invalid');
    }

    if (deriveBrowserReviewActionId(identity) !== commit.actionId) {
      throw new StorageConflictError('review action id does not match its normalized identity');
    }
    const existing = await this.getReviewActionReceipt(identity, commit.actionId);
    if (existing) {
      validateReceiptAgainstCommit(existing, commit);
      return { receipt: existing, replayed: true };
    }

    const rootKey = await this.getWorkspaceRootKey(identity.workspaceId);
    if (!rootKey) {
      throw new BrowserStorageError(`workspace key is unavailable: ${identity.workspaceId}`);
    }
    const recoveryId = browserReviewActionRecoveryId(commit.actionId);

    for (let attempt = 0; attempt < MAX_REVIEW_ACTION_COMMIT_RETRIES; attempt += 1) {
      const workspace = await this.workspaces.getWorkspace(identity.workspaceId);
      const entry = await this.workspaces.getEntry(identity.workspaceId, identity.path);
      if (!workspace) {
        throw new BrowserStorageError(`workspace does not exist: ${identity.workspaceId}`);
      }
      if (!entry) throw new BrowserStorageError(`entry does not exist: ${identity.path}`);
      if (entry.headRevisionId !== commit.expectedHeadRevisionId) {
        throw new StorageConflictError('head advanced past the expected review action base');
      }
      if (workspace.clock >= Number.MAX_SAFE_INTEGER) {
        throw new BrowserStorageError('workspace clock is exhausted');
      }
      const clock = workspace.clock + 1;
      const at = this.now();
      requireTimestamp(at, 'review action createdAt');
      const updatedAt = Math.max(at, workspace.updatedAt);
      const nextWorkspace: WorkspaceRecord = { ...workspace, clock, updatedAt };

      let revision: WorkspaceRevisionRecord | undefined;
      let nextEntry: WorkspaceEntryRecord = entry;
      if (commit.disposition === 'accepted') {
        revision = await this.workspaces.prepareRevisionForAtomicCommit({
          workspaceId: identity.workspaceId,
          revisionId: commit.revisionId,
          path: identity.path,
          clock,
          body: commit.body,
        });
        if (revision.bodyHash !== commit.bodyHash) {
          throw new BrowserStorageError('accepted revision body hash does not match action');
        }
        nextEntry = {
          ...entry,
          headRevisionId: commit.revisionId,
          sizeBytes: commit.body.length,
          clock,
          updatedAt,
        };
      }

      const receipt: BrowserReviewActionReceipt = {
        v: 1,
        ...identity,
        actionId: commit.actionId,
        disposition: commit.disposition,
        terminalEvent: structuredClone(commit.terminal.event),
        terminalEnvelope: structuredClone(commit.terminal.envelope),
        terminalEnvelopeId: commit.terminal.envelope.envelopeId,
        baseRevisionId: commit.expectedHeadRevisionId,
        ...(commit.disposition === 'accepted'
          ? {
              baseBodyHash: commit.expectedBodyHash,
              appliedRevisionId: commit.revisionId,
              resultingHash: commit.bodyHash,
            }
          : {}),
      };
      const receiptBytes = encodeBrowserReviewActionReceipt(receipt);
      let sealedReceipt: { nonce: string; ciphertext: string };
      try {
        sealedReceipt = await sealRecovery(
          this.cryptoImpl,
          rootKey,
          { workspaceId: identity.workspaceId, recoveryId },
          receiptBytes,
        );
      } finally {
        receiptBytes.fill(0);
      }
      const receiptRecord: ReviewActionRecoveryRecord = {
        v: WORKSPACE_RECORD_VERSION,
        workspaceId: identity.workspaceId,
        recoveryId,
        createdAt: updatedAt,
        nonce: sealedReceipt.nonce,
        ciphertext: sealedReceipt.ciphertext,
        reviewActionId: commit.actionId,
        reviewActionDisposition: commit.disposition,
      };
      validateWorkspaceRecoveryRecord(receiptRecord);

      const stores: StoreName[] = [
        STORE_WORKSPACES,
        STORE_WORKSPACE_ENTRIES,
        STORE_WORKSPACE_REVISIONS,
        STORE_WORKSPACE_GC,
        STORE_WORKSPACE_LEASES,
        STORE_WORKSPACE_RECOVERY,
        STORE_OUTBOX,
        STORE_HISTORY,
      ];
      const tx = this.db.transaction(stores, 'readwrite');
      const done = transactionDone(tx);
      const [currentWorkspace, currentEntry, baseRevision, lease, priorReceipt, outboxRow, historyRow] =
        await Promise.all([
          requestValue<WorkspaceRecord | undefined>(
            tx.objectStore(STORE_WORKSPACES).get(identity.workspaceId),
          ),
          requestValue<WorkspaceEntryRecord | undefined>(
            tx.objectStore(STORE_WORKSPACE_ENTRIES).get([identity.workspaceId, identity.path]),
          ),
          requestValue<WorkspaceRevisionRecord | undefined>(
            tx.objectStore(STORE_WORKSPACE_REVISIONS).get([
              identity.workspaceId,
              commit.expectedHeadRevisionId,
            ]),
          ),
          requestValue<WorkspaceLeaseRecord | undefined>(
            tx.objectStore(STORE_WORKSPACE_LEASES).get(identity.workspaceId),
          ),
          requestValue<ReviewActionRecoveryRecord | undefined>(
            tx.objectStore(STORE_WORKSPACE_RECOVERY).get([identity.workspaceId, recoveryId]),
          ),
          requestValue<OutboxRecord | undefined>(
            tx.objectStore(STORE_OUTBOX).get([
              identity.roomId,
              commit.terminal.envelope.envelopeId,
            ]),
          ),
          requestValue<HistoryRecord | undefined>(
            tx.objectStore(STORE_HISTORY).get([
              identity.roomId,
              commit.terminal.envelope.envelopeId,
            ]),
          ),
        ]);

      if (priorReceipt) {
        validateWorkspaceRecoveryRecord(priorReceipt);
        if (
          priorReceipt.reviewActionId !== commit.actionId ||
          priorReceipt.reviewActionDisposition !== commit.disposition
        ) {
          tx.abort();
          await done.catch(() => undefined);
          throw new StorageConflictError('suggestion already has the opposite terminal decision');
        }
        await done;
        const replay = await this.getReviewActionReceipt(identity, commit.actionId);
        if (!replay) throw new BrowserStorageError('review action replay receipt disappeared');
        validateReceiptAgainstCommit(replay, commit);
        return { receipt: replay, replayed: true };
      }

      if (!currentWorkspace || currentWorkspace.clock !== workspace.clock) {
        tx.abort();
        await done.catch(() => undefined);
        continue;
      }
      validateWorkspaceRecord(currentWorkspace);
      if (!currentEntry || currentEntry.deletedAt !== undefined) {
        tx.abort();
        await done.catch(() => undefined);
        throw new BrowserStorageError(`entry does not exist: ${identity.path}`);
      }
      validateWorkspaceEntryRecord(currentEntry);
      if (currentEntry.headRevisionId !== commit.expectedHeadRevisionId) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('head advanced past the expected review action base');
      }
      if (commit.disposition === 'accepted') {
        if (!baseRevision) {
          tx.abort();
          await done.catch(() => undefined);
          throw new BrowserStorageError('review action base revision is missing');
        }
        validateWorkspaceRevisionRecord(baseRevision);
        if (
          baseRevision.path !== identity.path ||
          baseRevision.bodyHash !== commit.expectedBodyHash
        ) {
          tx.abort();
          await done.catch(() => undefined);
          throw new StorageConflictError('review action bytes do not match the expected head');
        }
      }
      try {
        validateActiveFence(lease, commit.fence, this.now());
      } catch (error) {
        tx.abort();
        await done.catch(() => undefined);
        throw error;
      }

      const priorEnvelope = outboxRow?.envelope ?? historyRow?.envelope;
      if (priorEnvelope && !sameEnvelope(priorEnvelope, commit.terminal.envelope)) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('terminal envelope id conflicts with durable ciphertext');
      }

      if (revision) {
        const priorRevision = await requestValue<WorkspaceRevisionRecord | undefined>(
          tx.objectStore(STORE_WORKSPACE_REVISIONS).get([
            identity.workspaceId,
            revision.revisionId,
          ]),
        );
        if (priorRevision) {
          validateWorkspaceRevisionRecord(priorRevision);
          if (
            priorRevision.path !== revision.path ||
            priorRevision.sizeBytes !== revision.sizeBytes ||
            priorRevision.bodyHash !== revision.bodyHash
          ) {
            tx.abort();
            await done.catch(() => undefined);
            throw new StorageConflictError('accepted revision id conflicts with stored content');
          }
        } else {
          tx.objectStore(STORE_WORKSPACE_REVISIONS).add(revision);
        }
        tx.objectStore(STORE_WORKSPACE_ENTRIES).put(nextEntry);
        if (revision.body.location === 'opfs') {
          tx.objectStore(STORE_WORKSPACE_GC).delete(
            workspaceRevisionGcIntentId(identity.workspaceId, revision.revisionId),
          );
        }
      }
      tx.objectStore(STORE_WORKSPACES).put(nextWorkspace);
      tx.objectStore(STORE_WORKSPACE_RECOVERY).add(receiptRecord);
      if (!priorEnvelope) {
        tx.objectStore(STORE_OUTBOX).add({
          roomId: identity.roomId,
          envelopeId: commit.terminal.envelope.envelopeId,
          createdAt: commit.terminal.envelope.createdAt,
          envelope: structuredClone(commit.terminal.envelope),
        } satisfies OutboxRecord);
      }
      await done;
      return { receipt, replayed: false };
    }
    throw new StorageConflictError('review action commit kept losing workspace clock races');
  }

  /** Seal an opaque recovery payload under this workspace's non-extractable key. */
  async putWorkspaceRecovery(
    workspaceId: string,
    recoveryId: string,
    plaintext: Uint8Array,
  ): Promise<WorkspaceRecoverySummary> {
    requireId(workspaceId, 'workspaceId');
    requireId(recoveryId, 'recoveryId');
    if (!(plaintext instanceof Uint8Array)) {
      throw new BrowserStorageError('workspace recovery plaintext must be Uint8Array');
    }
    if (plaintext.length > MAX_SEALED_RECOVERY_BYTES - 16) {
      throw new BrowserStorageError('workspace recovery plaintext exceeds its sealed size cap');
    }
    const rootKey = await this.getWorkspaceRootKey(workspaceId);
    if (!rootKey) throw new BrowserStorageError(`workspace key is unavailable: ${workspaceId}`);
    const copy = new Uint8Array(plaintext);
    let sealed: { nonce: string; ciphertext: string };
    try {
      sealed = await sealRecovery(
        this.cryptoImpl,
        rootKey,
        { workspaceId, recoveryId },
        copy,
      );
    } finally {
      copy.fill(0);
    }
    const createdAt = this.now();
    requireTimestamp(createdAt, 'createdAt');
    const record: WorkspaceRecoveryRecord = {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId,
      recoveryId,
      createdAt,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
    };
    validateWorkspaceRecoveryRecord(record);
    const tx = this.db.transaction(STORE_WORKSPACE_RECOVERY, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_WORKSPACE_RECOVERY).put(record);
    await done;
    return { workspaceId, recoveryId, createdAt };
  }

  /** Open an opaque recovery payload. Returned plaintext belongs to the caller. */
  async getWorkspaceRecovery(
    workspaceId: string,
    recoveryId: string,
  ): Promise<Uint8Array | null> {
    requireId(workspaceId, 'workspaceId');
    requireId(recoveryId, 'recoveryId');
    const record = await this.get<WorkspaceRecoveryRecord>(STORE_WORKSPACE_RECOVERY, [
      workspaceId,
      recoveryId,
    ]);
    if (!record) return null;
    validateWorkspaceRecoveryRecord(record);
    if (record.workspaceId !== workspaceId || record.recoveryId !== recoveryId) {
      throw new BrowserStorageError('workspace recovery routing metadata is invalid');
    }
    const rootKey = await this.getWorkspaceRootKey(workspaceId);
    if (!rootKey) throw new BrowserStorageError(`workspace key is unavailable: ${workspaceId}`);
    return openRecovery(
      this.cryptoImpl,
      rootKey,
      { workspaceId, recoveryId },
      { nonce: record.nonce, ciphertext: record.ciphertext },
    );
  }

  async deleteWorkspaceRecovery(workspaceId: string, recoveryId: string): Promise<boolean> {
    requireId(workspaceId, 'workspaceId');
    requireId(recoveryId, 'recoveryId');
    const tx = this.db.transaction(STORE_WORKSPACE_RECOVERY, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_RECOVERY);
    const existing = await requestValue<unknown>(store.get([workspaceId, recoveryId]));
    if (existing !== undefined) store.delete([workspaceId, recoveryId]);
    await done;
    return existing !== undefined;
  }

  async listWorkspaceRecoveries(workspaceId: string): Promise<WorkspaceRecoverySummary[]> {
    requireId(workspaceId, 'workspaceId');
    const tx = this.db.transaction(STORE_WORKSPACE_RECOVERY, 'readonly');
    const done = transactionDone(tx);
    const records = await requestValue<WorkspaceRecoveryRecord[]>(
      tx
        .objectStore(STORE_WORKSPACE_RECOVERY)
        .index(WORKSPACE_INDEX)
        .getAll(IDBKeyRange.only(workspaceId)),
    );
    await done;
    for (const record of records) validateWorkspaceRecoveryRecord(record);
    return records
      .map(({ recoveryId, createdAt }) => ({ workspaceId, recoveryId, createdAt }))
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.recoveryId.localeCompare(right.recoveryId)
          : left.createdAt - right.createdAt,
      );
  }

  /** Validate, canonicalize, and seal one transport-neutral authority checkpoint. */
  async putCollabCheckpoint(
    workspaceId: string,
    checkpoint: BrowserCollabCheckpoint,
    options: { fence: WorkspaceFence; expectedVersion: number },
  ): Promise<WorkspaceRecoverySummary> {
    validateBrowserCollabCheckpoint(checkpoint);
    if (
      !Number.isSafeInteger(options.expectedVersion) ||
      options.expectedVersion < 0 ||
      options.expectedVersion >= checkpoint.version
    ) {
      throw new BrowserStorageError('collab checkpoint expectedVersion is invalid');
    }
    const recoveryId = collabCheckpointRecoveryId(
      checkpoint.roomId,
      checkpoint.fileId,
      checkpoint.epoch,
    );
    const rootKey = await this.getWorkspaceRootKey(workspaceId);
    if (!rootKey) throw new BrowserStorageError(`workspace key is unavailable: ${workspaceId}`);
    const bytes = encodeBrowserCollabCheckpoint(checkpoint);
    let sealed: { nonce: string; ciphertext: string };
    try {
      sealed = await sealRecovery(
        this.cryptoImpl,
        rootKey,
        { workspaceId, recoveryId },
        bytes,
      );
    } finally {
      bytes.fill(0);
    }
    const createdAt = this.now();
    requireTimestamp(createdAt, 'createdAt');
    const tx = this.db.transaction(
      [STORE_WORKSPACE_RECOVERY, STORE_WORKSPACE_LEASES],
      'readwrite',
    );
    const done = transactionDone(tx);
    const lease = await requestValue<WorkspaceLeaseRecord | undefined>(
      tx.objectStore(STORE_WORKSPACE_LEASES).get(workspaceId),
    );
    if (lease) validateWorkspaceLeaseRecord(lease);
    try {
      validateActiveFence(lease, options.fence, this.now());
    } catch (error) {
      tx.abort();
      await done.catch(() => undefined);
      throw error;
    }
    const store = tx.objectStore(STORE_WORKSPACE_RECOVERY);
    const existing = await requestValue<CollabRecoveryRecord | undefined>(
      store.get([workspaceId, recoveryId]),
    );
    if (existing) {
      validateWorkspaceRecoveryRecord(existing);
      if (
        existing.collabEpoch !== checkpoint.epoch ||
        existing.collabVersion !== options.expectedVersion
      ) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('collab checkpoint version moved');
      }
    } else if (options.expectedVersion !== 0) {
      tx.abort();
      await done.catch(() => undefined);
      throw new StorageConflictError('collab checkpoint base version is missing');
    }
    const record: CollabRecoveryRecord = {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId,
      recoveryId,
      createdAt,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      collabEpoch: checkpoint.epoch,
      collabVersion: checkpoint.version,
    };
    validateWorkspaceRecoveryRecord(record);
    store.put(record);
    await done;
    return { workspaceId, recoveryId, createdAt };
  }

  async getCollabCheckpoint(
    workspaceId: string,
    roomId: string,
    fileId: string,
    epoch: string,
  ): Promise<BrowserCollabCheckpoint | null> {
    const recoveryId = collabCheckpointRecoveryId(roomId, fileId, epoch);
    const bytes = await this.getWorkspaceRecovery(workspaceId, recoveryId);
    if (!bytes) return null;
    try {
      const checkpoint = decodeBrowserCollabCheckpoint(bytes);
      if (
        checkpoint.roomId !== roomId ||
        checkpoint.fileId !== fileId ||
        checkpoint.epoch !== epoch
      ) {
        throw new BrowserStorageError('collab checkpoint routing metadata is invalid');
      }
      return checkpoint;
    } finally {
      bytes.fill(0);
    }
  }

  async deleteCollabCheckpoint(
    workspaceId: string,
    roomId: string,
    fileId: string,
    epoch: string,
  ): Promise<boolean> {
    return this.deleteWorkspaceRecovery(
      workspaceId,
      collabCheckpointRecoveryId(roomId, fileId, epoch),
    );
  }

  async listCollabCheckpoints(
    workspaceId: string,
    roomId?: string,
  ): Promise<BrowserCollabCheckpoint[]> {
    if (roomId !== undefined) validateCollabCheckpointRoomId(roomId);
    const summaries = await this.listWorkspaceRecoveries(workspaceId);
    const checkpoints: BrowserCollabCheckpoint[] = [];
    for (const summary of summaries) {
      if (!isCollabCheckpointRecoveryId(summary.recoveryId)) continue;
      const bytes = await this.getWorkspaceRecovery(workspaceId, summary.recoveryId);
      if (!bytes) continue;
      try {
        const checkpoint = decodeBrowserCollabCheckpoint(bytes);
        const expected = collabCheckpointRecoveryId(
          checkpoint.roomId,
          checkpoint.fileId,
          checkpoint.epoch,
        );
        if (expected !== summary.recoveryId) {
          throw new BrowserStorageError('collab checkpoint recovery id does not match its payload');
        }
        if (roomId === undefined || checkpoint.roomId === roomId) checkpoints.push(checkpoint);
      } finally {
        bytes.fill(0);
      }
    }
    return checkpoints.sort((left, right) =>
      left.roomId === right.roomId
        ? left.fileId.localeCompare(right.fileId)
        : left.roomId.localeCompare(right.roomId),
    );
  }

  /**
   * Crypto-erasure primitive: deleting the root makes every sealed revision,
   * capability, and recovery record for the workspace permanently opaque.
   * Callers delete the key FIRST, then clean up records — an interrupted
   * cleanup can never resurrect private content.
   */
  async deleteWorkspaceKey(workspaceId: string): Promise<boolean> {
    requireId(workspaceId, 'workspaceId');
    const tx = this.db.transaction(STORE_WORKSPACE_KEYS, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_KEYS);
    const existing = await requestValue<unknown>(store.get(workspaceId));
    if (existing !== undefined) store.delete(workspaceId);
    await done;
    return existing !== undefined;
  }

  private async requireRoomRootKey(roomId: string): Promise<CryptoKey> {
    const rootKey = await this.getRoomRootKey(roomId);
    if (!rootKey) throw new BrowserStorageError(`room key is unavailable: ${roomId}`);
    return rootKey;
  }

  private async get<T>(storeName: StoreName, key: IDBValidKey): Promise<T | null> {
    const tx = this.db.transaction(storeName, 'readonly');
    const done = transactionDone(tx);
    const value = await requestValue<T | undefined>(tx.objectStore(storeName).get(key));
    await done;
    return value ?? null;
  }

  private async getAllByRoom<T>(storeName: StoreName, roomId: string): Promise<T[]> {
    const tx = this.db.transaction(storeName, 'readonly');
    const done = transactionDone(tx);
    const records = await requestValue<T[]>(
      tx.objectStore(storeName).index(ROOM_INDEX).getAll(IDBKeyRange.only(roomId)),
    );
    await done;
    return records;
  }
}

async function openDatabase(
  factory: IDBFactory,
  name: string,
  createIfMissing: boolean,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, BROWSER_STORAGE_SCHEMA_VERSION);
    let missing = false;
    request.onupgradeneeded = (event) => {
      const oldVersion = event.oldVersion;
      if (oldVersion === 0 && !createIfMissing) {
        missing = true;
        request.transaction?.abort();
        return;
      }
      migrate(request.result, oldVersion, request.transaction!);
    };
    request.onerror = () => {
      if (missing) reject(new MissingBrowserStorageError(name));
      else reject(request.error ?? new BrowserStorageError('failed to open browser storage'));
    };
    request.onblocked = () => reject(new BrowserStorageError('browser storage upgrade is blocked'));
    request.onsuccess = () => {
      if (missing) {
        request.result.close();
        reject(new MissingBrowserStorageError(name));
      } else {
        resolve(request.result);
      }
    };
  });
}

function migrate(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction): void {
  if (oldVersion < 1) {
    db.createObjectStore(STORE_ROOM_KEYS, { keyPath: 'roomId' });
    db.createObjectStore(STORE_ROOMS, { keyPath: 'roomId' });
  }
  if (oldVersion < 2) {
    createRoomStore(db, STORE_DEVICES, ['roomId', 'deviceId']);
    createRoomStore(db, STORE_IDENTITIES, 'roomId');
    const inbox = createRoomStore(db, STORE_INBOX, ['roomId', 'envelopeId']);
    inbox.createIndex(INBOX_SEQUENCE_INDEX, ['roomId', 'serverSeq'], { unique: true });
    createRoomStore(db, STORE_CURSORS, ['roomId', 'deviceId']);
    const outbox = createRoomStore(db, STORE_OUTBOX, ['roomId', 'envelopeId']);
    outbox.createIndex(OUTBOX_ORDER_INDEX, ['roomId', 'createdAt', 'envelopeId']);
    const history = createRoomStore(db, STORE_HISTORY, ['roomId', 'envelopeId']);
    history.createIndex(HISTORY_ORDER_INDEX, ['roomId', 'ackedAt', 'envelopeId']);
  }
  if (oldVersion < 3) {
    // Browser-owned workspace stores (attn-7xl.2.1). Every store the
    // workspace feature will need is created here so later steps never
    // require another version bump. Existing room stores are untouched.
    const workspaces = db.createObjectStore(STORE_WORKSPACES, { keyPath: 'workspaceId' });
    workspaces.createIndex(WORKSPACE_UPDATED_INDEX, 'updatedAt');
    db.createObjectStore(STORE_WORKSPACE_KEYS, { keyPath: 'workspaceId' });
    const entries = db.createObjectStore(STORE_WORKSPACE_ENTRIES, {
      keyPath: ['workspaceId', 'path'],
    });
    entries.createIndex(WORKSPACE_INDEX, 'workspaceId');
    const revisions = db.createObjectStore(STORE_WORKSPACE_REVISIONS, {
      keyPath: ['workspaceId', 'revisionId'],
    });
    revisions.createIndex(WORKSPACE_INDEX, 'workspaceId');
    revisions.createIndex(REVISION_HISTORY_INDEX, ['workspaceId', 'path', 'clock'], {
      unique: true,
    });
    const shareCaps = db.createObjectStore(STORE_WORKSPACE_SHARE_CAPS, {
      keyPath: ['workspaceId', 'capId'],
    });
    shareCaps.createIndex(WORKSPACE_INDEX, 'workspaceId');
    const recovery = db.createObjectStore(STORE_WORKSPACE_RECOVERY, {
      keyPath: ['workspaceId', 'recoveryId'],
    });
    recovery.createIndex(WORKSPACE_INDEX, 'workspaceId');
    const gc = db.createObjectStore(STORE_WORKSPACE_GC, { keyPath: 'gcId' });
    gc.createIndex(GC_CREATED_INDEX, 'createdAt');
    gc.createIndex(WORKSPACE_INDEX, 'workspaceId');
    db.createObjectStore(STORE_WORKSPACE_LEASES, { keyPath: 'workspaceId' });
  }
  // Touch transaction so strict implementations keep the upgrade transaction
  // associated with this migration function.
  void transaction.objectStore(STORE_ROOMS);
}

function createRoomStore(
  db: IDBDatabase,
  name: StoreName,
  keyPath: string | string[],
): IDBObjectStore {
  const store = db.createObjectStore(name, { keyPath });
  store.createIndex(ROOM_INDEX, 'roomId');
  return store;
}

async function importOpaqueRootKey(cryptoImpl: Crypto, rootKeyBytes: Uint8Array): Promise<CryptoKey> {
  const rootCopy = new Uint8Array(rootKeyBytes);
  try {
    return cryptoImpl.subtle.importKey('raw', rootCopy, 'HKDF', false, ['deriveBits']);
  } finally {
    rootCopy.fill(0);
  }
}

async function deriveSubkey(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  info: Uint8Array,
): Promise<Uint8Array> {
  validateRootKey(rootKey);
  return new Uint8Array(
    await cryptoImpl.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: ownedBuffer(info) },
      rootKey,
      256,
    ),
  );
}

function validateRootKey(key: CryptoKey): void {
  if (
    !key ||
    key.type !== 'secret' ||
    key.extractable ||
    key.algorithm.name !== 'HKDF' ||
    !key.usages.includes('deriveBits')
  ) {
    throw new BrowserStorageError('stored room root is not a non-extractable HKDF key');
  }
}

function validateRoom(room: BrowserStorageRoom): void {
  requireId(room.roomId, 'roomId');
  requireTimestamp(room.lastCreatedAt, 'lastCreatedAt');
  if (typeof room.storagePersisted !== 'boolean') {
    throw new BrowserStorageError('storagePersisted must be a boolean');
  }
  if (room.createdAt !== undefined) requireTimestamp(room.createdAt, 'createdAt');
  if (room.updatedAt !== undefined) requireTimestamp(room.updatedAt, 'updatedAt');
  if (!room.policy || typeof room.policy !== 'object') {
    throw new BrowserStorageError('room policy is required');
  }
  validatePolicy(room.policy);
  if (room.relayUrl !== undefined && typeof room.relayUrl !== 'string') {
    throw new BrowserStorageError('relayUrl must be a string');
  }
}

function validatePolicy(policy: RoomPolicy): void {
  if (!['live', 'async', 'hybrid'].includes(policy.mode)) {
    throw new BrowserStorageError('room policy mode is invalid');
  }
  for (const [label, value] of [
    ['maxPeers', policy.maxPeers],
    ['maxSnapshotBytes', policy.maxSnapshotBytes],
    ['maxEventBytes', policy.maxEventBytes],
    ['maxEvents', policy.maxEvents],
    ['expiresAt', policy.expiresAt],
    ['powBits', policy.powBits],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BrowserStorageError(`room policy ${label} must be a positive safe integer`);
    }
  }
  for (const [label, value] of [
    ['deleteEventsAfterOwnerAck', policy.deleteEventsAfterOwnerAck],
    ['allowBrowser', policy.allowBrowser],
    ['allowRemoteAgents', policy.allowRemoteAgents],
  ] as const) {
    if (typeof value !== 'boolean') throw new BrowserStorageError(`room policy ${label} is invalid`);
  }
}

function validateIdentity(identity: BrowserStorageDeviceIdentity): void {
  requireId(identity.deviceId, 'deviceId');
  requireId(identity.participantId, 'participantId');
  for (const [label, bytes] of [
    ['signingSecret', identity.signingSecret],
    ['signingPublic', identity.signingPublic],
    ['encryptionSecret', identity.encryptionSecret],
    ['publicEncryptionKey', identity.publicEncryptionKey],
  ] as const) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
      throw new BrowserStorageError(`${label} must be 32 bytes`);
    }
  }
  if (!equalBytes(ed25519.getPublicKey(identity.signingSecret), identity.signingPublic)) {
    throw new BrowserStorageError('Ed25519 private/public keys do not match');
  }
  if (!equalBytes(x25519.getPublicKey(identity.encryptionSecret), identity.publicEncryptionKey)) {
    throw new BrowserStorageError('X25519 private/public keys do not match');
  }
}

function validateIdentityRecord(record: IdentityRecord, roomId: string, deviceId: string): void {
  if (
    record.v !== LOCAL_IDENTITY_RECORD_VERSION ||
    record.roomId !== roomId ||
    record.deviceId !== deviceId
  ) {
    throw new BrowserStorageError('stored identity routing metadata is invalid');
  }
  requireId(record.participantId, 'participantId');
  decodeLength(record.publicSigningKey, 32, 'Ed25519 public key').fill(0);
  decodeLength(record.publicEncryptionKey, 32, 'X25519 public key').fill(0);
}

function validateDevice(device: Device): void {
  requireId(device.deviceId, 'deviceId');
  requireId(device.participantId, 'participantId');
  if (!['attn-native', 'attn-browser', 'agent-cli'].includes(device.client)) {
    throw new BrowserStorageError('device client is invalid');
  }
  if (!['owner', 'reviewer', 'agent'].includes(device.kind)) {
    throw new BrowserStorageError('device kind is invalid');
  }
  const signing = decodeLength(device.publicSigningKey, 32, 'Ed25519 public key');
  const encryption = decodeLength(device.publicEncryptionKey, 32, 'X25519 public key');
  const signature = decodeLength(device.selfSignature, 64, 'device self-signature');
  // MUST mirror browser-ws.ts `registrationBytes`: v3 grant-registered
  // devices (durable-share reviewers) sign over their grant fields too.
  // Omitting them rejected every /s/ joiner's record with "self-signature is
  // invalid", which broke directory persistence AND — because the presence
  // join path awaits persistence — kept live reviewers marked away forever.
  const canonical = toCanonicalBytes({
    client: device.client,
    deviceId: device.deviceId,
    kind: device.kind,
    participantId: device.participantId,
    publicEncryptionKey: device.publicEncryptionKey,
    publicSigningKey: device.publicSigningKey,
    ...(device.grantTier === undefined ? {} : { grantTier: device.grantTier }),
    ...(device.grantSignature === undefined ? {} : { grantSignature: device.grantSignature }),
  });
  try {
    if (!ed25519.verify(signature, canonical, signing)) {
      throw new BrowserStorageError('device self-signature is invalid');
    }
  } finally {
    signing.fill(0);
    encryption.fill(0);
    signature.fill(0);
    canonical.fill(0);
  }
}

function validateEnvelope(roomId: string, envelope: MailboxEnvelope): void {
  requireId(roomId, 'roomId');
  if (!envelope || typeof envelope !== 'object') {
    throw new BrowserStorageError('envelope must be an object');
  }
  if (envelope.v !== undefined && envelope.v !== 2) {
    throw new BrowserStorageError('envelope protocol version is invalid');
  }
  if (envelope.roomId !== undefined && envelope.roomId !== roomId) {
    throw new BrowserStorageError('envelope room does not match storage room');
  }
  for (const [label, value] of [
    ['envelopeId', envelope.envelopeId],
    ['authorId', envelope.authorId],
    ['deviceId', envelope.deviceId],
  ] as const) {
    requireId(value, label);
  }
  if (!['event', 'snapshot_blob', 'signal'].includes(envelope.kind)) {
    throw new BrowserStorageError('envelope kind is invalid');
  }
  requireTimestamp(envelope.createdAt, 'createdAt');
  requireTimestamp(envelope.expiresAt, 'expiresAt');
  if (envelope.expiresAt < envelope.createdAt) {
    throw new BrowserStorageError('envelope expiresAt precedes createdAt');
  }
  if (envelope.target !== undefined && envelope.target !== null) {
    requireId(envelope.target.deviceId, 'target.deviceId');
  }
  decodeLength(envelope.nonce, 24, 'envelope nonce').fill(0);
  const ciphertext = decodeAtLeast(envelope.ciphertext, 16, 'envelope ciphertext');
  try {
    if (!Number.isSafeInteger(envelope.ciphertextBytes) || envelope.ciphertextBytes !== ciphertext.length) {
      throw new BrowserStorageError('envelope ciphertextBytes does not match ciphertext');
    }
  } finally {
    ciphertext.fill(0);
  }
}

function identityAad(
  databaseName: string,
  record: Pick<
    IdentityRecord,
    | 'v'
    | 'roomId'
    | 'deviceId'
    | 'participantId'
    | 'publicSigningKey'
    | 'publicEncryptionKey'
  >,
): Uint8Array {
  return toCanonicalBytes({
    database: databaseName,
    deviceId: record.deviceId,
    participantId: record.participantId,
    publicEncryptionKey: record.publicEncryptionKey,
    publicSigningKey: record.publicSigningKey,
    record: 'device_identity',
    roomId: record.roomId,
    v: record.v,
  });
}

function parsePrivateIdentity(bytes: Uint8Array): PrivateIdentityPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BrowserStorageError('stored identity plaintext is malformed');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).v !== LOCAL_IDENTITY_RECORD_VERSION ||
    typeof (parsed as Record<string, unknown>).signingSecret !== 'string' ||
    typeof (parsed as Record<string, unknown>).encryptionSecret !== 'string'
  ) {
    throw new BrowserStorageError('stored identity plaintext has an invalid schema');
  }
  return parsed as PrivateIdentityPayload;
}

function sameInbound(a: InboxRecord, b: InboxRecord): boolean {
  return a.serverSeq === b.serverSeq && sameEnvelope(a.envelope, b.envelope);
}

function sameEnvelope(a: MailboxEnvelope, b: MailboxEnvelope): boolean {
  return toCanonicalString(a) === toCanonicalString(b);
}

function validateActiveFence(
  lease: WorkspaceLeaseRecord | undefined,
  fence: WorkspaceFence,
  now: number,
): void {
  requireTimestamp(now, 'lease check time');
  if (!lease) throw new StorageConflictError('write requires an active lease');
  validateWorkspaceLeaseRecord(lease);
  if (lease.expiresAt <= now) {
    throw new StorageConflictError('write requires an unexpired lease');
  }
  if (lease.holderId !== fence.holderId || lease.fencingToken !== fence.fencingToken) {
    throw new StorageConflictError('write was fenced off by a newer lease');
  }
}

function validateReceiptAgainstCommit(
  receipt: BrowserReviewActionReceipt,
  commit: AtomicBrowserReviewActionCommit,
): void {
  if (
    receipt.actionId !== commit.actionId ||
    receipt.workspaceId !== commit.identity.workspaceId ||
    receipt.roomId !== commit.identity.roomId ||
    receipt.path !== commit.identity.path ||
    receipt.suggestionId !== commit.identity.suggestionId ||
    receipt.disposition !== commit.disposition ||
    receipt.baseRevisionId !== commit.expectedHeadRevisionId ||
    receipt.terminalEnvelopeId !== commit.terminal.envelope.envelopeId ||
    !sameEnvelope(receipt.terminalEnvelope, commit.terminal.envelope) ||
    toCanonicalString(receipt.terminalEvent) !== toCanonicalString(commit.terminal.event)
  ) {
    throw new StorageConflictError('review action replay differs from the requested commit');
  }
  if (
    commit.disposition === 'accepted' &&
    (
      receipt.baseBodyHash !== commit.expectedBodyHash ||
      receipt.appliedRevisionId !== commit.revisionId ||
      receipt.resultingHash !== commit.bodyHash
    )
  ) {
    throw new StorageConflictError('accepted action replay differs from the requested transition');
  }
  if (
    commit.disposition === 'rejected' &&
    (receipt.baseBodyHash !== undefined ||
      receipt.appliedRevisionId !== undefined ||
      receipt.resultingHash !== undefined)
  ) {
    throw new StorageConflictError('rejected action replay contains accepted transition fields');
  }
}

function sameDeviceRegistration(existing: Record<string, unknown>, candidate: Device): boolean {
  return (
    existing.deviceId === candidate.deviceId &&
    existing.participantId === candidate.participantId &&
    existing.publicEncryptionKey === candidate.publicEncryptionKey &&
    existing.publicSigningKey === candidate.publicSigningKey &&
    existing.client === candidate.client &&
    existing.kind === candidate.kind &&
    existing.selfSignature === candidate.selfSignature
  );
}

function sameIdentityRegistration(existing: IdentityRecord, candidate: IdentityRecord): boolean {
  return (
    existing.v === candidate.v &&
    existing.roomId === candidate.roomId &&
    existing.deviceId === candidate.deviceId &&
    existing.participantId === candidate.participantId &&
    existing.publicSigningKey === candidate.publicSigningKey &&
    existing.publicEncryptionKey === candidate.publicEncryptionKey
  );
}

function stripRoomId(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.roomId;
  return copy;
}

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrowserStorageError(`${label} is required`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BrowserStorageError(`${label} must be a non-negative safe integer`);
  }
}

function validateServerSeq(value: unknown, allowZero = false): asserts value is number {
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
    throw new BrowserStorageError('serverSeq must be a positive safe integer');
  }
}

function decodeLength(value: string, length: number, label: string): Uint8Array {
  const bytes = decodeAtLeast(value, length, label);
  if (bytes.length !== length) {
    bytes.fill(0);
    throw new BrowserStorageError(`${label} must be ${length} bytes`);
  }
  return bytes;
}

function decodeAtLeast(value: string, minimum: number, label: string): Uint8Array {
  if (typeof value !== 'string') throw new BrowserStorageError(`${label} must be base64url`);
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(value);
  } catch {
    throw new BrowserStorageError(`${label} must be valid base64url`);
  }
  if (bytes.length < minimum) {
    bytes.fill(0);
    throw new BrowserStorageError(`${label} is too short`);
  }
  return bytes;
}

function randomBytes(cryptoImpl: Crypto, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  cryptoImpl.getRandomValues(bytes);
  return bytes;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}


async function deleteRoomRecords(
  database: IDBDatabase,
  storeName: StoreName,
  roomId: string,
): Promise<void> {
  const read = database.transaction(storeName, 'readonly');
  const readDone = transactionDone(read);
  const keys = await requestValue<IDBValidKey[]>(
    read.objectStore(storeName).index(ROOM_INDEX).getAllKeys(IDBKeyRange.only(roomId)),
  );
  await readDone;
  if (keys.length === 0) return;
  const write = database.transaction(storeName, 'readwrite');
  const writeDone = transactionDone(write);
  const store = write.objectStore(storeName);
  for (const key of keys) store.delete(key);
  await writeDone;
}

function roomRange(roomId: string): IDBKeyRange {
  return IDBKeyRange.bound([roomId], [roomId, []]);
}

function opaqueHash(label: string, value: string): string {
  const bytes = toCanonicalBytes({ label, value });
  try {
    return base64UrlEncode(sha256(bytes));
  } finally {
    bytes.fill(0);
  }
}

function sealedBlobRoomPrefix(roomId: string): string {
  return `.attn-sealed/v1/${opaqueHash('room', roomId)}`;
}

function sealedBlobPath(roomId: string, blobId: string): string {
  return `${sealedBlobRoomPrefix(roomId)}/${opaqueHash('blob', blobId)}.bin`;
}

function defaultNavigator(): BrowserStorageNavigator | null {
  return typeof navigator === 'undefined' ? null : (navigator as BrowserStorageNavigator);
}

function makeOpfsFilesystem(
  navigatorImpl: BrowserStorageNavigator | null,
): SealedBlobFileSystem | null {
  const getDirectory = navigatorImpl?.storage?.getDirectory;
  if (!getDirectory) return null;
  const root = (): Promise<OpfsDirectoryHandle> => getDirectory.call(navigatorImpl!.storage);
  return {
    async write(path, bytes) {
      const parts = safePathParts(path);
      const filename = parts.pop()!;
      const directory = await descend(await root(), parts, true);
      const handle = await directory.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => undefined);
        throw error;
      }
    },
    async read(path) {
      try {
        const parts = safePathParts(path);
        const filename = parts.pop()!;
        const directory = await descend(await root(), parts, false);
        const handle = await directory.getFileHandle(filename);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async delete(path) {
      try {
        const parts = safePathParts(path);
        const filename = parts.pop()!;
        const directory = await descend(await root(), parts, false);
        await directory.removeEntry(filename);
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async deletePrefix(prefix) {
      try {
        const parts = safePathParts(prefix);
        const name = parts.pop()!;
        const parent = await descend(await root(), parts, false);
        await parent.removeEntry(name, { recursive: true });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

function safePathParts(path: string): string[] {
  const parts = path.split('/');
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new BrowserStorageError('invalid sealed blob path');
  }
  return parts;
}

async function descend(
  root: OpfsDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<OpfsDirectoryHandle> {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create });
  return current;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
