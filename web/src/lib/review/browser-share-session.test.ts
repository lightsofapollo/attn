import type { Anchor, ReviewEvent, SuggestionDraft } from '../types';
import {
  BrowserShareResolver,
  BrowserShareResolutionError,
  type DecodedDurableShareBundle,
  type DurableRollbackValue,
  type DurableShareRecord,
  type DurableShareRollbackFloor,
} from './browser-share-resolver';
import {
  BrowserShareSession,
  type BrowserShareSessionOptions,
  ShareRoomGoneError,
  StaleShareEpochError,
  type DurableLiveSession,
  type DurableShareOutboxStore,
  type DurableShareOutboxTransition,
  type PersistedShareOutboxEntry,
  type ShareChangeSubscription,
  type ShareMailboxReceipt,
} from './browser-share-session';

const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];
let passed = 0;
function test(name: string, run: () => void | Promise<void>): void { cases.push({ name, run }); }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejects(run: () => Promise<unknown>, includes: string): Promise<void> {
  try { await run(); } catch (error) {
    assert(error instanceof Error && error.message.includes(includes), `wrong rejection: ${String(error)}`); return;
  }
  throw new Error('expected rejection');
}

const SHARE_ID = 'share-id';
const ROOM_ID = 'room-id';
const BUNDLE = 'B'.repeat(22);
const SNAPSHOT_DIGEST = 'S'.repeat(43);
const MANIFEST_A = 'A'.repeat(43);
const MANIFEST_B = 'C'.repeat(43);
const WIRE_HASH = 'W'.repeat(43);
const CAPABILITY_FINGERPRINT = 'F'.repeat(43);
const ANCHOR: Anchor = { v: 2, fileId: 'file-a', snapshotId: 'snapshot-a', baseHash: 'H'.repeat(43),
  position: { byteRange: [0, 1], lineRange: [0, 0] } };
const EVENT = { meta: { eventId: 'event-1' } } as ReviewEvent;

class Floor implements DurableShareRollbackFloor {
  readonly values = new Map<string, DurableRollbackValue>();
  async atomicMax(input: { shareId: string; bundleId: string; candidate: DurableRollbackValue }): Promise<DurableRollbackValue> {
    const key = `${input.shareId}:${input.bundleId}`;
    const old = this.values.get(key);
    if (!old || input.candidate.epoch > old.epoch ||
      (input.candidate.epoch === old.epoch && input.candidate.revision > old.revision)) {
      this.values.set(key, { ...input.candidate });
    }
    return { ...this.values.get(key)! };
  }
}

function record(epoch = 2, revision = 1, currentRoomId?: string): DurableShareRecord {
  return {
    v: 3, shareId: SHARE_ID, bundleId: BUNDLE, epoch, revision,
    ...(currentRoomId === undefined ? {} : { currentRoomId }),
    snapshots: [{ fileId: 'file-a', snapshotId: `snapshot-${epoch}-${revision}`, ciphertextBytes: 3,
      ciphertextSha256: SNAPSHOT_DIGEST, uploadedAt: 10 }],
    selectedBundle: new Uint8Array(40).fill(7), updatedAt: 100, expiresAt: 200,
  };
}
function bundle(epoch = 2, revision = 1, tier: 'view' | 'comment' | 'suggest' = 'comment', digest = MANIFEST_A): DecodedDurableShareBundle {
  return { v: 3, shareId: SHARE_ID, bundleId: BUNDLE, epoch, revision, manifestDigest: digest,
    roomId: ROOM_ID, tier, roomCapability: { read: true },
    ...(tier === 'view' ? {} : { shareMailboxCapability: { write: true } }) };
}

