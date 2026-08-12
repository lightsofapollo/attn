// Local multi-tab live co-editing (attn-47r).
//
// Reuses the owner-as-authority collab stack (CollabAuthority/CollabHost/
// CollabClient/CollabController) for tabs of the SAME browser profile on an
// UNSHARED workspace. The fenced-lease-holding tab hosts one authority per
// file in the controller's legacy-epoch mode — there is no published snapshot
// to authenticate against; the seed is the workspace's local head revision —
// and every other tab joins as a plain CollabClient. The wire is a
// per-workspace BroadcastChannel instead of the encrypted relay.
//
// Durability is unchanged: only the lease holder commits. The owner tab's
// editor+autosave own the file it has open; the hub commits every OTHER
// hosted file from the authority's canonical doc when accepted batches land.
// Steps are ephemeral by design — a crash loses at most one debounce window,
// exactly like a single tab.

import type { Node as PmNode } from 'prosemirror-model';

import { CollabController, parseCollabWireMessage } from '../prosemirror/collab-controller';
import { LOCAL_COLLAB_CHANNEL_PREFIX, openBroadcastChannel } from '../tab-channels';
import type { FileId } from '../types';
import {
  BrowserReviewEphemeraBus,
  type BrowserReviewEphemeraChannel,
  type BrowserReviewEphemeraMessage,
  type BrowserReviewEphemeraPeer,
  type BrowserReviewEphemeraSignal,
} from './browser-review-ephemera';

/** Primed by loadSeed (async, always ahead of any commit) so commitNow can stay
 *  synchronous while the module itself remains off the desk route. */
let schemaModule: typeof import('../schema') | null = null;

export { LOCAL_COLLAB_CHANNEL_PREFIX };
/** Wire ids (fileId, `legacy:` epoch) are capped at 256 bytes by the collab
 * envelope; local fileIds ARE entry paths, so deeper paths fall back to the
 * read-only follow mode instead of producing unroutable messages. */
export const MAX_LOCAL_COLLAB_PATH_BYTES = 200;
const HELLO_RETRY_MIN_MS = 300;
const HELLO_RETRY_MAX_MS = 2_000;
const SEED_TIMEOUT_MS = 4_000;
const COMMIT_DEBOUNCE_MS = 800;
const MAX_COLLAB_WIRE_ID_BYTES = 256;

export interface LocalCollabSeed {
  fileId: string;
  epoch: string;
  markdown: string;
}

type LocalCollabBody =
  | { kind: 'hello'; generation: string }
  | { kind: 'hello-request' }
  | { kind: 'seed-request'; path: string }
  | {
      kind: 'seed';
      generation: string;
      path: string;
      fileId: string;
      epoch: string;
      markdown: string;
    }
  | { kind: 'goodbye'; generation: string }
  | { kind: 'collab'; generation: string; payload: string };

/** Room presence snapshot mirrored to follower tabs (attn-90qq): the leader
 * is the only tab holding a live session, so followers render the roster
 * from these broadcasts. Shape mirrors BrowserPeerPresence. */
export type LocalCollabPresencePeer = BrowserReviewEphemeraPeer;

/** Cursor wires are accepted only after the canonical collab parser validates
 * their bounded payload shape. */
function isCursorPayload(payload: string): boolean {
  return parseCollabWireMessage(payload)?.kind === 'cursor';
}

interface LocalCollabEnvelope {
  v: 1;
  workspaceId: string;
  senderId: string;
  body: LocalCollabBody;
}

/** Minimal BroadcastChannel surface, injectable for tests. */
export interface LocalCollabChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type LocalCollabSchedule = (callback: () => void, delayMs: number) => unknown;
export type LocalCollabCancel = (handle: unknown) => void;

interface TimerOptions {
  schedule?: LocalCollabSchedule;
  cancelScheduled?: LocalCollabCancel;
}

