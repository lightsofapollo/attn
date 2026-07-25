import { ed25519 } from '@noble/curves/ed25519.js';
import { base64UrlDecode, base64UrlEncode, toCanonicalBytes } from './browser-crypto';
import type { MailboxEnvelope } from './browser-ws';

export const DEVICE_WS_PROOF_PURPOSE_V3 = 'attn device websocket proof v3';
export const DEVICE_SIGNAL_PROOF_PURPOSE_V3 = 'attn device signal proof v3';
export const DEVICE_HTTP_PROOF_PURPOSE_V3 = 'attn device http proof v3';
export const DEVICE_PROOF_LIFETIME_MS = 60_000;

export interface DeviceWebSocketProofV3 {
  expiresAt: number;
  nonce: string;
  signature: string;
}

export interface DeviceSignalProofInputV3 {
  roomId: string;
  envelopeId: string;
  authorId: string;
  deviceId: string;
  targetDeviceId: string | null;
  signalClass?: 'presence';
  generation: number;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  ciphertext: string;
  ciphertextBytes: number;
}

export interface DeviceHttpProofInputV3 {
  resourceKind: 'room' | 'share';
  resourceId: string;
  deviceId: string;
  method: 'POST' | 'DELETE';
  path: string;
  bodySha256: string;
  bodyLength: number;
  powToken: string;
}

export function canonicalDeviceHttpProofV3(input: DeviceHttpProofInputV3): Uint8Array {
  return toCanonicalBytes({
    bodyLength: input.bodyLength,
    bodySha256: input.bodySha256,
    deviceId: input.deviceId,
    method: input.method,
    path: input.path,
    powToken: input.powToken,
    purpose: DEVICE_HTTP_PROOF_PURPOSE_V3,
    resourceId: input.resourceId,
    resourceKind: input.resourceKind,
    v: 3,
  });
}

export async function createDeviceHttpProofV3(input: {
  resourceKind: 'room' | 'share';
  resourceId: string;
  deviceId: string;
  method: 'POST' | 'DELETE';
  path: string;
  body: Uint8Array;
  powToken: string;
  signingSecret: Uint8Array;
}): Promise<string> {
  if (input.signingSecret.byteLength !== 32) throw new Error('device signing secret must be 32 bytes');
  if (input.resourceId.length === 0 || input.deviceId.length === 0 || input.path.length === 0 || input.powToken.length === 0) {
    throw new Error('device HTTP proof contains an empty bound field');
  }
  const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBuffer(input.body)));
  const canonical = canonicalDeviceHttpProofV3({
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    deviceId: input.deviceId,
    method: input.method,
    path: input.path,
    bodySha256: base64UrlEncode(digestBytes),
    bodyLength: input.body.byteLength,
    powToken: input.powToken,
  });
  try {
    return base64UrlEncode(ed25519.sign(canonical, input.signingSecret));
  } finally {
    digestBytes.fill(0);
    canonical.fill(0);
  }
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function canonicalDeviceSignalProofV3(input: DeviceSignalProofInputV3): Uint8Array {
  return toCanonicalBytes({
    authorId: input.authorId,
    ciphertext: input.ciphertext,
    ciphertextBytes: input.ciphertextBytes,
    createdAt: input.createdAt,
    deviceId: input.deviceId,
    envelopeId: input.envelopeId,
    expiresAt: input.expiresAt,
    generation: input.generation,
    nonce: input.nonce,
    purpose: DEVICE_SIGNAL_PROOF_PURPOSE_V3,
    roomId: input.roomId,
    ...(input.signalClass === undefined ? {} : { signalClass: input.signalClass }),
    targetDeviceId: input.targetDeviceId,
    v: 3,
  });
}

export function signDeviceSignalProofV3(
  input: DeviceSignalProofInputV3,
  signingSecret: Uint8Array,
): string {
  if (signingSecret.length !== 32) throw new Error('device signing secret must be 32 bytes');
  validateDeviceSignalProofInput(input);
  const canonical = canonicalDeviceSignalProofV3(input);
  try {
    return base64UrlEncode(ed25519.sign(canonical, signingSecret));
  } finally {
    canonical.fill(0);
  }
}

