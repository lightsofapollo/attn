import {
  ATTN_DATA_CHANNEL_LABEL,
  ATTN_PRESENCE_CHANNEL_LABEL,
  BrowserPeerMesh,
  type BrowserDirectState,
} from './browser-webrtc';
import type { Device, MailboxEnvelope } from './browser-ws';

class FakeChannel {
  readonly label: string;
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'blob';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: Uint8Array[] = [];

  constructor(label: string, readonly options?: RTCDataChannelInit) { this.label = label; }
  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') this.sent.push(new TextEncoder().encode(data));
    else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  }
  close(): void { this.readyState = 'closed'; this.onclose?.(); }
  open(): void { this.readyState = 'open'; this.onopen?.(); }
  receive(data: ArrayBuffer): void { this.onmessage?.({ data } as MessageEvent); }
}

class FakePeerConnection {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  readonly candidates: RTCIceCandidateInit[] = [];
  channel: FakeChannel | null = null;
  presenceChannel: FakeChannel | null = null;

  constructor(readonly configuration: RTCConfiguration) {}
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
  }
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> { this.candidates.push(candidate); }
  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeChannel(label, options);
    if (label === ATTN_PRESENCE_CHANNEL_LABEL) this.presenceChannel = channel;
    else this.channel = channel;
    return channel as unknown as RTCDataChannel;
  }
  close(): void { this.connectionState = 'closed'; }
  restartIce(): void {}
  emitDataChannel(channel = new FakeChannel(ATTN_DATA_CHANNEL_LABEL)): FakeChannel {
    if (channel.label === ATTN_PRESENCE_CHANNEL_LABEL) this.presenceChannel = channel;
    else this.channel = channel;
    this.ondatachannel?.({ channel: channel as unknown as RTCDataChannel } as RTCDataChannelEvent);
    return channel;
  }
  fail(): void { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
}

const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push([name, fn]); }
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function device(deviceId: string, client: Device['client'] = 'attn-browser'): Device {
  return {
    deviceId,
    participantId: `participant-${deviceId}`,
    publicEncryptionKey: 'enc',
    publicSigningKey: 'sig',
    client,
    kind: 'reviewer',
    selfSignature: 'self',
  };
}

function envelope(deviceId = 'a'): MailboxEnvelope {
  return {
    v: 2,
    roomId: 'room-a',
    envelopeId: 'envelope-a',
    authorId: `participant-${deviceId}`,
    deviceId,
    createdAt: 1,
    expiresAt: 2,
    kind: 'event',
    nonce: 'nonce',
    ciphertext: 'ciphertext',
    ciphertextBytes: 16,
  };
}

test('uses STUN only and creates reliable review plus lossy presence channels', async () => {
  const pcs: FakePeerConnection[] = [];
  const signals: string[] = [];
  const states: BrowserDirectState[] = [];
  const presenceReady: string[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'a',
    maxEnvelopeBytes: 16_384,
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration); pcs.push(pc); return pc as unknown as RTCPeerConnection;
    },
    onSignal: async (_target, payload) => { signals.push(payload.kind); },
    onEnvelope: () => undefined,
    onState: (state) => states.push(state),
    onPresenceReady: (deviceId) => presenceReady.push(deviceId),
    maxIceRestarts: 0,
  });
  mesh.syncDevices([device('a'), device('z'), device('agent', 'agent-cli')]);
  await Promise.resolve(); await Promise.resolve();
  assert(pcs.length === 1, 'did not create exactly one eligible peer');
  assert(pcs[0]!.configuration.iceTransportPolicy === 'all', 'unexpected ICE transport policy');
  const urls = pcs[0]!.configuration.iceServers?.flatMap((entry) =>
    typeof entry.urls === 'string' ? [entry.urls] : [...entry.urls],
  ) ?? [];
  assert(urls.length > 0 && urls.every((url) => url.startsWith('stun:')), 'non-STUN server configured');
  assert(pcs[0]!.channel?.label === ATTN_DATA_CHANNEL_LABEL, 'wrong DataChannel label');
  assert(pcs[0]!.presenceChannel?.label === ATTN_PRESENCE_CHANNEL_LABEL, 'wrong presence channel label');
  assert(pcs[0]!.presenceChannel?.options?.ordered === false, 'presence channel must be unordered');
  assert(pcs[0]!.presenceChannel?.options?.maxRetransmits === 0, 'presence channel must not retransmit');
  assert(signals.includes('offer'), 'lexically smaller device did not offer');
  pcs[0]!.channel!.open();
  pcs[0]!.presenceChannel!.open();
  assert(presenceReady.join(',') === 'z', 'presence open did not request a current-state replay');
  assert(states.at(-1) === 'live_direct', 'open channel did not publish live_direct');
  mesh.broadcastEnvelope(envelope('a'));
  assert(pcs[0]!.channel!.sent.length === 1, 'exact envelope was not fanned over the channel');
  const presence = { ...envelope('a'), kind: 'signal', signalClass: 'presence' } as MailboxEnvelope;
  mesh.broadcastPresenceEnvelope(presence);
  assert(pcs[0]!.presenceChannel!.sent.length === 1, 'presence was not sent on its lossy channel');
  assert(pcs[0]!.channel!.sent.length === 1, 'presence leaked onto the review channel');
  mesh.close();
});

