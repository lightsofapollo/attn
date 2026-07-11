// Accountless browser-owner durable sharing (attn-7xl.4.5).
//
// A workspace owns one stable ShareDO id and three sibling public bearers.
// The ordinary v3 room is an epoch-scoped implementation detail: it can be
// recreated without changing `/s/<shareId>#key=…` links.

import { ed25519 } from '@noble/curves/ed25519.js';
import type { AnchorIndex, Capability, RoomPolicy } from '../types';
import {
  base64UrlEncode,
  deriveRoomIdV3,
  deriveShareEpochRoomSecret,
} from './browser-crypto';
import { assembleBrowserEvent } from './browser-envelope';
import {
  createOwnedRoomV3,
  defaultOwnerPolicy,
  deleteOwnedRoom,
  deleteOwnedRoomV3,
  type CreateOwnedRoomOptions,
  type OwnedRoomBootstrap,
  type OwnedRoomBootstrapV3,
} from './browser-owner-bootstrap';
import { BrowserOutbox, type BrowserOutboxPersistence } from './browser-outbox';
import { validateBrowserRelayUrl } from './browser-relay-url';
import {
  canonicalDeviceGrantV3,
  generateBrowserIdentity,
  ownerCredentialsFromInviteCapability,
  ownerCredentialsV3FromInviteCapability,
  type BrowserOwnerCredentials,
  type BrowserOwnerCredentialsV3,
} from './browser-session';
import {
  publishBrowserSnapshots,
  resumeBrowserSnapshotPublication,
  type BrowserSnapshotEntry,
  type PublishBrowserSnapshotsOptions,
  type SnapshotPublicationOutbox,
} from './browser-snapshot-publisher';
import {
  BrowserShareOwnerRelayClient,
  BrowserShareOwnerRelayError,
  EMPTY_SHARE_MANIFEST_DIGEST,
  buildShareBundleMutations,
  composeShareTierInvites,
  sealDurableShareSnapshot,
  type BrowserShareOwnerRelayOptions,
  type BrowserShareRelayRecord,
  type BrowserShareUpsertRequest,
  type ManagedShareSnapshotRef,
  type ShareTierInvites,
} from './browser-share-owner';
import type { BrowserStorage } from './browser-storage';
import { BrowserStorageError, StorageConflictError } from './browser-storage-errors';
import {
  inviteCapabilityFrom,
  type DurableShareCapabilityState,
  type InviteCapability,
  type ShareRecordView,
} from './browser-workspace-share';
import { compareManifestPathsUtf8 } from './browser-workspace-manifest';
import { normalizeEntryPath, type ShareScopeKind } from './browser-workspace-schema';
import type { LeaseHandle } from './browser-workspace-lease';

export const BROWSER_SHARE_TTL_ONE_HOUR = 60 * 60 * 1000;
export const BROWSER_SHARE_TTL_ONE_DAY = 24 * BROWSER_SHARE_TTL_ONE_HOUR;
export const BROWSER_SHARE_TTL_SEVEN_DAYS = 7 * BROWSER_SHARE_TTL_ONE_DAY;

export type BrowserWorkspaceShareMode = RoomPolicy['mode'];
export type BrowserWorkspaceShareTtlMs =
  | typeof BROWSER_SHARE_TTL_ONE_HOUR
  | typeof BROWSER_SHARE_TTL_ONE_DAY
  | typeof BROWSER_SHARE_TTL_SEVEN_DAYS;

export interface BrowserWorkspaceShareRequest {
  relayUrl: string;
  browserReviewBase: string;
  scopeKind: ShareScopeKind;
  paths: readonly string[];
  mode?: BrowserWorkspaceShareMode;
  ttlMs?: BrowserWorkspaceShareTtlMs;
  ownerDisplayName?: string;
}

export interface BrowserWorkspaceShareView {
  workspaceId: string;
  capId: string;
  shareId: string;
  roomId: string;
  scopeKind: ShareScopeKind;
  paths: string[];
  publication: ShareRecordView['publication'];
  mode: BrowserWorkspaceShareMode;
  expiresAt: number;
  expired: boolean;
  resumable: boolean;
  invite: ShareTierInvites | null;
}

