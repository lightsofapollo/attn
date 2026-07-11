import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalRequest } from "../../src/admission";
import { canonicalize } from "../../src/canonical";
import type { EnvelopeInput, RoomPolicy } from "../../src/schema";
import { generateEd25519Keypair, ownerSignatureHeader } from "../helpers/owner-sig";
import { FIXED_POW_RAND, createPowHeader, mintPowForTests } from "../helpers/pow";

const BASE = "https://relay.example";
const openSockets: WebSocket[] = [];
let sequence = 0;

afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    try {
      socket.close(1000, "test cleanup");
    } catch {
      // already closed
    }
  }
});

interface V3Room {
  roomId: string;
  owner: Awaited<ReturnType<typeof generateEd25519Keypair>>;
  readKey: Uint8Array;
  writeKey: Uint8Array;
}

function viewerId(seed: number): string {
  return base64UrlEncode(new Uint8Array(16).fill(seed));
}

function policy(overrides: Partial<RoomPolicy> = {}): RoomPolicy {
  return {
    mode: "live",
    maxPeers: 4,
    maxSnapshotBytes: 1_000_000,
    maxEventBytes: 8_192,
    maxEvents: 100,
    expiresAt: Date.now() + 3_600_000,
    idleTimeoutMs: 1_800_000,
    longSession: false,
    powBits: 16,
    deleteEventsAfterOwnerAck: false,
    allowBrowser: false,
    allowRemoteAgents: false,
    ...overrides,
  };
}

async function scopedHeader(
  scope: "read" | "write",
  key: Uint8Array,
  method: string,
  url: string,
  body?: string,
): Promise<string> {
  const request = new Request(url, { method, body });
  const canonical = await canonicalRequest(request, new URL(url).pathname);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, canonical));
  return `v3.${scope}.${base64UrlEncode(mac)}`;
}

async function createRoom(overrides: Partial<RoomPolicy> = {}): Promise<V3Room> {
  sequence += 1;
  const roomId = `v3-viewer-${Date.now().toString(36)}-${sequence}`;
  const roomUrl = `${BASE}/v3/rooms/${roomId}`;
  const owner = await generateEd25519Keypair();
  const readKey = new Uint8Array(32).fill(0x31 + (sequence % 16));
  const writeKey = new Uint8Array(32).fill(0x71 + (sequence % 16));
  const body = JSON.stringify({
    v: 3,
    policy: policy(overrides),
    ownerSigningKey: base64UrlEncode(owner.publicKeyBytes),
    readAdmissionKey: base64UrlEncode(readKey),
    writeAdmissionKey: base64UrlEncode(writeKey),
  });
  const response = await SELF.fetch(roomUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Owner-Signature": await ownerSignatureHeader({
        method: "POST", url: roomUrl, body, privateKey: owner.privateKey,
      }),
      "Attn-PoW": await createPowHeader(
        roomId,
        owner.publicKeyBytes,
        `/v3/rooms/${roomId}`,
      ),
    },
    body,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return { roomId, owner, readKey, writeKey };
}

async function registerOwner(room: V3Room, deviceId = "owner-device"): Promise<void> {
  const unsigned = {
    deviceId,
    participantId: "owner-participant",
    publicSigningKey: base64UrlEncode(room.owner.publicKeyBytes),
    publicEncryptionKey: base64UrlEncode(new Uint8Array(32).fill(0x44)),
    client: "attn-native",
    kind: "owner",
  } as const;
  const selfSignature = base64UrlEncode(new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    room.owner.privateKey,
    new TextEncoder().encode(canonicalize(unsigned)),
  )));
  const body = JSON.stringify({ ...unsigned, selfSignature });
  const url = `${BASE}/v3/rooms/${room.roomId}/devices`;
  const response = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Admission": await scopedHeader("write", room.writeKey, "POST", url, body),
      "Attn-PoW": await mintPowForTests({
        roomId: room.roomId,
        deviceId,
        method: "POST",
        path: `/v3/rooms/${room.roomId}/devices`,
        difficulty: 16,
        expiresAt: Date.now() + 300_000 + sequence,
        rand: FIXED_POW_RAND,
      }),
    },
    body,
  });
  expect(response.status, await response.clone().text()).toBe(204);
}

function envelope(
  room: V3Room,
  id: string,
  kind: "event" | "signal" = "event",
  target: { deviceId: string } | null = null,
): EnvelopeInput {
  return {
    envelopeId: id,
    authorId: "owner-participant",
    deviceId: "owner-device",
    kind,
    target,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    nonce: base64UrlEncode(new Uint8Array(24).fill(0x55)),
    ciphertext: base64UrlEncode(new Uint8Array(32).fill(0x77)),
    ciphertextBytes: 32,
  };
}

