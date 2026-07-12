import { expect, test, type Page } from '@playwright/test';

function documentEditor(page: Page) {
  return page.locator('[data-body-text] .ProseMirror');
}

test('WebKit expiry handoff elects exactly one writer after the old tab closes', async ({
  browserName,
  context,
  page,
}) => {
  test.skip(browserName !== 'webkit', 'WebKit-specific closed-page lease fallback');

  await page.goto('/app#new');
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');
  const url = page.url();

  const secondPromise = context.waitForEvent('page');
  await page.evaluate((target) => window.open(target, '_blank'), url);
  const second = await secondPromise;
  await second.waitForLoadState('domcontentloaded');

  const thirdPromise = context.waitForEvent('page');
  await page.evaluate((target) => window.open(target, '_blank'), url);
  const third = await thirdPromise;
  await third.waitForLoadState('domcontentloaded');

  for (const passive of [second, third]) {
    await expect(passive.locator('[data-degraded="lease-denied"]')).toContainText(
      'Another tab is editing this workspace.',
    );
    await expect(documentEditor(passive)).toHaveAttribute('contenteditable', 'false');
  }

  // WebKit may abandon the pagehide release transaction. Both successors can
  // wait for expiry, but the fenced IndexedDB acquisition must elect one and
  // only one writer when the stale record becomes available.
  await page.close();
  await Promise.all([
    second.getByRole('button', { name: 'Retry edit', exact: true }).click(),
    third.getByRole('button', { name: 'Retry edit', exact: true }).click(),
  ]);

  await expect.poll(async () => {
    const states = await Promise.all(
      [second, third].map((candidate) => documentEditor(candidate).getAttribute('contenteditable')),
    );
    return states.sort();
  }, { timeout: 25_000 }).toEqual(['false', 'true']);
});
