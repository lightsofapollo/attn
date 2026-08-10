import { expect, test, type Page } from '@playwright/test';

// Multi-entry routing smoke (attn-7xl.1.1). Asserts that the worker serves
// the right HTML entry for every route family without redirecting deep paths,
// and that the landing navigation never preloads editor/crypto chunks.

const FORBIDDEN_ON_LANDING = /prosemirror|mermaid|katex|noble|BrowserReviewApp|\/assets\/(?:review|app)-/iu;

/* The desk lists workspace names. It must not fetch the editor, the markdown
   parser, or the crypto suite to do it (attn-n01r.41).
   Chunk names are content-hashed but the vendor stems are stable, which is what
   these match on. */
const FORBIDDEN_ON_DESK = /prosemirror|mermaid|katex|schema-|BrowserReviewApp/iu;

/* Runtime script-byte budgets per route, in KB.
   check-route-bundles.mjs walks the Vite manifest's static `imports` and reports
   green while an awaited dynamic import pulls the same graph over the wire —
   that is how ~600 KB shipped to the desk under a passing gate. A static-manifest
   gate structurally cannot see this; only measuring what the browser actually
   fetches can. Headroom over the measured values is deliberate but small: these
   should fail on a regression, not absorb one. */
const SCRIPT_BUDGET_KB: Record<string, number> = {
  '/': 110,      // measured ~72 KB
  '/app': 500,   // measured ~414 KB
};

async function measureScriptKb(page: Page, path: string): Promise<number> {
  let bytes = 0;
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script') return;
    const length = Number(response.headers()['content-length'] ?? 0);
    if (Number.isFinite(length)) bytes += length;
  });
  await page.goto(path, { waitUntil: 'networkidle' });
  return bytes / 1024;
}

function captureAssetRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    urls.push(request.url());
  });
  return urls;
}

const LANDING_CAPTURE_IMAGES = '.product-stage img, .share-proof .capture img, .native-shot img';

async function waitForLandingCaptureImages(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const images = page.locator(LANDING_CAPTURE_IMAGES);
  await expect(images).toHaveCount(3);

  // `fullPage` screenshots do not guarantee that below-the-fold lazy images
  // have entered the loading viewport. Visit and decode each capture so a
  // theme swap can never leave a blank or stale frame in the visual baseline.
  for (let index = 0; index < 3; index += 1) {
    const image = images.nth(index);
    await image.scrollIntoViewIfNeeded();
    await image.evaluate(async (element) => {
      const img = element as HTMLImageElement;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const sourceAtStart = img.currentSrc;
        if (!img.complete) {
          await new Promise<void>((resolve, reject) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => reject(new Error(`failed to load ${img.currentSrc}`)), {
              once: true,
            });
          });
        }
        try {
          await img.decode();
        } catch (error) {
          // WebKit aborts decode when responsive source selection settles.
          // Retry the newly selected source instead of capturing mid-swap.
          if (!(error instanceof DOMException) || error.name !== 'EncodingError') throw error;
        }
        if (img.complete && img.naturalWidth > 0 && img.currentSrc === sourceAtStart) return;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      throw new Error(`image source did not settle: ${img.currentSrc}`);
    });
  }

  await expect
    .poll(async () =>
      images.evaluateAll(
        (elements, expectedTheme) =>
          elements.every((element) =>
            (element as HTMLImageElement).currentSrc.includes(`-${expectedTheme}-`),
          ),
        theme,
      ),
    )
    .toBe(true);
  // Let the sticky navigation's compositor layer settle back at the document
  // origin. Capturing in the same frame as the final lazy-image scroll places
  // the nav halfway down a full-page screenshot in Chromium/WebKit.
  await page.evaluate(async () => {
    window.scrollTo({ top: 0 });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
}

test('landing serves at / without editor, crypto, or other-entry chunks', async ({ page }) => {
  const requests = captureAssetRequests(page);
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.locator('body[data-route="landing"]')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('Review it together. Even when they aren\u2019t human.');
  // The page must actually argue the product's positioning (attn-n01r.10):
  // PRODUCT.md calls attn "the reviewer for agent-authored docs", and the
  // landing previously said "agent" and "AI" zero times.
  await expect(page.locator('body')).toContainText(/agent/iu);
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
  await waitForLandingCaptureImages(page, 'light');
  expect(
    await page.locator(LANDING_CAPTURE_IMAGES).evaluateAll((images) =>
      images.every((image) => image.getAttribute('width') === '1920' && image.getAttribute('height') === '1440'),
    ),
  ).toBe(true);
  expect(await heroShot.evaluate((image) => (image as HTMLImageElement).currentSrc)).toMatch(/\.avif$/u);
  await page.getByRole('button', { name: /^Switch to (dark|light) theme$/u }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(heroShot).toHaveAttribute('src', /collab-dark/u);
  await waitForLandingCaptureImages(page, 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await waitForLandingCaptureImages(page, 'dark');
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
  await waitForLandingCaptureImages(page, 'light');
  await page.screenshot({ path: 'test-results/landing-desktop-light.png', fullPage: true });
  await page.getByRole('button', { name: /^Switch to (dark|light) theme$/u }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await waitForLandingCaptureImages(page, 'dark');
  await page.screenshot({ path: 'test-results/landing-desktop-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // The nav collapses to a hamburger below the mid tier, so the theme control
  // lives inside the disclosure. This test asserted it was clickable at 390
  // without opening the menu and had been failing on main for that reason.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: /^Switch to (dark|light) theme$/u }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await waitForLandingCaptureImages(page, 'light');
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

test('the desk never fetches the editor or crypto graph', async ({ page }) => {
  const requests = captureAssetRequests(page);
  await page.goto('/app', { waitUntil: 'networkidle' });
  const forbidden = requests.filter((url) => FORBIDDEN_ON_DESK.test(new URL(url).pathname));
  expect(forbidden, `desk fetched forbidden chunks: ${forbidden.join(', ')}`).toEqual([]);
});

for (const [route, budgetKb] of Object.entries(SCRIPT_BUDGET_KB)) {
  test(`${route} stays inside its script budget (${budgetKb} KB)`, async ({ page }) => {
    const actual = await measureScriptKb(page, route);
    expect(
      actual,
      `${route} shipped ${actual.toFixed(1)} KB of script against a ${budgetKb} KB budget`,
    ).toBeLessThan(budgetKb);
  });
}
