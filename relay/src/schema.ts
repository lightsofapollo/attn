/** zod request/response validators for HTTP API per relay-spec.md §HTTP API. */

import { z } from "zod";

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
  ownerSigningKey: b64url.min(1, "ownerSigningKey required"),
  admissionKey: b64url.min(1, "admissionKey required"),
});

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
  deviceId: z.string().min(1).max(64),
  participantId: z.string().min(1).max(64),
  publicSigningKey: b64url.min(1, "publicSigningKey required"),
  publicEncryptionKey: b64url.min(1, "publicEncryptionKey required"),
  client: z.enum(["attn-native", "attn-browser", "agent-cli"]),
  kind: z.enum(["owner", "reviewer", "agent"]),
  selfSignature: b64url.min(1, "selfSignature required"),
});

export type DeviceRegistrationRequest = z.infer<typeof deviceRegistrationSchema>;

/**
 * Stored shape returned by `GET /v2/rooms/:roomId/devices`. Adds `registeredAt`
 * (ms-epoch) to the request body and preserves all client-supplied fields
 * (including `selfSignature` so clients can re-verify offline). Per spec we
 * return devices in registration order.
 */
export interface DeviceRecord extends DeviceRegistrationRequest {
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
 * - `nonce` is opaque to the relay (per crypto-spec.md it's a 24-byte XChaCha
 *   nonce, base64url-encoded). We don't enforce its length here so we can
 *   round-trip future nonce schemes; the wire shape stays the same.
 */
export const envelopeTargetSchema = z.object({
  deviceId: z.string().min(1).max(64),
});

export const envelopeKindSchema = z.enum(["event", "snapshot_blob", "signal"]);

export const envelopeSchema = z.object({
  envelopeId: z.string().min(1),
  authorId: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(64),
  kind: envelopeKindSchema,
  // null is a valid wire value for "no target / broadcast". zod's optional()
  // also covers the omitted case so clients can leave the key off entirely.
  target: envelopeTargetSchema.nullable().optional(),
  createdAt: unixMs,
  expiresAt: unixMs,
  nonce: b64url.min(1, "nonce required"),
  ciphertext: b64url, // empty ciphertext is allowed at the schema layer; per-kind cap is enforced in handler
  ciphertextBytes: z.number().int().positive(),
});

export const envelopeBatchSchema = z.object({
  // Lower bound 1: an empty batch is wasted PoW and almost certainly a client
  // bug. Upper bound 32 is amendments.md #7 (single PoW per HTTP request).
  envelopes: z.array(envelopeSchema).min(1).max(32),
});

export type EnvelopeInput = z.infer<typeof envelopeSchema>;
export type EnvelopeBatchInput = z.infer<typeof envelopeBatchSchema>;
export type EnvelopeKind = z.infer<typeof envelopeKindSchema>;

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
  ackedEnvelopeIds: z.array(z.string()).min(1).max(100),
  deviceId: z.string(),
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
 *   (the relay keys R2 objects under `rooms/<roomId>/blobs/<envelopeId>` to
 *   make alarm-driven cleanup a single prefix sweep).
 * - `authorId` / `deviceId` must reference an already-registered device. The
 *   handler re-checks both before reserving R2 bytes.
 * - `ciphertextBytes` must be > 1 MiB; below that the spec requires the inline
 *   envelope path (per-envelope size cap in handleEnvelopesIngest already
 *   covers the upper bound via `policy.maxSnapshotBytes`).
 */
export const blobPresignRequestSchema = z.object({
  envelopeId: z.string().min(1),
  authorId: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(64),
  ciphertextBytes: z.number().int().positive(),
});

export type BlobPresignRequest = z.infer<typeof blobPresignRequestSchema>;
