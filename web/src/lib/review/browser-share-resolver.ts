/** Crypto-agnostic durable-share resolution with persistent rollback fencing. */

export type DurableShareTier = 'view' | 'comment' | 'suggest';
export type DurableShareDocType = 'markdown' | 'html';

const PROTOCOL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BUNDLE_ID = /^[A-Za-z0-9_-]{22}$/u;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/u;
const MAX_SNAPSHOT_FILES = 64;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SHARE_SNAPSHOT_BYTES = 25 * 1024 * 1024;
const MAX_SEALED_BUNDLE_BYTES = 64 * 1024;

export interface DurableShareSnapshotRef {
  fileId: string;
  snapshotId: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  uploadedAt: number;
}

/** Normalized authenticated relay response. Adapters must decode sealed bytes canonically. */
export interface DurableShareRecord {
  v: 3;
  shareId: string;
  bundleId: string;
  epoch: number;
  revision: number;
  currentRoomId?: string;
  snapshots: unknown;
  /** Ownership transfers to resolve(); adapters must return fresh bytes per call. */
  selectedBundle: Uint8Array;
  updatedAt: number;
  expiresAt: number;
}

/** Strict plaintext returned by the injected capability-bundle decoder. */
export interface DecodedDurableShareBundle {
  v: 3;
  shareId: string;
  bundleId: string;
  epoch: number;
  revision: number;
  manifestDigest: string;
  roomId: string;
  tier: DurableShareTier;
  roomCapability: unknown;
  shareMailboxCapability?: unknown;
}

export interface DurableShareSnapshot {
  fileId: string;
  snapshotId: string;
  docType: DurableShareDocType;
  content: string;
  metadata?: unknown;
}

export interface SnapshotCiphertext {
  ciphertext: Uint8Array;
  ciphertextSha256: string;
}

export interface DurableRollbackValue {
  epoch: number;
  revision: number;
  manifestDigest: string;
}

/**
 * Implementations must atomically retain the lexicographic max(epoch,revision).
 * Equal epoch+revision with a different digest must retain the existing value.
 * The returned value is the durable value after the transaction.
 */
export interface DurableShareRollbackFloor {
  atomicMax(input: {
    shareId: string;
    bundleId: string;
    candidate: DurableRollbackValue;
  }): Promise<DurableRollbackValue>;
}

export interface ResolvedDurableShare {
  record: {
    v: 3;
    shareId: string;
    bundleId: string;
    epoch: number;
    revision: number;
    currentRoomId?: string;
    snapshots: DurableShareSnapshotRef[];
    updatedAt: number;
    expiresAt: number;
  };
  bundle: DecodedDurableShareBundle;
  snapshots: DurableShareSnapshot[];
  source: 'room' | 'share_snapshot';
}

export interface BrowserShareResolverOptions<TCapability = unknown> {
  shareId: string;
  capability: TCapability;
  rollbackFloor: DurableShareRollbackFloor;
  fetchRecord(input: {
    shareId: string;
    capability: TCapability;
    signal?: AbortSignal;
  }): Promise<DurableShareRecord>;
  decodeBundle(input: {
    shareId: string;
    bundleId: string;
    epoch: number;
    revision: number;
    sealedBundle: Uint8Array;
    capability: TCapability;
  }): Promise<DecodedDurableShareBundle> | DecodedDurableShareBundle;
  digestManifest(canonicalManifest: Uint8Array): Promise<string> | string;
  fetchSnapshot(input: {
    shareId: string;
    bundleId: string;
    epoch: number;
    ref: DurableShareSnapshotRef;
    capability: TCapability;
    signal?: AbortSignal;
  }): Promise<SnapshotCiphertext>;
  digestCiphertext(ciphertext: Uint8Array): Promise<string> | string;
  decryptSnapshot(input: {
    shareId: string;
    bundleId: string;
    epoch: number;
    bundle: DecodedDurableShareBundle;
    ref: DurableShareSnapshotRef;
    ciphertext: Uint8Array;
  }): Promise<DurableShareSnapshot> | DurableShareSnapshot;
  /** Zero imported keys or other decoder-owned values after rejection/disposal. */
  disposeBundle(bundle: DecodedDurableShareBundle): void;
  /** Dispose decrypted plaintext snapshots after rejection/session disposal. */
  disposeSnapshot(snapshot: DurableShareSnapshot): void;
}

