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
