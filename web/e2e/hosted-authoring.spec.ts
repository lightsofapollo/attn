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

function activeSidebarEntry(page: Page) {
  return page.locator('[data-path][data-active="true"]');
}

function documentEditor(page: Page) {
  return page.locator('[data-body-text] .ProseMirror');
}

// Workspace-level actions live in the ⌘K palette (the sidebar footer is a
// pure drop zone; per-file actions are in the tree context menu).
async function runPaletteCommand(page: Page, label: RegExp): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('option', { name: label }).click();
}

test('one-click create is real: persists across reload with zero relay traffic', async ({ page }) => {
  await page.goto('/app');
  const offOrigin = captureOffOriginRequests(page);
  await page.getByRole('button', { name: /New workspace/u }).click();
  // The editor opens in place and the URL is rewritten to the workspace.
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/w\/[A-Za-z0-9_-]+\/untitled\.md$/u);
  await expect(page.getByRole('combobox', { name: 'Project picker' })).toContainText('Untitled');
  expect(offOrigin).toEqual([]);

  // A full reload restores the workspace from IndexedDB.
  await page.reload();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Project picker' })).toContainText('Untitled');
  await expect(activeSidebarEntry(page)).toContainText('untitled.md');
  await expect(page.locator('[data-degraded="lease-denied"]')).toHaveCount(0);
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');

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

test('desktop editor fills the canvas and has no edit mode toggle', async ({ page }) => {
  await page.goto('/app#new');
  const editor = documentEditor(page);
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('[data-action="edit"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

  const geometry = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.hosted-content-viewport');
    const editable = document.querySelector<HTMLElement>('.hosted-native-document .ProseMirror');
    if (!viewport || !editable) throw new Error('desktop editor geometry is unavailable');
    const viewportRect = viewport.getBoundingClientRect();
    const editorRect = editable.getBoundingClientRect();
    return {
      viewportHeight: viewportRect.height,
      editorHeight: editorRect.height,
      availableEditorHeight: viewportRect.bottom - editorRect.top,
      bottomGap: viewportRect.bottom - editorRect.bottom,
      clickX: editorRect.left + editorRect.width / 2,
      clickY: editorRect.bottom - 48,
    };
  });
  // Degraded/private-storage banners legitimately consume space above the
  // editor in WebKit. The activation surface must fill what remains, rather
  // than an arbitrary percentage of the entire viewport.
  expect(geometry.editorHeight).toBeGreaterThan(geometry.availableEditorHeight * 0.9);
  expect(Math.abs(geometry.bottomGap)).toBeLessThanOrEqual(1);

  await page.mouse.click(geometry.clickX, geometry.clickY);
  const editorOutlineStyle = await editor.evaluate(
    (element) => getComputedStyle(element).outlineStyle,
  );
  expect(editorOutlineStyle).toBe('none');
  await page.keyboard.type('Typed from the blank canvas.');
  await expect(editor).toContainText('Typed from the blank canvas.');

  // Removing the canvas rectangle must not weaken visible focus on controls:
  // the sidebar filter draws its box via :focus-within when it holds focus.
  const filterField = page.locator('.sidebar-filter');
  const blurredBorder = await filterField.evaluate((el) => getComputedStyle(el).borderColor);
  await page.getByRole('textbox', { name: 'Filter files' }).focus();
  const focusedBorder = await filterField.evaluate((el) => getComputedStyle(el).borderColor);
  expect(focusedBorder).not.toBe(blurredBorder);
});

test('workspace picker is bounded and provides switch, create, rename, and desk actions', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page).toHaveURL(/\/app\/w\/[A-Za-z0-9_-]+\/untitled\.md$/u);
  const firstUrl = page.url();
  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByRole('menuitem', { name: 'Rename workspace' }).click();
  await page.getByRole('textbox', { name: 'Workspace title' }).fill('First workspace');
  await page.getByRole('textbox', { name: 'Workspace title' }).press('Enter');
  await expect(page.getByRole('combobox', { name: 'Project picker' })).toContainText('First workspace');

  const picker = page.getByRole('combobox', { name: 'Project picker' });
  await picker.click();
  const menu = page.locator('.sidebar-project-menu');
  await expect(menu).toBeVisible();
  const geometry = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, viewport: window.innerWidth };
  });
  expect(geometry.width).toBeLessThanOrEqual(320);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/hosted-workspace-picker.png' });

  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/[A-Za-z0-9_-]+\/untitled\.md$/u);
  expect(page.url()).not.toBe(firstUrl);

  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByRole('menuitem', { name: 'Rename workspace' }).click();
  const title = page.getByRole('textbox', { name: 'Workspace title' });
  await expect(title).toBeFocused();
  await title.fill('Second workspace');
  await title.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Project picker' })).toContainText('Second workspace');

  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByPlaceholder('Search projects...').fill('First workspace');
  await page.locator('.sidebar-project-menu-item').filter({ hasText: 'First workspace' }).click();
  await expect(page).toHaveURL(firstUrl);

  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByRole('menuitem', { name: 'All workspaces' }).click();
  await expect(page).toHaveURL(/\/app$/u);
  await expect(page.locator('.workspace-row')).toHaveCount(2);
});

