import { DurableObject } from "cloudflare:workers";
import { base64UrlDecode, base64UrlEncode, canonicalRequest, constantTimeEquals, verifyAdmissionV3 } from "./admission";
import { INTERNAL_EDGE_ORIGIN_HEADER, parseEdgeOriginContext } from "./browser-origin";
import { canonicalize } from "./canonical";
import {
  DeviceProofError,
  verifyDeviceHttpProofV3,
  verifyDeviceProofSignature,
} from "./device-proof";
import type { Env } from "./env";
import { encodeOpaqueSegment } from "./opaque-key";
import { verifyOwnerSignature } from "./owner-sig";
import { verifyPow } from "./pow";
import { deleteShareArtifacts, shareArtifactObjectKey } from "./r2";
import {
  deviceRegistrationSchemaV3,
  durableReviewSubmissionSchema,
  type DeviceRegistrationRequestV3,
  type DurableReviewSubmission,
} from "./schema";
import {
  MAX_PUSH_SUBSCRIPTIONS,
  parsePushSubscriptionInput,
  PUSH_DEBOUNCE_MS,
  PUSH_SUBSCRIPTION_PREFIX,
  pushLastSentKey,
  pushPublicConfig,
  publicPushSubscription,
  pushSubscriptionKey,
  sendPayloadlessPush,
  type StoredPushSubscription,
} from "./web-push";

const LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_MAILBOX_ITEMS = 500;
const MAX_MAILBOX_BYTES = 25 * 1024 * 1024;
const MAX_BATCH = 32;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_FILES = 64;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SHARE_SNAPSHOT_BYTES = 25 * 1024 * 1024;
const PUSH_SUBSCRIPTION_BODY_MAX_BYTES = 4096;
const CLEANUP_RETRY_MS = 60 * 1000;
const WATCH_PING_INTERVAL_MS = 30 * 1000;
const WATCH_IDLE_TIMEOUT_MS = 90 * 1000;
const WATCH_CLOSE_ADMISSION_INVALID = 4000;
const WATCH_CLOSE_REVOKED = 4001;
const WATCH_CLOSE_IDLE = 4002;
const WATCH_CLOSE_CAP = 4003;
const MAX_WATCH_FRAME_BYTES = 1024;

interface ShareSnapshotRef {
  fileId: string;
  snapshotId: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  uploadedAt: number;
}

interface StoredShareSnapshotRef extends ShareSnapshotRef {
  /** Relay-minted opaque component. Never crosses the public API. */
  artifactId: string;
}

/**
 * Snapshot uploads stage here and only enter the public record when an owner
 * upsert commits the full manifest together with re-sealed bundles. Joiners
 * therefore never observe a record whose revision/manifest is ahead of its
 * sealed capability bundles.
 */
interface StagedShareSnapshotRef extends StoredShareSnapshotRef {
  stagedAt: number;
  /** Retained so abandoned-staging cleanup can address R2 without a record. */
  shareId: string;
}

const STAGED_SNAPSHOT_PREFIX = "staging:snapshot:";
const STAGED_SNAPSHOT_TTL_MS = 60 * 60 * 1000;

interface ShareCleanup {
  shareId: string;
  reason: "revoked" | "expired";
  startedAt: number;
  epoch: number;
  revision: number;
}

type ShareTier = "view" | "comment" | "suggest";

interface ShareBundleEntry {
  bundleId: string;
  tier: ShareTier;
  readAdmissionKey: string;
  writeAdmissionKey?: string;
  sealedBundle: string;
}

interface ShareRecord {
  v: 3;
  shareId: string;
  ownerSigningKey: string;
  /** Legacy single-capability fields. New tier-safe shares use bundles. */
  readAdmissionKey?: string;
  writeAdmissionKey?: string;
  bundles?: ShareBundleEntry[];
  epoch: number;
  revision: number;
  currentRoomId?: string;
  snapshots: StoredShareSnapshotRef[];
  placeholders: unknown[];
  updatedAt: number;
  expiresAt: number;
}

interface MailItem { seq: number; envelopeId: string; bytes: number; payload: unknown; bundleId?: string; tier?: ShareTier; epoch?: number }
interface MailIndex { seq: number; payloadHash: string; expiresAt: number }

type PublicShareRecord = Omit<ShareRecord, "readAdmissionKey" | "writeAdmissionKey" | "bundles" | "snapshots"> & {
  snapshots: ShareSnapshotRef[];
  manifestDigest: string;
  bundle?: Pick<ShareBundleEntry, "bundleId" | "tier" | "sealedBundle">;
  mailbox: { count: number; bytes: number; latestSeq: number };
  features: { push: boolean; vapidPublicKey?: string };
};
type ShareMutationBody = Omit<Partial<ShareRecord>, "currentRoomId"> & {
  currentRoomId?: string | null;
  deviceId?: string;
};

interface WatchAttachment { v: 1; bundleId: string; lastPongTs: number }

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "X-Attn-Allow-Browser": "true" } });
}

function shareJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "X-Attn-Allow-Browser": "true" } });
}

