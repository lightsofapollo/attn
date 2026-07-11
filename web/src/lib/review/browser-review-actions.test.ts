import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import type { ApplyVerdict, SuggestionOperation } from '../types';
import { BrowserStorage, StorageConflictError } from './browser-storage';
import { generateBrowserIdentity } from './browser-session';
import {
  BrowserReviewActionConflictError,
  acceptBrowserSuggestion,
  applyBrowserReadyVerdict,
  browserWorkspaceBodyHash,
  classifyBrowserSuggestionText,
  deriveBrowserAppliedRevisionId,
  deriveBrowserReviewActionId,
  rejectBrowserSuggestion,
  resolveBrowserSuggestion,
  type AtomicBrowserReviewActionCommit,
  type AtomicBrowserReviewActionStore,
  type BrowserReviewActionReceipt,
} from './browser-review-actions';
import { assembleBrowserEvent } from './browser-envelope';

interface CaseResult { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void> | void): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.stack : String(error) };
    }
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const ROOM = 'room-actions';
const WORKSPACE = 'workspace-actions';
const PATH = 'docs/plan.md';
const SUGGESTION = 'suggestion-actions';
const FENCE = { holderId: 'tab-owner', fencingToken: 7 };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SharedApplyCorpus {
  v: number;
  classification: Array<{
    name: string;
    snapshot: string;
    current: string;
    expected: 'exact' | 'normalized_unicode' | 'trailing_whitespace' | 'mismatch';
  }>;
  apply: Array<{
    name: string;
    current: string;
    operation: SuggestionOperation;
    resolution: { status: 'exact' | 'remapped'; confidence: number; byteRange: [number, number] };
    expectedVerdict: 'ready' | 'requires_three_way';
    expectedMatch?: 'exact' | 'normalized_unicode' | 'trailing_whitespace';
    expectedTarget: [number, number];
    expectedReplacement: string;
    expectedResult?: string;
  }>;
}

const sharedCorpus = JSON.parse(
  readFileSync(new URL('../../../../planning/collab/test-vectors/suggestion-apply.json', import.meta.url), 'utf8'),
) as SharedApplyCorpus;

Object.defineProperty(globalThis, 'IDBKeyRange', {
  configurable: true,
  value: IDBKeyRange,
});

function resolved(confidence = 1, start = 4, end = 9) {
  return confidence === 1
    ? ({
        status: 'exact' as const,
        confidence: 1 as const,
        currentRange: { byteRange: [start, end] as [number, number], lineRange: [0, 0] as [number, number] },
        reason: 'base_hash_match' as const,
      })
    : ({
        status: 'remapped' as const,
        confidence,
        currentRange: { byteRange: [start, end] as [number, number], lineRange: [0, 0] as [number, number] },
        reason: 'quote_match' as const,
      });
}

const terminalIdentity = generateBrowserIdentity();
function testTerminalPort(
  counter: { value: number } = { value: 0 },
  adopted: unknown[] = [],
  adoptionError?: string,
) {
  return {
    prepareTerminalEvent: (body: Parameters<typeof assembleBrowserEvent>[0]['body']) => {
      const createdAt = 1_000 + ++counter.value;
      return assembleBrowserEvent({
        eventKey: new Uint8Array(32).fill(0x41),
        signingSecret: terminalIdentity.signingSecret,
        signingPublic: terminalIdentity.signingPublic,
        roomId: ROOM,
        authorId: 'owner',
        deviceId: 'owner-device',
        createdAt,
        expiresAt: 999_999,
        nonce: new Uint8Array(24).fill(counter.value),
        body,
      });
    },
    adoptDurableEnvelope: async (envelope: unknown) => {
      if (adoptionError) throw new Error(adoptionError);
      adopted.push(structuredClone(envelope));
    },
  };
}

class AtomicMemoryStore implements AtomicBrowserReviewActionStore {
  readonly receipts = new Map<string, BrowserReviewActionReceipt>();
  body = encoder.encode('The brown fox');
  head = 'head-1';
  commits = 0;
  fail: 'before' | 'after' | null = null;

