import { boundFetch } from './bound-fetch';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  base64UrlEncode,
  buildAdmissionHeaderV3,
  buildOwnerSignatureHeader,
  deriveShareLinkKeys,
  randomAeadNonce,
  toCanonicalBytes,
  type ShareLinkTier,
} from './browser-crypto';
import { mintBrowserPowInWorker, type BrowserPowInputs } from './browser-pow';
import { composeShareInvite, sealShareCapabilityBundle, type ShareCapabilityBundle } from './browser-share';
import { validateBrowserRelayUrl } from './browser-relay-url';
import type { BrowserDeviceIdentity } from './browser-session';

export const EMPTY_SHARE_MANIFEST_DIGEST = 'T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU';
export const DURABLE_SHARE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export interface ShareBundleMutation {
  bundleId: string;
  tier: ShareLinkTier;
  readAdmissionKey: string;
  writeAdmissionKey?: string;
  sealedBundle: string;
}

export interface ManagedShareSnapshotRef {
  fileId: string;
  snapshotId: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  uploadedAt: number;
}

export interface BrowserShareRelayRecord {
  v: 3;
  shareId: string;
  ownerSigningKey: string;
  epoch: number;
  revision: number;
  currentRoomId?: string;
  snapshots: ManagedShareSnapshotRef[];
  placeholders: unknown[];
  manifestDigest: string;
  updatedAt: number;
  expiresAt: number;
  mailbox: { count: number; bytes: number; latestSeq: number };
}

export interface BrowserShareMailboxItem {
  seq: number;
  envelopeId: string;
  bytes: number;
  payload: unknown;
  epoch: number;
  bundleId: string;
  tier: 'comment' | 'suggest';
}

export interface BrowserShareMailboxPage {
  items: BrowserShareMailboxItem[];
  nextAfter: number;
  bundle: { bundleId: string; tier: 'comment' | 'suggest'; sealedBundle: string };
}

export interface BrowserShareUpsertRequest {
  v: 3;
  ownerSigningKey: string;
  bundles: ShareBundleMutation[];
  epoch: number;
  revision: number;
  currentRoomId: string | null;
  snapshots: ManagedShareSnapshotRef[];
  placeholders: unknown[];
  deviceId: string;
}

export interface ShareTierInviteForms {
  tier: ShareLinkTier;
  browserUrl: string;
  nativeUrl: string;
  cliCommand: string;
}

export interface ShareTierInvites {
  view: ShareTierInviteForms;
  comment: ShareTierInviteForms;
  suggest: ShareTierInviteForms;
}

export interface ShareEpochBundleContext {
  shareId: string;
  shareSecret: Uint8Array;
  epoch: number;
  revision: number;
  manifestDigest: string;
  roomId: string;
  ownerSigningKey: string;
  readCapabilityKey: Uint8Array;
  writeAdmissionKey: Uint8Array;
  commentGrantSignature: string;
  suggestGrantSignature: string;
  randomBytes?: (length: number) => Uint8Array;
}

/** Seal all three stable sibling bearers to one exact epoch projection. */
export function buildShareBundleMutations(input: ShareEpochBundleContext): ShareBundleMutation[] {
  const random = input.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  return (['view', 'comment', 'suggest'] as const).map((tier) => {
    const keys = deriveShareLinkKeys(input.shareSecret, tier);
    try {
      const bundle: ShareCapabilityBundle = {
        v: 3,
        purpose: 'attn share capability bundle v3',
        bundleId: keys.bundleId,
        ownerSigningKey: input.ownerSigningKey,
        shareId: input.shareId,
        epoch: input.epoch,
        revision: input.revision,
        manifestDigest: input.manifestDigest,
        tier,
        roomId: input.roomId,
        readCapabilityKey: base64UrlEncode(input.readCapabilityKey),
        ...(tier === 'view'
          ? {}
          : {
              writeAdmissionKey: base64UrlEncode(input.writeAdmissionKey),
              grantSignature: tier === 'comment'
                ? input.commentGrantSignature
                : input.suggestGrantSignature,
            }),
      };
      const nonce = random(24);
      if (!(nonce instanceof Uint8Array) || nonce.length !== 24) {
        throw new Error('share bundle nonce source returned the wrong length');
      }
      try {
        return {
          bundleId: keys.bundleId,
          tier,
          readAdmissionKey: base64UrlEncode(keys.readAdmissionKey),
          ...(keys.writeAdmissionKey === undefined
            ? {}
            : { writeAdmissionKey: base64UrlEncode(keys.writeAdmissionKey) }),
          sealedBundle: sealShareCapabilityBundle(keys.bundleKey, keys.bundleId, bundle, nonce),
        };
      } finally {
        nonce.fill(0);
      }
    } finally {
      keys.linkSecret.fill(0);
      keys.bundleKey.fill(0);
      keys.readAdmissionKey.fill(0);
      keys.writeAdmissionKey?.fill(0);
    }
  });
}

