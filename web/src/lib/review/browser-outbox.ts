import { buildAdmissionHeader, buildAdmissionHeaderV3 } from './browser-crypto';
import { mintBrowserPowInWorker } from './browser-pow';
import type { MailboxEnvelope } from './browser-ws';

export const BROWSER_OUTBOX_BATCH_SIZE = 32;
export const BROWSER_OUTBOX_BACKOFF_INITIAL_MS = 1_000;
/** Terminal-error re-probe cadence (attn-c38z): first retry after 30s,
 *  doubling to a 5-minute ceiling. */
export const BROWSER_OUTBOX_TERMINAL_REPROBE_INITIAL_MS = 30_000;
export const BROWSER_OUTBOX_TERMINAL_REPROBE_MAX_MS = 300_000;
export const BROWSER_OUTBOX_BACKOFF_MAX_MS = 60_000;

export interface BrowserOutboxState {
  pendingCount: number;
  sending: boolean;
  lastError: string | null;
  terminal: boolean;
}

export interface BrowserOutboxFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface BrowserOutboxResponse {
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export interface BrowserOutboxOnlineTarget {
  addEventListener?(type: 'online', listener: () => void): void;
  removeEventListener?(type: 'online', listener: () => void): void;
}

export interface BrowserOutboxOptions {
  relayUrl: string;
  roomId: string;
  deviceId: string;
  admissionKey: Uint8Array;
  protocolVersion?: 2 | 3;
  powBits: number;
  maxEventBytes: number;
  /** Relay policy cap for `snapshot_blob`; defaults to maxEventBytes. */
  maxSnapshotBytes?: number;
  fetchImpl?: (url: string, init: BrowserOutboxFetchInit) => Promise<BrowserOutboxResponse>;
  mintPow?: (
    input: { roomId: string; deviceId: string; method: 'POST'; path: string; difficulty: number },
    signal: AbortSignal,
  ) => Promise<string>;
  now?: () => number;
  onState?: (state: BrowserOutboxState) => void;
  onTerminal?: (error: BrowserOutboxError) => void;
  /** Test seam: initial delay for the terminal-error re-probe (attn-c38z). */
  terminalReprobeInitialMs?: number;
  /** Best-effort hook after relay acknowledgement and durable queue removal. */
  onAccepted?: (batch: readonly MailboxEnvelope[]) => void;
  onlineTarget?: BrowserOutboxOnlineTarget;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Optional exact-ciphertext durability used only after explicit remember. */
  persistence?: BrowserOutboxPersistence;
}

export interface BrowserOutboxAccepted {
  envelopeId: string;
  serverSeq: number;
}

export interface BrowserOutboxPersistence {
  loadPending(): Promise<MailboxEnvelope[]>;
  putPending(envelope: MailboxEnvelope): Promise<void>;
  putPendingBatch(envelopes: readonly MailboxEnvelope[]): Promise<void>;
  acknowledge(batch: MailboxEnvelope[], accepted: BrowserOutboxAccepted[]): Promise<void>;
}

export class BrowserOutboxError extends Error {
  readonly code: string;
  readonly terminal: boolean;
  readonly retryAfterMs?: number;

