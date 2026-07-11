// Workspace share ownership + wrapped invite capability (attn-7xl.4.2).
//
// Binds a browser-owned review room to its workspace durably and safely:
//   - the raw invite capability (room secret + owner identity secrets +
//     policy + published-revision pointer) is sealed under the workspace key
//     via sealCapability (attn-7xl.2.2) — AAD binds workspaceId/capId/roomId/
//     scope, so a record can't be transplanted between workspaces or rooms;
//   - metadata (roomId, scope, relay, publication state) stays plaintext for
//     the desk/Share UI.
//
// Interrupted sharing resumes idempotently (the same capId re-opens the same
// sealed capability) or is rolled back with the room (attn-7xl.4.1 delete)
// and forgetShare. Nothing here derives keys or talks to the relay — it is
// pure local persistence over BrowserStorage's share-cap store.

import { base64UrlDecode, base64UrlEncode } from './browser-crypto';
import { openCapability, sealCapability, validateWorkspaceRootKey } from './browser-workspace-crypto';
import { requestValue, transactionDone } from './browser-idb';
import { BrowserStorageError, StorageConflictError } from './browser-storage-errors';
import type { PublishedManifestPointer } from './browser-snapshot-publisher';
import type { SnapshotPublicationSink } from './browser-snapshot-publisher';
import type { MailboxEnvelope } from './browser-ws';
import { compareManifestPathsUtf8 } from './browser-workspace-manifest';
import {
  STORE_WORKSPACE_SHARE_CAPS,
  WORKSPACE_INDEX,
  WORKSPACE_RECORD_VERSION,
  normalizeEntryPath,
  validateWorkspaceShareCapRecord,
  type ShareScopeKind,
  type WorkspaceShareCapRecord,
} from './browser-workspace-schema';

const CAPABILITY_VERSION = 1;

/** Transport/publication state a resumed share needs to continue. */
export type SharePublicationState = 'pending' | 'published' | 'stopped';

/** The raw, security-sensitive material that is sealed. */
export interface InviteCapability {
  v: number;
  /** 32-byte room invite secret (base64url). */
  roomSecret: string;
  /** Owner device private keys (base64url), so a reopened tab resumes
   * authority without re-registering a device. */
  ownerSigningSecret: string;
  ownerEncryptionSecret: string;
  ownerDeviceId: string;
  ownerParticipantId: string;
  /** Snapshot of the room policy at share time. */
  policy: unknown;
  /** Published-revision pointer (attn-7xl.4.3 updates it). */
  publishedRevisionId?: string;
  /** Last fully-acknowledged manifest and stable per-entry identities. */
  publishedManifest?: PublishedManifestPointer;
  /** In-flight publication is sealed before its exact ciphertext batch is
   * exposed to the transport. Envelope ids bind it to durable outbox rows. */
  pendingPublication?: {
    publishedManifest: PublishedManifestPointer;
    envelopeIds: string[];
  };
}

export interface ShareRecordView {
  workspaceId: string;
  capId: string;
  roomId: string;
  scopeKind: ShareScopeKind;
  relayUrl: string;
  publication: SharePublicationState;
  createdAt: number;
}

interface StoredShareRecord extends WorkspaceShareCapRecord {
  relayUrl: string;
  publication: SharePublicationState;
  /** Monotonic local CAS token; absent legacy records read as generation 0. */
  generation?: number;
  /** Pre-sealed published capability promoted by the durable ACK transaction. */
  publicationCommit?: {
    envelopeIds: string[];
    nonce: string;
    ciphertext: string;
  };
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

// Stable room-store names created by browser-storage schema v2. Kept local to
// avoid a browser-storage -> workspace-share -> browser-storage import cycle.
const STORE_OUTBOX = 'outbox';
const STORE_HISTORY = 'history';

export interface BindShareInput {
  workspaceId: string;
  capId: string;
  roomId: string;
  scopeKind: ShareScopeKind;
  relayUrl: string;
  capability: InviteCapability;
}

export class WorkspaceShareStore {
  private readonly db: IDBDatabase;
  private readonly cryptoImpl: Crypto;
  private readonly now: () => number;

  constructor(db: IDBDatabase, cryptoImpl: Crypto, now: () => number) {
    this.db = db;
    this.cryptoImpl = cryptoImpl;
    this.now = now;
  }

