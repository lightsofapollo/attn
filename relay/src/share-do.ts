import { DurableObject } from "cloudflare:workers";
import { base64UrlDecode, base64UrlEncode, verifyAdmissionV3 } from "./admission";
import type { Env } from "./env";
import { verifyOwnerSignature } from "./owner-sig";
import { verifyPow } from "./pow";
import { deleteShareArtifacts, shareArtifactObjectKey } from "./r2";

const LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_MAILBOX_ITEMS = 500;
const MAX_MAILBOX_BYTES = 25 * 1024 * 1024;
const MAX_BATCH = 32;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_FILES = 64;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SHARE_SNAPSHOT_BYTES = 25 * 1024 * 1024;
const CLEANUP_RETRY_MS = 60 * 1000;

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

interface ShareCleanup {
  shareId: string;
  reason: "revoked" | "expired";
  startedAt: number;
}

interface ShareRecord {
  v: 3;
  shareId: string;
  ownerSigningKey: string;
  readAdmissionKey: string;
  writeAdmissionKey: string;
  epoch: number;
  currentRoomId?: string;
  snapshots: StoredShareSnapshotRef[];
  placeholders: unknown[];
  updatedAt: number;
  expiresAt: number;
}

interface MailItem { seq: number; envelopeId: string; bytes: number; payload: unknown }
interface MailIndex { seq: number; payloadHash: string; expiresAt: number }

