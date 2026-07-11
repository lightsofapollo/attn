// Browser owner room bootstrap (attn-7xl.4.1).
//
// Lets a browser-local workspace CREATE and own an attn review room using
// the exact native relay protocol (relay-spec.md §POST /v2/rooms/:roomId):
//
//   body    {v: 2, policy, ownerSigningKey, admissionKey}
//   headers Attn-Admission        (HMAC over canonicalRequest, admissionKey)
//           Attn-Owner-Signature  (Ed25519 over the same canonical bytes —
//                                  proves possession of the owner key)
//           Attn-PoW              (bound to roomId + ownerSigningKeyId)
//
// then registers the owner device (kind "owner", client "attn-browser") with
// the same registration flow reviewers use. Failure after a first-create
// rolls the room back via owner-signed DELETE so an interrupted share never
// leaves a half-owned room behind. Rejoin (relay 200) is idempotent.
//
// Interoperability: every derivation (room id, room keys, admission,
// canonical request, self-signature) reuses the modules already proven
// against native rooms by the reviewer flow, so a browser-created room is
// indistinguishable from a native-created one on the wire.

import {
  base64UrlEncode,
  buildAdmissionHeader,
  buildAdmissionHeaderV3,
  buildOwnerSignatureHeader,
  deriveRoomId,
  deriveRoomIdV3,
  deriveRoomKeyTreeV3,
  deriveRoomKeys,
  signingKeyId,
  type RoomKeys,
  type RoomKeyTreeV3,
} from './browser-crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { mintBrowserPowInWorker, type BrowserPowInputs } from './browser-pow';
import {
  buildRegisterDeviceBody,
  canonicalDeviceGrantV3,
  generateBrowserIdentity,
  type BrowserDeviceIdentity,
} from './browser-session';
import { validateBrowserRelayUrl } from './browser-relay-url';
import type { RoomPolicy } from './browser-ws';

/** Mirrors bootstrap.rs BOOTSTRAP_POW_DIFFICULTY. */
export const OWNER_BOOTSTRAP_POW_DIFFICULTY = 12;

export type OwnerPowRequest = Omit<BrowserPowInputs, 'expiresAt' | 'rand' | 'counterStart'>;

export class OwnerBootstrapError extends Error {
  readonly stage: 'create' | 'register' | 'rollback';
  readonly status?: number;

  constructor(stage: 'create' | 'register' | 'rollback', message: string, status?: number) {
    super(message);
    this.name = 'OwnerBootstrapError';
    this.stage = stage;
    if (status !== undefined) this.status = status;
  }
}

/** Default share policy, mirroring bootstrap.rs::default_room_policy. */
export function defaultOwnerPolicy(createdAtMs: number): RoomPolicy {
  return {
    mode: 'hybrid',
    maxPeers: 8,
    maxSnapshotBytes: 5 * 1024 * 1024,
    maxEventBytes: 256 * 1024,
    maxEvents: 500,
    expiresAt: createdAtMs + 24 * 60 * 60 * 1000,
    powBits: OWNER_BOOTSTRAP_POW_DIFFICULTY,
    deleteEventsAfterOwnerAck: false,
    allowBrowser: true,
    allowRemoteAgents: true,
  };
}

/** Wire policy exactly as bootstrap.rs::WirePolicy serializes it. */
function wirePolicy(policy: RoomPolicy, longSession: boolean): Record<string, unknown> {
  return {
    mode: policy.mode,
    maxPeers: policy.maxPeers,
    maxSnapshotBytes: policy.maxSnapshotBytes,
    maxEventBytes: policy.maxEventBytes,
    maxEvents: policy.maxEvents,
    expiresAt: policy.expiresAt,
    idleTimeoutMs: 60 * 60 * 1000,
    longSession,
    powBits: OWNER_BOOTSTRAP_POW_DIFFICULTY,
    deleteEventsAfterOwnerAck: policy.deleteEventsAfterOwnerAck,
    allowBrowser: policy.allowBrowser,
    allowRemoteAgents: policy.allowRemoteAgents,
  };
}

export interface OwnedRoomBootstrap {
  roomId: string;
  /** The invite secret. The caller owns it: wrap (attn-7xl.4.2) then zero. */
  roomSecret: Uint8Array;
  keys: RoomKeys;
  identity: BrowserDeviceIdentity;
  policy: RoomPolicy;
  /** False when the relay reported an idempotent rejoin (200). */
  created: boolean;
}

