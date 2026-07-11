// Browser-side crypto primitives for the Phase 6 hosted review client.
//
// Implements the same cipher suite as `src/review/crypto/*` (Rust) so the
// browser client can decrypt envelopes, verify signatures, and derive room
// keys produced by native clients. The contract is the cross-impl
// test-vector corpus at `planning/collab/test-vectors/`:
//
//   - kdf.json             — HKDF-SHA-256 + room key derivation
//   - aead.json            — XChaCha20-Poly1305 seal/open with AAD-binding
//   - event-signature.json — Ed25519 sign/verify over canonical signed bytes
//   - canonical-json.jsonl — RFC 8785 JCS canonical JSON
//
// Decision authority: `planning/collab/ui/browser-crypto-decision.md`
// (attn-nnj.9.1) — Option B (hand-written TS + @noble/*).
//
// Tests: `browser-crypto.test.ts`. Run with:
//
//   cd web && npx tsx src/lib/review/browser-crypto.test.ts

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';

// ---------------------------------------------------------------------------
// base64url-no-pad codec — matches Rust `URL_SAFE_NO_PAD`.
// Mirrors `browser-invite.ts` (kept inline here so this module has zero
// internal-import surface beyond `@noble/*`).
// ---------------------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error('invalid base64url characters');
  }
  let std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4;
  if (pad === 2) std += '==';
  else if (pad === 3) std += '=';
  else if (pad === 1) throw new Error('invalid base64url length');
  let bin: string;
  try {
    bin = atob(std);
  } catch {
    throw new Error('invalid base64url encoding');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical JSON per RFC 8785 (JCS subset).
//
// Mirrors `src/review/crypto/canonical.rs` line for line:
//   1. Object keys sorted ASCII-ascending at every nesting level.
//   2. No insignificant whitespace.
//   3. UTF-8 (TextEncoder emits raw UTF-8 — no BOM).
//   4. Minimal string escapes: `\"`, `\\`, and `\u00XX` (lowercase hex)
//      for U+0000..U+001F. Everything else emitted raw.
//   5. Numbers: integers emit as plain digits; we restrict signed payloads
//      to integers (per spec) — non-finite throws.
//   6. `null` values in OBJECTS are dropped recursively; `null`s in
//      ARRAYS are preserved (index semantics matter).
// ---------------------------------------------------------------------------

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Reduce any JSON-serializable JS value to its canonical JSON UTF-8 bytes.
 *
 * NOTE: this assumes the input is a plain JSON value (object/array/string/
 * number/boolean/null) — pass typed structs through `JSON.parse(JSON.stringify(v))`
 * first if they carry methods or non-JSON-safe entries.
 */
export function toCanonicalBytes(value: unknown): Uint8Array {
  const s = toCanonicalString(value);
  return new TextEncoder().encode(s);
}

export function toCanonicalString(value: unknown): string {
  return writeValue(value);
}

function writeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return writeNumber(v);
  if (typeof v === 'bigint') return v.toString(10);
  if (typeof v === 'string') return writeString(v);
  if (Array.isArray(v)) return writeArray(v);
  if (typeof v === 'object') return writeObject(v as Record<string, unknown>);
  throw new CanonicalJsonError(`canonical JSON: unsupported value of type ${typeof v}`);
}

function writeArray(arr: unknown[]): string {
  let out = '[';
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) out += ',';
    // Nulls inside arrays must be preserved — they affect indices.
    out += writeValue(arr[i]);
  }
  out += ']';
  return out;
}

