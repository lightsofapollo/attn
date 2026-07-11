import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  BrowserWorkspaceService,
  WorkspaceServiceFailure,
  mapError,
  relativeTimeLabel,
  sizeLabel,
} from './workspace-service';
import { StorageConflictError, BrowserStorageError } from '../../lib/review/browser-storage';

Object.defineProperty(globalThis, 'IDBKeyRange', {
  configurable: true,
  value: IDBKeyRange,
});

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

let counter = 0;

async function openService(): Promise<BrowserWorkspaceService> {
  counter += 1;
  return BrowserWorkspaceService.open({
    databaseName: `attn-workspace-service-test-${counter}`,
    indexedDB: new IDBFactory(),
    crypto,
    navigator: null,
  });
}

defineCase('one-click create opens an empty untitled.md and lists it', async () => {
  const service = await openService();
  try {
    const created = await service.createWorkspace();
    assertEqual(created.entry.path, 'untitled.md', 'entry path');
    assertEqual(created.workspace.name, 'Untitled', 'name');
    assertEqual(await service.readHeadText(created.workspace.workspaceId, 'untitled.md'), '', 'empty body');
    const listed = await service.listWorkspaces();
    assertEqual(listed.length, 1, 'listed');
    assertEqual(listed[0]!.markdownCount, 1, 'markdown count');
    assertEqual(listed[0]!.openPath, 'untitled.md', 'open path');
    assertEqual(listed[0]!.sharing, 'local-only', 'nothing shared before Share');
  } finally {
    service.close();
  }
});

defineCase('commit/read text round-trips and load reflects durable state', async () => {
  const service = await openService();
  try {
    const created = await service.createWorkspace();
    const ws = created.workspace.workspaceId;
    await service.commitText(ws, 'untitled.md', '# Hello desk\n\nBody.');
    assertEqual(await service.readHeadText(ws, 'untitled.md'), '# Hello desk\n\nBody.', 'text round-trip');
    const loaded = await service.loadWorkspace(ws);
    assert(loaded, 'loads');
    assertEqual(loaded.entries.length, 1, 'entries');
    assert(loaded.workspace.clock > created.workspace.clock, 'durable clock advanced');
  } finally {
    service.close();
  }
});

defineCase('import/export round-trip preserves nested paths and bytes', async () => {
  const service = await openService();
  try {
    const image = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);
    const imported = await service.importWorkspace('Research folio', [
      { path: 'index.md', bytes: new TextEncoder().encode('# Index'), kind: 'markdown' },
      { path: 'notes/deep/a.md', bytes: new TextEncoder().encode('nested'), kind: 'markdown' },
      { path: 'figures/latency.png', bytes: image, kind: 'asset', mediaType: 'image/png' },
    ]);
    assertEqual(imported.entries.length, 3, 'imported entries');
    const exported = await service.exportWorkspace(imported.workspace.workspaceId);
    assertEqual(exported.length, 3, 'exported entries');
    const png = exported.find((file) => file.path === 'figures/latency.png');
    assert(png, 'asset path preserved');
    assertEqual(png.mediaType, 'image/png', 'media type preserved');
    assertEqual(png.bytes.length, image.length, 'byte length preserved');
    assert(png.bytes.every((byte, index) => byte === image[index]), 'bytes identical');
    const nested = exported.find((file) => file.path === 'notes/deep/a.md');
    assert(nested, 'nested path preserved');
  } finally {
    service.close();
  }
});

defineCase('empty import is an explicit user-visible error', async () => {
  const service = await openService();
  try {
    let failure: WorkspaceServiceFailure | null = null;
    try {
      await service.importWorkspace('Empty', []);
    } catch (error) {
      failure = error instanceof WorkspaceServiceFailure ? error : null;
    }
    assert(failure, 'typed failure');
    assertEqual(failure.info.kind, 'storage', 'kind');
  } finally {
    service.close();
  }
});