/** Browser-owned ordinary v3 epoch room used behind a stable durable share. */
export interface OwnedRoomBootstrapV3 {
  roomId: string;
  roomSecret: Uint8Array;
  keys: RoomKeyTreeV3;
  identity: BrowserDeviceIdentity;
  policy: RoomPolicy;
  commentGrantSignature: string;
  suggestGrantSignature: string;
  created: boolean;
}

export interface CreateOwnedRoomOptions {
  relayUrl: string;
  policy?: RoomPolicy;
  /** Relay 7-day tier. Must be explicit; ordinary rooms remain bounded to 24h. */
  longSession?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Injectable PoW minter (tests); defaults to the worker miner. */
  mintPow?: (input: OwnerPowRequest, signal: AbortSignal) => Promise<string>;
  /** Reuse an existing identity (resume paths); defaults to a fresh one. */
  identity?: BrowserDeviceIdentity;
  /** Reuse an existing room secret (recreate flows); defaults to fresh. */
  roomSecret?: Uint8Array;
  signal?: AbortSignal;
}

export async function createOwnedRoom(options: CreateOwnedRoomOptions): Promise<OwnedRoomBootstrap> {
  const relay = validateBrowserRelayUrl(options.relayUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const mintPow = options.mintPow ?? ((input, signal) => mintBrowserPowInWorker(input, { signal }));
  const abort = options.signal ?? new AbortController().signal;

  const roomSecret = options.roomSecret ?? crypto.getRandomValues(new Uint8Array(32));
  const roomId = deriveRoomId(roomSecret);
  const keys = deriveRoomKeys(roomSecret);
  const identity = options.identity ?? generateBrowserIdentity();
  const policy = options.policy ?? defaultOwnerPolicy(now());

  // ————— POST /v2/rooms/:roomId —————
  const path = `/v2/rooms/${roomId}`;
  const body = {
    v: 2,
    policy: wirePolicy(policy, options.longSession === true),
    ownerSigningKey: base64UrlEncode(identity.signingPublic),
    admissionKey: base64UrlEncode(keys.admissionKey),
  };
  const bodyJson = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const ownerSigningKeyId = signingKeyId(identity.signingPublic);
  const pow = await mintPow(
    { roomId, deviceId: ownerSigningKeyId, method: 'POST', path, difficulty: OWNER_BOOTSTRAP_POW_DIFFICULTY },
    abort,
  );
  const createResponse = await fetchImpl(`${relay}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Attn-Admission': buildAdmissionHeader(keys.admissionKey, 'POST', path, bodyBytes),
      'Attn-Owner-Signature': buildOwnerSignatureHeader(
        identity.signingSecret,
        'POST',
        path,
        bodyBytes,
      ),
      'Attn-PoW': pow,
    },
    body: bodyJson,
  });
  if (createResponse.status !== 200 && createResponse.status !== 201) {
    const text = await createResponse.text().catch(() => '');
    throw new OwnerBootstrapError(
      'create',
      `room create failed: ${text.slice(0, 200)}`,
      createResponse.status,
    );
  }
  const created = createResponse.status === 201;

  // ————— POST /v2/rooms/:roomId/devices (kind "owner") —————
  try {
    await registerOwnerDevice({ relay, roomId, keys, identity, fetchImpl, mintPow, abort });
  } catch (error) {
    // A room whose owner never registered is unusable: roll it back so the
    // interrupted share leaves nothing behind. Rollback is best-effort; the
    // original failure is what the caller must see.
    if (created) {
      await deleteOwnedRoom({
        relayUrl: relay,
        roomId,
        identity,
        admissionKey: keys.admissionKey,
        fetchImpl,
        mintPow,
      }).catch(() => undefined);
    }
    throw error;
  }

  return { roomId, roomSecret, keys, identity, policy, created };
}

/**
 * Create or rejoin a split-capability v3 room and register its browser owner.
 * The returned grant signatures are bound to this exact room and owner key;
 * callers place them only inside the comment/suggest durable-share bundles.
 */
export async function createOwnedRoomV3(
  options: CreateOwnedRoomOptions,
): Promise<OwnedRoomBootstrapV3> {
  const relay = validateBrowserRelayUrl(options.relayUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const mintPow = options.mintPow ?? ((input, signal) => mintBrowserPowInWorker(input, { signal }));
  const abort = options.signal ?? new AbortController().signal;
  const roomSecret = options.roomSecret ?? crypto.getRandomValues(new Uint8Array(32));
  const roomId = deriveRoomIdV3(roomSecret);
  const keys = deriveRoomKeyTreeV3(roomSecret);
  const identity = options.identity ?? generateBrowserIdentity();
  const policy = options.policy ?? defaultOwnerPolicy(now());
  const path = `/v3/rooms/${roomId}`;
  const body = {
    v: 3,
    policy: wirePolicy(policy, options.longSession === true),
    ownerSigningKey: base64UrlEncode(identity.signingPublic),
    readAdmissionKey: base64UrlEncode(keys.readKeys.readAdmissionKey),
    writeAdmissionKey: base64UrlEncode(keys.writeAdmissionKey),
  };
  const bodyJson = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const ownerSigningKeyId = signingKeyId(identity.signingPublic);
  const pow = await mintPow(
    { roomId, deviceId: ownerSigningKeyId, method: 'POST', path, difficulty: OWNER_BOOTSTRAP_POW_DIFFICULTY },
    abort,
  );
  const createResponse = await fetchImpl(`${relay}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Attn-Admission': buildAdmissionHeaderV3(
        keys.writeAdmissionKey,
        'write',
        'POST',
        path,
        bodyBytes,
      ),
      'Attn-Owner-Signature': buildOwnerSignatureHeader(identity.signingSecret, 'POST', path, bodyBytes),
      'Attn-PoW': pow,
    },
    body: bodyJson,
  });
  if (createResponse.status !== 200 && createResponse.status !== 201) {
    const message = await createResponse.text().catch(() => '');
    throw new OwnerBootstrapError('create', `room create failed: ${message.slice(0, 200)}`, createResponse.status);
  }
  const created = createResponse.status === 201;
  try {
    await registerOwnerDeviceV3({ relay, roomId, keys, identity, fetchImpl, mintPow, abort });
  } catch (error) {
    if (created) {
      await deleteOwnedRoomV3({
        relayUrl: relay,
        roomId,
        identity,
        writeAdmissionKey: keys.writeAdmissionKey,
        fetchImpl,
        mintPow,
      }).catch(() => undefined);
    }
    throw error;
  }
  const signGrant = (tier: 'comment' | 'suggest'): string => base64UrlEncode(
    ed25519.sign(canonicalDeviceGrantV3(roomId, tier), identity.signingSecret),
  );
  return {
    roomId,
    roomSecret,
    keys,
    identity,
    policy,
    commentGrantSignature: signGrant('comment'),
    suggestGrantSignature: signGrant('suggest'),
    created,
  };
}

