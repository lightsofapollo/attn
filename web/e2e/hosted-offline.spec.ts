import { expect, test } from '@playwright/test';

// Service worker / offline shell behavior (attn-7xl.6.2). Runs against the
// real Cloudflare worker (wrangler dev) with the built /sw.js.

test('offline launch serves the cached shell and local content survives', async ({
  page,
  context,
}) => {
  test.slow();
  // First visit: create real local content, register + activate the SW.
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state === 'active';
  });
  // Second online load routes assets through the SW into the asset cache.
  await page.reload();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();

  // Offline: navigation falls back to the cached shell; IndexedDB content
  // renders because nothing user-authored lives in HTTP caches.
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible({ timeout: 30_000 });
  // The workspace name is the witness, not a file name: this workspace has no
  // chosen document yet, so the header names only the workspace. The point here
  // is unchanged — it came back from IndexedDB with the network down.
  await expect(page.locator('.owner-project-name').first()).toContainText('Untitled');
  await context.setOffline(false);
});

test('caches contain only immutable assets and entry shells — nothing else', async ({ page }) => {
  await page.goto('/app?probe=1'); // query param: the SW must bypass this
  await page.goto('/app');
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state === 'active';
  });
  await page.reload();
  await page.goto('/review/room-cache-test');
  const inventory = await page.evaluate(async () => {
    const names = await caches.keys();
    const entries: Record<string, string[]> = {};
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      entries[name] = keys.map((request) => new URL(request.url).pathname + new URL(request.url).search);
    }
    return entries;
  });
  expect(Object.keys(inventory).sort()).toEqual(['attn-assets-v1', 'attn-shell-v1']);
  for (const path of inventory['attn-shell-v1']!) {
    expect(['/', '/app/', '/review/']).toContain(path);
  }
  const allowedAsset = /^\/assets\/[\w.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$|^\/(manifest\.webmanifest|favicon\.png|icon\.png|icon-192\.png|icon-512\.png|apple-touch-icon\.png)$/u;
  for (const path of inventory['attn-assets-v1']!) {
    expect(path, `unexpected cached asset ${path}`).toMatch(allowedAsset);
    expect(path.includes('?'), 'no query strings in cache').toBe(false);
  }
});

test('manifest describes an installable standalone app', async ({ page }) => {
  const response = await page.goto('/manifest.webmanifest');
  expect(response?.status()).toBe(200);
  const manifest = JSON.parse(await response!.text());
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/app');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  // Icons resolve.
  for (const icon of manifest.icons) {
    const iconResponse = await page.request.get(icon.src);
    expect(iconResponse.status(), icon.src).toBe(200);
  }
});

test('blocked IndexedDB degrades to an honest unavailable state', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: false });
  });
  await page.goto('/app');
  await expect(page.locator('body')).toContainText(
    'This browser currently blocks local document storage',
    { timeout: 30_000 },
  );
});