test('desktop Markdown formatting is keyboard-correct and supports input rules', async ({ page }) => {
  // The desktop editor converged with the native grammar: no persistent
  // formatting toolbar — keyboard shortcuts and Markdown input rules are
  // the formatting surface (mobile keeps its thumb-reachable edit bar).
  await page.goto('/app#new');
  const editor = documentEditor(page);

  await editor.click();
  await page.keyboard.type('Keyboard formatting');
  await page.keyboard.press('ControlOrMeta+A');
  const sidebar = page
    .locator('[data-slot="sidebar"]')
    .filter({ has: page.locator('[data-slot="sidebar-inner"]') });
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(editor.locator('strong')).toContainText('Keyboard formatting');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');

  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## ');
  await page.keyboard.type('Second heading');
  await expect(editor.locator('h2')).toContainText('Second heading');

  await page.keyboard.press('Enter');
  await page.keyboard.type('# ');
  await page.keyboard.type('Heading from Markdown');
  await expect(editor.locator('h1')).toContainText('Heading from Markdown');
});

test('the workspace drop target adds dropped Markdown files', async ({ page }) => {
  // The desk redesign removed page-level drag-import (files come in via the
  // Import workspace picker or the in-workspace dropzone). This gate covers
  // the surviving contract: dropping Markdown on the workspace dropzone
  // lands the file in the tree.
  await page.goto('/app#new');
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');

  const workspaceDrop = page.locator('.hosted-sidebar-dropzone');
  await expect(workspaceDrop).toContainText('Drop files anywhere');
  await workspaceDrop.evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['## Added note'], 'added.md', { type: 'text/markdown' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.getByRole('button', { name: 'added.md', exact: true })).toBeVisible();
});

test('returning from mobile reader mode restores desktop editing', async ({ page }) => {
  await page.goto('/app#new');
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.thumb-dock').getByRole('button', { name: 'Done' }).click();
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'false');

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
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
  await expect(page.getByRole('combobox', { name: 'Project picker' })).toContainText('direction');
  await expect(page.locator('[data-body-text]')).toContainText('Imported direction');
  await expect(page.getByRole('button', { name: 'desk.png' })).toBeVisible();
});

test('desk rename and delete are real and confirmed in-app', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await page.goto('/app');
  await expect(page.locator('.workspace-row')).toHaveCount(1);

  await page.getByRole('button', { name: 'Rename', exact: true }).click();
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
  const editor = documentEditor(page);
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
  await expect(page.locator('[data-degraded="lease-denied"]')).toHaveCount(0);
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');
});

test('active Markdown rename stays mounted and autosave follows the new path', async ({ page }) => {
  await page.goto('/app#new');
  const editor = documentEditor(page);
  const navigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);

  await page.getByRole('button', { name: 'untitled.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await page.getByRole('textbox', { name: 'New path' }).fill('renamed.md');
  await page.getByRole('textbox', { name: 'New path' }).press('Enter');

  await expect(page).toHaveURL(/\/renamed\.md$/u);
  await expect(page.getByRole('button', { name: 'renamed.md', exact: true })).toBeVisible();
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(
    navigationCount,
  );

  await editor.click();
  await page.keyboard.type('Text saved after the rename.');
  await expect(page.locator('[data-commits]')).not.toHaveAttribute('data-commits', '0', {
    timeout: 15_000,
  });
  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Saved on this device',
    { timeout: 15_000 },
  );
  await page.reload();
  await expect(documentEditor(page)).toContainText('Text saved after the rename.');
});