function writeObject(obj: Record<string, unknown>): string {
  // Drop null entries (rule 6). Preserve everything else.
  const keys: string[] = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) continue; // undefined never serializes as JSON
    if (v === null) continue;      // drop nulls in objects
    keys.push(k);
  }
  // ASCII-ascending sort — JS string comparison on BMP code units is
  // bytewise for ASCII keys, matching Rust `str::cmp`. For non-ASCII keys
  // (rare in our schemas) BOTH sides compare by UTF-16 code units… but
  // Rust compares by UTF-8 bytes, which can diverge above U+007F. Our
  // schemas keep keys ASCII-only, so this isn't exercised; if it ever
  // changes we'll need to compare by UTF-8 bytes here too.
  keys.sort();
  let out = '{';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (i > 0) out += ',';
    out += writeString(k);
    out += ':';
    out += writeValue(obj[k]);
  }
  out += '}';
  return out;
}

function writeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError('canonical JSON: non-finite number (NaN/Infinity)');
  }
  // Integers: plain digits, no decimal. Matches Rust serde_json's number
  // formatter for the integer subset we use in signed payloads.
  if (Number.isInteger(n)) {
    // -0 → "0" (matches serde_json which emits "0" for f64 -0)
    if (Object.is(n, -0)) return '0';
    return n.toString(10);
  }
  // Non-integer floats — we shouldn't see these in signed payloads, but
  // fall back to default JSON.stringify for completeness. Round-trip per
  // ECMA-404.
  return JSON.stringify(n);
}

function writeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += '\\\\';
    } else if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      // Append the original character — for surrogate pairs (code points
      // above U+FFFF) the high+low surrogates already concat correctly
      // because we walk by UTF-16 code units. The TextEncoder downstream
      // emits the same raw UTF-8 bytes Rust would.
      out += s[i];
    }
  }
  out += '"';
  return out;
}

// ---------------------------------------------------------------------------
// KDF — HKDF-SHA-256 + room key derivation.
//
// Mirrors `src/review/crypto/kdf.rs`:
//   rootKey      = HKDF(roomSecret, info="attn room root v2",          L=32)
//   eventKey     = HKDF(rootKey,    info="attn event encryption v2",   L=32)
//   snapshotKey  = HKDF(rootKey,    info="attn snapshot encryption v2",L=32)
//   signalingKey = HKDF(rootKey,    info="attn signaling encryption v2",L=32)
//   admissionKey = HKDF(rootKey,    info="attn relay admission v2",    L=32)
//   roomId       = base64url(first 16 bytes of SHA-256("attn room v2" || roomSecret))
// ---------------------------------------------------------------------------

export const INFO_ROOT = new TextEncoder().encode('attn room root v2');
export const INFO_EVENT = new TextEncoder().encode('attn event encryption v2');
export const INFO_SNAPSHOT = new TextEncoder().encode('attn snapshot encryption v2');
export const INFO_SIGNALING = new TextEncoder().encode('attn signaling encryption v2');
export const INFO_ADMISSION = new TextEncoder().encode('attn relay admission v2');
export const ROOM_ID_PREFIX = new TextEncoder().encode('attn room v2');

// Additive capability-split v3 tree. Existing v2 exports remain unchanged and
// continue to back production networking until an explicit protocol cutover.
export const INFO_ROOT_V3 = new TextEncoder().encode('attn room root v3');
export const INFO_READ_CAPABILITY_V3 = new TextEncoder().encode('attn read capability v3');
export const INFO_EVENT_V3 = new TextEncoder().encode('attn event encryption v3');
export const INFO_SNAPSHOT_V3 = new TextEncoder().encode('attn snapshot encryption v3');
export const INFO_SIGNALING_V3 = new TextEncoder().encode('attn signaling encryption v3');
export const INFO_READ_ADMISSION_V3 = new TextEncoder().encode('attn read admission v3');
export const INFO_WRITE_ADMISSION_V3 = new TextEncoder().encode('attn write admission v3');
export const ROOM_ID_PREFIX_V3 = new TextEncoder().encode('attn room v3');
export const INFO_SHARE_ROOM_V3 = new TextEncoder().encode('attn share room v3');

