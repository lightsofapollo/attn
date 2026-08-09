// The share sheet in the RAW BROWSER DEV LOOP (attn-bw2h.6).
//
// The reported symptom was the sheet sitting on "Creating the encrypted room
// and minting invite links…" with all three tiers reading "Preparing … link…".
// Those strings live only in `src/lib/ShareDialog.svelte`, which only
// `src/App.svelte` mounts — i.e. this loop, where there is no wry host and
// `installMockIpc()` stands in for the daemon. The mock answered
// `review_share` with a status and no ShareReady, so no invite could ever
// arrive and the sheet pended for its full 15s deadline on every share.
//
// Two things are pinned here, and they are different failures:
//
//  1. The mint COMPLETES. Three tier links, correctly shaped and genuinely
//     distinct. This is the bug the user hit.
//  2. A mint that cannot complete still resolves inside its deadline
//     (attn-vlmz.1.2). Measured at ~15.0s against MINT_TIMEOUT_MS — the
//     screenshot in the bug report was taken inside that window, so the
//     deadline was never broken, and this keeps it that way. A regression
//     here is invisible to every unit test: the timer lives in component
//     state that `tsx` cannot reach.
//
//   cd web && npx playwright test --config playwright.native-share.config.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/basic.md',
);

/** MINT_TIMEOUT_MS in ShareDialog.svelte. */
const MINT_TIMEOUT_MS = 15_000;

/**
 * Boot the raw dev loop with a document open and the share sheet on screen.
 *
 * The mock init payload carries no path, so the app lands on OpenLocalFiles;
 * feeding its hidden `<input type=file>` is how a browser user gets in. The
 * name prompt then intercepts the first share — App.svelte resumes into the
 * dialog once it is dismissed.
 */
async function openShareSheet(page: Page) {
  await page.goto('/');
  const picker = page.locator('input[type=file]').first();
  await picker.waitFor({ state: 'attached' });
  await picker.setInputFiles(FIXTURE);

  await page.locator('[data-slot=native-header-share]').click();
  const namePrompt = page.getByRole('button', { name: /^(Skip|Continue)$/u }).first();
  if (await namePrompt.isVisible().catch(() => false)) await namePrompt.click();

  const dialog = page.locator('[data-slot="share-dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Drop `review_share` on the floor so no ShareReady can arrive, whatever the
 * mock does. Without this the spec would silently stop testing the deadline
 * the moment the mock learns to mint. Every other message still flows.
 */
async function swallowShareRequests(page: Page) {
  await page.evaluate(() => {
    const ipc = (window as unknown as { ipc?: { postMessage(m: string): void } }).ipc;
    if (!ipc) throw new Error('no window.ipc — mock IPC did not install');
    const original = ipc.postMessage.bind(ipc);
    ipc.postMessage = (message: string) => {
      if (JSON.parse(message).type === 'review_share') return;
      original(message);
    };
  });
}

/** Read a tier's URL by copying it, since the sheet never renders one inline. */
async function copyTier(page: Page, dialog: ReturnType<Page['locator']>, tier: string) {
  await dialog.locator(`[data-slot="share-tier-${tier}"]`).click();
  return page.evaluate(() => (globalThis as { __copied?: string }).__copied ?? '');
}

test('the mint completes and offers three genuinely distinct tier links', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({
        writeText: async (value: string) => {
          (globalThis as { __copied?: string }).__copied = value;
        },
      }),
    });
  });
  const dialog = await openShareSheet(page);
  await dialog.getByRole('button', { name: /Create review link for/u }).click();

  // The state that was unreachable before: links, no pending rows, no error.
  await expect(dialog.locator('[data-slot="share-tier-links"]')).toBeVisible();
  await expect(dialog.locator('[data-slot="share-tier-pending"]')).toHaveCount(0);
  await expect(dialog.locator('[data-slot="share-error"]')).toHaveCount(0);

  const urls = {
    view: await copyTier(page, dialog, 'view'),
    comment: await copyTier(page, dialog, 'comment'),
    suggest: await copyTier(page, dialog, 'suggest'),
  };
  const fragments = Object.fromEntries(
    Object.entries(urls).map(([tier, url]) => [tier, new URLSearchParams(new URL(url).hash.slice(1))]),
  );

  // Three links, one room.
  expect(new Set(Object.values(urls).map((url) => new URL(url).pathname)).size).toBe(1);
  expect(new Set(Object.values(urls).map((url) => new URL(url).hash)).size).toBe(3);

  // The tier boundary is cryptographic, not a label: read derives from the one
  // room secret and is shared, `view` carries no write capability and no
  // grant, and the two writable tiers are separated by DIFFERENT grants — a
  // signature over the tier name. Three interchangeable URLs would teach this
  // loop a false model of the product, so assert the real shape.
  expect(new Set(Object.values(fragments).map((f) => f.get('read'))).size).toBe(1);
  expect(fragments.view.get('write')).toBeNull();
  expect(fragments.view.get('grant')).toBeNull();
  for (const tier of ['comment', 'suggest'] as const) {
    expect(fragments[tier].get('tier')).toBe(tier);
    expect(fragments[tier].get('write')).toBeTruthy();
    expect(fragments[tier].get('grant')).toBeTruthy();
  }
  expect(fragments.comment.get('grant')).not.toBe(fragments.suggest.get('grant'));
});

