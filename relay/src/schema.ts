/** zod request/response validators for HTTP API per relay-spec.md §HTTP API. */

import { z } from "zod";

/**
 * Schemas land here as endpoints are implemented:
 *   - RoomCreateRequest / RoomCreateResponse  (attn-nnj.5.5)
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

// TODO: filled in by attn-nnj.5.5..5.10
