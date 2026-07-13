// Local multi-tab live co-editing (attn-47r): hub + join over a fake
// BroadcastChannel bus. Proves the handshake, seed consistency, two-way
// step convergence, the headless commit hook, self-echo immunity, and the
// generation teardown on goodbye/takeover.
//
// Run: npx tsx src/lib/review/browser-local-collab.test.ts

import { collab } from 'prosemirror-collab';
import { EditorState } from 'prosemirror-state';

import { markdownParser, markdownSerializer, schema } from '../schema';
import type { EditorBridge } from '../prosemirror/collab-session';
import {
  LocalCollabHub,
  LocalCollabJoin,
  localCollabFileId,
  type LocalCollabChannel,
} from './browser-local-collab';

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];

function defineCase(name: string, fn: () => Promise<void> | void): void {
  cases.push({ name, fn });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ————— fake wire + clock —————

/** Delivers to every OTHER endpoint, like a real BroadcastChannel. */
class FakeBus {
  private readonly endpoints = new Set<FakeChannel>();

  connect(): FakeChannel {
    const channel = new FakeChannel(this);
    this.endpoints.add(channel);
    return channel;
  }

  deliver(from: FakeChannel, message: unknown): void {
    for (const endpoint of this.endpoints) {
      if (endpoint === from || endpoint.closed) continue;
      endpoint.onmessage?.({ data: message });
    }
  }

  drop(channel: FakeChannel): void {
    this.endpoints.delete(channel);
  }
}

class FakeChannel implements LocalCollabChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(private readonly bus: FakeBus) {}
  postMessage(message: unknown): void {
    if (!this.closed) this.bus.deliver(this, message);
  }
  close(): void {
    this.closed = true;
    this.bus.drop(this);
  }
}

/** Deterministic timer queue; run() executes everything currently scheduled. */
class FakeClock {
  private tasks = new Map<number, () => void>();
  private nextId = 1;
  schedule = (callback: () => void, _delayMs: number): unknown => {
    const id = this.nextId++;
    this.tasks.set(id, callback);
    return id;
  };
  cancel = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  run(): void {
    const due = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of due) task();
  }
}

// ————— editor stand-ins —————

function makeEditor(clientID: string, markdown: string) {
  let state = EditorState.create({
    doc: markdownParser.parse(markdown) ?? schema.node('doc', null, [schema.node('paragraph')]),
    plugins: [collab({ version: 0, clientID })],
  });
  const bridge: EditorBridge = {
    getState: () => state,
    apply: (tr) => {
      state = state.apply(tr);
    },
  };
  return {
    bridge,
    type(text: string) {
      state = state.apply(state.tr.insertText(text, state.doc.content.size - 1));
    },
    get text() {
      return state.doc.textContent;
    },
  };
}

interface Fixture {
  bus: FakeBus;
  clock: FakeClock;
  heads: Map<string, string>;
  commits: Array<{ path: string; markdown: string }>;
  hub: LocalCollabHub;
}

function makeHub(overrides: { heads?: Map<string, string> } = {}): Fixture {
  const bus = new FakeBus();
  const clock = new FakeClock();
  const heads = overrides.heads ?? new Map([['notes.md', 'hello world']]);
  const commits: Array<{ path: string; markdown: string }> = [];
  const hub = new LocalCollabHub({
    workspaceId: 'ws-1',
    holderId: 'tab-owner',
    selfLabel: 'You',
    selfColor: '#8a63b8',
    readHeadMarkdown: async (path) => heads.get(path) ?? null,
    commitMarkdown: async (path, markdown) => {
      commits.push({ path, markdown });
      heads.set(path, markdown);
    },
    channel: bus.connect(),
    schedule: clock.schedule,
    cancelScheduled: clock.cancel,
  });
  return { bus, clock, heads, commits, hub };
}

