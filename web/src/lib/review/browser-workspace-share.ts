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
import {
  STORE_WORKSPACE_SHARE_CAPS,
  WORKSPACE_INDEX,
  WORKSPACE_RECORD_VERSION,
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
}

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
      const parsed = JSON.parse(new TextDecoder().decode(opened)) as InviteCapability;
      if (parsed.v !== CAPABILITY_VERSION || typeof parsed.roomSecret !== 'string') {
        throw new BrowserStorageError('sealed capability has an invalid schema');
      }
      // Sanity-check the secret decodes to 32 bytes without keeping it here.
      if (base64UrlDecode(parsed.roomSecret).length !== 32) {
        throw new BrowserStorageError('sealed room secret is not 32 bytes');
      }
      return parsed;
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
    const next: StoredShareRecord = { ...record, publication };
    store.put(next);
    await done;
    return toView(next);
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
  };
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