function resolverFor(options: {
  getRecord: () => DurableShareRecord;
  getBundle: () => DecodedDurableShareBundle;
  floor?: Floor;
  manifestDigest?: () => string;
  onResolve?: () => void;
  isRoomLive?: () => boolean | Promise<boolean>;
  digestCiphertext?: () => string;
  decryptSnapshot?: (ref: { fileId: string; snapshotId: string }) => { fileId: string; snapshotId: string; docType: 'markdown' | 'html'; content: string };
  disposeSnapshot?: (snapshot: { content: string }) => void;
}): BrowserShareResolver<unknown> {
  const isRoomLive = options.isRoomLive;
  return new BrowserShareResolver({
    shareId: SHARE_ID, capability: { opaque: true }, rollbackFloor: options.floor ?? new Floor(),
    fetchRecord: async () => { options.onResolve?.(); return options.getRecord(); },
    ...(isRoomLive === undefined ? {} : { isRoomLive: () => isRoomLive() }),
    decodeBundle: () => options.getBundle(), digestManifest: () => options.manifestDigest?.() ?? MANIFEST_A,
    fetchSnapshot: async () => ({ ciphertext: new Uint8Array([1, 2, 3]), ciphertextSha256: SNAPSHOT_DIGEST }),
    digestCiphertext: () => options.digestCiphertext?.() ?? SNAPSHOT_DIGEST,
    decryptSnapshot: ({ ref }) => options.decryptSnapshot?.(ref) ??
      ({ fileId: ref.fileId, snapshotId: ref.snapshotId, docType: 'markdown', content: '# retained' }),
    disposeBundle: () => undefined,
    disposeSnapshot: snapshot => options.disposeSnapshot?.(snapshot),
  });
}

test('durable floor rejects epoch rollback across resolver reloads', async () => {
  const floor = new Floor();
  await resolverFor({ getRecord: () => record(2), getBundle: () => bundle(2), floor }).resolve();
  const reloaded = resolverFor({ getRecord: () => record(1), getBundle: () => bundle(1), floor });
  try { await reloaded.resolve(); throw new Error('accepted rollback'); }
  catch (error) { assert(error instanceof BrowserShareResolutionError && error.code === 'epoch_rollback', 'wrong rollback error'); }
});

test('same-epoch revision/digest rollback is rejected and sealed input is zeroed', async () => {
  const floor = new Floor();
  const first = record(2, 4);
  await resolverFor({ getRecord: () => first, getBundle: () => bundle(2, 4), floor }).resolve();
  assert(first.selectedBundle.every((byte) => byte === 0), 'sealed input was not zeroed');
  const oldRevision = resolverFor({ getRecord: () => record(2, 3), getBundle: () => bundle(2, 3), floor });
  await rejects(() => oldRevision.resolve(), 'revision');
  const conflict = resolverFor({ getRecord: () => record(2, 4), getBundle: () => bundle(2, 4, 'comment', MANIFEST_B),
    manifestDigest: () => MANIFEST_B, floor });
  await rejects(() => conflict.resolve(), 'manifest');
});

test('strict record/bundle output rejects unknown fields and manifest mismatch', async () => {
  const raw = record() as DurableShareRecord & { surprise?: boolean }; raw.surprise = true;
  await rejects(() => resolverFor({ getRecord: () => raw, getBundle: () => bundle() }).resolve(), 'record');
  await rejects(() => resolverFor({ getRecord: () => record(), getBundle: () => bundle(2, 1, 'comment', MANIFEST_B) }).resolve(), 'bundle');
});

test('rollback floor advances only after every snapshot authenticates', async () => {
  const floor = new Floor();
  await rejects(() => resolverFor({ getRecord: () => record(), getBundle: () => bundle(), floor,
    digestCiphertext: () => 'Z'.repeat(43) }).resolve(), 'digest');
  assert(floor.values.size === 0, 'failed snapshot advanced durable rollback floor');
});

