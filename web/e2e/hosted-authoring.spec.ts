import { expect, test, type Page } from '@playwright/test';

// Real local authoring flows (attn-7xl.3.2): the storage-backed service is
// the default (no ?shell= parameter). Everything here must work with ZERO
// non-origin network requests — creation and editing are local until Share.

function captureOffOriginRequests(page: Page): string[] {
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(page.url() || 'http://127.0.0.1:8797').origin) {
      offOrigin.push(request.url());
    }
  });
  return offOrigin;
}

test('one-click create is real: persists across reload with zero relay traffic', async ({ page }) => {
  await page.goto('/app');
  const offOrigin = captureOffOriginRequests(page);
  await page.getByRole('button', { name: /New workspace/u }).click();
  // The editor opens in place and the URL is rewritten to the workspace.
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/w\/[A-Za-z0-9_-]+\/untitled\.md$/u);
  await expect(page.locator('.writing-sheet h1')).toHaveText('Untitled');
  expect(offOrigin).toEqual([]);

  // A full reload restores the workspace from IndexedDB.
  await page.reload();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('.doc-name')).toContainText('Untitled');
  await expect(page.locator('.file-rail .file.active')).toContainText('untitled.md');

  // And the desk lists it as a real recent workspace.
  await page.goto('/app');
  await expect(page.locator('.workspace-row')).toHaveCount(1);
  await expect(page.locator('.workspace-row').first()).toContainText('Untitled');
  await expect(page.locator('.workspace-row').first()).toContainText('Local only');
});

test('landing hash intent creates without any dialog', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/w\/[A-Za-z0-9_-]+\/untitled\.md$/u);
  await expect(page.locator('[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Saved on this device',
  );
});

test('import creates a real multi-file workspace preserving paths', async ({ page }) => {
  await page.goto('/app');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Import workspace/u }).click();
  await (await chooser).setFiles([
    {
      name: 'direction.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Imported direction\n\nBody text.\n'),
    },
    {
      name: 'desk.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
    },
  ]);
  // Import navigates into the imported workspace's editor.
  await expect(page).toHaveURL(/\/app\/w\/[A-Za-z0-9_-]+\//u);
  await expect(page.locator('.doc-name')).toContainText('direction');
  await expect(page.locator('[data-body-text]')).toContainText('Imported direction');
  await expect(page.locator('.file-rail .file.asset')).toHaveCount(1);
  await expect(page.locator('.file-rail .file.asset')).toContainText('desk.png');
});

test('desk rename and delete are real and confirmed in-app', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await page.goto('/app');
  await expect(page.locator('.workspace-row')).toHaveCount(1);

  await page.getByRole('button', { name: 'Rename' }).click();
  const input = page.getByRole('textbox', { name: 'Workspace name' });
  await input.fill('Product direction');
  await input.press('Enter');
  await expect(page.locator('.workspace-row').first()).toContainText('Product direction');

  // Survives reload — the rename was a durable commit.
  await page.reload();
  await expect(page.locator('.workspace-row').first()).toContainText('Product direction');

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Delete “Product direction” from this device?');
  await confirm.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(page.locator('.workspace-row')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.workspace-row')).toHaveCount(0);
  await expect(page.locator('.empty-desk')).toBeVisible();
});