test('a mint that never answers resolves to an explicit error within its deadline', async ({ page }) => {
  const dialog = await openShareSheet(page);
  await swallowShareRequests(page);

  const started = Date.now();
  await dialog.getByRole('button', { name: /Create review link for/u }).click();

  // The pending UI is correct while it lasts — assert it is actually shown, so
  // a sheet that errors instantly for some unrelated reason cannot pass.
  await expect(dialog.locator('[data-slot="share-tier-pending"]')).toBeVisible();
  await expect(dialog.locator('[data-slot="share-minting"]')).toBeVisible();

  const error = dialog.locator('[data-slot="share-error"]');
  await expect(error).toBeVisible({ timeout: MINT_TIMEOUT_MS + 10_000 });
  const elapsed = Date.now() - started;

  // Explicit, and carrying a way out — an error the owner cannot act on is
  // barely better than the spinner it replaced.
  await expect(error).not.toBeEmpty();
  await expect(dialog.locator('[data-slot="share-retry"]')).toBeVisible();

  // Every pending surface must be gone, not merely covered.
  await expect(dialog.locator('[data-slot="share-tier-pending"]')).toHaveCount(0);
  await expect(dialog.locator('[data-slot="share-minting"]')).toHaveCount(0);
  await expect(dialog.locator('[data-slot="share-minting-description"]')).toHaveCount(0);

  // Bracketed on both sides: too early means the deadline is not what bounds
  // this, too late means it no longer bounds it.
  expect(elapsed).toBeGreaterThan(MINT_TIMEOUT_MS * 0.5);
  expect(elapsed).toBeLessThan(MINT_TIMEOUT_MS + 5_000);
});

test('retrying after the deadline re-arms it rather than pending forever', async ({ page }) => {
  const dialog = await openShareSheet(page);
  await swallowShareRequests(page);
  await dialog.getByRole('button', { name: /Create review link for/u }).click();
  await expect(dialog.locator('[data-slot="share-error"]')).toBeVisible({
    timeout: MINT_TIMEOUT_MS + 10_000,
  });

  // A retry re-enters 'minting'. If the second attempt did not arm its own
  // timer the sheet would pend forever from here — the failure mode is one
  // click deeper than the one that was reported, and just as permanent.
  await dialog.locator('[data-slot="share-retry"]').click();
  await expect(dialog.locator('[data-slot="share-tier-pending"]')).toBeVisible();
  await expect(dialog.locator('[data-slot="share-error"]')).toBeVisible({
    timeout: MINT_TIMEOUT_MS + 10_000,
  });
  await expect(dialog.locator('[data-slot="share-tier-pending"]')).toHaveCount(0);
});