test('invalid decrypted snapshot is disposed before resolver rejection', async () => {
  const disposed: string[] = [];
  await rejects(() => resolverFor({ getRecord: () => record(), getBundle: () => bundle(),
    decryptSnapshot: ref => ({ fileId: 'wrong-file', snapshotId: ref.snapshotId, docType: 'markdown', content: 'sensitive' }),
    disposeSnapshot: snapshot => { disposed.push(snapshot.content); } }).resolve(), 'decrypted snapshot');
  assert(disposed.length === 1 && disposed[0] === 'sensitive', 'invalid decrypted snapshot ownership was leaked');
});

class MemoryOutbox implements DurableShareOutboxStore {
  readonly entries = new Map<string, PersistedShareOutboxEntry>();
  disposed = 0;
  failEnqueue = false;
  hydratedCopies: PersistedShareOutboxEntry[] = [];
  async hydrate(shareId: string, bundleId: string): Promise<PersistedShareOutboxEntry[]> {
    this.hydratedCopies = [...this.entries.values()].filter((item) => item.shareId === shareId && item.bundleId === bundleId).map(copyEntry);
    return this.hydratedCopies;
  }
  async transition(_shareId: string, _bundleId: string, transition: DurableShareOutboxTransition): Promise<void> {
    if (this.failEnqueue && transition.kind === 'enqueue') throw new Error('persistence failed');
    if (transition.kind === 'enqueue') this.entries.set(transition.record.envelopeId, copyEntry(transition.record));
    else if (transition.kind === 'retry_stale') {
      this.entries.delete(`stale:${transition.draftId}`);
      this.entries.set(transition.record.envelopeId, copyEntry(transition.record));
    }
    else if (transition.kind === 'remove_stale') this.entries.delete(`stale:${transition.draftId}`);
    else {
      const current = this.entries.get(transition.envelopeId);
      assert(current?.state !== 'stale' && current?.wireHash === transition.expectedWireHash, 'atomic transition precondition failed');
      if (transition.kind === 'ack') this.entries.delete(transition.envelopeId);
      else if (transition.kind === 'retryable') this.entries.set(transition.envelopeId, { ...current, state: 'retryable' });
      else { this.entries.delete(transition.envelopeId); this.entries.set(`stale:${transition.record.draft.draftId}`, copyEntry(transition.record)); }
    }
  }
  dispose(): void { this.disposed += 1; }
}
function copyEntry(entry: PersistedShareOutboxEntry): PersistedShareOutboxEntry {
  if (entry.state === 'stale') return { ...entry, draft: { ...entry.draft } };
  return { ...entry, draft: { ...entry.draft }, canonicalWireBytes: new Uint8Array(entry.canonicalWireBytes) };
}

function fakeLive(calls: string[], start?: () => void | Promise<void>): DurableLiveSession {
  return { start: start ?? (() => { calls.push('start'); }), close: () => { calls.push('close'); },
    createComment: async () => EVENT, replyToComment: async () => EVENT, resolveComment: async () => EVENT,
    reopenComment: async () => EVENT,
    createSuggestion: async (_draft: SuggestionDraft) => EVENT, retryOutbox: async () => { calls.push('retry'); } };
}