  async getReviewActionReceipt(
    _identity: { workspaceId: string },
    actionId: string,
  ): Promise<BrowserReviewActionReceipt | null> {
    return structuredClone(this.receipts.get(actionId) ?? null);
  }

  async commitReviewAction(commit: AtomicBrowserReviewActionCommit) {
    const existing = this.receipts.get(commit.actionId);
    if (existing) return { receipt: structuredClone(existing), replayed: true };
    if (commit.expectedHeadRevisionId !== this.head) throw new Error('head conflict');
    if (commit.fence.holderId !== FENCE.holderId || commit.fence.fencingToken !== FENCE.fencingToken) {
      throw new Error('fence conflict');
    }
    if (this.fail === 'before') {
      this.fail = null;
      throw new Error('simulated crash before atomic commit');
    }
    const receipt: BrowserReviewActionReceipt = {
      v: 1,
      ...commit.identity,
      actionId: commit.actionId,
      disposition: commit.disposition,
      terminalEvent: structuredClone(commit.terminal.event),
      terminalEnvelope: structuredClone(commit.terminal.envelope),
      terminalEnvelopeId: commit.terminal.envelope.envelopeId,
      baseRevisionId: commit.expectedHeadRevisionId,
      ...(commit.disposition === 'accepted'
        ? {
            baseBodyHash: commit.expectedBodyHash,
            appliedRevisionId: commit.revisionId,
            resultingHash: commit.bodyHash,
          }
        : {}),
    };
    // The assignments model one indivisible transaction boundary.
    if (commit.disposition === 'accepted') {
      this.body = new Uint8Array(commit.body);
      this.head = commit.revisionId;
    }
    this.receipts.set(commit.actionId, structuredClone(receipt));
    this.commits += 1;
    if (this.fail === 'after') {
      this.fail = null;
      throw new Error('simulated crash after atomic commit');
    }
    return { receipt, replayed: false };
  }
}

function acceptInput(store: AtomicBrowserReviewActionStore, counter: { value: number } = { value: 0 }) {
  return {
    workspaceId: WORKSPACE,
    roomId: ROOM,
    path: PATH,
    suggestionId: SUGGESTION,
    fence: FENCE,
    expectedHeadRevisionId: 'head-1',
    store,
    terminalPort: testTerminalPort(counter),
    operation: { kind: 'replace', expectedText: 'brown', replacement: 'green' } as SuggestionOperation,
    resolvedAnchor: resolved(),
    currentMarkdownBytes: encoder.encode('The brown fox'),
  };
}

defineCase('text drift policy matches native exact/NFC/trailing-whitespace/mismatch tiers', () => {
  equal(classifyBrowserSuggestionText('same', 'same'), 'exact', 'exact');
  equal(classifyBrowserSuggestionText('caf\u00e9', 'cafe\u0301'), 'normalized_unicode', 'NFC');
  equal(classifyBrowserSuggestionText('one  \ntwo\n', 'one\ntwo'), 'trailing_whitespace', 'trailing ws');
  equal(classifyBrowserSuggestionText('line\r\n', 'line\n'), 'mismatch', 'CRLF is real drift');
  equal(classifyBrowserSuggestionText('Foo', 'foo'), 'mismatch', 'case is real drift');
});

