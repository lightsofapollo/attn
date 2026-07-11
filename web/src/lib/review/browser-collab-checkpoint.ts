// Transport-neutral durable checkpoint shape for browser owner authority.
//
// The storage layer deliberately knows nothing about ProseMirror. Callers
// serialize the authority's full step log to JSON values; this module only
// enforces a bounded, versioned shape before those bytes are sealed under the
// workspace recovery key. The authority document is deliberately omitted:
// replaying the full log against the authenticated base reconstructs it and
// avoids a second consistency surface inside the 64 KiB recovery budget.

import { base64UrlDecode, base64UrlEncode, toCanonicalBytes } from './browser-crypto';
import { BrowserStorageError } from './browser-storage-errors';
import { MAX_SEALED_RECOVERY_BYTES } from './browser-workspace-schema';

export const COLLAB_CHECKPOINT_VERSION = 1;
export const COLLAB_CHECKPOINT_KIND = 'collab_authority_checkpoint';
export const COLLAB_CHECKPOINT_RECOVERY_PREFIX = 'collab-checkpoint:';
export const MAX_COLLAB_CHECKPOINT_STEPS = 4_096;
export const MAX_COLLAB_CHECKPOINT_JSON_DEPTH = 64;
export const MAX_COLLAB_CHECKPOINT_JSON_NODES = 32_768;
/** XChaCha20-Poly1305 adds a 16-byte tag to the sealed plaintext. */
export const MAX_COLLAB_CHECKPOINT_PLAINTEXT_BYTES = MAX_SEALED_RECOVERY_BYTES - 16;

export type CollabCheckpointJson =
  | null
  | boolean
  | number
  | string
  | CollabCheckpointJson[]
  | { [key: string]: CollabCheckpointJson };

export type CollabCheckpointBase = { kind: 'snapshot'; id: string };

export interface BrowserCollabCheckpoint {
  v: 1;
  kind: typeof COLLAB_CHECKPOINT_KIND;
  roomId: string;
  fileId: string;
  epoch: string;
  base: CollabCheckpointBase;
  /** Exact authority version represented by the full log below. */
  version: number;
  /** Full ordered step log from base version zero. */
  steps: CollabCheckpointJson[];
  /** One originating client id for every step. */
  clientIDs: Array<string | number>;
}

export function collabCheckpointRecoveryId(
  roomId: string,
  fileId: string,
  epoch: string,
): string {
  requireCanonicalId(roomId, 16, 'roomId');
  requireCanonicalId(fileId, 16, 'fileId');
  requireCanonicalId(epoch, 16, 'epoch');
  return `${COLLAB_CHECKPOINT_RECOVERY_PREFIX}${roomId}:${fileId}:${epoch}`;
}

export function isCollabCheckpointRecoveryId(recoveryId: string): boolean {
  return recoveryId.startsWith(COLLAB_CHECKPOINT_RECOVERY_PREFIX);
}

export function validateCollabCheckpointRoomId(roomId: string): void {
  requireCanonicalId(roomId, 16, 'roomId');
}

