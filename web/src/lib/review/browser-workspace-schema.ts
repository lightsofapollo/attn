// Browser workspace storage v3 schema (attn-7xl.2.1).
//
// Record shapes, size caps, path rules, and runtime validation for the
// workspace stores added in schema version 3 of `attn-browser-review`
// (browser-storage.ts owns the version bump and store creation). Workspaces
// are folder-shaped and interoperate with native attn: nested Markdown plus
// arbitrary binary assets under normalized relative paths.
//
// Privacy split (product decision #8 + phase plan): workspace/file *metadata*
// (ids, names, relative paths, sizes, clocks) is plaintext IndexedDB;
// revision *bodies*, share capabilities, and recovery payloads are sealed
// (XChaCha20-Poly1305 under workspace-derived keys — sealing itself lands in
// attn-7xl.2.2). Store only already-sealed bytes in the sealed fields.

import { BrowserStorageError } from './browser-storage-errors';
import {
  EntryPathError,
  MAX_ENTRY_PATH_BYTES,
  MAX_ENTRY_PATH_SEGMENTS,
  normalizeEntryPath as normalizeEntryPathShared,
} from '../hosted/entry-path';

export { MAX_ENTRY_PATH_BYTES, MAX_ENTRY_PATH_SEGMENTS };

/** Bump when any workspace record shape changes; validators pin it. */
export const WORKSPACE_RECORD_VERSION = 1;

// ————— store names (created by browser-storage.ts migrate() at v3) —————

export const STORE_WORKSPACES = 'workspaces';
export const STORE_WORKSPACE_KEYS = 'workspace_keys';
export const STORE_WORKSPACE_ENTRIES = 'workspace_entries';
export const STORE_WORKSPACE_REVISIONS = 'workspace_revisions';
export const STORE_WORKSPACE_SHARE_CAPS = 'workspace_share_caps';
export const STORE_WORKSPACE_RECOVERY = 'workspace_recovery';
export const STORE_WORKSPACE_GC = 'workspace_gc';
export const STORE_WORKSPACE_LEASES = 'workspace_leases';

export const WORKSPACE_INDEX = 'by_workspace';
export const WORKSPACE_UPDATED_INDEX = 'by_updated';
export const REVISION_HISTORY_INDEX = 'by_workspace_path_clock';
export const GC_CREATED_INDEX = 'by_created';

// ————— size caps —————

export const MAX_WORKSPACE_NAME_BYTES = 256;
/** Sealed revision bodies at or under this stay inline in IndexedDB; larger
 * bodies use the OPFS tier (attn-7xl.2.4) or the IndexedDB blob fallback. */
export const MAX_INLINE_SEALED_BODY_BYTES = 512 * 1024;
/** Hard cap for any single plaintext body accepted by the storage layer. */
export const MAX_BODY_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES_PER_WORKSPACE = 4096;
export const MAX_SEALED_CAP_BYTES = 16 * 1024;
export const MAX_SEALED_RECOVERY_BYTES = 64 * 1024;

// ————— record shapes —————

export interface WorkspaceRecord {
  v: number;
  workspaceId: string;
  name: string;
  /** Per-workspace monotonic logical clock; every committed mutation bumps
   * it. Entry/revision ordering and lease fencing derive from this. */
  clock: number;
  createdAt: number;
  updatedAt: number;
  /** Result of the last navigator.storage.persist() observation. */
  storagePersisted: boolean;
  /** Currently selected entry (canonical path); cleared when it is deleted. */
  activePath?: string;
  /** Wall clock of the last successful export/backup of this workspace. */
  lastBackupAt?: number;
}

export type WorkspaceEntryKind = 'markdown' | 'asset';

export interface WorkspaceEntryRecord {
  v: number;
  workspaceId: string;
  /** Normalized relative path — the primary key with workspaceId. */
  path: string;
  kind: WorkspaceEntryKind;
  /** Declared/sniffed MIME type for assets; absent for Markdown. */
  mediaType?: string;
  /** Head revision; every live entry has one. */
  headRevisionId: string;
  /** Plaintext byte size of the head revision. */
  sizeBytes: number;
  /** Workspace clock value of the last mutation touching this entry. */
  clock: number;
  createdAt: number;
  updatedAt: number;
  /** Tombstone: set when deleted; kept until revision GC completes. */
  deletedAt?: number;
}

