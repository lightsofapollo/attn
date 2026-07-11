// Atomic workspace/file transactions (attn-7xl.2.3).
//
// All mutations commit through single multi-store IndexedDB transactions so a
// crash at any point leaves either the previous committed state or the new
// one — never a torn write. WebCrypto cannot be awaited inside an IndexedDB
// transaction (it would auto-commit), so bodies are sealed *before* the write
// transaction against a snapshotted workspace clock; if the clock moved by
// commit time the operation re-seals and retries a bounded number of times.
//
// Invariants:
//   - per-workspace `clock` strictly increases with every committed mutation
//   - wall timestamps are clamped monotonic (never decrease within a record)
//   - revision history is immutable and unique per (workspaceId, path, clock)
//   - relative-path uniqueness is enforced by the entry store's primary key
//   - optional lease fencing rejects writes from stale holders (attn-7xl.2.6
//     owns the lease lifecycle; the fencing check lives here)
//   - deleting a workspace crypto-erases its root key FIRST, so interrupted
//     cleanup can never resurrect sealed content

import { sha256 } from '@noble/hashes/sha2.js';
import { base64UrlEncode } from './browser-crypto';
import { abortWith, isConstraintError, requestValue, transactionDone } from './browser-idb';
import { BrowserStorageError, StorageConflictError } from './browser-storage-errors';
import {
  openRevisionBody,
  sealRevisionBody,
  generateWorkspaceRootKey,
  validateWorkspaceRootKey,
} from './browser-workspace-crypto';
import {
  MAX_BODY_BYTES,
  MAX_ENTRIES_PER_WORKSPACE,
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
  normalizeEntryPath,
  validateWorkspaceEntryRecord,
  validateWorkspaceLeaseRecord,
  validateWorkspaceRecord,
  validateWorkspaceRevisionRecord,
  type WorkspaceEntryKind,
  type WorkspaceEntryRecord,
  type WorkspaceLeaseRecord,
  type WorkspaceRecord,
  type WorkspaceRevisionRecord,
} from './browser-workspace-schema';

const MAX_COMMIT_RETRIES = 8;
const MAX_CLOCK = Number.MAX_SAFE_INTEGER;

/** Fencing credentials from the cross-tab writer lease (attn-7xl.2.6). */
export interface WorkspaceFence {
  holderId: string;
  fencingToken: number;
}

export interface CommittedRevision {
  workspace: WorkspaceRecord;
  entry: WorkspaceEntryRecord;
  revision: WorkspaceRevisionRecord;
}

export interface CreateWorkspaceInput {
  workspaceId?: string;
  name: string;
  storagePersisted: boolean;
  entry: {
    path: string;
    kind: WorkspaceEntryKind;
    mediaType?: string;
    body: Uint8Array;
  };
}

export interface CreateEntryInput {
  workspaceId: string;
  path: string;
  kind: WorkspaceEntryKind;
  mediaType?: string;
  body: Uint8Array;
  revisionId?: string;
  fence?: WorkspaceFence;
}

export interface CommitRevisionInput {
  workspaceId: string;
  path: string;
  body: Uint8Array;
  revisionId?: string;
  /** Optimistic concurrency: reject if the head moved since it was read. */
  expectedHeadRevisionId?: string;
  fence?: WorkspaceFence;
}

export class WorkspaceStore {
  private readonly db: IDBDatabase;
  private readonly cryptoImpl: Crypto;
  private readonly now: () => number;

  constructor(db: IDBDatabase, cryptoImpl: Crypto, now: () => number) {
    this.db = db;
    this.cryptoImpl = cryptoImpl;
    this.now = now;
  }

