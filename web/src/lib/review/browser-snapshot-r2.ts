import {
  aeadSeal,
  aeadOpen,
  base64UrlDecode,
  buildAdmissionHeader,
  buildAdmissionHeaderV3,
  contentHash,
  randomAeadNonce,
  type EnvelopeAad,
} from './browser-crypto';
import { mintBrowserPowInWorker, type BrowserPowInputs } from './browser-pow';
import type { MailboxEnvelope } from './browser-ws';

const EMPTY_BODY = new Uint8Array(0);
const R2_BODY_OVERHEAD_BYTES = 24 + 16;

/**
 * Download capabilities currently have a five-minute relay TTL. Allow one
 * additional minute for clock skew while still rejecting long-lived or
 * attacker-supplied capabilities.
 */
export const MAX_R2_DOWNLOAD_EXPIRY_MS = 6 * 60 * 1_000;
export const MAX_R2_UPLOAD_EXPIRY_MS = 16 * 60 * 1_000;

export interface SealSnapshotR2BodyOptions {
  snapshotKey: Uint8Array;
  plaintext: Uint8Array;
  wrapper: MailboxEnvelope;
  /** Deterministic test override. Production callers must omit this. */
  nonce?: Uint8Array;
}

export type SnapshotUploadPowRequest = Omit<
  BrowserPowInputs,
  'expiresAt' | 'rand' | 'counterStart'
>;