async function postEnvelopes(room: V3Room, envelopes: EnvelopeInput[]): Promise<void> {
  const url = `${BASE}/v3/rooms/${room.roomId}/envelopes`;
  const body = JSON.stringify({ envelopes });
  const response = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Attn-Admission": await scopedHeader("write", room.writeKey, "POST", url, body),
      "Attn-PoW": await mintPowForTests({
        roomId: room.roomId,
        deviceId: "owner-device",
        method: "POST",
        path: `/v3/rooms/${room.roomId}/envelopes`,
        difficulty: 16,
        expiresAt: Date.now() + 300_000 + sequence,
        rand: FIXED_POW_RAND,
      }),
    },
    body,
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

async function openSocket(
  room: V3Room,
  query: string,
  readKey = room.readKey,
  deviceProtocol: "valid" | "read-only" | "swapped-order" | "swapped-proofs" | "bad-write" = "valid",
): Promise<{ response: Response; socket: WebSocket | null }> {
  const url = `${BASE}/v3/rooms/${room.roomId}/socket${query}`;
  const admission = await scopedHeader("read", readKey, "GET", url);
  const writeAdmission = await scopedHeader(
    "write",
    deviceProtocol === "bad-write" ? new Uint8Array(32).fill(0xdd) : room.writeKey,
    "GET",
    url,
  );
  const params = new URL(url).searchParams;
  const registeredDevice = params.getAll("device_id").length === 1
    && params.getAll("viewer_id").length === 0;
  const readToken = `read-hmac.${admission.split(".")[2]}`;
  const writeToken = `write-hmac.${writeAdmission.split(".")[2]}`;
  let protocol = `attn.v3, ${readToken}`;
  if (registeredDevice && deviceProtocol !== "read-only") {
    if (deviceProtocol === "swapped-order") protocol = `attn.v3, ${writeToken}, ${readToken}`;
    else if (deviceProtocol === "swapped-proofs") {
      protocol = `attn.v3, read-hmac.${writeAdmission.split(".")[2]}, write-hmac.${admission.split(".")[2]}`;
    } else protocol = `attn.v3, ${readToken}, ${writeToken}`;
  }
  const response = await SELF.fetch(url, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": protocol,
    },
  });
  const socket = response.webSocket;
  if (socket !== null) {
    socket.accept();
    openSockets.push(socket);
  }
  return { response, socket };
}