defineCase('shared Rust/browser apply corpus matches every classification and splice', () => {
  equal(sharedCorpus.v, 1, 'corpus version');
  for (const vector of sharedCorpus.classification) {
    equal(
      classifyBrowserSuggestionText(vector.snapshot, vector.current),
      vector.expected,
      `classification ${vector.name}`,
    );
  }
  for (const vector of sharedCorpus.apply) {
    const anchor = vector.resolution.status === 'exact'
      ? {
          status: 'exact' as const,
          confidence: 1 as const,
          currentRange: { byteRange: vector.resolution.byteRange, lineRange: [0, 0] as [number, number] },
          reason: 'base_hash_match' as const,
        }
      : {
          status: 'remapped' as const,
          confidence: vector.resolution.confidence,
          currentRange: { byteRange: vector.resolution.byteRange, lineRange: [0, 0] as [number, number] },
          reason: 'quote_match' as const,
        };
    const verdict = resolveBrowserSuggestion({
      roomId: ROOM,
      suggestionId: SUGGESTION,
      operation: vector.operation,
      resolvedAnchor: anchor,
      currentMarkdownBytes: encoder.encode(vector.current),
    });
    equal(verdict.kind, vector.expectedVerdict, `verdict ${vector.name}`);
    if (verdict.kind === 'ready') {
      equal(verdict.targetByteRange, vector.expectedTarget, `target ${vector.name}`);
      equal(verdict.matchKind, vector.expectedMatch, `match ${vector.name}`);
      equal(verdict.replacement, vector.expectedReplacement, `replacement ${vector.name}`);
      equal(
        decoder.decode(applyBrowserReadyVerdict(encoder.encode(vector.current), verdict)),
        vector.expectedResult,
        `splice ${vector.name}`,
      );
    } else if (verdict.kind === 'requires_three_way') {
      equal(verdict.targetByteRange, vector.expectedTarget, `target ${vector.name}`);
      equal(verdict.proposedReplacement, vector.expectedReplacement, `proposal ${vector.name}`);
    } else {
      throw new Error(`vector ${vector.name} unexpectedly produced ${verdict.kind}`);
    }
  }
});

defineCase('replace and delete require three-way on semantic drift', () => {
  for (const operation of [
    { kind: 'replace', expectedText: 'black', replacement: 'green' },
    { kind: 'delete', expectedText: 'black' },
  ] as SuggestionOperation[]) {
    const verdict = resolveBrowserSuggestion({
      roomId: ROOM,
      suggestionId: SUGGESTION,
      operation,
      resolvedAnchor: resolved(),
      currentMarkdownBytes: encoder.encode('The brown fox'),
    });
    equal(verdict.kind, 'requires_three_way', `${operation.kind} drift`);
  }
});

defineCase('remap below 0.70 forces three-way even when text matches', () => {
  const verdict = resolveBrowserSuggestion({
    roomId: ROOM,
    suggestionId: SUGGESTION,
    operation: { kind: 'replace', expectedText: 'brown', replacement: 'green' },
    resolvedAnchor: resolved(0.69),
    currentMarkdownBytes: encoder.encode('The brown fox'),
  });
  equal(verdict.kind, 'requires_three_way', 'low confidence verdict');
});

defineCase('insert cursors mirror native before/after semantics', () => {
  const before = resolveBrowserSuggestion({
    roomId: ROOM,
    suggestionId: SUGGESTION,
    operation: { kind: 'insert_before', text: 'quick ' },
    resolvedAnchor: resolved(),
    currentMarkdownBytes: encoder.encode('The brown fox'),
  });
  const after = resolveBrowserSuggestion({
    roomId: ROOM,
    suggestionId: SUGGESTION,
    operation: { kind: 'insert_after', text: ' bear' },
    resolvedAnchor: resolved(),
    currentMarkdownBytes: encoder.encode('The brown fox'),
  });
  assert(before.kind === 'ready' && after.kind === 'ready', 'insertions ready');
  equal(before.targetByteRange, [4, 4], 'before cursor');
  equal(after.targetByteRange, [9, 9], 'after cursor');
});

defineCase('ambiguous and stale verdicts never become writes', () => {
  const ambiguous = resolveBrowserSuggestion({
    roomId: ROOM,
    suggestionId: SUGGESTION,
    operation: { kind: 'delete', expectedText: 'brown' },
    resolvedAnchor: { status: 'ambiguous', reason: 'tie', candidates: [] },
    currentMarkdownBytes: encoder.encode('The brown fox'),
  });
  const stale = resolveBrowserSuggestion({
    roomId: ROOM,
    suggestionId: SUGGESTION,
    operation: { kind: 'delete', expectedText: 'brown' },
    resolvedAnchor: { status: 'stale', reason: 'no_candidates' },
    currentMarkdownBytes: encoder.encode('The brown fox'),
  });
  equal(ambiguous.kind, 'ambiguous', 'ambiguous preserved');
  equal(stale.kind, 'stale', 'stale preserved');
});

