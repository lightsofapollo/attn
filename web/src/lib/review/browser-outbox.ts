import { buildAdmissionHeader } from './browser-crypto';
import { mintBrowserPowInWorker } from './browser-pow';
import type { MailboxEnvelope } from './browser-ws';

export const BROWSER_OUTBOX_BATCH_SIZE = 32;
export const BROWSER_OUTBOX_BACKOFF_INITIAL_MS = 1_000;
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
  powBits: number;
  maxEventBytes: number;
  fetchImpl?: (url: string, init: BrowserOutboxFetchInit) => Promise<BrowserOutboxResponse>;
  mintPow?: (
    input: { roomId: string; deviceId: string; method: 'POST'; path: string; difficulty: number },
    signal: AbortSignal,
  ) => Promise<string>;
  now?: () => number;
  onState?: (state: BrowserOutboxState) => void;
  onTerminal?: (error: BrowserOutboxError) => void;
  onlineTarget?: BrowserOutboxOnlineTarget;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
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

/** Memory-only sealed-envelope outbox. Durable storage lands in attn-egi.3. */
export class BrowserOutbox {
  private readonly opts: BrowserOutboxOptions;
  private powBits: number;
  private maxEventBytes: number;
  private readonly queue: MailboxEnvelope[] = [];
  private closed = false;
  private inFlight: Promise<void> | null = null;
  private requestAbort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private readonly maxBackoffMs: number;
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
    this.opts = opts;
    this.powBits = opts.powBits;
    this.maxEventBytes = opts.maxEventBytes;
    this.backoffMs = opts.backoffInitialMs ?? BROWSER_OUTBOX_BACKOFF_INITIAL_MS;
    this.maxBackoffMs = opts.backoffMaxMs ?? BROWSER_OUTBOX_BACKOFF_MAX_MS;
    opts.onlineTarget?.addEventListener?.('online', this.onlineHandler);
  }

  getState(): BrowserOutboxState {
    return { ...this.state };
  }

  /** Test/UI inspection surface. Values are sealed; no event plaintext is retained. */
  pendingEnvelopes(): readonly MailboxEnvelope[] {
    return this.queue;
  }

  /** Apply an authenticated relay policy update without rebuilding the queue. */
  updatePolicy(policy: { powBits: number; maxEventBytes: number }): void {
    if (!Number.isInteger(policy.powBits) || policy.powBits < 12 || policy.powBits > 24) {
      throw new Error('powBits must be an integer in [12, 24]');
    }
    if (!Number.isSafeInteger(policy.maxEventBytes) || policy.maxEventBytes <= 0) {
      throw new Error('maxEventBytes must be a positive safe integer');
    }
    this.powBits = policy.powBits;
    this.maxEventBytes = policy.maxEventBytes;
    for (const envelope of this.queue) this.validateEnvelope(envelope);
  }

  enqueue(envelope: MailboxEnvelope): boolean {
    if (this.closed) throw new Error('outbox is closed');
    this.validateEnvelope(envelope);
    const existing = this.queue.find((item) => item.envelopeId === envelope.envelopeId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(envelope)) {
        throw new BrowserOutboxError(
          'ATTN_ENVELOPE_ID_CONFLICT',
          'envelope id is already queued with different sealed fields',
          true,
        );
      }
      return false;
    }
    this.queue.push(Object.freeze({ ...envelope }));
    this.publish({ pendingCount: this.queue.length, lastError: null, terminal: false });
    return true;
  }

  async flushNow(): Promise<void> {
    if (this.closed || this.state.terminal || this.queue.length === 0) return;
    if (this.inFlight) return this.inFlight;
    this.clearRetry();
    this.publish({ sending: true });
    const run = this.drain()
      .catch((error: unknown) => {
        const classified = classifyThrown(error);
        this.publish({ lastError: classified.message, terminal: classified.terminal });
        if (classified.terminal) {
          this.opts.onTerminal?.(classified);
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
    this.requestAbort?.abort();
    this.requestAbort = null;
    this.queue.length = 0;
    this.publish({ pendingCount: 0, sending: false, lastError: null, terminal: false });
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length > 0) {
      const batch = this.queue.slice(0, BROWSER_OUTBOX_BATCH_SIZE);
      await this.sendBatch(batch);
      const acknowledged = new Set(batch.map((item) => item.envelopeId));
      while (this.queue[0] && acknowledged.has(this.queue[0]!.envelopeId)) this.queue.shift();
      this.backoffMs = this.opts.backoffInitialMs ?? BROWSER_OUTBOX_BACKOFF_INITIAL_MS;
      this.publish({ pendingCount: this.queue.length, lastError: null, terminal: false });
    }
  }

  private async sendBatch(batch: MailboxEnvelope[]): Promise<void> {
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
        validateAcknowledgements(second.accepted, batch);
        return;
      }
      validateAcknowledgements(first.accepted, batch);
    } finally {
      bodyBytes.fill(0);
    }
  }

  private async postAttempt(
    body: string,
    bodyBytes: Uint8Array,
  ): Promise<{ powInvalid: boolean; accepted: unknown }> {
    const path = `/v2/rooms/${this.opts.roomId}/envelopes`;
    const admission = buildAdmissionHeader(this.opts.admissionKey, 'POST', path, bodyBytes);
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
    if (envelope.kind !== 'event') throw new Error('browser outbox only accepts event envelopes');
    if (envelope.roomId !== this.opts.roomId) throw new Error('envelope room does not match outbox');
    if (envelope.deviceId !== this.opts.deviceId) throw new Error('envelope device does not match outbox');
    if (envelope.ciphertextBytes > this.maxEventBytes) {
      throw new BrowserOutboxError(
        'ATTN_ENVELOPE_TOO_LARGE',
        `encrypted event is ${envelope.ciphertextBytes} bytes; room limit is ${this.maxEventBytes}`,
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
  };
}

function validateAcknowledgements(accepted: unknown, batch: MailboxEnvelope[]): void {
  if (!Array.isArray(accepted)) throw transientProtocolError('relay response omitted accepted list');
  const expected = new Set(batch.map((item) => item.envelopeId));
  const seen = new Set<string>();
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
  }
  if (seen.size !== expected.size) {
    throw transientProtocolError('relay returned a partial acknowledgement set');
  }
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
