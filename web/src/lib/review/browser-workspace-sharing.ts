// Accountless browser-owner durable sharing (attn-7xl.4.5).
//
// A workspace owns one stable ShareDO id and three sibling public bearers.
// The ordinary v3 room is an epoch-scoped implementation detail: it can be
// recreated without changing `/s/<shareId>#key=…` links.

import { ed25519 } from '@noble/curves/ed25519.js';
import type { AnchorIndex, Capability, ReviewEvent, RoomPolicy } from '../types';
import {
  aeadOpen,
  base64UrlDecode,
  base64UrlEncode,
  deriveEventEnvelopeId,
  deriveEventId,
  deriveRoomIdV3,
  deriveShareLinkKeys,
  deriveShareEpochRoomSecret,
  verifyEventSignature,
} from './browser-crypto';
import { sanitizeParticipantColor } from '../participant-color';
import { assembleBrowserEvent } from './browser-envelope';
import {
  createOwnedRoomV3,
  defaultOwnerPolicy,
  deleteOwnedRoom,
  deleteOwnedRoomV3,
  registerFrozenReviewerDeviceV3,
  type CreateOwnedRoomOptions,
  type OwnedRoomBootstrap,
  type OwnedRoomBootstrapV3,
} from './browser-owner-bootstrap';
import { BrowserOutbox, type BrowserOutboxPersistence } from './browser-outbox';
import { validateBrowserRelayUrl } from './browser-relay-url';
import { requireShareInviteOrigin } from './browser-share';
import {
  canonicalDeviceGrantV3,
  canonicalRegisterDeviceBytes,
  generateBrowserIdentity,
  ownerCredentialsFromInviteCapability,
  ownerCredentialsV3FromInviteCapability,
  verifyDeviceGrantV3,
  type BrowserOwnerCredentials,
  type BrowserOwnerCredentialsV3,
  type RegisterDeviceBodyV3,
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
  digestShareSnapshotManifest,
  sealDurableShareSnapshot,
  type BrowserShareOwnerRelayOptions,
  type BrowserShareRelayRecord,
  type BrowserShareMailboxPage,
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
import type { MailboxEnvelope } from './browser-ws';

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
  /** Owner's picked identity color (attn-3gdd), announced on the genesis
   *  ParticipantJoined next to the display name. Omitted → hash fallback. */
  ownerColor?: string | null;
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
  fetchMailbox(shareSecret: Uint8Array, tier: 'comment' | 'suggest', after: number): Promise<BrowserShareMailboxPage>;
  ackMailbox(through: number): Promise<void>;
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
  registerFrozenDevice?: typeof registerFrozenReviewerDeviceV3;
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

  async inspect(browserReviewBase: string): Promise<BrowserWorkspaceShareView | null> {
    const record = await this.inspectRecord();
    return record ? this.view(record, browserReviewBase) : null;
  }

  /** Owner-tab startup reconciliation: renew routing and drain offline mail. */
  async reconcileActive(): Promise<BrowserWorkspaceShareView | null> {
    const record = await this.inspectRecord();
    if (!record) return null;
    const rootKey = await this.requireRootKey();
    const capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
    const durable = capability.durableShare;
    if (!durable || durable.lifecycle !== 'active'
      || (durable.expiresAt !== undefined && durable.expiresAt <= this.timestamp())) {
      return this.view(record);
    }
    return this.ensurePublished({
      relayUrl: record.relayUrl,
      browserReviewBase: 'https://attn.sh',
      scopeKind: record.scopeKind,
      paths: capability.sharePaths ?? [],
      mode: (capability.policy as RoomPolicy).mode,
    });
  }

  /**
   * Retire the current ordinary-room generation before recovering an
   * authenticated expiry. The stable share, epoch-derived room secret, and
   * reviewer grants deliberately remain unchanged: recreating the same room
   * identity lets queued ShareDO mailbox ciphertext flow into the fresh
   * generation without re-encryption or capability churn.
   */
  async retireCurrentRoomForRecovery(): Promise<void> {
    const record = await this.inspectRecord();
    if (!record) throw new BrowserStorageError('active share is unavailable for room recovery');
    const rootKey = await this.requireRootKey();
    const capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
    if (!capability.durableShare || capability.durableShare.lifecycle !== 'active') {
      throw new StorageConflictError('durable share is unavailable for room recovery');
    }
    const credentials = ownerCredentialsV3FromInviteCapability(capability, record.roomId);
    try {
      const retired = await (this.dependencies.deleteRoom ?? deleteOwnedRoomV3)({
        relayUrl: record.relayUrl,
        roomId: record.roomId,
        identity: credentials.identity,
        writeAdmissionKey: credentials.keys.admissionKey,
      });
      if (!retired) throw new BrowserStorageError('expired room generation could not be retired');
    } finally {
      zeroCredentialsV3(credentials);
    }
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
        // Reasserting an active share is also its renewal path. Refresh the
        // sealed ordinary-room policy before touching RoomDO so a missing
        // 24-hour epoch room can be recreated under the same stable share.
        const policy = { ...(capability.policy as RoomPolicy) };
        policy.expiresAt = this.timestamp() + BROWSER_SHARE_TTL_ONE_DAY;
        record = await this.storage.shares.updateDurableShareFenced(
          rootKey,
          this.workspaceId,
          record.capId,
          capability.durableShare,
          this.fence,
          policy,
        );
      } else if (
        capability.durableShare.lifecycle === 'revoke_pending'
        || (capability.durableShare.expiresAt ?? Number.MAX_SAFE_INTEGER) <= this.timestamp()
      ) {
        // Best-effort teardown: an unreachable remote must not wedge the
        // re-share — any orphaned remote resource expires with its TTL.
        const { record: tombstoned } = await this.deleteRemote();
        await this.eraseLocal(tombstoned);
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
        drainCursor: 0,
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
    const roomWasCreated = bootstrap.created;
    zeroBootstrapKeys(bootstrap);

    const outbox = this.makeOutbox(record.relayUrl, credentials);
    try {
      await outbox.initialize();
      await this.drainDurableMailbox(rootKey, record, credentials, outbox);
      if (capability.pendingPublication) {
        await resumeBrowserSnapshotPublication(outbox, {
          sink: this.storage.shares.publicationSink(rootKey),
          workspaceId: this.workspaceId,
          capId: record.capId,
          fence: this.fence,
          revisionSource: this.storage.workspaces,
        });
      } else if (record.publication !== 'published' || roomWasCreated) {
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
            prefixEnvelopes: ownerGenesisEnvelopes(
              credentials,
              request.ownerDisplayName,
              request.ownerColor ?? null,
              genesisAt,
            ),
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
      return this.view(active, request.browserReviewBase);
    } finally {
      outbox.close();
      zeroCredentialsV3(credentials);
    }
  }

  /**
   * Revoke the remote share. The revoke INTENT is persisted durably (the
   * revoke_pending tombstone) BEFORE any network call; the remote teardown
   * itself is best-effort. `teardownComplete: false` means some remote
   * resource may live until its TTL — the tombstone is retried by the next
   * ensurePublished. Throwing here used to wedge Stop forever whenever the
   * share was only partially created (a quota-denied publish leaves no
   * remote room/share, and tearing down nonexistent resources returns
   * CORS-untagged 404s the browser reads as network failure).
   */
  async deleteRemote(): Promise<{ record: ShareRecordView; teardownComplete: boolean }> {
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
        return { record, teardownComplete: true };
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
      let teardownComplete = false;
      try {
        const client = this.makeShareRelay(record.relayUrl, credentials);
        await client.revoke();
        teardownComplete = await (this.dependencies.deleteRoom ?? deleteOwnedRoomV3)({
          relayUrl: record.relayUrl,
          roomId: record.roomId,
          identity: credentials.identity,
          writeAdmissionKey: credentials.keys.admissionKey,
        });
      } catch {
        teardownComplete = false;
      }
      return { record, teardownComplete };
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
    const durable = capability.durableShare;
    if (!durable) throw new StorageConflictError('durable share ownership is missing');
    const manifest = capability.publishedManifest;
    if (!manifest) throw new StorageConflictError('published room is missing its exact manifest');
    const client = this.makeShareRelay(record.relayUrl, credentials);
    const context = this.bundleContext(credentials, 0, EMPTY_SHARE_MANIFEST_DIGEST);
    const createBody = {
      v: 3,
      ownerSigningKey: base64UrlEncode(credentials.identity.signingPublic),
      bundles: buildShareBundleMutations(context),
      epoch: credentials.epoch,
      revision: 0,
      currentRoomId: null,
      snapshots: [],
      placeholders: [],
      deviceId: credentials.identity.deviceId,
    } satisfies BrowserShareUpsertRequest;
    let remote: BrowserShareRelayRecord;
    // A durable record that has never committed a relay publish still carries
    // its minted revision-0/empty-manifest state (the local `publication`
    // flag promotes earlier and can't distinguish). Probing the relay first
    // in that state just manufactures a guaranteed 404 on every share
    // creation (attn-8l8) — create directly; if a concurrent owner operation
    // won the race, fall back to reading what it wrote.
    const relayHasRecord = durable.revision > 0
      || durable.manifestDigest !== EMPTY_SHARE_MANIFEST_DIGEST;
    if (!relayHasRecord) {
      try {
        remote = await client.upsert(createBody);
      } catch {
        remote = await client.fetchWithViewCapability(credentials.shareSecret);
      }
    } else {
      try {
        remote = await client.fetchWithViewCapability(credentials.shareSecret);
      } catch (error) {
        if (!(error instanceof BrowserShareOwnerRelayError) || error.status !== 404) throw error;
        remote = await client.upsert(createBody);
      }
    }

    // Uploads only stage ciphertext on the relay; nothing joiners can observe
    // changes until the single commit upsert below lands the full manifest
    // together with bundles sealed against it. Files absent from the
    // committed manifest are removed by that same commit.
    const sources = await this.loadSources(capability.sharePaths ?? []);
    const nextManifest: ManagedShareSnapshotRef[] = [];
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
      for (const [fileId, wanted] of desired) {
        const retained = remote.snapshots.find(
          (candidate) => candidate.fileId === fileId && candidate.snapshotId === wanted.snapshotId,
        );
        if (retained) {
          nextManifest.push(retained);
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
        const sealed = await sealDurableShareSnapshot({
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
          nextManifest.push(await client.uploadSnapshot(fileId, wanted.snapshotId, sealed));
        } finally {
          sealed.fill(0);
        }
      }
    } finally {
      zeroSources(sources);
    }

    // Re-read after uploads before choosing the commit revision. Current
    // relays stage uploads invisibly, while older deployed relays advanced the
    // public revision as each retained snapshot landed. Supporting both keeps
    // a localhost owner from needing a manual Resume during relay rollouts and
    // also closes the ordinary stale-read race with another owner operation.
    remote = await client.fetchWithViewCapability(credentials.shareSecret);
    // Reviewer-side manifest validation requires strict code-unit ascending
    // fileId order; localeCompare collates '-'/'_' (base64url alphabet)
    // differently and produced manifests multi-file joiners rejected as
    // 'snapshot manifest entry is invalid'.
    nextManifest.sort((left, right) => compareManifestPathsUtf8(left.fileId, right.fileId));
    const manifestDigest = digestShareSnapshotManifest(nextManifest);
    // A legacy record with an unverifiable stored digest must never count as
    // exact — commit the rewrite so the relay record heals (attn-qtz).
    const exact = remote.currentRoomId === record.roomId
      && remote.epoch === credentials.epoch
      && remote.manifestDigestValid
      && remote.manifestDigest === manifestDigest;
    const revision = exact ? remote.revision : remote.revision + 1;
    const active = await client.upsert({
      v: 3,
      ownerSigningKey: base64UrlEncode(credentials.identity.signingPublic),
      // A no-change touch omits bundles entirely (the relay keeps the stored
      // set). Sending an explicit [] was rejected as invalid, which silently
      // starved joiners of their share_changed wake-up.
      ...(exact
        ? {}
        : {
            bundles: buildShareBundleMutations(
              this.bundleContext(credentials, revision, manifestDigest),
            ),
          }),
      epoch: credentials.epoch,
      revision,
      currentRoomId: record.roomId,
      snapshots: nextManifest,
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
      drainCursor: durable.drainCursor ?? 0,
      lifecycle: 'active',
    }, this.fence);
  }

  private async drainDurableMailbox(
    rootKey: CryptoKey,
    record: ShareRecordView,
    credentials: BrowserOwnerCredentialsV3,
    outbox: BrowserWorkspaceShareOutbox,
  ): Promise<void> {
    const rootCapability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
    const durable = rootCapability.durableShare;
    if (!durable) throw new StorageConflictError('durable share ownership is missing');
    // A share that has never committed a relay publish has no relay record
    // and therefore no mailbox — probing it only logs a guaranteed 404
    // (attn-8l8; same predicate as publishDurableProjection).
    if (durable.revision === 0 && durable.manifestDigest === EMPTY_SHARE_MANIFEST_DIGEST) return;
    const client = this.makeShareRelay(record.relayUrl, credentials);
    const remote = await client.fetchWithViewCapability(credentials.shareSecret).catch((error) => {
      if (error instanceof BrowserShareOwnerRelayError && error.status === 404) return null;
      throw error;
    });
    if (!remote || remote.mailbox.count === 0) return;
    const after = durable.drainCursor ?? 0;
    const items = new Map<number, BrowserShareMailboxPage['items'][number]>();
    for (const tier of ['comment', 'suggest'] as const) {
      let cursor = after;
      for (;;) {
        const page = await client.fetchMailbox(credentials.shareSecret, tier, cursor);
        for (const item of page.items) {
          if (items.has(item.seq)) throw new StorageConflictError('durable mailbox repeated a sequence');
          items.set(item.seq, item);
        }
        if (page.items.length === 0) break;
        if (page.nextAfter <= cursor) throw new StorageConflictError('durable mailbox cursor did not advance');
        cursor = page.nextAfter;
      }
    }
    if (items.size !== remote.mailbox.count) {
      throw new StorageConflictError('durable mailbox selectors did not cover the retained prefix');
    }
    const ordered = [...items.values()].sort((left, right) => left.seq - right.seq);
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index]!.seq !== after + index + 1) {
        throw new StorageConflictError('durable mailbox sequence is not contiguous');
      }
    }
    const submissions = ordered.map((item) => preflightReviewSubmission(item, credentials, remote));
    for (const submission of submissions) {
      await (this.dependencies.registerFrozenDevice ?? registerFrozenReviewerDeviceV3)({
        relayUrl: record.relayUrl,
        roomId: credentials.roomId,
        writeAdmissionKey: credentials.keys.admissionKey,
        registration: submission.registration,
      });
      await outbox.enqueueBatchDurably(submission.envelopes);
      await outbox.flushNow();
    }
    const through = ordered.at(-1)!.seq;
    await client.ackMailbox(through);
    await this.storage.shares.updateDurableShareFenced(rootKey, this.workspaceId, record.capId, {
      ...durable,
      drainCursor: through,
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

  private async view(
    record: ShareRecordView,
    browserReviewBase = 'https://attn.sh/review',
  ): Promise<BrowserWorkspaceShareView> {
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
        invites = composeShareTierInvites(
          durable.shareId,
          credentials.shareSecret,
          new URL(browserReviewBase).origin,
        );
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

function ownerGenesisEnvelopes(
  credentials: BrowserOwnerCredentials,
  displayName: string | undefined,
  color: string | null,
  createdAt: number,
) {
  const common = {
    eventKey: credentials.keys.eventKey,
    signingSecret: credentials.identity.signingSecret,
    signingPublic: credentials.identity.signingPublic,
    roomId: credentials.roomId,
    authorId: credentials.identity.participantId,
    deviceId: credentials.identity.deviceId,
    expiresAt: credentials.policy.expiresAt,
  } as const;
  const ownerColor = sanitizeParticipantColor(color);
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
      // Validated at the seam (attn-3gdd): only palette-shaped values ride
      // the genesis announce; junk degrades to the hash color everywhere.
      ...(ownerColor !== null ? { color: ownerColor } : {}),
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
  // Fail BEFORE any side effect (room creation, snapshot publication,
  // durable projection): invite composition at the end of the flow enforces
  // these exact origin rules, and a share must never go live on an origin
  // that will then fail to mint its invite links (dev servers, previews).
  try {
    requireShareInviteOrigin(new URL(request.browserReviewBase).origin);
  } catch (error) {
    throw new BrowserStorageError(error instanceof Error ? error.message : String(error));
  }
}

function preflightReviewSubmission(
  item: BrowserShareMailboxPage['items'][number],
  credentials: BrowserOwnerCredentialsV3,
  remote: BrowserShareRelayRecord,
): { registration: RegisterDeviceBodyV3; envelopes: MailboxEnvelope[] } {
  if (!isRecord(item.payload)) throw new StorageConflictError('durable mailbox payload is invalid');
  const payload = item.payload;
  if (payload.v !== 3 || payload.type !== 'review_submission'
    || payload.envelopeId !== item.envelopeId || payload.shareId !== credentials.shareId
    || payload.epoch !== credentials.epoch || payload.roomId !== credentials.roomId
    || payload.tier !== item.tier || item.epoch !== credentials.epoch
    || !Array.isArray(payload.envelopes) || payload.envelopes.length < 2 || payload.envelopes.length > 8
    || !isRecord(payload.deviceRegistration)) {
    throw new StorageConflictError('durable review submission routing is invalid');
  }
  const keys = deriveShareLinkKeys(credentials.shareSecret, item.tier);
  try {
    if (keys.bundleId !== item.bundleId) {
      throw new StorageConflictError('durable review submission selected the wrong sibling bearer');
    }
  } finally {
    keys.linkSecret.fill(0);
    keys.bundleKey.fill(0);
    keys.readAdmissionKey.fill(0);
    keys.writeAdmissionKey?.fill(0);
  }
  const raw = payload.deviceRegistration;
  if (typeof raw.deviceId !== 'string' || typeof raw.participantId !== 'string'
    || typeof raw.publicSigningKey !== 'string' || typeof raw.publicEncryptionKey !== 'string'
    || raw.client !== 'attn-browser' || raw.kind !== 'reviewer' || raw.grantTier !== item.tier
    || typeof raw.grantSignature !== 'string' || typeof raw.selfSignature !== 'string') {
    throw new StorageConflictError('durable review submission registration is invalid');
  }
  const registration = raw as unknown as RegisterDeviceBodyV3;
  const publicKey = base64UrlDecode(registration.publicSigningKey);
  const encryptionKey = base64UrlDecode(registration.publicEncryptionKey);
  const selfSignature = base64UrlDecode(registration.selfSignature);
  try {
    if (publicKey.length !== 32 || encryptionKey.length !== 32 || selfSignature.length !== 64
      || !ed25519.verify(selfSignature, canonicalRegisterDeviceBytes(registration), publicKey)
      || !verifyDeviceGrantV3(
        credentials.roomId,
        registration.grantTier,
        registration.grantSignature,
        remote.ownerSigningKey,
      )) {
      throw new StorageConflictError('durable review submission registration proof is invalid');
    }
    const envelopes = payload.envelopes.map((value, index) => {
      if (!isRecord(value) || value.v !== 2 || value.kind !== 'event'
        || value.roomId !== credentials.roomId || value.deviceId !== registration.deviceId
        || value.authorId !== registration.participantId || typeof value.envelopeId !== 'string'
        || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
        || typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string'
        || !Number.isSafeInteger(value.ciphertextBytes)) {
        throw new StorageConflictError('durable review submission envelope is invalid');
      }
      const envelope = value as unknown as MailboxEnvelope;
      const plaintext = aeadOpen(
        credentials.keys.eventKey,
        base64UrlDecode(envelope.nonce),
        base64UrlDecode(envelope.ciphertext),
        {
          v: 2,
          roomId: credentials.roomId,
          envelopeId: envelope.envelopeId,
          kind: 'event',
          authorId: envelope.authorId,
          deviceId: envelope.deviceId,
          createdAt: envelope.createdAt,
        },
      );
      try {
        const event = JSON.parse(new TextDecoder().decode(plaintext)) as ReviewEvent;
        if (!isRecord(event) || !isRecord(event.meta) || !isRecord(event.auth)
          || event.meta.v !== 2 || event.meta.roomId !== credentials.roomId
          || event.meta.authorId !== registration.participantId
          || event.meta.deviceId !== registration.deviceId
          || event.meta.createdAt !== envelope.createdAt
          || typeof event.meta.eventId !== 'string'
          || deriveEventEnvelopeId(credentials.roomId, event.meta.eventId) !== envelope.envelopeId
          || deriveEventId(event.meta, event.body) !== event.meta.eventId) {
          throw new StorageConflictError('durable review event binding is invalid');
        }
        verifyEventSignature(event.meta, event.body, event.auth, publicKey);
        if (index === 0) {
          if (event.body.type !== 'participant_joined'
            || event.body.participant.participantId !== registration.participantId
            || event.body.participant.kind !== 'reviewer'
            || event.body.participant.publicSigningKey !== registration.publicSigningKey
            || event.body.device.deviceId !== registration.deviceId
            || event.body.device.publicSigningKey !== registration.publicSigningKey
            || event.body.device.publicEncryptionKey !== registration.publicEncryptionKey) {
            throw new StorageConflictError('durable reviewer attestation event is invalid');
          }
        } else if (event.body.type !== 'comment_created' && event.body.type !== 'suggestion_created') {
          throw new StorageConflictError('durable review submission contains an unauthorized event');
        }
      } finally {
        plaintext.fill(0);
      }
      return structuredClone(envelope);
    });
    return { registration: structuredClone(registration), envelopes };
  } finally {
    publicKey.fill(0);
    encryptionKey.fill(0);
    selfSignature.fill(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
