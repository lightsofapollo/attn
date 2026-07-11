import {
  aeadSeal,
  base64UrlEncode,
  deriveNonceEnvelopeId,
  randomAeadNonce,
  toCanonicalBytes,
  type EnvelopeAad,
} from './browser-crypto';
import type { MailboxEnvelope } from './browser-ws';

const MAX_SDP_BYTES = 1_048_576;
const MAX_ICE_CANDIDATES = 64;
const MAX_ICE_CANDIDATE_BYTES = 16_384;
const MAX_COLLAB_BYTES = 262_144;

export type BrowserSignalingPayload =
  | { kind: 'offer'; sdp: string; from: string }
  | { kind: 'answer'; sdp: string; from: string }
  | { kind: 'ice'; candidates: string[]; from: string }
  | { kind: 'request_snapshot'; file_id: string; since_snapshot_id?: string; from: string }
  | { kind: 'collab'; from: string; payload: string };

export interface AssembleBrowserSignalInput {
  signalingKey: Uint8Array;
  roomId: string;
  authorId: string;
  deviceId: string;
  /** Required for negotiation/request messages; omitted only for collab broadcast. */
  targetDeviceId?: string;
  createdAt: number;
  expiresAt: number;
  payload: BrowserSignalingPayload;
  /** Stable logical-message nonce used only for envelope-id derivation. */
  clientNonce?: Uint8Array;
  /** Deterministic crypto-test seam. Production callers omit this. */
  aeadNonce?: Uint8Array;
}

/** Mint a native-compatible, relay-opaque `kind:"signal"` envelope. */
export function assembleBrowserSignal(input: AssembleBrowserSignalInput): MailboxEnvelope {
  validateAssembleInput(input);
  const clientNonce = input.clientNonce
    ? new Uint8Array(input.clientNonce)
    : crypto.getRandomValues(new Uint8Array(16));
  const nonce = input.aeadNonce ? new Uint8Array(input.aeadNonce) : randomAeadNonce();
  const envelopeId = deriveNonceEnvelopeId(input.roomId, input.deviceId, clientNonce);
  const aad: EnvelopeAad = {
    v: 2,
    roomId: input.roomId,
    envelopeId,
    kind: 'signal',
    authorId: input.authorId,
    deviceId: input.deviceId,
    createdAt: input.createdAt,
  };
  const plaintext = toCanonicalBytes(input.payload);
  try {
    const ciphertext = aeadSeal(input.signalingKey, nonce, plaintext, aad);
    return {
      v: 2,
      roomId: input.roomId,
      envelopeId,
      authorId: input.authorId,
      deviceId: input.deviceId,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      kind: 'signal',
      target: input.targetDeviceId === undefined ? null : { deviceId: input.targetDeviceId },
      nonce: base64UrlEncode(nonce),
      ciphertext: base64UrlEncode(ciphertext),
      ciphertextBytes: ciphertext.length,
    };
  } finally {
    plaintext.fill(0);
    clientNonce.fill(0);
    nonce.fill(0);
  }
}

/**
 * Enforce the non-AAD-bound routing target before any ciphertext decoding or
 * AEAD work. Broadcast must remain provisionally allowed because native
 * collab signals use it; the decrypted payload gate rejects broadcast
 * offer/answer/ICE before they reach RTCPeerConnection.
 */
export function validateSignalTarget(envelope: MailboxEnvelope, localDeviceId: string): boolean {
  return (
    envelope.kind === 'signal' &&
    (envelope.target === null || envelope.target === undefined || envelope.target.deviceId === localDeviceId)
  );
}

