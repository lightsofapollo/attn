import type { BrowserSignalingPayload } from './browser-signaling';
import type { Device, MailboxEnvelope } from './browser-ws';

export const ATTN_DATA_CHANNEL_LABEL = 'attn-review';
export const ATTN_PRESENCE_CHANNEL_LABEL = 'attn-presence';
export const DEFAULT_STUN_SERVERS = ['stun:stun.l.google.com:19302'];

export type BrowserDirectState = 'mailbox' | 'live_direct' | 'direct_failed';

export interface BrowserPeerMeshOptions {
  localDeviceId: string;
  maxEnvelopeBytes: number;
  stunServers?: string[];
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  onSignal: (targetDeviceId: string, payload: BrowserSignalingPayload) => Promise<void>;
  onEnvelope: (envelope: MailboxEnvelope, remoteDeviceId: string) => Promise<void> | void;
  onState?: (state: BrowserDirectState) => void;
  /** A peer's lossy presence lane opened; caller should re-send latest state. */
  onPresenceReady?: (deviceId: string) => void;
  onError?: (message: string) => void;
  negotiationTimeoutMs?: number;
  maxIceRestarts?: number;
}

interface PeerState {
  device: Device;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  presenceChannel: RTCDataChannel | null;
  pendingCandidates: string[];
  failed: boolean;
  closed: boolean;
  restartAttempts: number;
  negotiationTimer: ReturnType<typeof setTimeout> | null;
  restarting: boolean;
}

/** Opportunistic full-mesh STUN-only WebRTC transport. Mailbox remains external and authoritative. */
export class BrowserPeerMesh {
  private readonly opts: BrowserPeerMeshOptions;
  private readonly peers = new Map<string, PeerState>();
  private readonly createPeerConnection: (configuration: RTCConfiguration) => RTCPeerConnection;
  private state: BrowserDirectState = 'mailbox';
  private closed = false;
  private readonly setupFailedDevices = new Set<string>();

  constructor(opts: BrowserPeerMeshOptions) {
    if (opts.localDeviceId.length === 0) throw new Error('localDeviceId is required');
    if (!Number.isSafeInteger(opts.maxEnvelopeBytes) || opts.maxEnvelopeBytes <= 0) {
      throw new Error('maxEnvelopeBytes must be a positive safe integer');
    }
    const stunServers = opts.stunServers ?? DEFAULT_STUN_SERVERS;
    if (stunServers.some((url) => !url.startsWith('stun:'))) {
      throw new Error('browser direct transport accepts STUN URLs only');
    }
    this.opts = { ...opts, stunServers: [...stunServers] };
    this.createPeerConnection =
      opts.createPeerConnection ??
      ((configuration) => new RTCPeerConnection(configuration));
  }

  getState(): BrowserDirectState {
    return this.state;
  }

  /** Reconcile immutable registered-device records into one peer connection per eligible peer. */
  syncDevices(devices: Iterable<Device>): void {
    if (this.closed) return;
    const eligible = new Map(
      [...devices]
        .filter(
          (device) =>
            device.deviceId !== this.opts.localDeviceId &&
            (device.client === 'attn-native' || device.client === 'attn-browser'),
        )
        .map((device) => [device.deviceId, device]),
    );
    for (const failedDeviceId of this.setupFailedDevices) {
      if (!eligible.has(failedDeviceId)) this.setupFailedDevices.delete(failedDeviceId);
    }
    for (const [deviceId, peer] of this.peers) {
      if (!eligible.has(deviceId)) {
        this.closePeer(peer);
        this.peers.delete(deviceId);
        this.setupFailedDevices.delete(deviceId);
      }
    }
    for (const device of eligible.values()) {
      const existing = this.peers.get(device.deviceId);
      if (existing && !existing.failed && existing.channel?.readyState !== 'closed') continue;
      if (existing) {
        this.closePeer(existing);
        this.peers.delete(device.deviceId);
      }
      try {
        const peer = this.createPeer(device);
        this.peers.set(device.deviceId, peer);
        this.setupFailedDevices.delete(device.deviceId);
        if (this.shouldInitiate(device)) void this.offer(peer);
      } catch (error) {
        this.setupFailedDevices.add(device.deviceId);
        this.reportFailure('direct_peer_setup_failed');
      }
    }
    this.publishState();
  }

