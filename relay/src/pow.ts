/** Hashcash PoW verification per relay-spec.md §Proof of Work + crypto-spec.md §Hashcash.
 *
 * Token format:
 *
 *   attn-pow:v2:<difficulty>:<expiresAt>:<roomId>:<deviceId>:<requestPathHash>:<rand>:<counter>
 *
 * Bound to `(method, path)` via `requestPathHash`. Replay-protected via a per-room
 * seen-token set with TTL = token expiry (storage adapter wired by the caller).
 *
 * Validation order (crypto-spec.md §Server Validation):
 *   1. Parse: 9 colon-separated segments (magic `attn-pow`, v2, then 7 fields),
 *      no extra colons inside fields.
 *   2. v == "v2".
 *   3. difficulty >= max(policy.powBits, 12).
 *   4. expiresAt > now and expiresAt <= now + 10 minutes (5-min default TTL +
 *      5-min clock-skew window).
 *   5. resource matches (roomId, deviceId, base64url(SHA-256(METHOD " " PATH)[:8])).
 *   6. SHA-256(token) has `difficulty` leading zero bits.
 *   7. Token not present in pow_seen replay set.
 *
 * Any failure → throw `PowError("ATTN_POW_INVALID")` — we deliberately collapse
 * specific failure causes into a single opaque error so an attacker cannot
 * distinguish which check failed.
 */

/** Minimum difficulty the spec allows (floor — server uses max(policy, 12)). */
export const MIN_POW_BITS = 12;

/** Maximum difficulty the spec allows. */
export const MAX_POW_BITS = 24;

/** Server clock-skew window: tokens may expire up to (now + 10min). */
export const POW_MAX_LIFETIME_MS = 10 * 60 * 1000;

const TOKEN_MAGIC = "attn-pow";
const TOKEN_VERSION = "v2";
/** Magic | version | 7 fields (difficulty, expiresAt, roomId, deviceId, requestPathHash, rand, counter). */
const TOKEN_SEGMENT_COUNT = 9;

const textEncoder = new TextEncoder();

export class PowError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PowError";
    this.code = code;
  }
}

/** Throw the canonical "PoW failed" error, hiding the specific reason from clients. */
function powInvalid(detail: string): never {
  throw new PowError("ATTN_POW_INVALID", detail);
}

export interface ParsedPow {
  v: "v2";
  difficulty: number;
  expiresAt: number;
  roomId: string;
  deviceId: string;
  requestPathHash: string;
  rand: string;
  counter: number;
}

export interface PowVerifyContext {
  roomId: string;
  deviceId: string;
  /** Request method, expected uppercase (caller is the authority). */
  method: string;
  /** Sanitized URL path used for the requestPathHash binding. */
  urlPath: string;
  /** Required difficulty in bits (typically 16; room override in [12,24]). */
  policyPowBits: number;
  /** ms-epoch "now", injectable for tests. */
  now: number;
  /** Replay-set adapter — must be backed by DO storage in production (wired in 5.12). */
  isReplayed: (tokenSha256: string) => Promise<boolean>;
  /** Mark a token as seen after successful verify. `expiresAt` lets a future alarm prune. */
  markSeen: (tokenSha256: string, expiresAt: number) => Promise<void>;
}

/**
 * Parse-only helper, exported for tests and introspection. Throws
 * `PowError("ATTN_POW_INVALID")` on any structural problem.
 */
export function parsePow(token: string): ParsedPow {
  // `splitn`-style: cap at one beyond the expected count so we can detect
  // extra colons inside fields (which would push len > TOKEN_SEGMENT_COUNT).
  const parts = token.split(":");
  if (parts.length !== TOKEN_SEGMENT_COUNT) {
    powInvalid(
      `expected ${TOKEN_SEGMENT_COUNT} colon-separated segments, got ${parts.length}`,
    );
  }
  const [
    magic,
    version,
    difficultyStr,
    expiresAtStr,
    roomId,
    deviceId,
    requestPathHash,
    rand,
    counterStr,
  ] = parts as [string, string, string, string, string, string, string, string, string];

  if (magic !== TOKEN_MAGIC) {
    powInvalid(`missing '${TOKEN_MAGIC}' magic`);
  }
  if (version !== TOKEN_VERSION) {
    powInvalid(`unsupported version: ${version}`);
  }
  const difficulty = parseUintField(difficultyStr, "difficulty");
  const expiresAt = parseUintField(expiresAtStr, "expiresAt");
  const counter = parseUintField(counterStr, "counter");

  if (roomId.length === 0 || deviceId.length === 0 || requestPathHash.length === 0) {
    powInvalid("resource components must be non-empty");
  }
  if (rand.length === 0) {
    powInvalid("rand must be non-empty");
  }

  return {
    v: TOKEN_VERSION,
    difficulty,
    expiresAt,
    roomId,
    deviceId,
    requestPathHash,
    rand,
    counter,
  };
}

