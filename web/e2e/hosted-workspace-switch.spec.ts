// In-place workspace switching (attn-e9r2).
//
// Desktop switches workspaces without unmounting the editor: same EditorShell,
// new `workspace` prop. Three separate defects lived in that seam — an import
// still reading bytes finished against whichever workspace was on screen by
// then, a pending lease acquisition installed workspace A's session as
// workspace B's, and the departed workspace's runtime (lease, heartbeat,
// local-collab hub, review transport) was never handed back. The races
// themselves are pinned deterministically in the unit suites
// (import-into-workspace.test.ts, owner-session-gate.test.ts,
// workspace-service.test.ts); this spec is the end-to-end floor: after real
// switching in the real app, each workspace still holds its own text, and a
// workspace this tab has left is writable from another tab.

import { expect, test, type Page } from '@playwright/test';

function editor(page: Page) {
  return page.locator('[data-body-text] .ProseMirror');
}

async function switchTo(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByPlaceholder('Search projects...').fill(name);
  await page.locator('.sidebar-project-menu-item').filter({ hasText: name }).click();
}

/** Wait for the durable commit, exactly as the authoring suite does — a page
 *  load taken inside the autosave debounce loses the text either way. */
async function settled(page: Page) {
  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Changes autosaved',
    { timeout: 15_000 },
  );
}

async function rename(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByRole('menuitem', { name: 'Rename workspace' }).click();
  const title = page.getByRole('textbox', { name: 'Workspace title' });
  await title.fill(name);
  await title.press('Enter');
}

test('in-place switching keeps each workspace’s text in its own workspace', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto('/app#new');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await rename(page, 'Alpha');
  const alphaUrl = page.url();
  await editor(page).click();
  await page.keyboard.type('alpha body');
  await settled(page);

  // New workspace, in place: same EditorShell, new workspace prop.
  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await rename(page, 'Beta');
  const betaUrl = page.url();
  expect(betaUrl).not.toBe(alphaUrl);
  await editor(page).click();
  await page.keyboard.type('beta body');
  await settled(page);

  // Back and forth twice: every switch tears one runtime down and builds another.
  await switchTo(page, 'Alpha');
  await expect(page).toHaveURL(alphaUrl);
  await expect(editor(page)).toContainText('alpha body');
  await expect(editor(page)).not.toContainText('beta body');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');

  await switchTo(page, 'Beta');
  await expect(page).toHaveURL(betaUrl);
  await expect(editor(page)).toContainText('beta body');
  await expect(editor(page)).not.toContainText('alpha body');
  await editor(page).click();
  await page.keyboard.type(' more');
  await settled(page);

  await switchTo(page, 'Alpha');
  await expect(editor(page)).toContainText('alpha body');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');

  // Durability: reload each and confirm autosave committed to the right one.
  await page.goto(betaUrl);
  await expect(editor(page)).toContainText('beta body more');
  await expect(editor(page)).not.toContainText('alpha body');
  await page.goto(alphaUrl);
  await expect(editor(page)).toContainText('alpha body');
  await expect(editor(page)).not.toContainText('beta body');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a second tab takes the pen of a workspace the first tab has left', async ({ context, page }) => {
  await page.goto('/app#new');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await rename(page, 'Gamma');
  const gammaUrl = page.url();
  await editor(page).click();
  await page.keyboard.type('gamma body');
  await settled(page);

  await page.getByRole('combobox', { name: 'Project picker' }).click();
  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await rename(page, 'Delta');

  // The first tab has LEFT Gamma. A second tab must be able to write it.
  const second = await context.newPage();
  await second.goto(gammaUrl);
  await expect(editor(second)).toHaveAttribute('contenteditable', 'true');
  await editor(second).click();
  await second.keyboard.press('ControlOrMeta+End');
  await second.keyboard.type(' from the second tab');
  await settled(second);
  await second.reload();
  await expect(editor(second)).toContainText('gamma body from the second tab');
  await second.close();
});
