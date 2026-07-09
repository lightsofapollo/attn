import { describe, expect, it } from "vitest";

import {
  acksRequestSchema,
  blobPresignRequestSchema,
  deviceRegistrationSchema,
  envelopeSchema,
  roomCreationSchema,
} from "../../src/schema";

const basePolicy = {
  mode: "hybrid",
  maxPeers: 4,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxEvents: 100,
  expiresAt: 1_800_000_000_000,
};

function roomCreation(overrides: Record<string, unknown> = {}) {
  return {
    v: 2,
    policy: basePolicy,
    ownerSigningKey: "A".repeat(43),
    admissionKey: "B".repeat(43),
    ...overrides,
  };
}

function deviceRegistration(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: "device-1",
    participantId: "participant-1",
    publicSigningKey: "C".repeat(43),
    publicEncryptionKey: "D".repeat(43),
    client: "attn-browser",
    kind: "reviewer",
    selfSignature: "E".repeat(86),
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    envelopeId: "envelope-1",
    authorId: "participant-1",
    deviceId: "device-1",
    kind: "event",
    createdAt: 1_700_000_000_000,
    expiresAt: 1_800_000_000_000,
    nonce: "F".repeat(32),
    ciphertext: "AA",
    ciphertextBytes: 1,
    ...overrides,
  };
}

describe("relay durable metadata schema bounds", () => {
  it("accepts protocol-sized room key encodings", () => {
    expect(roomCreationSchema.safeParse(roomCreation()).success).toBe(true);
  });

  it.each(["ownerSigningKey", "admissionKey"])(
    "rejects an oversized room %s encoding",
    (field) => {
      expect(
        roomCreationSchema.safeParse(roomCreation({ [field]: "A".repeat(44) })).success,
      ).toBe(false);
    },
  );

  it("accepts protocol-sized device key and signature encodings", () => {
    expect(deviceRegistrationSchema.safeParse(deviceRegistration()).success).toBe(true);
  });

  it.each([
    ["publicSigningKey", 44],
    ["publicEncryptionKey", 44],
    ["selfSignature", 87],
  ])("rejects an oversized device %s encoding", (field, length) => {
    expect(
      deviceRegistrationSchema.safeParse(
        deviceRegistration({ [field]: "A".repeat(length as number) }),
      ).success,
    ).toBe(false);
  });

  it("accepts maximum-sized opaque envelope metadata", () => {
    expect(
      envelopeSchema.safeParse(
        envelope({ envelopeId: "e".repeat(128), nonce: "n".repeat(32) }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["envelopeId", 129],
    ["nonce", 33],
  ])("rejects an oversized envelope %s", (field, length) => {
    expect(
      envelopeSchema.safeParse(envelope({ [field]: "A".repeat(length as number) })).success,
    ).toBe(false);
  });

  it("bounds both blob and ACK storage-key components", () => {
    const envelopeId = "e".repeat(128);
    const deviceId = "d".repeat(64);

    expect(
      blobPresignRequestSchema.safeParse({
        envelopeId,
        authorId: "participant-1",
        deviceId,
        ciphertextBytes: 1,
      }).success,
    ).toBe(true);
    expect(
      acksRequestSchema.safeParse({ ackedEnvelopeIds: [envelopeId], deviceId }).success,
    ).toBe(true);

    expect(
      blobPresignRequestSchema.safeParse({
        envelopeId: "e".repeat(129),
        authorId: "participant-1",
        deviceId,
        ciphertextBytes: 1,
      }).success,
    ).toBe(false);
    expect(
      acksRequestSchema.safeParse({
        ackedEnvelopeIds: ["e".repeat(129)],
        deviceId,
      }).success,
    ).toBe(false);
    expect(
      acksRequestSchema.safeParse({
        ackedEnvelopeIds: [envelopeId],
        deviceId: "d".repeat(65),
      }).success,
    ).toBe(false);
  });

  it("preserves duplicate ACK IDs for signed request semantics", () => {
    const parsed = acksRequestSchema.parse({
      ackedEnvelopeIds: ["same-id", "same-id"],
      deviceId: "device-1",
    });

    expect(parsed.ackedEnvelopeIds).toEqual(["same-id", "same-id"]);
  });
});