export class ShareDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

  override async fetch(request: Request): Promise<Response> {
    // Share creation roots an immutable owner key and mailbox sequence/cap
    // accounting is read-modify-write. Keep the full authenticated mutation
    // inside one DO concurrency gate so awaits in crypto/PoW cannot interleave
    // two requests and produce last-writer-wins ownership or duplicate seqs.
    return this.ctx.blockConcurrencyWhile(() => this.fetchSerialized(request));
  }

  private async fetchSerialized(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v3\/shares\/([^/]+)(?:\/(mailbox|watch)|\/push-subscriptions\/([^/]+)|\/snapshots\/([^/]+)(?:\/([^/]+))?)?\/?$/);
    if (!match?.[1]) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    const shareId = match[1];
    const mailbox = match[2] === "mailbox";
    const watch = match[2] === "watch";
    const pushDeviceId = match[3];
    const snapshotFileId = match[4];
    const snapshotId = match[5];
    try {
      if (watch) return await this.handleWatch(request, url, shareId);
      if (pushDeviceId !== undefined) return await this.handlePushSubscription(request, url.pathname, shareId, pushDeviceId);
      if (snapshotFileId !== undefined) return await this.handleSnapshot(request, url.pathname, shareId, snapshotFileId, snapshotId);
      if (mailbox) return await this.handleMailbox(request, url.pathname, shareId);
      if (request.method === "POST") return await this.upsert(request, url.pathname, shareId);
      if (request.method === "GET") return await this.read(request, url.pathname, shareId);
      if (request.method === "DELETE") return await this.revoke(request, url.pathname, shareId);
      return jsonError(405, "ATTN_METHOD_NOT_ALLOWED", "method not allowed");
    } catch (error) {
      const candidate = error as { code?: string; message?: string };
      const code = candidate.code ?? (error instanceof SyntaxError ? "ATTN_BODY_INVALID" : "ATTN_SHARE_INVALID");
      const status = code === "ATTN_WRITE_CAPABILITY_REQUIRED" || code.startsWith("ATTN_OWNER_SIG_")
        ? 403
        : code === "ATTN_ADMISSION_INVALID" ? 401 : 400;
      return jsonError(status, code, candidate.message ?? String(error));
    }
  }

  private async record(): Promise<ShareRecord | undefined> {
    const record = await this.ctx.storage.get<ShareRecord>("share:record");
    if (record !== undefined && !Number.isSafeInteger(record.revision)) record.revision = 0;
    return record;
  }

  private async manifestDigest(snapshots: StoredShareSnapshotRef[]): Promise<string> {
    const canonical = snapshots
      .map(({ artifactId: _artifactId, fileId, snapshotId, ciphertextBytes, ciphertextSha256, uploadedAt }) => ({
        fileId,
        snapshotId,
        ciphertextBytes,
        ciphertextSha256,
        uploadedAt,
      }))
      // Code-unit fileId order — the SAME total order the owner client's
      // digestShareSnapshotManifest and the reviewer manifest validator use
      // (web e2c6df5). localeCompare collates the base64url '-'/'_' alphabet
      // differently, so the relay-served digest could never re-verify on
      // multi-file shares and owner publishing paused forever (attn-qtz /
      // attn-40t: this cutover must ship relay + web together). For ASCII
      // fileIds, JS relational string compare IS code-unit order.
      .sort((left, right) => (left.fileId < right.fileId ? -1 : left.fileId > right.fileId ? 1 : 0));
    return base64UrlEncode(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalize(canonical)),
    )));
  }

  private async publicRecord(record: ShareRecord, selected?: ShareBundleEntry): Promise<PublicShareRecord> {
    const { readAdmissionKey: _read, writeAdmissionKey: _write, bundles: _bundles, snapshots, ...safe } = record;
    const push = await pushPublicConfig(this.env);
    return {
      ...safe,
      snapshots: snapshots.map(({ artifactId: _artifactId, ...snapshot }) => snapshot),
      manifestDigest: await this.manifestDigest(snapshots),
      ...(selected === undefined ? {} : {
        bundle: {
          bundleId: selected.bundleId,
          tier: selected.tier,
          sealedBundle: selected.sealedBundle,
        },
      }),
      mailbox: {
        count: await this.ctx.storage.get<number>("mail:count") ?? 0,
        bytes: await this.ctx.storage.get<number>("mail:bytes") ?? 0,
        latestSeq: await this.ctx.storage.get<number>("mail:seq") ?? 0,
      },
      features: {
        push: push.enabled,
        ...(push.vapidPublicKey === undefined
          ? {}
          : { vapidPublicKey: push.vapidPublicKey }),
      },
    };
  }

  private selectedBundle(request: Request, record: ShareRecord): ShareBundleEntry | Response | undefined {
    const bundles = record.bundles ?? [];
    if (bundles.length === 0) return undefined;
    const bundleId = request.headers.get("Attn-Share-Bundle");
    if (bundleId === null || !/^[A-Za-z0-9_-]{22}$/.test(bundleId)) {
      return jsonError(401, "ATTN_SHARE_BUNDLE_REQUIRED", "a valid share bundle selector is required");
    }
    return bundles.find(bundle => bundle.bundleId === bundleId)
      ?? jsonError(401, "ATTN_SHARE_BUNDLE_INVALID", "share bundle selector is invalid");
  }

  private async verifyBundleAdmission(
    request: Request,
    path: string,
    record: ShareRecord,
    required: "read" | "write",
  ): Promise<ShareBundleEntry | Response | undefined> {
    const selected = this.selectedBundle(request, record);
    if (selected instanceof Response || selected === undefined) return selected;
    if (required === "write" && selected.writeAdmissionKey === undefined) {
      return jsonError(403, "ATTN_WRITE_CAPABILITY_REQUIRED", "selected share bundle is read-only");
    }
    await verifyAdmissionV3(request, path, {
      roomId: record.shareId,
      readAdmissionKey: base64UrlDecode(selected.readAdmissionKey),
      writeAdmissionKey: base64UrlDecode(selected.writeAdmissionKey ?? selected.readAdmissionKey),
    }, required);
    return selected;
  }

  private bundleHeaders(selected: ShareBundleEntry): Headers {
    return new Headers({
      "Attn-Share-Bundle": selected.bundleId,
      "Attn-Share-Tier": selected.tier,
      "Attn-Sealed-Bundle": selected.sealedBundle,
    });
  }

  private async verifyOwner(request: Request, path: string, record: ShareRecord): Promise<void> {
    await verifyOwnerSignature(request, path, base64UrlDecode(record.ownerSigningKey));
  }

  private async verifyWritePow(request: Request, shareId: string, deviceId: string): Promise<void> {
    const now = Date.now();
    const markers = await this.ctx.storage.list<number>({ prefix: "pow:" });
    const expired = [...markers.entries()]
      .filter(([, expiresAt]) => expiresAt <= now)
      .map(([key]) => key);
    await this.deleteKeysChunked(expired);
    const token = request.headers.get("Attn-PoW") ?? "";
    await verifyPow(token, {
      roomId: shareId, deviceId, method: request.method, urlPath: new URL(request.url).pathname,
      policyPowBits: Number(this.env.MIN_POW_BITS || 12), now,
      isReplayed: async hash => (await this.ctx.storage.get(`pow:${hash}`)) !== undefined,
      markSeen: async (hash, expiresAt) => { await this.ctx.storage.put(`pow:${hash}`, expiresAt); },
    });
    await this.pruneMarkersAndSchedule(await this.record(), now);
  }

  private async deleteKeysChunked(keys: string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += 128) {
      await this.ctx.storage.delete(keys.slice(index, index + 128));
    }
  }

  private async pruneMarkersAndSchedule(record: ShareRecord | undefined, now = Date.now()): Promise<void> {
    const pow = await this.ctx.storage.list<number>({ prefix: "pow:" });
    const ids = await this.ctx.storage.list<MailIndex>({ prefix: "mail:id:" });
    const subscriptions = await this.ctx.storage.list<StoredPushSubscription>({ prefix: PUSH_SUBSCRIPTION_PREFIX });
    const expired = [
      ...[...pow.entries()].filter(([, expiresAt]) => expiresAt <= now).map(([key]) => key),
      ...[...ids.entries()].filter(([, value]) => value.expiresAt <= now).map(([key]) => key),
      ...[...subscriptions.entries()].filter(([, value]) => value.expiresAt <= now).flatMap(([key, value]) => [key, pushLastSentKey(value.deviceId)]),
    ];
    await this.deleteKeysChunked(expired);
    // Staged uploads whose publish never committed: hand their artifacts to
    // the alarm-owned delete queue atomically so a crash between the two
    // writes cannot strand R2 ciphertext.
    const staged = await this.ctx.storage.list<StagedShareSnapshotRef>({ prefix: STAGED_SNAPSHOT_PREFIX });
    const abandoned = [...staged.entries()].filter(([, value]) => value.stagedAt + STAGED_SNAPSHOT_TTL_MS <= now);
    if (abandoned.length > 0) {
      await this.ctx.storage.transaction(async transaction => {
        for (const [key, value] of abandoned) {
          await transaction.delete(key);
          await transaction.put(`artifact:delete:${value.artifactId}`, value.shareId);
        }
      });
    }
    const deadlines = [
      ...(record === undefined ? [] : [record.expiresAt]),
      ...[...pow.values()].filter(expiresAt => expiresAt > now),
      ...[...ids.values()].map(value => value.expiresAt).filter(expiresAt => expiresAt > now),
      ...[...subscriptions.values()].map(value => value.expiresAt).filter(expiresAt => expiresAt > now),
      ...[...staged.values()].map(value => value.stagedAt + STAGED_SNAPSHOT_TTL_MS).filter(deadline => deadline > now),
    ];
    const superseded = await this.ctx.storage.list<string>({ prefix: "artifact:delete:" });
    if (superseded.size > 0 || abandoned.length > 0) deadlines.push(now + CLEANUP_RETRY_MS);
    if (this.ctx.getWebSockets().length > 0) deadlines.push(now + WATCH_PING_INTERVAL_MS);
    if (deadlines.length > 0) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  private async upsert(request: Request, path: string, shareId: string): Promise<Response> {
    const body = await request.clone().json() as ShareMutationBody;
    const allowed = new Set(["v", "ownerSigningKey", "readAdmissionKey", "writeAdmissionKey", "bundles", "epoch", "revision", "currentRoomId", "snapshots", "placeholders", "deviceId"]);
    if (body.v !== 3 || Object.keys(body).some(key => !allowed.has(key))) {
      return jsonError(400, "ATTN_BODY_INVALID", "share body has an invalid version or field");
    }
    const existing = await this.record();
    if (existing !== undefined && existing.expiresAt <= Date.now()) {
      await this.beginShareCleanup(existing, "expired");
      await this.finishShareCleanup();
      return jsonError(404, "ATTN_SHARE_NOT_FOUND", "expired share cannot be renewed");
    }
    const ownerKey = existing?.ownerSigningKey ?? body.ownerSigningKey;
    if (!ownerKey || base64UrlDecode(ownerKey).length !== 32) {
      return jsonError(400, "ATTN_BODY_INVALID", "ownerSigningKey must be 32 bytes");
    }
    const provisional: ShareRecord = existing ?? {
      v: 3, shareId, ownerSigningKey: ownerKey,
      ...(body.readAdmissionKey === undefined ? {} : { readAdmissionKey: body.readAdmissionKey }),
      ...(body.writeAdmissionKey === undefined ? {} : { writeAdmissionKey: body.writeAdmissionKey }),
      ...(body.bundles === undefined ? {} : { bundles: body.bundles }),
      epoch: 0,
      revision: 0,
      snapshots: [], placeholders: [], updatedAt: 0, expiresAt: 0,
    };
    if (existing && body.ownerSigningKey !== undefined && body.ownerSigningKey !== existing.ownerSigningKey) {
      return jsonError(409, "ATTN_SHARE_IMMUTABLE", "owner signing key is immutable");
    }
    if (existing === undefined && body.revision !== 0) {
      return jsonError(400, "ATTN_SHARE_REVISION_INVALID", "new shares require revision 0");
    }
    const revision = body.revision ?? provisional.revision;
    if (!Number.isSafeInteger(revision) || revision < provisional.revision || revision > provisional.revision + 1) {
      return jsonError(409, "ATTN_SHARE_REVISION_INVALID", "share revision must be current or current + 1");
    }
    const bundles = this.validateBundles(body.bundles, provisional.bundles ?? []);
    if (bundles instanceof Response) return bundles;
    const legacyRead = body.readAdmissionKey ?? provisional.readAdmissionKey;
    const legacyWrite = body.writeAdmissionKey ?? provisional.writeAdmissionKey;
    if (bundles.length === 0) {
      const keyValues = [legacyRead, legacyWrite] as const;
      for (const [index, value] of keyValues.entries()) {
        if (!this.isCanonicalKey(value, 32)) {
          return jsonError(400, "ATTN_BODY_INVALID", `${index === 0 ? "read" : "write"} admission key must be canonical 32-byte base64url`);
        }
      }
      if (legacyRead === legacyWrite) {
        return jsonError(400, "ATTN_BODY_INVALID", "read and write admission keys must differ");
      }
    } else if (body.readAdmissionKey !== undefined || body.writeAdmissionKey !== undefined) {
      return jsonError(400, "ATTN_BODY_INVALID", "tier-safe shares must not mix legacy admission keys with bundles");
    }
    const epoch = body.epoch ?? provisional.epoch;
    if (!Number.isSafeInteger(epoch) || epoch < provisional.epoch) {
      return jsonError(409, "ATTN_SHARE_EPOCH_INVALID", "share epoch must be a non-decreasing safe integer");
    }
    const staged = await this.stagedSnapshots();
    const snapshots = this.validateSnapshotManifest(body.snapshots, provisional.snapshots, staged, existing !== undefined);
    if (snapshots instanceof Response) return snapshots;
    const placeholders = body.placeholders ?? provisional.placeholders;
    if (!Array.isArray(snapshots) || !Array.isArray(placeholders) || snapshots.length > 64 || placeholders.length > 64) {
      return jsonError(400, "ATTN_BODY_INVALID", "snapshots and placeholders must be arrays of at most 64 entries");
    }
    if (new TextEncoder().encode(JSON.stringify({ snapshots, placeholders })).length > 256 * 1024) {
      return jsonError(413, "ATTN_SHARE_MANIFEST_TOO_LARGE", "share manifest exceeds 256 KiB");
    }
    let currentRoomId = provisional.currentRoomId;
    if (Object.hasOwn(body, "currentRoomId")) {
      if (body.currentRoomId === null) {
        currentRoomId = undefined;
      } else if (typeof body.currentRoomId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.currentRoomId)) {
        currentRoomId = body.currentRoomId;
      } else {
        return jsonError(400, "ATTN_BODY_INVALID", "currentRoomId must be null or a protocol identifier");
      }
    }
    await this.verifyOwner(request, path, provisional);
    const routingIdentityChanged = JSON.stringify({
      epoch,
      currentRoomId: currentRoomId ?? null,
      bundles: bundles.map(({ sealedBundle: _sealedBundle, ...identity }) => identity),
      legacyRead: bundles.length === 0 ? legacyRead : null,
      legacyWrite: bundles.length === 0 ? legacyWrite : null,
    }) !== JSON.stringify({
      epoch: provisional.epoch,
      currentRoomId: provisional.currentRoomId ?? null,
      bundles: (provisional.bundles ?? []).map(({ sealedBundle: _sealedBundle, ...identity }) => identity),
      legacyRead: (provisional.bundles ?? []).length === 0 ? provisional.readAdmissionKey : null,
      legacyWrite: (provisional.bundles ?? []).length === 0 ? provisional.writeAdmissionKey : null,
    });
    const sealedBundlesChanged = JSON.stringify(bundles.map(({ bundleId, sealedBundle }) => ({ bundleId, sealedBundle })))
      !== JSON.stringify((provisional.bundles ?? []).map(({ bundleId, sealedBundle }) => ({ bundleId, sealedBundle })));
    const publicRefs = (refs: StoredShareSnapshotRef[]): ShareSnapshotRef[] =>
      refs.map(({ artifactId: _artifactId, ...snapshot }) => snapshot);
    const manifestChanged = JSON.stringify(publicRefs(snapshots)) !== JSON.stringify(publicRefs(provisional.snapshots));
    const completeProjectionChanged = routingIdentityChanged || manifestChanged || sealedBundlesChanged || revision !== provisional.revision;
    if (existing !== undefined && completeProjectionChanged && (await this.ctx.storage.get<number>("mail:count") ?? 0) > 0) {
      return jsonError(409, "ATTN_SHARE_MAIL_PENDING", "drain the durable mailbox before changing share routing or capabilities");
    }
    if (existing !== undefined && ((routingIdentityChanged || manifestChanged) ? revision !== provisional.revision + 1 : revision !== provisional.revision)) {
      return jsonError(
        409,
        "ATTN_SHARE_REVISION_INVALID",
        (routingIdentityChanged || manifestChanged)
          ? "routing or manifest changes require revision current + 1"
          : "sealed-bundle synchronization must keep the current revision",
      );
    }
    const ownerId = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", base64UrlDecode(ownerKey))));
    await this.verifyWritePow(request, shareId, body.deviceId ?? ownerId);
    const now = Date.now();
    const { currentRoomId: _previousRoom, readAdmissionKey: _oldRead, writeAdmissionKey: _oldWrite, bundles: _oldBundles, ...recordBase } = provisional;
    const record: ShareRecord = {
      ...recordBase,
      ...(bundles.length === 0
        ? { readAdmissionKey: legacyRead, writeAdmissionKey: legacyWrite }
        : { bundles }),
      epoch,
      revision,
      ...(currentRoomId === undefined ? {} : { currentRoomId }),
      snapshots,
      placeholders,
      updatedAt: now,
      expiresAt: now + LIFETIME_MS,
    };
    // Commit is the only mutation joiners can observe: the manifest, the
    // sealed bundles, and the revision land in one transaction, together with
    // the staging hand-off (promoted refs stop being staged; abandoned staged
    // and superseded live artifacts become alarm-owned delete intents).
    const committedArtifacts = new Set(record.snapshots.map(snapshot => snapshot.artifactId));
    const consumeStaging = body.snapshots !== undefined;
    const orphanedArtifacts = [
      ...provisional.snapshots.filter(snapshot => !committedArtifacts.has(snapshot.artifactId)),
      ...(consumeStaging ? [...staged.values()].filter(snapshot => !committedArtifacts.has(snapshot.artifactId)) : []),
    ].map(snapshot => snapshot.artifactId);
    await this.ctx.storage.transaction(async transaction => {
      await transaction.put("share:record", record);
      if (consumeStaging) {
        for (const entry of staged.values()) {
          await transaction.delete(`${STAGED_SNAPSHOT_PREFIX}${entry.fileId}`);
        }
      }
      for (const artifactId of orphanedArtifacts) {
        await transaction.put(`artifact:delete:${artifactId}`, shareId);
      }
      if (orphanedArtifacts.length > 0) {
        await transaction.setAlarm(now + CLEANUP_RETRY_MS);
      }
    });
    for (const artifactId of orphanedArtifacts) {
      await this.deleteQueuedArtifact(shareId, artifactId);
    }
    await this.repinPushSubscriptions(record.expiresAt, now);
    if (existing !== undefined) this.broadcastShareChanged(record);
    await this.pruneMarkersAndSchedule(record, now);
    return shareJson(await this.publicRecord(record), existing ? 200 : 201);
  }

  private isCanonicalKey(value: unknown, bytes: number): value is string {
    if (typeof value !== "string") return false;
    try {
      const decoded = base64UrlDecode(value);
      return decoded.length === bytes && base64UrlEncode(decoded) === value;
    } catch {
      return false;
    }
  }

  private validateBundles(candidate: unknown, stored: ShareBundleEntry[]): ShareBundleEntry[] | Response {
    // An explicit empty array means the same as omission: keep the stored
    // bundles. Touch/renewal upserts express "no bundle change" both ways
    // (serde skips empty vecs; the web client used to send []) — rejecting []
    // turned every no-op renewal into a silently swallowed 400, which starved
    // joiners of the share_changed wake-up and pinned them to stale snapshots.
    if (candidate === undefined || (Array.isArray(candidate) && candidate.length === 0)) {
      return stored;
    }
    if (!Array.isArray(candidate) || candidate.length > 3) {
      return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "bundles must contain 1..3 tier entries");
    }
    const allowed = new Set(["bundleId", "tier", "readAdmissionKey", "writeAdmissionKey", "sealedBundle"]);
    const tiers = new Set<string>();
    const ids = new Set<string>();
    const admissions = new Set<string>();
    const normalized: ShareBundleEntry[] = [];
    for (const raw of candidate) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.has(key))) {
        return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "bundle entry has an invalid field");
      }
      const entry = raw as Partial<ShareBundleEntry>;
      if (!this.isCanonicalKey(entry.bundleId, 16) || !["view", "comment", "suggest"].includes(entry.tier ?? "")) {
        return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "bundle id or tier is invalid");
      }
      if (!this.isCanonicalKey(entry.readAdmissionKey, 32)) {
        return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "bundle read admission is invalid");
      }
      if (entry.tier === "view") {
        if (entry.writeAdmissionKey !== undefined) {
          return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "view bundle must not carry write admission");
        }
      } else if (!this.isCanonicalKey(entry.writeAdmissionKey, 32) || entry.writeAdmissionKey === entry.readAdmissionKey) {
        return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "writable bundle requires a distinct write admission");
      }
      if (typeof entry.sealedBundle !== "string" || entry.sealedBundle.length > 2800) {
        return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "sealed bundle is missing or too large");
      }
      try {
        const sealed = base64UrlDecode(entry.sealedBundle);
        if (sealed.length < 40 || sealed.length > 2048 || base64UrlEncode(sealed) !== entry.sealedBundle) {
          return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "sealed bundle must be canonical bounded ciphertext");
        }
      } catch {
        return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "sealed bundle must be canonical base64url");
      }
      const valid = entry as ShareBundleEntry;
      if (tiers.has(valid.tier) || ids.has(valid.bundleId) || admissions.has(valid.readAdmissionKey)
        || (valid.writeAdmissionKey !== undefined && admissions.has(valid.writeAdmissionKey))) {
        return jsonError(400, "ATTN_SHARE_BUNDLES_INVALID", "bundle tiers, ids, and admission keys must be unique");
      }
      const previous = stored.find(item => item.bundleId === valid.bundleId);
      if (previous !== undefined && (previous.tier !== valid.tier
        || previous.readAdmissionKey !== valid.readAdmissionKey
        || previous.writeAdmissionKey !== valid.writeAdmissionKey)) {
        return jsonError(409, "ATTN_SHARE_BUNDLE_IMMUTABLE", "bundle identity and admissions are immutable");
      }
      tiers.add(valid.tier); ids.add(valid.bundleId); admissions.add(valid.readAdmissionKey);
      if (valid.writeAdmissionKey !== undefined) admissions.add(valid.writeAdmissionKey);
      normalized.push({
        bundleId: valid.bundleId,
        tier: valid.tier,
        readAdmissionKey: valid.readAdmissionKey,
        ...(valid.writeAdmissionKey === undefined ? {} : { writeAdmissionKey: valid.writeAdmissionKey }),
        sealedBundle: valid.sealedBundle,
      });
    }
    normalized.sort((left, right) => left.tier.localeCompare(right.tier));
    return normalized;
  }

  /**
   * The snapshot manifest is server-managed: bytes enter through PUT
   * /snapshots/:fileId/:snapshotId, which stages them without touching the
   * public record. An owner upsert commits the declared manifest by resolving
   * every ref against a live or staged snapshot the DO itself stored — a
   * client can select, but never pin arbitrary caller-chosen R2 keys. A
   * create may declare only an empty manifest.
   */
  private validateSnapshotManifest(
    candidate: unknown,
    stored: StoredShareSnapshotRef[],
    staged: Map<string, StagedShareSnapshotRef>,
    exists: boolean,
  ): StoredShareSnapshotRef[] | Response {
    if (candidate === undefined) return stored;
    if (!Array.isArray(candidate) || candidate.length > MAX_SNAPSHOT_FILES) {
      return jsonError(400, "ATTN_BODY_INVALID", "snapshots must contain at most 64 latest-per-file refs");
    }
    if (!exists) {
      return candidate.length === 0
        ? []
        : jsonError(400, "ATTN_SHARE_MANIFEST_MANAGED", "upload snapshots through the share snapshot endpoint");
    }
    const live = new Map(stored.map(snapshot => [snapshot.fileId, snapshot]));
    const resolved: StoredShareSnapshotRef[] = [];
    const seen = new Set<string>();
    let retainedBytes = 0;
    for (const raw of candidate) {
      const entry = raw as Partial<ShareSnapshotRef>;
      if (typeof entry?.fileId !== "string" || seen.has(entry.fileId)) {
        return jsonError(409, "ATTN_SHARE_MANIFEST_MANAGED", "snapshot refs are server-managed");
      }
      seen.add(entry.fileId);
      const stagedMatch = staged.get(entry.fileId);
      const source = stagedMatch !== undefined && stagedMatch.snapshotId === entry.snapshotId
        ? stagedMatch
        : live.get(entry.fileId);
      if (source === undefined) {
        return jsonError(409, "ATTN_SHARE_MANIFEST_MANAGED", "snapshot refs are server-managed");
      }
      const sourceRef: ShareSnapshotRef = {
        fileId: source.fileId,
        snapshotId: source.snapshotId,
        ciphertextBytes: source.ciphertextBytes,
        ciphertextSha256: source.ciphertextSha256,
        uploadedAt: source.uploadedAt,
      };
      if (JSON.stringify(raw) !== JSON.stringify(sourceRef)) {
        return jsonError(409, "ATTN_SHARE_MANIFEST_MANAGED", "snapshot refs are server-managed");
      }
      retainedBytes += sourceRef.ciphertextBytes;
      resolved.push({ ...sourceRef, artifactId: source.artifactId });
    }
    if (retainedBytes > MAX_SHARE_SNAPSHOT_BYTES) {
      return jsonError(413, "ATTN_SHARE_SNAPSHOT_BYTES_FULL", "share retained snapshot byte cap reached");
    }
    resolved.sort((left, right) => left.fileId.localeCompare(right.fileId));
    return resolved;
  }

  private async handleSnapshot(request: Request, path: string, shareId: string, fileId: string, snapshotId?: string): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) {
      return jsonError(400, "ATTN_IDENTIFIER_INVALID", "fileId must be a protocol identifier");
    }
    const record = await this.record();
    if (!record || record.expiresAt <= Date.now()) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    if (request.method === "PUT" && snapshotId !== undefined) return this.uploadSnapshot(request, path, shareId, fileId, snapshotId, record);
    if (request.method === "GET" && snapshotId === undefined) return this.readSnapshot(request, path, shareId, fileId, record);
    // No standalone DELETE: removals are expressed by committing a manifest
    // without the file, so the record and its sealed bundles change together.
    return jsonError(405, "ATTN_METHOD_NOT_ALLOWED", "method not allowed");
  }

  private async uploadSnapshot(
    request: Request,
    path: string,
    shareId: string,
    fileId: string,
    snapshotId: string,
    record: ShareRecord,
  ): Promise<Response> {
    const declaredLength = Number(request.headers.get("Content-Length"));
    if (request.headers.has("Content-Length") && (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_SNAPSHOT_BYTES)) {
      return jsonError(413, "ATTN_SHARE_SNAPSHOT_TOO_LARGE", "snapshot ciphertext must be 1 byte..5 MiB");
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(snapshotId)) {
      return jsonError(400, "ATTN_IDENTIFIER_INVALID", "snapshotId must be a protocol identifier");
    }

    const boundedBody = await this.readBoundedSnapshotBody(request);
    if (boundedBody instanceof Response) return boundedBody;
    if (request.headers.has("Content-Length") && declaredLength !== boundedBody.byteLength) {
      return jsonError(400, "ATTN_BODY_INVALID", "Content-Length does not match snapshot ciphertext bytes");
    }
    const authenticatedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: boundedBody,
    });
    await this.verifyOwner(authenticatedRequest, path, record);
    await this.verifyWritePow(authenticatedRequest, shareId, request.headers.get("Attn-Device-Id") ?? shareId);
    const ciphertext = boundedBody;
    const actualDigest = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)));

    await this.retrySupersededArtifacts();
    const pending = await this.ctx.storage.list<string>({ prefix: "artifact:delete:" });
    if (pending.size > 0) {
      return jsonError(503, "ATTN_SHARE_CLEANUP_PENDING", "superseded snapshot cleanup is unavailable");
    }
    // Caps apply to the projected manifest: live refs overlaid by staged refs.
    const staged = await this.stagedSnapshots();
    const effective = new Map(record.snapshots.map(snapshot => [snapshot.fileId, snapshot as StoredShareSnapshotRef]));
    for (const entry of staged.values()) effective.set(entry.fileId, entry);
    const previous = effective.get(fileId);
    if (previous === undefined && effective.size >= MAX_SNAPSHOT_FILES) {
      return jsonError(413, "ATTN_SHARE_MANIFEST_FULL", "share snapshot file cap reached");
    }
    const retainedBytes = [...effective.values()].reduce((total, snapshot) => total + snapshot.ciphertextBytes, 0)
      - (previous?.ciphertextBytes ?? 0)
      + ciphertext.byteLength;
    if (retainedBytes > MAX_SHARE_SNAPSHOT_BYTES) {
      return jsonError(413, "ATTN_SHARE_SNAPSHOT_BYTES_FULL", "share retained snapshot byte cap reached");
    }

    const artifactId = crypto.randomUUID();
    const objectKey = shareArtifactObjectKey(shareId, artifactId);
    const uploadIntentKey = `artifact:delete:${artifactId}`;
    // Intent first: a crash anywhere after this point leaves an alarm-visible
    // object key that can be deleted. The staging switch below atomically
    // removes this new-object intent; the object is then owned by the staged
    // ref until an owner upsert commits or the staging TTL abandons it.
    await this.ctx.storage.put(uploadIntentKey, shareId);
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
    try {
      await this.env.RELAY_BLOBS.put(objectKey, ciphertext, {
        customMetadata: { domain: "attn-share-v1", shareId, fileId, snapshotId },
      });
    } catch {
      return jsonError(503, "ATTN_SHARE_ARTIFACT_UNAVAILABLE", "snapshot storage is unavailable");
    }
    const now = Date.now();
    const next: StagedShareSnapshotRef = {
      fileId,
      snapshotId,
      ciphertextBytes: ciphertext.byteLength,
      ciphertextSha256: actualDigest,
      uploadedAt: now,
      artifactId,
      stagedAt: now,
      shareId,
    };
    const previousStaged = staged.get(fileId);
    // Staging never touches the public record: no revision bump, no manifest
    // change, no broadcast. Joiners keep resolving the last committed
    // projection, whose sealed bundles still match it exactly.
    await this.ctx.storage.transaction(async transaction => {
      await transaction.put(`${STAGED_SNAPSHOT_PREFIX}${fileId}`, next);
      await transaction.delete(uploadIntentKey);
      if (previousStaged !== undefined) {
        await transaction.put(`artifact:delete:${previousStaged.artifactId}`, shareId);
      }
    });
    if (previousStaged !== undefined) await this.deleteQueuedArtifact(shareId, previousStaged.artifactId);
    await this.pruneMarkersAndSchedule(await this.record(), now);
    const { artifactId: _artifactId, stagedAt: _stagedAt, shareId: _shareId, ...publicRef } = next;
    return shareJson(publicRef, previous === undefined ? 201 : 200);
  }

  private async stagedSnapshots(): Promise<Map<string, StagedShareSnapshotRef>> {
    const entries = await this.ctx.storage.list<StagedShareSnapshotRef>({ prefix: STAGED_SNAPSHOT_PREFIX });
    const staged = new Map<string, StagedShareSnapshotRef>();
    for (const entry of entries.values()) staged.set(entry.fileId, entry);
    return staged;
  }

  private async readBoundedSnapshotBody(request: Request): Promise<Uint8Array | Response> {
    if (request.body === null) {
      return jsonError(400, "ATTN_BODY_INVALID", "snapshot ciphertext body is required");
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SNAPSHOT_BYTES) {
        await reader.cancel();
        return jsonError(413, "ATTN_SHARE_SNAPSHOT_TOO_LARGE", "snapshot ciphertext must be 1 byte..5 MiB");
      }
      chunks.push(value);
    }
    if (total === 0) return jsonError(400, "ATTN_BODY_INVALID", "snapshot ciphertext body is required");
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }

  private async readSnapshot(
    request: Request,
    path: string,
    shareId: string,
    fileId: string,
    record: ShareRecord,
  ): Promise<Response> {
    const selected = await this.verifyBundleAdmission(request, path, record, "read");
    if (selected instanceof Response) return selected;
    if (selected === undefined) {
      await verifyAdmissionV3(request, path, {
        roomId: shareId,
        readAdmissionKey: base64UrlDecode(record.readAdmissionKey!),
        writeAdmissionKey: base64UrlDecode(record.writeAdmissionKey!),
      }, "read");
    }
    const snapshot = record.snapshots.find(candidate => candidate.fileId === fileId);
    if (snapshot === undefined) return jsonError(404, "ATTN_SHARE_SNAPSHOT_NOT_FOUND", "snapshot not found");
    let object: R2ObjectBody | null;
    try {
      object = await this.env.RELAY_BLOBS.get(shareArtifactObjectKey(shareId, snapshot.artifactId));
    } catch {
      return jsonError(503, "ATTN_SHARE_ARTIFACT_UNAVAILABLE", "snapshot storage is unavailable");
    }
    if (object === null) return jsonError(404, "ATTN_SHARE_SNAPSHOT_NOT_FOUND", "snapshot ciphertext not found");
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(snapshot.ciphertextBytes),
      "Attn-Snapshot-Id": snapshot.snapshotId,
      "Attn-Ciphertext-Sha256": snapshot.ciphertextSha256,
      "X-Attn-Allow-Browser": "true",
    });
    if (selected !== undefined) {
      for (const [key, value] of this.bundleHeaders(selected)) headers.set(key, value);
    }
    return new Response(object.body, { status: 200, headers });
  }

  private async read(request: Request, path: string, shareId: string): Promise<Response> {
    const record = await this.record();
    if (!record || record.expiresAt <= Date.now()) return jsonError(404, "ATTN_SHARE_NOT_FOUND", `share ${shareId} not found`);
    const selected = await this.verifyBundleAdmission(request, path, record, "read");
    if (selected instanceof Response) return selected;
    if (selected === undefined) {
      await verifyAdmissionV3(request, path, {
        roomId: shareId,
        readAdmissionKey: base64UrlDecode(record.readAdmissionKey!),
        writeAdmissionKey: base64UrlDecode(record.writeAdmissionKey!),
      }, "read");
    }
    return shareJson(await this.publicRecord(record, selected));
  }

  private async revoke(request: Request, path: string, shareId: string): Promise<Response> {
    const record = await this.record();
    if (!record) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    await this.verifyOwner(request, path, record);
    await this.verifyWritePow(request, shareId, request.headers.get("Attn-Device-Id") ?? shareId);
    await this.beginShareCleanup(record, "revoked");
    await this.finishShareCleanup();
    return new Response(null, { status: 204, headers: { "X-Attn-Allow-Browser": "true" } });
  }

  private async deleteQueuedArtifact(shareId: string, artifactId: string): Promise<void> {
    try {
      await this.env.RELAY_BLOBS.delete(shareArtifactObjectKey(shareId, artifactId));
      await this.ctx.storage.delete(`artifact:delete:${artifactId}`);
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
    }
  }

  private async retrySupersededArtifacts(): Promise<void> {
    const pending = await this.ctx.storage.list<string>({ prefix: "artifact:delete:" });
    for (const [storageKey, shareId] of pending) {
      const artifactId = storageKey.slice("artifact:delete:".length);
      try {
        await this.env.RELAY_BLOBS.delete(shareArtifactObjectKey(shareId, artifactId));
        await this.ctx.storage.delete(storageKey);
      } catch {
        // Keep the durable work item. The alarm is re-armed below.
      }
    }
    if ((await this.ctx.storage.list({ prefix: "artifact:delete:" })).size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
    }
  }

  /**
   * Make a share logically dead before touching R2. The cleanup tombstone is
   * the only retained state, so a crash or bucket outage cannot resurrect the
   * share and the alarm can safely retry the same prefix deletion.
   */
  private async beginShareCleanup(record: ShareRecord, reason: ShareCleanup["reason"]): Promise<void> {
    const cleanup: ShareCleanup = {
      shareId: record.shareId,
      reason,
      startedAt: Date.now(),
      epoch: record.epoch,
      revision: record.revision,
    };
    await this.ctx.storage.transaction(async transaction => {
      const keys = [...(await transaction.list()).keys()].filter(key => key !== "share:cleanup");
      for (let index = 0; index < keys.length; index += 128) {
        await transaction.delete(keys.slice(index, index + 128));
      }
      await transaction.put("share:cleanup", cleanup);
      // The logical deletion and its recovery wake-up commit together. An
      // isolate loss after this transaction can never leave a reconnectable
      // record or live sockets without an alarm-owned terminal close.
      await transaction.setAlarm(Date.now());
    });
  }

  private async finishShareCleanup(): Promise<void> {
    const cleanup = await this.ctx.storage.get<ShareCleanup>("share:cleanup");
    if (cleanup === undefined) return;
    this.broadcastTerminalCleanup(cleanup);
    try {
      await deleteShareArtifacts(this.env, cleanup.shareId);
      await this.ctx.storage.deleteAll();
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
    }
  }

  private async handleMailbox(request: Request, path: string, shareId: string): Promise<Response> {
    const record = await this.record();
    if (!record || record.expiresAt <= Date.now()) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    if (request.method === "GET") {
      const selected = await this.verifyBundleAdmission(request, path, record, "read");
      if (selected instanceof Response) return selected;
      if (selected === undefined) {
        await verifyAdmissionV3(request, path, {
          roomId: shareId,
          readAdmissionKey: base64UrlDecode(record.readAdmissionKey!),
          writeAdmissionKey: base64UrlDecode(record.writeAdmissionKey!),
        }, "read");
      }
      const requestUrl = new URL(request.url);
      const after = Number(requestUrl.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) return jsonError(400, "ATTN_QUERY_INVALID", "after must be a non-negative safe integer");
      const limit = Number(requestUrl.searchParams.get("limit") ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return jsonError(400, "ATTN_QUERY_INVALID", "limit must be in 1..100");
      const page = await this.ctx.storage.list<MailItem>({
        prefix: "mail:item:",
        startAfter: `mail:item:${after.toString().padStart(12, "0")}`,
      });
      const items = [...page.values()]
        .filter(item => selected === undefined ? item.bundleId === undefined : item.bundleId === selected.bundleId)
        .slice(0, limit);
      return shareJson({
        items,
        nextAfter: items.at(-1)?.seq ?? after,
        ...(selected === undefined ? {} : { bundle: {
          bundleId: selected.bundleId,
          tier: selected.tier,
          sealedBundle: selected.sealedBundle,
        } }),
      });
    }
    if (request.method === "DELETE") {
      await this.verifyOwner(request, path, record);
      const through = Number(new URL(request.url).searchParams.get("through"));
      if (!Number.isSafeInteger(through) || through < 0) {
        return jsonError(400, "ATTN_QUERY_INVALID", "through must be a non-negative safe integer");
      }
      await this.verifyWritePow(request, shareId, request.headers.get("Attn-Device-Id") ?? shareId);
      await this.ctx.storage.transaction(async transaction => {
        const entries = await transaction.list<MailItem>({ prefix: "mail:item:" });
        const removed = [...entries.entries()].filter(([, item]) => item.seq <= through);
        if (removed.length === 0) return;
        const keys = removed.map(([key]) => key);
        for (let index = 0; index < keys.length; index += 128) {
          await transaction.delete(keys.slice(index, index + 128));
        }
        // Keep mail:id tombstones until share expiry/revocation so a delayed
        // retry after ACK remains idempotent instead of minting a new seq.
        const removedBytes = removed.reduce((total, [, item]) => total + item.bytes, 0);
        const count = await transaction.get<number>("mail:count") ?? 0;
        const bytes = await transaction.get<number>("mail:bytes") ?? 0;
        await transaction.put({
          "mail:count": Math.max(0, count - removed.length),
          "mail:bytes": Math.max(0, bytes - removedBytes),
        });
      });
      return new Response(null, { status: 204, headers: { "X-Attn-Allow-Browser": "true" } });
    }
    if (request.method !== "POST") return jsonError(405, "ATTN_METHOD_NOT_ALLOWED", "method not allowed");
    const selected = await this.verifyBundleAdmission(request, path, record, "write");
    if (selected instanceof Response) {
      await request.body?.cancel().catch(() => undefined);
      return selected;
    }
    if (selected === undefined) {
      await verifyAdmissionV3(request, path, {
        roomId: shareId,
        readAdmissionKey: base64UrlDecode(record.readAdmissionKey!),
        writeAdmissionKey: base64UrlDecode(record.writeAdmissionKey!),
      }, "write");
    }
    const body = await request.json() as { epoch?: unknown; deviceId?: unknown; items?: unknown[] };
    if (selected !== undefined) {
      const keys = Object.keys(body).sort();
      if (keys.length !== 3 || keys[0] !== "deviceId" || keys[1] !== "epoch" || keys[2] !== "items"
        || !Number.isSafeInteger(body.epoch) || (body.epoch as number) < 0
        || typeof body.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.deviceId)) {
        return jsonError(400, "ATTN_BODY_INVALID", "bundle mailbox body must be exactly {epoch, deviceId, items}");
      }
      if (body.epoch !== record.epoch) {
        return Response.json({
          error: {
            code: "ATTN_SHARE_EPOCH_STALE",
            message: "share epoch changed; re-resolve before retrying",
            currentEpoch: record.epoch,
          },
          currentEpoch: record.epoch,
        }, { status: 409, headers: { "X-Attn-Allow-Browser": "true" } });
      }
    }
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_BATCH) return jsonError(400, "ATTN_BODY_INVALID", "items must contain 1..32 entries");
    let seq = await this.ctx.storage.get<number>("mail:seq") ?? 0;
    let bytes = await this.ctx.storage.get<number>("mail:bytes") ?? 0;
    const count = await this.ctx.storage.get<number>("mail:count") ?? 0;
    const writes: Record<string, MailItem | MailIndex | number> = {};
    const pendingIds = new Map<string, MailIndex>();
    const newItems: MailItem[] = [];
    const results: Array<{ envelopeId: string; seq: number; status: "accepted" | "duplicate" }> = [];
    for (const payload of body.items) {
      const parsed = durableReviewSubmissionSchema.safeParse(payload);
      if (!parsed.success) {
        return jsonError(400, "ATTN_BODY_INVALID", "mailbox item is not an exact bounded v3 review_submission");
      }
      const submission: DurableReviewSubmission = parsed.data;
      const routingError = this.validateDurableSubmissionRouting(
        submission, shareId, record, selected, body.deviceId,
      );
      if (routingError !== undefined) return routingError;
      const envelopeId = submission.envelopeId;
      const payloadHash = base64UrlEncode(new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ bundleId: selected?.bundleId, epoch: selected === undefined ? undefined : body.epoch, payload })),
      )));
      const pending = pendingIds.get(envelopeId);
      let existing = pending ?? await this.ctx.storage.get<MailIndex>(`mail:id:${envelopeId}`);
      if (existing !== undefined && existing.expiresAt <= Date.now()) {
        await this.ctx.storage.delete(`mail:id:${envelopeId}`);
        existing = undefined;
      }
      if (existing !== undefined) {
        if (existing.payloadHash !== payloadHash) {
          return jsonError(409, "ATTN_ENVELOPE_ID_CONFLICT", "envelopeId already names different ciphertext");
        }
        results.push({ envelopeId, seq: existing.seq, status: "duplicate" });
        continue;
      }
      const itemBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
      seq += 1;
      const index = { seq, payloadHash, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS };
      pendingIds.set(envelopeId, index);
      newItems.push({
        seq,
        envelopeId,
        payload,
        bytes: itemBytes,
        ...(selected === undefined ? {} : { bundleId: selected.bundleId, tier: selected.tier, epoch: body.epoch as number }),
      });
      results.push({ envelopeId, seq, status: "accepted" });
    }
    if (count + newItems.length > MAX_MAILBOX_ITEMS) return jsonError(413, "ATTN_SHARE_MAILBOX_FULL", "mailbox item cap reached");
    if (bytes + newItems.reduce((total, item) => total + item.bytes, 0) > MAX_MAILBOX_BYTES) {
      return jsonError(413, "ATTN_SHARE_MAILBOX_FULL", "mailbox byte cap reached");
    }
    await this.verifyWritePow(request, shareId, typeof body.deviceId === "string" ? body.deviceId : "share-mailbox");
    for (const item of newItems) {
      bytes += item.bytes;
      writes[`mail:item:${item.seq.toString().padStart(12, "0")}`] = item;
      writes[`mail:id:${item.envelopeId}`] = pendingIds.get(item.envelopeId)!;
    }
    writes["mail:seq"] = seq; writes["mail:bytes"] = bytes; writes["mail:count"] = count + newItems.length;
    await this.ctx.storage.put(writes);
    if (newItems.length > 0 && selected !== undefined && typeof body.deviceId === "string") {
      await this.notifyOfflineShareSubscribers(selected.bundleId, body.deviceId, record);
    }
    if (newItems.length > 0) {
      const nextIdExpiry = Math.min(...newItems.map(item => pendingIds.get(item.envelopeId)!.expiresAt));
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > nextIdExpiry) await this.ctx.storage.setAlarm(nextIdExpiry);
    }
    return shareJson({
      acceptedThrough: seq,
      accepted: newItems.length,
      results,
      ...(selected === undefined ? {} : { bundle: {
        bundleId: selected.bundleId,
        tier: selected.tier,
        sealedBundle: selected.sealedBundle,
      } }),
    }, newItems.length > 0 ? 201 : 200);
  }

  /**
   * Validate only cleartext routing and encrypted-envelope framing. In
   * particular, this must never decrypt or branch on ReviewEvent plaintext.
   */
  private validateDurableSubmissionRouting(
    submission: DurableReviewSubmission,
    shareId: string,
    record: ShareRecord,
    selected: ShareBundleEntry | undefined,
    requestDeviceId: unknown,
  ): Response | undefined {
    if (submission.shareId !== shareId
      || submission.epoch !== record.epoch
      || submission.roomId !== record.currentRoomId
      || submission.deviceRegistration.deviceId !== requestDeviceId) {
      return jsonError(400, "ATTN_BODY_INVALID", "review_submission routing context is invalid");
    }
    if (selected === undefined) {
      if (submission.bundleId !== undefined) {
        return jsonError(400, "ATTN_BODY_INVALID", "legacy share submission must not name a bundle");
      }
    } else if (submission.bundleId !== selected.bundleId || submission.tier !== selected.tier) {
      return jsonError(400, "ATTN_BODY_INVALID", "review_submission bundle or tier is invalid");
    }
    for (const envelope of submission.envelopes) {
      let nonce: Uint8Array;
      let ciphertext: Uint8Array;
      try {
        nonce = base64UrlDecode(envelope.nonce);
        ciphertext = base64UrlDecode(envelope.ciphertext);
      } catch {
        return jsonError(400, "ATTN_BODY_INVALID", "review_submission envelope encoding is invalid");
      }
      if (nonce.byteLength !== 24 || ciphertext.byteLength !== envelope.ciphertextBytes) {
        return jsonError(400, "ATTN_BODY_INVALID", "review_submission envelope byte counts are invalid");
      }
    }
    return undefined;
  }

  private async handlePushSubscription(
    request: Request,
    path: string,
    shareId: string,
    deviceId: string,
  ): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId) || request.headers.get("Attn-Device-Id") !== deviceId) {
      return jsonError(400, "ATTN_DEVICE_ID_INVALID", "path and Attn-Device-Id must name the same protocol device");
    }
    let authenticatedRequest = request;
    let postBody: Uint8Array | undefined;
    if (request.method === "POST") {
      const bounded = await this.readBoundedPushBody(request);
      if (bounded instanceof Response) return bounded;
      postBody = bounded;
      authenticatedRequest = new Request(request.url, { method: request.method, headers: request.headers, body: postBody });
    }
    const record = await this.record();
    if (!record || record.expiresAt <= Date.now()) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    const required = request.method === "GET" ? "read" : "write";
    const selected = await this.verifyBundleAdmission(authenticatedRequest, path, record, required);
    if (selected instanceof Response) return selected;
    if (selected === undefined) return jsonError(400, "ATTN_SHARE_BUNDLE_REQUIRED", "push subscriptions require a tiered share bundle");
    const key = pushSubscriptionKey(deviceId);
    const existing = await this.ctx.storage.get<StoredPushSubscription>(key);

    if (request.method === "GET") {
      if (existing === undefined || existing.bundleId !== selected.bundleId || existing.expiresAt <= Date.now()) {
        return jsonError(404, "ATTN_PUSH_SUBSCRIPTION_NOT_FOUND", "push subscription not found");
      }
      return shareJson(publicPushSubscription(existing));
    }
    if (request.method !== "POST" && request.method !== "DELETE") {
      return jsonError(405, "ATTN_METHOD_NOT_ALLOWED", "method not allowed");
    }

    let registration: DeviceRegistrationRequestV3 | undefined;
    if (request.method === "POST" && existing === undefined) {
      const parsedRegistration = this.parsePushDeviceRegistration(request);
      if (parsedRegistration instanceof Response) return parsedRegistration;
      registration = parsedRegistration;
      const registrationError = await this.verifySharePushRegistration(
        registration, record, selected, deviceId,
      );
      if (registrationError !== undefined) return registrationError;
    } else if (request.headers.has("Attn-Device-Registration")) {
      const parsedRegistration = this.parsePushDeviceRegistration(request);
      if (parsedRegistration instanceof Response) return parsedRegistration;
      registration = parsedRegistration;
      const registrationError = await this.verifySharePushRegistration(
        registration, record, selected, deviceId,
      );
      if (registrationError !== undefined) return registrationError;
      if (existing !== undefined && existing.devicePublicSigningKey !== registration.publicSigningKey) {
        return jsonError(409, "ATTN_DEVICE_KEY_CHANGED", "push device signing key is immutable");
      }
    }

    const publicSigningKey = existing?.devicePublicSigningKey ?? registration?.publicSigningKey;
    if (publicSigningKey === undefined) {
      return jsonError(401, "ATTN_PUSH_DEVICE_UNBOUND", "push device has no authenticated key binding");
    }
    const powToken = request.headers.get("Attn-PoW") ?? "";
    try {
      await verifyDeviceHttpProofV3({
        publicSigningKey,
        signature: request.headers.get("Attn-Device-Proof") ?? "",
        resourceKind: "share",
        resourceId: shareId,
        deviceId,
        method: request.method,
        path,
        body: postBody ?? new Uint8Array(),
        powToken,
      });
    } catch (error) {
      if (error instanceof DeviceProofError) return jsonError(401, error.code, error.message);
      throw error;
    }

    if (request.method === "DELETE") {
      await this.verifyWritePow(authenticatedRequest, shareId, deviceId);
      // DELETE is deliberately existence-oblivious across sibling bundles.
      // PoW is always consumed first, and storage changes only when the
      // selected bundle owns the existing device binding.
      if (existing?.bundleId === selected.bundleId) {
        await this.ctx.storage.delete([key, pushLastSentKey(deviceId)]);
      }
      return new Response(null, { status: 204, headers: { "X-Attn-Allow-Browser": "true" } });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(new TextDecoder().decode(postBody));
    } catch {
      return jsonError(400, "ATTN_BODY_INVALID", "push subscription body is invalid JSON");
    }
    const parsed = parsePushSubscriptionInput(parsedJson, Date.now(), this.env.TEST_PUSH_ENDPOINT_ORIGIN);
    if (parsed === undefined) return jsonError(400, "ATTN_BODY_INVALID", "push subscription body is invalid");
    if (existing !== undefined && existing.bundleId !== selected.bundleId) {
      return jsonError(409, "ATTN_PUSH_SUBSCRIPTION_BINDING_CONFLICT", "push device is bound to another share bundle");
    }
    await this.verifyWritePow(authenticatedRequest, shareId, deviceId);
    const now = Date.now();
    const all = await this.ctx.storage.list<StoredPushSubscription>({ prefix: PUSH_SUBSCRIPTION_PREFIX });
    const active = [...all.values()].filter(value => value.expiresAt > now);
    const existingActive = existing !== undefined && existing.expiresAt > now;
    if (!existingActive && active.length >= MAX_PUSH_SUBSCRIPTIONS) {
      return jsonError(413, "ATTN_PUSH_SUBSCRIPTION_CAP", "push subscription cap reached");
    }
    if (active.some(value => value.deviceId !== deviceId && value.endpoint === parsed.endpoint)) {
      return jsonError(409, "ATTN_PUSH_ENDPOINT_CONFLICT", "push endpoint is already bound to another device");
    }
    const stored: StoredPushSubscription = {
      ...parsed,
      deviceId,
      bundleId: selected.bundleId,
      devicePublicSigningKey: publicSigningKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: Math.min(record.expiresAt, parsed.expirationTime ?? record.expiresAt),
    };
    const unchanged = existing !== undefined && JSON.stringify({ ...existing, updatedAt: 0 }) === JSON.stringify({ ...stored, updatedAt: 0 });
    await this.ctx.storage.put(key, unchanged ? existing : stored);
    await this.pruneMarkersAndSchedule(record, now);
    return shareJson(publicPushSubscription(unchanged ? existing : stored), unchanged ? 200 : 201);
  }

  private parsePushDeviceRegistration(request: Request): DeviceRegistrationRequestV3 | Response {
    const encoded = request.headers.get("Attn-Device-Registration");
    if (encoded === null || encoded.length === 0) {
      return jsonError(401, "ATTN_DEVICE_REGISTRATION_REQUIRED", "first push subscription requires signed v3 device registration");
    }
    let parsed: unknown;
    try {
      const bytes = base64UrlDecode(encoded);
      if (bytes.byteLength > 2_048) throw new Error("registration header is too large");
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return jsonError(400, "ATTN_DEVICE_REGISTRATION_INVALID", "device registration header is invalid");
    }
    const result = deviceRegistrationSchemaV3.safeParse(parsed);
    return result.success
      ? result.data
      : jsonError(400, "ATTN_DEVICE_REGISTRATION_INVALID", "device registration does not match v3 schema");
  }

  private async verifySharePushRegistration(
    registration: DeviceRegistrationRequestV3,
    record: ShareRecord,
    selected: ShareBundleEntry,
    deviceId: string,
  ): Promise<Response | undefined> {
    if (registration.deviceId !== deviceId || registration.client !== "attn-browser" || registration.kind !== "reviewer") {
      return jsonError(403, "ATTN_DEVICE_REGISTRATION_INVALID", "push registration identity does not match browser device");
    }
    if (record.currentRoomId === undefined ||
      (selected.tier !== "comment" && selected.tier !== "suggest") ||
      registration.grantTier !== selected.tier || registration.grantSignature === undefined) {
      return jsonError(403, "ATTN_GRANT_INVALID", "device grant does not match current share room and bundle tier");
    }
    const unsigned = {
      deviceId: registration.deviceId,
      participantId: registration.participantId,
      publicSigningKey: registration.publicSigningKey,
      publicEncryptionKey: registration.publicEncryptionKey,
      client: registration.client,
      kind: registration.kind,
      grantTier: registration.grantTier,
      grantSignature: registration.grantSignature,
    };
    try {
      await verifyDeviceProofSignature(
        registration.publicSigningKey,
        registration.selfSignature,
        new TextEncoder().encode(canonicalize(unsigned)),
      );
      await verifyDeviceProofSignature(
        record.ownerSigningKey,
        registration.grantSignature,
        new TextEncoder().encode(canonicalize({
          grantTier: registration.grantTier,
          purpose: "attn device grant v3",
          roomId: record.currentRoomId,
          v: 3,
        })),
      );
    } catch (error) {
      if (error instanceof DeviceProofError) {
        return jsonError(403, "ATTN_DEVICE_REGISTRATION_INVALID", "device self-signature or owner grant is invalid");
      }
      throw error;
    }
    return undefined;
  }

  private async readBoundedPushBody(request: Request): Promise<Uint8Array | Response> {
    if (request.body === null) return jsonError(400, "ATTN_BODY_INVALID", "push subscription body is required");
    const declared = request.headers.get("Content-Length");
    if (declared !== null) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 1 || length > PUSH_SUBSCRIPTION_BODY_MAX_BYTES) {
        return jsonError(413, "ATTN_BODY_TOO_LARGE", "push subscription body exceeds 4 KiB");
      }
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PUSH_SUBSCRIPTION_BODY_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          return jsonError(413, "ATTN_BODY_TOO_LARGE", "push subscription body exceeds 4 KiB");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (total === 0) return jsonError(400, "ATTN_BODY_INVALID", "push subscription body is required");
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  }

  private async repinPushSubscriptions(resourceExpiresAt: number, now: number): Promise<void> {
    const entries = await this.ctx.storage.list<StoredPushSubscription>({ prefix: PUSH_SUBSCRIPTION_PREFIX });
    const writes: Record<string, StoredPushSubscription> = {};
    const deletes: string[] = [];
    for (const [key, value] of entries) {
      if (value.expirationTime !== null && value.expirationTime <= now) {
        deletes.push(key, pushLastSentKey(value.deviceId));
        continue;
      }
      const expiresAt = Math.min(resourceExpiresAt, value.expirationTime ?? resourceExpiresAt);
      if (expiresAt !== value.expiresAt) writes[key] = { ...value, expiresAt };
    }
    if (Object.keys(writes).length > 0) await this.ctx.storage.put(writes);
    if (deletes.length > 0) await this.deleteKeysChunked(deletes);
  }

  private async notifyOfflineShareSubscribers(bundleId: string, senderDeviceId: string, record: ShareRecord): Promise<void> {
    // The exact three-token watch protocol intentionally carries no device ID.
    // A live watch for the selected bundle therefore suppresses bundle-local
    // push conservatively; it never suppresses or reveals sibling tiers.
    const hasLiveBundleWatch = this.ctx.getWebSockets().some(socket => this.readWatchAttachment(socket)?.bundleId === bundleId);
    if (hasLiveBundleWatch) return;
    const now = Date.now();
    const entries = await this.ctx.storage.list<StoredPushSubscription>({ prefix: PUSH_SUBSCRIPTION_PREFIX });
    const deliveries: Array<Promise<void>> = [];
    for (const [key, subscription] of entries) {
      if (subscription.bundleId !== bundleId || subscription.deviceId === senderDeviceId) continue;
      if (subscription.expiresAt <= now) {
        await this.ctx.storage.delete([key, pushLastSentKey(subscription.deviceId)]);
        continue;
      }
      const debounceKey = pushLastSentKey(subscription.deviceId);
      const lastSent = await this.ctx.storage.get<number>(debounceKey) ?? 0;
      if (now - lastSent < PUSH_DEBOUNCE_MS) continue;
      await this.ctx.storage.put(debounceKey, now);
      deliveries.push((async () => {
        const result = await sendPayloadlessPush(this.env, subscription.endpoint, now);
        if (result === "gone") await this.ctx.storage.delete([key, debounceKey]);
        if (result === "disabled") await this.ctx.storage.delete(debounceKey);
      })());
    }
    await Promise.all(deliveries);
    await this.pruneMarkersAndSchedule(record, now);
  }

  override async alarm(): Promise<void> {
    if (await this.ctx.storage.get<ShareCleanup>("share:cleanup") !== undefined) {
      await this.finishShareCleanup();
      return;
    }
    const record = await this.record();
    const now = Date.now();
    if (!record) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (record.expiresAt <= now) {
      await this.beginShareCleanup(record, "expired");
      await this.finishShareCleanup();
      return;
    }
    this.pingAndPruneWatchers(now);
    await this.retrySupersededArtifacts();
    await this.pruneMarkersAndSchedule(record, now);
  }

  private async handleWatch(request: Request, url: URL, shareId: string): Promise<Response> {
    if (request.method !== "GET") return jsonError(405, "ATTN_METHOD_NOT_ALLOWED", "method not allowed");
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket" && upgrade !== "WebSocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const record = await this.record();
    if (!record || record.expiresAt <= Date.now()) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    const edgeOrigin = parseEdgeOriginContext(request.headers.get(INTERNAL_EDGE_ORIGIN_HEADER));
    if (edgeOrigin === undefined) return jsonError(500, "ATTN_INTERNAL_CONTEXT_INVALID", "missing or malformed internal browser-origin context");
    if (edgeOrigin.kind !== "native") {
      if (edgeOrigin.kind === "invalid" || !this.allowedBrowserOrigins().has(edgeOrigin.origin)) {
        return jsonError(403, "ATTN_ORIGIN_FORBIDDEN", "browser origin is not allowed");
      }
    }

    const protocol = this.parseWatchProtocol(request.headers.get("Sec-WebSocket-Protocol"));
    if (protocol === undefined) {
      return jsonError(401, "ATTN_ADMISSION_INVALID", "watch protocol must be exactly 'attn.v3, bundle.<base64url>, read-hmac.<base64url>'");
    }
    const selected = record.bundles?.find(bundle => bundle.bundleId === protocol.bundleId);
    if (selected === undefined) return jsonError(401, "ATTN_SHARE_BUNDLE_INVALID", "share bundle selector is invalid");
    const canonical = await canonicalRequest(new Request(url.toString(), { method: "GET" }), url.pathname);
    const key = await crypto.subtle.importKey("raw", base64UrlDecode(selected.readAdmissionKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, canonical));
    if (!constantTimeEquals(expected, protocol.readHmac)) {
      return this.closedUpgrade(WATCH_CLOSE_ADMISSION_INVALID, "admission HMAC invalid");
    }

    const sockets = this.ctx.getWebSockets();
    const totalCap = Math.max(1, Number.parseInt(this.env.HARD_MAX_VIEWER_SOCKETS, 10) || 32);
    const bundleCap = Math.max(1, Math.ceil(totalCap / Math.max(1, record.bundles?.length ?? 1)));
    const bundleCount = sockets.reduce((count, socket) => count + (this.readWatchAttachment(socket)?.bundleId === selected.bundleId ? 1 : 0), 0);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`sb3:${encodeOpaqueSegment(selected.bundleId)}`]);
    this.writeWatchAttachment(server, { v: 1, bundleId: selected.bundleId, lastPongTs: Date.now() });
    if (sockets.length >= totalCap || bundleCount >= bundleCap) {
      try { server.close(WATCH_CLOSE_CAP, "share watch socket limit reached"); } catch { /* best effort */ }
    } else {
      try { server.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch { /* best effort */ }
      await this.pruneMarkersAndSchedule(record);
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "attn.v3", "X-Attn-Allow-Browser": "true" },
    });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (new TextEncoder().encode(message).byteLength > MAX_WATCH_FRAME_BYTES) {
      try { ws.close(1009, "share watch frame too large"); } catch { /* best effort */ }
      return;
    }
    try {
      const frame = JSON.parse(message) as Record<string, unknown>;
      const attachment = this.readWatchAttachment(ws);
      if (attachment !== undefined && frame.type === "pong") {
        this.writeWatchAttachment(ws, { ...attachment, lastPongTs: Date.now() });
      }
    } catch { /* malformed watch frames are ignored */ }
  }

  override async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {}

  private parseWatchProtocol(header: string | null): { bundleId: string; readHmac: Uint8Array } | undefined {
    // Preserve empty components: `attn.v3,,bundle...`, a trailing comma, or
    // any other empty extra is not the exact three-token browser protocol.
    const tokens = header?.split(",").map(token => token.trim());
    if (tokens?.length !== 3 || tokens[0] !== "attn.v3" || !tokens[1]?.startsWith("bundle.") || !tokens[2]?.startsWith("read-hmac.")) return undefined;
    try {
      const bundleId = tokens[1].slice("bundle.".length);
      const bundleBytes = base64UrlDecode(bundleId);
      const readHmac = base64UrlDecode(tokens[2].slice("read-hmac.".length));
      return bundleBytes.length === 16 && base64UrlEncode(bundleBytes) === bundleId && readHmac.length === 32
        ? { bundleId, readHmac }
        : undefined;
    } catch { return undefined; }
  }

  private allowedBrowserOrigins(): Set<string> {
    return new Set((this.env.ALLOWED_BROWSER_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean));
  }

  private closedUpgrade(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    try { server.close(code, reason); } catch { /* best effort */ }
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": "attn.v3", "X-Attn-Allow-Browser": "true" },
    });
  }

  private readWatchAttachment(ws: WebSocket): WatchAttachment | undefined {
    const raw = ws.deserializeAttachment() as Partial<WatchAttachment> | null;
    return raw?.v === 1 && typeof raw.bundleId === "string" && typeof raw.lastPongTs === "number"
      ? raw as WatchAttachment
      : undefined;
  }

  private writeWatchAttachment(ws: WebSocket, attachment: WatchAttachment): void { ws.serializeAttachment(attachment); }

  private broadcastShareChanged(record: Pick<ShareRecord, "epoch" | "revision">, terminal = false): void {
    const frame = JSON.stringify({ type: "share_changed", epoch: record.epoch, revision: record.revision });
    for (const socket of this.ctx.getWebSockets()) {
      if (this.readWatchAttachment(socket) === undefined) continue;
      try { socket.send(frame); } catch { /* terminal close still must run */ }
      if (terminal) {
        try { socket.close(WATCH_CLOSE_REVOKED, "share unavailable"); } catch { /* best effort */ }
      }
    }
  }

  private broadcastTerminalCleanup(cleanup: ShareCleanup): void {
    this.broadcastShareChanged({
      epoch: Number.isSafeInteger(cleanup.epoch) ? cleanup.epoch : 0,
      revision: Number.isSafeInteger(cleanup.revision) ? cleanup.revision : 0,
    }, true);
  }

  private pingAndPruneWatchers(now: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readWatchAttachment(socket);
      if (attachment === undefined) continue;
      if (now - attachment.lastPongTs >= WATCH_IDLE_TIMEOUT_MS) {
        try { socket.close(WATCH_CLOSE_IDLE, "share watch idle timeout"); } catch { /* best effort */ }
      } else {
        try { socket.send(JSON.stringify({ type: "ping", ts: now })); } catch { /* best effort */ }
      }
    }
  }
}