type PublicShareRecord = Omit<ShareRecord, "readAdmissionKey" | "writeAdmissionKey" | "snapshots"> & {
  snapshots: ShareSnapshotRef[];
  mailbox: { count: number; bytes: number; latestSeq: number };
  features: { push: false };
};
type ShareMutationBody = Omit<Partial<ShareRecord>, "currentRoomId"> & {
  currentRoomId?: string | null;
  deviceId?: string;
};

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
    const match = url.pathname.match(/^\/v3\/shares\/([^/]+)(?:\/(mailbox)|\/snapshots\/([^/]+)(?:\/([^/]+))?)?\/?$/);
    if (!match?.[1]) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    const shareId = match[1];
    const mailbox = match[2] === "mailbox";
    const snapshotFileId = match[3];
    const snapshotId = match[4];
    try {
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
    return this.ctx.storage.get<ShareRecord>("share:record");
  }

  private async publicRecord(record: ShareRecord): Promise<PublicShareRecord> {
    const { readAdmissionKey: _read, writeAdmissionKey: _write, snapshots, ...safe } = record;
    return {
      ...safe,
      snapshots: snapshots.map(({ artifactId: _artifactId, ...snapshot }) => snapshot),
      mailbox: {
        count: await this.ctx.storage.get<number>("mail:count") ?? 0,
        bytes: await this.ctx.storage.get<number>("mail:bytes") ?? 0,
        latestSeq: await this.ctx.storage.get<number>("mail:seq") ?? 0,
      },
      features: { push: false },
    };
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
    const expired = [
      ...[...pow.entries()].filter(([, expiresAt]) => expiresAt <= now).map(([key]) => key),
      ...[...ids.entries()].filter(([, value]) => value.expiresAt <= now).map(([key]) => key),
    ];
    await this.deleteKeysChunked(expired);
    const deadlines = [
      ...(record === undefined ? [] : [record.expiresAt]),
      ...[...pow.values()].filter(expiresAt => expiresAt > now),
      ...[...ids.values()].map(value => value.expiresAt).filter(expiresAt => expiresAt > now),
    ];
    const superseded = await this.ctx.storage.list<string>({ prefix: "artifact:delete:" });
    if (superseded.size > 0) deadlines.push(now + CLEANUP_RETRY_MS);
    if (deadlines.length > 0) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  private async upsert(request: Request, path: string, shareId: string): Promise<Response> {
    const body = await request.clone().json() as ShareMutationBody;
    const allowed = new Set(["v", "ownerSigningKey", "readAdmissionKey", "writeAdmissionKey", "epoch", "currentRoomId", "snapshots", "placeholders", "deviceId"]);
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
      readAdmissionKey: body.readAdmissionKey ?? "",
      writeAdmissionKey: body.writeAdmissionKey ?? "",
      epoch: 0,
      snapshots: [], placeholders: [], updatedAt: 0, expiresAt: 0,
    };
    if (existing && body.ownerSigningKey !== undefined && body.ownerSigningKey !== existing.ownerSigningKey) {
      return jsonError(409, "ATTN_SHARE_IMMUTABLE", "owner signing key is immutable");
    }
    const keyValues = [body.readAdmissionKey ?? provisional.readAdmissionKey, body.writeAdmissionKey ?? provisional.writeAdmissionKey] as const;
    for (const [index, value] of keyValues.entries()) {
      try {
        if (base64UrlDecode(value).length !== 32 || base64UrlEncode(base64UrlDecode(value)) !== value) {
          return jsonError(400, "ATTN_BODY_INVALID", `${index === 0 ? "read" : "write"} admission key must be canonical 32-byte base64url`);
        }
      } catch {
        return jsonError(400, "ATTN_BODY_INVALID", "admission keys must be canonical base64url");
      }
    }
    if (keyValues[0] === keyValues[1]) {
      return jsonError(400, "ATTN_BODY_INVALID", "read and write admission keys must differ");
    }
    const epoch = body.epoch ?? provisional.epoch;
    if (!Number.isSafeInteger(epoch) || epoch < provisional.epoch) {
      return jsonError(409, "ATTN_SHARE_EPOCH_INVALID", "share epoch must be a non-decreasing safe integer");
    }
    const snapshots = this.validateSnapshotManifest(body.snapshots, provisional.snapshots, existing !== undefined);
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
    const ownerId = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", base64UrlDecode(ownerKey))));
    await this.verifyWritePow(request, shareId, body.deviceId ?? ownerId);
    const now = Date.now();
    const { currentRoomId: _previousRoom, ...recordBase } = provisional;
    const record: ShareRecord = {
      ...recordBase,
      epoch,
      ...(currentRoomId === undefined ? {} : { currentRoomId }),
      snapshots,
      placeholders,
      updatedAt: now,
      expiresAt: now + LIFETIME_MS,
    };
    await this.ctx.storage.put("share:record", record);
    await this.pruneMarkersAndSchedule(record, now);
    return shareJson(await this.publicRecord(record), existing ? 200 : 201);
  }

  /**
   * The snapshot manifest is server-managed by PUT /snapshots/:fileId. A
   * create may declare only an empty manifest; a later owner touch may omit it
   * or echo the exact public manifest. This prevents a client from pinning
   * arbitrary caller-selected R2 keys through the generic share mutation.
   */
  private validateSnapshotManifest(
    candidate: unknown,
    stored: StoredShareSnapshotRef[],
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
    const publicStored = stored.map(({ artifactId: _artifactId, ...snapshot }) => snapshot);
    if (JSON.stringify(candidate) !== JSON.stringify(publicStored)) {
      return jsonError(409, "ATTN_SHARE_MANIFEST_MANAGED", "snapshot refs are server-managed");
    }
    return stored;
  }

  private async handleSnapshot(request: Request, path: string, shareId: string, fileId: string, snapshotId?: string): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) {
      return jsonError(400, "ATTN_IDENTIFIER_INVALID", "fileId must be a protocol identifier");
    }
    const record = await this.record();
    if (!record || record.expiresAt <= Date.now()) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    if (request.method === "PUT" && snapshotId !== undefined) return this.uploadSnapshot(request, path, shareId, fileId, snapshotId, record);
    if (request.method === "GET" && snapshotId === undefined) return this.readSnapshot(request, path, shareId, fileId, record);
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
    const previousIndex = record.snapshots.findIndex(snapshot => snapshot.fileId === fileId);
    if (previousIndex < 0 && record.snapshots.length >= MAX_SNAPSHOT_FILES) {
      return jsonError(413, "ATTN_SHARE_MANIFEST_FULL", "share snapshot file cap reached");
    }
    const previous = previousIndex < 0 ? undefined : record.snapshots[previousIndex];
    const retainedBytes = record.snapshots.reduce((total, snapshot) => total + snapshot.ciphertextBytes, 0)
      - (previous?.ciphertextBytes ?? 0)
      + ciphertext.byteLength;
    if (retainedBytes > MAX_SHARE_SNAPSHOT_BYTES) {
      return jsonError(413, "ATTN_SHARE_SNAPSHOT_BYTES_FULL", "share retained snapshot byte cap reached");
    }

    const artifactId = crypto.randomUUID();
    const objectKey = shareArtifactObjectKey(shareId, artifactId);
    const uploadIntentKey = `artifact:delete:${artifactId}`;
    // Intent first: a crash anywhere after this point leaves an alarm-visible
    // object key that can be deleted. The manifest switch below atomically
    // removes this new-object intent and adds the superseded-object intent.
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
    const next: StoredShareSnapshotRef = {
      fileId,
      snapshotId,
      ciphertextBytes: ciphertext.byteLength,
      ciphertextSha256: actualDigest,
      uploadedAt: now,
      artifactId,
    };
    const snapshots = [...record.snapshots];
    if (previousIndex < 0) snapshots.push(next); else snapshots[previousIndex] = next;
    snapshots.sort((left, right) => left.fileId.localeCompare(right.fileId));
    await this.ctx.storage.transaction(async transaction => {
      await transaction.put("share:record", {
        ...record,
        snapshots,
        updatedAt: now,
        expiresAt: now + LIFETIME_MS,
      } satisfies ShareRecord);
      await transaction.delete(uploadIntentKey);
      if (previous !== undefined) {
        await transaction.put(`artifact:delete:${previous.artifactId}`, shareId);
      }
    });
    if (previous !== undefined) await this.deleteQueuedArtifact(shareId, previous.artifactId);
    await this.pruneMarkersAndSchedule(await this.record(), now);
    const { artifactId: _artifactId, ...publicRef } = next;
    return shareJson(publicRef, previous === undefined ? 201 : 200);
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
    await verifyAdmissionV3(request, path, {
      roomId: shareId,
      readAdmissionKey: base64UrlDecode(record.readAdmissionKey),
      writeAdmissionKey: base64UrlDecode(record.writeAdmissionKey),
    }, "read");
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
    return new Response(object.body, { status: 200, headers });
  }

  private async read(request: Request, path: string, shareId: string): Promise<Response> {
    const record = await this.record();
    if (!record || record.expiresAt <= Date.now()) return jsonError(404, "ATTN_SHARE_NOT_FOUND", `share ${shareId} not found`);
    await verifyAdmissionV3(request, path, {
      roomId: shareId,
      readAdmissionKey: base64UrlDecode(record.readAdmissionKey),
      writeAdmissionKey: base64UrlDecode(record.writeAdmissionKey),
    }, "read");
    return shareJson(await this.publicRecord(record));
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
    const cleanup: ShareCleanup = { shareId: record.shareId, reason, startedAt: Date.now() };
    await this.ctx.storage.transaction(async transaction => {
      const keys = [...(await transaction.list()).keys()].filter(key => key !== "share:cleanup");
      for (let index = 0; index < keys.length; index += 128) {
        await transaction.delete(keys.slice(index, index + 128));
      }
      await transaction.put("share:cleanup", cleanup);
    });
  }

  private async finishShareCleanup(): Promise<void> {
    const cleanup = await this.ctx.storage.get<ShareCleanup>("share:cleanup");
    if (cleanup === undefined) return;
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
    const admission = { roomId: shareId, readAdmissionKey: base64UrlDecode(record.readAdmissionKey), writeAdmissionKey: base64UrlDecode(record.writeAdmissionKey) };
    if (request.method === "GET") {
      await verifyAdmissionV3(request, path, admission, "read");
      const requestUrl = new URL(request.url);
      const after = Number(requestUrl.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) return jsonError(400, "ATTN_QUERY_INVALID", "after must be a non-negative safe integer");
      const limit = Number(requestUrl.searchParams.get("limit") ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return jsonError(400, "ATTN_QUERY_INVALID", "limit must be in 1..100");
      const page = await this.ctx.storage.list<MailItem>({
        prefix: "mail:item:",
        startAfter: `mail:item:${after.toString().padStart(12, "0")}`,
        limit,
      });
      const items = [...page.values()];
      return shareJson({ items, nextAfter: items.at(-1)?.seq ?? after });
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
    await verifyAdmissionV3(request, path, admission, "write");
    const body = await request.json() as { deviceId?: string; items?: unknown[] };
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_BATCH) return jsonError(400, "ATTN_BODY_INVALID", "items must contain 1..32 entries");
    let seq = await this.ctx.storage.get<number>("mail:seq") ?? 0;
    let bytes = await this.ctx.storage.get<number>("mail:bytes") ?? 0;
    const count = await this.ctx.storage.get<number>("mail:count") ?? 0;
    const writes: Record<string, MailItem | MailIndex | number> = {};
    const pendingIds = new Map<string, MailIndex>();
    const newItems: MailItem[] = [];
    const results: Array<{ envelopeId: string; seq: number; status: "accepted" | "duplicate" }> = [];
    for (const payload of body.items) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return jsonError(400, "ATTN_BODY_INVALID", "mailbox items must be envelope objects");
      }
      const envelopeId = (payload as { envelopeId?: unknown }).envelopeId;
      if (typeof envelopeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(envelopeId)) {
        return jsonError(400, "ATTN_BODY_INVALID", "mailbox envelopeId is invalid");
      }
      const payloadHash = base64UrlEncode(new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(payload)),
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
      newItems.push({ seq, envelopeId, payload, bytes: itemBytes });
      results.push({ envelopeId, seq, status: "accepted" });
    }
    if (count + newItems.length > MAX_MAILBOX_ITEMS) return jsonError(413, "ATTN_SHARE_MAILBOX_FULL", "mailbox item cap reached");
    if (bytes + newItems.reduce((total, item) => total + item.bytes, 0) > MAX_MAILBOX_BYTES) {
      return jsonError(413, "ATTN_SHARE_MAILBOX_FULL", "mailbox byte cap reached");
    }
    await this.verifyWritePow(request, shareId, body.deviceId ?? "share-mailbox");
    for (const item of newItems) {
      bytes += item.bytes;
      writes[`mail:item:${item.seq.toString().padStart(12, "0")}`] = item;
      writes[`mail:id:${item.envelopeId}`] = pendingIds.get(item.envelopeId)!;
    }
    writes["mail:seq"] = seq; writes["mail:bytes"] = bytes; writes["mail:count"] = count + newItems.length;
    await this.ctx.storage.put(writes);
    if (newItems.length > 0) {
      const nextIdExpiry = Math.min(...newItems.map(item => pendingIds.get(item.envelopeId)!.expiresAt));
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > nextIdExpiry) await this.ctx.storage.setAlarm(nextIdExpiry);
    }
    return shareJson({ acceptedThrough: seq, accepted: newItems.length, results }, newItems.length > 0 ? 201 : 200);
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
    await this.retrySupersededArtifacts();
    await this.pruneMarkersAndSchedule(record, now);
  }
}