/** Materialize public strings only while the Share sheet is open. */
export function composeShareTierInvites(
  shareId: string,
  shareSecret: Uint8Array,
  browserOrigin = 'https://attn.sh',
): ShareTierInvites {
  const result = {} as ShareTierInvites;
  for (const tier of ['view', 'comment', 'suggest'] as const) {
    const keys = deriveShareLinkKeys(shareSecret, tier);
    try {
      const nativeUrl = composeShareInvite(shareId, keys.linkSecret);
      const browserUrl = composeShareInvite(shareId, keys.linkSecret, browserOrigin);
      result[tier] = {
        tier,
        browserUrl,
        nativeUrl,
        cliCommand: `npx attnmd review join '${nativeUrl}'`,
      };
    } finally {
      keys.linkSecret.fill(0);
      keys.bundleKey.fill(0);
      keys.readAdmissionKey.fill(0);
      keys.writeAdmissionKey?.fill(0);
    }
  }
  return result;
}

export interface SealDurableSnapshotInput {
  shareId: string;
  epoch: number;
  fileId: string;
  snapshotId: string;
  docType: 'markdown' | 'html';
  content: string;
  metadata?: unknown;
  snapshotKey: Uint8Array;
  nonce?: Uint8Array;
}

/** Native-compatible nonce || XChaCha20-Poly1305 retained snapshot. */
export function sealDurableShareSnapshot(input: SealDurableSnapshotInput): Uint8Array {
  const nonce = input.nonce ? new Uint8Array(input.nonce) : randomAeadNonce();
  if (input.snapshotKey.length !== 32 || nonce.length !== 24) {
    nonce.fill(0);
    throw new Error('durable snapshot key or nonce length is invalid');
  }
  const aad = toCanonicalBytes({
    v: 3,
    purpose: 'attn durable share snapshot v3',
    shareId: input.shareId,
    epoch: input.epoch,
    fileId: input.fileId,
    snapshotId: input.snapshotId,
  });
  const plaintext = toCanonicalBytes({
    v: 3,
    fileId: input.fileId,
    snapshotId: input.snapshotId,
    docType: input.docType,
    content: input.content,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
  let ciphertext: Uint8Array | null = null;
  try {
    ciphertext = xchacha20poly1305(input.snapshotKey, nonce, aad).encrypt(plaintext);
    const sealed = new Uint8Array(nonce.length + ciphertext.length);
    sealed.set(nonce, 0);
    sealed.set(ciphertext, nonce.length);
    return sealed;
  } finally {
    nonce.fill(0);
    aad.fill(0);
    plaintext.fill(0);
    ciphertext?.fill(0);
  }
}

export function digestShareSnapshotManifest(refs: readonly ManagedShareSnapshotRef[]): string {
  const canonical = toCanonicalBytes([...refs]
    .sort((left, right) => left.fileId.localeCompare(right.fileId))
    .map((ref) => ({
      ciphertextBytes: ref.ciphertextBytes,
      ciphertextSha256: ref.ciphertextSha256,
      fileId: ref.fileId,
      snapshotId: ref.snapshotId,
      uploadedAt: ref.uploadedAt,
    })));
  try {
    return base64UrlEncode(sha256(canonical));
  } finally {
    canonical.fill(0);
  }
}

type OwnerPowRequest = Omit<BrowserPowInputs, 'expiresAt' | 'rand' | 'counterStart'>;

export interface BrowserShareOwnerRelayOptions {
  relayUrl: string;
  shareId: string;
  identity: BrowserDeviceIdentity;
  fetchImpl?: typeof fetch;
  mintPow?: (input: OwnerPowRequest, signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

export class BrowserShareOwnerRelayError extends Error {
  constructor(readonly status: number, operation: string) {
    super(`${operation} failed (${status})`);
    this.name = 'BrowserShareOwnerRelayError';
  }
}

/** Owner-only ShareDO transport. It never accepts or logs a public link secret. */
export class BrowserShareOwnerRelayClient {
  private readonly relay: string;
  private readonly fetchImpl: typeof fetch;
  private readonly mintPow: (input: OwnerPowRequest, signal: AbortSignal) => Promise<string>;
  private readonly signal: AbortSignal;

  constructor(private readonly options: BrowserShareOwnerRelayOptions) {
    this.relay = validateBrowserRelayUrl(options.relayUrl);
    this.fetchImpl = options.fetchImpl ?? boundFetch;
    this.mintPow = options.mintPow
      ?? ((input, signal) => mintBrowserPowInWorker(input, { signal }));
    this.signal = options.signal ?? new AbortController().signal;
  }

  async upsert(request: BrowserShareUpsertRequest): Promise<BrowserShareRelayRecord> {
    const body = JSON.stringify(request);
    const bodyBytes = new TextEncoder().encode(body);
    try {
      return await this.ownerJson('POST', this.sharePath(), bodyBytes, body);
    } finally {
      bodyBytes.fill(0);
    }
  }

  async fetchWithViewCapability(shareSecret: Uint8Array): Promise<BrowserShareRelayRecord> {
    const keys = deriveShareLinkKeys(shareSecret, 'view');
    const path = this.sharePath();
    try {
      const fetchImpl = this.fetchImpl;
      const response = await fetchImpl(`${this.relay}${path}`, {
        method: 'GET',
        headers: {
          'Attn-Share-Bundle': keys.bundleId,
          'Attn-Admission': buildAdmissionHeaderV3(
            keys.readAdmissionKey,
            'read',
            'GET',
            path,
            new Uint8Array(0),
          ),
        },
        signal: this.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      return await decodeRecord(response, this.options.shareId);
    } finally {
      keys.linkSecret.fill(0);
      keys.bundleKey.fill(0);
      keys.readAdmissionKey.fill(0);
      keys.writeAdmissionKey?.fill(0);
    }
  }

  async uploadSnapshot(
    fileId: string,
    snapshotId: string,
    ciphertext: Uint8Array,
  ): Promise<ManagedShareSnapshotRef> {
    const path = `${this.sharePath()}/snapshots/${encodeURIComponent(fileId)}/${encodeURIComponent(snapshotId)}`;
    const response = await this.ownerRequest('PUT', path, ciphertext, ciphertext);
    if (!response.ok) throw new BrowserShareOwnerRelayError(response.status, 'durable snapshot upload');
    const value = await response.json() as Partial<ManagedShareSnapshotRef>;
    return validateSnapshotRef(value);
  }

  async fetchMailbox(
    shareSecret: Uint8Array,
    tier: 'comment' | 'suggest',
    after: number,
  ): Promise<BrowserShareMailboxPage> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('mailbox cursor is invalid');
    const keys = deriveShareLinkKeys(shareSecret, tier);
    const path = `${this.sharePath()}/mailbox`;
    const query: Array<[string, string]> = [['after', String(after)], ['limit', '100']];
    try {
      const fetchImpl = this.fetchImpl;
      const response = await fetchImpl(`${this.relay}${path}?${new URLSearchParams(query)}`, {
        method: 'GET',
        headers: {
          'Attn-Share-Bundle': keys.bundleId,
          'Attn-Admission': buildAdmissionHeaderV3(
            keys.readAdmissionKey,
            'read',
            'GET',
            path,
            new Uint8Array(0),
            query,
          ),
        },
        signal: this.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new BrowserShareOwnerRelayError(response.status, 'durable mailbox fetch');
      return validateMailboxPage(await response.json(), keys.bundleId, tier, after);
    } finally {
      keys.linkSecret.fill(0);
      keys.bundleKey.fill(0);
      keys.readAdmissionKey.fill(0);
      keys.writeAdmissionKey?.fill(0);
    }
  }

  async ackMailbox(through: number): Promise<void> {
    if (!Number.isSafeInteger(through) || through < 0) throw new Error('mailbox ACK cursor is invalid');
    const query: Array<[string, string]> = [['through', String(through)]];
    const response = await this.ownerRequest(
      'DELETE',
      `${this.sharePath()}/mailbox`,
      new Uint8Array(0),
      undefined,
      query,
    );
    if (!response.ok) throw new BrowserShareOwnerRelayError(response.status, 'durable mailbox ACK');
  }

  async revoke(): Promise<void> {
    const response = await this.ownerRequest('DELETE', this.sharePath(), new Uint8Array(0));
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new BrowserShareOwnerRelayError(response.status, 'durable share revoke');
    }
  }

  private async ownerJson(
    method: 'POST',
    path: string,
    bytes: Uint8Array,
    body: string,
  ): Promise<BrowserShareRelayRecord> {
    const response = await this.ownerRequest(method, path, bytes, body);
    return decodeRecord(response, this.options.shareId);
  }

  private async ownerRequest(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    bytes: Uint8Array,
    body?: BodyInit | Uint8Array,
    query: Array<[string, string]> = [],
  ): Promise<Response> {
    const pow = await this.mintPow({
      roomId: this.options.shareId,
      deviceId: this.options.identity.deviceId,
      method,
      path,
      difficulty: 12,
    }, this.signal);
    const suffix = query.length === 0 ? '' : `?${new URLSearchParams(query)}`;
    const fetchImpl = this.fetchImpl;
    return fetchImpl(`${this.relay}${path}${suffix}`, {
      method,
      headers: {
        ...(body === undefined ? {} : {
          'content-type': method === 'PUT'
            ? 'application/octet-stream'
            : 'application/json; charset=utf-8',
        }),
        'Attn-Owner-Signature': buildOwnerSignatureHeader(
          this.options.identity.signingSecret,
          method,
          path,
          bytes,
          query,
        ),
        'Attn-PoW': pow,
        'Attn-Device-Id': this.options.identity.deviceId,
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof Uint8Array ? body.slice().buffer as ArrayBuffer : body }),
      signal: this.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  }

  private sharePath(): string {
    return `/v3/shares/${encodeURIComponent(this.options.shareId)}`;
  }
}

async function decodeRecord(response: Response, expectedShareId: string): Promise<BrowserShareRelayRecord> {
  if (!response.ok) throw new BrowserShareOwnerRelayError(response.status, 'durable share request');
  const value = await response.json() as Partial<BrowserShareRelayRecord>;
  if (
    value.v !== 3 || value.shareId !== expectedShareId || typeof value.ownerSigningKey !== 'string'
    || !Number.isSafeInteger(value.epoch) || !Number.isSafeInteger(value.revision)
    || !Array.isArray(value.snapshots) || !Array.isArray(value.placeholders)
    || typeof value.manifestDigest !== 'string' || !Number.isSafeInteger(value.updatedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || !isMailboxSummary(value.mailbox)
    || (value.currentRoomId !== undefined && typeof value.currentRoomId !== 'string')
  ) {
    throw new Error('durable share response is invalid');
  }
  const snapshots = value.snapshots.map(validateSnapshotRef);
  if (digestShareSnapshotManifest(snapshots) !== value.manifestDigest) {
    throw new Error('durable share manifest digest is invalid');
  }
  return { ...(value as BrowserShareRelayRecord), snapshots };
}

function isMailboxSummary(value: unknown): value is BrowserShareRelayRecord['mailbox'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const summary = value as Partial<BrowserShareRelayRecord['mailbox']>;
  return Number.isSafeInteger(summary.count) && (summary.count ?? -1) >= 0
    && Number.isSafeInteger(summary.bytes) && (summary.bytes ?? -1) >= 0
    && Number.isSafeInteger(summary.latestSeq) && (summary.latestSeq ?? -1) >= 0;
}

function validateMailboxPage(
  value: unknown,
  bundleId: string,
  tier: 'comment' | 'suggest',
  after: number,
): BrowserShareMailboxPage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('durable mailbox page is invalid');
  }
  const page = value as Partial<BrowserShareMailboxPage>;
  if (!Array.isArray(page.items) || !Number.isSafeInteger(page.nextAfter)
    || (page.nextAfter ?? -1) < after || typeof page.bundle !== 'object' || page.bundle === null
    || page.bundle.bundleId !== bundleId || page.bundle.tier !== tier
    || typeof page.bundle.sealedBundle !== 'string') {
    throw new Error('durable mailbox page is invalid');
  }
  const items = page.items.map((raw) => {
    const item = raw as Partial<BrowserShareMailboxItem>;
    if (!Number.isSafeInteger(item.seq) || (item.seq ?? 0) <= after
      || typeof item.envelopeId !== 'string' || !Number.isSafeInteger(item.bytes) || (item.bytes ?? 0) < 1
      || item.epoch === undefined || !Number.isSafeInteger(item.epoch)
      || item.bundleId !== bundleId || item.tier !== tier || item.payload === undefined) {
      throw new Error('durable mailbox item is invalid');
    }
    return item as BrowserShareMailboxItem;
  });
  if ((items.at(-1)?.seq ?? after) !== page.nextAfter) {
    throw new Error('durable mailbox cursor does not match its page');
  }
  return { items, nextAfter: page.nextAfter, bundle: page.bundle as BrowserShareMailboxPage['bundle'] };
}

function validateSnapshotRef(value: Partial<ManagedShareSnapshotRef>): ManagedShareSnapshotRef {
  if (
    typeof value.fileId !== 'string' || typeof value.snapshotId !== 'string'
    || !Number.isSafeInteger(value.ciphertextBytes) || (value.ciphertextBytes ?? 0) < 1
    || typeof value.ciphertextSha256 !== 'string' || !Number.isSafeInteger(value.uploadedAt)
  ) {
    throw new Error('durable share snapshot response is invalid');
  }
  return value as ManagedShareSnapshotRef;
}