defineCase('ready apply splices UTF-8 byte ranges and rejects split codepoints', () => {
  const current = encoder.encode('A caf\u00e9 day');
  const ready: ApplyVerdict = {
    kind: 'ready', suggestionId: SUGGESTION, targetByteRange: [2, 7], replacement: 'tea',
    confidence: 1, matchKind: 'exact',
  };
  equal(decoder.decode(applyBrowserReadyVerdict(current, ready)), 'A tea day', 'UTF-8 splice');
  let rejected = false;
  try {
    applyBrowserReadyVerdict(current, { ...ready, targetByteRange: [2, 6] });
  } catch (error) {
    rejected = error instanceof BrowserReviewActionConflictError;
  }
  assert(rejected, 'range splitting é must fail');
});

defineCase('action and applied revision IDs are deterministic and domain-separated', () => {
  const identity = { workspaceId: WORKSPACE, roomId: ROOM, path: PATH, suggestionId: SUGGESTION };
  const actionA = deriveBrowserReviewActionId(identity);
  const actionB = deriveBrowserReviewActionId(identity);
  equal(actionA, actionB, 'action id replay');
  const revisionInput = {
    identity, actionId: actionA, baseRevisionId: 'head-1',
    previousHash: browserWorkspaceBodyHash(encoder.encode('old')),
    resultingHash: browserWorkspaceBodyHash(encoder.encode('new')),
  };
  equal(
    deriveBrowserAppliedRevisionId(revisionInput),
    deriveBrowserAppliedRevisionId(revisionInput),
    'revision id replay',
  );
  assert(actionA !== deriveBrowserAppliedRevisionId(revisionInput), 'domains differ');
  equal(
    deriveBrowserReviewActionId({ ...identity, path: 'caf\u00e9.md' }),
    deriveBrowserReviewActionId({ ...identity, path: 'cafe\u0301.md' }),
    'NFC path aliases share one action id',
  );
});

defineCase('accepted action atomically advances the head and persists terminal receipt', async () => {
  const store = new AtomicMemoryStore();
  const adopted: unknown[] = [];
  const input = acceptInput(store);
  input.terminalPort = testTerminalPort({ value: 0 }, adopted);
  const result = await acceptBrowserSuggestion(input);
  assert(result.status === 'committed', 'accepted commit');
  equal(decoder.decode(store.body), 'The green fox', 'new head body');
  equal(store.commits, 1, 'one transaction');
  equal(result.receipt.appliedRevisionId, store.head, 'receipt revision is head');
  equal(result.receipt.resultingHash, browserWorkspaceBodyHash(store.body), 'result hash');
  equal(result.deliveryPending, false, 'fresh receipt delivery complete');
  equal(adopted[0], result.receipt.terminalEnvelope, 'live port adopts exact durable envelope');
});

defineCase('adoption failure reports pending without undoing commit and replay retries delivery', async () => {
  const store = new AtomicMemoryStore();
  const input = acceptInput(store);
  input.terminalPort = testTerminalPort({ value: 0 }, [], 'relay temporarily unavailable');
  const committed = await acceptBrowserSuggestion(input);
  assert(committed.status === 'committed', 'durable action was misreported');
  equal(committed.deliveryPending, true, 'delivery pending surfaced');
  equal(committed.deliveryError, 'relay temporarily unavailable', 'delivery diagnostic');
  equal(store.commits, 1, 'adoption failure did not roll back or duplicate commit');

  const adopted: unknown[] = [];
  input.terminalPort = testTerminalPort({ value: 10 }, adopted);
  const replay = await acceptBrowserSuggestion(input);
  assert(replay.status === 'committed' && replay.replayed, 'receipt did not replay');
  equal(replay.deliveryPending, false, 'replay adoption did not recover');
  equal(adopted[0], committed.receipt.terminalEnvelope, 'replay adopted winner ciphertext');
  equal(store.commits, 1, 'replay changed durable action');
});