interface SubmitArgs {
  canonicalWireBytes: Uint8Array;
  envelopeId: string;
  bundleId: string;
  epoch: number;
  revision: number;
  tier: 'view' | 'comment' | 'suggest';
  roomId: string;
  capabilityFingerprint: string;
  wireHash: string;
}
function sessionOptions(input: {
  resolver: BrowserShareResolver<unknown>;
  store?: MemoryOutbox;
  submit?: (args: SubmitArgs) => Promise<ShareMailboxReceipt>;
  subscribe?: (onChange: () => void) => ShareChangeSubscription;
  live?: () => DurableLiveSession;
  lifecycle?: (phase: string) => void;
}): BrowserShareSessionOptions {
  const store = input.store ?? new MemoryOutbox();
  return {
    shareId: SHARE_ID, resolver: input.resolver, outboxStore: store,
    digestWire: () => WIRE_HASH, capabilityFingerprint: () => CAPABILITY_FINGERPRINT,
    assembleOfflineComment: ({ resolution, draft }: { resolution: Awaited<ReturnType<BrowserShareResolver<unknown>['resolve']>>; draft: { body: string } }) => ({
      envelopeId: 'envelope-1', epoch: resolution.record.epoch, roomId: resolution.bundle.roomId,
      revision: resolution.record.revision, tier: resolution.bundle.tier,
      bundleId: resolution.record.bundleId, capabilityFingerprint: CAPABILITY_FINGERPRINT,
      canonicalWireBytes: new TextEncoder().encode(`{"body":${JSON.stringify(draft.body)}}`), event: EVENT,
    }),
    mailbox: { submit: async (args: SubmitArgs) => {
      if (input.submit) return input.submit(args);
      return { envelopeId: args.envelopeId, seq: 1, status: 'accepted' as const, bundleId: args.bundleId, epoch: args.epoch,
        revision: args.revision, tier: args.tier, roomId: args.roomId, capabilityFingerprint: args.capabilityFingerprint, wireHash: args.wireHash };
    } },
    createLiveSession: () => input.live?.() ?? fakeLive([]),
    subscribeToChanges: ({ onChange }: { onChange: () => void }) => input.subscribe?.(onChange) ?? { close() {} },
    onOptimisticLifecycle: ({ phase }: { phase: string }) => input.lifecycle?.(phase),
    disposeResolution: () => undefined,
    disposeSensitive: () => undefined,
    randomDraftId: () => 'draft-1',
  };
}

test('durable outbox reload retries byte-identical wire and commits ACK atomically', async () => {
  const store = new MemoryOutbox(); const attempts: Uint8Array[] = []; const phases: string[] = []; let fail = true;
  const make = () => new BrowserShareSession(sessionOptions({
    resolver: resolverFor({ getRecord: () => record(), getBundle: () => bundle() }), store,
    lifecycle: (phase) => { phases.push(phase); },
    submit: async (args) => { attempts.push(new Uint8Array(args.canonicalWireBytes)); if (fail) throw new Error('offline');
      return { envelopeId: args.envelopeId, seq: 9, status: 'duplicate', bundleId: args.bundleId, epoch: args.epoch,
        revision: args.revision, tier: args.tier, roomId: args.roomId, capabilityFingerprint: args.capabilityFingerprint, wireHash: args.wireHash }; },
  }));
  const first = make(); await first.start(); await rejects(() => first.createComment(ANCHOR, 'hello'), 'offline');
  assert(store.entries.has('envelope-1'), 'pending wire was not persisted'); first.close();
  fail = false; const second = make(); await second.start(); assert(second.getState().pendingComments === 1, 'pending wire was not hydrated');
  await second.retryOutbox(); assert(!store.entries.has('envelope-1'), 'ACK was not committed');
  assert(new TextDecoder().decode(attempts[0]) === new TextDecoder().decode(attempts[1]), 'reload changed canonical wire bytes');
  for (const phase of ['queued', 'retryable', 'hydrated', 'accepted']) assert(phases.includes(phase), `missing optimistic ${phase} phase`);
});

test('confused mailbox receipt is rejected without deleting durable wire', async () => {
  const store = new MemoryOutbox();
  const session = new BrowserShareSession(sessionOptions({
    resolver: resolverFor({ getRecord: () => record(), getBundle: () => bundle() }), store,
    submit: async (args) => ({ envelopeId: args.envelopeId, seq: 1, status: 'accepted',
      bundleId: args.bundleId, epoch: args.epoch, revision: args.revision, tier: args.tier, roomId: args.roomId,
      capabilityFingerprint: args.capabilityFingerprint, wireHash: 'X'.repeat(43) }),
  }));
  await session.start(); await rejects(() => session.createComment(ANCHOR, 'hello'), 'acknowledgement');
  assert(store.entries.has('envelope-1') && session.getState().pendingComments === 1, 'invalid receipt deleted durable wire');
});