  constructor(code: string, message: string, terminal: boolean, retryAfterMs?: number) {
    super(message);
    this.name = 'BrowserOutboxError';
    this.code = code;
    this.terminal = terminal;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Sealed-envelope outbox; persistence is opt-in through `BrowserOutboxPersistence`. */
export class BrowserOutbox {
  private readonly opts: BrowserOutboxOptions;
  private powBits: number;
  private maxEventBytes: number;
  private maxSnapshotBytes: number;
  private readonly queue: MailboxEnvelope[] = [];
  private readonly activeBatchIds = new Set<string>();
  private closed = false;
  private inFlight: Promise<void> | null = null;
  private persistenceTransition: Promise<void> | null = null;
  private requestAbort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-probe timer for TERMINAL errors (attn-c38z): "terminal" can be
   *  environmental — a relay upgraded mid-session started accepting the
   *  same batch it rejected minutes earlier, but the paused outbox held
   *  the writer lease hostage until a manual Retry or a full reload of
   *  exactly the leader tab. One capped probe (30s → 5min) breaks that
   *  dead end; genuinely-dead rooms just fail the probe again. */
  private terminalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalBackoffMs: number;
  private backoffMs: number;
  private readonly maxBackoffMs: number;
  private persistence: BrowserOutboxPersistence | null;
  private initialized = false;
  private state: BrowserOutboxState = {
    pendingCount: 0,
    sending: false,
    lastError: null,
    terminal: false,
  };
  private readonly onlineHandler = (): void => {
    void this.flushNow().catch(() => undefined);
  };

  constructor(opts: BrowserOutboxOptions) {
    if (opts.admissionKey.length !== 32) throw new Error('admissionKey must be 32 bytes');
    if (!Number.isInteger(opts.powBits) || opts.powBits < 12 || opts.powBits > 24) {
      throw new Error('powBits must be an integer in [12, 24]');
    }
    if (!Number.isSafeInteger(opts.maxEventBytes) || opts.maxEventBytes <= 0) {
      throw new Error('maxEventBytes must be a positive safe integer');
    }
    if (
      opts.maxSnapshotBytes !== undefined &&
      (!Number.isSafeInteger(opts.maxSnapshotBytes) || opts.maxSnapshotBytes <= 0)
    ) {
      throw new Error('maxSnapshotBytes must be a positive safe integer');
    }
    this.opts = opts;
    this.powBits = opts.powBits;
    this.maxEventBytes = opts.maxEventBytes;
    this.maxSnapshotBytes = opts.maxSnapshotBytes ?? opts.maxEventBytes;
    this.backoffMs = opts.backoffInitialMs ?? BROWSER_OUTBOX_BACKOFF_INITIAL_MS;
    this.terminalBackoffMs = opts.terminalReprobeInitialMs ?? BROWSER_OUTBOX_TERMINAL_REPROBE_INITIAL_MS;
    this.maxBackoffMs = opts.backoffMaxMs ?? BROWSER_OUTBOX_BACKOFF_MAX_MS;
    this.persistence = opts.persistence ?? null;
    opts.onlineTarget?.addEventListener?.('online', this.onlineHandler);
  }

  /** Load exact sealed pending envelopes before authoring or flushing. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.persistence) return;
    const stored = await this.persistence.loadPending();
    for (const envelope of stored) this.enqueueMemory(envelope);
    this.publish({ pendingCount: this.queue.length });
  }

  /**
   * Turn an already-running invite-only queue into a remembered-room queue.
   * The adapter becomes authoritative before the first await. Envelopes
   * authored during migration therefore take the durable path; the bounded
   * queue scan also catches anything appended between individual writes.
   */
  async enablePersistence(persistence: BrowserOutboxPersistence): Promise<void> {
    if (this.persistenceTransition) await this.persistenceTransition;
    if (this.persistence === persistence) return;
    if (this.persistence) throw new Error('outbox persistence is already configured');
    const transition = this.enablePersistenceAfterDrain(persistence);
    this.persistenceTransition = transition;
    try {
      await transition;
    } finally {
      if (this.persistenceTransition === transition) this.persistenceTransition = null;
    }
  }

  private async enablePersistenceAfterDrain(persistence: BrowserOutboxPersistence): Promise<void> {
    if (this.persistence === persistence) return;
    if (this.persistence) throw new Error('outbox persistence is already configured');
    // A batch already accepted by the relay must finish its memory-only drain
    // before the durable adapter becomes visible. Otherwise acknowledge()
    // could run against pending rows that migration has not written yet.
    await this.inFlight?.catch(() => undefined);
    this.persistence = persistence;
    this.initialized = true;
    try {
      for (let index = 0; index < this.queue.length; index += 1) {
        await persistence.putPending(this.queue[index]!);
      }
      const stored = await persistence.loadPending();
      for (const envelope of stored) this.enqueueMemory(envelope);
      this.publish({ pendingCount: this.queue.length });
    } catch (error) {
      if (this.persistence === persistence) this.persistence = null;
      throw error;
    }
  }

  /** Stop future durable writes while retaining the live in-memory queue. */
  disablePersistence(): void {
    this.persistence = null;
  }

  getState(): BrowserOutboxState {
    return { ...this.state };
  }

  /** Test/UI inspection surface. Values are sealed; no event plaintext is retained. */
  pendingEnvelopes(): readonly MailboxEnvelope[] {
    return this.queue;
  }

  /** Apply an authenticated relay policy update without rebuilding the queue. */
  updatePolicy(policy: { powBits: number; maxEventBytes: number; maxSnapshotBytes?: number }): void {
    if (!Number.isInteger(policy.powBits) || policy.powBits < 12 || policy.powBits > 24) {
      throw new Error('powBits must be an integer in [12, 24]');
    }
    if (!Number.isSafeInteger(policy.maxEventBytes) || policy.maxEventBytes <= 0) {
      throw new Error('maxEventBytes must be a positive safe integer');
    }
    if (
      policy.maxSnapshotBytes !== undefined &&
      (!Number.isSafeInteger(policy.maxSnapshotBytes) || policy.maxSnapshotBytes <= 0)
    ) {
      throw new Error('maxSnapshotBytes must be a positive safe integer');
    }
    this.powBits = policy.powBits;
    this.maxEventBytes = policy.maxEventBytes;
    if (policy.maxSnapshotBytes !== undefined) this.maxSnapshotBytes = policy.maxSnapshotBytes;
    for (const envelope of this.queue) this.validateEnvelope(envelope);
  }

  enqueue(envelope: MailboxEnvelope): boolean {
    if (this.persistence) {
      throw new Error('remembered-room outbox requires enqueueDurably()');
    }
    return this.enqueueMemory(envelope);
  }

  /**
   * Keep at most one unsent cursor/view sample behind the active request.
   * This is intentionally memory-only: the relay replaces the sample per
   * device and neither browser storage nor a network outage may turn it into
   * an append-only presence history.
   */
  enqueueReplaceablePresence(envelope: MailboxEnvelope): boolean {
    if (this.persistence) {
      throw new Error('replaceable presence requires a memory-only outbox');
    }
    if (
      envelope.kind !== 'signal' ||
      envelope.signalClass !== 'presence' ||
      envelope.target !== null
    ) {
      throw new Error('replaceable presence must be a broadcast presence signal');
    }
    if (this.closed) throw new Error('outbox is closed');
    this.validateEnvelope(envelope);
    const duplicate = this.queue.find((item) => item.envelopeId === envelope.envelopeId);
    if (duplicate) return this.sameOrConflict(duplicate, envelope);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index]!;
      if (
        !this.activeBatchIds.has(queued.envelopeId) &&
        queued.kind === 'signal' &&
        queued.signalClass === 'presence' &&
        queued.deviceId === envelope.deviceId
      ) {
        this.queue[index] = Object.freeze({ ...envelope });
        this.publish({ lastError: null, terminal: false });
        return true;
      }
    }
    return this.enqueueMemory(envelope);
  }

