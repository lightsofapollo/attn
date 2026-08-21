import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Accessibility gate for the unified hosted surface (attn-7xl.1.5):
// axe-core WCAG 2.x A/AA scans of every designed page (including degraded
// states and open dialogs) plus keyboard-only operation of the primary flows.

async function expectNoAxeViolations(page: Page, context: string): Promise<void> {
  // Contrast sampling near images/webfonts is unstable until they finish
  // loading — settle the page before scanning.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images)
        // Lazy below-the-fold captures are intentionally not requested until
        // scrolled near; waiting for their load event here deadlocks WebKit.
        .filter((img) => img.loading !== 'lazy' && !img.complete)
        .map((img) => new Promise((resolve) => img.addEventListener('load', resolve, { once: true }))),
    );
  });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(' ')).slice(0, 5),
  }));
  expect(violations, `axe violations on ${context}`).toEqual([]);
}

for (const [path, name] of [
  ['/', 'landing'],
  ['/app', 'desk'],
  ['/app/w/ws-product/direction.md?shell=demo', 'editor'],
  ['/app/storage', 'storage'],
  ['/open', 'open'],
  ['/app?shell=private', 'desk (private browsing)'],
  ['/app?shell=blocked', 'desk (storage blocked)'],
] as const) {
  test(`axe: ${name}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('body')).toHaveAttribute('data-hydrated', 'true');
    await expectNoAxeViolations(page, name);
  });
}

test('axe: share sheet open', async ({ page }) => {
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await page.getByRole('button', { name: 'Share for review' }).click();
  await expect(page.getByRole('dialog', { name: 'Share files for review' })).toBeVisible();
  await expectNoAxeViolations(page, 'share sheet');
});

test('axe: comments docked beside the owner document', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await page.locator('[data-slot="comments-toggle"]').click();
  await expect(page.locator('.review-history-placeholder')).toBeVisible();
  await expectNoAxeViolations(page, 'comments dock');
});

test('axe: mobile editor with files sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await page.locator('.thumb-dock').getByRole('button', { name: 'Files' }).click();
  await expect(page.getByRole('dialog', { name: 'Files' })).toBeVisible();
  await expectNoAxeViolations(page, 'mobile files sheet');
});

test('keyboard-only: landing reaches both CTAs', async ({ browserName, page }) => {
  await page.goto('/');
  // Safari/WebKit uses Option+Tab for links unless the user's system setting
  // enables full keyboard navigation. Exercise the platform's real shortcut.
  const tabKey = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  // Tab from the top of the document into the nav and hero.
  const openDocument = page.locator('.hero a[data-action="open-document"]');
  const openDesk = page.locator('.hero a[data-action="open-desk"]');
  for (let presses = 0; presses < 25; presses += 1) {
    await page.keyboard.press(tabKey);
    if (await openDocument.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(openDocument).toBeFocused();
  await page.keyboard.press(tabKey);
  await expect(openDesk).toBeFocused();
});

test('landing keeps its security proof disclosed and its install command keyboard-readable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');

  const hero = page.locator('.hero');
  await expect(hero.locator('.button.primary')).toHaveCount(1);
  await expect(hero.locator('a[data-action]')).toHaveCount(2);
  await expect(page.locator('.site-nav .button.primary')).toHaveCount(0);
  await expect(page.locator('.secondary-start')).toContainText('Other ways to begin');
  await expect(page.locator('.secondary-start .button.primary')).toHaveCount(0);

  const threatModel = page.locator('details.threat-model');
  await expect(threatModel).toHaveJSProperty('open', false);
  await page
    .getByRole('textbox', { name: 'Install command: brew install lightsofapollo/attn/attn' })
    .scrollIntoViewIfNeeded();
  await page.getByText('Read the threat model', { exact: true }).click();
  await expect(threatModel).toHaveJSProperty('open', true);
  await expect(threatModel.getByRole('link', { name: 'relay-spec.md' })).toBeVisible();
  await expect(threatModel.getByRole('link', { name: 'security-review.md' })).toBeVisible();

  // A 200% root text scale makes the command wider than a narrow viewport.
  // The focusable command must still expose the clipped tail by keyboard.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  const command = page.getByRole('textbox', {
    name: 'Install command: brew install lightsofapollo/attn/attn',
  });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await command.evaluate((element) => element.scrollTo({ left: 0, behavior: 'auto' }));
    await expect.poll(() => command.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await command.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => command.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.keyboard.press('End');
    await expect.poll(() => command.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    expect(
      await page.evaluate(() => {
        const root = document.scrollingElement;
        return root ? root.scrollWidth - root.clientWidth : 0;
      }),
    ).toBe(0);
  }

  await expect(command).toHaveValue('brew install lightsofapollo/attn/attn');
  const copy = page.locator('.native-section .code-copy').first();
  await page.context().grantPermissions(['clipboard-write']);
  await copy.click();
  await expect(copy).toHaveAttribute('data-state', 'copied');
});

test('keyboard-only: share sheet opens, traps start focus, and closes', async ({ page }) => {
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  const share = page.getByRole('button', { name: 'Share for review' });
  await share.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Share files for review' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Share files for review' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(share).toBeFocused();
});

test('keyboard-only: desk rows and storage clear confirm are operable', async ({ page }) => {
  await page.goto('/app/storage');
  const clear = page.getByRole('button', { name: 'Clear all local attn data' });
  await clear.focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(confirm).not.toBeVisible();
});

test('authoring controls move focus into transient inputs and restore it on cancel', async ({ page }) => {
  await page.goto('/app#new');
  // The per-file flows below drive the tree row's context menu, and a bare
  // workspace mounts no rail to hold it (attn-mkmz.5) — give it a second file,
  // then reopen untitled.md so the preconditions are otherwise unchanged.
  // untitled.md needs content first, or the import supersedes it
  // (attn-rjuo.3.1) and there is no row left to right-click.
  await page.locator('[data-body-text] .ProseMirror').click();
  await page.keyboard.type('Seed.');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('option', { name: /Add files to this workspace/u }).click();
  await (await chooser).setFiles({
    name: 'second.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Second\n'),
  });
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toBeVisible();
  await page.getByRole('button', { name: 'untitled.md', exact: true }).click();
  await expect(page).toHaveURL(/\/untitled\.md$/u);

  const documentEditor = page.getByRole('textbox', { name: 'Document editor' });
  await expect(documentEditor).toHaveAttribute('aria-multiline', 'true');
  await expect(documentEditor).toHaveAttribute('aria-readonly', 'false');

  const projectPicker = page.getByRole('combobox', { name: 'Project picker' });
  const triggerBox = await projectPicker.boundingBox();
  await projectPicker.click();
  await page.getByRole('menuitem', { name: 'Rename workspace' }).click();
  const workspaceInput = page.getByRole('textbox', { name: 'Workspace title' });
  await expect(workspaceInput).toBeFocused();
  /* IN PLACE (attn-rjuo.2.1). The rename used to render in the header's ACTIONS
     cluster, at the far right, editing a name that sat at the far left — an
     unstyled field floating beside Share, which read as a rendering fault. It
     now takes the name's own slot, so assert the geometry and not merely that
     an input exists somewhere. */
  const inputBox = await workspaceInput.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(Math.abs(inputBox!.x - triggerBox!.x)).toBeLessThanOrEqual(8);
  expect(Math.abs(inputBox!.y - triggerBox!.y)).toBeLessThanOrEqual(8);
  await page.keyboard.press('Escape');
  await expect(projectPicker).toBeFocused();

  const fileRow = page.getByRole('button', { name: 'untitled.md', exact: true });
  const fileRowBox = await fileRow.boundingBox();
  await fileRow.click({ button: 'right' });
  const fileRename = page.getByRole('menuitem', { name: 'Rename…', exact: true });
  await fileRename.click();
  const pathInput = page.getByRole('textbox', { name: 'New path' });
  await expect(pathInput).toBeFocused();
  /* ON THE ROW (user ruling, 2026-08-20), for the reason the workspace rename
     above is pinned the same way. This field used to render in the rail's
     FOOTER — bottom of a column whose top held the row it renamed, hundreds of
     pixels apart with nothing joining them. Assert the geometry, not merely
     that an input exists somewhere in the rail. */
  const pathInputBox = await pathInput.boundingBox();
  expect(fileRowBox).not.toBeNull();
  expect(pathInputBox).not.toBeNull();
  expect(pathInputBox!.y).toBeGreaterThanOrEqual(fileRowBox!.y - 2);
  expect(pathInputBox!.y + pathInputBox!.height).toBeLessThanOrEqual(
    fileRowBox!.y + fileRowBox!.height + 2,
  );
  await page.keyboard.press('Escape');
  await expect(fileRow).toBeFocused();

  // New Markdown moved to the command palette; Escape from the transient
  // path input returns focus to the project picker, which lives in the header.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('option', { name: /New Markdown file/u }).click();
  await expect(page.getByRole('textbox', { name: 'New Markdown file path' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(projectPicker).toBeFocused();

  await fileRow.click({ button: 'right' });
  const deleteFile = page.getByRole('menuitem', { name: 'Delete…', exact: true });
  await deleteFile.click();
  const deleteConfirmation = page.getByRole('group', { name: /Delete untitled\.md/u });
  await expect(deleteConfirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteConfirmation).not.toBeVisible();
  await expect(fileRow).toBeFocused();
});

test('mobile edit mode makes the visible writing canvas a full-height editor target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app#new');
  await page.locator('.thumb-dock').getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('textbox', { name: 'Document editor' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');

  const geometry = await page.evaluate(() => {
    const editable = document.querySelector<HTMLElement>('.writing-sheet .ProseMirror');
    const dock = document.querySelector<HTMLElement>('.thumb-dock');
    if (!editable || !dock) throw new Error('mobile editor geometry is unavailable');
    const editorRect = editable.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    return {
      editorBottom: editorRect.bottom,
      dockTop: dockRect.top,
      clickX: editorRect.left + editorRect.width / 2,
      // Stay above the fixed formatting bar while still targeting the blank
      // lower canvas that used to fall outside ProseMirror.
      clickY: dockRect.top - 96,
    };
  });
  expect(geometry.editorBottom).toBeGreaterThanOrEqual(geometry.dockTop);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.click(geometry.clickX, geometry.clickY);
  await expect(editor).toBeFocused();
});
