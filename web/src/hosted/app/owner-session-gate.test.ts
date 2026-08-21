// The workspace-switch race on the writer lease (attn-e9r2.2).
//
// Acquiring the pen takes real time — a polite ask, a handoff doorbell, a
// grace period — and desktop switches workspaces in place, so the user can
// pick another workspace inside that window. Every case here resolves the
// acquisition by hand, so the race is a fixture rather than a timing hope.
//
// Run with:
//
//   cd web && npx tsx src/hosted/app/owner-session-gate.test.ts

import { createOwnerSessionGate } from './owner-session-gate';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void> | void): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/* ————— a lease acquisition the test resolves by hand ————— */

interface Session {
  workspaceId: string;
}

function harness(startAt = 'ws-a') {
  let current = startAt;
  const settle = new Map<string, (granted: Session | null) => void>();
  const installed: Array<Session | null> = [];
  const discarded: string[] = [];

  const gate = createOwnerSessionGate<Session>({
    current: () => current,
    begin: (workspaceId) =>
      new Promise<Session | null>((resolve) => {
        settle.set(workspaceId, resolve);
      }),
    discard: async (workspaceId) => {
      discarded.push(workspaceId);
    },
  });

  return {
    gate,
    installed,
    discarded,
    switchTo(workspaceId: string): void {
      current = workspaceId;
    },
    /** Resolve the pending acquisition for a workspace, then let it settle. */
    async grant(workspaceId: string, granted: Session | null = { workspaceId }): Promise<void> {
      const resolve = settle.get(workspaceId);
      assert(resolve, `no acquisition in flight for ${workspaceId}`);
      settle.delete(workspaceId);
      resolve(granted);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    acquire(): Promise<Session | null> {
      return gate.acquire(async (granted) => {
        installed.push(granted);
      });
    },
  };
}

/* ————— cases ————— */

defineCase('a session granted after a workspace switch is never installed', async () => {
  const h = harness('ws-a');
  const pending = h.acquire();
  h.switchTo('ws-b');
  await h.grant('ws-a');
  assertEqual(await pending, null, 'the caller is told it lost');
  assertEqual(h.installed.length, 0, "workspace A's session never became B's session");
  assertEqual(h.discarded.join(), 'ws-a', 'and its lease was handed straight back');
});

defineCase('a switch does not hand the new workspace the old attempt', async () => {
  const h = harness('ws-a');
  const first = h.acquire();
  h.switchTo('ws-b');
  const second = h.acquire();
  assert(first !== second, 'ws-b started its own acquisition');
  assertEqual(h.gate.pendingFor(), 'ws-b', 'and the gate is holding it for ws-b');
  await h.grant('ws-b');
  assertEqual((await second)?.workspaceId, 'ws-b', "ws-b installs ws-b's session");
  assertEqual(h.installed.length, 1, 'exactly one install');
  assertEqual(h.installed[0]?.workspaceId, 'ws-b', 'and it is the right one');
  await h.grant('ws-a');
  assertEqual(await first, null, "ws-a's late grant installs nothing");
  assertEqual(h.discarded.join(), 'ws-a', 'and is handed back');
});

defineCase('two asks for the same workspace share one acquisition', async () => {
  // The single-flight property the gate replaced must survive: a second ask
  // while the doorbell is still ringing must not ring it again.
  const h = harness('ws-a');
  const first = h.acquire();
  const second = h.acquire();
  assert(first === second, 'the same acquisition is handed back');
  await h.grant('ws-a');
  assertEqual(h.installed.length, 1, 'installed once');
});

defineCase('switching away and back does not let the first attempt land', async () => {
  // A → B → A. The workspace id alone says the stale attempt is current
  // again, so identity — not the id — has to decide.
  const h = harness('ws-a');
  const first = h.acquire();
  h.switchTo('ws-b');
  h.gate.invalidate();
  h.switchTo('ws-a');
  const second = h.acquire();
  assert(first !== second, 'the return to ws-a is a fresh acquisition');
  await h.grant('ws-a');
  assertEqual(h.installed.length, 1, 'only the fresh attempt installed');
  assertEqual(h.discarded.length, 0, 'nothing to discard yet');
});

defineCase('a denial still reaches the caller so it can go read-only', async () => {
  const h = harness('ws-a');
  const pending = h.acquire();
  await h.grant('ws-a', null);
  assertEqual(await pending, null, 'no session');
  assertEqual(h.installed.length, 1, 'the caller was told');
  assertEqual(h.installed[0], null, 'with the denial itself');
  assertEqual(h.discarded.length, 0, 'nothing was granted to hand back');
});

defineCase('the slot frees after an acquisition settles', async () => {
  const h = harness('ws-a');
  const first = h.acquire();
  await h.grant('ws-a');
  await first;
  assertEqual(h.gate.pendingFor(), null, 'nothing in flight');
  const second = h.acquire();
  assert(first !== second, 'a later ask starts a new acquisition');
  await h.grant('ws-a');
  assertEqual(h.installed.length, 2, 'both installed');
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`owner-session-gate: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
