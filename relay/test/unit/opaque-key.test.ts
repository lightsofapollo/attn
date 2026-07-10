import { describe, expect, it } from "vitest";

import {
  decodeOpaqueSegment,
  encodeOpaqueSegment,
  isProtocolId,
} from "../../src/opaque-key";

describe("opaque storage-key segments", () => {
  it("is injective across delimiter, path, control, and Unicode edge cases", () => {
    const values = [
      "a|b:c",
      "a:b|c",
      "slash/value",
      "nul\0value",
      "c0\u0001value",
      "é",
      "e\u0301",
      "\ud800",
      "�",
    ];
    const encoded = values.map(encodeOpaqueSegment);
    expect(new Set(encoded).size).toBe(values.length);
    expect(encoded.every((value) => /^[A-Za-z0-9_-]+$/.test(value))).toBe(true);
    expect(encoded.map(decodeOpaqueSegment)).toEqual(values);
  });

  it("rejects malformed, non-string, noncanonical, invalid UTF-8, and empty encodings", () => {
    expect(decodeOpaqueSegment("")).toBeUndefined();
    expect(decodeOpaqueSegment("%%%")).toBeUndefined();
    expect(decodeOpaqueSegment("_w")).toBeUndefined(); // invalid UTF-8 byte 0xff
    expect(decodeOpaqueSegment("bnVsbA")).toBeUndefined(); // JSON null
    expect(decodeOpaqueSegment("IiI")).toBeUndefined(); // empty JSON string
  });

  it("accepts only nonempty bounded base64url protocol IDs", () => {
    expect(isProtocolId("Abc_123-z", 16)).toBe(true);
    expect(isProtocolId("a:b", 16)).toBe(false);
    expect(isProtocolId("a/b", 16)).toBe(false);
    expect(isProtocolId("nul\0", 16)).toBe(false);
    expect(isProtocolId("x".repeat(17), 16)).toBe(false);
  });
});
