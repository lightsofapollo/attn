// attn-1l2f.2 — the cross-workspace file-read race.
//
// AppShell used two independent generation counters: `applyEntry` (switch file)
// only guarded against a newer `applyEntry`, and `navigate` (switch workspace)
// only against a newer `navigate`. Neither could see the other, so a file read
// issued in workspace A could resolve after workspace B was open and write A's
// body, path, and URL into B — after which the next autosave saved A's text
// against B.
//
// These cases drive a miniature AppShell built on the shared guard: the same
// two functions, the same await points, deferred reads so the interleaving is
// exact.

import {
  canApplyWorkspaceRead,
  createNavigationGuard,
  type PendingWorkspaceRead,
} from './navigation-guard';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void | string> | void | string): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** A read whose resolution the test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every already-resolved microtask continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * The part of AppShell this guard exists for: the state a resolved read
 * mutates, and the two moves that race for it.
 */
class ShellModel {
  readonly nav = createNavigationGuard();
  openWorkspaceId: string | undefined;
  activePath: string | undefined;
  bodyText: string | null = null;
  url = '/app';

  /** Reads keyed by `${workspaceId}:${path}`, resolved by the test. */
  readonly reads = new Map<string, { promise: Promise<string>; resolve: (v: string) => void }>();

  read(workspaceId: string, path: string): Promise<string> {
    const key = `${workspaceId}:${path}`;
    const existing = this.reads.get(key);
    if (existing) return existing.promise;
    const d = deferred<string>();
    this.reads.set(key, d);
    return d.promise;
  }

  finish(workspaceId: string, path: string, body: string): void {
    this.reads.get(`${workspaceId}:${path}`)?.resolve(body);
  }

  /** `applyEntry` — switch file inside the open workspace. */
  async applyEntry(path: string): Promise<void> {
    if (this.openWorkspaceId === undefined || path === this.activePath) return;
    const pending: PendingWorkspaceRead = {
      token: this.nav.begin(),
      workspaceId: this.openWorkspaceId,
    };
    const body = await this.read(pending.workspaceId, path);
    if (!canApplyWorkspaceRead(this.nav, pending, this.openWorkspaceId)) return;
    this.activePath = path;
    this.bodyText = body;
    this.url = `/app/w/${pending.workspaceId}/${path}`;
  }

  /** `openWorkspaceRoute` — switch workspace. */
  async openWorkspace(workspaceId: string, path: string): Promise<void> {
    const generation = this.nav.begin();
    const body = await this.read(workspaceId, path);
    if (!this.nav.isCurrent(generation)) return;
    this.openWorkspaceId = workspaceId;
    this.activePath = path;
    this.bodyText = body;
    this.url = `/app/w/${workspaceId}/${path}`;
  }
}

/** A shell already sitting in workspace A on `a.md`. */
function shellInWorkspaceA(): ShellModel {
  const shell = new ShellModel();
  shell.openWorkspaceId = 'ws-a';
  shell.activePath = 'a.md';
  shell.bodyText = 'A body';
  shell.url = '/app/w/ws-a/a.md';
  return shell;
}

defineCase('a file read from the previous workspace never lands in the new one', async () => {
  const shell = shellInWorkspaceA();

  // Select another file in A — the read goes out and stays out.
  const selecting = shell.applyEntry('a-second.md');
  await settle();

  // Then switch to workspace B, which completes first.
  const switching = shell.openWorkspace('ws-b', 'b.md');
  shell.finish('ws-b', 'b.md', 'B body');
  await switching;
  assertEqual(shell.openWorkspaceId, 'ws-b', 'workspace B must be open');

  // Now A's read comes back.
  shell.finish('ws-a', 'a-second.md', 'A second body');
  await selecting;

  assertEqual(shell.openWorkspaceId, 'ws-b', 'workspace must still be B');
  assertEqual(shell.activePath, 'b.md', "B's path must survive");
  assertEqual(shell.bodyText, 'B body', "B's body must survive");
  assertEqual(shell.url, '/app/w/ws-b/b.md', 'the URL must still name B');
});

defineCase('the same guard also drops a superseded same-workspace read', async () => {
  const shell = shellInWorkspaceA();

  const first = shell.applyEntry('one.md');
  await settle();
  const second = shell.applyEntry('two.md');
  await settle();

  // The newer selection resolves first, then the older one.
  shell.finish('ws-a', 'two.md', 'two body');
  await second;
  shell.finish('ws-a', 'one.md', 'one body');
  await first;

  assertEqual(shell.activePath, 'two.md', 'the newest selection must win');
  assertEqual(shell.bodyText, 'two body', 'the newest body must win');
});

defineCase('a workspace navigation is dropped by a newer file selection', async () => {
  const shell = shellInWorkspaceA();

  const switching = shell.openWorkspace('ws-b', 'b.md');
  await settle();
  const selecting = shell.applyEntry('a-second.md');
  await settle();

  shell.finish('ws-a', 'a-second.md', 'A second body');
  await selecting;
  shell.finish('ws-b', 'b.md', 'B body');
  await switching;

  assertEqual(shell.openWorkspaceId, 'ws-a', 'the later intent wins in both directions');
  assertEqual(shell.activePath, 'a-second.md', "A's selection must survive");
  assertEqual(shell.bodyText, 'A second body', "A's body must survive");
});

defineCase('an uncontested file switch still applies', async () => {
  const shell = shellInWorkspaceA();
  const selecting = shell.applyEntry('a-second.md');
  shell.finish('ws-a', 'a-second.md', 'A second body');
  await selecting;
  assertEqual(shell.activePath, 'a-second.md', 'the ordinary path must not regress');
  assertEqual(shell.bodyText, 'A second body', 'the body must land');
  assertEqual(shell.url, '/app/w/ws-a/a-second.md', 'the URL must follow');
});

defineCase('current() observes without superseding, begin() supersedes', () => {
  const nav = createNavigationGuard();
  const first = nav.begin();
  const observed = nav.current();
  assertEqual(observed, first, 'current() must report the transition in flight');
  assertEqual(nav.isCurrent(first), true, 'observing must not cancel the transition');
  const second = nav.begin();
  assertEqual(nav.isCurrent(first), false, 'a new transition supersedes the old token');
  assertEqual(nav.isCurrent(second), true, 'the new token is current');
});

defineCase('a background refresh is dropped when the workspace changed', async () => {
  // `refreshActiveBody` / `onWorkspaceChanged`: the token can still be current
  // (the navigation finished), so workspace identity is the half that catches
  // it — and two workspaces routinely hold the same path name.
  const shell = shellInWorkspaceA();
  const pending: PendingWorkspaceRead = { token: shell.nav.current(), workspaceId: 'ws-a' };

  const switching = shell.openWorkspace('ws-b', 'a.md');
  shell.finish('ws-b', 'a.md', 'B body');
  await switching;

  assertEqual(
    canApplyWorkspaceRead(shell.nav, pending, shell.openWorkspaceId),
    false,
    "a refresh from A must not write into B's identically-named file",
  );
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`navigation-guard: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
