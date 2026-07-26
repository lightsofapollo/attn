import {
  BrowserOutbox,
  type BrowserOutboxAccepted,
  type BrowserOutboxPersistence,
  type BrowserOutboxResponse,
} from './browser-outbox';
import type { MailboxEnvelope } from './browser-ws';

const ROOM = 'room-outbox-test';
const DEVICE = 'device-outbox-test';
const NOW = 1_700_000_000_000;

let passed = 0;
const failures: string[] = [];
const cases: Array<{ name: string; run: () => Promise<void> }> = [];

function test(name: string, run: () => Promise<void>): void {
  cases.push({ name, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function envelope(id: string): MailboxEnvelope {
  return {
    v: 2,
    roomId: ROOM,
    envelopeId: id,
    authorId: 'participant-outbox-test',
    deviceId: DEVICE,
    kind: 'event',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ciphertext: 'AQ',
    ciphertextBytes: 1,
  };
}

function presenceEnvelope(id: string): MailboxEnvelope {
  return {
    ...envelope(id),
    kind: 'signal',
    target: null,
    signalGeneration: NOW,
    signalClass: 'presence',
    deviceSignature: 'device-signature',
  };
}

function response(status: number, body: unknown): BrowserOutboxResponse {
  return { status, text: async () => JSON.stringify(body) };
}

function acceptedFromBody(body: string): BrowserOutboxResponse {
  const parsed = JSON.parse(body) as { envelopes: Array<{ envelopeId: string }> };
  return response(201, {
    accepted: parsed.envelopes.map((item, index) => ({
      envelopeId: item.envelopeId,
      serverSeq: index + 1,
    })),
  });
}

function makeOutbox(
  fetchImpl: ConstructorParameters<typeof BrowserOutbox>[0]['fetchImpl'],
  powTokens: string[],
): BrowserOutbox {
  return new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x42),
    powBits: 12,
    maxEventBytes: 1024,
    now: () => NOW,
    fetchImpl,
    mintPow: async () => `pow-${powTokens.push('mint')}`,
    backoffInitialMs: 60_000,
    backoffMaxMs: 60_000,
  });
}

test('snapshot_blob validates against maxSnapshotBytes, not the event cap', async () => {
  // Regression: the session dropped policy.maxSnapshotBytes when building
  // the outbox, so the snapshot fell back to the 256 KiB event cap and any
  // document over ~256 KiB paused live review with ATTN_ENVELOPE_TOO_LARGE
  // despite the relay's 5 MiB snapshot cap.
  const outbox = new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x42),
    powBits: 12,
    maxEventBytes: 1024,
    maxSnapshotBytes: 5 * 1024 * 1024,
    now: () => NOW,
    fetchImpl: async () => response(201, { accepted: [] }),
    mintPow: async () => 'pow-snapshot-cap',
    backoffInitialMs: 60_000,
    backoffMaxMs: 60_000,
  });
  const big: MailboxEnvelope = {
    ...envelope('snapshot-big'),
    kind: 'snapshot_blob',
    ciphertextBytes: 300_000,
  };
  assert(outbox.enqueue(big), 'snapshot over the event cap but under the snapshot cap must enqueue');
  const overCap: MailboxEnvelope = {
    ...envelope('snapshot-over'),
    kind: 'snapshot_blob',
    ciphertextBytes: 5 * 1024 * 1024 + 1,
  };
  let rejected = false;
  try {
    outbox.enqueue(overCap);
  } catch (error) {
    rejected = true;
    assert(
      error instanceof Error && error.message.includes('room limit is 5242880'),
      'over-cap snapshot must report the snapshot cap, not the event cap',
    );
  }
  assert(rejected, 'snapshot over the snapshot cap must be rejected');
  const event: MailboxEnvelope = { ...envelope('event-big'), ciphertextBytes: 2048 };
  let eventRejected = false;
  try {
    outbox.enqueue(event);
  } catch {
    eventRejected = true;
  }
  assert(eventRejected, 'events must still validate against maxEventBytes');
  outbox.close();
});

