/** zod request/response validators for HTTP API per relay-spec.md §HTTP API. */

import { z } from "zod";
import {
  DEVICE_ID_MAX_CHARS,
  ENVELOPE_ID_MAX_CHARS,
  PARTICIPANT_ID_MAX_CHARS,
} from "./opaque-key";

/**
 * Schemas land here as endpoints are implemented:
 *   - RoomCreateRequest / RoomCreateResponse  (attn-nnj.5.5) ← THIS PASS
 *   - DeviceRegisterRequest                   (attn-nnj.5.6)
 *   - EnvelopeBatchRequest / Envelope         (attn-nnj.5.7)
 *   - AckRequest                              (attn-nnj.5.8)
 *   - BlobPresignRequest                      (attn-nnj.5.10)
 *
 * Shared primitives below stay minimal until callers exist.
 */

/** base64url without padding (per relay-spec.md §Wire Conventions). */
export const b64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/, "must be base64url without padding");

/** Wire-size ceilings for fixed-size base64url-no-pad protocol fields. */
export const BASE64URL_32_BYTE_MAX_CHARS = 43;
export const BASE64URL_64_BYTE_MAX_CHARS = 86;
export const XCHACHA20_NONCE_MAX_CHARS = 32;

/** Durable-storage key components must remain small even when client-chosen. */
export { DEVICE_ID_MAX_CHARS, ENVELOPE_ID_MAX_CHARS } from "./opaque-key";

/** Unix milliseconds, integer, non-negative. */
export const unixMs = z.number().int().nonnegative();

// --- POST /v2/rooms/:roomId ----------------------------------------------

/**
 * Per relay-spec.md §POST /v2/rooms/:roomId and amendments.md decisions #8, #12.
 *
 * `policy.expiresAt` is required at the schema level — the spec describes a
 * default of "createdAt + 24h" but that default is computed by the handler
 * against `now`, not in the schema (zod has no access to wall-clock at parse).
 *
 * Bounds enforced here are the loose/sanity bounds. Hard server maxima
 * (HARD_MAX_*) are read from env and clamped inside the handler so different
 * environments (staging vs prod) can dial limits without re-shipping zod.
 */
export const policySchema = z.object({
  mode: z.enum(["live", "async", "hybrid"]),
  maxPeers: z.number().int().min(1).max(8),
  maxSnapshotBytes: z.number().int().positive(),
  maxEventBytes: z.number().int().positive(),
  maxEvents: z.number().int().positive(),
  expiresAt: z.number().int(),
  idleTimeoutMs: z.number().int().min(60_000).optional(),
  longSession: z.boolean().optional().default(false),
  powBits: z.number().int().min(12).max(24).optional().default(16),
  deleteEventsAfterOwnerAck: z.boolean().optional().default(false),
  allowBrowser: z.boolean().optional().default(false),
  allowRemoteAgents: z.boolean().optional().default(false),
});

/**
 * Body of `POST /v2/rooms/:roomId`.
 *
 * NOTE on `admissionKey`: the published relay-spec.md does NOT enumerate this
 * field in the room-create body. We add it here as the only viable resolution
 * of the chicken-and-egg in the admission-HMAC trust model:
 *
 *   - amendments.md #2 pins admission as URL-as-bearer + HMAC, with the relay
 *     storing the per-room admissionKey at `meta:admission_key`.
 *   - The relay cannot derive admissionKey from roomSecret (it never sees
 *     roomSecret), so the creator must supply it.
 *   - The first POST therefore cannot be admission-verified (no stored key
 *     yet); the trust boundary remains URL possession.
 *
 * Flag this deviation in the room-do.ts code comment and add to amendments
 * follow-ups.
 */
export const roomCreationSchema = z.object({
  v: z.literal(2),
  policy: policySchema,
  ownerSigningKey: b64url
    .min(1, "ownerSigningKey required")
    .max(BASE64URL_32_BYTE_MAX_CHARS),
  admissionKey: b64url
    .min(1, "admissionKey required")
    .max(BASE64URL_32_BYTE_MAX_CHARS),
});

