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

import { markdownParser, markdownSerializer } from '../schema';
import { CollabController } from '../prosemirror/collab-controller';
import { LOCAL_COLLAB_CHANNEL_PREFIX, openBroadcastChannel } from '../tab-channels';
import type { FileId } from '../types';

export { LOCAL_COLLAB_CHANNEL_PREFIX };
/** Wire ids (fileId, `legacy:` epoch) are capped at 256 bytes by the collab
 * envelope; local fileIds ARE entry paths, so deeper paths fall back to the
 * read-only follow mode instead of producing unroutable messages. */
export const MAX_LOCAL_COLLAB_PATH_BYTES = 200;
const HELLO_RETRY_MIN_MS = 300;
const HELLO_RETRY_MAX_MS = 2_000;
const SEED_TIMEOUT_MS = 4_000;
const COMMIT_DEBOUNCE_MS = 800;

export interface LocalCollabSeed {
  fileId: string;
  epoch: string;
  markdown: string;
}

type LocalCollabBody =
  | { kind: 'hello'; generation: string }
  | { kind: 'hello-request' }
  | { kind: 'seed-request'; path: string }
  | { kind: 'seed'; generation: string; path: string; markdown: string }
  | { kind: 'goodbye'; generation: string }
  | { kind: 'collab'; generation: string; payload: string };

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
      const seed = body as { generation?: unknown; path?: unknown; markdown?: unknown };
      return typeof seed.generation === 'string'
        && typeof seed.path === 'string'
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
  private readonly pendingCommits = new Map<FileId, unknown>();
  private readonly inflightCommits = new Set<Promise<void>>();
  private readonly seedRequests = new Map<string, Promise<LocalCollabSeed | null>>();
  private readonly schedule: LocalCollabSchedule;
  private readonly cancelScheduled: LocalCollabCancel;
  private closed = false;

  constructor(options: LocalCollabHubOptions) {
    this.options = options;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.channel = options.channel === undefined
      ? defaultChannel(options.workspaceId)
      : options.channel;
    this.controller = new CollabController({
      isOwner: true,
      send: (payload) => this.onControllerSend(payload),
      selfClientId: options.holderId,
      selfLabel: options.selfLabel,
      selfColor: options.selfColor,
      // A follower can reach a file before the owner opens it; seed its
      // authority from the same cached base a seed reply would carry.
      getSeedDoc: (fileId) => this.seeds.get(fileId)?.doc ?? null,
    });
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
    const doc = markdownParser.parse(markdown);
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
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  private onControllerSend(payload: string): void {
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
    const markdown = markdownSerializer.serialize(doc);
    const commit = this.options.commitMarkdown(fileId, markdown).catch(() => {
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
      return;
    }
    if (body.kind === 'seed-request') {
      void this.seedFor(body.path).then((seed) => {
        if (!seed || this.closed) return;
        this.post({
          kind: 'seed',
          generation: this.generation,
          path: body.path,
          markdown: seed.markdown,
        });
      });
      return;
    }
    if (body.kind === 'collab' && body.generation === this.generation) {
      this.controller.onInbound(body.payload, envelope.senderId);
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
}

export interface LocalCollabJoinOptions extends TimerOptions {
  workspaceId: string;
  holderId: string;
  selfLabel: string;
  selfColor: string;
  channel?: LocalCollabChannel | null;
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
  private readonly subscribers = new Set<(state: LocalCollabJoinState) => void>();
  private readonly schedule: LocalCollabSchedule;
  private readonly cancelScheduled: LocalCollabCancel;
  private stateValue: LocalCollabJoinState = {
    status: 'connecting',
    generation: null,
    ownerHolderId: null,
  };
  private controllerValue: CollabController | null = null;
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
    const fileId = localCollabFileId(path);
    if (fileId === null) return null;
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
      send: (payload) => this.post({ kind: 'collab', generation, payload }),
      selfClientId: this.options.holderId,
      selfLabel: this.options.selfLabel,
      selfColor: this.options.selfColor,
      // Only the hub whose generation we joined may linearize steps.
      isAuthorityDevice: (deviceId) => deviceId === ownerHolderId,
    });
    this.patchState({ status: 'live', generation, ownerHolderId });
  }

  private becomeDisconnected(): void {
    this.controllerValue = null;
    this.dropAllSeedWaiters();
    this.patchState({ status: 'connecting', generation: null, ownerHolderId: null });
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
        const fileId = localCollabFileId(body.path);
        if (fileId === null) return;
        this.resolveSeed(body.path, {
          fileId,
          epoch: localEpochFor(fileId),
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
