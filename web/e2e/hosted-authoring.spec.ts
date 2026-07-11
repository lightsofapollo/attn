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
  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
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

test('editing autosaves durable revisions and recovers after reload', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.locator('.writing-sheet .ProseMirror');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('# Autosaved title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Body that must survive a reload.');
  // Wait for a durable commit (data-commits increments only after the
  // IndexedDB transaction completes), then for the settled save state.
  await expect(page.locator('[data-commits]')).not.toHaveAttribute('data-commits', '0', {
    timeout: 15_000,
  });
  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Saved on this device',
    { timeout: 15_000 },
  );
  await page.reload();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('[data-body-text]')).toContainText('Autosaved title');
  await expect(page.locator('[data-body-text]')).toContainText('survive a reload');
});

test('a second tab is honestly read-only while one tab edits', async ({ page, context }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  const url = page.url();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.writing-sheet .ProseMirror')).toBeVisible();

  const second = await context.newPage();
  await second.goto(url);
  await expect(second.locator('[data-app-view="workspace"]')).toBeVisible();
  await second.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(second.locator('[data-degraded="lease-denied"]')).toContainText(
    'Another tab is editing this workspace.',
  );
  await expect(second.locator('.writing-sheet .ProseMirror')).toHaveCount(0);

  // Done in the first tab releases the lease; the second tab can now edit.
  await page.getByRole('button', { name: 'Done' }).click();
  await second.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(second.locator('.writing-sheet .ProseMirror')).toBeVisible();
});

test('multi-file rail: create, add asset with inline preview, rename, delete, export zip', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();

  // Create a nested Markdown file from the rail.
  await page.locator('[data-action="new-markdown"]').click();
  await page.getByRole('textbox', { name: 'New Markdown file path' }).fill('docs/notes');
  await page.getByRole('textbox', { name: 'New Markdown file path' }).press('Enter');
  await expect(page).toHaveURL(/\/docs\/notes\.md$/u);
  await expect(page.locator('.file-rail .file.active')).toContainText('docs/notes.md');

  // Add a PNG asset — it must render inline from decrypted bytes.
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-action="add-assets"]').click();
  // 1x1 transparent PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  await (await chooser).setFiles([{ name: 'pixel.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.locator('.file-rail .file.asset')).toContainText('pixel.png');
  await page.locator('.file-rail .file.asset').click();
  await expect(page.locator('.asset-image')).toBeVisible();
  const naturalWidth = await page
    .locator('.asset-image')
    .evaluate((img) => (img as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBe(1); // decoded — the decrypted bytes are a real PNG

  // Rename the asset to a nested path.
  await page.getByRole('button', { name: 'Rename' }).click();
  const renameInput = page.getByRole('textbox', { name: 'New path' });
  await renameInput.fill('images/pixel.png');
  await renameInput.press('Enter');
  await expect(page).toHaveURL(/\/images\/pixel\.png$/u);
  await expect(page.locator('.asset-image')).toBeVisible();

  // Export the whole workspace as a zip with exact paths.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="export-zip"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/u);

  // Delete the asset; the workspace survives with its Markdown files.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete file' }).click();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('.file-rail .file.asset')).toHaveCount(0);
  await expect(page.locator('.file-rail .file-list .file')).toHaveCount(2);
  await expect(page.locator('.file-rail .file-list')).toContainText('untitled.md');
  await expect(page.locator('.file-rail .file-list')).toContainText('docs/notes.md');
});

test('zip import expands into a nested multi-file workspace', async ({ page }) => {
  await page.goto('/app');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Import workspace/u }).click();
  const { zipSync } = await import('fflate');
  const zip = Buffer.from(
    zipSync({
      'folio/index.md': new TextEncoder().encode('# Folio index'),
      'folio/img/dot.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    }),
  );
  await (await chooser).setFiles([{ name: 'folio.zip', mimeType: 'application/zip', buffer: zip }]);
  await expect(page).toHaveURL(/\/app\/w\/[A-Za-z0-9_-]+\//u);
  await expect(page.locator('[data-body-text]')).toContainText('Folio index');
  await expect(page.locator('.file-rail .file.asset')).toContainText('folio/img/dot.png');
});

test('phase gate: create → type → reload → edit → export → reimport with zero relay traffic', async ({ page }) => {
  test.slow();
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:8797')) offOrigin.push(request.url());
  });

  // From the landing, one click into a real editor.
  await page.goto('/');
  await page.locator('.hero a[data-action="new-workspace"]').click();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();

  // Type through the real editor; wait for the durable commit.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.locator('.writing-sheet .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await editor.click();
  await page.keyboard.type('Journey body survives everything.');
  await expect(page.locator('.save-state[data-commits]')).not.toHaveAttribute('data-commits', '0', {
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Done' }).click();

  // Reload: the committed head recovers.
  await page.reload();
  await expect(page.locator('[data-body-text]')).toContainText('Journey body survives everything.');

  // Add a >1 MiB asset (exercises the large-body tier), then export a zip.
  const bigAsset = Buffer.alloc(1_200_000);
  for (let index = 0; index < bigAsset.length; index += 1) bigAsset[index] = index % 251;
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-action="add-assets"]').click();
  await (await chooser).setFiles([
    { name: 'big.bin', mimeType: 'application/octet-stream', buffer: bigAsset },
  ]);
  await expect(page.locator('.file-rail .file.asset')).toContainText('big.bin');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="export-zip"]').click();
  const download = await downloadPromise;
  const zipPath = await download.path();
  const { unzipSync } = await import('fflate');
  const fs = await import('node:fs');
  const exported = unzipSync(new Uint8Array(fs.readFileSync(zipPath!)));
  expect(Object.keys(exported).sort()).toEqual(['big.bin', 'untitled.md']);
  expect(new TextDecoder().decode(exported['untitled.md']!)).toContain(
    'Journey body survives everything.',
  );
  expect(exported['big.bin']!.length).toBe(bigAsset.length);
  expect(exported['big.bin']![777_777]).toBe(777_777 % 251);

  // Reimport the exported zip as a fresh workspace: bytes and paths hold.
  await page.goto('/app');
  const reimportChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Import workspace/u }).click();
  await (await reimportChooser).setFiles([
    { name: 'journey.zip', mimeType: 'application/zip', buffer: fs.readFileSync(zipPath!) },
  ]);
  await expect(page).toHaveURL(/\/app\/w\/[A-Za-z0-9_-]+\//u);
  await expect(page.locator('[data-body-text]')).toContainText('Journey body survives everything.');
  await expect(page.locator('.file-rail .file.asset')).toContainText('big.bin');

  // The entire journey — creation to reimport — touched no non-origin host.
  expect(offOrigin).toEqual([]);
});
