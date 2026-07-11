import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WORKSPACE_URL = '/app/w/ws-product/direction.md?shell=demo';

async function openShare(page: Page) {
  await page.goto(WORKSPACE_URL);
  const dockShare = page.locator('.thumb-dock').getByRole('button', { name: 'Share' });
  if (await dockShare.isVisible()) await dockShare.click();
  else await page.getByRole('banner').getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share for review' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create review link' })).toBeVisible();
  return dialog;
}

async function createReadyShare(page: Page) {
  const dialog = await openShare(page);
  await dialog.getByRole('button', { name: 'Create review link' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review link ready' })).toBeVisible();
  return dialog;
}

test('defaults to the focused current-file and hybrid delivery flow', async ({ page }) => {
  const dialog = await openShare(page);

  await expect(dialog.getByRole('heading', { name: 'Share for review' })).toBeFocused();
  await expect(dialog.getByRole('radio', { name: /Current file/u })).toBeChecked();
  await expect(dialog.locator('.share-manifest')).toContainText('1 entry');
  await expect(dialog.locator('.share-manifest')).toContainText('1 Markdown');
  await expect(dialog.getByText('Delivery mode Hybrid')).toBeVisible();

  await dialog.getByText('Delivery mode Hybrid').click();
  await expect(dialog.getByRole('radio', { name: /^Hybrid/u })).toBeChecked();
  await expect(dialog).toContainText('Stable links renew for 90 days');
});

test('durability states gate sharing honestly', async ({ page }) => {
  await page.goto('/app/w/ws-product/direction.md?shell=private');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const privateDialog = page.getByRole('dialog', { name: 'Share for review' });
  const create = privateDialog.getByRole('button', { name: 'Create review link' });
  await expect(privateDialog).toContainText('Private browsing is session-only');
  await expect(create).toBeDisabled();
  await privateDialog.getByRole('checkbox', { name: /I understand this browser may erase/u }).check();
  await expect(create).toBeEnabled();

  await page.keyboard.press('Escape');
  await page.goto('/app/w/ws-product/direction.md?shell=quota');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const quotaDialog = page.getByRole('dialog', { name: 'Share for review' });
  await expect(quotaDialog.getByRole('alert')).toContainText('Sharing stays unavailable');
  await expect(quotaDialog.getByRole('button', { name: 'Create review link' })).toBeDisabled();
});

test('each tier matches across browser, native, and CLI while sibling bearers stay distinct', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({
        writeText: async (value: string) => {
          (globalThis as typeof globalThis & { __attnCopied?: string }).__attnCopied = value;
        },
      }),
    });
  });
  const dialog = await createReadyShare(page);
  await expect(dialog.getByRole('radio', { name: /Comment/u })).toBeChecked();
  await dialog.getByText('Native app and CLI options').click();
  const tierSecrets: string[] = [];
  let shareId = '';
  for (const tier of ['View-only', 'Comment', 'Suggest']) {
    await dialog.getByRole('radio', { name: new RegExp(tier, 'u') }).check();
    const browserCode = dialog.locator('.share-link-row code');
    await expect(browserCode).toContainText('#key=••••');
    await dialog.getByRole('button', { name: 'Show' }).click();
    const browserUrl = (await browserCode.textContent()) ?? '';
    const inviteCodes = dialog.locator('.share-invite-option code');
    const nativeUrl = (await inviteCodes.nth(0).textContent()) ?? '';
    const cliCommand = (await inviteCodes.nth(1).textContent()) ?? '';
    const browser = new URL(browserUrl);
    const native = new URL(nativeUrl);
    expect(browser.pathname).toMatch(/^\/s\/[A-Za-z0-9_-]+$/u);
    expect(native.protocol).toBe('attn:');
    expect(native.hostname).toBe('share');
    expect(native.hash).toBe(browser.hash);
    expect(cliCommand).toContain(nativeUrl);
    shareId ||= browser.pathname.split('/').at(-1) ?? '';
    expect(browser.pathname).toBe(`/s/${shareId}`);
    tierSecrets.push(browser.hash);
    await dialog.getByRole('button', { name: 'Hide' }).click();
  }
  expect(new Set(tierSecrets).size).toBe(3);
  await dialog.getByRole('radio', { name: /Comment/u }).check();
  await dialog.getByRole('button', { name: 'Show' }).click();
  const browserUrl = (await dialog.locator('.share-link-row code').textContent()) ?? '';
  await dialog.getByRole('button', { name: /Copy Comment link/u }).click();
  expect(await page.evaluate(() =>
    (globalThis as typeof globalThis & { __attnCopied?: string }).__attnCopied,
  )).toBe(browserUrl);

  await dialog.getByRole('button', { name: 'Stop sharing' }).click();
  await dialog.getByRole('button', { name: 'Stop now' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review access is off' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create a new review link' }).click();
  await dialog.getByRole('button', { name: 'Create review link' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review link ready' })).toBeVisible();
});

test('uses Web Share when available and remains axe-clean at mobile width', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: async (payload: ShareData) => {
        (globalThis as typeof globalThis & { __attnShared?: ShareData }).__attnShared = payload;
      },
    });
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(WORKSPACE_URL);
  await page.locator('.thumb-dock').getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share for review' });
  await dialog.getByRole('button', { name: 'Create review link' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review link ready' })).toBeVisible();

  await dialog.getByRole('button', { name: /Share Comment link/u }).click();
  const payload = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __attnShared?: ShareData }).__attnShared,
  );
  expect(payload?.url).toMatch(/^https:\/\/attn\.sh\/s\/.+#key=.+/u);

  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement;
    return root ? root.scrollWidth - root.clientWidth : 0;
  });
  expect(overflow).toBe(0);
  const violations = (await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()).violations;
  expect(violations.map(({ id }) => id)).toEqual([]);
});

test('falls back to clipboard when Web Share rejects', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: async () => {
        throw new DOMException('share unavailable', 'NotAllowedError');
      },
    });
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({
        writeText: async (value: string) => {
          (globalThis as typeof globalThis & { __attnCopied?: string }).__attnCopied = value;
        },
      }),
    });
  });
  const dialog = await createReadyShare(page);
  await dialog.getByRole('button', { name: /Share Comment link/u }).click();
  const copied = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __attnCopied?: string }).__attnCopied,
  );
  expect(copied).toMatch(/^https:\/\/attn\.sh\/s\/.+#key=.+/u);
  await expect(dialog.getByRole('status').filter({ hasText: /browser link was copied/u }).first()).toBeVisible();
});

test('mobile permission tier rows meet 44px touch targets', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const dialog = await createReadyShare(page);
  const tierHeights = await dialog.locator('.share-tier-picker label').evaluateAll((labels) =>
    labels.map((label) => label.getBoundingClientRect().height),
  );
  for (const height of tierHeights) expect(height).toBeGreaterThanOrEqual(44);
});

test('destructive confirmation takes keyboard focus', async ({ page }) => {
  const dialog = await openShare(page);
  await dialog.getByRole('button', { name: 'Create review link' }).click();
  await dialog.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(dialog.getByRole('button', { name: 'Keep sharing' })).toBeFocused();
});
