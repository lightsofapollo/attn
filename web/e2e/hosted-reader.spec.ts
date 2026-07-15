import { expect, test } from '@playwright/test';

// iOS reader surface matrix (attn-7xl.3.7): runs on Chromium AND WebKit via
// playwright.storage.config.ts (Vite dev server, real route rewrites in the
// dev middleware). Demo fixtures give the reader a long scrollable document.

const READER_PATH = '/app/w/ws-product/direction.md?shell=demo';

for (const width of [320, 375, 390, 430]) {
  test(`phone reader at ${width}px: legible measure, no page overflow, dock reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto(READER_PATH);
    await expect(page.locator('[data-body-text]')).toBeVisible();

    // No page-level horizontal panning, ever.
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement;
      return root ? root.scrollWidth - root.clientWidth : 0;
    });
    expect(overflow).toBe(0);

    // 18–19 CSS px body text at phone widths (ios-ux.md §3).
    const fontSize = await page
      .locator('[data-body-text] .ProseMirror p')
      .first()
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(17.5);
    expect(fontSize).toBeLessThanOrEqual(19.5);

    // The thumb dock stays reachable and its targets are ≥44px tall.
    const dock = page.locator('.thumb-dock');
    await expect(dock).toBeVisible();
    const buttonHeight = await dock
      .getByRole('button', { name: 'Files' })
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(buttonHeight).toBeGreaterThanOrEqual(44);
  });
}

for (const width of [820]) {
  test(`iPad-width reader at ${width}px keeps a capped, centered measure`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(READER_PATH);
    await expect(page.locator('[data-body-text]')).toBeVisible();
    const sheetWidth = await page
      .locator('.writing-sheet')
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(sheetWidth).toBeLessThanOrEqual(760 + 2);
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement;
      return root ? root.scrollWidth - root.clientWidth : 0;
    });
    expect(overflow).toBe(0);
  });
}

test('wide tablet uses the shared desktop workspace composition', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto(READER_PATH);
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
  await expect(page.locator('.hosted-native-document .ProseMirror')).toBeVisible();
  await expect(page.locator('.thumb-dock')).toHaveCount(0);
});

test('reading position survives file switches and sheet trips', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(READER_PATH);
  await expect(page.locator('[data-body-text]')).toBeVisible();

  // Scroll deep into the document (mobile scrolls the page itself).
  await page.evaluate(() => {
    document.scrollingElement!.scrollTop = 1200;
  });
  await page.waitForFunction(() => document.scrollingElement!.scrollTop >= 1100);
  // Opening and closing a sheet must not move the reading position.
  await page.locator('.thumb-dock').getByRole('button', { name: 'Files' }).click();
  await page.keyboard.press('Escape');
  const afterSheet = await page.evaluate(() => document.scrollingElement!.scrollTop);
  expect(afterSheet).toBeGreaterThanOrEqual(1100);

  // Switch to another file and come back: position restores best-effort.
  await page.locator('.thumb-dock').getByRole('button', { name: 'Files' }).click();
  await page.getByRole('dialog').getByRole('link', { name: /principles\.md/u }).click();
  await expect(page).toHaveURL(/principles\.md/u);
  await page.goBack();
  await expect(page.locator('[data-body-text]')).toBeVisible();
  await page.waitForFunction(() => document.scrollingElement!.scrollTop >= 1100);
});

test('safe raster lightbox opens edge-to-edge and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/w/ws-product/images/desk.png?shell=demo');
  const trigger = page.locator('.asset-image-button');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const lightbox = page.getByRole('dialog', { name: /full screen/u });
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('view-only mode replaces Edit with Open native and keeps the reader useful', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/w/ws-product/direction.md?shell=quota');
  await expect(page.locator('[data-body-text]')).toBeVisible();
  const dock = page.locator('.thumb-dock');
  await expect(dock.getByRole('link', { name: 'Open native' })).toBeVisible();
  await expect(dock.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  // Reader actions stay available: files sheet and share.
  await dock.getByRole('button', { name: 'Files' }).click();
  await expect(page.getByRole('dialog', { name: /Files/u })).toBeVisible();
  await page.keyboard.press('Escape');
  // Share lives only in the masthead: the owner's rare, doc-level act.
  await page.locator('.editor-top').getByRole('button', { name: 'Share' }).click();
  await expect(page.getByRole('dialog', { name: /Share/u })).toBeVisible();
});

test('mobile edit mode: formatting bar above the keyboard viewport, 44px targets, live save state', async ({ page }) => {
  test.slow(); // first hit dev-transforms the whole ProseMirror graph
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await page.locator('.thumb-dock').getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('.writing-sheet .ProseMirror')).toBeVisible({ timeout: 120_000 });

  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(bar).toBeVisible();
  for (const name of ['Bold', 'Italic', 'Heading', 'Bullet list', 'Undo', 'Redo']) {
    const box = await bar.getByRole('button', { name }).boundingBox();
    expect(box!.height, `${name} target height`).toBeGreaterThanOrEqual(44);
    expect(box!.width, `${name} target width`).toBeGreaterThanOrEqual(44);
  }
  // The save state is visible inside the bar (above the keyboard region).
  await expect(bar.locator('.edit-bar-state')).toBeVisible();

  // Formatting commands apply to the document.
  const editor = page.locator('.writing-sheet .ProseMirror');
  await editor.click();
  const editorOutlineStyle = await editor.evaluate(
    (element) => getComputedStyle(element).outlineStyle,
  );
  expect(editorOutlineStyle).toBe('none');
  await page.keyboard.type('emphasis target');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await bar.getByRole('button', { name: 'Bold' }).click();
  await bar.getByRole('button', { name: 'Heading' }).click();
  await page.locator('.thumb-dock').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-body-text] h2 strong')).toContainText('emphasis target');
});

test('workspace title is a separate edit target in edit mode', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await page.locator('.thumb-dock').getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Rename workspace' }).click({ timeout: 120_000 });
  const input = page.getByRole('textbox', { name: 'Workspace title' });
  await input.fill('Field notes');
  await input.press('Enter');
  await expect(page.locator('.doc-name')).toContainText('Field notes');
  // Durable: the desk shows the new name.
  await page.goto('/app');
  await expect(page.locator('.workspace-row').first()).toContainText('Field notes');
});