/**
 * Full server-side verification per crypto-spec.md §Server Validation.
 *
 * The replay-set check (step 7) is split into two halves so the DO event loop
 * can serialize within a room: we read first, then `markSeen` after every
 * other check passes. The DO event loop guarantees no concurrent request
 * for the same room interleaves between the two calls.
 */
export async function verifyPow(token: string, ctx: PowVerifyContext): Promise<void> {
  // Steps 1+2: parse + version (parsePow rejects anything but v2).
  const parsed = parsePow(token);

  // Step 3: difficulty >= max(policy, MIN_POW_BITS).
  const required = Math.max(ctx.policyPowBits, MIN_POW_BITS);
  if (parsed.difficulty < required) {
    powInvalid(
      `token difficulty ${parsed.difficulty} below required ${required}`,
    );
  }

  // Step 4: expiresAt within (now, now + 10min].
  if (parsed.expiresAt <= ctx.now) {
    powInvalid(
      `token expired (expiresAt=${parsed.expiresAt}, now=${ctx.now})`,
    );
  }
  if (parsed.expiresAt > ctx.now + POW_MAX_LIFETIME_MS) {
    powInvalid(
      `expiresAt ${parsed.expiresAt} beyond clock-skew window (now + ${POW_MAX_LIFETIME_MS}ms)`,
    );
  }

  // Step 5: resource binding. Constant-time compare across the three
  // concatenated components so we don't leak which one mismatched.
  const expectedPathHash = await requestPathHash(ctx.method, ctx.urlPath);
  const expectedResource = `${ctx.roomId}:${ctx.deviceId}:${expectedPathHash}`;
  const actualResource = `${parsed.roomId}:${parsed.deviceId}:${parsed.requestPathHash}`;
  if (!constantTimeStringEquals(expectedResource, actualResource)) {
    powInvalid("resource mismatch");
  }

  // Step 6: SHA-256(token) leading-zero-bit count >= claimed difficulty.
  const hashBytes = await sha256Bytes(textEncoder.encode(token));
  const bits = leadingZeroBits(hashBytes);
  if (bits < parsed.difficulty) {
    powInvalid(
      `token hash has ${bits} leading zero bits, claims ${parsed.difficulty}`,
    );
  }

  // Step 7: replay. Check first, mark after. Non-atomic, but the DO event loop
  // serializes requests within a room so the read→write window is closed.
  const hashB64 = base64UrlEncode(hashBytes);
  if (await ctx.isReplayed(hashB64)) {
    powInvalid("token already seen (replay)");
  }
  await ctx.markSeen(hashB64, parsed.expiresAt);
}

/** SHA-256(token) base64url — used for the replay-set key. */
export async function tokenHash(token: string): Promise<string> {
  const bytes = await sha256Bytes(textEncoder.encode(token));
  return base64UrlEncode(bytes);
}

/** requestPathHash = base64url-no-pad(first 8 bytes of SHA-256(METHOD " " PATH)). */
export async function requestPathHash(method: string, path: string): Promise<string> {
  const input = textEncoder.encode(`${method} ${path}`);
  const digest = await sha256Bytes(input);
  return base64UrlEncode(digest.slice(0, 8));
}

// --- helpers --------------------------------------------------------------

/** Count leading zero bits across a byte slice (high bit of byte 0 first). */
export function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b === 0) {
      count += 8;
      continue;
    }
    // Count leading zeros in a single byte (0..7).
    let bit = 0x80;
    while (bit !== 0 && (b & bit) === 0) {
      count += 1;
      bit >>>= 1;
    }
    break;
  }
  return count;
}

/** Parse a non-negative decimal integer field; throw PowError on any deviation. */
function parseUintField(s: string, name: string): number {
  if (s.length === 0) powInvalid(`${name} must be non-empty`);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) powInvalid(`${name} must be decimal digits`);
  }
  // We accept up to Number.MAX_SAFE_INTEGER. expiresAt fits in a u53 until
  // year 287396; counter never approaches that. Anything larger is rejected
  // outright — JS numbers can't represent it without loss.
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) {
    powInvalid(`${name} not a safe non-negative integer`);
  }
  return n;
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** Constant-time string equality (length-revealing, content-blind). */
export function constantTimeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Encode bytes as unpadded base64url. */
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