/** Additive `/v3` create body; v2 schema and call sites remain unchanged. */
export const roomCreationSchemaV3 = z.object({
  v: z.literal(3),
  policy: policySchema,
  ownerSigningKey: b64url.min(1).max(BASE64URL_32_BYTE_MAX_CHARS),
  readAdmissionKey: b64url.min(1).max(BASE64URL_32_BYTE_MAX_CHARS),
  writeAdmissionKey: b64url.min(1).max(BASE64URL_32_BYTE_MAX_CHARS),
}).superRefine((body, ctx) => {
  if (constantTimeStringEquals(body.readAdmissionKey, body.writeAdmissionKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["writeAdmissionKey"],
      message: "writeAdmissionKey must differ from readAdmissionKey",
    });
  }
});

function constantTimeStringEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export type RoomCreationRequestV3 = z.infer<typeof roomCreationSchemaV3>;

export type RoomCreationRequest = z.infer<typeof roomCreationSchema>;
export type RoomPolicyInput = z.input<typeof policySchema>;
export type RoomPolicy = z.infer<typeof policySchema>;

// --- POST /v2/rooms/:roomId/devices --------------------------------------

/**
 * Per relay-spec.md §POST /v2/rooms/:roomId/devices and crypto-spec.md §Signing-Key
 * Publication.
 *
 * - `publicSigningKey` is a base64url-encoded Ed25519 32-byte key. We validate the
 *   raw shape here (string + base64url chars) and the byte-length post-decode in
 *   the handler so the schema error stays compact ("ATTN_BODY_INVALID").
 * - `publicEncryptionKey` is stored opaquely in v2 — the relay doesn't use it for
 *   transport (5.6 scope), but it's promised to peers for the future v3
 *   device-to-device E2E path.
 * - `selfSignature` is 64 bytes after decode. Verification (signed-over canonical
 *   body MINUS selfSignature) lives in the handler, not the schema.
 */
export const deviceRegistrationSchema = z.object({
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_CHARS),
  participantId: z.string().min(1).max(PARTICIPANT_ID_MAX_CHARS),
  publicSigningKey: b64url
    .min(1, "publicSigningKey required")
    .max(BASE64URL_32_BYTE_MAX_CHARS),
  publicEncryptionKey: b64url
    .min(1, "publicEncryptionKey required")
    .max(BASE64URL_32_BYTE_MAX_CHARS),
  client: z.enum(["attn-native", "attn-browser", "agent-cli"]),
  kind: z.enum(["owner", "reviewer", "agent"]),
  selfSignature: b64url
    .min(1, "selfSignature required")
    .max(BASE64URL_64_BYTE_MAX_CHARS),
});

export const deviceRegistrationSchemaV3 = deviceRegistrationSchema.extend({
  grantTier: z.enum(["comment", "suggest"]).optional(),
  grantSignature: b64url.min(1).max(BASE64URL_64_BYTE_MAX_CHARS).optional(),
}).superRefine((body, ctx) => {
  if (body.kind === "owner" && (body.grantTier !== undefined || body.grantSignature !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "v3 owner registration forbids grantTier and grantSignature",
    });
  }
  if (body.kind !== "owner" && (body.grantTier === undefined || body.grantSignature === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "v3 non-owner registration requires grantTier and grantSignature",
    });
  }
});

export type DeviceRegistrationRequest = z.infer<typeof deviceRegistrationSchema>;
export type DeviceRegistrationRequestV3 = z.infer<typeof deviceRegistrationSchemaV3>;

/**
 * Stored shape returned by `GET /v2/rooms/:roomId/devices`. Adds `registeredAt`
 * (ms-epoch) to the request body and preserves all client-supplied fields
 * (including `selfSignature` so clients can re-verify offline). Per spec we
 * return devices in registration order.
 */
export interface DeviceRecord extends DeviceRegistrationRequest {
  grantTier?: "comment" | "suggest";
  grantSignature?: string;
  registeredAt: number;
}

// --- POST /v2/rooms/:roomId/envelopes ------------------------------------

/**
 * Per relay-spec.md §POST /v2/rooms/:roomId/envelopes and amendments.md #7
 * (batch cap 32). The relay is content-agnostic past the routing tag: the
 * payload (`ciphertext`) is opaque encrypted bytes; we only validate framing.
 *
 * - `envelopeId` is client-chosen, deterministic, and used for idempotency
 *   (crypto-spec.md §Envelope IDs). We treat it as an opaque string for
 *   storage keying.
 * - `authorId` / `deviceId` must reference an existing device record; we
 *   re-check at handler time against `device:<participantId>:<deviceId>`.
 * - `kind == "signal"` may set `target.deviceId` so the relay can route the
 *   envelope to the right peer over WebSocket (5.11) and prune via the
 *   `maxSignalEnvelopes=64` sub-cap per (authorId, targetDeviceId) pair.
 * - `ciphertextBytes` is asserted equal to the decoded `ciphertext` length so
 *   we can enforce per-kind size caps without a second decode round.
 * - `nonce` is opaque to the relay, but v2 fixes it to a 24-byte XChaCha nonce
 *   (32 base64url characters), so accepting a larger stored value is neither
 *   useful nor forward-compatible within this protocol version.
 */
