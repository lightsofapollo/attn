import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Workspace storage v3 in real browsers (attn-7xl.2.7). The Vite dev server
// transpiles the storage modules on demand, so the page imports the real
// implementation and exercises the browser's actual IndexedDB, WebCrypto,
// and OPFS. Chromium and WebKit both run (see playwright.storage.config.ts).

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageModule = `/@fs${path.join(webRoot, 'src/lib/review/browser-storage.ts')}`;
const probeModule = `/@fs${path.join(webRoot, 'src/lib/review/browser-storage-probe.ts')}`;
const leaseModule = `/@fs${path.join(webRoot, 'src/lib/review/browser-workspace-lease.ts')}`;

test('workspace create/commit survives a full page reload', async ({ page }) => {
  await page.goto('/');
  const created = await page.evaluate(async (moduleUrl) => {
    const { BrowserStorage } = await import(/* @vite-ignore */ moduleUrl);
    const storage = await BrowserStorage.open({ createIfMissing: true, databaseName: 'attn-e2e-storage' });
    const result = await storage.workspaces.createWorkspace({
      name: 'Persistence proof',
      storagePersisted: false,
      entry: {
        path: 'docs/proof.md',
        kind: 'markdown',
        body: new TextEncoder().encode('# survives reload\n'),
      },
    });
    await storage.workspaces.commitRevision({
      workspaceId: result.workspace.workspaceId,
      path: 'docs/proof.md',
      body: new TextEncoder().encode('# second revision\n'),
    });
    storage.close();
    return { workspaceId: result.workspace.workspaceId };
  }, storageModule);

  await page.reload();
  const restored = await page.evaluate(
    async ({ moduleUrl, workspaceId }) => {
      const { BrowserStorage } = await import(/* @vite-ignore */ moduleUrl);
      const storage = await BrowserStorage.open({ createIfMissing: false, databaseName: 'attn-e2e-storage' });
      const workspace = await storage.workspaces.getWorkspace(workspaceId);
      const body = await storage.workspaces.getHeadBody(workspaceId, 'docs/proof.md');
      const history = await storage.workspaces.listRevisions(workspaceId, 'docs/proof.md');
      storage.close();
      return {
        name: workspace?.name,
        body: new TextDecoder().decode(body),
        revisions: history.length,
        clocks: history.map((revision: { clock: number }) => revision.clock),
      };
    },
    { moduleUrl: storageModule, workspaceId: created.workspaceId },
  );
  expect(restored.name).toBe('Persistence proof');
  expect(restored.body).toBe('# second revision\n');
  expect(restored.revisions).toBe(2);
  expect(restored.clocks[1]).toBeGreaterThan(restored.clocks[0]!);
});

test('large bodies persist through the OPFS tier or its fallback', async ({ page }) => {
  await page.goto('/');
  const stored = await page.evaluate(async (moduleUrl) => {
    const { BrowserStorage } = await import(/* @vite-ignore */ moduleUrl);
    const storage = await BrowserStorage.open({ createIfMissing: true, databaseName: 'attn-e2e-opfs' });
    const body = new Uint8Array(700 * 1024).fill(42); // over the 512 KiB inline threshold
    const created = await storage.workspaces.createWorkspace({
      name: 'Large body',
      storagePersisted: false,
      entry: { path: 'big.bin', kind: 'asset', mediaType: 'application/octet-stream', body },
    });
    storage.close();
    return {
      workspaceId: created.workspace.workspaceId,
      location: created.revision.body.location,
    };
  }, storageModule);
  expect(['opfs', 'idb-large']).toContain(stored.location);

  await page.reload();
  const restored = await page.evaluate(
    async ({ moduleUrl, workspaceId }) => {
      const { BrowserStorage } = await import(/* @vite-ignore */ moduleUrl);
      const storage = await BrowserStorage.open({ createIfMissing: false, databaseName: 'attn-e2e-opfs' });
      const body = await storage.workspaces.getHeadBody(workspaceId, 'big.bin');
      storage.close();
      return { length: body.length, sample: body[123_456] };
    },
    { moduleUrl: storageModule, workspaceId: stored.workspaceId },
  );
  expect(restored.length).toBe(700 * 1024);
  expect(restored.sample).toBe(42);
});

test('capability probe reports an honest mode with real APIs', async ({ page, browserName }) => {
  await page.goto('/');
  const result = await page.evaluate(async (moduleUrl) => {
    const { probeStorageCapabilities } = await import(/* @vite-ignore */ moduleUrl);
    return probeStorageCapabilities({ databaseName: 'attn-e2e-probe' });
  }, probeModule);
  expect(result.indexedDb.ok, `idb probe: ${JSON.stringify(result.indexedDb)}`).toBe(true);
  expect(result.cryptoKeyClone.ok, `key probe: ${JSON.stringify(result.cryptoKeyClone)}`).toBe(true);
  // Playwright's ephemeral WebKit contexts refuse OPFS like a private
  // session, so an honest probe may report volatile there.
  expect(['persistent', 'best_effort', 'volatile']).toContain(result.mode);
  if (result.mode === 'volatile') {
    expect(result.opfs.apiPresent).toBe(true);
    expect(result.opfs.ok).toBe(false);
  }
  // Record what each engine actually reported.
  test.info().annotations.push({
    type: 'probe',
    description: `${browserName}: mode=${result.mode} opfs=${result.opfs.ok}`,
  });
});

test('cross-tab lease: second context is read-only until takeover', async ({ page, context }) => {
  await page.goto('/');
  const first = await page.evaluate(
    async ({ storageUrl, leaseUrl }) => {
      const { BrowserStorage } = await import(/* @vite-ignore */ storageUrl);
      const { WorkspaceLeaseManager } = await import(/* @vite-ignore */ leaseUrl);
      const storage = await BrowserStorage.open({ createIfMissing: true, databaseName: 'attn-e2e-lease' });
      const created = await storage.workspaces.createWorkspace({
        name: 'Leased',
        storagePersisted: false,
        entry: { path: 'a.md', kind: 'markdown', body: new TextEncoder().encode('a') },
      });
      const manager = new WorkspaceLeaseManager((storage as never as { db: IDBDatabase }).db, {
        leaseDurationMs: 60_000,
      });
      const lease = await manager.acquire(created.workspace.workspaceId, 'tab-one');
      return { workspaceId: created.workspace.workspaceId, granted: lease !== null };
    },
    { storageUrl: storageModule, leaseUrl: leaseModule },
  );
  expect(first.granted).toBe(true);

  const second = await context.newPage();
  await second.goto('/');
  const denied = await second.evaluate(
    async ({ storageUrl, leaseUrl, workspaceId }) => {
      const { BrowserStorage } = await import(/* @vite-ignore */ storageUrl);
      const { WorkspaceLeaseManager } = await import(/* @vite-ignore */ leaseUrl);
      const storage = await BrowserStorage.open({ createIfMissing: false, databaseName: 'attn-e2e-lease' });
      const manager = new WorkspaceLeaseManager((storage as never as { db: IDBDatabase }).db, {
        leaseDurationMs: 60_000,
      });
      const lease = await manager.acquire(workspaceId, 'tab-two');
      return { lease };
    },
    { storageUrl: storageModule, leaseUrl: leaseModule, workspaceId: first.workspaceId },
  );
  expect(denied.lease).toBeNull();
});