async function registerOwnerDevice(input: {
  relay: string;
  roomId: string;
  keys: RoomKeys;
  identity: BrowserDeviceIdentity;
  fetchImpl: typeof fetch;
  mintPow: (pow: OwnerPowRequest, signal: AbortSignal) => Promise<string>;
  abort: AbortSignal;
}): Promise<void> {
  const body = buildRegisterDeviceBody(input.identity, 'owner');
  const bodyJson = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const path = `/v2/rooms/${input.roomId}/devices`;
  const pow = await input.mintPow(
    {
      roomId: input.roomId,
      deviceId: input.identity.deviceId,
      method: 'POST',
      path,
      difficulty: OWNER_BOOTSTRAP_POW_DIFFICULTY,
    },
    input.abort,
  );
  const response = await input.fetchImpl(`${input.relay}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Attn-Admission': buildAdmissionHeader(input.keys.admissionKey, 'POST', path, bodyBytes),
      'Attn-PoW': pow,
    },
    body: bodyJson,
  });
  if (response.status !== 200 && response.status !== 204) {
    const text = await response.text().catch(() => '');
    throw new OwnerBootstrapError(
      'register',
      `owner registration failed: ${text.slice(0, 200)}`,
      response.status,
    );
  }
}

async function registerOwnerDeviceV3(input: {
  relay: string;
  roomId: string;
  keys: RoomKeyTreeV3;
  identity: BrowserDeviceIdentity;
  fetchImpl: typeof fetch;
  mintPow: (pow: OwnerPowRequest, signal: AbortSignal) => Promise<string>;
  abort: AbortSignal;
}): Promise<void> {
  const body = buildRegisterDeviceBody(input.identity, 'owner');
  const bodyJson = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const path = `/v3/rooms/${input.roomId}/devices`;
  const pow = await input.mintPow({
    roomId: input.roomId,
    deviceId: input.identity.deviceId,
    method: 'POST',
    path,
    difficulty: OWNER_BOOTSTRAP_POW_DIFFICULTY,
  }, input.abort);
  const response = await input.fetchImpl(`${input.relay}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Attn-Admission': buildAdmissionHeaderV3(
        input.keys.writeAdmissionKey,
        'write',
        'POST',
        path,
        bodyBytes,
      ),
      'Attn-PoW': pow,
    },
    body: bodyJson,
  });
  if (response.status !== 200 && response.status !== 204) {
    const message = await response.text().catch(() => '');
    throw new OwnerBootstrapError('register', `owner registration failed: ${message.slice(0, 200)}`, response.status);
  }
}