export const envelopeTargetSchema = z.object({
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_CHARS),
});

export const envelopeKindSchema = z.enum(["event", "snapshot_blob", "signal"]);

export const envelopeSchema = z.object({
  envelopeId: z.string().min(1).max(ENVELOPE_ID_MAX_CHARS),
  authorId: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_CHARS),
  kind: envelopeKindSchema,
  // null is a valid wire value for "no target / broadcast". zod's optional()
  // also covers the omitted case so clients can leave the key off entirely.
  target: envelopeTargetSchema.nullable().optional(),
  createdAt: unixMs,
  expiresAt: unixMs,
  nonce: b64url.min(1, "nonce required").max(XCHACHA20_NONCE_MAX_CHARS),
  ciphertext: b64url, // empty ciphertext is allowed at the schema layer; per-kind cap is enforced in handler
  ciphertextBytes: z.number().int().positive(),
  /** V3 signal-only monotonic negotiation/collaboration generation. */
  signalGeneration: z.number().int().nonnegative().optional(),
  /** Ed25519 signature by the immutable registered device key. */
  deviceSignature: b64url.max(86).optional(),
});

export const envelopeBatchSchema = z.object({
  // Lower bound 1: an empty batch is wasted PoW and almost certainly a client
  // bug. Upper bound 32 is amendments.md #7 (single PoW per HTTP request).
  envelopes: z.array(envelopeSchema).min(1).max(32),
});

export type EnvelopeInput = z.infer<typeof envelopeSchema>;
export type EnvelopeBatchInput = z.infer<typeof envelopeBatchSchema>;
export type EnvelopeKind = z.infer<typeof envelopeKindSchema>;

// --- POST /v3/shares/:shareId/mailbox ------------------------------------

/**
 * Content-blind durable-share submission framing. These schemas deliberately
 * validate only cleartext routing/authentication metadata and encrypted
 * envelope headers. The relay never opens `ciphertext` or interprets a
 * ReviewEvent body.
 *
 * All objects are strict because a durable mailbox item can outlive the room
 * that produced it. Accepting an unbounded/unknown field here would turn the
 * ShareDO into an attacker-controlled long-lived object store and make owner
 * intake ambiguity survive every retry.
 */
export const durableSubmissionDeviceSchema = z.object({
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_CHARS),
  participantId: z.string().min(1).max(PARTICIPANT_ID_MAX_CHARS),
  publicSigningKey: b64url.length(BASE64URL_32_BYTE_MAX_CHARS),
  publicEncryptionKey: b64url.length(BASE64URL_32_BYTE_MAX_CHARS),
  client: z.enum(["attn-native", "attn-browser", "agent-cli"]),
  kind: z.enum(["reviewer", "agent"]),
  grantTier: z.enum(["comment", "suggest"]),
  grantSignature: b64url.length(BASE64URL_64_BYTE_MAX_CHARS),
  selfSignature: b64url.length(BASE64URL_64_BYTE_MAX_CHARS),
}).strict();

export const durableSubmissionEnvelopeSchema = z.object({
  v: z.literal(2),
  roomId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  envelopeId: z.string().min(1).max(ENVELOPE_ID_MAX_CHARS).regex(/^[A-Za-z0-9_-]+$/),
  authorId: z.string().min(1).max(PARTICIPANT_ID_MAX_CHARS),
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_CHARS),
  createdAt: unixMs,
  expiresAt: unixMs,
  kind: z.literal("event"),
  nonce: b64url.length(XCHACHA20_NONCE_MAX_CHARS),
  ciphertext: b64url.max(350_000),
  ciphertextBytes: z.number().int().min(16).max(256 * 1024),
}).strict().superRefine((envelope, ctx) => {
  if (envelope.expiresAt < envelope.createdAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt precedes createdAt" });
  }
});

