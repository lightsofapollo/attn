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
  // The storage badge was removed from the header (user ruling, 2026-08-20);
  // the shell still reports which state it is in on the header itself.
  await expect(page.locator('[data-storage-mode]')).toHaveAttribute('data-storage-mode', 'persistent');
  await expect(page.locator('.app-header .local-badge')).toHaveCount(0);
  await expect(page.locator('.quick')).toHaveCount(3);
  await expect(page.locator('.workspace-row')).toHaveCount(3);
  await expect(page.locator('.workspace-row').first()).toContainText('Product direction');
  // Storage link navigates to the storage page (real service).
  await page.getByRole('link', { name: 'Storage', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/storage$/u);
  await expect(page.locator('h1')).toHaveText('Storage & recovery');
});

test('mobile Desk makes workspace facts and administration scannable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app?shell=demo');
  const row = page.locator('.workspace-row').first();
  const layout = await row.evaluate((element) => {
    const rect = (selector: string) => {
      const item = element.querySelector<HTMLElement>(selector);
      if (!item) throw new Error(`missing ${selector}`);
      const box = item.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    return {
      title: rect('.row-open'),
      facts: rect('.detail-group'),
      review: rect('.review-pill'),
      status: rect('.row-tail'),
      menu: rect('.row-menu summary'),
    };
  });
  expect(layout.title.bottom).toBeLessThanOrEqual(layout.facts.top + 1);
  expect(layout.facts.bottom).toBeLessThanOrEqual(layout.review.top + 1);
  expect(layout.review.bottom).toBeLessThanOrEqual(layout.status.top + 1);
  expect(layout.menu.width).toBeGreaterThanOrEqual(44);
  expect(layout.menu.height).toBeGreaterThanOrEqual(44);

  await page.getByLabel('Manage Product direction').click();
  await expect(row.getByRole('button', { name: 'Rename' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('landing one-click intent opens an untitled draft editor', async ({ page }) => {
  await page.goto('/app#new');
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('.hosted-native-document .ProseMirror')).toBeVisible();
  // A bare workspace mounts no file rail (attn-mkmz.5): a filter over a single
  // row, and that row is the document already open beside it. The header does
  // not name a file either (user ruling, 2026-08-20) — while the canvas is
  // asking which document to open, the placeholder `untitled.md` is not a file
  // anyone has chosen, and printing it contradicted the invitation beneath.
  await expect(page.locator('[data-slot="owner-file-name"]')).toHaveCount(0);
  await expect(page.locator('[data-path][data-active="true"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="canvas-invite"]')).toBeVisible();
  // The workspace switcher survives the rail's absence — it lives in the header.
  await expect(page.getByRole('combobox', { name: 'Project picker' })).toBeVisible();
  await expect(page.locator('[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Changes autosaved',
  );
});

test('the bare canvas invitation withdraws when the canvas is answered', async ({ page }) => {
  await page.goto('/app#new');
  const invite = page.locator('[data-slot="canvas-invite"]');
  await expect(invite).toBeVisible();
  // Pointer-transparent except its buttons: a click anywhere else has to reach
  // the ProseMirror and place a caret, exactly as on any other empty document —
  // and that click alone withdraws the offer (attn-rjuo.1.3). Waiting for a
  // keystroke left the caret and the centred invitation on screen together.
  await page.locator('.hosted-native-document .ProseMirror').click({ position: { x: 300, y: 20 } });
  await expect(invite).toHaveCount(0);
  await page.keyboard.type('Typed straight through the invitation.');
  await expect(page.locator('.hosted-native-document .ProseMirror')).toContainText(
    'Typed straight through the invitation.',
  );
  // Answering the canvas also returns the rail — the rail is hidden exactly
  // while the invitation is up. Because the trigger is POINTER-DOWN, that
  // happens before the first character, never mid-word.
  await expect(page.locator('[data-path][data-active="true"]')).toContainText('untitled.md');
  // And it must not come back a second later, when the autosave commit hands
  // down a fresh workspace: that refresh used to reset the answered latch and
  // resurrect the invitation over live typing (attn-rjuo).
  await page.waitForTimeout(3000);
  await expect(invite).toHaveCount(0);
});

test('a blank untitled.md opens the ordinary editor, rail and all', async ({ page }) => {
  // Case 2 of the desk's two routes (user ruling, 2026-08-20). "Start a blank
  // untitled.md" is a document you are already working on, not an empty surface
  // waiting to be told what it is: no invitation, and the file rail, the file
  // row and the Add files footer are all there from the first frame.
  await page.goto('/app');
  await page.locator('[data-action="start-blank"]').click();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('[data-slot="canvas-invite"]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toBeVisible();
  await expect(page.locator('[data-path][data-active="true"]')).toContainText('untitled.md');
  await expect(page.locator('.hosted-sidebar-add')).toContainText('Add files');

  // The invitation must not arrive late — the autosave commit that follows the
  // first keystroke refreshes the workspace, and that refresh used to clear the
  // create-intent this route depends on.
  await page.locator('.hosted-native-document .ProseMirror').click();
  await page.keyboard.type('rotwjboritj');
  await page.waitForTimeout(3000);
  await expect(page.locator('[data-slot="canvas-invite"]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toBeVisible();
});

test('the invitation does not wait for the editor chunk', async ({ page }) => {
  // THE FAILURE THIS PINS (attn-rjuo.1.1): the invitation was nested inside the
  // branch that renders once the lazily-imported editor resolves, so a bare
  // workspace's first paint was a lone caret on an empty canvas for the length
  // of a dynamic import — reported as "the untitled experience is broken".
  //
  // Asserted STRUCTURALLY, not by racing the network. "The editor has not
  // mounted yet" is not a claim a test can hold on both builds: the dev server
  // fetches the chunk on demand while the worker modulepreloads it, so a
  // timing proxy passes on one and lies on the other. Whether the invitation is
  // a DESCENDANT of the editor surface is the regression itself, and it is the
  // same answer in every build.
  await page.goto('/app#new');
  const invite = page.locator('[data-slot="canvas-invite"]');
  await expect(invite).toBeVisible();
  await expect(page.locator('.hosted-editor-surface [data-slot="canvas-invite"]')).toHaveCount(0);
  // Nor may the wait's own message double up with it on one empty canvas.
  await expect(page.locator('.hosted-editor-loading')).toHaveCount(0);
});

test('the invitation still paints while the editor chunk is stalled', async ({ page }) => {
  // The other half of attn-rjuo.1.1, as close to the reported symptom as a test
  // can get: hold the editor chunk and the canvas must still say something.
  // Matches the chunk in BOTH shapes — `…/Editor.svelte` on the dev server,
  // `assets/Editor-<hash>.js` from the build.
  await page.route('**/*', async (route) => {
    if (/\bEditor(\.svelte|-[A-Za-z0-9_-]+\.js)/u.test(route.request().url())) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await route.continue();
  });
  await page.goto('/app#new', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-slot="canvas-invite"]')).toBeVisible({ timeout: 10_000 });
});

test('an explicitly blank workspace stays blank across a reload', async ({ page }) => {
  // attn-rjuo.1.2: the create-intent used to live only in component state, so a
  // refresh re-covered a page someone had asked to be blank with an offer to
  // import something.
  await page.goto('/app');
  await page.locator('[data-action="start-blank"]').click();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('[data-slot="canvas-invite"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-app-view="workspace"]')).toBeVisible();
  await expect(page.locator('[data-slot="canvas-invite"]')).toHaveCount(0);
  await expect(page.locator('.ProseMirror p.is-editor-empty')).toBeVisible();
});

test('the import route keeps its invitation across a reload', async ({ page }) => {
  await page.goto('/app');
  await page.locator('[data-action="import-files"]').click();
  await expect(page.locator('[data-slot="canvas-invite"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-slot="canvas-invite"]')).toBeVisible();
});

test('desktop editor reuses the native sidebar, editor, and review rail frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
  await expect(page.locator('[data-path][data-active="true"]')).toContainText('direction.md');
  await expect(page.getByRole('button', { name: 'desk.png' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'notes.json' })).toBeVisible();
  await expect(page.locator('.hosted-native-document .ProseMirror')).toBeVisible();
  await expect(page.locator('[data-action="edit"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  // Addressed by slot, not by name: this control RENAMES itself between states
  // ("Comments" -> "Hide comments"), so a name-based locator silently stops
  // matching the moment it is opened — which is exactly what it did.
  const commentsToggle = page.locator('[data-slot="comments-toggle"]');
  await expect(commentsToggle).toBeVisible();
  await expect(commentsToggle).toHaveAccessibleName('Comments');
  await expect(commentsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-slot="right-rail"]')).toHaveCount(0);
  await expect(page.locator('.review-history-placeholder')).toHaveCount(0);
  await commentsToggle.click();
  await expect(commentsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(commentsToggle).toHaveAccessibleName('Hide comments');
  await expect(page.locator('[data-slot="right-rail"]')).toHaveAttribute('data-mode', 'expanded');
  await expect(page.locator('.review-history-placeholder')).toContainText('Comments');
  await expect(page.locator('.review-history-placeholder')).toContainText('JULES');
  await expect(page.locator('.review-history-placeholder')).toContainText(
    'Live review adds presence and replies; these comments stay here.',
  );
  // Comments get their own docked column. It reflows the document only while
  // explicitly open; closing removes the rail rather than retaining a gutter.
  const readingLayout = await page.evaluate(() => {
    const documentSurface = document.querySelector<HTMLElement>('.hosted-native-document');
    const rail = document.querySelector<HTMLElement>('[data-slot="right-rail"]');
    if (!documentSurface || !rail) throw new Error('missing docked review layout');
    const documentRect = documentSurface.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    return {
      documentRight: documentRect.right,
      documentWidth: documentRect.width,
      railLeft: railRect.left,
      railWidth: railRect.width,
    };
  });
  expect(readingLayout.documentRight).toBeLessThanOrEqual(readingLayout.railLeft + 1);
  expect(readingLayout.documentWidth).toBeGreaterThanOrEqual(600);
  expect(readingLayout.railWidth).toBeGreaterThanOrEqual(300);
  await page.screenshot({ path: 'test-results/hosted-saved-review-docked.png' });
  await commentsToggle.click();
  await expect(page.locator('[data-slot="right-rail"]')).toHaveCount(0);
  await commentsToggle.click();
  await expect(page.locator('[data-slot="right-rail"]')).toHaveAttribute('data-mode', 'expanded');
  // 1024px is still the desktop workspace (the phone layout begins below the
  // app's 900px breakpoint). The dock must shrink the reading measure rather
  // than force a horizontal canvas or slide back over the prose.
  await page.setViewportSize({ width: 1024, height: 900 });
  const compactReadingLayout = await page.evaluate(() => {
    const documentSurface = document.querySelector<HTMLElement>('.hosted-native-document');
    const rail = document.querySelector<HTMLElement>('[data-slot="right-rail"]');
    if (!documentSurface || !rail) throw new Error('missing compact docked review layout');
    const documentRect = documentSurface.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    return {
      documentRight: documentRect.right,
      documentWidth: documentRect.width,
      railLeft: railRect.left,
      railRight: railRect.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(compactReadingLayout.documentRight).toBeLessThanOrEqual(compactReadingLayout.railLeft + 1);
  expect(compactReadingLayout.documentWidth).toBeGreaterThanOrEqual(340);
  expect(compactReadingLayout.railRight).toBeLessThanOrEqual(compactReadingLayout.viewportWidth + 1);
  await page.screenshot({ path: 'test-results/hosted-saved-review-docked-1024.png' });
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
  // The banner is the whole surface now — it says the state, the consequence,
  // and offers the remedy, which the removed badge never did.
  await expect(page.locator('[data-degraded="session-only"]')).toContainText(
    'This private session may erase your desk when it closes.',
  );
});

test('blocked-storage scenario keeps the desk viewable', async ({ page }) => {
  await page.goto('/app?shell=blocked');
  await expect(page.locator('[data-storage-mode]')).toHaveAttribute('data-storage-mode', 'unavailable');
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