  /**
   * Atomically bind a share to its workspace. Idempotent by capId: re-binding
   * the same capId with a capability whose sealed material opens to the same
   * roomId is a no-op resume; a different roomId conflicts.
   */
  async bindShare(rootKey: CryptoKey, input: BindShareInput): Promise<ShareRecordView> {
    validateWorkspaceRootKey(rootKey);
    requireId(input.workspaceId, 'workspaceId');
    requireId(input.capId, 'capId');
    requireId(input.roomId, 'roomId');
    requireRelay(input.relayUrl);

    const existing = await this.getRaw(input.workspaceId, input.capId);
    if (existing) {
      if (existing.roomId !== input.roomId || existing.scopeKind !== input.scopeKind) {
        throw new StorageConflictError('share capId already bound to a different room');
      }
      return toView(existing);
    }

    const plaintext = new TextEncoder().encode(
      JSON.stringify({ ...input.capability, v: CAPABILITY_VERSION }),
    );
    const meta = {
      workspaceId: input.workspaceId,
      capId: input.capId,
      roomId: input.roomId,
      scopeKind: input.scopeKind,
    } as const;
    let sealed: { nonce: string; ciphertext: string };
    try {
      sealed = await sealCapability(this.cryptoImpl, rootKey, meta, plaintext);
    } finally {
      plaintext.fill(0);
    }
    const record: StoredShareRecord = {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId: input.workspaceId,
      capId: input.capId,
      roomId: input.roomId,
      scopeKind: input.scopeKind,
      createdAt: this.timestamp(),
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      relayUrl: input.relayUrl,
      publication: 'pending',
      generation: 0,
    };
    validateWorkspaceShareCapRecord(record);

    const tx = this.db.transaction(STORE_WORKSPACE_SHARE_CAPS, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_WORKSPACE_SHARE_CAPS).add(record);
    try {
      await done;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'ConstraintError') {
        // Lost a race with a concurrent identical bind; return the winner.
        const winner = await this.getRaw(input.workspaceId, input.capId);
        if (winner) return toView(winner);
      }
      throw error;
    }
    return toView(record);
  }

  /** Open the sealed invite capability for a resumed share. Caller zeroes it. */
  async openShare(rootKey: CryptoKey, workspaceId: string, capId: string): Promise<InviteCapability> {
    validateWorkspaceRootKey(rootKey);
    const record = await this.getRaw(workspaceId, capId);
    if (!record) throw new BrowserStorageError(`share does not exist: ${capId}`);
    return this.openRecord(rootKey, record);
  }

  private async openRecord(
    rootKey: CryptoKey,
    record: StoredShareRecord,
  ): Promise<InviteCapability> {
    const opened = await openCapability(
      this.cryptoImpl,
      rootKey,
      {
        workspaceId: record.workspaceId,
        capId: record.capId,
        roomId: record.roomId,
        scopeKind: record.scopeKind,
      },
      { nonce: record.nonce, ciphertext: record.ciphertext },
    );
    try {
      return validateInviteCapability(JSON.parse(new TextDecoder().decode(opened)));
    } finally {
      opened.fill(0);
    }
  }

  async listShares(workspaceId: string): Promise<ShareRecordView[]> {
    requireId(workspaceId, 'workspaceId');
    const tx = this.db.transaction(STORE_WORKSPACE_SHARE_CAPS, 'readonly');
    const done = transactionDone(tx);
    const records = await requestValue<StoredShareRecord[]>(
      tx
        .objectStore(STORE_WORKSPACE_SHARE_CAPS)
        .index(WORKSPACE_INDEX)
        .getAll(IDBKeyRange.only(workspaceId)),
    );
    await done;
    return records.map(toView);
  }

