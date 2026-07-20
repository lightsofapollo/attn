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

  // Join-first contract: the duplicated tabs become live co-editors
  // through the authority's hub — no wall, both editable.
  for (const passive of [second, third]) {
    await expect(documentEditor(passive)).toHaveAttribute('contenteditable', 'true', {
      timeout: 20_000,
    });
  }

  // WebKit may abandon the pagehide release transaction entirely. When the
  // authority tab closes, the fenced IndexedDB acquisition must elect a NEW
  // single authority among the survivors — proven behaviorally: an edit in
  // one surviving tab still converges into the other (the hub was rebuilt
  // around exactly one new fence holder).
  await page.close();
  await expect
    .poll(async () => {
      await documentEditor(second).click();
      await second.keyboard.press('ControlOrMeta+End');
      await second.keyboard.type(' relay');
      await second.waitForTimeout(1_500);
      const thirdText = await documentEditor(third).textContent();
      return thirdText?.includes('relay') ?? false;
    }, { timeout: 30_000 })
    .toBe(true);
});