  removePeer(deviceId: string): void {
    this.setupFailedDevices.delete(deviceId);
    const peer = this.peers.get(deviceId);
    if (!peer) {
      this.publishState();
      return;
    }
    this.closePeer(peer);
    this.peers.delete(deviceId);
    this.setupFailedDevices.delete(deviceId);
    this.publishState();
  }

  async handleSignal(payload: BrowserSignalingPayload): Promise<void> {
    if (this.closed || payload.from === this.opts.localDeviceId) return;
    if (payload.kind === 'collab' || payload.kind === 'request_snapshot') return;
    let peer = this.peers.get(payload.from);
    if (!peer) {
      this.reportFailure('direct_signal_sender_offline');
      return;
    }
    if (peer.failed && payload.kind === 'offer') {
      this.closePeer(peer);
      peer = this.createPeer(peer.device);
      this.peers.set(payload.from, peer);
    }
    try {
      switch (payload.kind) {
        case 'offer':
          if (peer.device.client === 'attn-native' || !(payload.from < this.opts.localDeviceId)) {
            throw new Error('offer violates deterministic initiator ordering');
          }
          await peer.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
          await this.flushCandidates(peer);
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          if (!peer.pc.localDescription?.sdp) throw new Error('answer omitted local SDP');
          await this.opts.onSignal(payload.from, {
            kind: 'answer',
            sdp: peer.pc.localDescription.sdp,
            from: this.opts.localDeviceId,
          });
          break;
        case 'answer':
          if (!this.shouldInitiate(peer.device)) {
            throw new Error('answer does not match local initiator ordering');
          }
          await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
          await this.flushCandidates(peer);
          break;
        case 'ice':
          for (const candidate of payload.candidates) {
            if (!peer.pc.remoteDescription) peer.pendingCandidates.push(candidate);
            else await peer.pc.addIceCandidate({ candidate, sdpMLineIndex: 0 });
          }
          break;
      }
    } catch (error) {
      peer.failed = true;
      this.reportFailure('direct_signaling_failed');
    }
    this.publishState();
  }

  /** Best-effort exact encrypted-envelope fan-out alongside the mailbox path. */
  broadcastEnvelope(envelope: MailboxEnvelope): void {
    if (this.closed) return;
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    try {
      if (bytes.length > this.opts.maxEnvelopeBytes) return;
      for (const peer of this.peers.values()) {
        const channel = peer.channel;
        if (!channel || channel.readyState !== 'open') continue;
        try {
          channel.send(bytes);
        } catch (error) {
          this.opts.onError?.('direct_send_failed');
        }
      }
    } finally {
      bytes.fill(0);
    }
  }