  /** Advance publication/transport state (attn-7xl.4.3/.4.5). */
  async setPublication(
    workspaceId: string,
    capId: string,
    publication: SharePublicationState,
  ): Promise<ShareRecordView> {
    const tx = this.db.transaction(STORE_WORKSPACE_SHARE_CAPS, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_SHARE_CAPS);
    const record = await requestValue<StoredShareRecord | undefined>(
      store.get([workspaceId, capId]),
    );
    if (!record) {
      tx.abort();
      await done.catch(() => undefined);
      throw new BrowserStorageError(`share does not exist: ${capId}`);
    }
    if (publication === 'published') {
      tx.abort();
      await done.catch(() => undefined);
      throw new BrowserStorageError('published state requires durable relay acknowledgements');
    }
    if (publication === 'pending') {
      if (record.publication === 'pending') {
        await done;
        return toView(record);
      }
      tx.abort();
      await done.catch(() => undefined);
      throw new StorageConflictError('share cannot be reset to pending without a new transaction');
    }
    const next: StoredShareRecord = {
      ...record,
      publication,
      generation: generationOf(record) + 1,
      publicationCommit: undefined,
    };
    store.put(next);
    await done;
    return toView(next);
  }

  /** A bound adapter keeps the workspace root key out of publisher state. */
  publicationSink(rootKey: CryptoKey): SnapshotPublicationSink {
    validateWorkspaceRootKey(rootKey);
    return {
      loadPublishedManifest: (workspaceId, capId) =>
        this.loadPublishedManifest(rootKey, workspaceId, capId),
      stagePublication: (workspaceId, capId, pointer, envelopes) =>
        this.stagePublication(rootKey, workspaceId, capId, pointer, envelopes),
      loadPendingPublication: (workspaceId, capId) =>
        this.loadPendingPublication(rootKey, workspaceId, capId),
      commitPublication: (workspaceId, capId) =>
        this.commitPublication(rootKey, workspaceId, capId),
    };
  }

  async loadPublishedManifest(
    rootKey: CryptoKey,
    workspaceId: string,
    capId: string,
  ): Promise<PublishedManifestPointer | undefined> {
    validateWorkspaceRootKey(rootKey);
    const record = await this.getRaw(workspaceId, capId);
    if (!record) throw new BrowserStorageError(`share does not exist: ${capId}`);
    const capability = await this.openRecord(rootKey, record);
    if (capability.pendingPublication) {
      throw new StorageConflictError('pending publication must be resumed before publishing again');
    }
    return capability.publishedManifest === undefined
      ? undefined
      : validatePublishedManifest(capability.publishedManifest);
  }

