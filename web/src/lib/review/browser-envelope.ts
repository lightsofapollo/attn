import {
  aeadSeal,
  base64UrlEncode,
  deriveEventEnvelopeId,
  deriveEventId,
  deriveNonceEnvelopeId,
  randomAeadNonce,
  signEvent,
  toCanonicalBytes,
  type EnvelopeAad,
  type SignableMetaShape,
} from './browser-crypto';
import { signDeviceSignalProofV3 } from './device-proof';
import type { MailboxEnvelope } from './browser-ws';
import type {
  EventId,
  ReviewEvent,
  ReviewEventBody,
  RoomId,
  SnapshotId,
} from '../types';

export interface AssembleBrowserEventInput {
  eventKey: Uint8Array;
  signingSecret: Uint8Array;
  signingPublic: Uint8Array;
  roomId: RoomId;
  authorId: string;
  deviceId: string;
  createdAt: number;
  expiresAt: number;
  parentEventIds?: EventId[];
  snapshotId?: SnapshotId;
  body: ReviewEventBody;
  /** Deterministic test override. Production callers must omit this. */
  nonce?: Uint8Array;
}

export interface AssembledBrowserEvent {
  event: ReviewEvent;
  envelope: MailboxEnvelope;
}

export interface AssembleSnapshotBlobEnvelopeInput {
  plaintext: Uint8Array;
  snapshotKey: Uint8Array;
  roomId: RoomId;
  authorId: string;
  deviceId: string;
  /** Durable 16-byte nonce used only for EnvelopeId derivation. */
  clientNonce: Uint8Array;
  createdAt: number;
  expiresAt: number;
  /**
   * Registered device signing secret (32 bytes). When present on a v3 owner
   * publish, the snapshot carries a device-proof signature so the relay can
   * authenticate it as an owner snapshot before honoring signal compaction.
   * Reviewers may omit it — an unsigned snapshot is still valid, it just never
   * drives compaction.
   */
  signingSecret?: Uint8Array;
  /** Deterministic AEAD nonce override. Production callers must omit this. */
  nonce?: Uint8Array;
}

/**
 * Assemble native `kind: snapshot_blob` bytes. On a v3 owner publish (when
 * `signingSecret` is supplied) the envelope carries a device-proof signature
 * over its own envelopeId + ciphertext so the relay can authenticate the owner.
 */
export function assembleSnapshotBlobEnvelope(
  input: AssembleSnapshotBlobEnvelopeInput,
): MailboxEnvelope {
  validateSnapshotBlobInput(input);
  const envelopeId = deriveNonceEnvelopeId(input.roomId, input.deviceId, input.clientNonce);
  const aad: EnvelopeAad = {
    v: 2,
    roomId: input.roomId,
    envelopeId,
    kind: 'snapshot_blob',
    authorId: input.authorId,
    deviceId: input.deviceId,
    createdAt: input.createdAt,
  };
  const nonce = input.nonce ? new Uint8Array(input.nonce) : randomAeadNonce();
  try {
    const ciphertext = aeadSeal(input.snapshotKey, nonce, input.plaintext, aad);
    const ciphertextB64 = base64UrlEncode(ciphertext);
    const envelope: MailboxEnvelope = {
      v: 2,
      roomId: input.roomId,
      envelopeId,
      authorId: input.authorId,
      deviceId: input.deviceId,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      kind: 'snapshot_blob',
      nonce: base64UrlEncode(nonce),
      ciphertext: ciphertextB64,
      ciphertextBytes: ciphertext.length,
    };
    if (input.signingSecret !== undefined) {
      envelope.deviceSignature = signDeviceSignalProofV3(
        {
          roomId: input.roomId,
          envelopeId,
          authorId: input.authorId,
          deviceId: input.deviceId,
          targetDeviceId: null,
          // The relay pins the snapshot proof generation to createdAt (a
          // snapshot has no monotonic signal generation of its own).
          generation: input.createdAt,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          nonce: envelope.nonce,
          ciphertext: ciphertextB64,
          ciphertextBytes: ciphertext.length,
        },
        input.signingSecret,
      );
    }
    return envelope;
  } finally {
    nonce.fill(0);
  }
}

