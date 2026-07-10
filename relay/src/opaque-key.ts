/**
 * Injective encoding for attacker-controlled Durable Object / R2 key segments.
 *
 * JSON stringification happens before UTF-8 encoding deliberately: JavaScript
 * strings are UTF-16 and may contain lone surrogates. JSON escapes those code
 * units, whereas TextEncoder(value) would replace them with U+FFFD and alias
 * distinct identifiers.
 */

export const ROOM_ID_MAX_CHARS = 128;
export const DEVICE_ID_MAX_CHARS = 64;
export const PARTICIPANT_ID_MAX_CHARS = 64;
export const ENVELOPE_ID_MAX_CHARS = 128;

const PROTOCOL_ID_RE = /^[A-Za-z0-9_-]+$/;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function isProtocolId(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    PROTOCOL_ID_RE.test(value)
  );
}

export function encodeOpaqueSegment(value: string): string {
  if (value.length === 0) throw new Error("opaque segment must be nonempty");
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("opaque segment must be a string");
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Strict, canonical decoder. Invalid input never gets partially decoded. */
export function decodeOpaqueSegment(encoded: string): string | undefined {
  if (encoded.length === 0 || !SEGMENT_RE.test(encoded)) return undefined;
  let standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const remainder = standard.length % 4;
  if (remainder === 1) return undefined;
  if (remainder === 2) standard += "==";
  if (remainder === 3) standard += "=";
  let binary: string;
  try {
    binary = atob(standard);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Reject alternate base64/JSON spellings so one logical identifier has one
  // and only one storage segment.
  return encodeOpaqueSegment(value) === encoded ? value : undefined;
}