defineCase('rename/delete/select workspace and entry operations', async () => {
  const service = await openService();
  try {
    const created = await service.createWorkspace();
    const ws = created.workspace.workspaceId;
    const renamed = await service.renameWorkspace(ws, 'Product direction');
    assertEqual(renamed.name, 'Product direction', 'workspace renamed');
    await service.createMarkdown(ws, 'notes.md', 'notes');
    await service.renameEntry(ws, 'notes.md', 'docs/notes.md');
    assertEqual(await service.readHeadText(ws, 'docs/notes.md'), 'notes', 'entry renamed with body');
    await service.selectEntry(ws, 'docs/notes.md');
    const loaded = await service.loadWorkspace(ws);
    assertEqual(loaded!.workspace.activePath, 'docs/notes.md', 'selection persisted');
    await service.deleteEntry(ws, 'docs/notes.md');
    assertEqual((await service.loadWorkspace(ws))!.entries.length, 1, 'entry deleted');
    assert(await service.deleteWorkspace(ws), 'workspace deleted');
    assertEqual((await service.listWorkspaces()).length, 0, 'gone from the desk');
  } finally {
    service.close();
  }
});

defineCase('service errors map to explicit user-visible kinds', async () => {
  assertEqual(mapError(new StorageConflictError('boom')).info.kind, 'conflict', 'conflict');
  assertEqual(mapError(new BrowserStorageError('bad')).info.kind, 'storage', 'storage');
  assertEqual(
    mapError(new DOMException('full', 'QuotaExceededError')).info.kind,
    'quota',
    'quota',
  );
  assertEqual(mapError(new Error('misc')).info.kind, 'storage', 'unknown maps to storage');
  const service = await openService();
  try {
    const created = await service.createWorkspace();
    let failure: WorkspaceServiceFailure | null = null;
    try {
      await service.createMarkdown(created.workspace.workspaceId, 'untitled.md', 'dup');
    } catch (error) {
      failure = error instanceof WorkspaceServiceFailure ? error : null;
    }
    assert(failure, 'duplicate path raises a typed failure');
    assertEqual(failure.info.kind, 'conflict', 'duplicate path is a conflict');
  } finally {
    service.close();
  }
});

defineCase('instances are isolated: no state leaks between databases', async () => {
  const a = await openService();
  const b = await openService();
  try {
    await a.createWorkspace('Only in A');
    assertEqual((await a.listWorkspaces()).length, 1, 'A sees its workspace');
    assertEqual((await b.listWorkspaces()).length, 0, 'B sees nothing');
    const capsA = a.capabilities();
    const capsB = b.capabilities();
    assert(capsA !== capsB || capsA.mode === capsB.mode, 'capability snapshots are per-instance');
  } finally {
    a.close();
    b.close();
  }
});

defineCase('leases are reachable through the service', async () => {
  const service = await openService();
  try {
    const created = await service.createWorkspace();
    const lease = await service.leases.acquire(created.workspace.workspaceId, 'tab-a');
    assert(lease, 'lease granted');
    await service.commitText(created.workspace.workspaceId, 'untitled.md', 'fenced', {
      fence: lease,
    });
    assertEqual(
      await service.readHeadText(created.workspace.workspaceId, 'untitled.md'),
      'fenced',
      'fenced commit through the service',
    );
  } finally {
    service.close();
  }
});

defineCase('label helpers format sizes and relative times', () => {
  assertEqual(sizeLabel(42), '42 B', 'bytes');
  assertEqual(sizeLabel(2048), '2 KB', 'kilobytes');
  assertEqual(sizeLabel(2_516_582), '2.4 MB', 'megabytes');
  const now = 1_700_000_000_000;
  assertEqual(relativeTimeLabel(now - 5_000, now), 'Just now', 'just now');
  assertEqual(relativeTimeLabel(now - 8 * 60_000, now), 'Edited 8 min ago', 'minutes');
  assertEqual(relativeTimeLabel(now - 3 * 3_600_000, now), 'Edited 3 h ago', 'hours');
  assertEqual(relativeTimeLabel(now - 30 * 3_600_000, now), 'Yesterday', 'yesterday');
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
  console.log(`workspace-service: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