test('drops presence for unavailable peer channels without blocking reachable peers', async () => {
  const pcs: FakePeerConnection[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'a',
    maxEnvelopeBytes: 16_384,
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration); pcs.push(pc); return pc as unknown as RTCPeerConnection;
    },
    onSignal: async () => undefined,
    onEnvelope: () => undefined,
    maxIceRestarts: 0,
  });
  mesh.syncDevices([device('b'), device('c')]);
  await Promise.resolve(); await Promise.resolve();
  pcs[0]!.presenceChannel!.open();
  const presence = { ...envelope('a'), kind: 'signal', signalClass: 'presence' } as MailboxEnvelope;
  mesh.broadcastPresenceEnvelope(presence);
  assert(pcs[0]!.presenceChannel!.sent.length === 1, 'open peer did not receive direct presence');
  assert(pcs[1]!.presenceChannel!.sent.length === 0, 'closed peer unexpectedly received presence');
  mesh.close();
});

test('buffers ICE until offer and imports only the DTLS-bound remote device', async () => {
  const pcs: FakePeerConnection[] = [];
  const received: MailboxEnvelope[] = [];
  const errors: string[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'z',
    maxEnvelopeBytes: 16_384,
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration); pcs.push(pc); return pc as unknown as RTCPeerConnection;
    },
    onSignal: async () => undefined,
    onEnvelope: (value) => { received.push(value); },
    onError: (message) => errors.push(message),
  });
  mesh.syncDevices([device('a')]);
  await mesh.handleSignal({ kind: 'ice', candidates: ['candidate:early'], from: 'a' });
  assert(pcs[0]!.candidates.length === 0, 'early ICE was not buffered');
  await mesh.handleSignal({ kind: 'offer', sdp: 'offer-sdp', from: 'a' });
  assert(Number(pcs[0]!.candidates.length) === 1, 'buffered ICE was not flushed');
  const channel = pcs[0]!.emitDataChannel();
  channel.open();
  const good = new TextEncoder().encode(JSON.stringify(envelope('a')));
  channel.receive(good.buffer as ArrayBuffer);
  await Promise.resolve();
  assert(received.length === 1, 'valid direct envelope was not imported');
  const forged = new TextEncoder().encode(JSON.stringify(envelope('other')));
  channel.receive(forged.buffer as ArrayBuffer);
  await Promise.resolve(); await Promise.resolve();
  assert(received.length === 1, 'forged remote device envelope was imported');
  assert(errors.includes('direct_message_rejected'), 'forged sender was not reported');
  const presenceChannel = pcs[0]!.emitDataChannel(new FakeChannel(ATTN_PRESENCE_CHANNEL_LABEL));
  presenceChannel.open();
  const presence = new TextEncoder().encode(JSON.stringify({
    ...envelope('a'),
    kind: 'signal',
    signalClass: 'presence',
  }));
  presenceChannel.receive(presence.buffer as ArrayBuffer);
  await Promise.resolve();
  assert(received.length === 2, 'presence lane did not import presence');
  channel.receive(presence.buffer as ArrayBuffer);
  await Promise.resolve(); await Promise.resolve();
  assert(received.length === 2, 'presence was accepted on the reliable review lane');
  mesh.close();
});