  /**
   * Ephemeral presence never enters the mailbox. Use its own unordered,
   * no-retransmit channel so a stale cursor packet cannot block a newer one.
   */
  broadcastPresenceEnvelope(envelope: MailboxEnvelope): void {
    if (this.closed || envelope.signalClass !== 'presence') return;
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    try {
      if (bytes.length > this.opts.maxEnvelopeBytes) return;
      for (const peer of this.peers.values()) {
        const channel = peer.presenceChannel;
        if (!channel || channel.readyState !== 'open') continue;
        try {
          channel.send(bytes);
        } catch {
          this.opts.onError?.('direct_presence_send_failed');
        }
      }
    } finally {
      bytes.fill(0);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
    this.state = 'mailbox';
  }

  private createPeer(device: Device): PeerState {
    const iceServers = (this.opts.stunServers ?? []).map((urls) => ({ urls }));
    const pc = this.createPeerConnection({ iceServers, iceTransportPolicy: 'all' });
    const peer: PeerState = {
      device,
      pc,
      channel: null,
      presenceChannel: null,
      pendingCandidates: [],
      failed: false,
      closed: false,
      restartAttempts: 0,
      negotiationTimer: null,
      restarting: false,
    };
    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.candidate;
      if (!candidate || peer.closed) return;
      void this.opts.onSignal(device.deviceId, {
        kind: 'ice',
        candidates: [candidate],
        from: this.opts.localDeviceId,
      }).catch(() => this.reportFailure('direct_ice_signal_failed'));
    };
    pc.ondatachannel = (event) => this.installChannel(peer, event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        void this.retryIceOrFail(peer, 'direct_peer_connection_failed');
      }
      this.publishState();
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        void this.retryIceOrFail(peer, 'direct_ice_failed');
      }
      this.publishState();
    };
    if (this.shouldInitiate(device)) {
      this.installChannel(peer, pc.createDataChannel(ATTN_DATA_CHANNEL_LABEL, { ordered: true }));
      this.installChannel(peer, pc.createDataChannel(ATTN_PRESENCE_CHANNEL_LABEL, {
        ordered: false,
        maxRetransmits: 0,
      }));
    }
    this.armNegotiationDeadline(peer);
    return peer;
  }

  private async offer(peer: PeerState, iceRestart = false): Promise<void> {
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart }));
      if (!peer.pc.localDescription?.sdp) throw new Error('offer omitted local SDP');
      await this.opts.onSignal(peer.device.deviceId, {
        kind: 'offer',
        sdp: peer.pc.localDescription.sdp,
        from: this.opts.localDeviceId,
      });
    } catch (error) {
      peer.failed = true;
      this.reportFailure('direct_offer_failed');
      this.publishState();
    }
  }

  private installChannel(peer: PeerState, channel: RTCDataChannel): void {
    const isPresence = channel.label === ATTN_PRESENCE_CHANNEL_LABEL;
    if ((!isPresence && channel.label !== ATTN_DATA_CHANNEL_LABEL) || peer.closed) {
      channel.close();
      peer.failed = true;
      this.publishState();
      return;
    }
    const active = isPresence ? peer.presenceChannel : peer.channel;
    if (active && active !== channel) {
      channel.close();
      this.opts.onError?.('direct_duplicate_data_channel');
      return;
    }
    if (isPresence) peer.presenceChannel = channel;
    else peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (!isPresence) {
        peer.failed = false;
        this.clearNegotiationDeadline(peer);
      } else {
        this.opts.onPresenceReady?.(peer.device.deviceId);
      }
      this.publishState();
    };
    channel.onclose = () => {
      if (!isPresence && !peer.closed) peer.failed = true;
      this.publishState();
    };
    channel.onerror = () => {
      if (!isPresence) peer.failed = true;
      this.opts.onError?.(isPresence ? 'direct_presence_channel_failed' : 'direct_data_channel_failed');
      this.publishState();
    };
    channel.onmessage = (event) => {
      void this.handleChannelMessage(peer, event.data, isPresence)
        .catch(() => this.reportFailure('direct_message_rejected'));
    };
    this.publishState();
  }

  private async handleChannelMessage(
    peer: PeerState,
    data: unknown,
    presenceChannel: boolean,
  ): Promise<void> {
    let bytes: Uint8Array;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else {
      throw new Error('unsupported DataChannel message type');
    }
    if (bytes.length === 0 || bytes.length > this.opts.maxEnvelopeBytes) {
      throw new Error('DataChannel envelope is empty or too large');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('DataChannel envelope is not valid JSON');
    }
    const envelope = parseDirectEnvelope(raw);
    if ((envelope.signalClass === 'presence') !== presenceChannel) {
      throw new Error('DataChannel envelope used the wrong transport lane');
    }
    if (envelope.v !== 2 || envelope.roomId === undefined) {
      throw new Error('DataChannel envelope omitted bound room metadata');
    }
    if (envelope.deviceId !== peer.device.deviceId) {
      throw new Error('DataChannel envelope sender does not match DTLS peer');
    }
    await this.opts.onEnvelope(envelope, peer.device.deviceId);
  }

  private async flushCandidates(peer: PeerState): Promise<void> {
    const pending = peer.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await peer.pc.addIceCandidate({ candidate, sdpMLineIndex: 0 });
    }
  }

  private armNegotiationDeadline(peer: PeerState): void {
    this.clearNegotiationDeadline(peer);
    const timeoutMs = this.opts.negotiationTimeoutMs ?? 15_000;
    peer.negotiationTimer = setTimeout(() => {
      peer.negotiationTimer = null;
      if (peer.channel?.readyState === 'open' || peer.closed) return;
      void this.retryIceOrFail(peer, 'direct_negotiation_timeout');
    }, timeoutMs);
  }

  private clearNegotiationDeadline(peer: PeerState): void {
    if (peer.negotiationTimer === null) return;
    clearTimeout(peer.negotiationTimer);
    peer.negotiationTimer = null;
  }

  private async retryIceOrFail(peer: PeerState, failureCode: string): Promise<void> {
    if (peer.closed || peer.channel?.readyState === 'open' || peer.restarting) return;
    const maxRestarts = this.opts.maxIceRestarts ?? 1;
    if (this.shouldInitiate(peer.device) && peer.restartAttempts < maxRestarts) {
      peer.restarting = true;
      peer.restartAttempts += 1;
      try {
        peer.pc.restartIce();
        await this.offer(peer, true);
        this.armNegotiationDeadline(peer);
        return;
      } catch {
        // Fall through to the honest mailbox-backed failure state.
      } finally {
        peer.restarting = false;
      }
    }
    peer.failed = true;
    this.reportFailure(failureCode);
    this.publishState();
  }

  private closePeer(peer: PeerState): void {
    if (peer.closed) return;
    peer.closed = true;
    this.clearNegotiationDeadline(peer);
    try { peer.channel?.close(); } catch { /* best effort */ }
    try { peer.presenceChannel?.close(); } catch { /* best effort */ }
    try { peer.pc.close(); } catch { /* best effort */ }
  }

  private reportFailure(code: string): void {
    this.opts.onError?.(code);
  }

  private shouldInitiate(device: Device): boolean {
    // Cross-implementation DTLS/DataChannel negotiation is most reliable when
    // Chromium creates the offer. Same-client meshes retain the glare-free
    // lexical device-id tie-break used by native.
    return device.client === 'attn-native' || this.opts.localDeviceId < device.deviceId;
  }

  private publishState(): void {
    if (this.closed) return;
    const peers = [...this.peers.values()];
    const next: BrowserDirectState =
      this.setupFailedDevices.size > 0 || peers.some((peer) => peer.failed)
        ? 'direct_failed'
        : peers.length > 0 && peers.every((peer) => peer.channel?.readyState === 'open')
          ? 'live_direct'
          : 'mailbox';
    if (next === this.state) return;
    this.state = next;
    this.opts.onState?.(next);
  }
}