export interface BrowserWorkspaceShareOutbox extends SnapshotPublicationOutbox {
  initialize(): Promise<void>;
  close(): void;
}

export interface BrowserShareOwnerRelayPort {
  upsert(request: BrowserShareUpsertRequest): Promise<BrowserShareRelayRecord>;
  fetchWithViewCapability(shareSecret: Uint8Array): Promise<BrowserShareRelayRecord>;
  uploadSnapshot(fileId: string, snapshotId: string, ciphertext: Uint8Array): Promise<ManagedShareSnapshotRef>;
  deleteSnapshot(fileId: string): Promise<void>;
  revoke(): Promise<void>;
}

export interface BrowserWorkspaceSharingDependencies {
  createRoom?: (options: CreateOwnedRoomOptions) => Promise<OwnedRoomBootstrapV3 | OwnedRoomBootstrap>;
  deleteRoom?: typeof deleteOwnedRoomV3;
  publish?: (options: PublishBrowserSnapshotsOptions) => Promise<unknown>;
  shareRelayFactory?: (options: BrowserShareOwnerRelayOptions) => BrowserShareOwnerRelayPort;
  outboxFactory?: (input: {
    storage: BrowserStorage;
    relayUrl: string;
    credentials: BrowserOwnerCredentialsV3;
  }) => BrowserWorkspaceShareOutbox;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  indexBuilder?: (markdown: Uint8Array, snapshotId: string) => Promise<AnchorIndex>;
}

const OWNER_CAPABILITIES: Capability[] = [
  'room_admin', 'read_snapshot', 'write_comment', 'write_suggestion',
  'resolve_comment', 'accept_suggestion', 'publish_snapshot',
];

export class BrowserWorkspaceSharingCoordinator {
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(
    private readonly storage: BrowserStorage,
    private readonly workspaceId: string,
    private readonly fence: LeaseHandle,
    private readonly dependencies: BrowserWorkspaceSharingDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.randomBytes = dependencies.randomBytes
      ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  }

  async inspect(_browserReviewBase: string): Promise<BrowserWorkspaceShareView | null> {
    const record = await this.inspectRecord();
    return record ? this.view(record) : null;
  }

