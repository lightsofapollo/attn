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

test('unknown paths fall back to the landing entry', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(200);
  await expect(page.locator('body[data-route="landing"]')).toBeVisible();
});

for (const [path, view, headingHint] of [
  ['/app', 'home', 'On this device'],
  ['/app/storage', 'storage', 'Storage & recovery'],
  ['/open', 'open', 'Import into your desk'],
  ['/app/w/ws1/docs/notes.md', 'workspace', 'Workspace ws1 — docs/notes.md'],
] as const) {
  test(`app entry serves ${path} without redirecting`, async ({ page }) => {
    const response = await page.goto(path);
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