/** Parse and strictly validate a decrypted signaling payload. */
export function parseBrowserSignalingPayload(
  plaintext: Uint8Array,
  envelopeDeviceId: string,
): BrowserSignalingPayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('signal plaintext is not valid JSON');
  }
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.from !== 'string') {
    throw new Error('signal plaintext has invalid shape');
  }
  if (value.from.length === 0 || value.from !== envelopeDeviceId) {
    throw new Error('signal sender does not match envelope device');
  }
  switch (value.kind) {
    case 'offer':
    case 'answer': {
      requireExactKeys(value, ['kind', 'sdp', 'from']);
      if (typeof value.sdp !== 'string' || value.sdp.length === 0 || byteLength(value.sdp) > MAX_SDP_BYTES) {
        throw new Error('signal SDP is invalid or too large');
      }
      return { kind: value.kind, sdp: value.sdp, from: value.from };
    }
    case 'ice': {
      requireExactKeys(value, ['kind', 'candidates', 'from']);
      if (!Array.isArray(value.candidates) || value.candidates.length > MAX_ICE_CANDIDATES) {
        throw new Error('signal ICE candidate list is invalid');
      }
      const candidates = value.candidates.map((candidate) => {
        if (
          typeof candidate !== 'string' ||
          candidate.length === 0 ||
          byteLength(candidate) > MAX_ICE_CANDIDATE_BYTES
        ) {
          throw new Error('signal ICE candidate is invalid or too large');
        }
        return candidate;
      });
      return { kind: 'ice', candidates, from: value.from };
    }
    case 'request_snapshot': {
      requireExactKeys(value, ['kind', 'file_id', 'since_snapshot_id', 'from'], ['since_snapshot_id']);
      if (typeof value.file_id !== 'string' || value.file_id.length === 0) {
        throw new Error('snapshot request file id is invalid');
      }
      if (value.since_snapshot_id !== undefined && typeof value.since_snapshot_id !== 'string') {
        throw new Error('snapshot request since id is invalid');
      }
      return {
        kind: 'request_snapshot',
        file_id: value.file_id,
        ...(value.since_snapshot_id === undefined
          ? {}
          : { since_snapshot_id: value.since_snapshot_id }),
        from: value.from,
      };
    }
    case 'collab': {
      requireExactKeys(value, ['kind', 'from', 'payload']);
      if (typeof value.payload !== 'string' || byteLength(value.payload) > MAX_COLLAB_BYTES) {
        throw new Error('collab signal payload is invalid or too large');
      }
      return { kind: 'collab', from: value.from, payload: value.payload };
    }
    default:
      throw new Error('unknown signaling payload kind');
  }
}

function validateAssembleInput(input: AssembleBrowserSignalInput): void {
  if (input.signalingKey.length !== 32) throw new Error('signalingKey must be 32 bytes');
  for (const [label, value] of [
    ['roomId', input.roomId],
    ['authorId', input.authorId],
    ['deviceId', input.deviceId],
  ] as const) {
    if (value.length === 0) throw new Error(`${label} is required`);
  }
  if (input.payload.kind === 'collab') {
    if (input.targetDeviceId !== undefined) {
      throw new Error('collab signal must be broadcast with no targetDeviceId');
    }
  } else if (input.targetDeviceId === undefined || input.targetDeviceId.length === 0) {
    throw new Error('targetDeviceId is required for non-collab signaling');
  }
  if (input.payload.from !== input.deviceId) throw new Error('signal from must match deviceId');
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) {
    throw new Error('createdAt must be a positive safe integer');
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < input.createdAt) {
    throw new Error('expiresAt must be at or after createdAt');
  }
  if (input.clientNonce !== undefined && input.clientNonce.length !== 16) {
    throw new Error('clientNonce must be 16 bytes');
  }
  if (input.aeadNonce !== undefined && input.aeadNonce.length !== 24) {
    throw new Error('aeadNonce must be 24 bytes');
  }
  // Reuse the strict parser for outbound bounds and exact shape.
  const bytes = toCanonicalBytes(input.payload);
  try {
    parseBrowserSignalingPayload(bytes, input.deviceId);
  } finally {
    bytes.fill(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  optional: string[] = [],
): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key))) throw new Error('signal plaintext has extra fields');
  for (const key of allowed) {
    if (!optional.includes(key) && !(key in value)) throw new Error(`signal plaintext omitted ${key}`);
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