export function verifyDeviceSignalProofV3(
  envelope: MailboxEnvelope,
  roomId: string,
  publicSigningKey: string,
): void {
  if (!Number.isSafeInteger(envelope.signalGeneration) || (envelope.signalGeneration ?? -1) < 0) {
    throw new Error('signal generation is missing or invalid');
  }
  if (typeof envelope.deviceSignature !== 'string') {
    throw new Error('signal device signature is missing');
  }
  const input = signalProofInputFromEnvelope(envelope, roomId);
  validateDeviceSignalProofInput(input);
  const signature = base64UrlDecode(envelope.deviceSignature);
  const publicKey = base64UrlDecode(publicSigningKey);
  if (signature.length !== 64 || publicKey.length !== 32) {
    throw new Error('signal device proof key or signature has invalid length');
  }
  const canonical = canonicalDeviceSignalProofV3(input);
  try {
    if (!ed25519.verify(signature, canonical, publicKey)) {
      throw new Error('signal device signature is invalid');
    }
  } finally {
    canonical.fill(0);
    signature.fill(0);
    publicKey.fill(0);
  }
}

export function signalProofInputFromEnvelope(
  envelope: MailboxEnvelope,
  roomId: string,
): DeviceSignalProofInputV3 {
  if (envelope.signalGeneration === undefined) throw new Error('signal generation is missing');
  return {
    roomId,
    envelopeId: envelope.envelopeId,
    authorId: envelope.authorId,
    deviceId: envelope.deviceId,
    targetDeviceId: envelope.target?.deviceId ?? null,
    ...(envelope.signalClass === undefined ? {} : { signalClass: envelope.signalClass }),
    generation: envelope.signalGeneration,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    ciphertextBytes: envelope.ciphertextBytes,
  };
}

function validateDeviceSignalProofInput(input: DeviceSignalProofInputV3): void {
  for (const value of [input.roomId, input.envelopeId, input.authorId, input.deviceId, input.nonce, input.ciphertext]) {
    if (value.length === 0) throw new Error('signal proof contains an empty bound field');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error('signal generation is invalid');
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) throw new Error('signal createdAt is invalid');
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < input.createdAt) throw new Error('signal expiresAt is invalid');
  if (!Number.isSafeInteger(input.ciphertextBytes) || input.ciphertextBytes <= 0) throw new Error('signal ciphertext length is invalid');
}

export function canonicalDeviceWebSocketProofV3(input: {
  roomId: string;
  deviceId: string;
  path: string;
  expiresAt: number;
  nonce: string;
}): Uint8Array {
  return toCanonicalBytes({
    deviceId: input.deviceId,
    expiresAt: input.expiresAt,
    method: 'GET',
    nonce: input.nonce,
    path: input.path,
    purpose: DEVICE_WS_PROOF_PURPOSE_V3,
    roomId: input.roomId,
    v: 3,
  });
}

export function createDeviceWebSocketProofV3(input: {
  roomId: string;
  deviceId: string;
  path: string;
  signingSecret: Uint8Array;
  now?: number;
  nonceBytes?: Uint8Array;
}): DeviceWebSocketProofV3 {
  if (input.signingSecret.length !== 32) throw new Error('device signing secret must be 32 bytes');
  const nonceBytes = input.nonceBytes === undefined
    ? crypto.getRandomValues(new Uint8Array(16))
    : new Uint8Array(input.nonceBytes);
  if (nonceBytes.length !== 16) throw new Error('device proof nonce must be 16 bytes');
  const expiresAt = (input.now ?? Date.now()) + DEVICE_PROOF_LIFETIME_MS;
  const nonce = base64UrlEncode(nonceBytes);
  const canonical = canonicalDeviceWebSocketProofV3({
    roomId: input.roomId,
    deviceId: input.deviceId,
    path: input.path,
    expiresAt,
    nonce,
  });
  try {
    return {
      expiresAt,
      nonce,
      signature: base64UrlEncode(ed25519.sign(canonical, input.signingSecret)),
    };
  } finally {
    canonical.fill(0);
    nonceBytes.fill(0);
  }
}
