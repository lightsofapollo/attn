// Accountless browser-owner share lifecycle (attn-7xl.4.5).
//
// The coordinator is deliberately DOM-free. It prepares ownership under the
// active workspace fence before any relay request, journals RoomCreated + the
// owner ParticipantJoined atomically with the initial encrypted snapshots,
// and only materializes invite strings for an explicitly opened Share sheet.

import type { Capability, RoomPolicy } from '../types';
import {
  base64UrlEncode,
  deriveRoomId,
  deriveRoomKeys,
} from './browser-crypto';
import { assembleBrowserEvent } from './browser-envelope';
import { composeInviteForms, type InviteForms } from './browser-invite';
import {
  createOwnedRoom,
  defaultOwnerPolicy,
  deleteOwnedRoom,
  type CreateOwnedRoomOptions,
  type OwnedRoomBootstrap,
} from './browser-owner-bootstrap';
import { BrowserOutbox, type BrowserOutboxPersistence } from './browser-outbox';
import { validateBrowserRelayUrl } from './browser-relay-url';
import {
  ownerCredentialsFromInviteCapability,
  generateBrowserIdentity,
  type BrowserOwnerCredentials,
} from './browser-session';
import {
  publishBrowserSnapshots,
  resumeBrowserSnapshotPublication,
  type BrowserSnapshotEntry,
  type PublishBrowserSnapshotsOptions,
  type SnapshotPublicationOutbox,
} from './browser-snapshot-publisher';
import type { BrowserStorage } from './browser-storage';
import { BrowserStorageError, StorageConflictError } from './browser-storage-errors';
import {
  inviteCapabilityFrom,
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
  roomId: string;
  scopeKind: ShareScopeKind;
  paths: string[];
  publication: ShareRecordView['publication'];
  mode: BrowserWorkspaceShareMode;
  expiresAt: number;
  expired: boolean;
  resumable: boolean;
  invite: InviteForms | null;
}

export interface BrowserWorkspaceShareOutbox extends SnapshotPublicationOutbox {
  initialize(): Promise<void>;
  close(): void;
}

export interface BrowserWorkspaceSharingDependencies {
  createRoom?: (options: CreateOwnedRoomOptions) => Promise<OwnedRoomBootstrap>;
  deleteRoom?: typeof deleteOwnedRoom;
  publish?: (options: PublishBrowserSnapshotsOptions) => Promise<unknown>;
  outboxFactory?: (input: {
    storage: BrowserStorage;
    relayUrl: string;
    credentials: BrowserOwnerCredentials;
  }) => BrowserWorkspaceShareOutbox;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

const OWNER_CAPABILITIES: Capability[] = [
  'room_admin',
  'read_snapshot',
  'write_comment',
  'write_suggestion',
  'resolve_comment',
  'accept_suggestion',
  'publish_snapshot',
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
    const active = (await this.storage.shares.listShares(this.workspaceId))
      .filter((share) => share.publication !== 'stopped')
      .sort((left, right) => right.createdAt - left.createdAt);
    if (active.length === 0) return null;
    if (active.length !== 1) {
      throw new StorageConflictError('workspace has multiple active shares');
    }
    return this.view(active[0]!, browserReviewBase);
  }