export type SealedBody =
  | {
      location: 'idb';
      /** 24-byte XChaCha20 nonce, base64url. */
      nonce: string;
      /** Sealed bytes (ciphertext + 16-byte tag), stored inline. */
      ciphertext: Uint8Array;
    }
  | {
      /** Large-body fallback when OPFS is unavailable or fails: the sealed
       * bytes live in the record without the inline cap. */
      location: 'idb-large';
      nonce: string;
      ciphertext: Uint8Array;
    }
  | {
      location: 'opfs';
      nonce: string;
      /** Length of the sealed OPFS object, for GC/quota accounting. */
      sealedBytes: number;
    };

export interface WorkspaceRevisionRecord {
  v: number;
  workspaceId: string;
  revisionId: string;
  path: string;
  /** Workspace clock at commit; unique per (workspaceId, path). */
  clock: number;
  createdAt: number;
  /** Plaintext byte length. */
  sizeBytes: number;
  /** base64url SHA-256 of the plaintext body (integrity + native interop). */
  bodyHash: string;
  body: SealedBody;
}

export type ShareScopeKind = 'workspace' | 'entries' | 'file';

export interface WorkspaceShareCapRecord {
  v: number;
  workspaceId: string;
  capId: string;
  /** Room this capability belongs to (routing metadata, plaintext). */
  roomId: string;
  scopeKind: ShareScopeKind;
  createdAt: number;
  /** Sealed capability payload (room secret wrapping, manifest, TTL). */
  nonce: string;
  ciphertext: string;
}

export interface WorkspaceRecoveryRecord {
  v: number;
  workspaceId: string;
  recoveryId: string;
  createdAt: number;
  /** Sealed recovery payload (e.g. room re-join material, export state). */
  nonce: string;
  ciphertext: string;
}

export type GcTargetKind = 'opfs-orphan' | 'revision' | 'workspace';

export interface WorkspaceGcRecord {
  v: number;
  gcId: string;
  kind: GcTargetKind;
  workspaceId: string;
  /** Opaque target: an OPFS path, revisionId, or workspaceId. */
  target: string;
  createdAt: number;
}

export interface WorkspaceLeaseRecord {
  v: number;
  workspaceId: string;
  /** Opaque per-tab holder id. */
  holderId: string;
  /** Monotonic fencing token; every takeover increments it. */
  fencingToken: number;
  /** Wall-clock lease expiry; holders heartbeat before it lapses. */
  expiresAt: number;
  /**
   * Per-JS-context nonce (never persisted by the page). A duplicated tab
   * copies sessionStorage — and with it the holder id — but can never share
   * this value, so a same-holder acquire from a different context is a
   * token-bumping takeover rather than a silent second writer.
   */
  contextId?: string;
}

// ————— path rules —————

/**
 * Canonical path normalization lives in src/lib/hosted/entry-path.ts (shared
 * with the app bundle, which must stay free of this module's graph). This
 * wrapper converts violations into storage errors.
 */
export function normalizeEntryPath(raw: string): string {
  try {
    return normalizeEntryPathShared(raw);
  } catch (error) {
    if (error instanceof EntryPathError) throw new BrowserStorageError(error.message);
    throw error;
  }
}

// ————— validation —————

function requireVersion(value: unknown): void {
  if (value !== WORKSPACE_RECORD_VERSION) {
    throw new BrowserStorageError('workspace record version is unsupported');
  }
}

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new BrowserStorageError(`${label} is required`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BrowserStorageError(`${label} must be a non-negative safe integer`);
  }
}

function requireClock(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BrowserStorageError(`${label} must be a non-negative safe integer`);
  }
}

function requireBase64Url(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new BrowserStorageError(`${label} must be base64url`);
  }
}

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new BrowserStorageError(`${label} must be an object`);
  }
}