  /** Persist the immutable sealed envelope before optimistic UI echo. */
  async enqueueDurably(envelope: MailboxEnvelope): Promise<boolean> {
    return (await this.enqueueBatchDurably([envelope])) === 1;
  }

  /** Validate and persist the whole immutable batch before exposing any item in memory. */
  async enqueueBatchDurably(envelopes: readonly MailboxEnvelope[]): Promise<number> {
    if (this.closed) throw new Error('outbox is closed');
    if (!this.initialized) await this.initialize();
    const batchIds = new Set<string>();
    for (const envelope of envelopes) {
      this.validateEnvelope(envelope);
      if (batchIds.has(envelope.envelopeId)) {
        throw new BrowserOutboxError(
          'ATTN_ENVELOPE_ID_CONFLICT',
          'durable batch contains a duplicate envelope id',
          true,
        );
      }
      batchIds.add(envelope.envelopeId);
      const existing = this.queue.find((item) => item.envelopeId === envelope.envelopeId);
      if (existing) this.sameOrConflict(existing, envelope);
    }
    await this.persistence?.putPendingBatch(envelopes);
    let inserted = 0;
    for (const envelope of envelopes) {
      if (this.enqueueMemory(envelope)) inserted += 1;
    }
    return inserted;
  }

  private enqueueMemory(envelope: MailboxEnvelope): boolean {
    if (this.closed) throw new Error('outbox is closed');
    this.validateEnvelope(envelope);
    const existing = this.queue.find((item) => item.envelopeId === envelope.envelopeId);
    if (existing) return this.sameOrConflict(existing, envelope);
    this.queue.push(Object.freeze({ ...envelope }));
    this.publish({ pendingCount: this.queue.length, lastError: null, terminal: false });
    return true;
  }