test('enqueue persistence failure zeroes assembler and retained wire', async () => {
  const store = new MemoryOutbox(); store.failEnqueue = true;
  let assembled!: Uint8Array;
  const options = sessionOptions({ resolver: resolverFor({ getRecord: () => record(), getBundle: () => bundle() }), store });
  options.assembleOfflineComment = ({ resolution }) => ({ envelopeId: 'envelope-1', epoch: resolution.record.epoch,
    revision: resolution.record.revision, tier: resolution.bundle.tier, roomId: resolution.bundle.roomId,
    bundleId: resolution.record.bundleId, capabilityFingerprint: CAPABILITY_FINGERPRINT,
    canonicalWireBytes: (assembled = new Uint8Array([8, 9])) });
  const session = new BrowserShareSession(options); await session.start();
  await rejects(() => session.createComment(ANCHOR, 'hello'), 'persistence');
  assert(assembled.every(byte => byte === 0) && session.getState().pendingComments === 0, 'failed enqueue retained plaintext wire');
});

test('hydrate is all-or-nothing and zeroes every staged wire on error', async () => {
  const store = new MemoryOutbox();
  const base = { state: 'retryable' as const, shareId: SHARE_ID, bundleId: BUNDLE, epoch: 2, revision: 1,
    tier: 'comment' as const, roomId: ROOM_ID, capabilityFingerprint: CAPABILITY_FINGERPRINT, wireHash: WIRE_HASH,
    draft: { draftId: 'draft-a', anchor: ANCHOR, body: 'saved' } };
  store.entries.set('one', { ...base, envelopeId: 'one', canonicalWireBytes: new Uint8Array([1]) });
  store.entries.set('two', { ...base, envelopeId: 'two', wireHash: 'Q'.repeat(43), canonicalWireBytes: new Uint8Array([2]),
    draft: { ...base.draft, draftId: 'draft-b' } });
  const phases: string[] = [];
  const session = new BrowserShareSession(sessionOptions({ resolver: resolverFor({ getRecord: () => record(), getBundle: () => bundle() }), store,
    lifecycle: phase => { phases.push(phase); } }));
  await session.start();
  assert(session.getState().status === 'error' && session.getState().pendingComments === 0 && phases.length === 0,
    'partial hydrate became observable');
});

test('hydrate zeroes its current wire copy when digest throws before staging', async () => {
  const store = new MemoryOutbox();
  let digestedWire: Uint8Array | undefined;
  store.entries.set('one', { state: 'retryable', shareId: SHARE_ID, bundleId: BUNDLE, epoch: 2, revision: 1,
    tier: 'comment', roomId: ROOM_ID, capabilityFingerprint: CAPABILITY_FINGERPRINT, envelopeId: 'one', wireHash: WIRE_HASH,
    canonicalWireBytes: new Uint8Array([4, 5, 6]), draft: { draftId: 'draft-a', anchor: ANCHOR, body: 'saved' } });
  const options = sessionOptions({ resolver: resolverFor({ getRecord: () => record(), getBundle: () => bundle() }), store });
  options.digestWire = (wire) => { digestedWire = wire; throw new Error('digest failed'); };
  const session = new BrowserShareSession(options); await session.start();
  assert(session.getState().status === 'error' && session.getState().pendingComments === 0 &&
    digestedWire instanceof Uint8Array && digestedWire.every(byte => byte === 0),
    'digest failure retained the exact wire buffer passed to digestWire');
});

