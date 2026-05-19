/** Canonical JSON (RFC 8785 JCS subset) — TS port of `src/review/crypto/canonical.rs`.
 *
 * Used to canonicalize device-registration bodies before verifying the
 * `selfSignature` Ed25519 signature in `room-do.ts`. The Rust impl is the
 * source of truth (see `planning/collab/crypto-spec.md` §Canonical JSON); this
 * port mirrors its rules byte-for-byte so a signature produced by either side
 * verifies on the other.
 *
 * Summary of the rules enforced here:
 *   1. Object keys sorted ASCII-ascending (capitals before lowercase).
 *   2. No insignificant whitespace.
 *   3. UTF-8 (the runtime's string type).
 *   4. String escapes are minimal: only `\"`, `\\`, and `\u00XX` (lowercase
 *      hex) for U+0000..U+001F. Non-ASCII (incl. emoji) emitted raw.
 *   5. Integers via JS `String(n)`. We never canonicalize floats — every v2
 *      payload field is an integer; non-integer numbers throw.
 *   6. `null` keys are DROPPED from objects (recursively); nulls inside
 *      arrays are preserved (index semantics).
 *
 * NOTE: a shared canonical-json TS module is a future DRY opportunity once
 * other relay handlers need it. For 5.6 we ship this minimal local copy.
 */

/** Any JSON-like value the canonicalizer accepts. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** Thrown on inputs the canonicalizer refuses (non-finite numbers, non-JSON values). */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/**
 * Canonicalize a JSON-like value to its single deterministic string form.
 * Reject non-finite numbers and `undefined` (the Rust port refuses both).
 */
export function canonicalize(value: CanonicalValue): string {
  const out: string[] = [];
  writeValue(value, out);
  return out.join("");
}

function writeValue(value: CanonicalValue, out: string[]): void {
  if (value === null) {
    // Top-level null is legal; the drop-in-object rule applies only inside writeObject.
    out.push("null");
    return;
  }
  if (typeof value === "boolean") {
    out.push(value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(`canonical JSON cannot represent ${value}`);
    }
    // v2 payloads only carry integers; refuse floats so we never depend on a
    // JS-specific number formatter that could drift from serde_json.
    if (!Number.isInteger(value)) {
      throw new CanonicalJsonError(`canonical JSON requires integers (got ${value})`);
    }
    out.push(String(value));
    return;
  }
  if (typeof value === "string") {
    writeString(value, out);
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",");
      writeValue(value[i] as CanonicalValue, out);
    }
    out.push("]");
    return;
  }
  if (typeof value === "object") {
    writeObject(value as Record<string, CanonicalValue>, out);
    return;
  }
  throw new CanonicalJsonError(`unsupported value type: ${typeof value}`);
}

function writeObject(map: Record<string, CanonicalValue>, out: string[]): void {
  // Collect non-null entries (rule 6).
  const entries: Array<[string, CanonicalValue]> = [];
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (v === undefined) continue; // serde_json drops these too via skip_serializing_if pattern
    if (v === null) continue;
    entries.push([k, v]);
  }
  // ASCII-ascending sort by raw bytes — for keys that are pure ASCII (our
  // schemas), codepoint order matches byte order matches the Rust impl.
  entries.sort((a, b) => compareBytes(a[0], b[0]));

  out.push("{");
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) out.push(",");
    const entry = entries[i];
    if (entry === undefined) continue;
    writeString(entry[0], out);
    out.push(":");
    writeValue(entry[1], out);
  }
  out.push("}");
}

function compareBytes(a: string, b: string): number {
  // Compare by UTF-8 byte sequence to exactly match Rust's `as_bytes().cmp(...)`.
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.min(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = ab[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return ab.length - bb.length;
}

function writeString(s: string, out: string[]): void {
  out.push('"');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) {
      out.push('\\"');
    } else if (c === 0x5c) {
      out.push("\\\\");
    } else if (c < 0x20) {
      // \u00XX with lowercase hex per RFC 8785 §3.2.2.2.
      const hex = c.toString(16);
      out.push("\\u00", hex.length === 1 ? "0" : "", hex);
    } else {
      // Non-ASCII passes through as raw UTF-16 code unit; the eventual
      // UTF-8 encoder used by callers (TextEncoder) handles surrogate
      // pairs correctly so emoji round-trip.
      out.push(s.charAt(i));
    }
  }
  out.push('"');
}
