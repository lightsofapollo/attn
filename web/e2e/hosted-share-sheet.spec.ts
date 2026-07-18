// ShareSheet contract (post-redesign: file checkboxes + sentence-pattern
// permissions + quiet chrome). Runs against the `?shell=` mock scenarios via
// playwright.routes.config.ts. attn-y6y: the previous revision asserted the
// retired "Share for review" dialog (scope radios, tier radio rows, the
// storage risk-gate checkboxes) — this one matches the shipped sheet.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WORKSPACE_URL = '/app/w/ws-product/direction.md?shell=demo';
const DIALOG_NAME = 'Share files for review';
const CREATE_BUTTON = /Create review link for \d+ files?/u;

async function openShare(page: Page, url: string = WORKSPACE_URL) {
  await page.goto(url);
  const headerShare = page.locator('.editor-top').getByRole('button', { name: 'Share' });
  if (await headerShare.isVisible()) await headerShare.click();
  else await page.getByRole('button', { name: 'Share for review' }).click();
  const dialog = page.getByRole('dialog', { name: DIALOG_NAME });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function createReadyShare(page: Page) {
  const dialog = await openShare(page);
  await dialog.getByRole('button', { name: CREATE_BUTTON }).click();
  await expect(dialog.locator('.share-ready-scope')).toContainText('shared');
  return dialog;
}

test('defaults to the focused current file with hybrid delivery behind Advanced', async ({ page }) => {
  const dialog = await openShare(page);

  await expect(dialog.getByRole('heading', { name: DIALOG_NAME })).toBeFocused();
  // The active document is pre-checked; sharing is opt-in per file.
  await expect(dialog.locator('.share-entry-current input[type="checkbox"]')).toBeChecked();
  await expect(dialog.locator('.share-manifest')).toContainText('1 file selected');
  await expect(dialog.locator('.share-manifest')).toContainText('1 Markdown');
  await expect(dialog.getByRole('button', { name: CREATE_BUTTON })).toBeEnabled();

  const advanced = dialog.locator('.share-advanced > summary');
  await expect(advanced).toContainText('Advanced settings');
  await expect(advanced).toContainText('Hybrid delivery');
  await advanced.click();
  await expect(dialog.getByRole('radio', { name: /^Hybrid/u })).toBeChecked();
  await expect(dialog).toContainText('Hybrid is recommended');
});

test('select-all and clear drive the manifest and create gate', async ({ page }) => {
  const dialog = await openShare(page);
  await dialog.getByRole('button', { name: 'Select all' }).click();
  await expect(dialog.locator('.share-manifest')).not.toContainText('1 file selected');
  await dialog.getByRole('button', { name: 'Clear' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Select at least one Markdown file');
  await expect(dialog.getByRole('button', { name: CREATE_BUTTON })).toBeDisabled();
});

test('durability states gate sharing honestly', async ({ page }) => {
  // Quota pressure hard-blocks creation with a plain-language reason.
  const quotaDialog = await openShare(page, '/app/w/ws-product/direction.md?shell=quota');
  await expect(quotaDialog).toContainText('Sharing is unavailable until local storage is healthy.');
  await expect(quotaDialog.getByRole('button', { name: CREATE_BUTTON })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Session-only storage (private browsing) shares without a risk-gate — the
  // redesign deliberately removed the confirmation checkbox flow.
  const privateDialog = await openShare(page, '/app/w/ws-product/direction.md?shell=private');
  await expect(privateDialog.getByRole('button', { name: CREATE_BUTTON })).toBeEnabled();
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
  const tierSelect = dialog.getByRole('combobox', { name: 'What this link allows' });
  await expect(tierSelect).toHaveValue('comment');

  const linkChip = dialog.locator('.share-link-chip');
  await dialog.getByText('Native app & CLI').click();
  const tierSecrets: string[] = [];
  let shareId = '';
  for (const tier of ['view', 'comment', 'suggest']) {
    await tierSelect.selectOption(tier);
    // Key stays masked until deliberately revealed.
    await expect(linkChip).toHaveAttribute('aria-pressed', 'false');
    await expect(linkChip.locator('code')).toContainText('•');
    await linkChip.click();
    const browserUrl = (await linkChip.locator('code').textContent()) ?? '';
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
    await linkChip.click();
  }
  expect(new Set(tierSecrets).size).toBe(3);

  await tierSelect.selectOption('comment');
  await linkChip.click();
  const browserUrl = (await linkChip.locator('code').textContent()) ?? '';
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  expect(await page.evaluate(() =>
    (globalThis as typeof globalThis & { __attnCopied?: string }).__attnCopied,
  )).toBe(browserUrl);
});

test('stop sharing confirms destructively, then a new link can be minted', async ({ page }) => {
  const dialog = await createReadyShare(page);
  await dialog.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(dialog).toContainText('Reviewers lose access immediately.');
  await expect(dialog.getByRole('button', { name: 'Keep sharing' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Stop now' }).click();
  await expect(dialog.getByRole('heading', { name: 'Sharing stopped' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create a new link' }).click();
  await dialog.getByRole('button', { name: CREATE_BUTTON }).click();
  await expect(dialog.locator('.share-ready-scope')).toContainText('shared');
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
  await page.locator('.editor-top').getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog', { name: DIALOG_NAME });
  await dialog.getByRole('button', { name: CREATE_BUTTON }).click();
  await expect(dialog.locator('.share-ready-scope')).toContainText('shared');

  await dialog.getByRole('button', { name: 'Share via system share sheet' }).click();
  const payload = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __attnShared?: ShareData }).__attnShared,
  );
  expect(payload?.url).toMatch(/^https:\/\/(?:staging\.)?attn\.sh\/s\/.+#key=.+/u);

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
  await dialog.getByRole('button', { name: 'Share via system share sheet' }).click();
  const copied = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __attnCopied?: string }).__attnCopied,
  );
  expect(copied).toMatch(/^https:\/\/(?:staging\.)?attn\.sh\/s\/.+#key=.+/u);
  await expect(dialog.getByRole('status').filter({ hasText: /browser link was copied/u }).first()).toBeVisible();
});

test('mobile file rows meet 44px touch targets', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const dialog = await openShare(page);
  const rowHeights = await dialog.locator('.share-entry-list label').evaluateAll((labels) =>
    labels.map((label) => label.getBoundingClientRect().height),
  );
  expect(rowHeights.length).toBeGreaterThan(0);
  for (const height of rowHeights) expect(height).toBeGreaterThanOrEqual(44);
});
