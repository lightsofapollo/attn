import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { parsePushSubscriptionInput, pushPublicConfig } from "../../src/web-push";

const PUBLIC_KEY = "BKOaMoQCJMzoFLApwG1J8FvD2rB3JECjlJ_ZU2qhp4tUGJSfB2Z-5OI6wxAVDd2DilYJoXLRkN0bOSDRA32s7HI";
const PRIVATE_JWK = {
  kty: "EC",
  x: "o5oyhAIkzOgUsCnAbUnwW8PasHckQKOUn9lTaqGni1Q",
  y: "GJSfB2Z-5OI6wxAVDd2DilYJoXLRkN0bOSDRA32s7HI",
  crv: "P-256",
  d: "5jxhim-klclQknmN_V_qLFPmXvv7TUAkwzxGE9-mDyA",
};

function config(privateJwk: Record<string, string>): Env {
  return {
    VAPID_PUBLIC_KEY: PUBLIC_KEY,
    VAPID_SUBJECT: "mailto:relay-tests@attn.sh",
    VAPID_PRIVATE_JWK: JSON.stringify(privateJwk),
  } as Env;
}

describe("VAPID configuration boundary", () => {
  it("enables only a canonical private scalar that proves the configured public key", async () => {
    await expect(pushPublicConfig(config(PRIVATE_JWK))).resolves.toEqual({
      enabled: true,
      vapidPublicKey: PUBLIC_KEY,
    });
    await expect(pushPublicConfig(config({ ...PRIVATE_JWK, d: "AA" }))).resolves.toEqual({ enabled: false });
    await expect(pushPublicConfig(config({
      ...PRIVATE_JWK,
      d: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    }))).resolves.toEqual({ enabled: false });
  });
});

describe("local push endpoint test seam", () => {
  const input = { v: 3, endpoint: "http://127.0.0.1:8800/push/test", expirationTime: null,
    keys: { p256dh: PUBLIC_KEY, auth: "AAAAAAAAAAAAAAAAAAAAAA" } };
  it("allows only an exact explicitly configured loopback origin", () => {
    expect(parsePushSubscriptionInput(input, Date.now(), "http://127.0.0.1:8800")).toBeDefined();
    expect(parsePushSubscriptionInput(input)).toBeUndefined();
    expect(parsePushSubscriptionInput(input, Date.now(), "https://example.com")).toBeUndefined();
    expect(parsePushSubscriptionInput({ ...input, endpoint: "http://localhost:8800/push/test" }, Date.now(),
      "http://127.0.0.1:8800")).toBeUndefined();
  });
});