  async ensurePublished(request: BrowserWorkspaceShareRequest): Promise<BrowserWorkspaceShareView> {
    validateRequest(request);
    const relayUrl = validateBrowserRelayUrl(request.relayUrl);
    const rootKey = await this.requireRootKey();
    let record = await this.inspectRecord();

    if (record) {
      const capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
      if (!capability.durableShare) {
        // One-time migration from the checkpoint's v2 browser room. Retire it
        // authoritatively before minting the stable v3 share.
        const legacy = ownerCredentialsFromInviteCapability(capability, record.roomId);
        try {
          await deleteOwnedRoom({
            relayUrl: record.relayUrl,
            roomId: record.roomId,
            identity: legacy.identity,
            admissionKey: legacy.keys.admissionKey,
          });
        } finally {
          zeroCredentials(legacy);
        }
        await this.eraseLocal(record);
        record = null;
      } else if (
        capability.durableShare.lifecycle === 'active'
        && capability.durableShare.currentRoomId === record.roomId
        && record.publication === 'published'
        && (capability.durableShare.expiresAt ?? 0) > this.timestamp()
      ) {
        return this.view(record);
      } else if (
        capability.durableShare.lifecycle === 'revoke_pending'
        || (capability.durableShare.expiresAt ?? Number.MAX_SAFE_INTEGER) <= this.timestamp()
      ) {
        await this.deleteRemote();
        await this.eraseLocal(record);
        record = null;
      }
    }

    let capability: InviteCapability;
    let credentials: BrowserOwnerCredentialsV3;
    if (record) {
      capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
      credentials = ownerCredentialsV3FromInviteCapability(capability, record.roomId);
    } else {
      const paths = await this.resolvePaths(request.scopeKind, request.paths);
      const createdAt = this.timestamp();
      const policy = defaultOwnerPolicy(createdAt);
      policy.mode = request.mode ?? 'hybrid';
      // Stable links renew for 90 days; the current ordinary room stays short-lived.
      policy.expiresAt = createdAt + BROWSER_SHARE_TTL_ONE_DAY;
      const shareId = base64UrlEncode(this.exactRandom(16, 'share id'));
      const shareSecret = this.exactRandom(32, 'share secret');
      const roomSecret = deriveShareEpochRoomSecret(shareSecret, 0);
      const roomId = deriveRoomIdV3(roomSecret);
      const identity = generateBrowserIdentity();
      const durableShare: DurableShareCapabilityState = {
        protocolVersion: 3,
        shareId,
        shareSecret: base64UrlEncode(shareSecret),
        epoch: 0,
        revision: 0,
        manifestDigest: EMPTY_SHARE_MANIFEST_DIGEST,
        lifecycle: 'active',
      };
      capability = inviteCapabilityFrom({
        roomSecret,
        ownerSigningSecret: identity.signingSecret,
        ownerEncryptionSecret: identity.encryptionSecret,
        ownerDeviceId: identity.deviceId,
        ownerParticipantId: identity.participantId,
        durableShare,
        policy,
        sharePaths: paths,
      });
      record = await this.storage.shares.bindShareFenced(rootKey, {
        workspaceId: this.workspaceId,
        capId: shareId,
        roomId,
        scopeKind: request.scopeKind,
        relayUrl,
        capability,
      }, this.fence);
      credentials = ownerCredentialsV3FromInviteCapability(capability, roomId);
      shareSecret.fill(0);
      roomSecret.fill(0);
      identity.signingSecret.fill(0);
      identity.encryptionSecret.fill(0);
    }

    const paths = capability.sharePaths;
    if (!paths?.length) {
      zeroCredentialsV3(credentials);
      throw new BrowserStorageError('prepared share is missing its exact scope paths');
    }

    const createRoom = this.dependencies.createRoom ?? createOwnedRoomV3;
    const bootstrap = await createRoom({
      relayUrl: record.relayUrl,
      policy: credentials.policy,
      identity: credentials.identity,
      roomSecret: credentials.roomSecret,
      now: this.now,
    });
    if (bootstrap.roomId !== record.roomId) {
      zeroBootstrapKeys(bootstrap);
      zeroCredentialsV3(credentials);
      throw new StorageConflictError('relay room does not match prepared v3 ownership');
    }
    zeroBootstrapKeys(bootstrap);

    const outbox = this.makeOutbox(record.relayUrl, credentials);
    try {
      await outbox.initialize();
      if (capability.pendingPublication) {
        await resumeBrowserSnapshotPublication(outbox, {
          sink: this.storage.shares.publicationSink(rootKey),
          workspaceId: this.workspaceId,
          capId: record.capId,
          fence: this.fence,
          revisionSource: this.storage.workspaces,
        });
      } else if (record.publication !== 'published') {
        const sources = await this.loadSources(paths);
        try {
          const genesisAt = Math.max(this.timestamp(), record.createdAt);
          const publish = this.dependencies.publish ?? publishBrowserSnapshots;
          await publish({
            protocolVersion: 3,
            relayUrl: record.relayUrl,
            roomId: record.roomId,
            roomSecret: credentials.roomSecret,
            keys: credentials.keys,
            identity: credentials.identity,
            policy: credentials.policy,
            entries: sources,
            prefixEnvelopes: ownerGenesisEnvelopes(credentials, request.ownerDisplayName, genesisAt),
            scope: record.scopeKind,
            outbox,
            publication: {
              sink: this.storage.shares.publicationSink(rootKey),
              workspaceId: this.workspaceId,
              capId: record.capId,
              fence: this.fence,
              revisionSource: this.storage.workspaces,
            },
            now: () => Math.max(this.timestamp(), genesisAt + 2),
          });
        } finally {
          zeroSources(sources);
        }
      }

      const promoted = await this.inspectRecord();
      if (!promoted || promoted.capId !== record.capId || promoted.publication !== 'published') {
        throw new StorageConflictError('ordinary v3 room publication did not promote');
      }
      await this.publishDurableProjection(rootKey, promoted, credentials);
      const active = await this.inspectRecord();
      if (!active) throw new StorageConflictError('durable share disappeared after promotion');
      return this.view(active);
    } finally {
      outbox.close();
      zeroCredentialsV3(credentials);
    }
  }