test('replaceable presence keeps only the latest sample behind an active request', async () => {
  const posted: string[][] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const outbox = makeOutbox(async (_url, init) => {
    const parsed = JSON.parse(init.body) as { envelopes: Array<{ envelopeId: string }> };
    posted.push(parsed.envelopes.map((item) => item.envelopeId));
    if (posted.length === 1) await firstPending;
    return acceptedFromBody(init.body);
  }, []);
  try {
    outbox.enqueueReplaceablePresence(presenceEnvelope('presence-1'));
    const flushing = outbox.flushNow();
    for (let index = 0; index < 20 && posted.length === 0; index += 1) await Promise.resolve();
    outbox.enqueueReplaceablePresence(presenceEnvelope('presence-2'));
    outbox.enqueueReplaceablePresence(presenceEnvelope('presence-3'));
    equal(
      outbox.pendingEnvelopes().map((item) => item.envelopeId),
      ['presence-1', 'presence-3'],
      'presence queue while first sample is active',
    );
    releaseFirst();
    await flushing;
    equal(posted, [['presence-1'], ['presence-3']], 'relay presence batches');
    equal(outbox.pendingEnvelopes(), [], 'presence queue drained');
  } finally {
    releaseFirst();
    outbox.close();
  }
});

test('v3 outbox uses write-scoped admission and v3 route', async () => {
  let requestUrl = '';
  let admission = '';
  const outbox = new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x43),
    protocolVersion: 3,
    powBits: 12,
    maxEventBytes: 1024,
    now: () => NOW,
    fetchImpl: async (url, init) => {
      requestUrl = url;
      admission = init.headers['Attn-Admission']!;
      return acceptedFromBody(init.body);
    },
    mintPow: async () => 'pow-v3',
  });
  try {
    outbox.enqueue(envelope('env-v3'));
    await outbox.flushNow();
    assert(requestUrl.endsWith(`/v3/rooms/${ROOM}/envelopes`), 'v3 envelope path');
    assert(admission.startsWith('v3.write.'), 'write-scoped admission');
  } finally {
    outbox.close();
  }
});

test('ambiguous network failure retains exact sealed body and remints PoW', async () => {
  const bodies: string[] = [];
  const pows: string[] = [];
  let attempts = 0;
  const outbox = makeOutbox(async (_url, init) => {
    attempts += 1;
    bodies.push(init.body);
    pows.push(init.headers['Attn-PoW']!);
    if (attempts === 1) throw new Error('connection reset after upload');
    return acceptedFromBody(init.body);
  }, []);
  try {
    outbox.enqueue(envelope('env-retry'));
    await outbox.flushNow().catch(() => undefined);
    equal(outbox.getState().pendingCount, 1, 'retained after ambiguous failure');
    await outbox.flushNow();
    equal(outbox.getState().pendingCount, 0, 'removed after acknowledgement');
    equal(bodies[0], bodies[1], 'request body is byte-identical');
    assert(pows[0] !== pows[1], 'PoW token must be fresh for retry');
  } finally {
    outbox.close();
  }
});

test('ATTN_POW_INVALID gets one immediate fresh-token retry', async () => {
  const pows: string[] = [];
  let attempts = 0;
  const outbox = makeOutbox(async (_url, init) => {
    attempts += 1;
    pows.push(init.headers['Attn-PoW']!);
    if (attempts === 1) {
      return response(400, { error: { code: 'ATTN_POW_INVALID', message: 'stale' } });
    }
    return acceptedFromBody(init.body);
  }, []);
  try {
    outbox.enqueue(envelope('env-pow'));
    await outbox.flushNow();
    equal(attempts, 2, 'attempt count');
    assert(pows[0] !== pows[1], 'PoW token changes');
    equal(outbox.getState().pendingCount, 0, 'acked');
  } finally {
    outbox.close();
  }
});

test('malformed partial acknowledgements retain the whole batch', async () => {
  const outbox = makeOutbox(
    async () => response(201, { accepted: [{ envelopeId: 'env-a', serverSeq: 1 }] }),
    [],
  );
  try {
    outbox.enqueue(envelope('env-a'));
    outbox.enqueue(envelope('env-b'));
    await outbox.flushNow().catch(() => undefined);
    equal(outbox.getState().pendingCount, 2, 'whole batch retained');
    equal(outbox.getState().terminal, false, 'protocol response can retry');
  } finally {
    outbox.close();
  }
});

