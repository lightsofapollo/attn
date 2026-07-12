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
  await expect(page.getByRole('dialog', { name: 'Share for review' })).toBeVisible();
  await expectNoAxeViolations(page, 'share sheet');
});

test('axe: mobile editor with files sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  await page.locator('.thumb-dock').getByRole('button', { name: 'Files' }).click();
  await expect(page.getByRole('dialog', { name: /Files · 5/u })).toBeVisible();
  await expectNoAxeViolations(page, 'mobile files sheet');
});

test('keyboard-only: landing reaches both CTAs', async ({ browserName, page }) => {
  await page.goto('/');
  // Safari/WebKit uses Option+Tab for links unless the user's system setting
  // enables full keyboard navigation. Exercise the platform's real shortcut.
  const tabKey = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  // Tab from the top of the document into the nav and hero.
  const newWorkspace = page.locator('.hero a[data-action="new-workspace"]');
  const openDesk = page.locator('.hero a[data-action="open-desk"]');
  for (let presses = 0; presses < 25; presses += 1) {
    await page.keyboard.press(tabKey);
    if (await newWorkspace.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(newWorkspace).toBeFocused();
  await page.keyboard.press(tabKey);
  await expect(openDesk).toBeFocused();
});

test('keyboard-only: share sheet opens, traps start focus, and closes', async ({ page }) => {
  await page.goto('/app/w/ws-product/direction.md?shell=demo');
  const share = page.getByRole('button', { name: 'Share for review' });
  await share.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Share for review' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Share for review' })).toBeFocused();
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
  const documentEditor = page.getByRole('textbox', { name: 'Document editor' });
  await expect(documentEditor).toHaveAttribute('aria-multiline', 'true');
  await expect(documentEditor).toHaveAttribute('aria-readonly', 'false');

  const workspaceRename = page.getByRole('button', { name: 'Rename workspace' });
  await workspaceRename.focus();
  await page.keyboard.press('Enter');
  const workspaceInput = page.getByRole('textbox', { name: 'Workspace title' });
  await expect(workspaceInput).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(workspaceRename).toBeFocused();

  const fileRename = page.getByRole('button', { name: 'Rename', exact: true });
  await fileRename.focus();
  await page.keyboard.press('Enter');
  const pathInput = page.getByRole('textbox', { name: 'New path' });
  await expect(pathInput).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(fileRename).toBeFocused();

  const addMarkdown = page.getByRole('button', { name: 'New Markdown' });
  await addMarkdown.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'New Markdown file path' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(addMarkdown).toBeFocused();

  const deleteFile = page.getByRole('button', { name: 'Delete', exact: true });
  await deleteFile.focus();
  await page.keyboard.press('Enter');
  const deleteDialog = page.getByRole('alertdialog', { name: /Delete untitled\.md/u });
  await expect(deleteDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteDialog).not.toBeVisible();
  await expect(deleteFile).toBeFocused();
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