  /**
   * Seal the pending pointer and atomically install every immutable envelope.
   * A crash sees either both journal+batch or neither; no partial batch exists.
   */
  async stagePublication(
    rootKey: CryptoKey,
    workspaceId: string,
    capId: string,
    publishedManifest: PublishedManifestPointer,
    envelopes: readonly MailboxEnvelope[],
  ): Promise<ShareRecordView> {
    validateWorkspaceRootKey(rootKey);
    const pointer = validatePublishedManifest(publishedManifest);
    const original = await this.getRaw(workspaceId, capId);
    if (!original) throw new BrowserStorageError(`share does not exist: ${capId}`);
    if (original.publication === 'stopped') {
      throw new StorageConflictError('stopped share cannot stage a publication');
    }
    const records = validatePublicationEnvelopes(original.roomId, envelopes);
    const capability = await this.openRecord(rootKey, original);
    if (capability.pendingPublication) {
      throw new StorageConflictError('share already has a pending publication');
    }
    const nextCapability: InviteCapability = {
      ...capability,
      pendingPublication: {
        publishedManifest: pointer,
        envelopeIds: records.map((record) => record.envelopeId),
      },
    };
    const sealed = await this.sealRecordCapability(rootKey, original, nextCapability);
    const finalCapability: InviteCapability = {
      ...capability,
      publishedManifest: pointer,
    };
    const finalSealed = await this.sealRecordCapability(rootKey, original, finalCapability);
    const tx = this.db.transaction(
      [STORE_WORKSPACE_SHARE_CAPS, STORE_OUTBOX, STORE_HISTORY],
      'readwrite',
    );
    const done = transactionDone(tx);
    const shares = tx.objectStore(STORE_WORKSPACE_SHARE_CAPS);
    const current = await requestValue<StoredShareRecord | undefined>(
      shares.get([workspaceId, capId]),
    );
    if (!sameGeneration(current, original)) {
      tx.abort();
      await done.catch(() => undefined);
      throw new StorageConflictError('share changed in another tab');
    }
    const outbox = tx.objectStore(STORE_OUTBOX);
    const history = tx.objectStore(STORE_HISTORY);
    for (const record of records) {
      const pending = await requestValue<OutboxRecord | undefined>(
        outbox.get([original.roomId, record.envelopeId]),
      );
      const sent = await requestValue<HistoryRecord | undefined>(
        history.get([original.roomId, record.envelopeId]),
      );
      const prior = pending ?? sent;
      if (prior && !sameEnvelope(prior.envelope, record.envelope)) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('publication envelope id conflicts with durable ciphertext');
      }
      if (!prior) outbox.add(record);
    }
    const next: StoredShareRecord = {
      ...original,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      publication: 'pending',
      generation: generationOf(original) + 1,
      publicationCommit: {
        envelopeIds: records.map((record) => record.envelopeId),
        nonce: finalSealed.nonce,
        ciphertext: finalSealed.ciphertext,
      },
    };
    shares.put(next);
    await done;
    return toView(next);
  }

  /** Recover only unacknowledged exact ciphertext; history proves prior ACKs. */
  async loadPendingPublication(
    rootKey: CryptoKey,
    workspaceId: string,
    capId: string,
  ): Promise<readonly MailboxEnvelope[]> {
    validateWorkspaceRootKey(rootKey);
    const record = await this.getRaw(workspaceId, capId);
    if (!record) throw new BrowserStorageError(`share does not exist: ${capId}`);
    if (record.publication === 'published') return [];
    if (record.publication !== 'pending') {
      throw new StorageConflictError('share publication is not pending');
    }
    const capability = await this.openRecord(rootKey, record);
    const pending = validatePendingPublication(capability.pendingPublication);
    const tx = this.db.transaction([STORE_OUTBOX, STORE_HISTORY], 'readonly');
    const done = transactionDone(tx);
    const outbox = tx.objectStore(STORE_OUTBOX);
    const history = tx.objectStore(STORE_HISTORY);
    const recovered: MailboxEnvelope[] = [];
    for (const envelopeId of pending.envelopeIds) {
      const queued = await requestValue<OutboxRecord | undefined>(
        outbox.get([record.roomId, envelopeId]),
      );
      const sent = await requestValue<HistoryRecord | undefined>(
        history.get([record.roomId, envelopeId]),
      );
      if (queued && sent) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('publication envelope exists in outbox and history');
      }
      if (!queued && !sent) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('publication envelope is missing from durable storage');
      }
      if (
        (queued && queued.envelope.envelopeId !== envelopeId) ||
        (sent && sent.envelope.envelopeId !== envelopeId)
      ) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('publication envelope routing metadata is corrupt');
      }
      if (queued) {
        validatePublicationEnvelopes(record.roomId, [queued.envelope]);
        recovered.push(structuredClone(queued.envelope));
      }
    }
    await done;
    return recovered;
  }

  /** Promote the sealed pending pointer only after every envelope has an ACK. */
  async commitPublication(
    rootKey: CryptoKey,
    workspaceId: string,
    capId: string,
  ): Promise<ShareRecordView> {
    validateWorkspaceRootKey(rootKey);
    const original = await this.getRaw(workspaceId, capId);
    if (!original) throw new BrowserStorageError(`share does not exist: ${capId}`);
    if (original.publication === 'published') return toView(original);
    if (original.publication !== 'pending') {
      throw new StorageConflictError('share publication is not pending');
    }
    const capability = await this.openRecord(rootKey, original);
    const pending = validatePendingPublication(capability.pendingPublication);
    const promotion = validatePublicationCommit(original.publicationCommit, pending.envelopeIds);

    const tx = this.db.transaction(
      [STORE_WORKSPACE_SHARE_CAPS, STORE_OUTBOX, STORE_HISTORY],
      'readwrite',
    );
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_SHARE_CAPS);
    const current = await requestValue<StoredShareRecord | undefined>(
      store.get([workspaceId, capId]),
    );
    if (!sameGeneration(current, original)) {
      tx.abort();
      await done.catch(() => undefined);
      throw new StorageConflictError('share capability changed in another tab');
    }
    const outbox = tx.objectStore(STORE_OUTBOX);
    const history = tx.objectStore(STORE_HISTORY);
    for (const envelopeId of pending.envelopeIds) {
      const queued = await requestValue<OutboxRecord | undefined>(
        outbox.get([original.roomId, envelopeId]),
      );
      const sent = await requestValue<HistoryRecord | undefined>(
        history.get([original.roomId, envelopeId]),
      );
      if (queued || !sent) {
        tx.abort();
        await done.catch(() => undefined);
        throw new StorageConflictError('publication has not been fully acknowledged');
      }
    }
    const next: StoredShareRecord = {
      ...current,
      nonce: promotion.nonce,
      ciphertext: promotion.ciphertext,
      publication: 'published',
      generation: generationOf(current) + 1,
      publicationCommit: undefined,
    };
    store.put(next);
    await done;
    return toView(next);
  }

  private async sealRecordCapability(
    rootKey: CryptoKey,
    record: StoredShareRecord,
    capability: InviteCapability,
  ): Promise<{ nonce: string; ciphertext: string }> {
    const plaintext = new TextEncoder().encode(JSON.stringify(capability));
    try {
      return await sealCapability(
        this.cryptoImpl,
        rootKey,
        {
          workspaceId: record.workspaceId,
          capId: record.capId,
          roomId: record.roomId,
          scopeKind: record.scopeKind,
        },
        plaintext,
      );
    } finally {
      plaintext.fill(0);
    }
  }

  /** Remove a share binding (stop-sharing / rollback). */
  async forgetShare(workspaceId: string, capId: string): Promise<boolean> {
    const tx = this.db.transaction(STORE_WORKSPACE_SHARE_CAPS, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_SHARE_CAPS);
    const existing = await requestValue<StoredShareRecord | undefined>(store.get([workspaceId, capId]));
    if (existing) store.delete([workspaceId, capId]);
    await done;
    return existing !== undefined;
  }

  private async getRaw(workspaceId: string, capId: string): Promise<StoredShareRecord | null> {
    const tx = this.db.transaction(STORE_WORKSPACE_SHARE_CAPS, 'readonly');
    const done = transactionDone(tx);
    const record = await requestValue<StoredShareRecord | undefined>(
      tx.objectStore(STORE_WORKSPACE_SHARE_CAPS).get([workspaceId, capId]),
    );
    await done;
    return record ?? null;
  }

  private timestamp(): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new BrowserStorageError('clock produced an invalid timestamp');
    }
    return at;
  }
}

