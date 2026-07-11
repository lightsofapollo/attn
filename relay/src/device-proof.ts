import { base64UrlDecode, base64UrlEncode } from "./admission";
import { canonicalize } from "./canonical";

export const DEVICE_WS_PROOF_PURPOSE_V3 = "attn device websocket proof v3";
export const DEVICE_SIGNAL_PROOF_PURPOSE_V3 = "attn device signal proof v3";
export const DEVICE_HTTP_PROOF_PURPOSE_V3 = "attn device http proof v3";
export const DEVICE_PROOF_NONCE_BYTES = 16;
export const DEVICE_PROOF_MAX_LIFETIME_MS = 5 * 60_000;

export interface DeviceWebSocketProofV3 {
  v: 3;
  purpose: typeof DEVICE_WS_PROOF_PURPOSE_V3;
  roomId: string;
  deviceId: string;
  method: "GET";
  path: string;
  expiresAt: number;
  nonce: string;
}

export interface DeviceSignalProofV3 {
  v: 3;
  purpose: typeof DEVICE_SIGNAL_PROOF_PURPOSE_V3;
  roomId: string;
  envelopeId: string;
  authorId: string;
  deviceId: string;
  targetDeviceId: string | null;
  generation: number;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  ciphertext: string;
  ciphertextBytes: number;
}

export interface DeviceHttpProofV3 {
  v: 3;
  purpose: typeof DEVICE_HTTP_PROOF_PURPOSE_V3;
  resourceKind: "room" | "share";
  resourceId: string;
  deviceId: string;
  method: "POST" | "DELETE";
  path: string;
  bodySha256: string;
  bodyLength: number;
  powToken: string;
}

export class DeviceProofError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DeviceProofError";
  }
}

export function canonicalDeviceWebSocketProofV3(
  input: Omit<DeviceWebSocketProofV3, "v" | "purpose" | "method">,
): Uint8Array {
  return new TextEncoder().encode(canonicalize({
    deviceId: input.deviceId,
    expiresAt: input.expiresAt,
    method: "GET",
    nonce: input.nonce,
    path: input.path,
    purpose: DEVICE_WS_PROOF_PURPOSE_V3,
    roomId: input.roomId,
    v: 3,
  }));
}

export function canonicalDeviceSignalProofV3(
  input: Omit<DeviceSignalProofV3, "v" | "purpose">,
): Uint8Array {
  return new TextEncoder().encode(canonicalize({
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
    targetDeviceId: input.targetDeviceId,
    v: 3,
  }));
}

export function canonicalDeviceHttpProofV3(
  input: Omit<DeviceHttpProofV3, "v" | "purpose">,
): Uint8Array {
  return new TextEncoder().encode(canonicalize({
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
  }));
}

export async function deviceHttpBodySha256(body: Uint8Array): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
}

export async function verifyDeviceHttpProofV3(input: {
  publicSigningKey: string;
  signature: string;
  resourceKind: "room" | "share";
  resourceId: string;
  deviceId: string;
  method: string;
  path: string;
  body: Uint8Array;
  powToken: string;
}): Promise<void> {
  if (input.method !== "POST" && input.method !== "DELETE") {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device HTTP proof method is invalid");
  }
  if (input.path.length === 0 || input.resourceId.length === 0 || input.deviceId.length === 0) {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device HTTP proof contains an empty bound field");
  }
  if (input.powToken.length === 0) {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device HTTP proof requires the exact PoW token");
  }
  await verifyDeviceProofSignature(
    input.publicSigningKey,
    input.signature,
    canonicalDeviceHttpProofV3({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      deviceId: input.deviceId,
      method: input.method,
      path: input.path,
      bodySha256: await deviceHttpBodySha256(input.body),
      bodyLength: input.body.byteLength,
      powToken: input.powToken,
    }),
  );
}

export function validateDeviceProofNonce(nonce: string): void {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(nonce);
  } catch {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device proof nonce is not base64url");
  }
  if (bytes.length !== DEVICE_PROOF_NONCE_BYTES) {
    throw new DeviceProofError(
      "ATTN_DEVICE_PROOF_INVALID",
      `device proof nonce must be ${DEVICE_PROOF_NONCE_BYTES} bytes`,
    );
  }
}

export function validateDeviceProofTime(expiresAt: number, now: number): void {
  if (!Number.isSafeInteger(expiresAt)) {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device proof expiry must be an integer");
  }
  if (expiresAt < now) {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_EXPIRED", "device proof has expired");
  }
  if (expiresAt > now + DEVICE_PROOF_MAX_LIFETIME_MS) {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device proof expiry is too far in the future");
  }
}

export async function verifyDeviceProofSignature(
  publicSigningKey: string,
  signature: string,
  canonical: Uint8Array,
): Promise<void> {
  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKeyBytes = base64UrlDecode(publicSigningKey);
    signatureBytes = base64UrlDecode(signature);
  } catch {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device proof key or signature is not base64url");
  }
  if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device proof key or signature has invalid length");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "registered device signing key is invalid");
  }
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, canonical);
  if (!valid) {
    throw new DeviceProofError("ATTN_DEVICE_PROOF_INVALID", "device proof signature is invalid");
  }
}