  /** Create, resume, or return the one active browser-owned room. */
  async ensurePublished(request: BrowserWorkspaceShareRequest): Promise<BrowserWorkspaceShareView> {
    validateRequest(request);
    const relayUrl = validateBrowserRelayUrl(request.relayUrl);
    let existing = await this.inspectRecord();
    if (existing) {
      const existingView = await this.view(existing, request.browserReviewBase);
      if (existingView.expired) {
        // Expired ownership must not trap the workspace behind the single-active
        // invariant. Confirm relay teardown (404/410 are idempotent success),
        // then crypto-erase the sealed capability before minting a fresh room.
        const retired = await this.deleteRemote();
        await this.eraseLocal(retired);
        existing = null;
      } else if (existing.publication === 'published') {
        return existingView;
      }
    }

    const rootKey = await this.storage.getWorkspaceRootKey(this.workspaceId);
    if (!rootKey) throw new BrowserStorageError('workspace key is unavailable');

    let record = existing;
    let capability: InviteCapability;
    let credentials: BrowserOwnerCredentials;
    if (record) {
      capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
      credentials = ownerCredentialsFromInviteCapability(capability, record.roomId);
    } else {
      const paths = await this.resolvePaths(request.scopeKind, request.paths);
      const createdAt = this.timestamp();
      const ttlMs = request.ttlMs ?? BROWSER_SHARE_TTL_ONE_DAY;
      const policy = defaultOwnerPolicy(createdAt);
      policy.mode = request.mode ?? 'hybrid';
      policy.expiresAt = createdAt + ttlMs;
      const roomSecret = this.exactRandom(32, 'room secret');
      const identity = generateBrowserIdentity();
      const roomId = deriveRoomId(roomSecret);
      const capId = base64UrlEncode(this.exactRandom(16, 'share capability id'));
      capability = inviteCapabilityFrom({
        roomSecret,
        ownerSigningSecret: identity.signingSecret,
        ownerEncryptionSecret: identity.encryptionSecret,
        ownerDeviceId: identity.deviceId,
        ownerParticipantId: identity.participantId,
        policy,
        sharePaths: paths,
      });
      record = await this.storage.shares.bindShareFenced(rootKey, {
        workspaceId: this.workspaceId,
        capId,
        roomId,
        scopeKind: request.scopeKind,
        relayUrl,
        capability,
      }, this.fence);
      credentials = {
        roomId,
        roomSecret,
        keys: deriveRoomKeys(roomSecret),
        identity,
        policy,
      };
    }

    const paths = capability.sharePaths;
    if (!paths || paths.length === 0) {
      zeroCredentials(credentials);
      throw new BrowserStorageError('prepared share is missing its exact scope paths');
    }
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
      } else {
        const createRoom = this.dependencies.createRoom ?? createOwnedRoom;
        const created = await createRoom({
          relayUrl: record.relayUrl,
          policy: credentials.policy,
          longSession: credentials.policy.expiresAt - record.createdAt > BROWSER_SHARE_TTL_ONE_DAY,
          identity: credentials.identity,
          roomSecret: credentials.roomSecret,
          now: this.now,
        });
        // A prepared record is allowed to receive 201: no genesis/snapshot
        // envelope is exposed until the atomic publication journal below.
        if (created.roomId !== record.roomId) {
          zeroBootstrapKeys(created);
          throw new StorageConflictError('relay room does not match prepared ownership');
        }
        zeroBootstrapKeys(created);
        const sources = await this.loadSources(paths);
        try {
          const genesisAt = Math.max(this.timestamp(), record.createdAt);
          const prefixEnvelopes = ownerGenesisEnvelopes(
            credentials,
            request.ownerDisplayName,
            genesisAt,
          );
          const publish = this.dependencies.publish ?? publishBrowserSnapshots;
          await publish({
            relayUrl: record.relayUrl,
            roomId: record.roomId,
            roomSecret: credentials.roomSecret,
            keys: credentials.keys,
            identity: credentials.identity,
            policy: credentials.policy,
            entries: sources,
            prefixEnvelopes,
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
        throw new StorageConflictError('share publication did not promote');
      }
      return await this.view(promoted, request.browserReviewBase);
    } finally {
      outbox.close();
      zeroCredentials(credentials);
    }
  }

  /** Authoritatively delete the room. Local erasure is a separate fenced step. */
  async deleteRemote(): Promise<ShareRecordView> {
    const record = await this.inspectRecord();
    if (!record) throw new BrowserStorageError('workspace has no active share');
    const rootKey = await this.storage.getWorkspaceRootKey(this.workspaceId);
    if (!rootKey) throw new BrowserStorageError('workspace key is unavailable');
    const capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
    const credentials = ownerCredentialsFromInviteCapability(capability, record.roomId);
    try {
      const deleted = await (this.dependencies.deleteRoom ?? deleteOwnedRoom)({
        relayUrl: record.relayUrl,
        roomId: record.roomId,
        identity: credentials.identity,
        admissionKey: credentials.keys.admissionKey,
      });
      if (!deleted) throw new Error('The review room could not be stopped; the existing link may still work.');
      return record;
    } finally {
      zeroCredentials(credentials);
    }
  }

  async eraseLocal(record: ShareRecordView): Promise<void> {
    if (record.workspaceId !== this.workspaceId) {
      throw new StorageConflictError('share erase is bound to another workspace');
    }
    await this.storage.shares.forgetShareFenced(
      this.workspaceId,
      record.capId,
      this.fence,
    );
  }

  private async inspectRecord(): Promise<ShareRecordView | null> {
    const active = (await this.storage.shares.listShares(this.workspaceId))
      .filter((share) => share.publication !== 'stopped');
    if (active.length > 1) throw new StorageConflictError('workspace has multiple active shares');
    return active[0] ?? null;
  }

  private async view(
    record: ShareRecordView,
    browserReviewBase: string,
  ): Promise<BrowserWorkspaceShareView> {
    const rootKey = await this.storage.getWorkspaceRootKey(this.workspaceId);
    if (!rootKey) throw new BrowserStorageError('workspace key is unavailable');
    const capability = await this.storage.shares.openShare(rootKey, this.workspaceId, record.capId);
    const credentials = ownerCredentialsFromInviteCapability(capability, record.roomId);
    try {
      const published = record.publication === 'published';
      const expired = credentials.policy.expiresAt <= this.timestamp();
      return {
        workspaceId: this.workspaceId,
        capId: record.capId,
        roomId: record.roomId,
        scopeKind: record.scopeKind,
        paths: [...(capability.sharePaths ?? capability.publishedManifest?.entries.map((entry) => entry.path) ?? [])],
        publication: record.publication,
        mode: credentials.policy.mode,
        expiresAt: credentials.policy.expiresAt,
        expired,
        resumable: record.publication === 'pending',
        invite: published && !expired
          ? composeInviteForms(credentials.roomSecret, browserReviewBase)
          : null,
      };
    } finally {
      zeroCredentials(credentials);
    }
  }

  private async resolvePaths(
    scopeKind: ShareScopeKind,
    requested: readonly string[],
  ): Promise<string[]> {
    const entries = await this.storage.workspaces.listEntries(this.workspaceId);
    const live = new Map(entries.map((entry) => [entry.path, entry]));
    const paths = scopeKind === 'workspace'
      ? entries.map((entry) => entry.path)
      : requested.map((path) => normalizeEntryPath(path));
    if (scopeKind === 'file' && paths.length !== 1) {
      throw new BrowserStorageError('current-file share requires exactly one path');
    }
    if (paths.length === 0) throw new BrowserStorageError('share scope cannot be empty');
    const unique = new Set(paths);
    if (unique.size !== paths.length) throw new BrowserStorageError('share scope contains duplicate paths');
    for (const path of paths) {
      if (!live.has(path)) throw new StorageConflictError('share scope contains a stale path');
    }
    if (![...unique].some((path) => live.get(path)?.kind === 'markdown')) {
      throw new BrowserStorageError('share scope must contain at least one Markdown file');
    }
    return [...unique].sort(compareManifestPathsUtf8);
  }

  private async loadSources(paths: readonly string[]): Promise<BrowserSnapshotEntry[]> {
    const sources: BrowserSnapshotEntry[] = [];
    try {
      for (const path of paths) {
        const entry = await this.storage.workspaces.getEntry(this.workspaceId, path);
        if (!entry) throw new StorageConflictError('share scope changed before publication');
        const bytes = await this.storage.workspaces.getRevisionBody(
          this.workspaceId,
          path,
          entry.headRevisionId,
        );
        sources.push(entry.kind === 'markdown'
          ? { path, docType: 'markdown', bytes, revisionId: entry.headRevisionId }
          : {
              path,
              docType: 'asset',
              mediaType: entry.mediaType ?? 'application/octet-stream',
              bytes,
              revisionId: entry.headRevisionId,
            });
      }
      return sources;
    } catch (error) {
      zeroSources(sources);
      throw error;
    }
  }

  private makeOutbox(
    relayUrl: string,
    credentials: BrowserOwnerCredentials,
  ): BrowserWorkspaceShareOutbox {
    if (this.dependencies.outboxFactory) {
      return this.dependencies.outboxFactory({ storage: this.storage, relayUrl, credentials });
    }
    const persistence: BrowserOutboxPersistence = {
      loadPending: () => this.storage.listOutbox(credentials.roomId, credentials.identity.deviceId),
      putPending: async (envelope) => { await this.storage.putOutbox(credentials.roomId, envelope); },
      putPendingBatch: async (envelopes) => {
        await this.storage.putOutboxBatch(credentials.roomId, envelopes);
      },
      acknowledge: async (batch, accepted) => {
        await this.storage.acknowledge(credentials.roomId, batch, accepted);
      },
    };
    return new BrowserOutbox({
      relayUrl,
      roomId: credentials.roomId,
      deviceId: credentials.identity.deviceId,
      admissionKey: credentials.keys.admissionKey,
      powBits: credentials.policy.powBits,
      maxEventBytes: credentials.policy.maxEventBytes,
      maxSnapshotBytes: credentials.policy.maxSnapshotBytes,
      persistence,
    });
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BrowserStorageError('share clock is invalid');
    }
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
  createdAt: number,
) {
  const identity = credentials.identity;
  const common = {
    eventKey: credentials.keys.eventKey,
    signingSecret: identity.signingSecret,
    signingPublic: identity.signingPublic,
    roomId: credentials.roomId,
    authorId: identity.participantId,
    deviceId: identity.deviceId,
    expiresAt: credentials.policy.expiresAt,
  } as const;
  const roomCreated = assembleBrowserEvent({
    ...common,
    createdAt,
    body: {
      type: 'room_created',
      roomId: credentials.roomId,
      policy: credentials.policy,
      createdBy: identity.participantId,
    },
  });
  const ownerJoined = assembleBrowserEvent({
    ...common,
    createdAt: createdAt + 1,
    body: {
      type: 'participant_joined',
      participant: {
        participantId: identity.participantId,
        displayName: displayName?.trim() || 'Browser owner',
        kind: 'owner',
        publicSigningKey: base64UrlEncode(identity.signingPublic),
        capabilities: [...OWNER_CAPABILITIES],
      },
      device: {
        deviceId: identity.deviceId,
        participantId: identity.participantId,
        publicEncryptionKey: base64UrlEncode(identity.publicEncryptionKey),
        publicSigningKey: base64UrlEncode(identity.signingPublic),
        client: 'attn-browser',
        createdAt: createdAt + 1,
      },
    },
  });
  return [roomCreated.envelope, ownerJoined.envelope] as const;
}

function validateRequest(request: BrowserWorkspaceShareRequest): void {
  if (request.mode !== undefined && !['live', 'async', 'hybrid'].includes(request.mode)) {
    throw new BrowserStorageError('share mode is invalid');
  }
  if (
    request.ttlMs !== undefined
    && ![
      BROWSER_SHARE_TTL_ONE_HOUR,
      BROWSER_SHARE_TTL_ONE_DAY,
      BROWSER_SHARE_TTL_SEVEN_DAYS,
    ].includes(request.ttlMs)
  ) {
    throw new BrowserStorageError('share lifetime is invalid');
  }
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
  credentials.identity.signingSecret.fill(0);
  credentials.identity.signingPublic.fill(0);
  credentials.identity.encryptionSecret.fill(0);
  credentials.identity.publicEncryptionKey.fill(0);
}

function zeroBootstrapKeys(bootstrap: OwnedRoomBootstrap): void {
  bootstrap.keys.rootKey.fill(0);
  bootstrap.keys.eventKey.fill(0);
  bootstrap.keys.snapshotKey.fill(0);
  bootstrap.keys.signalingKey.fill(0);
  bootstrap.keys.admissionKey.fill(0);
}
