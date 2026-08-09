import { expect, test, type Page } from '@playwright/test';

// Local workspace page shells (attn-7xl.1.3): desk home, editor, Share sheet,
// storage/recovery, import handoff, and every designed degraded state, all
// rendered from the injected mock service (`?shell=` selects a scenario).

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement;
    return root ? root.scrollWidth - root.clientWidth : 0;
  });
  expect(overflow).toBe(0);
}

test('desk home lists recent workspaces with storage health', async ({ page }) => {
  await page.goto('/app?shell=demo');
  await expect(page.locator('h1')).toHaveText('Your desk');
  await expect(page.locator('[data-storage-mode]')).toHaveAttribute('data-storage-mode', 'persistent');
  await expect(page.locator('.local-badge').first()).toContainText('On this device');
  await expect(page.locator('.quick')).toHaveCount(3);
  await expect(page.locator('.workspace-row')).toHaveCount(3);
  await expect(page.locator('.workspace-row').first()).toContainText('Product direction');
  // Storage link navigates to the storage page (real service).
  await page.getByRole('link', { name: 'Storage', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/storage$/u);
  await expect(page.locator('h1')).toHaveText('Storage & recovery');
});

test('landing one-click intent opens an untitled draft editor', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('.hosted-native-document .ProseMirror')).toBeVisible();
  await expect(page.locator('[data-path][data-active="true"]')).toContainText('untitled.md');
  await expect(page.locator('[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Changes autosaved',
  );
});