export function validateWorkspaceRecord(value: unknown): asserts value is WorkspaceRecord {
  requireRecord(value, 'workspace record');
  const record = value as Partial<WorkspaceRecord>;
  requireVersion(record.v);
  requireId(record.workspaceId, 'workspaceId');
  if (
    typeof record.name !== 'string' ||
    record.name.length === 0 ||
    new TextEncoder().encode(record.name).length > MAX_WORKSPACE_NAME_BYTES
  ) {
    throw new BrowserStorageError(
      `workspace name must be 1..${MAX_WORKSPACE_NAME_BYTES} bytes`,
    );
  }
  requireClock(record.clock, 'workspace clock');
  requireTimestamp(record.createdAt, 'createdAt');
  requireTimestamp(record.updatedAt, 'updatedAt');
  if (typeof record.storagePersisted !== 'boolean') {
    throw new BrowserStorageError('storagePersisted must be a boolean');
  }
  if (record.activePath !== undefined) {
    if (typeof record.activePath !== 'string' || normalizeEntryPath(record.activePath) !== record.activePath) {
      throw new BrowserStorageError('activePath is not in canonical form');
    }
  }
  if (record.lastBackupAt !== undefined) requireTimestamp(record.lastBackupAt, 'lastBackupAt');
}

export function validateWorkspaceEntryRecord(
  value: unknown,
): asserts value is WorkspaceEntryRecord {
  requireRecord(value, 'workspace entry record');
  const record = value as Partial<WorkspaceEntryRecord>;
  requireVersion(record.v);
  requireId(record.workspaceId, 'workspaceId');
  if (typeof record.path !== 'string' || normalizeEntryPath(record.path) !== record.path) {
    throw new BrowserStorageError('entry path is not in canonical form');
  }
  if (record.kind !== 'markdown' && record.kind !== 'asset') {
    throw new BrowserStorageError('entry kind is invalid');
  }
  if (record.mediaType !== undefined) {
    if (record.kind !== 'asset') {
      throw new BrowserStorageError('mediaType is only valid for assets');
    }
    if (
      typeof record.mediaType !== 'string' ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(record.mediaType)
    ) {
      throw new BrowserStorageError('entry mediaType is invalid');
    }
  }
  requireId(record.headRevisionId, 'headRevisionId');
  if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0) {
    throw new BrowserStorageError('entry sizeBytes must be a non-negative safe integer');
  }
  if ((record.sizeBytes as number) > MAX_BODY_BYTES) {
    throw new BrowserStorageError('entry sizeBytes exceeds the body cap');
  }
  requireClock(record.clock, 'entry clock');
  requireTimestamp(record.createdAt, 'createdAt');
  requireTimestamp(record.updatedAt, 'updatedAt');
  if (record.deletedAt !== undefined) requireTimestamp(record.deletedAt, 'deletedAt');
}

export function validateSealedBody(value: unknown): asserts value is SealedBody {
  requireRecord(value, 'sealed body');
  const body = value as Partial<SealedBody> & { location?: unknown };
  requireBase64Url(body.nonce, 'sealed body nonce');
  if (body.location === 'idb' || body.location === 'idb-large') {
    const ciphertext = (body as { ciphertext?: unknown }).ciphertext;
    if (!(ciphertext instanceof Uint8Array) || ciphertext.length < 16) {
      throw new BrowserStorageError('inline sealed body must include an authentication tag');
    }
    if (body.location === 'idb' && ciphertext.length > MAX_INLINE_SEALED_BODY_BYTES) {
      throw new BrowserStorageError(
        `inline sealed body exceeds ${MAX_INLINE_SEALED_BODY_BYTES} bytes`,
      );
    }
    if (ciphertext.length > MAX_BODY_BYTES + 16) {
      throw new BrowserStorageError('sealed body exceeds the maximum size cap');
    }
    return;
  }
  if (body.location === 'opfs') {
    const sealedBytes = (body as { sealedBytes?: unknown }).sealedBytes;
    if (!Number.isSafeInteger(sealedBytes) || (sealedBytes as number) < 16) {
      throw new BrowserStorageError('opfs sealed body length is invalid');
    }
    return;
  }
  throw new BrowserStorageError('sealed body location is invalid');
}