export function validateBrowserCollabCheckpoint(
  value: unknown,
): asserts value is BrowserCollabCheckpoint {
  requireRecord(value, 'collab checkpoint');
  requireExactKeys(value, [
    'v',
    'kind',
    'roomId',
    'fileId',
    'epoch',
    'base',
    'version',
    'steps',
    'clientIDs',
  ]);
  if (value.v !== COLLAB_CHECKPOINT_VERSION || value.kind !== COLLAB_CHECKPOINT_KIND) {
    throw new BrowserStorageError('collab checkpoint version or kind is unsupported');
  }
  requireCanonicalId(value.roomId, 16, 'roomId');
  requireCanonicalId(value.fileId, 16, 'fileId');
  requireCanonicalId(value.epoch, 16, 'epoch');
  validateBase(value.base);
  if (value.base.id !== value.epoch) {
    throw new BrowserStorageError('collab checkpoint base snapshot must equal its epoch');
  }
  if (
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0
  ) {
    throw new BrowserStorageError('collab checkpoint version counter is invalid');
  }
  const version = value.version as number;
  if (!Array.isArray(value.steps) || !Array.isArray(value.clientIDs)) {
    throw new BrowserStorageError('collab checkpoint log arrays are invalid');
  }
  if (
    value.steps.length > MAX_COLLAB_CHECKPOINT_STEPS ||
    value.clientIDs.length > MAX_COLLAB_CHECKPOINT_STEPS
  ) {
    throw new BrowserStorageError('collab checkpoint step count exceeds its bound');
  }
  if (
    value.steps.length !== value.clientIDs.length ||
    value.steps.length !== version
  ) {
    throw new BrowserStorageError('collab checkpoint version and log lengths disagree');
  }
  for (const clientID of value.clientIDs) validateClientId(clientID);

  const budget = { nodes: 0 };
  for (const step of value.steps) validateJson(step, 0, budget);

  let canonical: Uint8Array;
  try {
    canonical = toCanonicalBytes(value);
  } catch {
    throw new BrowserStorageError('collab checkpoint is not canonical JSON');
  }
  try {
    if (canonical.length > MAX_COLLAB_CHECKPOINT_PLAINTEXT_BYTES) {
      throw new BrowserStorageError('collab checkpoint exceeds its sealed size bound');
    }
  } finally {
    canonical.fill(0);
  }
}

export function encodeBrowserCollabCheckpoint(value: BrowserCollabCheckpoint): Uint8Array {
  validateBrowserCollabCheckpoint(value);
  return toCanonicalBytes(value);
}

export function decodeBrowserCollabCheckpoint(bytes: Uint8Array): BrowserCollabCheckpoint {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_COLLAB_CHECKPOINT_PLAINTEXT_BYTES) {
    throw new BrowserStorageError('collab checkpoint bytes exceed their bound');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BrowserStorageError('collab checkpoint is not valid UTF-8 JSON');
  }
  validateBrowserCollabCheckpoint(value);
  return value;
}

function validateBase(value: unknown): asserts value is CollabCheckpointBase {
  requireRecord(value, 'collab checkpoint base');
  requireExactKeys(value, ['kind', 'id']);
  if (value.kind !== 'snapshot') {
    throw new BrowserStorageError('collab checkpoint base kind is invalid');
  }
  requireCanonicalId(value.id, 16, 'base snapshot id');
}

function validateClientId(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BrowserStorageError('collab checkpoint client id is invalid');
    }
    return;
  }
  requireOpaqueId(value, 'collab checkpoint client id');
}

function validateJson(value: unknown, depth: number, budget: { nodes: number }): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_COLLAB_CHECKPOINT_JSON_NODES) {
    throw new BrowserStorageError('collab checkpoint JSON node count exceeds its bound');
  }
  if (depth > MAX_COLLAB_CHECKPOINT_JSON_DEPTH) {
    throw new BrowserStorageError('collab checkpoint JSON nesting exceeds its bound');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BrowserStorageError('collab checkpoint JSON contains a non-finite number');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1, budget);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (new TextEncoder().encode(key).length > 256) {
        throw new BrowserStorageError('collab checkpoint JSON key exceeds its bound');
      }
      validateJson(item, depth + 1, budget);
    }
    return;
  }
  throw new BrowserStorageError('collab checkpoint contains a non-JSON value');
}

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserStorageError(`${label} must be an object`);
  }
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new BrowserStorageError('collab checkpoint contains missing or extra fields');
  }
}

function requireOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new BrowserStorageError(`${label} is invalid`);
  const bytes = new TextEncoder().encode(value);
  if (bytes.length === 0 || bytes.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BrowserStorageError(`${label} is invalid`);
  }
}

function requireCanonicalId(
  value: unknown,
  byteLength: number,
  label: string,
): asserts value is string {
  if (typeof value !== 'string') throw new BrowserStorageError(`${label} is invalid`);
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(value);
  } catch {
    throw new BrowserStorageError(`${label} is not canonical base64url`);
  }
  try {
    if (decoded.length !== byteLength || base64UrlEncode(decoded) !== value) {
      throw new BrowserStorageError(`${label} must be ${byteLength} canonical bytes`);
    }
  } finally {
    decoded.fill(0);
  }
}