export interface UploadBrowserR2SnapshotOptions {
  relayUrl: string;
  roomId: string;
  admissionKey: Uint8Array;
  envelopeId: string;
  authorId: string;
  deviceId: string;
  sealedBody: Uint8Array;
  powBits: number;
  fetchImpl?: typeof fetch;
  mintPow?: (input: SnapshotUploadPowRequest, signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  now?: () => number;
}

/** Seal `nonce || ciphertext || tag` using the wrapper's exact cleartext AAD. */
export function sealSnapshotR2Body(options: SealSnapshotR2BodyOptions): Uint8Array {
  if (!(options.snapshotKey instanceof Uint8Array) || options.snapshotKey.length !== 32) {
    throw new Error('snapshotKey must be 32 bytes');
  }
  if (!(options.plaintext instanceof Uint8Array)) throw new Error('plaintext must be Uint8Array');
  validateWrapper(options.wrapper);
  if (options.nonce !== undefined && options.nonce.length !== 24) {
    throw new Error('nonce must be 24 bytes');
  }
  const nonce = options.nonce ? new Uint8Array(options.nonce) : randomAeadNonce();
  let ciphertext: Uint8Array | null = null;
  try {
    ciphertext = aeadSeal(
      options.snapshotKey,
      nonce,
      options.plaintext,
      wrapperAad(options.wrapper.roomId!, options.wrapper),
    );
    const body = new Uint8Array(nonce.length + ciphertext.length);
    body.set(nonce, 0);
    body.set(ciphertext, nonce.length);
    return body;
  } finally {
    nonce.fill(0);
    ciphertext?.fill(0);
  }
}

/**
 * Authenticated native-compatible presign + same-origin capability PUT.
 * The capability is never returned, persisted, or included in an error.
 */
export async function uploadBrowserR2Snapshot(
  options: UploadBrowserR2SnapshotOptions,
): Promise<void> {
  validateUploadInputs(options);
  const relay = parseRelayOrigin(options.relayUrl);
  const path = `/v2/rooms/${encodeURIComponent(options.roomId)}/blobs`;
  const bodyJson = JSON.stringify({
    envelopeId: options.envelopeId,
    authorId: options.authorId,
    deviceId: options.deviceId,
    ciphertextBytes: options.sealedBody.length,
  });
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const signal = options.signal ?? new AbortController().signal;
  const mint =
    options.mintPow ??
    ((input: SnapshotUploadPowRequest, abortSignal: AbortSignal) =>
      mintBrowserPowInWorker(input, { signal: abortSignal }));
  const fetchImpl = options.fetchImpl ?? fetch;
  let presignResponse: Response;
  try {
    const pow = await mint(
      {
        roomId: options.roomId,
        deviceId: options.deviceId,
        method: 'POST',
        path,
        difficulty: options.powBits,
      },
      signal,
    );
    presignResponse = await fetchImpl(`${relay.origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'Attn-Admission': buildAdmissionHeader(options.admissionKey, 'POST', path, bodyBytes),
        'Attn-PoW': pow,
      },
      body: bodyJson,
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('R2 snapshot upload presign request failed');
  } finally {
    bodyBytes.fill(0);
  }
  if (presignResponse.status !== 200) {
    throw new Error(`R2 snapshot upload presign request failed (${presignResponse.status})`);
  }

  let value: unknown;
  try {
    value = await presignResponse.json();
  } catch {
    throw new Error('R2 snapshot upload presign response is invalid');
  }
  const uploadUrl = parsePresignedUpload(
    value,
    relay,
    options.roomId,
    options.envelopeId,
    options.now?.() ?? Date.now(),
  );
  const uploadBody = new Uint8Array(options.sealedBody);
  let uploadResponse: Response;
  try {
    uploadResponse = await fetchImpl(uploadUrl.href, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: uploadBody,
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('R2 snapshot upload failed');
  } finally {
    uploadBody.fill(0);
  }
  if (uploadResponse.status !== 204) {
    throw new Error(`R2 snapshot upload failed (${uploadResponse.status})`);
  }
}

export interface BrowserSnapshotSealedCache {
  getSealed(
    roomId: string,
    envelopeId: string,
  ): Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>;
  putSealed(
    roomId: string,
    envelopeId: string,
    sealedBody: Uint8Array,
  ): void | Promise<void>;
}

export interface ResolveBrowserR2SnapshotOptions {
  relayUrl: string;
  roomId: string;
  admissionKey: Uint8Array;
  protocolVersion?: 2 | 3;
  snapshotKey: Uint8Array;
  /** The exact encrypted `kind=snapshot_blob` mailbox wrapper. */
  wrapper: MailboxEnvelope;
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  sealedCache?: BrowserSnapshotSealedCache;
  /** Deterministic test hook. Production callers should omit it. */
  now?: () => number;
}

interface R2BlobRef {
  storage: 'r2';
  blobId: string;
  byteLength: number;
  contentHash: string;
}

interface PresignedDownload {
  downloadUrl: string;
  method: 'GET';
  expiresAt: number;
}

/**
 * Resolve a native-produced R2 snapshot wrapper to verified plaintext.
 *
 * Capability URLs remain confined to this function. They are never returned,
 * included in errors, or passed to persistence; an optional cache receives
 * only a defensive copy of the sealed `nonce || ciphertext || tag` bytes.
 */
export async function resolveBrowserR2Snapshot(
  options: ResolveBrowserR2SnapshotOptions,
): Promise<Uint8Array> {
  validateInputs(options);

  const relay = parseRelayOrigin(options.relayUrl);
  const path = blobPath(options.roomId, options.wrapper.envelopeId, options.protocolVersion ?? 2);
  const aad = wrapperAad(options.roomId, options.wrapper);
  const blobRef = openWrapperBlobRef(options.snapshotKey, options.wrapper, aad);

  let sealed: Uint8Array | null = null;
  let recovered: Uint8Array | null = null;
  try {
    const cached = await options.sealedCache?.getSealed(
      options.roomId,
      options.wrapper.envelopeId,
    );
    if (cached !== undefined && cached !== null) {
      if (!(cached instanceof Uint8Array)) {
        throw new Error('R2 snapshot cache returned an invalid sealed body');
      }
      // Never zero or return storage-owned memory.
      sealed = new Uint8Array(cached);
    } else {
      sealed = await fetchSealedBody(options, relay, path);
    }

    if (sealed.length !== blobRef.byteLength + R2_BODY_OVERHEAD_BYTES) {
      throw new Error('R2 snapshot failed integrity validation');
    }

    const nonce = sealed.subarray(0, 24);
    const ciphertext = sealed.subarray(24);
    try {
      recovered = aeadOpen(options.snapshotKey, nonce, ciphertext, aad);
    } catch {
      throw new Error('R2 snapshot failed integrity validation');
    }

    if (
      recovered.length !== blobRef.byteLength ||
      contentHash(recovered) !== blobRef.contentHash
    ) {
      recovered.fill(0);
      recovered = null;
      throw new Error('R2 snapshot failed integrity validation');
    }

    if (cached === undefined || cached === null) {
      // Cache only authenticated sealed bytes. The defensive copy lets the
      // local temporary be zeroed without corrupting storage-owned memory.
      try {
        await options.sealedCache?.putSealed(
          options.roomId,
          options.wrapper.envelopeId,
          new Uint8Array(sealed),
        );
      } catch {
        // A cache is an optimization. Verified content remains usable when
        // best-effort local persistence is unavailable.
      }
    }

    const result = recovered;
    recovered = null;
    return result;
  } finally {
    sealed?.fill(0);
    recovered?.fill(0);
  }
}

function validateInputs(options: ResolveBrowserR2SnapshotOptions): void {
  if (!(options.admissionKey instanceof Uint8Array) || options.admissionKey.length !== 32) {
    throw new Error('admissionKey must be 32 bytes');
  }
  if (!(options.snapshotKey instanceof Uint8Array) || options.snapshotKey.length !== 32) {
    throw new Error('snapshotKey must be 32 bytes');
  }
  if (typeof options.roomId !== 'string' || options.roomId.length === 0) {
    throw new Error('roomId is required');
  }
  if (typeof options.fetchImpl !== 'function') throw new Error('fetchImpl is required');

  const wrapper = options.wrapper;
  if (wrapper.v !== undefined && wrapper.v !== 2) {
    throw new Error('R2 snapshot wrapper has an unsupported version');
  }
  if (wrapper.roomId !== undefined && wrapper.roomId !== options.roomId) {
    throw new Error('R2 snapshot wrapper room mismatch');
  }
  if (wrapper.kind !== 'snapshot_blob') {
    throw new Error('R2 snapshot wrapper kind mismatch');
  }
  for (const value of [wrapper.envelopeId, wrapper.authorId, wrapper.deviceId]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('R2 snapshot wrapper metadata is invalid');
    }
  }
  if (!Number.isSafeInteger(wrapper.createdAt) || wrapper.createdAt < 0) {
    throw new Error('R2 snapshot wrapper metadata is invalid');
  }
  if (!Number.isSafeInteger(wrapper.ciphertextBytes) || wrapper.ciphertextBytes < 16) {
    throw new Error('R2 snapshot wrapper ciphertext length is invalid');
  }
}

function validateWrapper(wrapper: MailboxEnvelope): void {
  if (wrapper.v !== 2 || typeof wrapper.roomId !== 'string' || wrapper.roomId.length === 0) {
    throw new Error('R2 snapshot wrapper metadata is invalid');
  }
  if (wrapper.kind !== 'snapshot_blob') throw new Error('R2 snapshot wrapper kind mismatch');
  for (const value of [wrapper.envelopeId, wrapper.authorId, wrapper.deviceId]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('R2 snapshot wrapper metadata is invalid');
    }
  }
  if (!Number.isSafeInteger(wrapper.createdAt) || wrapper.createdAt < 0) {
    throw new Error('R2 snapshot wrapper metadata is invalid');
  }
}

function validateUploadInputs(options: UploadBrowserR2SnapshotOptions): void {
  if (!(options.admissionKey instanceof Uint8Array) || options.admissionKey.length !== 32) {
    throw new Error('admissionKey must be 32 bytes');
  }
  if (!(options.sealedBody instanceof Uint8Array) || options.sealedBody.length < R2_BODY_OVERHEAD_BYTES) {
    throw new Error('sealedBody must contain an R2 nonce and authentication tag');
  }
  for (const [label, value] of [
    ['roomId', options.roomId],
    ['envelopeId', options.envelopeId],
    ['authorId', options.authorId],
    ['deviceId', options.deviceId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  }
  if (!Number.isInteger(options.powBits) || options.powBits < 12 || options.powBits > 24) {
    throw new Error('powBits must be an integer in [12, 24]');
  }
}

function parseRelayOrigin(relayUrl: string): URL {
  let relay: URL;
  try {
    relay = new URL(relayUrl);
  } catch {
    throw new Error('relayUrl must be an absolute HTTP(S) origin');
  }
  if (
    (relay.protocol !== 'https:' && relay.protocol !== 'http:') ||
    relay.username !== '' ||
    relay.password !== '' ||
    relay.pathname !== '/' ||
    relay.search !== '' ||
    relay.hash !== ''
  ) {
    throw new Error('relayUrl must be an absolute HTTP(S) origin');
  }
  return relay;
}

function parsePresignedUpload(
  value: unknown,
  relay: URL,
  roomId: string,
  envelopeId: string,
  now: number,
): URL {
  if (!isPlainRecord(value)) throw new Error('R2 snapshot upload presign response is invalid');
  const keys = Object.keys(value).sort();
  const expected = ['blobKey', 'expiresAt', 'headers', 'leaseId', 'method', 'uploadUrl'];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    typeof value.uploadUrl !== 'string' ||
    value.method !== 'PUT' ||
    !isPlainRecord(value.headers) ||
    Object.keys(value.headers).length !== 1 ||
    value.headers['Content-Type'] !== 'application/octet-stream' ||
    typeof value.blobKey !== 'string' ||
    value.blobKey.length === 0 ||
    typeof value.leaseId !== 'string' ||
    value.leaseId.length === 0 ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(now) ||
    (value.expiresAt as number) <= now ||
    (value.expiresAt as number) > now + MAX_R2_UPLOAD_EXPIRY_MS
  ) {
    throw new Error('R2 snapshot upload presign response is invalid');
  }
  let resolved: URL;
  try {
    resolved = new URL(value.uploadUrl, relay);
  } catch {
    throw new Error('R2 snapshot upload capability is invalid');
  }
  const expectedPath = blobPath(roomId, envelopeId, 2);
  const caps = resolved.searchParams.getAll('cap');
  const queryKeys = [...resolved.searchParams.keys()];
  if (
    resolved.origin !== relay.origin ||
    resolved.username !== '' ||
    resolved.password !== '' ||
    resolved.pathname !== expectedPath ||
    resolved.hash !== '' ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'cap' ||
    caps.length !== 1 ||
    caps[0] === ''
  ) {
    throw new Error('R2 snapshot upload capability is invalid');
  }
  return resolved;
}

function blobPath(roomId: string, envelopeId: string, version: 2 | 3): string {
  return `/v${version}/rooms/${encodeURIComponent(roomId)}/blobs/${encodeURIComponent(envelopeId)}`;
}

function wrapperAad(roomId: string, wrapper: MailboxEnvelope): EnvelopeAad {
  return {
    v: 2,
    roomId,
    envelopeId: wrapper.envelopeId,
    kind: 'snapshot_blob',
    authorId: wrapper.authorId,
    deviceId: wrapper.deviceId,
    createdAt: wrapper.createdAt,
  };
}

function openWrapperBlobRef(
  snapshotKey: Uint8Array,
  wrapper: MailboxEnvelope,
  aad: EnvelopeAad,
): R2BlobRef {
  let nonce: Uint8Array | null = null;
  let ciphertext: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    try {
      nonce = base64UrlDecode(wrapper.nonce);
      ciphertext = base64UrlDecode(wrapper.ciphertext);
    } catch {
      throw new Error('R2 snapshot wrapper is invalid');
    }
    if (nonce.length !== 24 || ciphertext.length !== wrapper.ciphertextBytes) {
      throw new Error('R2 snapshot wrapper is invalid');
    }
    try {
      plaintext = aeadOpen(snapshotKey, nonce, ciphertext, aad);
    } catch {
      throw new Error('R2 snapshot wrapper failed integrity validation');
    }
    return parseR2BlobRef(plaintext, wrapper.envelopeId);
  } finally {
    nonce?.fill(0);
    ciphertext?.fill(0);
    plaintext?.fill(0);
  }
}

function parseR2BlobRef(bytes: Uint8Array, envelopeId: string): R2BlobRef {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('R2 snapshot wrapper payload is invalid');
  }
  if (!isPlainRecord(value)) throw new Error('R2 snapshot wrapper payload is invalid');

  const keys = Object.keys(value).sort();
  const expected = ['blobId', 'byteLength', 'contentHash', 'storage'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('R2 snapshot wrapper payload is invalid');
  }
  if (
    value.storage !== 'r2' ||
    typeof value.blobId !== 'string' ||
    value.blobId !== envelopeId ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    typeof value.contentHash !== 'string'
  ) {
    throw new Error('R2 snapshot wrapper payload is invalid');
  }

  let hashBytes: Uint8Array;
  try {
    hashBytes = base64UrlDecode(value.contentHash);
  } catch {
    throw new Error('R2 snapshot wrapper payload is invalid');
  }
  try {
    if (hashBytes.length !== 32) throw new Error('R2 snapshot wrapper payload is invalid');
  } finally {
    hashBytes.fill(0);
  }

  return {
    storage: 'r2',
    blobId: value.blobId,
    byteLength: value.byteLength as number,
    contentHash: value.contentHash,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchSealedBody(
  options: ResolveBrowserR2SnapshotOptions,
  relay: URL,
  path: string,
): Promise<Uint8Array> {
  const admission = (options.protocolVersion ?? 2) === 3
    ? buildAdmissionHeaderV3(options.admissionKey, 'read', 'GET', path, EMPTY_BODY)
    : buildAdmissionHeader(options.admissionKey, 'GET', path, EMPTY_BODY);
  let presignResponse: Response;
  try {
    presignResponse = await options.fetchImpl(`${relay.origin}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Attn-Admission': admission,
      },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('R2 snapshot presign request failed');
  }
  if (presignResponse.status !== 200) {
    throw new Error(`R2 snapshot presign request failed (${presignResponse.status})`);
  }

  let value: unknown;
  try {
    value = await presignResponse.json();
  } catch {
    throw new Error('R2 snapshot presign response is invalid');
  }
  const presigned = parsePresignedDownload(value, options.now?.() ?? Date.now());
  const download = resolveDownloadUrl(presigned.downloadUrl, relay, path);

  let downloadResponse: Response;
  try {
    downloadResponse = await options.fetchImpl(download.href, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('R2 snapshot download failed');
  }
  if (downloadResponse.status !== 200) {
    throw new Error(`R2 snapshot download failed (${downloadResponse.status})`);
  }
  try {
    return new Uint8Array(await downloadResponse.arrayBuffer());
  } catch {
    throw new Error('R2 snapshot download body is invalid');
  }
}

function parsePresignedDownload(value: unknown, now: number): PresignedDownload {
  if (!isPlainRecord(value)) throw new Error('R2 snapshot presign response is invalid');
  const keys = Object.keys(value).sort();
  const expected = ['downloadUrl', 'expiresAt', 'method'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('R2 snapshot presign response is invalid');
  }
  if (
    typeof value.downloadUrl !== 'string' ||
    value.method !== 'GET' ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(now) ||
    (value.expiresAt as number) <= now ||
    (value.expiresAt as number) > now + MAX_R2_DOWNLOAD_EXPIRY_MS
  ) {
    throw new Error('R2 snapshot presign response is invalid');
  }
  return {
    downloadUrl: value.downloadUrl,
    method: 'GET',
    expiresAt: value.expiresAt as number,
  };
}

function resolveDownloadUrl(downloadUrl: string, relay: URL, path: string): URL {
  let resolved: URL;
  try {
    resolved = new URL(downloadUrl, relay);
  } catch {
    throw new Error('R2 snapshot download capability is invalid');
  }
  const caps = resolved.searchParams.getAll('cap');
  const queryKeys = [...resolved.searchParams.keys()];
  if (
    resolved.origin !== relay.origin ||
    resolved.username !== '' ||
    resolved.password !== '' ||
    resolved.pathname !== path ||
    resolved.hash !== '' ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'cap' ||
    caps.length !== 1 ||
    caps[0] === ''
  ) {
    throw new Error('R2 snapshot download capability is invalid');
  }
  return resolved;
}