  async deleteRemote(): Promise<ShareRecordView> {
    let record = await this.inspectRecord();
    if (!record) throw new BrowserStorageError('workspace has no active share');
    const rootKey = await this.requireRootKey();
    const capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
    if (!capability.durableShare) {
      const legacy = ownerCredentialsFromInviteCapability(capability, record.roomId);
      try {
        const stopped = await deleteOwnedRoom({
          relayUrl: record.relayUrl,
          roomId: record.roomId,
          identity: legacy.identity,
          admissionKey: legacy.keys.admissionKey,
        });
        if (!stopped) throw new Error('The review room could not be stopped.');
        return record;
      } finally {
        zeroCredentials(legacy);
      }
    }
    const credentials = ownerCredentialsV3FromInviteCapability(capability, record.roomId);
    try {
      const pending = { ...capability.durableShare, lifecycle: 'revoke_pending' as const };
      record = await this.storage.shares.updateDurableShareFenced(
        rootKey, this.workspaceId, record.capId, pending, this.fence,
      );
      const client = this.makeShareRelay(record.relayUrl, credentials);
      await client.revoke();
      const stopped = await (this.dependencies.deleteRoom ?? deleteOwnedRoomV3)({
        relayUrl: record.relayUrl,
        roomId: record.roomId,
        identity: credentials.identity,
        writeAdmissionKey: credentials.keys.admissionKey,
      });
      if (!stopped) throw new Error('The stable link is revoked, but the epoch room teardown must be retried.');
      return record;
    } finally {
      zeroCredentialsV3(credentials);
    }
  }

  async eraseLocal(record: ShareRecordView): Promise<void> {
    if (record.workspaceId !== this.workspaceId) {
      throw new StorageConflictError('share erase is bound to another workspace');
    }
    await this.storage.shares.forgetShareFenced(this.workspaceId, record.capId, this.fence);
  }

  private async publishDurableProjection(
    rootKey: CryptoKey,
    record: ShareRecordView,
    credentials: BrowserOwnerCredentialsV3,
  ): Promise<void> {
    const capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
    const manifest = capability.publishedManifest;
    if (!manifest) throw new StorageConflictError('published room is missing its exact manifest');
    const client = this.makeShareRelay(record.relayUrl, credentials);
    const context = this.bundleContext(credentials, 0, EMPTY_SHARE_MANIFEST_DIGEST);
    let remote: BrowserShareRelayRecord;
    try {
      remote = await client.fetchWithViewCapability(credentials.shareSecret);
    } catch (error) {
      if (!(error instanceof BrowserShareOwnerRelayError) || error.status !== 404) throw error;
      remote = await client.upsert({
        v: 3,
        ownerSigningKey: base64UrlEncode(credentials.identity.signingPublic),
        bundles: buildShareBundleMutations(context),
        epoch: credentials.epoch,
        revision: 0,
        currentRoomId: null,
        snapshots: [],
        placeholders: [],
        deviceId: credentials.identity.deviceId,
      });
    }

    const sources = await this.loadSources(capability.sharePaths ?? []);
    try {
      const desired = new Map<string, { snapshotId: string; source: BrowserSnapshotEntry }>();
      for (const entry of manifest.entries) {
        const source = sources.find((candidate) => candidate.path === entry.path);
        if (!source) throw new StorageConflictError('durable share source path disappeared');
        // The current retained-snapshot plaintext format is text-bearing.
        // Assets remain available through the live ordinary room; a later
        // resolver extension may retain inert binary snapshots as well.
        if (source.docType === 'asset') continue;
        desired.set(entry.fileId, { snapshotId: entry.snapshotId, source });
      }
      for (const retained of remote.snapshots) {
        const wanted = desired.get(retained.fileId);
        if (!wanted || wanted.snapshotId !== retained.snapshotId) {
          await client.deleteSnapshot(retained.fileId);
        }
      }
      remote = await client.fetchWithViewCapability(credentials.shareSecret);
      for (const [fileId, wanted] of desired) {
        if (remote.snapshots.some((candidate) => candidate.fileId === fileId && candidate.snapshotId === wanted.snapshotId)) {
          continue;
        }
        const content = new TextDecoder('utf-8', { fatal: true }).decode(wanted.source.bytes);
        if (wanted.source.docType === 'asset') {
          throw new StorageConflictError('durable text projection selected an asset');
        }
        const metadata = wanted.source.docType === 'markdown'
          ? await (this.dependencies.indexBuilder
              ?? (await import('./browser-anchor-index')).buildCanonicalAnchorIndex)(
                wanted.source.bytes,
                wanted.snapshotId,
              )
          : undefined;
        const sealed = sealDurableShareSnapshot({
          shareId: credentials.shareId,
          epoch: credentials.epoch,
          fileId,
          snapshotId: wanted.snapshotId,
          docType: wanted.source.docType,
          content,
          metadata,
          snapshotKey: credentials.keys.snapshotKey,
        });
        try {
          await client.uploadSnapshot(fileId, wanted.snapshotId, sealed);
        } finally {
          sealed.fill(0);
        }
      }
    } finally {
      zeroSources(sources);
    }

    remote = await client.fetchWithViewCapability(credentials.shareSecret);
    const exact = remote.currentRoomId === record.roomId
      && remote.epoch === credentials.epoch;
    const active = exact ? remote : await client.upsert({
      v: 3,
      ownerSigningKey: base64UrlEncode(credentials.identity.signingPublic),
      bundles: buildShareBundleMutations(
        this.bundleContext(credentials, remote.revision + 1, remote.manifestDigest),
      ),
      epoch: credentials.epoch,
      revision: remote.revision + 1,
      currentRoomId: record.roomId,
      snapshots: remote.snapshots,
      placeholders: remote.placeholders,
      deviceId: credentials.identity.deviceId,
    });
    await this.storage.shares.updateDurableShareFenced(rootKey, this.workspaceId, record.capId, {
      protocolVersion: 3,
      shareId: credentials.shareId,
      shareSecret: base64UrlEncode(credentials.shareSecret),
      epoch: credentials.epoch,
      revision: active.revision,
      manifestDigest: active.manifestDigest,
      currentRoomId: record.roomId,
      expiresAt: active.expiresAt,
      lifecycle: 'active',
    }, this.fence);
  }