export interface RoomKeys {
  /** HKDF root key — used only to derive subkeys. Never used directly. */
  rootKey: Uint8Array;
  /** AEAD key for encrypted review events. */
  eventKey: Uint8Array;
  /** AEAD key for snapshot blobs. */
  snapshotKey: Uint8Array;
  /** AEAD key for WebRTC signaling envelopes. */
  signalingKey: Uint8Array;
  /** HMAC key for relay-admission tokens. */
  admissionKey: Uint8Array;
}

export interface ReadKeysV3 {
  readCapabilityKey: Uint8Array;
  eventKey: Uint8Array;
  snapshotKey: Uint8Array;
  signalingKey: Uint8Array;
  readAdmissionKey: Uint8Array;
}

export interface RoomKeyTreeV3 {
  rootKey: Uint8Array;
  readKeys: ReadKeysV3;
  writeAdmissionKey: Uint8Array;
}

export function hkdfExpand32(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  // HKDF(salt=empty, ikm, info, L=32). `salt: undefined` → noble treats as
  // empty, matching Rust `Hkdf::<Sha256>::new(None, ikm)`.
  return hkdf(sha256, ikm, undefined, info, 32);
}

export function deriveRoomKeys(roomSecret: Uint8Array): RoomKeys {
  if (!(roomSecret instanceof Uint8Array) || roomSecret.length !== 32) {
    throw new Error('roomSecret must be a 32-byte Uint8Array');
  }
  const rootKey = hkdfExpand32(roomSecret, INFO_ROOT);
  return {
    rootKey,
    eventKey: hkdfExpand32(rootKey, INFO_EVENT),
    snapshotKey: hkdfExpand32(rootKey, INFO_SNAPSHOT),
    signalingKey: hkdfExpand32(rootKey, INFO_SIGNALING),
    admissionKey: hkdfExpand32(rootKey, INFO_ADMISSION),
  };
}

export function deriveReadKeysV3(readCapabilityKey: Uint8Array): ReadKeysV3 {
  requireKey32(readCapabilityKey, 'readCapabilityKey');
  return {
    readCapabilityKey: new Uint8Array(readCapabilityKey),
    eventKey: hkdfExpand32(readCapabilityKey, INFO_EVENT_V3),
    snapshotKey: hkdfExpand32(readCapabilityKey, INFO_SNAPSHOT_V3),
    signalingKey: hkdfExpand32(readCapabilityKey, INFO_SIGNALING_V3),
    readAdmissionKey: hkdfExpand32(readCapabilityKey, INFO_READ_ADMISSION_V3),
  };
}

export function deriveRoomKeyTreeV3(roomSecret: Uint8Array): RoomKeyTreeV3 {
  requireKey32(roomSecret, 'roomSecret');
  const rootKey = hkdfExpand32(roomSecret, INFO_ROOT_V3);
  const readCapabilityKey = hkdfExpand32(rootKey, INFO_READ_CAPABILITY_V3);
  return {
    rootKey,
    readKeys: deriveReadKeysV3(readCapabilityKey),
    writeAdmissionKey: hkdfExpand32(rootKey, INFO_WRITE_ADMISSION_V3),
  };
}

/**
 * Derive one durable share epoch's room secret. The epoch is encoded as an
 * unsigned uint64be suffix on the fixed HKDF info string. JavaScript callers
 * use safe integers because the relay record carries the epoch as JSON.
 */
export function deriveShareEpochRoomSecret(
  shareSecret: Uint8Array,
  epoch: number,
): Uint8Array {
  requireKey32(shareSecret, 'shareSecret');
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error('epoch must be a non-negative safe integer');
  }
  const info = new Uint8Array(INFO_SHARE_ROOM_V3.length + 8);
  info.set(INFO_SHARE_ROOM_V3, 0);
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  view.setBigUint64(INFO_SHARE_ROOM_V3.length, BigInt(epoch), false);
  return hkdfExpand32(shareSecret, info);
}