test('pending text is reported immediately and guards an immediate reload', async ({ page }) => {
  await page.goto('/app#new');
  const editor = documentEditor(page);
  await editor.click();
  await page.keyboard.type('Pending text must never look saved.');

  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Saving…',
  );
  let sawLeaveWarning = false;
  page.once('dialog', async (dialog) => {
    sawLeaveWarning = dialog.type() === 'beforeunload';
    await dialog.dismiss();
  });
  await page.evaluate(() => window.location.reload());
  if (sawLeaveWarning) {
    // Chromium exposes the native warning. Dismissing it keeps the exact
    // in-memory document in place while the flush finishes.
    await expect(editor).toContainText('Pending text must never look saved.');
    await expect(page.locator('[data-commits]')).not.toHaveAttribute('data-commits', '0', {
      timeout: 15_000,
    });
    await page.reload();
  } else {
    // WebKit does not surface beforeunload dialogs in headless automation;
    // its pagehide drain must therefore make the immediate reload durable.
    await page.waitForLoadState('domcontentloaded');
  }
  await expect(documentEditor(page)).toContainText('Pending text must never look saved.');
});

test('file switching drains pending editor text before navigation', async ({ page }) => {
  await page.goto('/app#new');
  const originalEditor = documentEditor(page);
  await originalEditor.click();
  await page.keyboard.type('Persist before creating another file.');

  // File creation is itself a hard navigation and must first drain the
  // current editor, even though the debounce has not elapsed.
  await runPaletteCommand(page, /New Markdown file/u);
  await page.getByRole('textbox', { name: 'New Markdown file path' }).fill('notes');
  await page.getByRole('textbox', { name: 'New Markdown file path' }).press('Enter');
  await expect(page).toHaveURL(/\/notes\.md$/u);

  await page.getByRole('button', { name: 'untitled.md', exact: true }).click();
  await expect(page).toHaveURL(/\/untitled\.md$/u);
  await expect(documentEditor(page)).toContainText('Persist before creating another file.');
  const editor = documentEditor(page);
  await editor.click();
  await page.keyboard.type('Persist before the click.');
  await page.getByRole('button', { name: 'notes.md', exact: true }).click();
  await expect(page).toHaveURL(/\/notes\.md$/u);

  await page.getByRole('button', { name: 'untitled.md', exact: true }).click();
  await expect(documentEditor(page)).toContainText('Persist before the click.');
});

test('export drains pending text before reading workspace bytes', async ({ page }) => {
  await page.goto('/app#new');
  const editor = documentEditor(page);
  await editor.click();
  await page.keyboard.type('Fresh text belongs in the export.');

  const downloadPromise = page.waitForEvent('download');
  await runPaletteCommand(page, /Export workspace/u);
  const download = await downloadPromise;
  const zipPath = await download.path();
  const { unzipSync } = await import('fflate');
  const fs = await import('node:fs');
  const exported = unzipSync(new Uint8Array(fs.readFileSync(zipPath!)));
  expect(new TextDecoder().decode(exported['untitled.md']!)).toContain(
    'Fresh text belongs in the export.',
  );
});

test('workspace rename stays mounted and keeps the same tab writable', async ({ page }) => {
  await page.goto('/app#new');
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');
  const navigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);

  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByRole('menuitem', { name: 'Rename workspace' }).click();
  const input = page.getByRole('textbox', { name: 'Workspace title' });
  await input.fill('Lease handoff');
  await input.press('Enter');

  await expect(page.getByRole('combobox', { name: 'Project picker' })).toContainText(
    'Lease handoff',
  );
  await expect(page.locator('[data-degraded="lease-denied"]')).toHaveCount(0);
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(
    navigationCount,
  );
});

