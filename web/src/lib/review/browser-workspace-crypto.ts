// Workspace sealing crypto (attn-7xl.2.2).
//
// Local browser workspaces derive all sealing keys from a per-workspace
// non-extractable HKDF root generated on this device (unlike rooms, whose
// root arrives in an invite). Domain-separated subkeys seal revision bodies,
// wrapped room-invite capabilities, and recovery payloads with
// XChaCha20-Poly1305, binding routing metadata as AAD so records cannot be
// swapped between workspaces, paths, or rows without failing authentication.
//
// Zeroization contract: this module zeroes every transient subkey and buffer
// it allocates. Callers own their plaintext inputs and the plaintexts
// returned by open* — zero them as soon as they are consumed.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base64UrlDecode, base64UrlEncode, toCanonicalBytes } from './browser-crypto';
import { BrowserStorageError } from './browser-storage-errors';
import { WORKSPACE_RECORD_VERSION, type ShareScopeKind } from './browser-workspace-schema';

export const INFO_WORKSPACE_REVISION = new TextEncoder().encode('attn workspace revision v1');
export const INFO_WORKSPACE_CAPABILITY = new TextEncoder().encode('attn workspace capability v1');
export const INFO_WORKSPACE_RECOVERY = new TextEncoder().encode('attn workspace recovery v1');

const NONCE_BYTES = 24;
const TAG_BYTES = 16;

export interface SealedWorkspaceBytes {
  /** 24-byte XChaCha20 nonce, base64url. */
  nonce: string;
  /** ciphertext + 16-byte tag. */
  ciphertext: Uint8Array;
}

export interface RevisionAad {
  workspaceId: string;
  revisionId: string;
  path: string;
  clock: number;
  sizeBytes: number;
  bodyHash: string;
}

export interface CapabilityAad {
  workspaceId: string;
  capId: string;
  roomId: string;
  scopeKind: ShareScopeKind;
}

export interface RecoveryAad {
  workspaceId: string;
  recoveryId: string;
}

/** Generate a fresh non-extractable workspace HKDF root. The raw bytes never
 * leave this function. */
export async function generateWorkspaceRootKey(cryptoImpl: Crypto): Promise<CryptoKey> {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  try {
    return await cryptoImpl.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits']);
  } finally {
    bytes.fill(0);
  }
}

export function validateWorkspaceRootKey(key: CryptoKey): void {
  if (
    !key ||
    key.type !== 'secret' ||
    key.extractable ||
    key.algorithm.name !== 'HKDF' ||
    !key.usages.includes('deriveBits')
  ) {
    throw new BrowserStorageError('workspace root is not a non-extractable HKDF key');
  }
}

async function deriveSubkey(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  info: Uint8Array,
): Promise<Uint8Array> {
  validateWorkspaceRootKey(rootKey);
  const infoCopy = new Uint8Array(info.length);
  infoCopy.set(info);
  return new Uint8Array(
    await cryptoImpl.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: infoCopy.buffer },
      rootKey,
      256,
    ),
  );
}

/** Exposed for key-compatibility vectors; prefer the seal/open helpers. */
export async function deriveWorkspaceSubkey(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  info: Uint8Array,
): Promise<Uint8Array> {
  return deriveSubkey(cryptoImpl, rootKey, info);
}

function revisionAadBytes(meta: RevisionAad): Uint8Array {
  return toCanonicalBytes({
    bodyHash: meta.bodyHash,
    clock: meta.clock,
    path: meta.path,
    record: 'workspace_revision',
    revisionId: meta.revisionId,
    sizeBytes: meta.sizeBytes,
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: meta.workspaceId,
  });
}

function capabilityAadBytes(meta: CapabilityAad): Uint8Array {
  return toCanonicalBytes({
    capId: meta.capId,
    record: 'workspace_share_cap',
    roomId: meta.roomId,
    scopeKind: meta.scopeKind,
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: meta.workspaceId,
  });
}

function recoveryAadBytes(meta: RecoveryAad): Uint8Array {
  return toCanonicalBytes({
    record: 'workspace_recovery',
    recoveryId: meta.recoveryId,
    v: WORKSPACE_RECORD_VERSION,
    workspaceId: meta.workspaceId,
  });
}

