// Fenced cross-tab writer leases (attn-7xl.2.6).
//
// Exactly one tab may write a workspace at a time. Ownership is decided by
// IndexedDB readwrite transactions — the browser serializes them across tabs,
// so exactly one concurrent acquire can observe an absent/expired lease and
// claim it. Every takeover increments the fencing token; WorkspaceStore's
// mutation fencing (attn-7xl.2.3) rejects writes carrying a stale token, so
// a suspended tab that wakes up after losing its lease cannot corrupt state.
//
// BroadcastChannel is a courtesy doorbell only: it wakes other tabs to
// re-check the store, but it never decides correctness.

import { requestValue, transactionDone } from './browser-idb';
import { BrowserStorageError, StorageConflictError } from './browser-storage-errors';
import {
  STORE_WORKSPACE_LEASES,
  WORKSPACE_RECORD_VERSION,
  validateWorkspaceLeaseRecord,
  type WorkspaceLeaseRecord,
} from './browser-workspace-schema';
import type { WorkspaceFence } from './browser-workspace-store';

import { LEASE_CHANNEL_NAME } from '../tab-channels';

export { LEASE_CHANNEL_NAME };
const DEFAULT_LEASE_DURATION_MS = 15_000;
/** Reserved holder id marking a released lease. Keeping the tombstone (with
 * its token) makes fencing tokens monotonic across release/reacquire and
 * fences the releasing holder immediately. */
const RELEASED_HOLDER = '~released~';

export interface LeaseHandle extends WorkspaceFence {
  workspaceId: string;
  expiresAt: number;
}

export interface LeaseChannelMessage {
  workspaceId: string;
  event: 'acquired' | 'released';
  holderId: string;
  fencingToken: number;
}

/** Minimal BroadcastChannel surface, injectable for tests and absent APIs. */
export interface LeaseChannel {
  postMessage(message: LeaseChannelMessage): void;
  close(): void;
}

export interface WorkspaceLeaseManagerOptions {
  leaseDurationMs?: number;
  now?: () => number;
  channel?: LeaseChannel | null;
}

export class WorkspaceLeaseManager {
  private readonly db: IDBDatabase;
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly channel: LeaseChannel | null;

  constructor(db: IDBDatabase, options: WorkspaceLeaseManagerOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.channel = options.channel === undefined ? defaultChannel() : options.channel;
  }

  /**
   * Claim (or renew) single-writer ownership. Returns null when another
   * holder's unexpired lease exists — the caller stays a read-only tab.
   */
  async acquire(workspaceId: string, holderId: string): Promise<LeaseHandle | null> {
    requireId(workspaceId, 'workspaceId');
    requireId(holderId, 'holderId');
    const at = this.timestamp();
    const tx = this.db.transaction(STORE_WORKSPACE_LEASES, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_LEASES);
    const existing = await requestValue<WorkspaceLeaseRecord | undefined>(store.get(workspaceId));
    if (existing) validateWorkspaceLeaseRecord(existing);
    if (existing && existing.holderId !== holderId && existing.expiresAt > at) {
      await done;
      return null;
    }
    const sameHolder = existing?.holderId === holderId;
    const fencingToken = sameHolder ? existing!.fencingToken : (existing?.fencingToken ?? 0) + 1;
    const record: WorkspaceLeaseRecord = {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId,
      holderId,
      fencingToken,
      expiresAt: at + this.leaseDurationMs,
    };
    store.put(record);
    await done;
    this.notify({ workspaceId, event: 'acquired', holderId, fencingToken });
    return { workspaceId, holderId, fencingToken, expiresAt: record.expiresAt };
  }

  /** Extend an owned lease. Throws StorageConflictError once fenced off. */
  async heartbeat(handle: LeaseHandle): Promise<LeaseHandle> {
    requireId(handle.workspaceId, 'workspaceId');
    requireId(handle.holderId, 'holderId');
    const at = this.timestamp();
    const tx = this.db.transaction(STORE_WORKSPACE_LEASES, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_LEASES);
    const existing = await requestValue<WorkspaceLeaseRecord | undefined>(
      store.get(handle.workspaceId),
    );
    if (
      !existing ||
      existing.holderId !== handle.holderId ||
      existing.fencingToken !== handle.fencingToken
    ) {
      tx.abort();
      await done.catch(() => undefined);
      throw new StorageConflictError('lease was taken over by another tab');
    }
    const record: WorkspaceLeaseRecord = { ...existing, expiresAt: at + this.leaseDurationMs };
    store.put(record);
    await done;
    return { ...handle, expiresAt: record.expiresAt };
  }

  /** Release an owned lease; a lost lease is a quiet no-op. */
  async release(handle: LeaseHandle): Promise<boolean> {
    requireId(handle.workspaceId, 'workspaceId');
    const tx = this.db.transaction(STORE_WORKSPACE_LEASES, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_LEASES);
    const existing = await requestValue<WorkspaceLeaseRecord | undefined>(
      store.get(handle.workspaceId),
    );
    if (
      !existing ||
      existing.holderId !== handle.holderId ||
      existing.fencingToken !== handle.fencingToken
    ) {
      await done;
      return false;
    }
    store.put({
      v: WORKSPACE_RECORD_VERSION,
      workspaceId: handle.workspaceId,
      holderId: RELEASED_HOLDER,
      fencingToken: handle.fencingToken,
      expiresAt: 0,
    } satisfies WorkspaceLeaseRecord);
    await done;
    this.notify({
      workspaceId: handle.workspaceId,
      event: 'released',
      holderId: handle.holderId,
      fencingToken: handle.fencingToken,
    });
    return true;
  }

  /** Inspect the current lease record (expired records included). */
  async current(workspaceId: string): Promise<WorkspaceLeaseRecord | null> {
    requireId(workspaceId, 'workspaceId');
    const tx = this.db.transaction(STORE_WORKSPACE_LEASES, 'readonly');
    const done = transactionDone(tx);
    const record = await requestValue<WorkspaceLeaseRecord | undefined>(
      tx.objectStore(STORE_WORKSPACE_LEASES).get(workspaceId),
    );
    await done;
    if (!record) return null;
    validateWorkspaceLeaseRecord(record);
    return record;
  }

  close(): void {
    this.channel?.close();
  }

  private notify(message: LeaseChannelMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // Notifications are advisory; storage remains the source of truth.
    }
  }

  private timestamp(): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new BrowserStorageError('clock produced an invalid timestamp');
    }
    return at;
  }
}

function defaultChannel(): LeaseChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(LEASE_CHANNEL_NAME);
}

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrowserStorageError(`${label} is required`);
  }
}