test('a duplicated tab gets a distinct identity and takes the pen seamlessly', async ({ page, context }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  const url = page.url();
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');

  // Opening from the writer copies sessionStorage in real browsers. The new
  // tab must still derive a DISTINCT identity — and under the join-first
  // multi-tab contract (attn-7xl.7.10) it becomes a live co-editor through
  // the opener's fenced authority. No "Another tab is editing" wall.
  const secondPromise = context.waitForEvent('page');
  await page.evaluate((target) => window.open(target, '_blank'), url);
  const second = await secondPromise;
  await second.waitForLoadState('domcontentloaded');
  await expect(second.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(documentEditor(second)).toHaveAttribute('contenteditable', 'true', {
    timeout: 20_000,
  });

  // Both tabs edit through ONE fenced authority; keystrokes stream both
  // ways and nothing is lost in either direction (attn-7xl.7.10).
  await documentEditor(second).click();
  await second.keyboard.press('ControlOrMeta+End');
  await second.keyboard.type(' from-second-tab');
  await expect(documentEditor(page)).toContainText('from-second-tab', { timeout: 20_000 });

  // The first tab keeps working seamlessly; its edit lands and streams
  // into the second.
  await page.bringToFront();
  await documentEditor(page).click();
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true', {
    timeout: 20_000,
  });
  await documentEditor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' from-first-tab');
  for (const candidate of [page, second]) {
    await expect(documentEditor(candidate)).toContainText('from-first-tab', { timeout: 20_000 });
    await expect(documentEditor(candidate)).toContainText('from-second-tab', { timeout: 20_000 });
  }

  // Closing a tab frees its lease; the survivor keeps sole, durable
  // authorship — no manual retry — and the converged text survives reload.
  // Wait for the autosave to land before reloading: automation dismisses
  // the beforeunload guard that protects humans from reloading mid-flush,
  // so reloading while "Saving…" would race the debounce by design.
  await second.close();
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true', {
    timeout: 25_000,
  });
  await expect(page.locator('[data-commits]')).not.toHaveAttribute('data-commits', '0', {
    timeout: 15_000,
  });
  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Saved on this device',
    { timeout: 15_000 },
  );
  await page.reload();
  await expect(documentEditor(page)).toContainText('from-first-tab');
  await expect(documentEditor(page)).toContainText('from-second-tab');
});

test('mobile reader does not claim the writer lease until Edit is requested', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('[data-degraded="lease-denied"]')).toHaveCount(0);
  const url = page.url();

  const desktop = await context.newPage();
  await desktop.setViewportSize({ width: 1280, height: 800 });
  await desktop.goto(url);
  await expect(documentEditor(desktop)).toHaveAttribute('contenteditable', 'true');

  // Tapping Edit is explicit intent: the mobile tab joins the desktop's
  // live authority as a co-editor — both surfaces editable, one fenced
  // authority, edits converge (attn-7xl.7.10). No wall, no pen churn.
  await page.locator('.thumb-dock').getByRole('button', { name: 'Edit' }).click();
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true', {
    timeout: 20_000,
  });
  await documentEditor(page).click();
  await page.keyboard.type('from-mobile ');
  await expect(documentEditor(desktop)).toContainText('from-mobile', { timeout: 20_000 });
});