async function sealWithInfo(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<SealedWorkspaceBytes> {
  const key = await deriveSubkey(cryptoImpl, rootKey, info);
  const nonce = new Uint8Array(NONCE_BYTES);
  cryptoImpl.getRandomValues(nonce);
  try {
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    return { nonce: base64UrlEncode(nonce), ciphertext };
  } finally {
    key.fill(0);
    nonce.fill(0);
    aad.fill(0);
  }
}

async function openWithInfo(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  info: Uint8Array,
  aad: Uint8Array,
  sealed: SealedWorkspaceBytes,
): Promise<Uint8Array> {
  if (!(sealed.ciphertext instanceof Uint8Array) || sealed.ciphertext.length < TAG_BYTES) {
    throw new BrowserStorageError('sealed workspace bytes are too short');
  }
  const key = await deriveSubkey(cryptoImpl, rootKey, info);
  let nonce: Uint8Array | null = null;
  try {
    nonce = base64UrlDecode(sealed.nonce);
    if (nonce.length !== NONCE_BYTES) {
      throw new BrowserStorageError('sealed workspace nonce is invalid');
    }
    return xchacha20poly1305(key, nonce, aad).decrypt(sealed.ciphertext);
  } catch (error) {
    if (error instanceof BrowserStorageError) throw error;
    throw new BrowserStorageError('sealed workspace bytes could not be authenticated');
  } finally {
    key.fill(0);
    nonce?.fill(0);
    aad.fill(0);
  }
}

export async function sealRevisionBody(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  meta: RevisionAad,
  plaintext: Uint8Array,
): Promise<SealedWorkspaceBytes> {
  return sealWithInfo(cryptoImpl, rootKey, INFO_WORKSPACE_REVISION, revisionAadBytes(meta), plaintext);
}

export async function openRevisionBody(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  meta: RevisionAad,
  sealed: SealedWorkspaceBytes,
): Promise<Uint8Array> {
  return openWithInfo(cryptoImpl, rootKey, INFO_WORKSPACE_REVISION, revisionAadBytes(meta), sealed);
}

/**
 * Wrap a room-invite capability payload (room secret + manifest + TTL) so
 * share state survives reload without ever storing the invite secret raw.
 */
export async function sealCapability(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  meta: CapabilityAad,
  plaintext: Uint8Array,
): Promise<{ nonce: string; ciphertext: string }> {
  const sealed = await sealWithInfo(
    cryptoImpl,
    rootKey,
    INFO_WORKSPACE_CAPABILITY,
    capabilityAadBytes(meta),
    plaintext,
  );
  try {
    return { nonce: sealed.nonce, ciphertext: base64UrlEncode(sealed.ciphertext) };
  } finally {
    sealed.ciphertext.fill(0);
  }
}

export async function openCapability(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  meta: CapabilityAad,
  sealed: { nonce: string; ciphertext: string },
): Promise<Uint8Array> {
  const ciphertext = decodeSealedString(sealed.ciphertext);
  try {
    return await openWithInfo(cryptoImpl, rootKey, INFO_WORKSPACE_CAPABILITY, capabilityAadBytes(meta), {
      nonce: sealed.nonce,
      ciphertext,
    });
  } finally {
    ciphertext.fill(0);
  }
}

export async function sealRecovery(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  meta: RecoveryAad,
  plaintext: Uint8Array,
): Promise<{ nonce: string; ciphertext: string }> {
  const sealed = await sealWithInfo(
    cryptoImpl,
    rootKey,
    INFO_WORKSPACE_RECOVERY,
    recoveryAadBytes(meta),
    plaintext,
  );
  try {
    return { nonce: sealed.nonce, ciphertext: base64UrlEncode(sealed.ciphertext) };
  } finally {
    sealed.ciphertext.fill(0);
  }
}

export async function openRecovery(
  cryptoImpl: Crypto,
  rootKey: CryptoKey,
  meta: RecoveryAad,
  sealed: { nonce: string; ciphertext: string },
): Promise<Uint8Array> {
  const ciphertext = decodeSealedString(sealed.ciphertext);
  try {
    return await openWithInfo(cryptoImpl, rootKey, INFO_WORKSPACE_RECOVERY, recoveryAadBytes(meta), {
      nonce: sealed.nonce,
      ciphertext,
    });
  } finally {
    ciphertext.fill(0);
  }
}

function decodeSealedString(value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(value);
  } catch {
    throw new BrowserStorageError('sealed workspace ciphertext must be base64url');
  }
  if (bytes.length < TAG_BYTES) {
    bytes.fill(0);
    throw new BrowserStorageError('sealed workspace bytes are too short');
  }
  return bytes;
}