test('desktop editor reuses the native sidebar, editor, and review rail frame', async ({ page }) => {
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
  await expect(page.locator('[data-path][data-active="true"]')).toContainText('direction.md');
  await expect(page.getByRole('button', { name: 'desk.png' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'notes.json' })).toBeVisible();
  await expect(page.locator('.hosted-native-document .ProseMirror')).toBeVisible();
  await expect(page.locator('[data-action="edit"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-slot="right-rail"]')).toHaveCount(1);
  await expect(page.locator('.file-rail, .review-rail')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('asset entries render inline previews and download-only placeholders', async ({ page }) => {
  await page.goto('/app/w/ws-product/images/desk.png?shell=demo');
  await expect(page.locator('.hosted-native-document .eyebrow')).toHaveText('Asset preview');
  // Safe rasters render inline from (mock-)decrypted bytes.
  await expect(page.locator('.asset-image')).toBeVisible();
  await page.goto('/app/w/ws-product/data/notes.json?shell=demo');
  await expect(page.locator('.hosted-native-document .eyebrow')).toHaveText('Download only');
  await expect(page.locator('.asset-preview')).toContainText('never executed');
  await expect(page.locator('.hosted-native-document').getByRole('button', { name: 'Download' })).toBeVisible();
});

test('share sheet opens as a dialog and returns focus on close', async ({ page }) => {
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await page.getByRole('button', { name: 'Share for review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share files for review' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Choose files to share');
  await expect(dialog).toContainText('1 file selected');
  await expect(dialog).toContainText('Encrypted before it leaves this browser.');
  // The dialog heading owns initial focus; Escape closes and restores focus.
  await expect(dialog.getByRole('heading', { name: 'Share files for review' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Share for review' })).toBeFocused();
});

test('storage page confirms destructive clear in-app', async ({ page }) => {
  await page.goto('/app/storage?shell=demo');
  await expect(page.locator('.status-box strong')).toContainText('Protected from automatic cleanup');
  await expect(
    page.getByRole('region', { name: 'Local workspaces' }).locator('.workspace-row'),
  ).toHaveCount(4); // 3 workspaces + 1 remembered room row
  await page.getByRole('button', { name: 'Clear all local attn data' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Delete every local workspace in this browser?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Clear all local attn data' })).toBeVisible();
});

test('open page presents the import handoff', async ({ page }) => {
  await page.goto('/open');
  await expect(page.locator('h1')).toHaveText('Import into your desk');
  await expect(page.locator('.drop-zone')).toContainText('Relative paths are preserved');
});

test('private browsing scenario degrades honestly', async ({ page }) => {
  await page.goto('/app?shell=private');
  await expect(page.locator('[data-storage-mode]')).toHaveAttribute('data-storage-mode', 'session-only');
  await expect(page.locator('.local-badge').first()).toContainText('This session only');
  await expect(page.locator('[data-degraded="session-only"]')).toContainText(
    'This private session may erase your desk when it closes.',
  );
});

test('blocked-storage scenario keeps the desk viewable', async ({ page }) => {
  await page.goto('/app?shell=blocked');
  await expect(page.locator('.local-badge').first()).toContainText('View-only');
  await expect(page.locator('[data-degraded="unavailable"]')).toContainText(
    'This browser currently blocks local document storage.',
  );
  await expect(page.locator('.workspace-row')).toHaveCount(0);
});

test('quota pressure blocks writes without hiding the document', async ({ page }) => {
  await page.goto('/app/w/ws-product/direction.md?shell=quota');
  await expect(page.locator('[data-degraded="quota-pressure"]')).toContainText(
    'New edits are paused',
  );
  await page.goto('/app/storage?shell=quota');
  await expect(page.locator('.status-box strong')).toContainText('Storage is nearly full');
  await expect(page.locator('.meter.warn')).toBeVisible();
});

test('mobile editor is reader-first with dock and sheets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await expect(page.locator('.file-rail')).toBeHidden();
  await expect(page.locator('.review-rail')).toBeHidden();
  const dock = page.locator('.thumb-dock');
  await expect(dock).toBeVisible();
  await dock.getByRole('button', { name: 'Files' }).click();
  const filesSheet = page.getByRole('dialog', { name: 'Files' });
  await expect(filesSheet).toBeVisible();
  await expect(filesSheet.locator('.file-row')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await expect(filesSheet).not.toBeVisible();
  await expect(dock.getByRole('button', { name: 'Files' })).toBeFocused();
  await dock.getByRole('button', { name: /Review · 1/u }).click();
  await expect(page.getByRole('dialog', { name: /Review · 1/u })).toContainText('JULES');
  await expectNoHorizontalScroll(page);
});

for (const path of ['/app', '/app/w/ws-product/direction.md?shell=demo', '/app/storage', '/open']) {
  test(`no horizontal scroll at 320px: ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(path);
    await expect(page.locator('body')).toHaveAttribute('data-hydrated', 'true');
    await expectNoHorizontalScroll(page);
  });
}

test('share sheet fits 320px without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await page.locator('.editor-top').getByRole('button', { name: 'Share' }).click();
  await expect(page.getByRole('dialog', { name: 'Share files for review' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('capture shell screenshots for design review', async ({ page }) => {
  const shots: Array<[string, string, { open?: 'share' }?]> = [
    ['/app?shell=demo', 'desk'],
    ['/app/w/ws-product/direction.md?shell=demo', 'editor'],
    ['/app/w/ws-product/direction.md?shell=demo', 'share', { open: 'share' }],
    ['/app/storage?shell=demo', 'storage'],
    ['/open', 'open'],
    ['/app?shell=private', 'desk-private'],
  ];
  for (const [path, name, opts] of shots) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(path);
    await expect(page.locator('body')).toHaveAttribute('data-hydrated', 'true');
    if (path.includes('/app/w/')) {
      await expect(page.locator('.hosted-native-document')).toBeVisible();
    }
    if (opts?.open === 'share') {
      await page.getByRole('button', { name: 'Share for review' }).click();
    }
    await page.screenshot({ path: `test-results/shell-${name}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.locator('body')).toHaveAttribute('data-hydrated', 'true');
    if (path.includes('/app/w/')) {
      await expect(page.locator('.writing-sheet')).toBeVisible();
    }
    if (opts?.open === 'share') {
      await page.locator('.editor-top').getByRole('button', { name: 'Share' }).click();
    }
    await page.screenshot({ path: `test-results/shell-${name}-mobile.png`, fullPage: true });
  }
});