export function deriveRoomId(roomSecret: Uint8Array): string {
  if (!(roomSecret instanceof Uint8Array) || roomSecret.length !== 32) {
    throw new Error('roomSecret must be a 32-byte Uint8Array');
  }
  // SHA-256("attn room v2" || roomSecret), take first 16 bytes, base64url.
  const input = new Uint8Array(ROOM_ID_PREFIX.length + roomSecret.length);
  input.set(ROOM_ID_PREFIX, 0);
  input.set(roomSecret, ROOM_ID_PREFIX.length);
  const digest = sha256(input);
  return base64UrlEncode(digest.subarray(0, 16));
}

export function deriveRoomIdV3(roomSecret: Uint8Array): string {
  requireKey32(roomSecret, 'roomSecret');
  const input = new Uint8Array(ROOM_ID_PREFIX_V3.length + roomSecret.length);
  input.set(ROOM_ID_PREFIX_V3, 0);
  input.set(roomSecret, ROOM_ID_PREFIX_V3.length);
  return base64UrlEncode(sha256(input).subarray(0, 16));
}

function requireKey32(value: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`${name} must be a 32-byte Uint8Array`);
  }
}

// ---------------------------------------------------------------------------
// AEAD — XChaCha20-Poly1305 with AAD-bound envelope metadata.
//
// Mirrors `src/review/crypto/aead.rs`. The AAD is the canonical-JSON form of
// `{v, roomId, envelopeId, kind, authorId, deviceId, createdAt}` — the relay
// surfaces these in cleartext for routing, so a tampered routing tag
// invalidates the MAC.
// ---------------------------------------------------------------------------

export interface EnvelopeAad {
  v: number;
  roomId: string;
  envelopeId: string;
  kind: 'event' | 'snapshot_blob' | 'signal';
  authorId: string;
  deviceId: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
}

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeadError';
  }
}

/** Build the canonical AAD bytes that get bound into the Poly1305 tag. */
export function aeadAadBytes(aad: EnvelopeAad): Uint8Array {
  return toCanonicalBytes(aad as unknown);
}

/**
 * Seal `plaintext` under `key` with the supplied 24-byte nonce. Returns
 * `ciphertext || tag` (per RustCrypto convention — last 16 bytes are the
 * Poly1305 tag). Deterministic for fixed inputs (used by corpus tests).
 */
export function aeadSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: EnvelopeAad,
): Uint8Array {
  if (key.length !== 32) throw new AeadError('aead key must be 32 bytes');
  if (nonce.length !== 24) throw new AeadError('aead nonce must be 24 bytes (XChaCha20)');
  const aadBytes = aeadAadBytes(aad);
  const cipher = xchacha20poly1305(key, nonce, aadBytes);
  return cipher.encrypt(plaintext);
}

/**
 * Open a ciphertext sealed by `aeadSeal` (or the Rust side). Returns the
 * recovered plaintext bytes. All failure modes (wrong key, wrong nonce,
 * tampered ciphertext, mutated AAD) collapse to `AeadError('aead open failed')`
 * to match Rust `AeadError::Decrypt` — we never leak which input was wrong.
 */
export function aeadOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: EnvelopeAad,
): Uint8Array {
  if (key.length !== 32) throw new AeadError('aead key must be 32 bytes');
  if (nonce.length !== 24) throw new AeadError('aead nonce must be 24 bytes (XChaCha20)');
  const aadBytes = aeadAadBytes(aad);
  const cipher = xchacha20poly1305(key, nonce, aadBytes);
  try {
    return cipher.decrypt(ciphertext);
  } catch {
    // Collapse all failure reasons into one opaque error — never leak
    // which input was wrong (matches Rust aead::open).
    throw new AeadError('aead open failed');
  }
}