test('33 envelopes are sent as batches of 32 and 1', async () => {
  const sizes: number[] = [];
  const outbox = makeOutbox(async (_url, init) => {
    const parsed = JSON.parse(init.body) as { envelopes: unknown[] };
    sizes.push(parsed.envelopes.length);
    return acceptedFromBody(init.body);
  }, []);
  try {
    for (let i = 0; i < 33; i++) outbox.enqueue(envelope(`env-${i}`));
    await outbox.flushNow();
    equal(sizes, [32, 1], 'batch sizes');
    equal(outbox.getState().pendingCount, 0, 'all acknowledged');
  } finally {
    outbox.close();
  }
});

test('duplicate enqueue is idempotent but conflicting reuse is rejected', async () => {
  const outbox = makeOutbox(async (_url, init) => acceptedFromBody(init.body), []);
  try {
    equal(outbox.enqueue(envelope('env-dedupe')), true, 'first enqueue');
    equal(outbox.enqueue(envelope('env-dedupe')), false, 'identical duplicate');
    let rejected = false;
    try {
      outbox.enqueue({ ...envelope('env-dedupe'), ciphertext: 'Ag' });
    } catch {
      rejected = true;
    }
    equal(rejected, true, 'conflicting duplicate rejected');
  } finally {
    outbox.close();
  }
});

test('507 storage cap is terminal and does not auto-retry', async () => {
  let attempts = 0;
  let terminalCode = '';
  const outbox = new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x42),
    powBits: 12,
    maxEventBytes: 1024,
    now: () => NOW,
    fetchImpl: async () => {
      attempts += 1;
      return response(507, { error: { code: 'ATTN_ROOM_STORAGE_FULL', message: 'full' } });
    },
    mintPow: async () => 'pow-terminal',
    onTerminal: (error) => { terminalCode = error.code; },
    backoffInitialMs: 10,
    backoffMaxMs: 10,
  });
  try {
    outbox.enqueue(envelope('env-full'));
    await outbox.flushNow().catch(() => undefined);
    await outbox.flushNow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    equal(attempts, 1, 'terminal response ignores explicit and timer retries');
    equal(terminalCode, 'ATTN_ROOM_STORAGE_FULL', 'terminal callback');
    equal(outbox.getState().terminal, true, 'terminal state');
    equal(outbox.getState().pendingCount, 1, 'sealed envelope remains visibly pending');
    equal(outbox.getState().lastError, 'full', 'terminal error remains visible');
  } finally {
    outbox.close();
  }
});

test('429 without Retry-After falls back to bounded backoff', async () => {
  let attempts = 0;
  const outbox = makeOutbox(async () => {
    attempts += 1;
    return {
      status: 429,
      text: async () => JSON.stringify({ error: { code: 'ATTN_RATE_LIMIT', message: 'slow down' } }),
      headers: { get: () => null },
    };
  }, []);
  try {
    outbox.enqueue(envelope('env-rate'));
    await outbox.flushNow().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    equal(attempts, 1, 'missing header does not create an immediate retry loop');
  } finally {
    outbox.close();
  }
});

test('authenticated policy updates change PoW difficulty for the queued envelope', async () => {
  const difficulties: number[] = [];
  const outbox = new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x42),
    powBits: 12,
    maxEventBytes: 1024,
    now: () => NOW,
    fetchImpl: async (_url, init) => acceptedFromBody(init.body),
    mintPow: async (input) => {
      difficulties.push(input.difficulty);
      return 'pow-policy';
    },
  });
  try {
    outbox.enqueue(envelope('env-policy'));
    outbox.updatePolicy({ powBits: 19, maxEventBytes: 1024 });
    await outbox.flushNow();
    equal(difficulties, [19], 'new policy difficulty');
  } finally {
    outbox.close();
  }
});