export class BrowserShareResolutionError extends Error {
  constructor(
    readonly code:
      | 'record_invalid'
      | 'epoch_rollback'
      | 'manifest_rollback'
      | 'bundle_invalid'
      | 'manifest_invalid'
      | 'snapshot_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserShareResolutionError';
  }
}

export class BrowserShareResolver<TCapability = unknown> {
  private readonly options: BrowserShareResolverOptions<TCapability>;

  constructor(options: BrowserShareResolverOptions<TCapability>) {
    if (!PROTOCOL_ID.test(options.shareId)) throw new Error('shareId is not a protocol identifier');
    this.options = options;
  }

  async resolve(signal?: AbortSignal): Promise<ResolvedDurableShare> {
    const record = await this.options.fetchRecord({
      shareId: this.options.shareId,
      capability: this.options.capability,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      this.validateRecord(record);
    } catch (error) {
      if (record?.selectedBundle instanceof Uint8Array) record.selectedBundle.fill(0);
      throw error;
    }
    const sealedBundle = new Uint8Array(record.selectedBundle);
    if (sealedBundle.byteLength < 40 || sealedBundle.byteLength > MAX_SEALED_BUNDLE_BYTES) {
      sealedBundle.fill(0);
      record.selectedBundle.fill(0);
      throw new BrowserShareResolutionError('bundle_invalid', 'sealed capability bundle size is invalid');
    }
    let refs: DurableShareSnapshotRef[];
    let manifestDigest: string;
    let decoded: DecodedDurableShareBundle | null = null;
    try {
      refs = validateManifest(record.snapshots);
      const manifestBytes = canonicalManifestBytes(refs);
      try {
        manifestDigest = await this.options.digestManifest(manifestBytes);
      } finally {
        manifestBytes.fill(0);
      }
      if (!SHA256_BASE64URL.test(manifestDigest)) {
        throw new BrowserShareResolutionError('manifest_invalid', 'manifest digest is not canonical');
      }
      decoded = await this.options.decodeBundle({
        shareId: record.shareId,
        bundleId: record.bundleId,
        epoch: record.epoch,
        revision: record.revision,
        sealedBundle,
        capability: this.options.capability,
      });
    } finally {
      sealedBundle.fill(0);
      record.selectedBundle.fill(0);
    }
    const snapshots: DurableShareSnapshot[] = [];
    try {
      const bundle = validateAndConstructBundle(record, decoded, manifestDigest);
      const source = record.currentRoomId === bundle.roomId ? 'room' : 'share_snapshot';
      if (source === 'share_snapshot') {
        for (const ref of refs) snapshots.push(await this.resolveSnapshot(record, bundle, ref, signal));
      }
      const durable = await this.options.rollbackFloor.atomicMax({
        shareId: record.shareId,
        bundleId: record.bundleId,
        candidate: {
          epoch: record.epoch,
          revision: record.revision,
          manifestDigest,
        },
      });
      validateRollbackFloor(record, manifestDigest, durable);
      return {
        record: {
          v: 3,
          shareId: record.shareId,
          bundleId: record.bundleId,
          epoch: record.epoch,
          revision: record.revision,
          ...(record.currentRoomId === undefined ? {} : { currentRoomId: record.currentRoomId }),
          snapshots: refs,
          updatedAt: record.updatedAt,
          expiresAt: record.expiresAt,
        },
        bundle,
        snapshots,
        source,
      };
    } catch (error) {
      for (const snapshot of snapshots) {
        try { this.options.disposeSnapshot(snapshot); } catch { /* Preserve the validation error. */ }
      }
      if (decoded !== null) {
        try { this.options.disposeBundle(decoded); } catch { /* Preserve the validation error. */ }
      }
      throw error;
    }
  }

  private validateRecord(record: DurableShareRecord): void {
    const allowed = new Set([
      'v', 'shareId', 'bundleId', 'epoch', 'revision', 'currentRoomId', 'snapshots',
      'selectedBundle', 'updatedAt', 'expiresAt',
    ]);
    if (
      !isRecord(record) ||
      Object.keys(record).some((key) => !allowed.has(key)) ||
      record.v !== 3 ||
      record.shareId !== this.options.shareId ||
      !BUNDLE_ID.test(record.bundleId) ||
      !Number.isSafeInteger(record.epoch) || record.epoch < 0 ||
      !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      (record.currentRoomId !== undefined && !PROTOCOL_ID.test(record.currentRoomId)) ||
      !(record.selectedBundle instanceof Uint8Array) ||
      !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0 ||
      !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.updatedAt
    ) {
      throw new BrowserShareResolutionError('record_invalid', 'durable share record is invalid');
    }
  }

  private async resolveSnapshot(
    record: DurableShareRecord,
    bundle: DecodedDurableShareBundle,
    ref: DurableShareSnapshotRef,
    signal?: AbortSignal,
  ): Promise<DurableShareSnapshot> {
    const fetched = await this.options.fetchSnapshot({
      shareId: record.shareId,
      bundleId: record.bundleId,
      epoch: record.epoch,
      ref,
      capability: this.options.capability,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!(fetched.ciphertext instanceof Uint8Array)) {
      throw new BrowserShareResolutionError('snapshot_invalid', 'snapshot ciphertext is invalid');
    }
    try {
      if (
        fetched.ciphertext.byteLength !== ref.ciphertextBytes ||
        fetched.ciphertextSha256 !== ref.ciphertextSha256 ||
        (await this.options.digestCiphertext(fetched.ciphertext)) !== ref.ciphertextSha256
      ) {
        throw new BrowserShareResolutionError('snapshot_invalid', 'snapshot ciphertext digest mismatch');
      }
      const snapshot = await this.options.decryptSnapshot({
        shareId: record.shareId,
        bundleId: record.bundleId,
        epoch: record.epoch,
        bundle,
        ref,
        ciphertext: fetched.ciphertext,
      });
      try {
        if (
          snapshot.fileId !== ref.fileId || snapshot.snapshotId !== ref.snapshotId ||
          (snapshot.docType !== 'markdown' && snapshot.docType !== 'html') ||
          typeof snapshot.content !== 'string'
        ) {
          throw new BrowserShareResolutionError(
            'snapshot_invalid',
            'decrypted snapshot does not match its authenticated manifest reference',
          );
        }
        return snapshot;
      } catch (error) {
        try { this.options.disposeSnapshot(snapshot); } catch { /* Preserve the validation error. */ }
        throw error;
      }
    } finally {
      fetched.ciphertext.fill(0);
    }
  }
}

function validateAndConstructBundle(
  record: DurableShareRecord,
  value: DecodedDurableShareBundle,
  manifestDigest: string,
): DecodedDurableShareBundle {
  const allowed = new Set([
    'v', 'shareId', 'bundleId', 'epoch', 'revision', 'manifestDigest', 'roomId',
    'tier', 'roomCapability', 'shareMailboxCapability',
  ]);
  if (
    !isRecord(value) || Object.keys(value).some((key) => !allowed.has(key)) ||
    value.v !== 3 || value.shareId !== record.shareId || value.bundleId !== record.bundleId ||
    value.epoch !== record.epoch || value.revision !== record.revision ||
    value.manifestDigest !== manifestDigest || !PROTOCOL_ID.test(value.roomId) ||
    (value.tier !== 'view' && value.tier !== 'comment' && value.tier !== 'suggest') ||
    value.roomCapability == null ||
    (record.currentRoomId !== undefined && record.currentRoomId !== value.roomId) ||
    (value.tier === 'view' && value.shareMailboxCapability !== undefined) ||
    (value.tier !== 'view' && value.shareMailboxCapability == null)
  ) {
    throw new BrowserShareResolutionError(
      'bundle_invalid',
      'decoded capability bundle does not match the authenticated share record and manifest',
    );
  }
  return {
    v: 3,
    shareId: value.shareId,
    bundleId: value.bundleId,
    epoch: value.epoch,
    revision: value.revision,
    manifestDigest: value.manifestDigest,
    roomId: value.roomId,
    tier: value.tier,
    roomCapability: value.roomCapability,
    ...(value.shareMailboxCapability === undefined
      ? {}
      : { shareMailboxCapability: value.shareMailboxCapability }),
  };
}

function validateRollbackFloor(
  record: DurableShareRecord,
  manifestDigest: string,
  durable: DurableRollbackValue,
): void {
  if (
    !Number.isSafeInteger(durable.epoch) || !Number.isSafeInteger(durable.revision) ||
    !SHA256_BASE64URL.test(durable.manifestDigest)
  ) {
    throw new BrowserShareResolutionError('epoch_rollback', 'durable rollback floor is invalid');
  }
  if (durable.epoch > record.epoch) {
    throw new BrowserShareResolutionError('epoch_rollback', 'share epoch is older than durable state');
  }
  if (durable.epoch < record.epoch || (durable.epoch === record.epoch && durable.revision < record.revision)) {
    throw new BrowserShareResolutionError('epoch_rollback', 'durable rollback floor did not commit candidate');
  }
  if (durable.epoch === record.epoch && durable.revision > record.revision) {
    throw new BrowserShareResolutionError('manifest_rollback', 'share revision is older than durable state');
  }
  if (
    durable.epoch === record.epoch && durable.revision === record.revision &&
    durable.manifestDigest !== manifestDigest
  ) {
    throw new BrowserShareResolutionError('manifest_rollback', 'share manifest conflicts with durable state');
  }
}

function validateManifest(value: unknown): DurableShareSnapshotRef[] {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_FILES) {
    throw new BrowserShareResolutionError('manifest_invalid', 'share snapshot manifest is invalid');
  }
  const refs: DurableShareSnapshotRef[] = [];
  let bytes = 0;
  let previousFileId = '';
  const snapshotIds = new Set<string>();
  for (const raw of value) {
    const allowed = new Set(['fileId', 'snapshotId', 'ciphertextBytes', 'ciphertextSha256', 'uploadedAt']);
    if (!isRecord(raw) || Object.keys(raw).some((key) => !allowed.has(key))) {
      throw new BrowserShareResolutionError('manifest_invalid', 'snapshot manifest entry is invalid');
    }
    const { fileId, snapshotId, ciphertextBytes, ciphertextSha256, uploadedAt } = raw;
    if (
      typeof fileId !== 'string' || !PROTOCOL_ID.test(fileId) || fileId <= previousFileId ||
      typeof snapshotId !== 'string' || !PROTOCOL_ID.test(snapshotId) || snapshotIds.has(snapshotId) ||
      !Number.isSafeInteger(ciphertextBytes) || (ciphertextBytes as number) < 1 ||
      (ciphertextBytes as number) > MAX_SNAPSHOT_BYTES ||
      typeof ciphertextSha256 !== 'string' || !SHA256_BASE64URL.test(ciphertextSha256) ||
      !Number.isSafeInteger(uploadedAt) || (uploadedAt as number) < 0
    ) {
      throw new BrowserShareResolutionError('manifest_invalid', 'snapshot manifest entry is invalid');
    }
    bytes += ciphertextBytes as number;
    if (bytes > MAX_SHARE_SNAPSHOT_BYTES) {
      throw new BrowserShareResolutionError('manifest_invalid', 'snapshot manifest exceeds byte cap');
    }
    previousFileId = fileId;
    snapshotIds.add(snapshotId);
    refs.push({ fileId, snapshotId, ciphertextBytes: ciphertextBytes as number, ciphertextSha256, uploadedAt: uploadedAt as number });
  }
  return refs;
}

function canonicalManifestBytes(refs: DurableShareSnapshotRef[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(refs.map((ref) => ({
    fileId: ref.fileId,
    snapshotId: ref.snapshotId,
    ciphertextBytes: ref.ciphertextBytes,
    ciphertextSha256: ref.ciphertextSha256,
    uploadedAt: ref.uploadedAt,
  }))));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