export const durableReviewSubmissionSchema = z.object({
  v: z.literal(3),
  envelopeId: z.string().min(1).max(ENVELOPE_ID_MAX_CHARS).regex(/^[A-Za-z0-9_-]+$/),
  type: z.literal("review_submission"),
  shareId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  epoch: z.number().int().nonnegative().safe(),
  roomId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  tier: z.enum(["comment", "suggest"]),
  /** Required for tier-bundle shares; omitted only by legacy single-key shares. */
  bundleId: z.string().length(22).regex(/^[A-Za-z0-9_-]+$/).optional(),
  deviceRegistration: durableSubmissionDeviceSchema,
  envelopes: z.array(durableSubmissionEnvelopeSchema).min(2).max(8),
}).strict().superRefine((submission, ctx) => {
  if (submission.deviceRegistration.grantTier !== submission.tier) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deviceRegistration", "grantTier"], message: "grant tier mismatch" });
  }
  const envelopeIds = new Set<string>();
  for (const [index, envelope] of submission.envelopes.entries()) {
    if (envelope.roomId !== submission.roomId
      || envelope.deviceId !== submission.deviceRegistration.deviceId
      || envelope.authorId !== submission.deviceRegistration.participantId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["envelopes", index], message: "envelope routing identity mismatch" });
    }
    if (envelopeIds.has(envelope.envelopeId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["envelopes", index, "envelopeId"], message: "duplicate envelopeId" });
    }
    envelopeIds.add(envelope.envelopeId);
  }
});

export type DurableReviewSubmission = z.infer<typeof durableReviewSubmissionSchema>;

/**
 * Stored shape — the wire envelope plus the server-assigned `serverSeq`.
 * `target` is normalized to `null` when omitted on the wire so storage stays
 * consistent across encoders.
 */
export interface EnvelopeRecord extends Omit<EnvelopeInput, "target"> {
  target: { deviceId: string } | null;
  serverSeq: number;
}

// --- POST /v2/rooms/:roomId/acks -----------------------------------------

/**
 * Per relay-spec.md §POST /v2/rooms/:roomId/acks.
 *
 * The body is a single batch of envelopeIds being acked by exactly one device.
 * Per spec the request shape is `{ackedEnvelopeIds, deviceId}`; multiple
 * devices ACKing the same envelope each issue their own request (the spec
 * pins per-device ack tracking so each device's `ack:<deviceId>:<envelopeId>`
 * slot is independently recorded).
 *
 * - `ackedEnvelopeIds` is bounded at 1..100 to keep one HTTP request's worth
 *   of work cheap. The spec does not pin an explicit cap; 100 matches the
 *   client batching cadence (mailbox replay scans typically yield 10s of
 *   envelopes per round-trip).
 * - `deviceId` must match a registered device in the room. The handler
 *   re-checks against `device:<participantId>:<deviceId>` (looked up by
 *   deviceId alone since the participantId isn't carried on the wire).
 */
export const acksRequestSchema = z.object({
  ackedEnvelopeIds: z
    .array(z.string().min(1).max(ENVELOPE_ID_MAX_CHARS))
    .min(1)
    .max(100),
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_CHARS),
});

export type AcksRequest = z.infer<typeof acksRequestSchema>;

// --- POST /v2/rooms/:roomId/blobs ----------------------------------------

/**
 * Per relay-spec.md §POST /v2/rooms/:roomId/blobs (R2 spillover) and
 * amendments.md #9 (R2 7-day lifecycle as safety net only).
 *
 * Used when `kind == "snapshot_blob"` and `ciphertextBytes > 1 MiB`. The client
 * gets back a presigned upload URL, PUTs the ciphertext to R2 directly, then
 * issues a follow-up POST /envelopes with a small BlobRef payload that points
 * to the uploaded object.
 *
 * - `envelopeId` must be the same one the eventual POST /envelopes will use
 *   (the relay keys R2 objects under a generation-bound room prefix so
 *   alarm-driven cleanup remains a single room-prefix sweep).
 * - `authorId` / `deviceId` must reference an already-registered device. The
 *   handler re-checks both before reserving R2 bytes.
 * - `ciphertextBytes` must be > 1 MiB; below that the spec requires the inline
 *   envelope path (per-envelope size cap in handleEnvelopesIngest already
 *   covers the upper bound via `policy.maxSnapshotBytes`).
 */
export const blobPresignRequestSchema = z.object({
  envelopeId: z.string().min(1).max(ENVELOPE_ID_MAX_CHARS),
  authorId: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_CHARS),
  ciphertextBytes: z.number().int().positive(),
});

export type BlobPresignRequest = z.infer<typeof blobPresignRequestSchema>;