/**
 * Owner-signed room teardown. The relay requires all three proofs: admission
 * HMAC (URL possession), PoW bound to the REGISTERED deleting device, and
 * the owner Ed25519 signature (room-do.ts::handleRoomDelete).
 */
export async function deleteOwnedRoom(input: {
  relayUrl: string;
  roomId: string;
  identity: BrowserDeviceIdentity;
  admissionKey: Uint8Array;
  fetchImpl?: typeof fetch;
  mintPow?: (pow: OwnerPowRequest, signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}): Promise<boolean> {
  const relay = validateBrowserRelayUrl(input.relayUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const mintPow =
    input.mintPow ?? ((request, signal) => mintBrowserPowInWorker(request, { signal }));
  const abort = input.signal ?? new AbortController().signal;
  const path = `/v2/rooms/${input.roomId}`;
  const empty = new Uint8Array(0);
  const pow = await mintPow(
    {
      roomId: input.roomId,
      deviceId: input.identity.deviceId,
      method: 'DELETE',
      path,
      difficulty: OWNER_BOOTSTRAP_POW_DIFFICULTY,
    },
    abort,
  );
  const response = await fetchImpl(`${relay}${path}`, {
    method: 'DELETE',
    headers: {
      'Attn-Admission': buildAdmissionHeader(input.admissionKey, 'DELETE', path, empty),
      'Attn-PoW': pow,
      'Attn-Owner-Signature': buildOwnerSignatureHeader(
        input.identity.signingSecret,
        'DELETE',
        path,
        empty,
      ),
    },
  });
  // Stop is idempotent: an authenticated owner asking to delete a room that
  // is already absent/expired has reached the same authoritative outcome.
  return response.status === 200
    || response.status === 204
    || response.status === 404
    || response.status === 410;
}

export async function deleteOwnedRoomV3(input: {
  relayUrl: string;
  roomId: string;
  identity: BrowserDeviceIdentity;
  writeAdmissionKey: Uint8Array;
  fetchImpl?: typeof fetch;
  mintPow?: (pow: OwnerPowRequest, signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}): Promise<boolean> {
  const relay = validateBrowserRelayUrl(input.relayUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const mintPow = input.mintPow ?? ((request, signal) => mintBrowserPowInWorker(request, { signal }));
  const abort = input.signal ?? new AbortController().signal;
  const path = `/v3/rooms/${input.roomId}`;
  const empty = new Uint8Array(0);
  const pow = await mintPow({
    roomId: input.roomId,
    deviceId: input.identity.deviceId,
    method: 'DELETE',
    path,
    difficulty: OWNER_BOOTSTRAP_POW_DIFFICULTY,
  }, abort);
  const response = await fetchImpl(`${relay}${path}`, {
    method: 'DELETE',
    headers: {
      'Attn-Admission': buildAdmissionHeaderV3(
        input.writeAdmissionKey,
        'write',
        'DELETE',
        path,
        empty,
      ),
      'Attn-PoW': pow,
      'Attn-Owner-Signature': buildOwnerSignatureHeader(input.identity.signingSecret, 'DELETE', path, empty),
    },
  });
  return response.status === 200 || response.status === 204 || response.status === 404 || response.status === 410;
}