/** Convenience: fresh 24-byte random nonce from WebCrypto. */
export function randomAeadNonce(): Uint8Array {
  const out = new Uint8Array(24);
  crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// Ed25519 event signing + verification.
//
// Mirrors the receive half of `src/review/crypto/signing.rs`:
//   signedBytes = canonicalJSON({ meta: <EventMeta WITHOUT eventId,
//                                         parentEventIds sorted ASCII-asc>,
//                                 body })
//   signature   = base64url(Ed25519.sign(signingKey, signedBytes))
//   signingKeyId= base64url(SHA-256(publicSigningKey))
//
// Hosted reviewers use the same canonical signed bytes as native clients.
// ---------------------------------------------------------------------------

/** Pulled from `web/src/lib/types.ts` shapes so callers don't need to import. */
export interface SignableMetaShape {
  v: number;
  /** Present on the wire but stripped before signing. */
  eventId?: string;
  roomId: string;
  authorId: string;
  deviceId: string;
  createdAt: number;
  parentEventIds: string[];
  snapshotId?: string;
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

/** `signingKeyId = base64url(SHA-256(publicSigningKey))`. */
export function signingKeyId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new SignatureError('Ed25519 public key must be 32 bytes');
  }
  return base64UrlEncode(sha256(publicKey));
}

/**
 * Build the canonical signed bytes for a `(meta, body)` pair.
 *
 * Strips `eventId` from `meta` (chicken/egg with EventId) and sorts
 * `parentEventIds` ASCII-ascending — both rules mirror
 * `signing.rs::canonical_signed_bytes`. Returns the UTF-8 bytes that get
 * hashed under the Ed25519 signature.
 */
export function canonicalSignedBytes(meta: SignableMetaShape, body: unknown): Uint8Array {
  const parents = (meta.parentEventIds ?? []).slice();
  parents.sort(); // ASCII-ascending — matches Rust sort_by_key
  const signableMeta: Record<string, unknown> = {
    v: meta.v,
    roomId: meta.roomId,
    authorId: meta.authorId,
    deviceId: meta.deviceId,
    createdAt: meta.createdAt,
    parentEventIds: parents,
  };
  if (meta.snapshotId !== undefined && meta.snapshotId !== null) {
    signableMeta.snapshotId = meta.snapshotId;
  }
  return toCanonicalBytes({ body, meta: signableMeta });
}

/** `EventId = base64url(SHA-256(canonicalJSON({ meta-without-eventId, body })))`. */
export function deriveEventId(meta: SignableMetaShape, body: unknown): string {
  return base64UrlEncode(sha256(canonicalSignedBytes(meta, body)));
}

/** Sign a review event over its canonical `(meta-without-eventId, body)` bytes. */
export function signEvent(
  meta: SignableMetaShape,
  body: unknown,
  secretKey: Uint8Array,
  publicKey?: Uint8Array,
): { signature: string; signingKeyId: string } {
  if (secretKey.length !== 32) {
    throw new SignatureError('Ed25519 secret key must be a 32-byte seed');
  }
  const resolvedPublicKey = publicKey ?? ed25519.getPublicKey(secretKey);
  if (resolvedPublicKey.length !== 32) {
    throw new SignatureError('Ed25519 public key must be 32 bytes');
  }
  const signed = canonicalSignedBytes(meta, body);
  try {
    return {
      signature: base64UrlEncode(ed25519.sign(signed, secretKey)),
      signingKeyId: signingKeyId(resolvedPublicKey),
    };
  } finally {
    signed.fill(0);
  }
}

const ENVELOPE_ID_PREFIX = new TextEncoder().encode('envelope v2');
const FILE_ID_PREFIX = new TextEncoder().encode('attn file v2');
const SNAPSHOT_ID_PREFIX = new TextEncoder().encode('snapshot v2');

/**
 * Stable room-private file identity. The first snapshot hash is deliberately
 * part of the derivation only for the initial publish; republish callers must
 * retain and reuse the returned FileId.
 */