/** Build the sealed capability payload from a bootstrap result + identity. */
export function inviteCapabilityFrom(input: {
  roomSecret: Uint8Array;
  ownerSigningSecret: Uint8Array;
  ownerEncryptionSecret: Uint8Array;
  ownerDeviceId: string;
  ownerParticipantId: string;
  policy: unknown;
  publishedRevisionId?: string;
  publishedManifest?: PublishedManifestPointer;
}): InviteCapability {
  return {
    v: CAPABILITY_VERSION,
    roomSecret: base64UrlEncode(input.roomSecret),
    ownerSigningSecret: base64UrlEncode(input.ownerSigningSecret),
    ownerEncryptionSecret: base64UrlEncode(input.ownerEncryptionSecret),
    ownerDeviceId: input.ownerDeviceId,
    ownerParticipantId: input.ownerParticipantId,
    policy: input.policy,
    ...(input.publishedRevisionId === undefined
      ? {}
      : { publishedRevisionId: input.publishedRevisionId }),
    ...(input.publishedManifest === undefined
      ? {}
      : { publishedManifest: validatePublishedManifest(input.publishedManifest) }),
  };
}

function validateInviteCapability(value: unknown): InviteCapability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserStorageError('sealed capability has an invalid schema');
  }
  const parsed = value as Partial<InviteCapability>;
  if (
    parsed.v !== CAPABILITY_VERSION ||
    typeof parsed.roomSecret !== 'string' ||
    typeof parsed.ownerSigningSecret !== 'string' ||
    typeof parsed.ownerEncryptionSecret !== 'string' ||
    typeof parsed.ownerDeviceId !== 'string' ||
    parsed.ownerDeviceId.length === 0 ||
    typeof parsed.ownerParticipantId !== 'string' ||
    parsed.ownerParticipantId.length === 0 ||
    typeof parsed.policy !== 'object' ||
    parsed.policy === null
  ) {
    throw new BrowserStorageError('sealed capability has an invalid schema');
  }
  for (const [label, secret] of [
    ['room secret', parsed.roomSecret],
    ['owner signing secret', parsed.ownerSigningSecret],
    ['owner encryption secret', parsed.ownerEncryptionSecret],
  ] as const) {
    try {
      if (base64UrlDecode(secret).length !== 32) {
        throw new BrowserStorageError(`sealed ${label} is not 32 bytes`);
      }
    } catch (error) {
      if (error instanceof BrowserStorageError) throw error;
      throw new BrowserStorageError(`sealed ${label} is invalid`);
    }
  }
  if (parsed.publishedRevisionId !== undefined && typeof parsed.publishedRevisionId !== 'string') {
    throw new BrowserStorageError('sealed published revision is invalid');
  }
  return {
    ...(parsed as InviteCapability),
    ...(parsed.publishedManifest === undefined
      ? {}
      : { publishedManifest: validatePublishedManifest(parsed.publishedManifest) }),
    ...(parsed.pendingPublication === undefined
      ? {}
      : { pendingPublication: validatePendingPublication(parsed.pendingPublication) }),
  };
}

