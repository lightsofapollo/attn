import { describe, expect, it } from "vitest";

import {
  encodeEdgeOriginContext,
  INTERNAL_EDGE_ORIGIN_HEADER,
  parseEdgeOriginContext,
} from "../../src/browser-origin";

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

describe("browser-origin private context", () => {
  it("uses the fixed private header and explicit native sentinel", () => {
    expect(INTERNAL_EDGE_ORIGIN_HEADER).toBe("X-Attn-Edge-Origin");
    expect(encodeEdgeOriginContext(null)).toBe("v1.native");
    expect(parseEdgeOriginContext("v1.native")).toEqual({ kind: "native" });
  });

  it.each([
    "https://attn.sh",
    "http://localhost:8787",
    "https://sub.example.test:8443",
    "http://127.0.0.1",
    "http://[::1]:8787",
  ])("round-trips canonical browser origin %s", (origin) => {
    const encoded = encodeEdgeOriginContext(origin);
    expect(encoded).toBe(`v1.browser.${base64Url(origin)}`);
    expect(parseEdgeOriginContext(encoded)).toEqual({ kind: "browser", origin });
  });

  it.each([
    "",
    "null",
    "https://attn.sh, https://evil.example",
    "HTTPS://attn.sh",
    "https://ATTN.sh",
    "https://attn.sh/",
    "https://attn.sh/path",
    "https://user@attn.sh",
    "https://user:pass@attn.sh",
    "https://attn.sh?query=yes",
    "https://attn.sh#fragment",
    "https://attn.sh:443",
    "ws://attn.sh",
    "file://attn.sh",
    " https://attn.sh",
    "not an origin",
    `https://${"a".repeat(513)}.example`,
  ])("classifies invalid/non-canonical edge Origin %s", (origin) => {
    expect(encodeEdgeOriginContext(origin)).toBe("v1.invalid");
  });

  it("parses the explicit invalid-browser sentinel", () => {
    expect(parseEdgeOriginContext("v1.invalid")).toEqual({ kind: "invalid" });
  });

  it.each([
    null,
    "",
    "v1",
    "v1.native.extra",
    "v1.invalid.extra",
    "v2.native",
    "v1.browser.",
    "v1.browser.***",
    "v1.browser._w", // invalid UTF-8 byte 0xff
    `v1.browser.${base64Url("https://attn.sh/")}`,
    `v1.browser.${base64Url("https://ATTN.sh")}`,
    `v1.browser.${base64Url("null")}`,
    `v1.browser.${base64Url("https://attn.sh")}=`,
  ])("fails closed on missing/malformed private context %s", (context) => {
    expect(parseEdgeOriginContext(context)).toBeUndefined();
  });
});