defineCase('crash before atomic commit applies nothing and retry applies once', async () => {
  const store = new AtomicMemoryStore();
  store.fail = 'before';
  const input = acceptInput(store);
  await acceptBrowserSuggestion(input).then(
    () => { throw new Error('expected simulated crash'); },
    () => undefined,
  );
  equal(decoder.decode(store.body), 'The brown fox', 'old body survived');
  equal(store.commits, 0, 'no receipt');
  const retried = await acceptBrowserSuggestion(input);
  assert(retried.status === 'committed', 'retry committed');
  equal(decoder.decode(store.body), 'The green fox', 'applied once');
  equal(store.commits, 1, 'one committed transition');
});

defineCase('crash after commit replays receipt without applying or authoring twice', async () => {
  const store = new AtomicMemoryStore();
  store.fail = 'after';
  const authored = { value: 0 };
  const input = acceptInput(store, authored);
  await acceptBrowserSuggestion(input).then(
    () => { throw new Error('expected simulated lost response'); },
    () => undefined,
  );
  equal(decoder.decode(store.body), 'The green fox', 'commit landed');
  const retried = await acceptBrowserSuggestion(input);
  assert(retried.status === 'committed' && retried.replayed, 'receipt replayed');
  equal(store.commits, 1, 'no duplicate revision');
  equal(authored.value, 1, 'no second terminal ciphertext');
});

defineCase('rejection is durable on return and precludes later acceptance', async () => {
  const store = new AtomicMemoryStore();
  const rejected = await rejectBrowserSuggestion({
    workspaceId: WORKSPACE,
    roomId: ROOM,
    path: PATH,
    suggestionId: SUGGESTION,
    fence: FENCE,
    expectedHeadRevisionId: 'head-1',
    reason: 'not applicable',
    store,
    terminalPort: testTerminalPort(),
  });
  equal(rejected.receipt.disposition, 'rejected', 'durable before return');
  equal(decoder.decode(store.body), 'The brown fox', 'rejection does not mutate');
  let conflict = false;
  try {
    await acceptBrowserSuggestion(acceptInput(store));
  } catch (error) {
    conflict = error instanceof BrowserReviewActionConflictError;
  }
  assert(conflict, 'opposite terminal decision rejected');
});

defineCase('receipt replay rejects changed accepted bytes and changed rejection reason', async () => {
  const acceptedStore = new AtomicMemoryStore();
  const accepted = acceptInput(acceptedStore);
  await acceptBrowserSuggestion(accepted);
  let changedAcceptFailed = false;
  try {
    await acceptBrowserSuggestion({
      ...accepted,
      currentMarkdownBytes: encoder.encode('The brown cat'),
    });
  } catch (error) {
    changedAcceptFailed = error instanceof BrowserReviewActionConflictError;
  }
  assert(changedAcceptFailed, 'changed accepted transition replayed an old receipt');

  const rejectedStore = new AtomicMemoryStore();
  const rejected = {
    workspaceId: WORKSPACE,
    roomId: ROOM,
    path: PATH,
    suggestionId: SUGGESTION,
    fence: FENCE,
    expectedHeadRevisionId: 'head-1',
    store: rejectedStore,
    terminalPort: testTerminalPort(),
  };
  await rejectBrowserSuggestion({ ...rejected, reason: 'first reason' });
  let changedRejectFailed = false;
  try {
    await rejectBrowserSuggestion({ ...rejected, reason: 'different reason' });
  } catch (error) {
    changedRejectFailed = error instanceof BrowserReviewActionConflictError;
  }
  assert(changedRejectFailed, 'changed rejection reason replayed an old receipt');
});