function validatePendingPublication(
  value: InviteCapability['pendingPublication'] | unknown,
): NonNullable<InviteCapability['pendingPublication']> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('publishedManifest' in value) ||
    !('envelopeIds' in value) ||
    !Array.isArray(value.envelopeIds) ||
    value.envelopeIds.length === 0
  ) {
    throw new BrowserStorageError('sealed pending publication is invalid');
  }
  const ids = new Set<string>();
  const envelopeIds = value.envelopeIds.map((id) => {
    requireCapabilityId(id, 16, 'pending envelopeId');
    if (ids.has(id)) throw new BrowserStorageError('pending publication has duplicate envelopes');
    ids.add(id);
    return id;
  });
  return {
    publishedManifest: validatePublishedManifest(
      value.publishedManifest as PublishedManifestPointer,
    ),
    envelopeIds,
  };
}

function validatePublicationCommit(
  value: StoredShareRecord['publicationCommit'],
  expectedEnvelopeIds: readonly string[],
): NonNullable<StoredShareRecord['publicationCommit']> {
  if (
    !value ||
    !Array.isArray(value.envelopeIds) ||
    JSON.stringify(value.envelopeIds) !== JSON.stringify(expectedEnvelopeIds)
  ) {
    throw new BrowserStorageError('publication promotion journal is invalid');
  }
  requireCapabilityId(value.nonce, 24, 'promotion nonce');
  try {
    const ciphertext = base64UrlDecode(value.ciphertext);
    try {
      if (ciphertext.length < 16 || base64UrlEncode(ciphertext) !== value.ciphertext) {
        throw new Error('invalid ciphertext');
      }
    } finally {
      ciphertext.fill(0);
    }
  } catch {
    throw new BrowserStorageError('publication promotion ciphertext is invalid');
  }
  return value;
}

function validatePublicationEnvelopes(
  roomId: string,
  envelopes: readonly MailboxEnvelope[],
): OutboxRecord[] {
  if (envelopes.length === 0) throw new BrowserStorageError('publication batch is empty');
  const ids = new Set<string>();
  return envelopes.map((envelope) => {
    if (!envelope || typeof envelope !== 'object') {
      throw new BrowserStorageError('publication envelope is invalid');
    }
    if (envelope.v !== undefined && envelope.v !== 2) {
      throw new BrowserStorageError('publication envelope version is invalid');
    }
    if (envelope.roomId !== undefined && envelope.roomId !== roomId) {
      throw new BrowserStorageError('publication envelope room is invalid');
    }
    requireCapabilityId(envelope.envelopeId, 16, 'envelopeId');
    if (ids.has(envelope.envelopeId)) {
      throw new BrowserStorageError('publication batch has a duplicate envelope id');
    }
    ids.add(envelope.envelopeId);
    requireId(envelope.authorId, 'envelope authorId');
    requireId(envelope.deviceId, 'envelope deviceId');
    if (envelope.kind !== 'event' && envelope.kind !== 'snapshot_blob') {
      throw new BrowserStorageError('publication envelope kind is invalid');
    }
    if (
      !Number.isSafeInteger(envelope.createdAt) ||
      !Number.isSafeInteger(envelope.expiresAt) ||
      envelope.createdAt < 0 ||
      envelope.expiresAt < envelope.createdAt
    ) {
      throw new BrowserStorageError('publication envelope timestamps are invalid');
    }
    requireCapabilityId(envelope.nonce, 24, 'envelope nonce');
    let ciphertext: Uint8Array;
    try {
      ciphertext = base64UrlDecode(envelope.ciphertext);
    } catch {
      throw new BrowserStorageError('publication envelope ciphertext is invalid');
    }
    try {
      if (
        ciphertext.length < 16 ||
        base64UrlEncode(ciphertext) !== envelope.ciphertext ||
        envelope.ciphertextBytes !== ciphertext.length
      ) {
        throw new BrowserStorageError('publication envelope ciphertext length is invalid');
      }
    } finally {
      ciphertext.fill(0);
    }
    return {
      roomId,
      envelopeId: envelope.envelopeId,
      createdAt: envelope.createdAt,
      envelope: structuredClone(envelope),
    };
  });
}