function defaultChannel(workspaceId: string): LocalCollabChannel | null {
  return openBroadcastChannel(
    `${LOCAL_COLLAB_CHANNEL_PREFIX}${workspaceId}`,
  ) as unknown as LocalCollabChannel | null;
}

function randomGeneration(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `gen-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validWireId(value: string): boolean {
  return value.length > 0 && utf8Length(value) <= MAX_COLLAB_WIRE_ID_BYTES;
}

/** A path usable as a local collab fileId (bounded so wire ids stay valid). */
export function localCollabFileId(path: string): FileId | null {
  if (path.length === 0 || utf8Length(path) > MAX_LOCAL_COLLAB_PATH_BYTES) return null;
  return path as FileId;
}

function localEpochFor(fileId: FileId): string {
  return `legacy:${fileId}`;
}

function parseEnvelope(data: unknown, workspaceId: string): LocalCollabEnvelope | null {
  if (typeof data !== 'object' || data === null) return null;
  const envelope = data as Partial<LocalCollabEnvelope>;
  if (envelope.v !== 1) return null;
  if (envelope.workspaceId !== workspaceId) return null;
  if (typeof envelope.senderId !== 'string' || envelope.senderId.length === 0) return null;
  const body = envelope.body as Partial<LocalCollabBody> | undefined;
  if (typeof body !== 'object' || body === null || typeof body.kind !== 'string') return null;
  switch (body.kind) {
    case 'hello-request':
      return envelope as LocalCollabEnvelope;
    case 'hello':
    case 'goodbye':
      return typeof (body as { generation?: unknown }).generation === 'string'
        ? (envelope as LocalCollabEnvelope)
        : null;
    case 'seed-request':
      return typeof (body as { path?: unknown }).path === 'string'
        ? (envelope as LocalCollabEnvelope)
        : null;
    case 'seed': {
      const seed = body as {
        generation?: unknown;
        path?: unknown;
        fileId?: unknown;
        epoch?: unknown;
        markdown?: unknown;
      };
      return typeof seed.generation === 'string'
        && typeof seed.path === 'string'
        && typeof seed.fileId === 'string'
        && typeof seed.epoch === 'string'
        && typeof seed.markdown === 'string'
        ? (envelope as LocalCollabEnvelope)
        : null;
    }
    case 'collab': {
      const collab = body as { generation?: unknown; payload?: unknown };
      return typeof collab.generation === 'string' && typeof collab.payload === 'string'
        ? (envelope as LocalCollabEnvelope)
        : null;
    }
    default:
      return null;
  }
}

// ————————————————————————————————————————————————————————————— owner side —

export interface LocalCollabHubOptions extends TimerOptions {
  workspaceId: string;
  /** This tab's stable holder id (the lease holder's identity on the wire). */
  holderId: string;
  selfLabel: string;
  selfColor: string;
  /** Head markdown for an entry; null for assets/missing entries. */
  readHeadMarkdown(path: string): Promise<string | null>;
  /** Durable fenced commit through the owner runtime's mutation queue. */
  commitMarkdown(path: string, markdown: string): Promise<void>;
  /**
   * The sole cross-tab presence transport. It is kept separate from this
   * document channel so cursors/rosters can never turn into durable steps.
   */
  ephemera?: BrowserReviewEphemeraBus | null;
  /** Owner-only room egress for a follower tab's already-validated cursor. */
  forwardEphemera?: (signal: BrowserReviewEphemeraSignal) => void;
  /** Active published-room controller. When present, local tabs join the same
   * authenticated authority instead of creating a parallel legacy authority. */
  controller?: CollabController;
  /** Exact published seed (stable file id + snapshot epoch) for shared rooms. */
  seedForPath?: (path: string) => Promise<LocalCollabSeed | null>;
  /** Resolve a published file id back to its local path for headless commits. */
  pathForFileId?: (fileId: FileId) => string | null;
  channel?: LocalCollabChannel | null;
  commitDebounceMs?: number;
}

/**
 * Owner-tab glue: hosts the per-file authorities for local multi-tab
 * co-editing and serves the join handshake. The seed cache is the single
 * source of every authority's base document — the owner's own editor, a
 * follower's seed reply, and a lazily-created host for a file a follower
 * reached first all read the same cached markdown, so every participant
 * seeds from an identical base.
 */
export class LocalCollabHub {
  readonly generation = randomGeneration();
  readonly controller: CollabController;
  private readonly options: LocalCollabHubOptions;
  private readonly channel: LocalCollabChannel | null;
  private readonly seeds = new Map<FileId, { markdown: string; doc: PmNode }>();
  /** Latest room roster, retained only to answer a late local-tab handshake.
   * It is republished through BrowserReviewEphemeraBus, never the document
   * channel and never durable storage. */
  private lastPresence: BrowserReviewEphemeraPeer[] = [];
  private readonly pendingCommits = new Map<FileId, unknown>();
  private readonly inflightCommits = new Set<Promise<void>>();
  private readonly seedRequests = new Map<string, Promise<LocalCollabSeed | null>>();
  private readonly schedule: LocalCollabSchedule;
  private readonly cancelScheduled: LocalCollabCancel;
  private readonly unsubscribeControllerSend: (() => void) | null;
  private readonly unsubscribeEphemera: (() => void) | null;
  private closed = false;

  constructor(options: LocalCollabHubOptions) {
    this.options = options;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.channel = options.channel === undefined
      ? defaultChannel(options.workspaceId)
      : options.channel;
    this.controller = options.controller ?? new CollabController({
      isOwner: true,
      send: (payload) => this.onControllerSend(payload),
      selfClientId: options.holderId,
      selfLabel: options.selfLabel,
      selfColor: options.selfColor,
      // A follower can reach a file before the owner opens it; seed its
      // authority from the same cached base a seed reply would carry.
      getSeedDoc: (fileId) => this.seeds.get(fileId)?.doc ?? null,
    });
    this.unsubscribeControllerSend = options.controller
      ? this.controller.addSendListener((payload) => this.onControllerSend(payload))
      : null;
    this.unsubscribeEphemera = options.ephemera?.subscribe((message) => this.onEphemera(message)) ?? null;
    if (this.channel) {
      this.channel.onmessage = (event) => this.onMessage(event.data);
    }
    this.post({ kind: 'hello', generation: this.generation });
  }

  /** Whether local co-editing can run at all (BroadcastChannel available). */
  get available(): boolean {
    return this.channel !== null;
  }

  /**
   * The seed every participant (including the owner's own editor) binds
   * from. Cached per file for the hub's lifetime: authorities replay their
   * step logs over this exact base, so it must never drift to a newer head.
   */
  async seedFor(path: string): Promise<LocalCollabSeed | null> {
    if (this.options.seedForPath) {
      const seed = await this.options.seedForPath(path);
      if (this.closed || !seed || !validWireId(seed.fileId) || !validWireId(seed.epoch)) return null;
      return seed;
    }
    const fileId = localCollabFileId(path);
    if (fileId === null) return null;
    const cached = this.seeds.get(fileId);
    if (cached) {
      return { fileId, epoch: localEpochFor(fileId), markdown: cached.markdown };
    }
    // Coalesce concurrent misses (owner bind racing a follower's request) so
    // both observe one cache entry instead of parsing two different heads.
    let request = this.seedRequests.get(path);
    if (!request) {
      request = this.loadSeed(path, fileId).finally(() => this.seedRequests.delete(path));
      this.seedRequests.set(path, request);
    }
    return request;
  }

  private async loadSeed(path: string, fileId: FileId): Promise<LocalCollabSeed | null> {
    const markdown = await this.options.readHeadMarkdown(path);
    if (markdown === null || this.closed) return null;
    const existing = this.seeds.get(fileId);
    if (existing) {
      return { fileId, epoch: localEpochFor(fileId), markdown: existing.markdown };
    }
    schemaModule ??= await import('../schema');
    const doc = schemaModule.markdownParser.parse(markdown);
    if (!doc) return null;
    this.seeds.set(fileId, { markdown, doc });
    return { fileId, epoch: localEpochFor(fileId), markdown };
  }

  /** Flush pending commits, say goodbye, release the channel. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [fileId, timer] of this.pendingCommits) {
      this.cancelScheduled(timer);
      this.commitNow(fileId);
    }
    this.pendingCommits.clear();
    await Promise.allSettled([...this.inflightCommits]);
    this.post({ kind: 'goodbye', generation: this.generation });
    this.unsubscribeControllerSend?.();
    this.unsubscribeEphemera?.();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  private onControllerSend(payload: string): void {
    // Cursor presence does not belong on the document channel. The generic
    // ephemera bus fans this owner cursor to follower tabs; BrowserAuthority
    // independently forwards it to remote room members.
    if (isCursorPayload(payload)) {
      this.options.ephemera?.publish({ kind: 'cursor', source: 'owner', payload });
      return;
    }
    this.post({ kind: 'collab', generation: this.generation, payload });
    // Every accepted batch flows through here as a broadcast — the durable
    // commit signal for files the owner's editor (and its autosave) does NOT
    // have open. The active file's replayed steps hit the owner's editor and
    // commit through the existing autosave path instead.
    try {
      const message = JSON.parse(payload) as { kind?: unknown; fileId?: unknown };
      if (message.kind !== 'broadcast' || typeof message.fileId !== 'string') return;
      const fileId = message.fileId as FileId;
      if (fileId === this.controller.activeFile) return;
      this.scheduleCommit(fileId);
    } catch {
      // Own-controller output; parse failures are unreachable in practice.
    }
  }

  private scheduleCommit(fileId: FileId): void {
    if (this.closed || this.pendingCommits.has(fileId)) return;
    const debounce = this.options.commitDebounceMs ?? COMMIT_DEBOUNCE_MS;
    this.pendingCommits.set(fileId, this.schedule(() => {
      this.pendingCommits.delete(fileId);
      this.commitNow(fileId);
    }, debounce));
  }

  private commitNow(fileId: FileId): void {
    const doc = this.controller.authorityDoc(fileId);
    if (!doc) return;
    const path = this.options.pathForFileId?.(fileId) ?? fileId;
    if (!path) return;
    /* Serialize synchronously off the module primed in loadSeed (attn-n01r.41,
       flake fixed in attn-n01r.48).

       An earlier version awaited import('../schema') here. That kept close()'s
       contract — the promise is still registered synchronously — but it added a
       tick before the commit was issued, and it made
       'headless published edit commits once' fail 3 runs in 20 where it had
       failed 0 in 20 before. loadSeed always runs before any commit and is
       already async, so priming there and reading the cached module here keeps
       the desk free of ProseMirror without changing commit timing at all. */
    const serializer = schemaModule?.markdownSerializer;
    if (!serializer) return;
    const commit = this.options.commitMarkdown(path, serializer.serialize(doc)).catch(() => {
      // Lease loss / close races: the follower that takes over re-commits
      // its live doc, so a failed trailing commit here is not data loss.
    });
    this.inflightCommits.add(commit);
    void commit.finally(() => this.inflightCommits.delete(commit));
  }

  private onMessage(data: unknown): void {
    if (this.closed) return;
    const envelope = parseEnvelope(data, this.options.workspaceId);
    if (!envelope || envelope.senderId === this.options.holderId) return;
    const body = envelope.body;
    if (body.kind === 'hello-request') {
      this.post({ kind: 'hello', generation: this.generation });
      // BroadcastChannel has no retained messages. Re-send the current roster
      // through the generic loss-only bus after the follower is live so a late
      // tab need not wait for a later authority status tick.
      if (this.lastPresence.length > 0) {
        this.options.ephemera?.publish({ kind: 'presence', peers: this.lastPresence });
      }
      return;
    }
    if (body.kind === 'seed-request') {
      void this.seedFor(body.path).then((seed) => {
        if (!seed || this.closed) return;
        this.post({
          kind: 'seed',
          generation: this.generation,
          path: body.path,
          fileId: seed.fileId,
          epoch: seed.epoch,
          markdown: seed.markdown,
        });
      });
      return;
    }
    if (body.kind === 'collab' && body.generation === this.generation) {
      // The document bus accepts only document/replay messages. Cursor input
      // arrives through BrowserReviewEphemeraBus, where source and size are
      // validated separately.
      if (isCursorPayload(body.payload)) return;
      this.controller.onInbound(body.payload, envelope.senderId);
    }
  }

  private onEphemera(message: BrowserReviewEphemeraMessage): void {
    if (this.closed) return;
    const signal = message.signal;
    if (signal.kind === 'presence') {
      // The runtime publishes roster snapshots from this owner tab. Retain a
      // bounded copy only for the next LocalCollabJoin hello; no peer state is
      // ever persisted or replayed through a review log.
      if (message.senderId === this.options.holderId) {
        this.lastPresence = signal.peers.map((peer) => ({ ...peer }));
      }
      return;
    }
    if (message.senderId === this.options.holderId) return;
    // A local follower's cursor arrives here already structurally validated.
    // It is consumed by the owner controller and, for a published room, sent
    // once through the authenticated owner session. Room/owner cursors are
    // only for follower rendering and are already handled by the authority.
    if (signal.source !== 'local-tab') return;
    this.controller.onInbound(signal.payload, message.senderId);
    try {
      this.options.forwardEphemera?.(signal);
    } catch {
      // Presence is best-effort by definition.
    }
  }

  private post(body: LocalCollabBody): void {
    try {
      this.channel?.postMessage({
        v: 1,
        workspaceId: this.options.workspaceId,
        senderId: this.options.holderId,
        body,
      } satisfies LocalCollabEnvelope);
    } catch {
      // Advisory wire; followers re-handshake and IndexedDB stays canonical.
    }
  }
}

// ——————————————————————————————————————————————————————————— follower side —

export interface LocalCollabJoinState {
  status: 'connecting' | 'live';
  generation: string | null;
  ownerHolderId: string | null;
  /** Room roster mirrored from the hub's presence broadcasts (attn-90qq). */
  peers: LocalCollabPresencePeer[];
}

export interface LocalCollabJoinOptions extends TimerOptions {
  workspaceId: string;
  holderId: string;
  selfLabel: string;
  selfColor: string;
  channel?: LocalCollabChannel | null;
  /** Test seam for the generic cursor/presence bus. */
  ephemeraChannel?: BrowserReviewEphemeraChannel | null;
}

/**
 * Follower-tab glue: a persistent, reconnecting CollabClient wire. It keeps
 * requesting `hello` until a hub answers, builds a reviewer-role controller
 * bound to that hub's generation, and tears it down again on `goodbye` or a
 * new generation (a takeover) — subscribers rebind + reseed on every state
 * change, so a client never applies steps from two authority generations.
 */
export class LocalCollabJoin {
  private readonly options: LocalCollabJoinOptions;
  private readonly channel: LocalCollabChannel | null;
  private readonly ephemera: BrowserReviewEphemeraBus;
  private readonly unsubscribeEphemera: () => void;
  private readonly subscribers = new Set<(state: LocalCollabJoinState) => void>();
  private readonly schedule: LocalCollabSchedule;
  private readonly cancelScheduled: LocalCollabCancel;
  private stateValue: LocalCollabJoinState = {
    status: 'connecting',
    generation: null,
    ownerHolderId: null,
    peers: [],
  };
  private controllerValue: CollabController | null = null;
  /** A roster may arrive on the ephemera channel before this tab receives the
   * document-channel hello. Keep one bounded advisory snapshot and apply it
   * only if that hello names the same elected owner. */
  private pendingPresence: { senderId: string; peers: LocalCollabPresencePeer[] } | null = null;
  private seedWaiters = new Map<string, Array<(seed: LocalCollabSeed | null) => void>>();
  private helloTimer: unknown = null;
  private helloDelayMs = HELLO_RETRY_MIN_MS;
  private closed = false;

  constructor(options: LocalCollabJoinOptions) {
    this.options = options;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.channel = options.channel === undefined
      ? defaultChannel(options.workspaceId)
      : options.channel;
    this.ephemera = new BrowserReviewEphemeraBus({
      workspaceId: options.workspaceId,
      senderId: options.holderId,
      ...(options.ephemeraChannel === undefined ? {} : { channel: options.ephemeraChannel }),
    });
    this.unsubscribeEphemera = this.ephemera.subscribe((message) => this.onEphemera(message));
    if (this.channel) {
      this.channel.onmessage = (event) => this.onMessage(event.data);
      this.requestHello();
    }
  }

  get available(): boolean {
    return this.channel !== null;
  }

  getState(): LocalCollabJoinState {
    return { ...this.stateValue };
  }

  subscribe(subscriber: (state: LocalCollabJoinState) => void): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.getState());
    return () => this.subscribers.delete(subscriber);
  }

  /** The controller for the CURRENT generation; null while disconnected. */
  getController(): CollabController | null {
    return this.controllerValue;
  }

  /** Request the authority's base document for a path (current generation). */
  async getSeed(path: string): Promise<LocalCollabSeed | null> {
    if (this.closed || this.stateValue.status !== 'live') return null;
    if (path.length === 0 || utf8Length(path) > 4_096) return null;
    const generation = this.stateValue.generation;
    return new Promise<LocalCollabSeed | null>((resolve) => {
      const waiters = this.seedWaiters.get(path) ?? [];
      waiters.push(resolve);
      this.seedWaiters.set(path, waiters);
      this.post({ kind: 'seed-request', path });
      this.schedule(() => {
        // Still unanswered for this generation → give up quietly.
        if (this.stateValue.generation !== generation) return;
        this.settleSeed(path, null, resolve);
      }, SEED_TIMEOUT_MS);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.helloTimer !== null) this.cancelScheduled(this.helloTimer);
    this.helloTimer = null;
    this.dropAllSeedWaiters();
    this.controllerValue = null;
    this.unsubscribeEphemera();
    this.ephemera.close();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  private requestHello(): void {
    if (this.closed || this.stateValue.status === 'live') return;
    this.post({ kind: 'hello-request' });
    this.helloTimer = this.schedule(() => {
      this.helloTimer = null;
      this.helloDelayMs = Math.min(this.helloDelayMs * 2, HELLO_RETRY_MAX_MS);
      this.requestHello();
    }, this.helloDelayMs);
  }

  private becomeLive(generation: string, ownerHolderId: string): void {
    if (this.helloTimer !== null) {
      this.cancelScheduled(this.helloTimer);
      this.helloTimer = null;
    }
    this.helloDelayMs = HELLO_RETRY_MIN_MS;
    this.dropAllSeedWaiters();
    this.controllerValue = new CollabController({
      isOwner: false,
      send: (payload) => {
        if (isCursorPayload(payload)) {
          this.ephemera.publish({ kind: 'cursor', source: 'local-tab', payload });
          return;
        }
        this.post({ kind: 'collab', generation, payload });
      },
      selfClientId: this.options.holderId,
      selfLabel: this.options.selfLabel,
      selfColor: this.options.selfColor,
      // Only the hub whose generation we joined may linearize steps.
      isAuthorityDevice: (deviceId) => deviceId === ownerHolderId,
    });
    this.patchState({ status: 'live', generation, ownerHolderId, peers: [] });
    if (this.pendingPresence?.senderId === ownerHolderId) {
      this.patchState({ peers: this.pendingPresence.peers });
    }
    this.pendingPresence = null;
  }

  private becomeDisconnected(): void {
    this.controllerValue = null;
    this.pendingPresence = null;
    this.dropAllSeedWaiters();
    this.patchState({ status: 'connecting', generation: null, ownerHolderId: null, peers: [] });
    this.helloDelayMs = HELLO_RETRY_MIN_MS;
    if (this.helloTimer === null) this.requestHello();
  }

  private onMessage(data: unknown): void {
    if (this.closed) return;
    const envelope = parseEnvelope(data, this.options.workspaceId);
    if (!envelope || envelope.senderId === this.options.holderId) return;
    const body = envelope.body;
    switch (body.kind) {
      case 'hello': {
        if (
          this.stateValue.status === 'live'
          && this.stateValue.generation === body.generation
        ) return;
        this.becomeLive(body.generation, envelope.senderId);
        return;
      }
      case 'goodbye': {
        if (this.stateValue.generation === body.generation) this.becomeDisconnected();
        return;
      }
      case 'seed': {
        if (body.generation !== this.stateValue.generation) return;
        if (!validWireId(body.fileId) || !validWireId(body.epoch)) return;
        this.resolveSeed(body.path, {
          fileId: body.fileId,
          epoch: body.epoch,
          markdown: body.markdown,
        });
        return;
      }
      case 'collab': {
        if (body.generation !== this.stateValue.generation) return;
        this.controllerValue?.onInbound(body.payload, envelope.senderId);
        return;
      }
      default:
        return;
    }
  }

  private resolveSeed(path: string, seed: LocalCollabSeed): void {
    const waiters = this.seedWaiters.get(path);
    if (!waiters) return;
    this.seedWaiters.delete(path);
    for (const waiter of waiters) waiter(seed);
  }

  private settleSeed(
    path: string,
    seed: LocalCollabSeed | null,
    resolve: (seed: LocalCollabSeed | null) => void,
  ): void {
    const waiters = this.seedWaiters.get(path);
    if (!waiters?.includes(resolve)) return;
    const remaining = waiters.filter((waiter) => waiter !== resolve);
    if (remaining.length === 0) this.seedWaiters.delete(path);
    else this.seedWaiters.set(path, remaining);
    resolve(seed);
  }

  private dropAllSeedWaiters(): void {
    for (const waiters of this.seedWaiters.values()) {
      for (const waiter of waiters) waiter(null);
    }
    this.seedWaiters.clear();
  }

  private patchState(patch: Partial<LocalCollabJoinState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    const snapshot = this.getState();
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  private onEphemera(message: BrowserReviewEphemeraMessage): void {
    if (this.closed || message.senderId === this.options.holderId) return;
    const signal = message.signal;
    if (signal.kind === 'presence') {
      // Only the elected document authority may mirror the room roster.
      if (message.senderId === this.stateValue.ownerHolderId) {
        this.patchState({ peers: [...signal.peers] });
      } else if (this.stateValue.ownerHolderId === null) {
        // BroadcastChannel delivery order is independent across channel names;
        // retain one snapshot until the document-channel hello authenticates
        // which tab is the owner for this generation.
        this.pendingPresence = { senderId: message.senderId, peers: [...signal.peers] };
      }
      return;
    }
    // Only the owner tab can authenticate and relay remote room/owner
    // presence to this follower. A local-tab cursor is owner-bound only.
    if (
      (signal.source === 'room' || signal.source === 'owner')
      && message.senderId === this.stateValue.ownerHolderId
    ) {
      this.controllerValue?.onInbound(signal.payload, message.senderId);
    }
  }

  private post(body: LocalCollabBody): void {
    try {
      this.channel?.postMessage({
        v: 1,
        workspaceId: this.options.workspaceId,
        senderId: this.options.holderId,
        body,
      } satisfies LocalCollabEnvelope);
    } catch {
      // Advisory wire; the reconnect loop re-establishes state.
    }
  }
}