test('browser always offers to a native peer regardless of lexical device id', async () => {
  const signals: string[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'z-browser',
    maxEnvelopeBytes: 4096,
    createPeerConnection: (configuration) =>
      new FakePeerConnection(configuration) as unknown as RTCPeerConnection,
    onSignal: async (_target, payload) => { signals.push(payload.kind); },
    onEnvelope: () => undefined,
  });
  mesh.syncDevices([device('a-native', 'attn-native')]);
  await Promise.resolve(); await Promise.resolve();
  assert(signals.includes('offer'), 'browser did not offer to lexically smaller native peer');
  mesh.close();
});

test('surfaces direct failure while leaving mailbox ownership outside the mesh', () => {
  const pcs: FakePeerConnection[] = [];
  const states: BrowserDirectState[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'a',
    maxEnvelopeBytes: 1024,
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration); pcs.push(pc); return pc as unknown as RTCPeerConnection;
    },
    onSignal: async () => undefined,
    onEnvelope: () => undefined,
    onState: (state) => states.push(state),
    maxIceRestarts: 0,
  });
  mesh.syncDevices([device('z')]);
  pcs[0]!.fail();
  assert(states.at(-1) === 'direct_failed', 'failed ICE did not publish direct_failed');
  mesh.close();
});

test('rejects TURN configuration', () => {
  let rejected = false;
  try {
    new BrowserPeerMesh({
      localDeviceId: 'a',
      maxEnvelopeBytes: 1024,
      stunServers: ['turn:relay.example.com'],
      onSignal: async () => undefined,
      onEnvelope: () => undefined,
    });
  } catch { rejected = true; }
  assert(rejected, 'TURN server was accepted');
});

test('bounded negotiation deadline surfaces direct_failed', async () => {
  const states: BrowserDirectState[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'z',
    maxEnvelopeBytes: 1024,
    negotiationTimeoutMs: 5,
    maxIceRestarts: 0,
    createPeerConnection: (configuration) =>
      new FakePeerConnection(configuration) as unknown as RTCPeerConnection,
    onSignal: async () => undefined,
    onEnvelope: () => undefined,
    onState: (state) => states.push(state),
  });
  mesh.syncDevices([device('a')]);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert(states.at(-1) === 'direct_failed', 'negotiation timeout stayed mailbox forever');
  mesh.close();
});

test('duplicate DataChannel cannot replace the active channel', () => {
  const pcs: FakePeerConnection[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'z',
    maxEnvelopeBytes: 4096,
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration); pcs.push(pc); return pc as unknown as RTCPeerConnection;
    },
    onSignal: async () => undefined,
    onEnvelope: () => undefined,
  });
  mesh.syncDevices([device('a')]);
  const first = pcs[0]!.emitDataChannel();
  first.open();
  const duplicate = pcs[0]!.emitDataChannel();
  mesh.broadcastEnvelope(envelope('z'));
  assert(duplicate.readyState === 'closed', 'duplicate channel was not rejected');
  assert(first.sent.length === 1, 'active channel was replaced by duplicate');
  mesh.close();
});

test('offline signal sender is rejected without throwing into mailbox transport', async () => {
  const errors: string[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'z',
    maxEnvelopeBytes: 1024,
    createPeerConnection: (configuration) =>
      new FakePeerConnection(configuration) as unknown as RTCPeerConnection,
    onSignal: async () => undefined,
    onEnvelope: () => undefined,
    onError: (code) => errors.push(code),
  });
  await mesh.handleSignal({ kind: 'offer', sdp: 'v=0', from: 'offline-a' });
  assert(errors.includes('direct_signal_sender_offline'), 'offline sender was not rejected opaquely');
  mesh.close();
});

test('constructor failure clears when the failed peer leaves the online roster', () => {
  const states: BrowserDirectState[] = [];
  const mesh = new BrowserPeerMesh({
    localDeviceId: 'a',
    maxEnvelopeBytes: 1024,
    createPeerConnection: () => { throw new Error('forced'); },
    onSignal: async () => undefined,
    onEnvelope: () => undefined,
    onState: (state) => states.push(state),
  });
  mesh.syncDevices([device('z')]);
  assert(states.at(-1) === 'direct_failed', 'constructor failure was not surfaced');
  mesh.syncDevices([]);
  assert(states.at(-1) === 'mailbox', 'departed failed peer kept direct_failed sticky');
  mesh.close();
});

let passed = 0;
const failures: string[] = [];
for (const [name, fn] of tests) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    console.error(`FAIL ${failures.at(-1)}`);
  }
}
console.log(`browser-webrtc: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
