import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("returns ok with build sha and timestamp", async () => {
    const res = await SELF.fetch("https://relay.example/health");

    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; build: string; ts: number };
    expect(body.status).toBe("ok");
    expect(typeof body.build).toBe("string");
    expect(typeof body.ts).toBe("number");
    expect(body.ts).toBeGreaterThan(0);
  });

  it("404s unknown routes (endpoints land in 5.5-5.13)", async () => {
    const res = await SELF.fetch("https://relay.example/v2/rooms/abc");
    expect(res.status).toBe(404);
  });
});