let databaseSerial = 0;
async function realStorageHarness(filesystem: {
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  delete(path: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<void>;
} | null = null) {
  databaseSerial += 1;
  const factory = new IDBFactory();
  const databaseName = `attn-review-action-${databaseSerial}`;
  const clock = { value: 1_700_000_000_000 };
  const open = () => BrowserStorage.open({
    indexedDB: factory,
    databaseName,
    createIfMissing: true,
    filesystem,
    navigator: null,
    now: () => clock.value,
  });
  const storage = await open();
  const created = await storage.workspaces.createWorkspace({
    workspaceId: WORKSPACE,
    name: 'Action workspace',
    storagePersisted: true,
    entry: { path: PATH, kind: 'markdown', body: encoder.encode('The brown fox') },
  });
  const lease = await storage.leases({
    now: () => clock.value,
    leaseDurationMs: 1_000,
    channel: null,
  }).acquire(WORKSPACE, FENCE.holderId);
  assert(lease, 'workspace lease acquired');
  return { storage, open, clock, created, fence: lease };
}

defineCase('real IndexedDB transaction commits revision, receipt, and exact outbox once', async () => {
  const harness = await realStorageHarness();
  const authored = { value: 0 };
  const input = {
    ...acceptInput(harness.storage, authored),
    store: harness.storage,
    fence: harness.fence,
    expectedHeadRevisionId: harness.created.revision.revisionId,
  };
  const committed = await acceptBrowserSuggestion(input);
  assert(committed.status === 'committed' && !committed.replayed, 'first atomic commit');
  equal(decoder.decode(await harness.storage.workspaces.getHeadBody(WORKSPACE, PATH)), 'The green fox', 'head');
  const outbox = await harness.storage.listOutbox(ROOM, 'owner-device');
  equal(outbox.length, 1, 'one terminal outbox row');
  equal(outbox[0], committed.receipt.terminalEnvelope, 'exact sealed envelope retained');
  harness.storage.close();

  const reopened = await harness.open();
  const replayed = await acceptBrowserSuggestion({ ...input, store: reopened });
  assert(replayed.status === 'committed' && replayed.replayed, 'receipt replay after reopen');
  equal(authored.value, 1, 'replay does not author new ciphertext');
  equal((await reopened.workspaces.listRevisions(WORKSPACE, PATH)).length, 2, 'one applied revision');
  equal((await reopened.listOutbox(ROOM, 'owner-device')).length, 1, 'one outbox row');
  reopened.close();
});

defineCase('real IndexedDB rejects an expired fence before rejection becomes visible', async () => {
  const harness = await realStorageHarness();
  harness.clock.value += 1_001;
  let workspaceWriteFailed = false;
  try {
    await harness.storage.workspaces.commitRevision({
      workspaceId: WORKSPACE,
      path: PATH,
      body: encoder.encode('expired writer'),
      expectedHeadRevisionId: harness.created.revision.revisionId,
      fence: harness.fence,
    });
  } catch (error) {
    workspaceWriteFailed = error instanceof StorageConflictError;
  }
  assert(workspaceWriteFailed, 'all fenced workspace writes require unexpired lease');
  let failed = false;
  try {
    await rejectBrowserSuggestion({
      workspaceId: WORKSPACE,
      roomId: ROOM,
      path: PATH,
      suggestionId: SUGGESTION,
      fence: harness.fence,
      expectedHeadRevisionId: harness.created.revision.revisionId,
      store: harness.storage,
      terminalPort: testTerminalPort(),
    });
  } catch (error) {
    failed = error instanceof StorageConflictError;
  }
  assert(failed, 'expired lease rejected');
  equal((await harness.storage.listOutbox(ROOM, 'owner-device')).length, 0, 'no optimistic dismissal row');
  harness.storage.close();
});

defineCase('real IndexedDB head race fails CAS without terminal receipt or outbox', async () => {
  const harness = await realStorageHarness();
  await harness.storage.workspaces.commitRevision({
    workspaceId: WORKSPACE,
    path: PATH,
    body: encoder.encode('A newer local edit'),
    expectedHeadRevisionId: harness.created.revision.revisionId,
    fence: harness.fence,
  });
  let failed = false;
  try {
    await rejectBrowserSuggestion({
      workspaceId: WORKSPACE,
      roomId: ROOM,
      path: PATH,
      suggestionId: SUGGESTION,
      fence: harness.fence,
      expectedHeadRevisionId: harness.created.revision.revisionId,
      store: harness.storage,
      terminalPort: testTerminalPort(),
    });
  } catch (error) {
    failed = error instanceof StorageConflictError;
  }
  assert(failed, 'stale expected head rejected');
  equal(decoder.decode(await harness.storage.workspaces.getHeadBody(WORKSPACE, PATH)), 'A newer local edit', 'new head preserved');
  equal((await harness.storage.listOutbox(ROOM, 'owner-device')).length, 0, 'no terminal row');
  harness.storage.close();
});

defineCase('large concurrent same-action attempts cannot overwrite winner OPFS ciphertext', async () => {
  const blobs = new Map<string, Uint8Array>();
  let writes = 0;
  const filesystem = {
    write: async (path: string, bytes: Uint8Array) => {
      writes += 1;
      blobs.set(path, new Uint8Array(bytes));
    },
    read: async (path: string) => blobs.get(path) ?? null,
    delete: async (path: string) => blobs.delete(path),
    deletePrefix: async (prefix: string) => {
      for (const path of blobs.keys()) if (path.startsWith(prefix)) blobs.delete(path);
    },
  };
  const harness = await realStorageHarness(filesystem);
  const large = 'x'.repeat(600 * 1024);
  const authored = { value: 50 };
  const base = {
    workspaceId: WORKSPACE,
    roomId: ROOM,
    path: PATH,
    suggestionId: SUGGESTION,
    fence: harness.fence,
    expectedHeadRevisionId: harness.created.revision.revisionId,
    store: harness.storage,
    operation: { kind: 'insert_after', text: large } as SuggestionOperation,
    resolvedAnchor: resolved(1, 4, 9),
    currentMarkdownBytes: encoder.encode('The brown fox'),
    terminalPort: testTerminalPort(authored),
  };
  const outcomes = await Promise.allSettled([
    acceptBrowserSuggestion(base),
    acceptBrowserSuggestion(base),
  ]);
  equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1, 'one exact terminal wins');
  equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1, 'different terminal pair conflicts');
  equal(writes, 0, 'atomic action staging never touches deterministic OPFS path');
  const body = await harness.storage.workspaces.getHeadBody(WORKSPACE, PATH);
  equal(body.length, encoder.encode('The brown').length + large.length + encoder.encode(' fox').length, 'large body intact');
  equal((await harness.storage.workspaces.listRevisions(WORKSPACE, PATH)).length, 2, 'one large revision');
  harness.storage.close();
});

defineCase('receipt replay fails closed when its exact envelope disappears', async () => {
  const harness = await realStorageHarness();
  const input = {
    ...acceptInput(harness.storage),
    store: harness.storage,
    fence: harness.fence,
    expectedHeadRevisionId: harness.created.revision.revisionId,
  };
  const first = await acceptBrowserSuggestion(input);
  assert(first.status === 'committed', 'seed action');
  const db = (harness.storage as unknown as { db: IDBDatabase }).db;
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').delete([ROOM, first.receipt.terminalEnvelopeId]);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  let failed = false;
  try {
    await acceptBrowserSuggestion(input);
  } catch (error) {
    failed = error instanceof StorageConflictError;
  }
  assert(failed, 'missing durable envelope rejects replay');
  harness.storage.close();
});

async function run(): Promise<void> {
  const results = await Promise.all(cases.map((testCase) => testCase()));
  for (const result of results) {
    if (result.ok) console.log(`PASS ${result.name}`);
    else console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
  }
  const failures = results.filter((result) => !result.ok);
  console.log(`browser-review-actions: ${results.length - failures.length} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void run();
