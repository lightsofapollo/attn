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

import { LEASE_CHANNEL_NAME, openBroadcastChannel } from '../tab-channels';

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
  /**
   * 'handoff-request' is the seamless-editing doorbell (user feedback: the
   * "Another tab is editing" wall must never appear): a denied tab asks the
   * live holder to flush + release so the requester can acquire immediately
   * instead of waiting out the 15s expiry. Like every channel message it is
   * advisory — correctness stays with the IndexedDB record + fencing token.
   */
  event: 'acquired' | 'released' | 'handoff-request' | 'handoff-ack';
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
  /** Test seam. Production uses one nonce per JS context (page load). */
  contextId?: string;
}

/**
 * One nonce per JS context. sessionStorage-derived holder ids are copied when
 * a tab is duplicated, so holder identity alone cannot distinguish "same tab
 * after reload" from "live concurrent copy". This value is never persisted by
 * the page, so a copy can never present it.
 */
const JS_CONTEXT_ID = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `ctx-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
  }
})();

export class WorkspaceLeaseManager {
  private readonly db: IDBDatabase;
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly channel: LeaseChannel | null;
  private readonly contextId: string;

  constructor(db: IDBDatabase, options: WorkspaceLeaseManagerOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.channel = options.channel === undefined ? defaultChannel() : options.channel;
    this.contextId = options.contextId ?? JS_CONTEXT_ID;
  }

  /**
   * Claim (or renew) single-writer ownership. Returns null when another
   * holder's unexpired lease exists — the caller stays a read-only tab.
   */
  async acquire(workspaceId: string, holderId: string): Promise<LeaseHandle | null> {
    return this.claim(workspaceId, holderId, false);
  }

  /**
   * Forced claim for seamless handoff: takes the lease even while another
   * holder's record is unexpired. The token bump fences the previous
   * holder's in-flight writes, so this is always SAFE — the polite
   * handoff-request + grace period beforehand is about not discarding the
   * previous holder's un-flushed autosave, not about correctness.
   */
  async takeover(workspaceId: string, holderId: string): Promise<LeaseHandle> {
    const handle = await this.claim(workspaceId, holderId, true);
    if (!handle) throw new BrowserStorageError('forced lease takeover cannot be denied');
    return handle;
  }

  /** Ask the current holder (if any live tab) to flush + release. */
  requestHandoff(workspaceId: string, holderId: string): void {
    requireId(workspaceId, 'workspaceId');
    requireId(holderId, 'holderId');
    this.notify({ workspaceId, event: 'handoff-request', holderId, fencingToken: 0 });
  }

  /**
   * Holder's immediate answer to a handoff request: "yielding — hold on."
   * Requesters that hear this extend their polite grace instead of forcing
   * a takeover while the holder is still flushing (a big document's flush
   * can outlast a short grace, and forcing mid-flush fences the flush off
   * and loses the holder's final keystrokes).
   */
  acknowledgeHandoff(workspaceId: string, holderId: string): void {
    requireId(workspaceId, 'workspaceId');
    requireId(holderId, 'holderId');
    this.notify({ workspaceId, event: 'handoff-ack', holderId, fencingToken: 0 });
  }

  private async claim(
    workspaceId: string,
    holderId: string,
    force: boolean,
  ): Promise<LeaseHandle | null> {
    requireId(workspaceId, 'workspaceId');
    requireId(holderId, 'holderId');
    const at = this.timestamp();
    const tx = this.db.transaction(STORE_WORKSPACE_LEASES, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_WORKSPACE_LEASES);
    const existing = await requestValue<WorkspaceLeaseRecord | undefined>(store.get(workspaceId));
    if (existing) validateWorkspaceLeaseRecord(existing);
    if (!force && existing && existing.holderId !== holderId && existing.expiresAt > at) {
      await done;
      return null;
    }
    // "Same owner" requires the same JS context, not just the same holder id:
    // a duplicated tab inherits the holder id via copied sessionStorage. A
    // same-holder acquire from another context is a takeover — the token
    // bumps, so the other context's writes fence off instead of both tabs
    // writing under one valid token. A reload (old context gone) takes over
    // its own lease immediately the same way.
    const sameOwner = existing?.holderId === holderId && existing.contextId === this.contextId;
    const fencingToken = sameOwner ? existing!.fencingToken : (existing?.fencingToken ?? 0) + 1;
    const record: WorkspaceLeaseRecord = {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId,
      holderId,
      fencingToken,
      expiresAt: at + this.leaseDurationMs,
      contextId: this.contextId,
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
  return openBroadcastChannel(LEASE_CHANNEL_NAME);
}

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrowserStorageError(`${label} is required`);
  }
}
