import {
  aeadSeal,
  base64UrlEncode,
  deriveEventEnvelopeId,
  deriveEventId,
  randomAeadNonce,
  signEvent,
  toCanonicalBytes,
  type EnvelopeAad,
  type SignableMetaShape,
} from './browser-crypto';
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