test('anchors are runtime validated, deep cloned and frozen; close clears observable plaintext', async () => {
  const store = new MemoryOutbox(); let observedFrozen = false; let disposed = 0;
  const options = sessionOptions({ resolver: resolverFor({ getRecord: () => record(), getBundle: () => bundle() }), store });
  options.assembleOfflineComment = ({ resolution, draft }) => {
    observedFrozen = Object.isFrozen(draft.anchor) && Object.isFrozen(draft.anchor.position.byteRange);
    return { envelopeId: 'envelope-1', epoch: resolution.record.epoch, revision: resolution.record.revision,
      tier: resolution.bundle.tier, roomId: resolution.bundle.roomId, bundleId: resolution.record.bundleId,
      capabilityFingerprint: CAPABILITY_FINGERPRINT, canonicalWireBytes: new Uint8Array([1]) };
  };
  options.disposeSensitive = () => { disposed += 1; };
  const session = new BrowserShareSession(options); await session.start();
  await session.createComment(ANCHOR, 'hello');
  assert(observedFrozen, 'assembler received mutable anchor');
  await rejects(() => session.createComment({} as Anchor, 'bad'), 'anchor');
  session.close(); const state = session.getState();
  assert(disposed === 1 && state.status === 'terminated' && state.epoch === null && state.roomId === null &&
    state.snapshots.length === 0 && state.staleDrafts.length === 0 && state.error === null, 'close retained observable sensitive state');
});

test('subscribe-first gap forces a second resolve', async () => {
  let resolves = 0;
  const session = new BrowserShareSession(sessionOptions({
    resolver: resolverFor({ getRecord: () => record(), getBundle: () => bundle(), onResolve: () => { resolves += 1; } }),
    subscribe: (onChange) => { onChange(); return { close() {} }; },
  }));
  await session.start(); assert(resolves >= 2, 'change in subscribe/resolve gap was lost');
});

test('transient mid-publish resolution failures retry before surfacing', async () => {
  let attempts = 0;
  const resolver = resolverFor({ getRecord: () => record(), getBundle: () => bundle(), onResolve: () => {
    attempts += 1;
    if (attempts === 1) throw new BrowserShareResolutionError('snapshot_invalid', 'snapshot ciphertext digest mismatch');
    if (attempts === 2) {
      const straddled = new Error('capability bundle context mismatch');
      straddled.name = 'ShareInviteParseError';
      throw straddled;
    }
  } });
  const session = new BrowserShareSession(sessionOptions({ resolver }));
  await session.start();
  assert(attempts === 3, `expected 3 resolve attempts, saw ${attempts}`);
  assert(session.getState().status !== 'error', `transient resolve failure surfaced terminally: ${session.getState().error}`);
  session.close();
});

test('rollback rejections surface immediately without retry', async () => {
  let attempts = 0;
  const resolver = resolverFor({ getRecord: () => record(), getBundle: () => bundle(), onResolve: () => {
    attempts += 1;
    throw new BrowserShareResolutionError('epoch_rollback', 'share epoch is older than durable state');
  } });
  const session = new BrowserShareSession(sessionOptions({ resolver }));
  await session.start();
  assert(attempts === 1, `rollback must not be retried, saw ${attempts} attempts`);
  assert(session.getState().status === 'error', 'rollback must surface as a terminal error');
  session.close();
});

test('view tier rejects every mutation including resolve and retries', async () => {
  const store = new MemoryOutbox(); store.entries.set('stale:draft-1', { state: 'stale', shareId: SHARE_ID, bundleId: BUNDLE,
    draft: { draftId: 'draft-1', anchor: ANCHOR, body: 'saved' } });
  const session = new BrowserShareSession(sessionOptions({ resolver: resolverFor({ getRecord: () => record(2, 1, ROOM_ID), getBundle: () => bundle(2, 1, 'view') }), store }));
  await session.start();
  await rejects(() => session.createComment(ANCHOR, 'x'), 'view');
  await rejects(() => session.resolveComment('thread'), 'view');
  await rejects(() => session.retryOutbox(), 'view');
  await rejects(() => session.retryStaleDraft('draft-1'), 'view');
});