/**
 * Assemble the exact native-compatible signed event and XChaCha envelope.
 * Callers must retain the returned envelope unchanged until relay ack.
 */
export function assembleBrowserEvent(input: AssembleBrowserEventInput): AssembledBrowserEvent {
  validateInput(input);
  const metaWithoutId: SignableMetaShape = {
    v: 2,
    roomId: input.roomId,
    authorId: input.authorId,
    deviceId: input.deviceId,
    createdAt: input.createdAt,
    parentEventIds: [...(input.parentEventIds ?? [])],
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
  };
  const eventId = deriveEventId(metaWithoutId, input.body);
  const meta = { ...metaWithoutId, eventId } as ReviewEvent['meta'];
  const auth = signEvent(meta, input.body, input.signingSecret, input.signingPublic);
  const event: ReviewEvent = { meta, body: input.body, auth };
  const envelopeId = deriveEventEnvelopeId(input.roomId, eventId);
  const aad: EnvelopeAad = {
    v: 2,
    roomId: input.roomId,
    envelopeId,
    kind: 'event',
    authorId: input.authorId,
    deviceId: input.deviceId,
    createdAt: input.createdAt,
  };
  const plaintext = toCanonicalBytes(event);
  const nonce = input.nonce ? new Uint8Array(input.nonce) : randomAeadNonce();
  try {
    const ciphertext = aeadSeal(input.eventKey, nonce, plaintext, aad);
    return {
      event,
      envelope: {
        v: 2,
        roomId: input.roomId,
        envelopeId,
        authorId: input.authorId,
        deviceId: input.deviceId,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        kind: 'event',
        nonce: base64UrlEncode(nonce),
        ciphertext: base64UrlEncode(ciphertext),
        ciphertextBytes: ciphertext.length,
      },
    };
  } finally {
    plaintext.fill(0);
    nonce.fill(0);
  }
}

function validateInput(input: AssembleBrowserEventInput): void {
  if (input.eventKey.length !== 32) throw new Error('eventKey must be 32 bytes');
  if (input.signingSecret.length !== 32) throw new Error('signingSecret must be 32 bytes');
  if (input.signingPublic.length !== 32) throw new Error('signingPublic must be 32 bytes');
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) {
    throw new Error('createdAt must be a positive safe integer');
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < input.createdAt) {
    throw new Error('expiresAt must be a safe integer at or after createdAt');
  }
  if (input.nonce !== undefined && input.nonce.length !== 24) {
    throw new Error('nonce must be 24 bytes');
  }
  for (const [label, value] of [
    ['roomId', input.roomId],
    ['authorId', input.authorId],
    ['deviceId', input.deviceId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  }
}

function validateSnapshotBlobInput(input: AssembleSnapshotBlobEnvelopeInput): void {
  if (!(input.plaintext instanceof Uint8Array)) throw new Error('plaintext must be Uint8Array');
  if (!(input.snapshotKey instanceof Uint8Array) || input.snapshotKey.length !== 32) {
    throw new Error('snapshotKey must be 32 bytes');
  }
  if (!(input.clientNonce instanceof Uint8Array) || input.clientNonce.length !== 16) {
    throw new Error('clientNonce must be 16 bytes');
  }
  if (input.nonce !== undefined && input.nonce.length !== 24) {
    throw new Error('nonce must be 24 bytes');
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error('createdAt must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < input.createdAt) {
    throw new Error('expiresAt must be a safe integer at or after createdAt');
  }
  for (const [label, value] of [
    ['roomId', input.roomId],
    ['authorId', input.authorId],
    ['deviceId', input.deviceId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  }
}