  private bundleContext(
    credentials: BrowserOwnerCredentialsV3,
    revision: number,
    manifestDigest: string,
  ) {
    const signGrant = (tier: 'comment' | 'suggest'): string => base64UrlEncode(
      ed25519.sign(canonicalDeviceGrantV3(credentials.roomId, tier), credentials.identity.signingSecret),
    );
    return {
      shareId: credentials.shareId,
      shareSecret: credentials.shareSecret,
      epoch: credentials.epoch,
      revision,
      manifestDigest,
      roomId: credentials.roomId,
      ownerSigningKey: base64UrlEncode(credentials.identity.signingPublic),
      readCapabilityKey: credentials.readCapabilityKey!,
      writeAdmissionKey: credentials.keys.admissionKey,
      commentGrantSignature: signGrant('comment'),
      suggestGrantSignature: signGrant('suggest'),
      randomBytes: this.randomBytes,
    };
  }

  private async inspectRecord(): Promise<ShareRecordView | null> {
    const active = (await this.storage.shares.listShares(this.workspaceId))
      .filter((share) => share.publication !== 'stopped');
    if (active.length > 1) throw new StorageConflictError('workspace has multiple active shares');
    return active[0] ?? null;
  }

  private async view(record: ShareRecordView): Promise<BrowserWorkspaceShareView> {
    const rootKey = await this.requireRootKey();
    const capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
    const durable = capability.durableShare;
    const published = record.publication === 'published'
      && durable?.lifecycle === 'active'
      && durable.currentRoomId === record.roomId;
    const expiresAt = durable?.expiresAt ?? (capability.policy as RoomPolicy).expiresAt;
    const expired = expiresAt <= this.timestamp();
    let invites: ShareTierInvites | null = null;
    if (published && durable && !expired) {
      const credentials = ownerCredentialsV3FromInviteCapability(capability, record.roomId);
      try {
        invites = composeShareTierInvites(durable.shareId, credentials.shareSecret);
      } finally {
        zeroCredentialsV3(credentials);
      }
    }
    return {
      workspaceId: this.workspaceId,
      capId: record.capId,
      shareId: durable?.shareId ?? record.capId,
      roomId: record.roomId,
      scopeKind: record.scopeKind,
      paths: [...(capability.sharePaths ?? capability.publishedManifest?.entries.map((entry) => entry.path) ?? [])],
      publication: record.publication,
      mode: (capability.policy as RoomPolicy).mode,
      expiresAt,
      expired,
      resumable: !published,
      invite: invites,
    };
  }