class FrameQueue {
  private readonly frames: unknown[] = [];
  private readonly waiters: Array<(frame: unknown) => void> = [];
  closed = false;
  closeCode: number | undefined;

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as unknown;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      this.closed = true;
      this.closeCode = event.code;
      for (const waiter of this.waiters.splice(0)) waiter(undefined);
    });
  }

  async next(timeoutMs = 1_000): Promise<unknown> {
    const frame = this.frames.shift();
    if (frame !== undefined) return frame;
    if (this.closed) return undefined;
    return new Promise((resolve) => {
      let wrapped: (frame: unknown) => void;
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(wrapped);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs);
      wrapped = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(wrapped);
    });
  }

  async waitClosed(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("v3 anonymous viewer WebSocket", () => {
  it("requires exactly one well-formed viewer_id or registered device_id", async () => {
    const room = await createRoom();
    const validViewer = viewerId(1);
    for (const query of [
      "",
      `?viewer_id=${validViewer}&device_id=missing-device`,
      "?viewer_id=short",
      `?viewer_id=${validViewer}&viewer_id=${viewerId(2)}`,
    ]) {
      const { response, socket } = await openSocket(room, query);
      expect(response.status, query).toBe(400);
      expect(socket, query).toBeNull();
      expect((await response.json() as { error: { code: string } }).error.code)
        .toBe("ATTN_BODY_INVALID");
    }

    const readOnlyDevice = await openSocket(
      room,
      "?device_id=owner-device",
      room.readKey,
      "read-only",
    );
    expect(readOnlyDevice.response.status).toBe(401);
    expect(readOnlyDevice.socket).toBeNull();
    expect((await readOnlyDevice.response.json() as { error: { code: string } }).error.code)
      .toBe("ATTN_ADMISSION_INVALID");

    const unregistered = await openSocket(room, "?device_id=not-registered");
    expect(unregistered.response.status).toBe(404);
    expect((await unregistered.response.json() as { error: { code: string } }).error.code)
      .toBe("ATTN_DEVICE_UNREGISTERED");

    const badAdmission = await openSocket(
      room,
      `?viewer_id=${validViewer}`,
      new Uint8Array(32).fill(0xee),
    );
    expect(badAdmission.response.status).toBe(101);
    const badAdmissionFrames = new FrameQueue(badAdmission.socket!);
    await badAdmissionFrames.waitClosed();
    expect(badAdmissionFrames.closeCode).toBe(4000);
  });

  it("requires valid ordered read+write proofs for registered v3 device sockets", async () => {
    const room = await createRoom();
    await registerOwner(room);

    const readOnly = await openSocket(
      room,
      "?device_id=owner-device",
      room.readKey,
      "read-only",
    );
    expect(readOnly.response.status).toBe(401);
    expect(readOnly.socket).toBeNull();

    const valid = await openSocket(room, "?device_id=owner-device");
    expect(valid.response.status).toBe(101);

    const badWrite = await openSocket(
      room,
      "?device_id=owner-device",
      room.readKey,
      "bad-write",
    );
    expect(badWrite.response.status).toBe(101);
    const badWriteFrames = new FrameQueue(badWrite.socket!);
    await badWriteFrames.waitClosed();
    expect(badWriteFrames.closeCode).toBe(4000);

    const swappedProofs = await openSocket(
      room,
      "?device_id=owner-device",
      room.readKey,
      "swapped-proofs",
    );
    expect(swappedProofs.response.status).toBe(101);
    const swappedProofFrames = new FrameQueue(swappedProofs.socket!);
    await swappedProofFrames.waitClosed();
    expect(swappedProofFrames.closeCode).toBe(4000);

    const swappedOrder = await openSocket(
      room,
      "?device_id=owner-device",
      room.readKey,
      "swapped-order",
    );
    expect(swappedOrder.response.status).toBe(401);
    expect(swappedOrder.socket).toBeNull();
  });

  it("replays and broadcasts non-signals without presence, signals, or viewer roster entries", async () => {
    const room = await createRoom({ maxPeers: 2 });
    await registerOwner(room);
    await postEnvelopes(room, [
      envelope(room, "replay-event"),
      envelope(room, "replay-target-signal", "signal", { deviceId: "owner-device" }),
      envelope(room, "replay-broadcast-signal", "signal"),
    ]);

    const ownerOpen = await openSocket(room, "?device_id=owner-device");
    expect(ownerOpen.response.status).toBe(101);
    const ownerSocket = ownerOpen.socket!;
    const ownerFrames = new FrameQueue(ownerSocket);
    ownerSocket.send(JSON.stringify({ type: "subscribe", after: 0 }));
    expect(await ownerFrames.next()).toMatchObject({ type: "hello" });
    // Drain the owner's replay and ping before checking viewer presence silence.
    for (let i = 0; i < 4; i += 1) await ownerFrames.next();

    const viewerOpen = await openSocket(room, `?viewer_id=${viewerId(3)}`);
    expect(viewerOpen.response.status).toBe(101);
    const viewerSocket = viewerOpen.socket!;
    const viewerFrames = new FrameQueue(viewerSocket);
    expect(await ownerFrames.next(150)).toBeUndefined();

    viewerSocket.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello = await viewerFrames.next() as {
      type: string;
      onlineDeviceIds: string[];
      missedSignalEnvelopeIds: string[];
    };
    expect(hello.type).toBe("hello");
    expect(hello.onlineDeviceIds).toEqual(["owner-device"]);
    expect(hello.missedSignalEnvelopeIds).toEqual([]);
    expect(await viewerFrames.next()).toMatchObject({
      type: "envelope",
      envelope: { envelopeId: "replay-event", kind: "event" },
    });
    expect(await viewerFrames.next()).toMatchObject({ type: "ping" });
    expect(await viewerFrames.next(150)).toBeUndefined();

    // Viewer sockets share the deliberately tiny client-frame grammar with
    // registered sockets: subscribe and pong only. There is no ACK/write
    // frame path hidden behind the anonymous connection.
    viewerSocket.send(JSON.stringify({ type: "ack", envelopeIds: ["replay-event"] }));
    expect(await viewerFrames.next()).toMatchObject({
      type: "error",
      code: "ATTN_FRAME_INVALID",
    });

    await postEnvelopes(room, [
      envelope(room, "fresh-event"),
      envelope(room, "fresh-target-signal", "signal", { deviceId: "owner-device" }),
      envelope(room, "fresh-broadcast-signal", "signal"),
    ]);
    expect(await viewerFrames.next()).toMatchObject({
      type: "envelope",
      envelope: { envelopeId: "fresh-event", kind: "event" },
    });
    expect(await viewerFrames.next(150)).toBeUndefined();
  });

  it("uses a separate viewer socket cap and does not consume maxPeers", async () => {
    const room = await createRoom({ maxPeers: 1 });
    await registerOwner(room);

    // Deployment config pins this independent anonymous-reader pool to 32.
    for (let i = 0; i < 32; i += 1) {
      const opened = await openSocket(room, `?viewer_id=${viewerId(i + 10)}`);
      expect(opened.response.status, `viewer ${i + 1}`).toBe(101);
    }

    // A registered participant still gets the room's sole peer slot.
    const ownerOpen = await openSocket(room, "?device_id=owner-device");
    expect(ownerOpen.response.status).toBe(101);
    const ownerFrames = new FrameQueue(ownerOpen.socket!);
    ownerOpen.socket!.send(JSON.stringify({ type: "subscribe", after: 0 }));
    const hello = await ownerFrames.next() as { type: string; onlineDeviceIds: string[] };
    expect(hello.type).toBe("hello");
    expect(hello.onlineDeviceIds).toEqual(["owner-device"]);

    const overflow = await openSocket(room, `?viewer_id=${viewerId(99)}`);
    expect(overflow.response.status).toBe(101);
    const overflowFrames = new FrameQueue(overflow.socket!);
    await overflowFrames.waitClosed();
    expect(overflowFrames.closeCode).toBe(4003);
  });
});