function makeJoin(fixture: Fixture, holderId = 'tab-follower'): LocalCollabJoin {
  return new LocalCollabJoin({
    workspaceId: 'ws-1',
    holderId,
    selfLabel: 'Another tab',
    selfColor: '#8a63b8',
    channel: fixture.bus.connect(),
    schedule: fixture.clock.schedule,
    cancelScheduled: fixture.clock.cancel,
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ————— cases —————

defineCase('join handshakes to live with the hub generation', async () => {
  const fixture = makeHub();
  const join = makeJoin(fixture);
  await tick();
  const state = join.getState();
  assert(state.status === 'live', `expected live, got ${state.status}`);
  assert(state.generation === fixture.hub.generation, 'generation mismatch');
  assert(state.ownerHolderId === 'tab-owner', 'owner holder mismatch');
  join.close();
  await fixture.hub.close();
});

defineCase('a join created before the hub connects on hello', async () => {
  const bus = new FakeBus();
  const clock = new FakeClock();
  const join = new LocalCollabJoin({
    workspaceId: 'ws-1',
    holderId: 'tab-follower',
    selfLabel: 'Another tab',
    selfColor: '#8a63b8',
    channel: bus.connect(),
    schedule: clock.schedule,
    cancelScheduled: clock.cancel,
  });
  assert(join.getState().status === 'connecting', 'should start connecting');
  const heads = new Map([['notes.md', 'hi']]);
  const hub = new LocalCollabHub({
    workspaceId: 'ws-1',
    holderId: 'tab-owner',
    selfLabel: 'You',
    selfColor: '#8a63b8',
    readHeadMarkdown: async (path) => heads.get(path) ?? null,
    commitMarkdown: async () => undefined,
    channel: bus.connect(),
    schedule: clock.schedule,
    cancelScheduled: clock.cancel,
  });
  await tick();
  assert(join.getState().status === 'live', 'hub hello should flip the join live');
  join.close();
  await hub.close();
});

defineCase('seed reply carries the head markdown and a legacy epoch', async () => {
  const fixture = makeHub();
  const join = makeJoin(fixture);
  await tick();
  const seed = await join.getSeed('notes.md');
  assert(seed !== null, 'seed should resolve');
  assert(seed!.markdown === 'hello world', `seed markdown: ${seed!.markdown}`);
  assert(seed!.fileId === 'notes.md', 'fileId is the path');
  assert(seed!.epoch === 'legacy:notes.md', `epoch: ${seed!.epoch}`);
  const missing = await Promise.race([join.getSeed('nope.md'), tick().then(() => 'pending')]);
  assert(missing === 'pending', 'unknown path should not resolve immediately');
  join.close();
  await fixture.hub.close();
});

defineCase('owner and follower editors converge both directions', async () => {
  const fixture = makeHub();
  const join = makeJoin(fixture);
  await tick();

  const seed = await fixture.hub.seedFor('notes.md');
  assert(seed !== null, 'hub seed');
  const ownerEditor = makeEditor('owner-editor', seed!.markdown);
  fixture.hub.controller.setActiveFile(seed!.fileId, ownerEditor.bridge, seed!.epoch);

  const joinSeed = await join.getSeed('notes.md');
  assert(joinSeed !== null, 'join seed');
  const followerEditor = makeEditor('follower-editor', joinSeed!.markdown);
  join.getController()!.setActiveFile(joinSeed!.fileId, followerEditor.bridge, joinSeed!.epoch);
  await tick();

  ownerEditor.type(' +owner');
  fixture.hub.controller.onLocalChange();
  await tick();
  assert(
    followerEditor.text.includes('+owner'),
    `follower should see owner text: ${followerEditor.text}`,
  );

  followerEditor.type(' +follower');
  join.getController()!.onLocalChange();
  await tick();
  assert(
    ownerEditor.text.includes('+follower'),
    `owner should see follower text: ${ownerEditor.text}`,
  );
  assert(ownerEditor.text === followerEditor.text, 'editors must converge');
  join.close();
  await fixture.hub.close();
});

defineCase('follower edits to a headless file debounce-commit from the authority doc', async () => {
  const fixture = makeHub();
  const join = makeJoin(fixture);
  await tick();
  // The owner never opens notes.md (no setActiveFile) — the hub must commit.
  const joinSeed = await join.getSeed('notes.md');
  const followerEditor = makeEditor('follower-editor', joinSeed!.markdown);
  join.getController()!.setActiveFile(joinSeed!.fileId, followerEditor.bridge, joinSeed!.epoch);
  await tick();
  followerEditor.type(' +headless');
  join.getController()!.onLocalChange();
  await tick();
  assert(fixture.commits.length === 0, 'commit must wait for the debounce');
  fixture.clock.run();
  await tick();
  assert(fixture.commits.length === 1, `expected 1 commit, got ${fixture.commits.length}`);
  assert(fixture.commits[0]!.path === 'notes.md', 'commit path');
  assert(fixture.commits[0]!.markdown.includes('+headless'), 'committed markdown has the edit');
  join.close();
  await fixture.hub.close();
});

defineCase('hub close flushes pending commits and says goodbye', async () => {
  const fixture = makeHub();
  const join = makeJoin(fixture);
  await tick();
  const joinSeed = await join.getSeed('notes.md');
  const followerEditor = makeEditor('follower-editor', joinSeed!.markdown);
  join.getController()!.setActiveFile(joinSeed!.fileId, followerEditor.bridge, joinSeed!.epoch);
  await tick();
  followerEditor.type(' +flush');
  join.getController()!.onLocalChange();
  await tick();
  await fixture.hub.close();
  assert(fixture.commits.length === 1, 'close must flush the debounced commit');
  assert(fixture.commits[0]!.markdown.includes('+flush'), 'flushed content');
  await tick();
  assert(join.getState().status === 'connecting', 'goodbye should disconnect the join');
  join.close();
});

defineCase('a takeover generation reseeds the follower from the new head', async () => {
  const fixture = makeHub();
  const join = makeJoin(fixture);
  await tick();
  const first = join.getState().generation;
  await fixture.hub.close();
  await tick();
  assert(join.getState().status === 'connecting', 'follower disconnects on goodbye');

  // New owner committed its converged doc, then hosts a fresh generation.
  fixture.heads.set('notes.md', 'hello world +takeover');
  const secondHub = new LocalCollabHub({
    workspaceId: 'ws-1',
    holderId: 'tab-second-owner',
    selfLabel: 'You',
    selfColor: '#8a63b8',
    readHeadMarkdown: async (path) => fixture.heads.get(path) ?? null,
    commitMarkdown: async () => undefined,
    channel: fixture.bus.connect(),
    schedule: fixture.clock.schedule,
    cancelScheduled: fixture.clock.cancel,
  });
  await tick();
  const state = join.getState();
  assert(state.status === 'live', 'follower reconnects to the new hub');
  assert(state.generation !== first, 'generation must change');
  assert(state.ownerHolderId === 'tab-second-owner', 'new owner identity');
  const seed = await join.getSeed('notes.md');
  assert(seed!.markdown === 'hello world +takeover', 'seed reflects the takeover commit');
  join.close();
  await secondHub.close();
});

defineCase('messages for another workspace are ignored', async () => {
  const fixture = makeHub();
  const foreign = new LocalCollabJoin({
    workspaceId: 'ws-2',
    holderId: 'tab-foreign',
    selfLabel: 'Another tab',
    selfColor: '#8a63b8',
    channel: fixture.bus.connect(),
    schedule: fixture.clock.schedule,
    cancelScheduled: fixture.clock.cancel,
  });
  await tick();
  assert(foreign.getState().status === 'connecting', 'ws-2 join must not adopt a ws-1 hub');
  foreign.close();
  await fixture.hub.close();
});

defineCase('deep paths refuse a local collab fileId', () => {
  assert(localCollabFileId('a/'.repeat(150) + 'x.md') === null, 'over-long path must be rejected');
  assert(localCollabFileId('docs/notes.md') === 'docs/notes.md', 'normal path passes through');
});

defineCase('serialized commits round-trip the schema', async () => {
  const doc = markdownParser.parse('# Title\n\n- [ ] task');
  assert(doc !== null, 'parse');
  const markdown = markdownSerializer.serialize(doc!);
  assert(markdown.includes('# Title'), 'heading survives');
});

async function main(): Promise<void> {
  for (const { name, fn } of cases) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${(err as Error).message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