function generationOf(record: StoredShareRecord): number {
  return Number.isSafeInteger(record.generation) && (record.generation ?? 0) >= 0
    ? record.generation!
    : 0;
}

function sameGeneration(
  current: StoredShareRecord | undefined,
  original: StoredShareRecord,
): current is StoredShareRecord {
  return Boolean(
    current &&
      generationOf(current) === generationOf(original) &&
      current.nonce === original.nonce &&
      current.ciphertext === original.ciphertext &&
      current.publication === original.publication,
  );
}

function sameEnvelope(left: MailboxEnvelope, right: MailboxEnvelope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePublishedManifest(value: PublishedManifestPointer): PublishedManifestPointer {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.manifestSnapshotId !== 'string' ||
    value.manifestSnapshotId.length === 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    throw new BrowserStorageError('published manifest pointer is invalid');
  }
  requireCapabilityId(value.manifestSnapshotId, 16, 'manifest snapshotId');
  let previous: string | undefined;
  const fileIds = new Set<string>();
  const snapshotIds = new Set<string>();
  const entries = value.entries.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.path !== 'string' ||
      normalizeEntryPathForCapability(entry.path) !== entry.path ||
      typeof entry.fileId !== 'string' ||
      typeof entry.snapshotId !== 'string' ||
      typeof entry.contentHash !== 'string'
    ) {
      throw new BrowserStorageError('published manifest entry is invalid');
    }
    requireCapabilityId(entry.fileId, 16, 'entry fileId');
    requireCapabilityId(entry.snapshotId, 16, 'entry snapshotId');
    requireCapabilityId(entry.contentHash, 32, 'entry contentHash');
    if (fileIds.has(entry.fileId) || snapshotIds.has(entry.snapshotId)) {
      throw new BrowserStorageError('published manifest entries have duplicate identities');
    }
    fileIds.add(entry.fileId);
    snapshotIds.add(entry.snapshotId);
    if (previous !== undefined && compareManifestPathsUtf8(previous, entry.path) >= 0) {
      throw new BrowserStorageError('published manifest entries are not uniquely path-sorted');
    }
    previous = entry.path;
    return { ...entry };
  });
  return { manifestSnapshotId: value.manifestSnapshotId, entries };
}

function requireCapabilityId(value: string, bytes: number, label: string): void {
  try {
    const decoded = base64UrlDecode(value);
    if (decoded.length !== bytes || base64UrlEncode(decoded) !== value) {
      throw new Error('invalid length/encoding');
    }
  } catch {
    throw new BrowserStorageError(`published manifest ${label} is invalid`);
  }
}

function normalizeEntryPathForCapability(path: string): string {
  try {
    return normalizeEntryPath(path);
  } catch {
    return '';
  }
}

function toView(record: StoredShareRecord): ShareRecordView {
  return {
    workspaceId: record.workspaceId,
    capId: record.capId,
    roomId: record.roomId,
    scopeKind: record.scopeKind,
    relayUrl: record.relayUrl,
    publication: record.publication,
    createdAt: record.createdAt,
  };
}

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrowserStorageError(`${label} is required`);
  }
}

function requireRelay(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^https?:\/\//u.test(value)) {
    throw new BrowserStorageError('relayUrl must be an http(s) origin');
  }
}
