import { expect, test, type Page } from '@playwright/test';

// Multi-entry routing smoke (attn-7xl.1.1). Asserts that the worker serves
// the right HTML entry for every route family without redirecting deep paths,
// and that the landing navigation never preloads editor/crypto chunks.

const FORBIDDEN_ON_LANDING = /prosemirror|mermaid|katex|noble|BrowserReviewApp|\/assets\/(?:review|app)-/iu;

function captureAssetRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    urls.push(request.url());
  });
  return urls;
}

test('landing serves at / without editor, crypto, or other-entry chunks', async ({ page }) => {
  const requests = captureAssetRequests(page);
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.locator('body[data-route="landing"]')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('A private desk for working documents.');
  await expect(page.locator('body')).toHaveAttribute('data-hydrated', 'true');
  expect(requests.some((url) => /\/assets\/landing-/u.test(url))).toBe(true);
  const forbidden = requests.filter((url) => FORBIDDEN_ON_LANDING.test(new URL(url).pathname));
  expect(forbidden).toEqual([]);
});

test('landing leads with browser CTAs and keeps native install below', async ({ page }) => {
  await page.goto('/');
  const hero = page.locator('.hero');
  await expect(hero.locator('a[data-action="new-workspace"]')).toHaveAttribute('href', '/app#new');
  await expect(hero.locator('a[data-action="open-desk"]')).toHaveAttribute('href', '/app');
  await expect(page.locator('.native-section .code').first()).toContainText(
    'brew install lightsofapollo/attn/attn',
  );
  await expect(page.locator('.site-nav a[href="https://github.com/lightsofapollo/attn"]')).toBeVisible();
  // The browser is now a first-class surface; the old native-only claim is gone.
  await expect(page.locator('body')).not.toContainText('No browser tab');
});

test('landing theme toggle flips palette, swaps captures, and persists', async ({ page }) => {
  await page.goto('/');
  const heroShot = page.locator('.product-stage .window img');
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(initialTheme).toBe('light'); // Playwright defaults to prefers-color-scheme: light
  await expect(heroShot).toHaveAttribute('src', /collab-light/u);
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(heroShot).toHaveAttribute('src', /collab-dark/u);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('landing has no horizontal scrolling at 320 CSS px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-hydrated', 'true');
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement;
    return root ? root.scrollWidth - root.clientWidth : 0;
  });
  expect(overflow).toBe(0);
});

test('capture landing screenshots for design review', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-hydrated', 'true');
  await page.screenshot({ path: 'test-results/landing-desktop-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/landing-desktop-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'test-results/landing-iphone-light.png', fullPage: true });
});

test('unknown paths fall back to the landing entry', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(200);
  await expect(page.locator('body[data-route="landing"]')).toBeVisible();
});

for (const [path, view, headingHint] of [
  ['/app', 'home', 'Your desk'],
  ['/app/storage', 'storage', 'Storage & recovery'],
  ['/open', 'open', 'Import into your desk'],
  ['/app/w/ws-product/direction.md', 'workspace', 'Product direction'],
] as const) {
  test(`app entry serves ${path} without redirecting`, async ({ page }) => {
    // The fixture workspace lives in the mock service (?shell=demo).
    const response = await page.goto(`${path}?shell=demo`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('body[data-route="app"]')).toBeVisible();
    await expect(page.locator('[data-app-view]')).toHaveAttribute('data-app-view', view);
    await expect(page.locator('h1')).toHaveText(headingHint);
    expect(new URL(page.url()).pathname).toBe(path);
  });
}

test('review entry serves deep room paths without redirecting', async ({ page }) => {
  const requests = captureAssetRequests(page);
  const response = await page.goto('/review/room-e2e-canary');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Attn review');
  expect(new URL(page.url()).pathname).toBe('/review/room-e2e-canary');
  expect(requests.some((url) => /\/assets\/review-/u.test(url))).toBe(true);
  expect(requests.some((url) => /\/assets\/landing-/u.test(url))).toBe(false);
});

test('review entry serves durable share paths without redirecting', async ({ page }) => {
  const response = await page.goto('/s/AAAAAAAAAAAAAAAAAAAAAA');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Attn review');
  expect(new URL(page.url()).pathname).toBe('/s/AAAAAAAAAAAAAAAAAAAAAA');
});