  private sameOrConflict(existing: MailboxEnvelope, envelope: MailboxEnvelope): false {
    if (JSON.stringify(existing) !== JSON.stringify(envelope)) {
      throw new BrowserOutboxError(
        'ATTN_ENVELOPE_ID_CONFLICT',
        'envelope id is already queued with different sealed fields',
        true,
      );
    }
    return false;
  }

  async flushNow(): Promise<void> {
    if (!this.initialized) await this.initialize();
    await this.persistenceTransition;
    if (this.closed || this.state.terminal || this.queue.length === 0) return;
    if (this.inFlight) {
      // A finishing drain may have taken its final queue-empty check before
      // this caller's envelopes were enqueued (its promise is registered
      // until the trailing `finally`). Joining it alone would report success
      // while those envelopes sit unsent — the startup share-republish
      // resume then failed its acknowledgment gate and paused the authority
      // (attn-w22). Join, then re-check the queue with a fresh flush; the
      // previous drain's failure belongs to its own callers.
      await this.inFlight.catch(() => undefined);
      return this.flushNow();
    }
    this.clearRetry();
    this.publish({ sending: true });
    const run = this.drain()
      .catch((error: unknown) => {
        const classified = classifyThrown(error);
        this.publish({ lastError: classified.message, terminal: classified.terminal });
        if (classified.terminal) {
          this.opts.onTerminal?.(classified);
          this.scheduleTerminalReprobe();
        } else if (!this.closed) {
          this.scheduleRetry(classified.retryAfterMs);
        }
        throw classified;
      })
      .finally(() => {
        this.inFlight = null;
        this.publish({ sending: false });
      });
    this.inFlight = run;
    return run;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.onlineTarget?.removeEventListener?.('online', this.onlineHandler);
    this.clearRetry();
    if (this.terminalRetryTimer !== null) {
      clearTimeout(this.terminalRetryTimer);
      this.terminalRetryTimer = null;
    }
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.queue.length = 0;
    this.publish({ pendingCount: 0, sending: false, lastError: null, terminal: false });
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length > 0) {
      const batch = this.queue.slice(0, BROWSER_OUTBOX_BATCH_SIZE);
      for (const envelope of batch) this.activeBatchIds.add(envelope.envelopeId);
      let accepted: BrowserOutboxAccepted[];
      try {
        accepted = await this.sendBatch(batch);
        await this.persistence?.acknowledge(batch, accepted);
      } finally {
        for (const envelope of batch) this.activeBatchIds.delete(envelope.envelopeId);
      }
      const acknowledged = new Set(batch.map((item) => item.envelopeId));
      while (this.queue[0] && acknowledged.has(this.queue[0]!.envelopeId)) this.queue.shift();
      try {
        this.opts.onAccepted?.(batch);
      } catch {
        // Direct transport is opportunistic; mailbox acknowledgement wins.
      }
      this.backoffMs = this.opts.backoffInitialMs ?? BROWSER_OUTBOX_BACKOFF_INITIAL_MS;
      this.terminalBackoffMs =
        this.opts.terminalReprobeInitialMs ?? BROWSER_OUTBOX_TERMINAL_REPROBE_INITIAL_MS;
      this.publish({ pendingCount: this.queue.length, lastError: null, terminal: false });
    }
  }

  private async sendBatch(batch: MailboxEnvelope[]): Promise<BrowserOutboxAccepted[]> {
    const wire = batch.map(toRelayEnvelope);
    const body = JSON.stringify({ envelopes: wire });
    const bodyBytes = new TextEncoder().encode(body);
    try {
      const first = await this.postAttempt(body, bodyBytes);
      if (first.powInvalid) {
        const second = await this.postAttempt(body, bodyBytes);
        if (second.powInvalid) {
          throw new BrowserOutboxError(
            'ATTN_POW_INVALID',
            'relay rejected two freshly minted PoW tokens',
            false,
          );
        }
        return validateAcknowledgements(second.accepted, batch);
      }
      return validateAcknowledgements(first.accepted, batch);
    } finally {
      bodyBytes.fill(0);
    }
  }