export function validateWorkspaceRevisionRecord(
  value: unknown,
): asserts value is WorkspaceRevisionRecord {
  requireRecord(value, 'workspace revision record');
  const record = value as Partial<WorkspaceRevisionRecord>;
  requireVersion(record.v);
  requireId(record.workspaceId, 'workspaceId');
  requireId(record.revisionId, 'revisionId');
  if (typeof record.path !== 'string' || normalizeEntryPath(record.path) !== record.path) {
    throw new BrowserStorageError('revision path is not in canonical form');
  }
  requireClock(record.clock, 'revision clock');
  requireTimestamp(record.createdAt, 'createdAt');
  if (
    !Number.isSafeInteger(record.sizeBytes) ||
    (record.sizeBytes as number) < 0 ||
    (record.sizeBytes as number) > MAX_BODY_BYTES
  ) {
    throw new BrowserStorageError('revision sizeBytes is invalid');
  }
  requireBase64Url(record.bodyHash, 'bodyHash');
  validateSealedBody(record.body);
}

export function validateWorkspaceShareCapRecord(
  value: unknown,
): asserts value is WorkspaceShareCapRecord {
  requireRecord(value, 'workspace share capability record');
  const record = value as Partial<WorkspaceShareCapRecord>;
  requireVersion(record.v);
  requireId(record.workspaceId, 'workspaceId');
  requireId(record.capId, 'capId');
  requireId(record.roomId, 'roomId');
  if (
    record.scopeKind !== 'workspace' &&
    record.scopeKind !== 'entries' &&
    record.scopeKind !== 'file'
  ) {
    throw new BrowserStorageError('share capability scope is invalid');
  }
  requireTimestamp(record.createdAt, 'createdAt');
  requireBase64Url(record.nonce, 'capability nonce');
  requireBase64Url(record.ciphertext, 'capability ciphertext');
  if (record.ciphertext.length > MAX_SEALED_CAP_BYTES * 2) {
    throw new BrowserStorageError('sealed capability exceeds its size cap');
  }
}

export function validateWorkspaceRecoveryRecord(
  value: unknown,
): asserts value is WorkspaceRecoveryRecord {
  requireRecord(value, 'workspace recovery record');
  const record = value as Partial<WorkspaceRecoveryRecord>;
  requireVersion(record.v);
  requireId(record.workspaceId, 'workspaceId');
  requireId(record.recoveryId, 'recoveryId');
  requireTimestamp(record.createdAt, 'createdAt');
  requireBase64Url(record.nonce, 'recovery nonce');
  requireBase64Url(record.ciphertext, 'recovery ciphertext');
  if (record.ciphertext.length > MAX_SEALED_RECOVERY_BYTES * 2) {
    throw new BrowserStorageError('sealed recovery record exceeds its size cap');
  }
}

export function validateWorkspaceGcRecord(value: unknown): asserts value is WorkspaceGcRecord {
  requireRecord(value, 'workspace gc record');
  const record = value as Partial<WorkspaceGcRecord>;
  requireVersion(record.v);
  requireId(record.gcId, 'gcId');
  if (record.kind !== 'opfs-orphan' && record.kind !== 'revision' && record.kind !== 'workspace') {
    throw new BrowserStorageError('gc target kind is invalid');
  }
  requireId(record.workspaceId, 'workspaceId');
  requireId(record.target, 'gc target');
  requireTimestamp(record.createdAt, 'createdAt');
}

export function validateWorkspaceLeaseRecord(
  value: unknown,
): asserts value is WorkspaceLeaseRecord {
  requireRecord(value, 'workspace lease record');
  const record = value as Partial<WorkspaceLeaseRecord>;
  requireVersion(record.v);
  requireId(record.workspaceId, 'workspaceId');
  requireId(record.holderId, 'holderId');
  if (!Number.isSafeInteger(record.fencingToken) || (record.fencingToken as number) < 1) {
    throw new BrowserStorageError('fencingToken must be a positive safe integer');
  }
  requireTimestamp(record.expiresAt, 'expiresAt');
  if (record.contextId !== undefined) requireId(record.contextId, 'contextId');
}