function parseDirectEnvelope(value: unknown): MailboxEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('DataChannel envelope has invalid shape');
  }
  const envelope = value as Record<string, unknown>;
  const requiredStrings = ['roomId', 'envelopeId', 'authorId', 'deviceId', 'kind', 'nonce', 'ciphertext'];
  for (const key of requiredStrings) {
    if (typeof envelope[key] !== 'string' || (envelope[key] as string).length === 0) {
      throw new Error(`DataChannel envelope has invalid ${key}`);
    }
  }
  if (!['event', 'snapshot_blob', 'signal'].includes(envelope.kind as string)) {
    throw new Error('DataChannel envelope has invalid kind');
  }
  for (const key of ['v', 'createdAt', 'expiresAt', 'ciphertextBytes']) {
    if (!Number.isSafeInteger(envelope[key])) throw new Error(`DataChannel envelope has invalid ${key}`);
  }
  if (envelope.v !== 2 || (envelope.ciphertextBytes as number) <= 0) {
    throw new Error('DataChannel envelope has invalid protocol metadata');
  }
  if (envelope.target !== undefined && envelope.target !== null) {
    if (
      typeof envelope.target !== 'object' ||
      typeof (envelope.target as Record<string, unknown>).deviceId !== 'string'
    ) {
      throw new Error('DataChannel envelope has invalid target');
    }
  }
  return value as MailboxEnvelope;
}
