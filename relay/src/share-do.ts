import { DurableObject } from "cloudflare:workers";
import { base64UrlDecode, base64UrlEncode, verifyAdmissionV3 } from "./admission";
import type { Env } from "./env";
import { verifyOwnerSignature } from "./owner-sig";
import { verifyPow } from "./pow";

const LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_MAILBOX_ITEMS = 500;
const MAX_MAILBOX_BYTES = 25 * 1024 * 1024;
const MAX_BATCH = 32;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface ShareRecord {
  v: 3;
  shareId: string;
  ownerSigningKey: string;
  readAdmissionKey: string;
  writeAdmissionKey: string;
  epoch: number;
  currentRoomId?: string;
  snapshots: unknown[];
  placeholders: unknown[];
  updatedAt: number;
  expiresAt: number;
}

interface MailItem { seq: number; envelopeId: string; bytes: number; payload: unknown }
interface MailIndex { seq: number; payloadHash: string; expiresAt: number }

type PublicShareRecord = Omit<ShareRecord, "readAdmissionKey" | "writeAdmissionKey"> & {
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
    const match = url.pathname.match(/^\/v3\/shares\/([^/]+)(?:\/(mailbox))?\/?$/);
    if (!match?.[1]) return jsonError(404, "ATTN_SHARE_NOT_FOUND", "share not found");
    const shareId = match[1];
    const mailbox = match[2] === "mailbox";
    try {
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
    const { readAdmissionKey: _read, writeAdmissionKey: _write, ...safe } = record;
    return {
      ...safe,
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
    if (deadlines.length > 0) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  private async upsert(request: Request, path: string, shareId: string): Promise<Response> {
    const body = await request.clone().json() as ShareMutationBody;
    const allowed = new Set(["v", "ownerSigningKey", "readAdmissionKey", "writeAdmissionKey", "epoch", "currentRoomId", "snapshots", "placeholders", "deviceId"]);
    if (body.v !== 3 || Object.keys(body).some(key => !allowed.has(key))) {
      return jsonError(400, "ATTN_BODY_INVALID", "share body has an invalid version or field");
    }
    const existing = await this.record();
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
    const snapshots = body.snapshots ?? provisional.snapshots;
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
    await this.ctx.storage.deleteAll();
    return new Response(null, { status: 204, headers: { "X-Attn-Allow-Browser": "true" } });
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
    const record = await this.record();
    const now = Date.now();
    if (!record || record.expiresAt <= now) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.pruneMarkersAndSchedule(record, now);
  }
}
