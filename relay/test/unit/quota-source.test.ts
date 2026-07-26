import { describe, expect, it } from "vitest";

import { canonicalQuotaSourceIp, roomCorsPreflightRoomId } from "../../src/index";

describe("room CORS preflight routing", () => {
  it("recognizes v2/v3 room OPTIONS before application request accounting", () => {
    expect(roomCorsPreflightRoomId("OPTIONS", "/v3/rooms/room-1/devices")).toBe("room-1");
    expect(roomCorsPreflightRoomId("OPTIONS", "/v2/rooms/room-2/envelopes")).toBe("room-2");
    expect(roomCorsPreflightRoomId("GET", "/v3/rooms/room-1/devices")).toBeUndefined();
    expect(roomCorsPreflightRoomId("OPTIONS", "/health")).toBeUndefined();
  });
});

describe("durable quota source canonicalization", () => {
  it("canonicalizes IPv4 per address", () => {
    expect(canonicalQuotaSourceIp(" 192.168.001.010 ")).toBe("ipv4:192.168.1.10/32");
  });

  it("maps equivalent IPv6 spellings and privacy addresses to one /64", () => {
    const expected = "ipv6:2001:0db8:abcd:1234::/64";
    expect(canonicalQuotaSourceIp("2001:db8:abcd:1234::1")).toBe(expected);
    expect(canonicalQuotaSourceIp("2001:0DB8:ABCD:1234:ffff:eeee:dddd:cccc")).toBe(
      expected,
    );
  });

  it("rejects malformed or ambiguous values", () => {
    expect(canonicalQuotaSourceIp(null)).toBeUndefined();
    expect(canonicalQuotaSourceIp("999.1.2.3")).toBeUndefined();
    expect(canonicalQuotaSourceIp("2001:db8::1::2")).toBeUndefined();
    expect(canonicalQuotaSourceIp("192.0.2.1, 198.51.100.2")).toBeUndefined();
  });
});