export function deriveFileId(
  roomSecret: Uint8Array,
  path: string,
  firstSnapshotHash: string,
): string {
  if (!(roomSecret instanceof Uint8Array) || roomSecret.length !== 32) {
    throw new Error('roomSecret must be a 32-byte Uint8Array');
  }
  if (typeof path !== 'string' || path.length === 0) throw new Error('path must be non-empty');
  if (typeof firstSnapshotHash !== 'string' || firstSnapshotHash.length === 0) {
    throw new Error('firstSnapshotHash must be non-empty');
  }
  const pathBytes = new TextEncoder().encode(path);
  const hashBytes = new TextEncoder().encode(firstSnapshotHash);
  const input = new Uint8Array(
    FILE_ID_PREFIX.length + roomSecret.length + pathBytes.length + hashBytes.length,
  );
  let offset = 0;
  input.set(FILE_ID_PREFIX, offset);
  offset += FILE_ID_PREFIX.length;
  input.set(roomSecret, offset);
  offset += roomSecret.length;
  input.set(pathBytes, offset);
  offset += pathBytes.length;
  input.set(hashBytes, offset);
  const digest = sha256(input);
  input.fill(0);
  return base64UrlEncode(digest.subarray(0, 16));
}

/** Native-compatible SnapshotId using decimal ASCII for createdAt. */
export function deriveSnapshotId(
  roomId: string,
  fileId: string,
  baseHash: string,
  createdAt: number,
): string {
  for (const [label, value] of [
    ['roomId', roomId],
    ['fileId', fileId],
    ['baseHash', baseHash],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${label} must be non-empty`);
    }
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('createdAt must be a non-negative safe integer');
  }
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(roomId),
    encoder.encode(fileId),
    encoder.encode(baseHash),
    encoder.encode(createdAt.toString(10)),
  ];
  const input = new Uint8Array(
    SNAPSHOT_ID_PREFIX.length + parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  input.set(SNAPSHOT_ID_PREFIX, offset);
  offset += SNAPSHOT_ID_PREFIX.length;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.length;
  }
  const digest = sha256(input);
  input.fill(0);
  return base64UrlEncode(digest.subarray(0, 16));
}

/** Deterministic event envelope id used for relay dedupe across retries. */
export function deriveEventEnvelopeId(roomId: string, eventId: string): string {
  if (roomId.length === 0 || eventId.length === 0) {
    throw new Error('roomId and eventId must be non-empty');
  }
  const room = new TextEncoder().encode(roomId);
  const event = new TextEncoder().encode(eventId);
  const input = new Uint8Array(ENVELOPE_ID_PREFIX.length + room.length + event.length);
  input.set(ENVELOPE_ID_PREFIX, 0);
  input.set(room, ENVELOPE_ID_PREFIX.length);
  input.set(event, ENVELOPE_ID_PREFIX.length + room.length);
  const digest = sha256(input);
  input.fill(0);
  return base64UrlEncode(digest.subarray(0, 16));
}

/**
 * Deterministic envelope id for signal/snapshot payloads.
 * Mirrors Rust `derive_envelope_id_with_nonce`: first 16 bytes of
 * SHA-256("envelope v2" || roomId || deviceId || clientNonce).
 */
export function deriveNonceEnvelopeId(
  roomId: string,
  deviceId: string,
  clientNonce: Uint8Array,
): string {
  if (roomId.length === 0 || deviceId.length === 0) {
    throw new Error('roomId and deviceId must be non-empty');
  }
  if (clientNonce.length !== 16) throw new Error('clientNonce must be 16 bytes');
  const room = new TextEncoder().encode(roomId);
  const device = new TextEncoder().encode(deviceId);
  const input = new Uint8Array(
    ENVELOPE_ID_PREFIX.length + room.length + device.length + clientNonce.length,
  );
  let offset = 0;
  input.set(ENVELOPE_ID_PREFIX, offset);
  offset += ENVELOPE_ID_PREFIX.length;
  input.set(room, offset);
  offset += room.length;
  input.set(device, offset);
  offset += device.length;
  input.set(clientNonce, offset);
  const digest = sha256(input);
  input.fill(0);
  return base64UrlEncode(digest.subarray(0, 16));
}

/** `ContentHash = base64url(SHA-256(canonical snapshot plaintext bytes))`. */
export function contentHash(bytes: Uint8Array): string {
  return base64UrlEncode(sha256(bytes));
}

/**
 * Verify an event signature against a known public key.
 *
 * Rejects if:
 *   - `auth.signingKeyId` does not equal `signingKeyId(publicKey)` (key swap), OR
 *   - the signature isn't valid base64url-no-pad of 64 bytes, OR
 *   - the signature doesn't verify against `canonicalSignedBytes(meta, body)`.
 *
 * Returns `true` on success; throws `SignatureError` on any failure.
 */
export function verifyEventSignature(
  meta: SignableMetaShape,
  body: unknown,
  auth: { signature: string; signingKeyId: string },
  publicKey: Uint8Array,
): true {
  if (publicKey.length !== 32) {
    throw new SignatureError('Ed25519 public key must be 32 bytes');
  }
  const expectedKeyId = signingKeyId(publicKey);
  if (auth.signingKeyId !== expectedKeyId) {
    throw new SignatureError(
      `signingKeyId mismatch: expected ${expectedKeyId}, got ${auth.signingKeyId}`,
    );
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(auth.signature);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new SignatureError(`invalid signature encoding: ${m}`);
  }
  if (sigBytes.length !== 64) {
    throw new SignatureError(
      `invalid signature length: expected 64 bytes, got ${sigBytes.length}`,
    );
  }
  const signed = canonicalSignedBytes(meta, body);
  let ok: boolean;
  try {
    ok = ed25519.verify(sigBytes, signed, publicKey);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new SignatureError(`ed25519 verify error: ${m}`);
  }
  if (!ok) throw new SignatureError('signature verification failed');
  return true;
}

/**
 * Decode an Ed25519 public-signing-key string (base64url-no-pad) into the
 * 32-byte form `verifyEventSignature` expects. Throws on malformed input.
 */
export function decodePublicSigningKey(b64url: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(b64url);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new SignatureError(`invalid public key encoding: ${m}`);
  }
  if (bytes.length !== 32) {
    throw new SignatureError(
      `invalid public key length: expected 32 bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Admission HMAC subprotocol — mirror of `ws.rs::build_subprotocol`.
//
// The relay's WS handshake checks `Sec-WebSocket-Protocol: attn.v2, hmac.<…>`
// where the HMAC is over the canonical request bytes (METHOD || "\n" ||
// PATH || "\n" || CANONICAL_QUERY || "\n" || SHA-256(body)). For the WS
// upgrade the body is empty so the trailing 32 bytes are SHA-256("").
// ---------------------------------------------------------------------------

import { hmac } from '@noble/hashes/hmac.js';

function rfc3986Encode(s: string): string {
  let out = '';
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    const isUnreserved =
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e; // - . _ ~
    if (isUnreserved) {
      out += String.fromCharCode(b);
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function canonicalizeQuery(pairs: Array<[string, string]>): string {
  const sorted = pairs.slice().sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return sorted.map(([k, v]) => `${rfc3986Encode(k)}=${rfc3986Encode(v)}`).join('&');
}

function canonicalRequestBytes(
  method: string,
  urlPath: string,
  queryPairs: Array<[string, string]>,
  body: Uint8Array,
): Uint8Array {
  const canonQuery = canonicalizeQuery(queryPairs);
  const bodyHash = sha256(body);
  const methodBytes = new TextEncoder().encode(method.toUpperCase());
  const pathBytes = new TextEncoder().encode(urlPath);
  const queryBytes = new TextEncoder().encode(canonQuery);
  const out = new Uint8Array(
    methodBytes.length + 1 + pathBytes.length + 1 + queryBytes.length + 1 + bodyHash.length,
  );
  let off = 0;
  out.set(methodBytes, off);
  off += methodBytes.length;
  out[off++] = 0x0a;
  out.set(pathBytes, off);
  off += pathBytes.length;
  out[off++] = 0x0a;
  out.set(queryBytes, off);
  off += queryBytes.length;
  out[off++] = 0x0a;
  out.set(bodyHash, off);
  return out;
}

/**
 * Build `Attn-Owner-Signature: <base64url(Ed25519(canonicalRequest))>` for
 * owner-privileged requests (room create/delete; relay owner-sig.ts). Uses
 * the exact canonical bytes the admission HMAC signs.
 */
export function buildOwnerSignatureHeader(
  signingSecret: Uint8Array,
  method: string,
  urlPath: string,
  body: Uint8Array,
): string {
  if (signingSecret.length !== 32) {
    throw new Error('owner signing secret must be 32 bytes');
  }
  const canon = canonicalRequestBytes(method, urlPath, [], body);
  try {
    return base64UrlEncode(ed25519.sign(canon, signingSecret));
  } finally {
    canon.fill(0);
  }
}

/** Build `Attn-Admission: v2.<base64url HMAC>` for an HTTP request. */
export function buildAdmissionHeader(
  admissionKey: Uint8Array,
  method: string,
  urlPath: string,
  body: Uint8Array,
): string {
  if (admissionKey.length !== 32) {
    throw new Error('admissionKey must be 32 bytes');
  }
  const canon = canonicalRequestBytes(method, urlPath, [], body);
  const tag = hmac(sha256, admissionKey, canon);
  canon.fill(0);
  return `v2.${base64UrlEncode(tag)}`;
}

/** Build a scoped v3 admission header. */
export function buildAdmissionHeaderV3(
  admissionKey: Uint8Array,
  scope: 'read' | 'write',
  method: string,
  urlPath: string,
  body: Uint8Array,
): string {
  if (admissionKey.length !== 32) throw new Error('admissionKey must be 32 bytes');
  const canon = canonicalRequestBytes(method, urlPath, [], body);
  const tag = hmac(sha256, admissionKey, canon);
  canon.fill(0);
  return `v3.${scope}.${base64UrlEncode(tag)}`;
}

/**
 * Build the `Sec-WebSocket-Protocol` value `"attn.v2, hmac.<base64url HMAC>"`
 * the browser passes when opening the WS to the relay. Equivalent to
 * `ws.rs::build_subprotocol`.
 */
export function buildAdmissionSubprotocol(
  admissionKey: Uint8Array,
  method: string,
  urlPath: string,
  queryPairs: Array<[string, string]>,
): string {
  if (admissionKey.length !== 32) {
    throw new Error('admissionKey must be 32 bytes');
  }
  const canon = canonicalRequestBytes(method, urlPath, queryPairs, new Uint8Array(0));
  const tag = hmac(sha256, admissionKey, canon);
  return `attn.v2, hmac.${base64UrlEncode(tag)}`;
}

/** Build the v3 read-scoped WebSocket admission subprotocol. */
export function buildAdmissionSubprotocolV3(
  readAdmissionKey: Uint8Array,
  method: string,
  urlPath: string,
  queryPairs: Array<[string, string]>,
  writeAdmissionKey?: Uint8Array,
): string {
  if (readAdmissionKey.length !== 32) throw new Error('readAdmissionKey must be 32 bytes');
  if (writeAdmissionKey !== undefined && writeAdmissionKey.length !== 32) {
    throw new Error('writeAdmissionKey must be 32 bytes');
  }
  const canon = canonicalRequestBytes(method, urlPath, queryPairs, new Uint8Array(0));
  const readTag = hmac(sha256, readAdmissionKey, canon);
  const writeTag = writeAdmissionKey === undefined ? undefined : hmac(sha256, writeAdmissionKey, canon);
  canon.fill(0);
  if (writeAdmissionKey === undefined) {
    return `attn.v3, read-hmac.${base64UrlEncode(readTag)}`;
  }
  return `attn.v3, read-hmac.${base64UrlEncode(readTag)}, write-hmac.${base64UrlEncode(writeTag!)}`;
}