test('remembered outbox survives reconstruction and removes exact ciphertext only after durable ACK', async () => {
  const pending = new Map<string, MailboxEnvelope>();
  const history = new Map<string, { envelope: MailboxEnvelope; serverSeq: number }>();
  const persistence: BrowserOutboxPersistence = {
    loadPending: async () => [...pending.values()],
    putPending: async (item) => {
      const existing = pending.get(item.envelopeId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
        throw new Error('conflicting durable envelope');
      }
      pending.set(item.envelopeId, structuredClone(item));
    },
    putPendingBatch: async (items) => {
      for (const item of items) {
        const existing = pending.get(item.envelopeId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
          throw new Error('conflicting durable envelope');
        }
      }
      for (const item of items) pending.set(item.envelopeId, structuredClone(item));
    },
    acknowledge: async (batch, accepted: BrowserOutboxAccepted[]) => {
      for (const ack of accepted) {
        const item = batch.find((candidate) => candidate.envelopeId === ack.envelopeId);
        if (!item) throw new Error('ack did not match batch');
        history.set(ack.envelopeId, { envelope: structuredClone(item), serverSeq: ack.serverSeq });
        pending.delete(ack.envelopeId);
      }
    },
  };
  const first = new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x42),
    powBits: 12,
    maxEventBytes: 1024,
    now: () => NOW,
    fetchImpl: async (_url, init) => acceptedFromBody(init.body),
    mintPow: async () => 'pow-first',
    persistence,
  });
  const original = envelope('env-durable-reload');
  await first.initialize();
  await first.enqueueDurably(original);
  equal(pending.get(original.envelopeId), original, 'exact ciphertext committed before close');
  first.close();

  let sentBody = '';
  const resumed = new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x42),
    powBits: 12,
    maxEventBytes: 1024,
    now: () => NOW,
    fetchImpl: async (_url, init) => {
      sentBody = init.body;
      return acceptedFromBody(init.body);
    },
    mintPow: async () => 'pow-resumed',
    persistence,
  });
  try {
    await resumed.initialize();
    equal(resumed.getState().pendingCount, 1, 'sealed queue restored');
    await resumed.flushNow();
    const wire = (JSON.parse(sentBody) as { envelopes: Array<{ ciphertext: string; nonce: string }> }).envelopes[0]!;
    equal(wire.ciphertext, original.ciphertext, 'ciphertext unchanged across reconstruction');
    equal(wire.nonce, original.nonce, 'nonce unchanged across reconstruction');
    equal(pending.size, 0, 'pending row removed after durable ack journal');
    equal(history.get(original.envelopeId)?.envelope, original, 'acked history keeps exact sealed envelope');
  } finally {
    resumed.close();
  }
});

test('envelopes authored while persistence is enabling are durably migrated', async () => {
  const pending = new Map<string, MailboxEnvelope>();
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstBlocked = false;
  const persistence: BrowserOutboxPersistence = {
    loadPending: async () => [...pending.values()],
    putPending: async (item) => {
      if (!firstBlocked && item.envelopeId === 'env-before-enable') {
        firstBlocked = true;
        announceFirst();
        await firstGate;
      }
      pending.set(item.envelopeId, structuredClone(item));
    },
    putPendingBatch: async (items) => {
      for (const item of items) await persistence.putPending(item);
    },
    acknowledge: async () => undefined,
  };
  const outbox = makeOutbox(async (_url, init) => acceptedFromBody(init.body), []);
  try {
    outbox.enqueue(envelope('env-before-enable'));
    const enabling = outbox.enablePersistence(persistence);
    await firstStarted;
    await outbox.enqueueDurably(envelope('env-during-enable'));
    releaseFirst();
    await enabling;
    equal([...pending.keys()].sort(), ['env-before-enable', 'env-during-enable'], 'both envelopes durable');
    equal(outbox.getState().pendingCount, 2, 'both envelopes remain queued');
  } finally {
    releaseFirst();
    outbox.close();
  }
});