  private async resolvePaths(scopeKind: ShareScopeKind, requested: readonly string[]): Promise<string[]> {
    const entries = await this.storage.workspaces.listEntries(this.workspaceId);
    const live = new Map(entries.map((entry) => [entry.path, entry]));
    const paths = scopeKind === 'workspace'
      ? entries.map((entry) => entry.path)
      : requested.map((path) => normalizeEntryPath(path));
    if (scopeKind === 'file' && paths.length !== 1) {
      throw new BrowserStorageError('current-file share requires exactly one path');
    }
    if (paths.length === 0) throw new BrowserStorageError('share scope cannot be empty');
    if (new Set(paths).size !== paths.length) throw new BrowserStorageError('share scope contains duplicate paths');
    for (const path of paths) if (!live.has(path)) throw new StorageConflictError('share scope contains a stale path');
    if (!paths.some((path) => live.get(path)?.kind === 'markdown')) {
      throw new BrowserStorageError('share scope must contain at least one Markdown file');
    }
    return [...paths].sort(compareManifestPathsUtf8);
  }

  private async loadSources(paths: readonly string[]): Promise<BrowserSnapshotEntry[]> {
    const sources: BrowserSnapshotEntry[] = [];
    try {
      for (const path of paths) {
        const entry = await this.storage.workspaces.getEntry(this.workspaceId, path);
        if (!entry) throw new StorageConflictError('share scope changed before publication');
        const bytes = await this.storage.workspaces.getRevisionBody(this.workspaceId, path, entry.headRevisionId);
        sources.push(entry.kind === 'markdown'
          ? { path, docType: 'markdown', bytes, revisionId: entry.headRevisionId }
          : { path, docType: 'asset', mediaType: entry.mediaType ?? 'application/octet-stream', bytes, revisionId: entry.headRevisionId });
      }
      return sources;
    } catch (error) {
      zeroSources(sources);
      throw error;
    }
  }

  private makeOutbox(relayUrl: string, credentials: BrowserOwnerCredentialsV3): BrowserWorkspaceShareOutbox {
    if (this.dependencies.outboxFactory) {
      return this.dependencies.outboxFactory({ storage: this.storage, relayUrl, credentials });
    }
    const persistence: BrowserOutboxPersistence = {
      loadPending: () => this.storage.listOutbox(credentials.roomId, credentials.identity.deviceId),
      putPending: async (envelope) => { await this.storage.putOutbox(credentials.roomId, envelope); },
      putPendingBatch: async (envelopes) => { await this.storage.putOutboxBatch(credentials.roomId, envelopes); },
      acknowledge: async (batch, accepted) => { await this.storage.acknowledge(credentials.roomId, batch, accepted); },
    };
    return new BrowserOutbox({
      relayUrl,
      roomId: credentials.roomId,
      deviceId: credentials.identity.deviceId,
      admissionKey: credentials.keys.admissionKey,
      protocolVersion: 3,
      powBits: credentials.policy.powBits,
      maxEventBytes: credentials.policy.maxEventBytes,
      maxSnapshotBytes: credentials.policy.maxSnapshotBytes,
      persistence,
    });
  }

  private makeShareRelay(relayUrl: string, credentials: BrowserOwnerCredentialsV3): BrowserShareOwnerRelayPort {
    const options = {
      relayUrl,
      shareId: credentials.shareId,
      identity: credentials.identity,
    };
    return this.dependencies.shareRelayFactory?.(options)
      ?? new BrowserShareOwnerRelayClient(options);
  }

  private async requireRootKey(): Promise<CryptoKey> {
    const key = await this.storage.getWorkspaceRootKey(this.workspaceId);
    if (!key) throw new BrowserStorageError('workspace key is unavailable');
    return key;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) throw new BrowserStorageError('share clock is invalid');
    return value;
  }

  private exactRandom(length: number, label: string): Uint8Array {
    const value = this.randomBytes(length);
    if (!(value instanceof Uint8Array) || value.length !== length) {
      throw new BrowserStorageError(`${label} generator returned the wrong length`);
    }
    return new Uint8Array(value);
  }
}