test('multi-file workspace: create, add, context-rename, context-delete, and export', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();

  // Create a nested Markdown file from the sidebar.
  await runPaletteCommand(page, /New Markdown file/u);
  await page.getByRole('textbox', { name: 'New Markdown file path' }).fill('docs/notes');
  await page.getByRole('textbox', { name: 'New Markdown file path' }).press('Enter');
  await expect(page).toHaveURL(/\/docs\/notes\.md$/u);
  await expect(activeSidebarEntry(page)).toContainText('notes.md');
  await expect(page.locator('[data-degraded="lease-denied"]')).toHaveCount(0);
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');

  // Add a PNG asset — it must render inline from decrypted bytes.
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-action="add-assets"]').click();
  // 1x1 transparent PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  await (await chooser).setFiles([{ name: 'pixel.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.getByRole('button', { name: 'pixel.png' })).toBeVisible();
  await expect(page.locator('[data-degraded="lease-denied"]')).toHaveCount(0);
  await expect(documentEditor(page)).toHaveAttribute('contenteditable', 'true');
  await page.getByRole('button', { name: 'pixel.png' }).click();
  await expect(page.locator('.asset-image')).toBeVisible();
  const naturalWidth = await page
    .locator('.asset-image')
    .evaluate((img) => (img as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBe(1); // decoded — the decrypted bytes are a real PNG

  // Rename the asset to a nested path.
  await page.getByRole('button', { name: 'pixel.png', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const renameInput = page.getByRole('textbox', { name: 'New path' });
  const navigationCountBeforeRename = await page.evaluate(() =>
    performance.getEntriesByType('navigation').length,
  );
  await renameInput.fill('images/pixel.png');
  await renameInput.press('Enter');
  await expect(page).toHaveURL(/\/images\/pixel\.png$/u);
  await expect(page.locator('.asset-image')).toBeVisible();
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(
    navigationCountBeforeRename,
  );

  // Export the whole workspace as a zip with exact paths.
  const downloadPromise = page.waitForEvent('download');
  await runPaletteCommand(page, /Export workspace/u);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/u);

  // Delete the asset; the workspace survives with its Markdown files.
  await page.getByRole('button', { name: 'pixel.png', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  await page.getByRole('button', { name: 'Delete file' }).click();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'pixel.png' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'untitled.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'notes.md' })).toBeVisible();
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
  await page.getByRole('button', { name: 'img' }).click();
  await expect(page.getByRole('button', { name: 'dot.png' })).toBeVisible();
});

test('phase gate: create → type → reload → edit → export → reimport with zero relay traffic', async ({ page }) => {
  test.slow();
  const allRequests: string[] = [];
  page.on('request', (request) => {
    allRequests.push(request.url());
  });

  // From the landing, one click into a real editor.
  await page.goto('/');
  await page.locator('.hero a[data-action="new-workspace"]').click();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();

  // Type through the real editor; wait for the durable commit.
  const editor = documentEditor(page);
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await editor.click();
  await page.keyboard.type('Journey body survives everything.');
  await expect(page.locator('.save-state[data-commits]')).not.toHaveAttribute('data-commits', '0', {
    timeout: 15_000,
  });
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
  await expect(page.getByRole('button', { name: 'big.bin' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await runPaletteCommand(page, /Export workspace/u);
  const download = await downloadPromise;
  const zipPath = await download.path();
  const { unzipSync } = await import('fflate');
  const fs = await import('node:fs');
  const exported = unzipSync(new Uint8Array(fs.readFileSync(zipPath!)));
  expect(Object.keys(exported).sort()).toEqual(['attn-manifest.json', 'big.bin', 'untitled.md']);
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
  await expect(page.getByRole('button', { name: 'big.bin' })).toBeVisible();

  // The entire journey — creation to reimport — touched no non-origin host.
  const origin = new URL(page.url()).origin;
  expect(allRequests.filter((url) => !url.startsWith(origin))).toEqual([]);
});

test('storage page: export marks backup, reimport dedupes names, clear-all erases', async ({ page }) => {
  test.slow();
  // Create a workspace, then manage it from the storage page.
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await page.goto('/app/storage');
  const panel = page.getByRole('region', { name: 'Local workspaces' });
  await expect(panel.locator('.workspace-row')).toHaveCount(1);
  await expect(panel).toContainText('Never backed up');

  // Export → download fires and the backup label becomes honest.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/u);
  await expect(panel).toContainText('Backed up just now');

  // Reimport the backup: manifest name + explicit numbered dedupe.
  const zipPath = await download.path();
  const fs = await import('node:fs');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import backup' }).click();
  await (await chooser).setFiles([
    { name: 'backup.zip', mimeType: 'application/zip', buffer: fs.readFileSync(zipPath!) },
  ]);
  await expect(page).toHaveURL(/\/app\/w\//u);
  await expect(page.getByRole('combobox', { name: 'Project picker' })).toContainText('Untitled 2');

  // Clear all local data: in-app confirm, durable erasure.
  await page.goto('/app/storage');
  const panelAfter = page.getByRole('region', { name: 'Local workspaces' });
  await expect(panelAfter.locator('.workspace-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear all local attn data' }).click();
  await page.getByRole('button', { name: 'Delete everything' }).click();
  await expect(panelAfter.locator('.workspace-row')).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Local workspaces' }).locator('.workspace-row'),
  ).toHaveCount(0);
});

test('remembered rooms can be forgotten with crypto-erasure confirmation', async ({ page }) => {
  await page.goto('/app/storage?shell=demo');
  const roomsPanel = page.getByRole('region', { name: 'Local workspaces' });
  await expect(roomsPanel).toContainText('7pmH1MwiTfQt9gecnT4HIA');
  await page.getByRole('button', { name: 'Forget', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: /Forget room/u });
  await expect(confirm).toContainText('The local key is deleted first');
  await confirm.getByRole('button', { name: 'Forget room' }).click();
  await expect(roomsPanel).toContainText('No remembered review rooms in this browser profile.');
});

test('private-session sharing is streamlined but the storage risk stays visible', async ({ page }) => {
  // The acknowledgment checkbox was deliberately removed (b2baf39
  // "streamline browser share creation"): sharing is one click even in a
  // private session. The session-only storage risk must still be
  // COMMUNICATED — by the standing degraded banner, not a modal gate.
  await page.goto('/app/w/ws-product/direction.md?shell=private');
  await expect(page.locator('[data-degraded]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Share for review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share files for review' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create review link' })).toBeEnabled();
});