  private async postAttempt(
    body: string,
    bodyBytes: Uint8Array,
  ): Promise<{ powInvalid: boolean; accepted: unknown }> {
    const version = this.opts.protocolVersion ?? 2;
    const path = `/v${version}/rooms/${this.opts.roomId}/envelopes`;
    const admission = version === 3
      ? buildAdmissionHeaderV3(this.opts.admissionKey, 'write', 'POST', path, bodyBytes)
      : buildAdmissionHeader(this.opts.admissionKey, 'POST', path, bodyBytes);
    this.requestAbort = new AbortController();
    const signal = this.requestAbort.signal;
    const mint =
      this.opts.mintPow ??
      ((input, abortSignal) => mintBrowserPowInWorker(input, { signal: abortSignal }));
    try {
      const pow = await mint(
        {
          roomId: this.opts.roomId,
          deviceId: this.opts.deviceId,
          method: 'POST',
          path,
          difficulty: this.powBits,
        },
        signal,
      );
      const response = await this.fetchImpl()(`${this.opts.relayUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Attn-Admission': admission,
          'Attn-PoW': pow,
        },
        body,
        signal,
      });
      const raw = await response.text();
      const parsed = safeJson(raw);
      if (response.status === 200 || response.status === 201) {
        return {
          powInvalid: false,
          accepted: (parsed as { accepted?: unknown } | null)?.accepted,
        };
      }
      const errorBody = parseRelayError(parsed);
      if (response.status === 400 && errorBody.code === 'ATTN_POW_INVALID') {
        return { powInvalid: true, accepted: null };
      }
      if (response.status === 429) {
        const header = response.headers?.get('Retry-After');
        const headerSeconds = header === null || header === undefined ? Number.NaN : Number(header);
        const requestedDelay =
          errorBody.retryAfterMs ??
          (Number.isFinite(headerSeconds) && headerSeconds >= 0
            ? headerSeconds * 1_000
            : this.backoffMs);
        const retryAfterMs = Math.max(
          this.opts.backoffInitialMs ?? BROWSER_OUTBOX_BACKOFF_INITIAL_MS,
          Math.min(requestedDelay, this.maxBackoffMs),
        );
        throw new BrowserOutboxError(errorBody.code, errorBody.message, false, retryAfterMs);
      }
      const terminal =
        response.status === 401 ||
        response.status === 404 ||
        response.status === 410 ||
        response.status === 413 ||
        response.status === 507 ||
        (response.status === 400 && errorBody.code !== 'ATTN_POW_INVALID');
      throw new BrowserOutboxError(
        errorBody.code || `HTTP_${response.status}`,
        errorBody.message || `relay rejected envelope batch (${response.status})`,
        terminal,
      );
    } finally {
      this.requestAbort = null;
    }
  }

  private fetchImpl(): BrowserOutboxOptions['fetchImpl'] & ((url: string, init: BrowserOutboxFetchInit) => Promise<BrowserOutboxResponse>) {
    if (this.opts.fetchImpl) return this.opts.fetchImpl;
    return async (url, init) => {
      const response = await fetch(url, init);
      return response;
    };
  }

  private validateEnvelope(envelope: MailboxEnvelope): void {
    if (
      envelope.kind !== 'event' &&
      envelope.kind !== 'signal' &&
      envelope.kind !== 'snapshot_blob'
    ) {
      throw new Error('browser outbox received an unsupported envelope kind');
    }
    if (envelope.roomId !== this.opts.roomId) throw new Error('envelope room does not match outbox');
    if (envelope.deviceId !== this.opts.deviceId) throw new Error('envelope device does not match outbox');
    const maxBytes = envelope.kind === 'snapshot_blob' ? this.maxSnapshotBytes : this.maxEventBytes;
    if (envelope.ciphertextBytes > maxBytes) {
      throw new BrowserOutboxError(
        'ATTN_ENVELOPE_TOO_LARGE',
        `encrypted ${envelope.kind} is ${envelope.ciphertextBytes} bytes; room limit is ${maxBytes}`,
        true,
      );
    }
    if (envelope.expiresAt <= (this.opts.now?.() ?? Date.now())) {
      throw new BrowserOutboxError('ATTN_ROOM_EXPIRED', 'room has expired', true);
    }
  }

  private scheduleRetry(delay?: number): void {
    if (this.retryTimer || this.closed) return;
    const wait = delay ?? this.backoffMs;
    if (delay === undefined) this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushNow().catch(() => undefined);
    }, Math.max(0, wait));
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleTerminalReprobe(): void {
    if (this.terminalRetryTimer || this.closed || this.queue.length === 0) return;
    const wait = this.terminalBackoffMs;
    this.terminalBackoffMs = Math.min(
      this.terminalBackoffMs * 2,
      BROWSER_OUTBOX_TERMINAL_REPROBE_MAX_MS,
    );
    this.terminalRetryTimer = setTimeout(() => {
      this.terminalRetryTimer = null;
      if (this.closed) return;
      // Lift the terminal latch for ONE attempt; a repeat terminal failure
      // re-enters through the flush catch and reschedules with the doubled
      // backoff. The lastError stays visible until a batch actually lands.
      this.publish({ terminal: false });
      void this.flushNow().catch(() => undefined);
    }, wait);
  }

  private publish(patch: Partial<BrowserOutboxState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState?.({ ...this.state });
  }
}

function toRelayEnvelope(envelope: MailboxEnvelope): Record<string, unknown> {
  return {
    envelopeId: envelope.envelopeId,
    authorId: envelope.authorId,
    deviceId: envelope.deviceId,
    kind: envelope.kind,
    ...(envelope.target === undefined ? {} : { target: envelope.target }),
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    ciphertextBytes: envelope.ciphertextBytes,
    ...(envelope.signalGeneration === undefined ? {} : { signalGeneration: envelope.signalGeneration }),
    ...(envelope.signalClass === undefined ? {} : { signalClass: envelope.signalClass }),
    ...(envelope.deviceSignature === undefined ? {} : { deviceSignature: envelope.deviceSignature }),
  };
}

function validateAcknowledgements(
  accepted: unknown,
  batch: MailboxEnvelope[],
): BrowserOutboxAccepted[] {
  if (!Array.isArray(accepted)) throw transientProtocolError('relay response omitted accepted list');
  const expected = new Set(batch.map((item) => item.envelopeId));
  const seen = new Set<string>();
  const parsed: BrowserOutboxAccepted[] = [];
  for (const item of accepted) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { envelopeId?: unknown }).envelopeId !== 'string' ||
      !Number.isSafeInteger((item as { serverSeq?: unknown }).serverSeq)
    ) {
      throw transientProtocolError('relay returned a malformed acknowledgement');
    }
    const id = (item as { envelopeId: string }).envelopeId;
    if (!expected.has(id) || seen.has(id)) {
      throw transientProtocolError('relay returned unexpected or duplicate acknowledgements');
    }
    seen.add(id);
    parsed.push({
      envelopeId: id,
      serverSeq: (item as { serverSeq: number }).serverSeq,
    });
  }
  if (seen.size !== expected.size) {
    throw transientProtocolError('relay returned a partial acknowledgement set');
  }
  return parsed;
}

function transientProtocolError(message: string): BrowserOutboxError {
  return new BrowserOutboxError('ATTN_RELAY_RESPONSE_INVALID', message, false);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseRelayError(value: unknown): { code: string; message: string; retryAfterMs?: number } {
  const error =
    typeof value === 'object' && value !== null && 'error' in value
      ? (value as { error?: unknown }).error
      : null;
  if (typeof error !== 'object' || error === null) return { code: '', message: '' };
  const record = error as { code?: unknown; message?: unknown; retryAfterMs?: unknown };
  return {
    code: typeof record.code === 'string' ? record.code : '',
    message: typeof record.message === 'string' ? record.message : '',
    ...(Number.isSafeInteger(record.retryAfterMs)
      ? { retryAfterMs: record.retryAfterMs as number }
      : {}),
  };
}

function classifyThrown(error: unknown): BrowserOutboxError {
  if (error instanceof BrowserOutboxError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new BrowserOutboxError('ATTN_OUTBOX_ABORTED', 'outbox request was cancelled', false);
  }
  return new BrowserOutboxError(
    'ATTN_NETWORK',
    error instanceof Error ? error.message : String(error),
    false,
  );
}