test('room-gone live bootstrap degrades to durable snapshots with mailbox authoring (attn-hh9r)', async () => {
  // The resolver's liveness probe races the room's 24h hard TTL: first pass
  // says `room`, the live bootstrap then finds it wiped, and the queued
  // re-resolve observes the dead room. No hard error — the reviewer keeps
  // the snapshot presentation with the owner shown offline.
  let roomLiveCalls = 0;
  const store = new MemoryOutbox();
  const session = new BrowserShareSession(sessionOptions({
    resolver: resolverFor({ getRecord: () => record(2, 1, ROOM_ID), getBundle: () => bundle(),
      isRoomLive: () => { roomLiveCalls += 1; return roomLiveCalls === 1; } }),
    store,
    live: () => fakeLive([], () => { throw new ShareRoomGoneError(); }),
  }));
  await session.start();
  const state = session.getState();
  assert(state.status === 'ready', `room-gone bootstrap surfaced ${state.status}: ${state.error}`);
  assert(state.source === 'share_snapshot' && !state.ownerOnline, 'room-gone bootstrap did not degrade to snapshots');
  assert(state.snapshots.length === 1, 'degraded session lost its durable snapshots');
  assert(state.canComment, 'degraded session lost mailbox authoring');
  const event = await session.createComment(ANCHOR, 'delivered through the mailbox');
  assert(event === EVENT && session.getState().pendingComments === 0, 'mailbox comment did not flush after degrade');
  session.close();
});

test('room-gone bootstrap retries are bounded; genuine live failures still error (attn-hh9r)', async () => {
  // A room that flaps alive-at-probe/dead-at-bootstrap must not loop forever.
  let starts = 0;
  const flapping = new BrowserShareSession(sessionOptions({
    resolver: resolverFor({ getRecord: () => record(2, 1, ROOM_ID), getBundle: () => bundle(), isRoomLive: () => true }),
    live: () => fakeLive([], () => { starts += 1; throw new ShareRoomGoneError(); }),
  }));
  await flapping.start();
  assert(flapping.getState().status === 'error', 'unbounded room-gone bootstrap retries');
  assert(starts === 4, `expected 1 + 3 bounded bootstrap attempts, saw ${starts}`);
  flapping.close();
  // A genuinely unreachable relay keeps the terminal error presentation.
  const network = new BrowserShareSession(sessionOptions({
    resolver: resolverFor({ getRecord: () => record(2, 1, ROOM_ID), getBundle: () => bundle(), isRoomLive: () => true }),
    live: () => fakeLive([], () => { throw new Error('relay unreachable'); }),
  }));
  await network.start();
  const failed = network.getState();
  assert(failed.status === 'error' && failed.error === 'relay unreachable', 'genuine network failure was masked');
  network.close();
});

test('live start failure closes candidate/subscription and close wins generation race', async () => {
  const failedCalls: string[] = []; let subscriptionClosed = 0;
  const failed = new BrowserShareSession(sessionOptions({
    resolver: resolverFor({ getRecord: () => record(2, 1, ROOM_ID), getBundle: () => bundle() }),
    subscribe: () => ({ close: () => { subscriptionClosed += 1; } }),
    live: () => fakeLive(failedCalls, () => { throw new Error('live start failed'); }),
  }));
  await failed.start(); assert(failed.getState().status === 'error', 'start failure not surfaced');
  assert(failedCalls.includes('close') && subscriptionClosed === 1, 'failed transports were not closed');

  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const raceCalls: string[] = [];
  const racing = new BrowserShareSession(sessionOptions({
    resolver: resolverFor({ getRecord: () => record(2, 1, ROOM_ID), getBundle: () => bundle() }),
    live: () => fakeLive(raceCalls, () => gate),
  }));
  const starting = racing.start(); await new Promise((resolve) => setTimeout(resolve, 0)); racing.close(); release(); await starting;
  assert(racing.getState().status === 'terminated' && raceCalls.includes('close'), 'late live start resurrected closed session');
});

for (const item of cases) {
  try { await item.run(); passed += 1; console.log(`  ok  ${item.name}`); }
  catch (error) { console.error(`  not ok  ${item.name}: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
if (!process.exitCode) console.log(`\n${passed} passed, 0 failed`);