function ownerGenesisEnvelopes(credentials: BrowserOwnerCredentials, displayName: string | undefined, createdAt: number) {
  const common = {
    eventKey: credentials.keys.eventKey,
    signingSecret: credentials.identity.signingSecret,
    signingPublic: credentials.identity.signingPublic,
    roomId: credentials.roomId,
    authorId: credentials.identity.participantId,
    deviceId: credentials.identity.deviceId,
    expiresAt: credentials.policy.expiresAt,
  } as const;
  const roomCreated = assembleBrowserEvent({ ...common, createdAt, body: {
    type: 'room_created', roomId: credentials.roomId, policy: credentials.policy,
    createdBy: credentials.identity.participantId,
  } });
  const ownerJoined = assembleBrowserEvent({ ...common, createdAt: createdAt + 1, body: {
    type: 'participant_joined',
    participant: {
      participantId: credentials.identity.participantId,
      displayName: displayName?.trim() || 'Browser owner',
      kind: 'owner', publicSigningKey: base64UrlEncode(credentials.identity.signingPublic),
      capabilities: [...OWNER_CAPABILITIES],
    },
    device: {
      deviceId: credentials.identity.deviceId,
      participantId: credentials.identity.participantId,
      publicEncryptionKey: base64UrlEncode(credentials.identity.publicEncryptionKey),
      publicSigningKey: base64UrlEncode(credentials.identity.signingPublic),
      client: 'attn-browser', createdAt: createdAt + 1,
    },
  } });
  return [roomCreated.envelope, ownerJoined.envelope] as const;
}

function validateRequest(request: BrowserWorkspaceShareRequest): void {
  if (request.mode !== undefined && !['live', 'async', 'hybrid'].includes(request.mode)) {
    throw new BrowserStorageError('share mode is invalid');
  }
  if (request.ttlMs !== undefined && ![
    BROWSER_SHARE_TTL_ONE_HOUR, BROWSER_SHARE_TTL_ONE_DAY, BROWSER_SHARE_TTL_SEVEN_DAYS,
  ].includes(request.ttlMs)) throw new BrowserStorageError('share lifetime is invalid');
  if (!['file', 'entries', 'workspace'].includes(request.scopeKind)) {
    throw new BrowserStorageError('share scope is invalid');
  }
}

function zeroSources(sources: readonly BrowserSnapshotEntry[]): void {
  for (const source of sources) source.bytes.fill(0);
}

function zeroCredentials(credentials: BrowserOwnerCredentials): void {
  credentials.roomSecret.fill(0);
  credentials.keys.rootKey.fill(0);
  credentials.keys.eventKey.fill(0);
  credentials.keys.snapshotKey.fill(0);
  credentials.keys.signalingKey.fill(0);
  credentials.keys.admissionKey.fill(0);
  credentials.readAdmissionKey?.fill(0);
  credentials.readCapabilityKey?.fill(0);
  credentials.identity.signingSecret.fill(0);
  credentials.identity.signingPublic.fill(0);
  credentials.identity.encryptionSecret.fill(0);
  credentials.identity.publicEncryptionKey.fill(0);
}

function zeroCredentialsV3(credentials: BrowserOwnerCredentialsV3): void {
  credentials.shareSecret.fill(0);
  zeroCredentials(credentials);
}

function zeroBootstrapKeys(bootstrap: OwnedRoomBootstrapV3 | OwnedRoomBootstrap): void {
  bootstrap.keys.rootKey.fill(0);
  if ('readKeys' in bootstrap.keys) {
    bootstrap.keys.readKeys.readCapabilityKey.fill(0);
    bootstrap.keys.readKeys.eventKey.fill(0);
    bootstrap.keys.readKeys.snapshotKey.fill(0);
    bootstrap.keys.readKeys.signalingKey.fill(0);
    bootstrap.keys.readKeys.readAdmissionKey.fill(0);
    bootstrap.keys.writeAdmissionKey.fill(0);
  } else {
    bootstrap.keys.eventKey.fill(0);
    bootstrap.keys.snapshotKey.fill(0);
    bootstrap.keys.signalingKey.fill(0);
    bootstrap.keys.admissionKey.fill(0);
  }
}