test('persistence waits for an already in-flight memory drain before becoming authoritative', async () => {
  let announceFetch!: () => void;
  let releaseFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { announceFetch = resolve; });
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const pending = new Map<string, MailboxEnvelope>();
  let durableAcks = 0;
  const persistence: BrowserOutboxPersistence = {
    loadPending: async () => [...pending.values()],
    putPending: async (item) => { pending.set(item.envelopeId, structuredClone(item)); },
    putPendingBatch: async (items) => {
      for (const item of items) pending.set(item.envelopeId, structuredClone(item));
    },
    acknowledge: async (batch) => {
      durableAcks += 1;
      assert(batch.every((item) => pending.has(item.envelopeId)), 'durable ack requires pending rows');
    },
  };
  const outbox = makeOutbox(async (_url, init) => {
    announceFetch();
    await fetchGate;
    return acceptedFromBody(init.body);
  }, []);
  try {
    outbox.enqueue(envelope('env-in-flight-before-enable'));
    const flushing = outbox.flushNow();
    await fetchStarted;
    const enabling = outbox.enablePersistence(persistence);
    releaseFetch();
    await flushing;
    await enabling;
    equal(durableAcks, 0, 'memory-mode acknowledgement completes before adapter install');
    equal(pending.size, 0, 'accepted envelope is not resurrected during migration');
    equal(outbox.getState().pendingCount, 0, 'accepted queue remains empty');
  } finally {
    releaseFetch();
    outbox.close();
  }
});

test('targeted signal is relay-acked before the opportunistic accepted hook', async () => {
  const order: string[] = [];
  const signal: MailboxEnvelope = {
    ...envelope('signal-accepted'),
    kind: 'signal',
    target: { deviceId: 'remote-device' },
  };
  const outbox = new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x42),
    powBits: 12,
    maxEventBytes: 1024,
    now: () => NOW,
    mintPow: async () => 'pow-signal',
    fetchImpl: async (_url, init) => {
      order.push('relay');
      return acceptedFromBody(init.body);
    },
    onAccepted: (batch) => {
      assert(batch[0]?.kind === 'signal', 'accepted hook received wrong envelope');
      order.push('accepted');
    },
  });
  try {
    outbox.enqueue(signal);
    await outbox.flushNow();
    equal(order, ['relay', 'accepted'], 'mailbox-before-direct ordering');
  } finally {
    outbox.close();
  }
});

test('terminal relay rejection re-probes on capped backoff and heals (attn-c38z)', async () => {
  // Regression: a 400 (e.g. an out-of-date relay rejecting a batch shape it
  // did not understand yet) latched the outbox terminal FOREVER. The paused
  // session kept the writer lease, so no other tab could heal delivery, and
  // late-joining reviewers missed every envelope authored after the latch.
  // Terminal now schedules one capped re-probe; once the relay accepts
  // again (upgraded mid-session), the backlog drains without manual Retry.
  let rejecting = true;
  let terminalSignals = 0;
  const outbox = new BrowserOutbox({
    relayUrl: 'https://relay.example.test',
    roomId: ROOM,
    deviceId: DEVICE,
    admissionKey: new Uint8Array(32).fill(0x42),
    powBits: 12,
    maxEventBytes: 1024,
    now: () => NOW,
    fetchImpl: async (_url, init) => {
      if (rejecting) {
        return response(400, {
          error: { code: 'ATTN_DEVICE_PROOF_INVALID', message: 'device proof fields are v3 signal-only' },
        });
      }
      return acceptedFromBody(String(init.body));
    },
    mintPow: async () => 'pow-terminal-reprobe',
    backoffInitialMs: 60_000,
    backoffMaxMs: 60_000,
    terminalReprobeInitialMs: 40,
    onTerminal: () => {
      terminalSignals += 1;
    },
  });
  try {
    assert(outbox.enqueue(envelope('reprobe-1')), 'enqueue');
    await outbox.flushNow().catch(() => undefined);
    equal(outbox.getState().terminal, true, 'first rejection latches terminal');
    equal(terminalSignals, 1, 'terminal surfaced to the session once');
    equal(outbox.getState().pendingCount, 1, 'envelope stays queued, never dropped');

    // Relay "upgrades" while the session is idle; the re-probe must drain
    // the backlog with no manual retry.
    rejecting = false;
    await new Promise((resolve) => setTimeout(resolve, 160));
    equal(outbox.getState().pendingCount, 0, 're-probe drained the backlog');
    equal(outbox.getState().terminal, false, 'terminal latch cleared after success');
  } finally {
    outbox.close();
  }
});

for (const item of cases) {
  try {
    await item.run();
    passed += 1;
    console.log(`PASS ${item.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push(`${item.name}: ${message}`);
    console.error(`FAIL ${item.name}: ${message}`);
  }
}

console.log(`browser-outbox: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
