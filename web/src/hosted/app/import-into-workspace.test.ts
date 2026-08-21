// Mid-import workspace switching (attn-e9r2.1).
//
// Desktop switches workspaces in place, so an import that is still reading
// bytes when the user clicks another workspace used to finish against
// whichever workspace was on screen by then: it deleted THAT workspace's
// untitled.md, renamed it after the import, and navigated away from the
// document the user had just opened. The switch here is deterministic — the
// fake read resolves only when the test says so — so the race is a fixture,
// not a timing hope.
//
// Run with:
//
//   cd web && npx tsx src/hosted/app/import-into-workspace.test.ts

import { importIntoWorkspace, type WorkspaceImportPort } from './import-into-workspace';
import type { PickedFile } from './import-files';
import type { ImportFileInput } from './types';

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

/* ————— fakes ————— */

interface Recorded {
  added: Array<{ workspaceId: string; paths: string[] }>;
  deleted: Array<{ workspaceId: string; path: string }>;
  renamed: Array<{ workspaceId: string; name: string }>;
  followed: Array<string | undefined>;
}

function makePort(recorded: Recorded, names: Array<{ id: string; name: string }>): WorkspaceImportPort {
  return {
    async addAssetFiles(workspaceId: string, files: ImportFileInput[]): Promise<void> {
      recorded.added.push({ workspaceId, paths: files.map((file) => file.path) });
    },
    async deleteEntry(workspaceId: string, path: string): Promise<void> {
      recorded.deleted.push({ workspaceId, path });
    },
    async renameWorkspace(workspaceId: string, name: string): Promise<void> {
      recorded.renamed.push({ workspaceId, name });
    },
    async listWorkspaces(): Promise<readonly { id: string; name: string }[]> {
      return names;
    },
  };
}

function picked(name: string): PickedFile {
  return { name, type: 'text/markdown', bytes: new TextEncoder().encode(`# ${name}`) };
}

function emptyRecord(): Recorded {
  return { added: [], deleted: [], renamed: [], followed: [] };
}

/* ————— cases ————— */

defineCase('an import that stays on screen supersedes the placeholder and follows', async () => {
  const recorded = emptyRecord();
  await importIntoWorkspace({
    workspaceId: 'ws-a',
    read: async () => [picked('plan.md')],
    port: makePort(recorded, [{ id: 'ws-a', name: 'Untitled' }]),
    scope: {
      isOnScreen: () => true,
      flushPendingEdits: async () => undefined,
      supersededPlaceholder: () => 'untitled.md',
      currentName: () => 'Untitled',
      follow: async (openPath) => {
        recorded.followed.push(openPath);
      },
    },
  });
  assertEqual(recorded.added.length, 1, 'the files landed');
  assertEqual(recorded.added[0]!.workspaceId, 'ws-a', 'in the importing workspace');
  assertEqual(recorded.deleted.length, 1, 'the empty placeholder went');
  assertEqual(recorded.deleted[0]!.workspaceId, 'ws-a', 'from the importing workspace');
  assertEqual(recorded.renamed[0]?.workspaceId, 'ws-a', 'the auto-name went to it too');
  assertEqual(recorded.renamed[0]?.name, 'plan', 'named after the import');
  assertEqual(recorded.followed[0], 'plan.md', 'and it opened what arrived');
});

defineCase('switching workspaces mid-import never touches the workspace switched to', async () => {
  const recorded = emptyRecord();
  // The switch happens exactly where it hurt: after the bytes are read, before
  // anything is written.
  let current = 'ws-a';
  await importIntoWorkspace({
    workspaceId: 'ws-a',
    read: async () => {
      current = 'ws-b';
      return [picked('plan.md')];
    },
    port: makePort(recorded, [
      { id: 'ws-a', name: 'Untitled' },
      { id: 'ws-b', name: 'Untitled' },
    ]),
    scope: {
      isOnScreen: () => current === 'ws-a',
      flushPendingEdits: async () => undefined,
      // Live reads answer for whatever is on screen — ws-b — which is exactly
      // why they must not be consulted once the workspace has changed.
      supersededPlaceholder: () => 'untitled.md',
      currentName: () => 'Untitled',
      follow: async (openPath) => {
        recorded.followed.push(openPath);
      },
    },
  });
  assertEqual(recorded.added.length, 1, 'the read files still land — nothing is lost');
  assertEqual(recorded.added[0]!.workspaceId, 'ws-a', 'in the workspace they were dropped on');
  assertEqual(recorded.deleted.length, 0, "ws-b's untitled.md survives");
  assertEqual(recorded.renamed.length, 0, 'ws-b keeps its own name');
  assertEqual(recorded.followed.length, 0, 'and the user stays in the workspace they opened');
});

defineCase('a switch after the write still leaves the new workspace alone', async () => {
  const recorded = emptyRecord();
  let current = 'ws-a';
  const port = makePort(recorded, [{ id: 'ws-a', name: 'Untitled' }]);
  await importIntoWorkspace({
    workspaceId: 'ws-a',
    read: async () => [picked('plan.md')],
    port: {
      ...port,
      // The user clicks away while the entries are being written.
      addAssetFiles: async (workspaceId, files) => {
        current = 'ws-b';
        await port.addAssetFiles(workspaceId, files);
      },
    },
    scope: {
      isOnScreen: () => current === 'ws-a',
      flushPendingEdits: async () => undefined,
      supersededPlaceholder: () => 'untitled.md',
      currentName: () => 'Untitled',
      follow: async (openPath) => {
        recorded.followed.push(openPath);
      },
    },
  });
  // The placeholder was decided while ws-a was on screen, so removing it is
  // still right — and it is removed from ws-a, by id, not from whatever is on
  // screen now.
  assertEqual(recorded.deleted.length, 1, 'the decided placeholder still goes');
  assertEqual(recorded.deleted[0]!.workspaceId, 'ws-a', 'from ws-a');
  assertEqual(recorded.renamed[0]?.workspaceId, 'ws-a', 'the rename targets ws-a');
  assertEqual(recorded.followed.length, 0, 'no navigation out of ws-b');
});

defineCase('a workspace with a name of its own is not renamed by an import', async () => {
  const recorded = emptyRecord();
  await importIntoWorkspace({
    workspaceId: 'ws-a',
    read: async () => [picked('plan.md')],
    port: makePort(recorded, [{ id: 'ws-a', name: 'Q3 notes' }]),
    scope: {
      isOnScreen: () => true,
      flushPendingEdits: async () => undefined,
      supersededPlaceholder: () => 'untitled.md',
      currentName: () => 'Q3 notes',
      follow: async () => undefined,
    },
  });
  assertEqual(recorded.renamed.length, 0, 'a named workspace keeps its name');
});

defineCase('a failed write leaves the placeholder and reports', async () => {
  const recorded = emptyRecord();
  const port = makePort(recorded, [{ id: 'ws-a', name: 'Untitled' }]);
  let thrown: unknown = null;
  try {
    await importIntoWorkspace({
      workspaceId: 'ws-a',
      read: async () => [picked('plan.md')],
      port: {
        ...port,
        addAssetFiles: async () => {
          throw new Error('quota exceeded');
        },
      },
      scope: {
        isOnScreen: () => true,
        flushPendingEdits: async () => undefined,
        supersededPlaceholder: () => 'untitled.md',
        currentName: () => 'Untitled',
        follow: async () => undefined,
      },
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error, 'the failure reaches the caller');
  assertEqual(recorded.deleted.length, 0, 'and the workspace is exactly as it was');
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
  console.log(`import-into-workspace: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