  // ————— reads —————

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    requireId(workspaceId, 'workspaceId');
    const record = await this.getRaw<WorkspaceRecord>(STORE_WORKSPACES, workspaceId);
    if (!record) return null;
    validateWorkspaceRecord(record);
    return record;
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const tx = this.db.transaction(STORE_WORKSPACES, 'readonly');
    const done = transactionDone(tx);
    const records = await requestValue<WorkspaceRecord[]>(
      tx.objectStore(STORE_WORKSPACES).getAll(),
    );
    await done;
    for (const record of records) validateWorkspaceRecord(record);
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getEntry(workspaceId: string, path: string): Promise<WorkspaceEntryRecord | null> {
    requireId(workspaceId, 'workspaceId');
    const canonical = normalizeEntryPath(path);
    const record = await this.getRaw<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [
      workspaceId,
      canonical,
    ]);
    if (!record) return null;
    validateWorkspaceEntryRecord(record);
    return record.deletedAt === undefined ? record : null;
  }

  async listEntries(workspaceId: string): Promise<WorkspaceEntryRecord[]> {
    requireId(workspaceId, 'workspaceId');
    const tx = this.db.transaction(STORE_WORKSPACE_ENTRIES, 'readonly');
    const done = transactionDone(tx);
    const records = await requestValue<WorkspaceEntryRecord[]>(
      tx
        .objectStore(STORE_WORKSPACE_ENTRIES)
        .index(WORKSPACE_INDEX)
        .getAll(IDBKeyRange.only(workspaceId)),
    );
    await done;
    const live = records.filter((record) => {
      validateWorkspaceEntryRecord(record);
      return record.deletedAt === undefined;
    });
    return live.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async listRevisions(workspaceId: string, path: string): Promise<WorkspaceRevisionRecord[]> {
    requireId(workspaceId, 'workspaceId');
    const canonical = normalizeEntryPath(path);
    const tx = this.db.transaction(STORE_WORKSPACE_REVISIONS, 'readonly');
    const done = transactionDone(tx);
    const records = await requestValue<WorkspaceRevisionRecord[]>(
      tx
        .objectStore(STORE_WORKSPACE_REVISIONS)
        .index(REVISION_HISTORY_INDEX)
        .getAll(IDBKeyRange.bound([workspaceId, canonical, 0], [workspaceId, canonical, MAX_CLOCK])),
    );
    await done;
    for (const record of records) validateWorkspaceRevisionRecord(record);
    return records;
  }

  /** Unseal and return the head body. The caller owns (and should zero) it. */
  async getHeadBody(workspaceId: string, path: string): Promise<Uint8Array> {
    const entry = await this.getEntry(workspaceId, path);
    if (!entry) throw new BrowserStorageError(`entry does not exist: ${path}`);
    const revision = await this.getRaw<WorkspaceRevisionRecord>(STORE_WORKSPACE_REVISIONS, [
      workspaceId,
      entry.headRevisionId,
    ]);
    if (!revision) throw new BrowserStorageError('head revision record is missing');
    validateWorkspaceRevisionRecord(revision);
    return this.openBody(workspaceId, revision);
  }

  // ————— mutations —————

  async createWorkspace(input: CreateWorkspaceInput): Promise<CommittedRevision> {
    const workspaceId = input.workspaceId ?? this.generateId();
    requireId(workspaceId, 'workspaceId');
    requireName(input.name);
    const path = normalizeEntryPath(input.entry.path);
    requireBody(input.entry.body);

    if (await this.getRaw(STORE_WORKSPACES, workspaceId)) {
      throw new StorageConflictError('workspace already exists');
    }
    // A crash between key creation and the record transaction leaves an
    // orphan root key; retrying the same create reuses it.
    const rootKey = (await this.getRootKey(workspaceId)) ?? (await this.addRootKey(workspaceId));

    const at = this.timestamp(0);
    const clock = 1;
    const revisionId = this.generateId();
    const sealed = await this.seal(rootKey, {
      workspaceId,
      revisionId,
      path,
      clock,
      body: input.entry.body,
    });
    const workspace: WorkspaceRecord = {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId,
      name: input.name,
      clock,
      createdAt: at,
      updatedAt: at,
      storagePersisted: input.storagePersisted,
      activePath: path,
    };
    const entry: WorkspaceEntryRecord = {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId,
      path,
      kind: input.entry.kind,
      ...(input.entry.mediaType === undefined ? {} : { mediaType: input.entry.mediaType }),
      headRevisionId: revisionId,
      sizeBytes: input.entry.body.length,
      clock,
      createdAt: at,
      updatedAt: at,
    };
    const revision = sealed;

    const tx = this.db.transaction(
      [STORE_WORKSPACES, STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_REVISIONS],
      'readwrite',
    );
    const done = transactionDone(tx);
    tx.objectStore(STORE_WORKSPACES).add(workspace);
    tx.objectStore(STORE_WORKSPACE_ENTRIES).add(entry);
    tx.objectStore(STORE_WORKSPACE_REVISIONS).add(revision);
    try {
      await done;
    } catch (error) {
      if (isConstraintError(error)) {
        throw new StorageConflictError('workspace already exists');
      }
      throw error;
    }
    return { workspace, entry, revision };
  }

  async createEntry(input: CreateEntryInput): Promise<CommittedRevision> {
    requireId(input.workspaceId, 'workspaceId');
    const path = normalizeEntryPath(input.path);
    requireBody(input.body);
    return this.retryCommit(input.workspaceId, input.fence, async (workspace, rootKey) => {
      const existing = await this.getRaw<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [
        input.workspaceId,
        path,
      ]);
      if (existing && existing.deletedAt === undefined) {
        throw new StorageConflictError(`entry already exists: ${path}`);
      }
      const at = this.timestamp(workspace.updatedAt);
      const clock = workspace.clock + 1;
      const revisionId = input.revisionId ?? this.generateId();
      const revision = await this.seal(rootKey, {
        workspaceId: input.workspaceId,
        revisionId,
        path,
        clock,
        body: input.body,
      });
      const entry: WorkspaceEntryRecord = {
        v: WORKSPACE_RECORD_VERSION,
        workspaceId: input.workspaceId,
        path,
        kind: input.kind,
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
        headRevisionId: revisionId,
        sizeBytes: input.body.length,
        clock,
        createdAt: at,
        updatedAt: at,
      };
      const nextWorkspace: WorkspaceRecord = { ...workspace, clock, updatedAt: at };
      return {
        expectedClock: workspace.clock,
        apply: async (tx) => {
          const entries = tx.objectStore(STORE_WORKSPACE_ENTRIES);
          const current = await requestValue<WorkspaceEntryRecord | undefined>(
            entries.get([input.workspaceId, path]),
          );
          if (current && current.deletedAt === undefined) {
            throw new StorageConflictError(`entry already exists: ${path}`);
          }
          const liveCount = await requestValue<number>(
            entries.index(WORKSPACE_INDEX).count(IDBKeyRange.only(input.workspaceId)),
          );
          if (liveCount >= MAX_ENTRIES_PER_WORKSPACE) {
            throw new StorageConflictError('workspace entry cap reached');
          }
          entries.put(entry);
          tx.objectStore(STORE_WORKSPACE_REVISIONS).add(revision);
          tx.objectStore(STORE_WORKSPACES).put(nextWorkspace);
        },
        result: { workspace: nextWorkspace, entry, revision },
      };
    });
  }

  async commitRevision(input: CommitRevisionInput): Promise<CommittedRevision> {
    requireId(input.workspaceId, 'workspaceId');
    const path = normalizeEntryPath(input.path);
    requireBody(input.body);
    return this.retryCommit(input.workspaceId, input.fence, async (workspace, rootKey) => {
      const entry = await this.getRaw<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [
        input.workspaceId,
        path,
      ]);
      if (!entry || entry.deletedAt !== undefined) {
        throw new BrowserStorageError(`entry does not exist: ${path}`);
      }
      validateWorkspaceEntryRecord(entry);
      if (
        input.expectedHeadRevisionId !== undefined &&
        entry.headRevisionId !== input.expectedHeadRevisionId
      ) {
        throw new StorageConflictError('head advanced past the expected revision');
      }
      // Idempotent replay: an identical revision id + content is a no-op.
      if (input.revisionId) {
        const prior = await this.getRaw<WorkspaceRevisionRecord>(STORE_WORKSPACE_REVISIONS, [
          input.workspaceId,
          input.revisionId,
        ]);
        if (prior) {
          validateWorkspaceRevisionRecord(prior);
          const sameContent =
            prior.path === path &&
            prior.sizeBytes === input.body.length &&
            prior.bodyHash === base64UrlEncode(sha256(input.body));
          if (!sameContent) {
            throw new StorageConflictError('revision id is already bound to different content');
          }
          return { replay: { workspace, entry, revision: prior } };
        }
      }
      const at = this.timestamp(workspace.updatedAt);
      const clock = workspace.clock + 1;
      const revisionId = input.revisionId ?? this.generateId();
      const revision = await this.seal(rootKey, {
        workspaceId: input.workspaceId,
        revisionId,
        path,
        clock,
        body: input.body,
      });
      const nextEntry: WorkspaceEntryRecord = {
        ...entry,
        headRevisionId: revisionId,
        sizeBytes: input.body.length,
        clock,
        updatedAt: at,
      };
      const nextWorkspace: WorkspaceRecord = { ...workspace, clock, updatedAt: at };
      return {
        expectedClock: workspace.clock,
        apply: async (tx) => {
          const current = await requestValue<WorkspaceEntryRecord | undefined>(
            tx.objectStore(STORE_WORKSPACE_ENTRIES).get([input.workspaceId, path]),
          );
          if (!current || current.deletedAt !== undefined) {
            throw new BrowserStorageError(`entry does not exist: ${path}`);
          }
          if (
            input.expectedHeadRevisionId !== undefined &&
            current.headRevisionId !== input.expectedHeadRevisionId
          ) {
            throw new StorageConflictError('head advanced past the expected revision');
          }
          tx.objectStore(STORE_WORKSPACE_REVISIONS).add(revision);
          tx.objectStore(STORE_WORKSPACE_ENTRIES).put(nextEntry);
          tx.objectStore(STORE_WORKSPACES).put(nextWorkspace);
        },
        result: { workspace: nextWorkspace, entry: nextEntry, revision },
      };
    });
  }

  async renameEntry(input: {
    workspaceId: string;
    fromPath: string;
    toPath: string;
    fence?: WorkspaceFence;
  }): Promise<CommittedRevision> {
    requireId(input.workspaceId, 'workspaceId');
    const fromPath = normalizeEntryPath(input.fromPath);
    const toPath = normalizeEntryPath(input.toPath);
    if (fromPath === toPath) throw new BrowserStorageError('rename requires a different path');
    return this.retryCommit(input.workspaceId, input.fence, async (workspace, rootKey) => {
      const entry = await this.getRaw<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [
        input.workspaceId,
        fromPath,
      ]);
      if (!entry || entry.deletedAt !== undefined) {
        throw new BrowserStorageError(`entry does not exist: ${fromPath}`);
      }
      validateWorkspaceEntryRecord(entry);
      const target = await this.getRaw<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [
        input.workspaceId,
        toPath,
      ]);
      if (target && target.deletedAt === undefined) {
        throw new StorageConflictError(`entry already exists: ${toPath}`);
      }
      const headRevision = await this.getRaw<WorkspaceRevisionRecord>(STORE_WORKSPACE_REVISIONS, [
        input.workspaceId,
        entry.headRevisionId,
      ]);
      if (!headRevision) throw new BrowserStorageError('head revision record is missing');
      validateWorkspaceRevisionRecord(headRevision);
      // The sealed body's AAD binds its path, so a rename re-seals the head
      // under the new path as a fresh immutable revision.
      const body = await this.openBody(input.workspaceId, headRevision);
      let revision: WorkspaceRevisionRecord;
      try {
        const at = this.timestamp(workspace.updatedAt);
        const clock = workspace.clock + 1;
        revision = await this.seal(rootKey, {
          workspaceId: input.workspaceId,
          revisionId: this.generateId(),
          path: toPath,
          clock,
          body,
        });
        const nextEntry: WorkspaceEntryRecord = {
          ...entry,
          path: toPath,
          headRevisionId: revision.revisionId,
          clock,
          updatedAt: at,
        };
        const nextWorkspace: WorkspaceRecord = {
          ...workspace,
          clock,
          updatedAt: at,
          ...(workspace.activePath === fromPath ? { activePath: toPath } : {}),
        };
        return {
          expectedClock: workspace.clock,
          apply: async (tx) => {
            const entries = tx.objectStore(STORE_WORKSPACE_ENTRIES);
            const currentTarget = await requestValue<WorkspaceEntryRecord | undefined>(
              entries.get([input.workspaceId, toPath]),
            );
            if (currentTarget && currentTarget.deletedAt === undefined) {
              throw new StorageConflictError(`entry already exists: ${toPath}`);
            }
            entries.delete([input.workspaceId, fromPath]);
            entries.put(nextEntry);
            await this.retireRevisions(tx, input.workspaceId, fromPath);
            tx.objectStore(STORE_WORKSPACE_REVISIONS).add(revision);
            tx.objectStore(STORE_WORKSPACES).put(nextWorkspace);
          },
          result: { workspace: nextWorkspace, entry: nextEntry, revision },
        };
      } finally {
        body.fill(0);
      }
    });
  }

  async deleteEntry(input: {
    workspaceId: string;
    path: string;
    fence?: WorkspaceFence;
  }): Promise<WorkspaceRecord> {
    requireId(input.workspaceId, 'workspaceId');
    const path = normalizeEntryPath(input.path);
    const committed = await this.retryCommit(
      input.workspaceId,
      input.fence,
      async (workspace) => {
        const entry = await this.getRaw<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [
          input.workspaceId,
          path,
        ]);
        if (!entry || entry.deletedAt !== undefined) {
          throw new BrowserStorageError(`entry does not exist: ${path}`);
        }
        const at = this.timestamp(workspace.updatedAt);
        const clock = workspace.clock + 1;
        const tombstone: WorkspaceEntryRecord = { ...entry, clock, updatedAt: at, deletedAt: at };
        const nextWorkspace: WorkspaceRecord = { ...workspace, clock, updatedAt: at };
        if (nextWorkspace.activePath === path) delete nextWorkspace.activePath;
        return {
          expectedClock: workspace.clock,
          apply: async (tx) => {
            tx.objectStore(STORE_WORKSPACE_ENTRIES).put(tombstone);
            await this.retireRevisions(tx, input.workspaceId, path);
            tx.objectStore(STORE_WORKSPACES).put(nextWorkspace);
          },
          result: { workspace: nextWorkspace, entry: tombstone, revision: undefined },
        };
      },
    );
    return committed.workspace;
  }

  async selectEntry(input: {
    workspaceId: string;
    path: string;
    fence?: WorkspaceFence;
  }): Promise<WorkspaceRecord> {
    requireId(input.workspaceId, 'workspaceId');
    const path = normalizeEntryPath(input.path);
    const committed = await this.retryCommit(
      input.workspaceId,
      input.fence,
      async (workspace) => {
        const entry = await this.getRaw<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [
          input.workspaceId,
          path,
        ]);
        if (!entry || entry.deletedAt !== undefined) {
          throw new BrowserStorageError(`entry does not exist: ${path}`);
        }
        const at = this.timestamp(workspace.updatedAt);
        const clock = workspace.clock + 1;
        const nextWorkspace: WorkspaceRecord = {
          ...workspace,
          clock,
          updatedAt: at,
          activePath: path,
        };
        return {
          expectedClock: workspace.clock,
          apply: (tx) => {
            tx.objectStore(STORE_WORKSPACES).put(nextWorkspace);
          },
          result: { workspace: nextWorkspace, entry, revision: undefined },
        };
      },
    );
    return committed.workspace;
  }

  /**
   * Crypto-erasure first: the root key dies in its own committed transaction
   * before any record cleanup, so interrupted cleanup leaves only opaque
   * ciphertext plus plaintext metadata that the next open can finish
   * removing.
   */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    requireId(workspaceId, 'workspaceId');
    const existing = await this.getRaw(STORE_WORKSPACES, workspaceId);
    const keyTx = this.db.transaction(STORE_WORKSPACE_KEYS, 'readwrite');
    const keyDone = transactionDone(keyTx);
    keyTx.objectStore(STORE_WORKSPACE_KEYS).delete(workspaceId);
    await keyDone;
    if (!existing) return false;

    const stores = [
      STORE_WORKSPACES,
      STORE_WORKSPACE_ENTRIES,
      STORE_WORKSPACE_REVISIONS,
      STORE_WORKSPACE_SHARE_CAPS,
      STORE_WORKSPACE_RECOVERY,
      STORE_WORKSPACE_LEASES,
      STORE_WORKSPACE_GC,
    ];
    const tx = this.db.transaction(stores, 'readwrite');
    const done = transactionDone(tx);
    await this.retireRevisions(tx, workspaceId, undefined);
    tx.objectStore(STORE_WORKSPACES).delete(workspaceId);
    tx.objectStore(STORE_WORKSPACE_LEASES).delete(workspaceId);
    for (const store of [
      STORE_WORKSPACE_ENTRIES,
      STORE_WORKSPACE_SHARE_CAPS,
      STORE_WORKSPACE_RECOVERY,
    ]) {
      const keys = await requestValue<IDBValidKey[]>(
        tx.objectStore(store).index(WORKSPACE_INDEX).getAllKeys(IDBKeyRange.only(workspaceId)),
      );
      for (const key of keys) tx.objectStore(store).delete(key);
    }
    await done;
    return true;
  }

  // ————— internals —————

  /** Read-seal-commit with bounded retries when the workspace clock moves. */
  private async retryCommit(
    workspaceId: string,
    fence: WorkspaceFence | undefined,
    prepare: (
      workspace: WorkspaceRecord,
      rootKey: CryptoKey,
    ) => Promise<
      | {
          expectedClock: number;
          apply: (tx: IDBTransaction) => Promise<void> | void;
          result: CommittedRevision | { workspace: WorkspaceRecord; entry: WorkspaceEntryRecord; revision: undefined };
        }
      | { replay: CommittedRevision }
    >,
  ): Promise<CommittedRevision> {
    const rootKey = await this.requireRootKey(workspaceId);
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const workspace = await this.getWorkspace(workspaceId);
      if (!workspace) throw new BrowserStorageError(`workspace does not exist: ${workspaceId}`);
      await this.checkFence(workspaceId, fence);
      const plan = await prepare(workspace, rootKey);
      if ('replay' in plan) return plan.replay;

      const tx = this.db.transaction(
        [
          STORE_WORKSPACES,
          STORE_WORKSPACE_ENTRIES,
          STORE_WORKSPACE_REVISIONS,
          STORE_WORKSPACE_GC,
          STORE_WORKSPACE_LEASES,
        ],
        'readwrite',
      );
      const done = transactionDone(tx);
      const current = await requestValue<WorkspaceRecord | undefined>(
        tx.objectStore(STORE_WORKSPACES).get(workspaceId),
      );
      if (!current || current.clock !== plan.expectedClock) {
        tx.abort();
        await done.catch(() => undefined);
        continue; // clock moved — re-read, re-seal, retry
      }
      if (fence) {
        const lease = await requestValue<WorkspaceLeaseRecord | undefined>(
          tx.objectStore(STORE_WORKSPACE_LEASES).get(workspaceId),
        );
        assertFence(lease, fence);
      }
      try {
        await plan.apply(tx);
      } catch (error) {
        await abortWith(tx, done, toStorageError(error));
      }
      try {
        await done;
      } catch (error) {
        if (isConstraintError(error)) {
          throw new StorageConflictError('workspace write conflicted with concurrent state');
        }
        throw error;
      }
      return plan.result as CommittedRevision;
    }
    throw new StorageConflictError('workspace commit kept losing clock races');
  }

  /** Delete revision records for one path (or all) and queue OPFS orphans. */
  private async retireRevisions(
    tx: IDBTransaction,
    workspaceId: string,
    path: string | undefined,
  ): Promise<void> {
    const revisions = tx.objectStore(STORE_WORKSPACE_REVISIONS);
    const range =
      path === undefined
        ? IDBKeyRange.only(workspaceId)
        : IDBKeyRange.bound([workspaceId, path, 0], [workspaceId, path, MAX_CLOCK]);
    const index =
      path === undefined ? revisions.index(WORKSPACE_INDEX) : revisions.index(REVISION_HISTORY_INDEX);
    const records = await requestValue<WorkspaceRevisionRecord[]>(index.getAll(range));
    const gc = tx.objectStore(STORE_WORKSPACE_GC);
    const createdAt = this.timestamp(0);
    for (const record of records) {
      revisions.delete([workspaceId, record.revisionId]);
      if (record.body.location === 'opfs') {
        gc.put({
          v: WORKSPACE_RECORD_VERSION,
          gcId: `opfs:${workspaceId}:${record.revisionId}`,
          kind: 'opfs-orphan',
          workspaceId,
          target: record.revisionId,
          createdAt,
        });
      }
    }
  }

  private async checkFence(workspaceId: string, fence: WorkspaceFence | undefined): Promise<void> {
    if (!fence) return;
    const lease = await this.getRaw<WorkspaceLeaseRecord>(STORE_WORKSPACE_LEASES, workspaceId);
    assertFence(lease ?? undefined, fence);
  }

  private async seal(
    rootKey: CryptoKey,
    input: {
      workspaceId: string;
      revisionId: string;
      path: string;
      clock: number;
      body: Uint8Array;
    },
  ): Promise<WorkspaceRevisionRecord> {
    const bodyHash = base64UrlEncode(sha256(input.body));
    const sealed = await sealRevisionBody(
      this.cryptoImpl,
      rootKey,
      {
        workspaceId: input.workspaceId,
        revisionId: input.revisionId,
        path: input.path,
        clock: input.clock,
        sizeBytes: input.body.length,
        bodyHash,
      },
      input.body,
    );
    return {
      v: WORKSPACE_RECORD_VERSION,
      workspaceId: input.workspaceId,
      revisionId: input.revisionId,
      path: input.path,
      clock: input.clock,
      createdAt: this.timestamp(0),
      sizeBytes: input.body.length,
      bodyHash,
      body: { location: 'idb', nonce: sealed.nonce, ciphertext: sealed.ciphertext },
    };
  }

  private async openBody(
    workspaceId: string,
    revision: WorkspaceRevisionRecord,
  ): Promise<Uint8Array> {
    if (revision.body.location !== 'idb') {
      // The OPFS large-body tier lands in attn-7xl.2.4.
      throw new BrowserStorageError('opfs revision bodies are not readable yet');
    }
    const rootKey = await this.requireRootKey(workspaceId);
    return openRevisionBody(
      this.cryptoImpl,
      rootKey,
      {
        workspaceId,
        revisionId: revision.revisionId,
        path: revision.path,
        clock: revision.clock,
        sizeBytes: revision.sizeBytes,
        bodyHash: revision.bodyHash,
      },
      { nonce: revision.body.nonce, ciphertext: revision.body.ciphertext },
    );
  }

  private async getRootKey(workspaceId: string): Promise<CryptoKey | null> {
    const record = await this.getRaw<{ rootKey: CryptoKey }>(STORE_WORKSPACE_KEYS, workspaceId);
    if (!record) return null;
    validateWorkspaceRootKey(record.rootKey);
    return record.rootKey;
  }

  private async requireRootKey(workspaceId: string): Promise<CryptoKey> {
    const key = await this.getRootKey(workspaceId);
    if (!key) throw new BrowserStorageError(`workspace key is unavailable: ${workspaceId}`);
    return key;
  }

  private async addRootKey(workspaceId: string): Promise<CryptoKey> {
    const rootKey = await generateWorkspaceRootKey(this.cryptoImpl);
    const tx = this.db.transaction(STORE_WORKSPACE_KEYS, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_WORKSPACE_KEYS).add({ workspaceId, rootKey });
    try {
      await done;
    } catch (error) {
      if (isConstraintError(error)) {
        const existing = await this.getRootKey(workspaceId);
        if (existing) return existing;
      }
      throw error;
    }
    return rootKey;
  }

  private async getRaw<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    const tx = this.db.transaction(storeName, 'readonly');
    const done = transactionDone(tx);
    const value = await requestValue<T | undefined>(tx.objectStore(storeName).get(key));
    await done;
    return value ?? null;
  }

  private generateId(): string {
    const bytes = new Uint8Array(16);
    this.cryptoImpl.getRandomValues(bytes);
    return base64UrlEncode(bytes);
  }

  /** Wall-clock timestamps never decrease relative to a floor. */
  private timestamp(floor: number): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new BrowserStorageError('clock produced an invalid timestamp');
    }
    return Math.max(at, floor);
  }
}

function assertFence(lease: WorkspaceLeaseRecord | undefined, fence: WorkspaceFence): void {
  if (!lease) throw new StorageConflictError('write requires an active lease');
  validateWorkspaceLeaseRecord(lease);
  if (lease.holderId !== fence.holderId || lease.fencingToken !== fence.fencingToken) {
    throw new StorageConflictError('write was fenced off by a newer lease');
  }
}

function toStorageError(error: unknown): BrowserStorageError {
  if (error instanceof BrowserStorageError) return error;
  return new BrowserStorageError(
    `workspace transaction failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrowserStorageError(`${label} is required`);
  }
}

function requireName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrowserStorageError('workspace name is required');
  }
}

function requireBody(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new BrowserStorageError('body must be a Uint8Array');
  }
  if (value.length > MAX_BODY_BYTES) {
    throw new BrowserStorageError('body exceeds the maximum size cap');
  }
}
