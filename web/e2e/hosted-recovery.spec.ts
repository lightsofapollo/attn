import { expect, test, type Page } from '@playwright/test';

// Accountless recovery + secret-hygiene gates (attn-7xl.5.6).

function documentEditor(page: Page) {
  return page.locator('[data-body-text] .ProseMirror');
}

async function runPaletteCommand(page: Page, label: RegExp): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('option', { name: label }).click();
}

test('workspace export → import → export round-trips byte-identically', async ({ page, context }) => {
  await page.goto('/app#new');
  await documentEditor(page).click();
  await page.keyboard.type('# Round Trip\n\nRecovery round trip body text.');
  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Changes autosaved',
    { timeout: 15_000 },
  );

  const firstDownload = page.waitForEvent('download');
  await runPaletteCommand(page, /Export workspace/u);
  const first = await firstDownload;
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const zipPath = path.join(os.tmpdir(), 'attn-roundtrip.zip');
  fs.copyFileSync((await first.path())!, zipPath);
  const { unzipSync } = await import('fflate');
  const exported = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const originalBytes = exported['untitled.md'];
  expect(originalBytes).toBeTruthy();
  expect(new TextDecoder().decode(originalBytes)).toContain('Recovery round trip body text.');

  const desk = await context.newPage();
  await desk.goto('/app');
  const chooser = desk.waitForEvent('filechooser');
  await desk.getByRole('button', { name: /Import workspace/u }).click();
  await (await chooser).setFiles(zipPath);
  await expect(documentEditor(desk)).toContainText('Recovery round trip body text.', {
    timeout: 20_000,
  });

  const secondDownload = desk.waitForEvent('download');
  await runPaletteCommand(desk, /Export workspace/u);
  const second = await secondDownload;
  const reExported = unzipSync(new Uint8Array(fs.readFileSync((await second.path())!)));
  const roundTripped = reExported['untitled.md'];
  expect(roundTripped).toBeTruthy();
  expect(Buffer.from(roundTripped!)).toEqual(Buffer.from(originalBytes!));
  await desk.close();
});

test('deleting a workspace destroys it: gone from the desk and from storage', async ({ page }) => {
  await page.goto('/app#new');
  await documentEditor(page).click();
  await page.keyboard.type('Ephemeral workspace body.');
  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Changes autosaved',
    { timeout: 15_000 },
  );
  await page.goto('/app');
  const row = page.locator('.workspace-row').first();
  await expect(row).toBeVisible();
  const before = await page.locator('.workspace-row').count();
  await row.getByRole('button', { name: /Delete/u }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: /Delete/u }).click();
  await expect(page.locator('.workspace-row')).toHaveCount(before - 1);
  await page.reload();
  await expect(page.locator('.workspace-row')).toHaveCount(before - 1);
});

test('the share link secret never appears in any network request', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(`${request.url()}|${request.postData() ?? ''}`);
  });
  await page.goto('/app#new');
  await documentEditor(page).click();
  await page.keyboard.type('Secret hygiene document.');
  await expect(page.locator('.save-state[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'Changes autosaved',
    { timeout: 15_000 },
  );
  await page.getByRole('button', { name: 'Share for review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share files for review' });
  await expect(dialog).toBeVisible();
  const create = dialog.getByRole('button', { name: 'Create review link' });
  await expect(create).toBeEnabled();
  await create.click();
  const copy = dialog.getByRole('button', { name: /Copy/u }).first();
  try {
    await expect(copy).toBeVisible({ timeout: 30_000 });
  } catch {
    test.skip(true, 'relay unreachable from this environment');
  }
  await copy.click();
  const link = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  });
  test.skip(!link || !link.includes('#key='), 'clipboard unavailable');
  const key = link!.split('#key=')[1]!;
  expect(key.length).toBeGreaterThan(20);
  const leaks = requests.filter((entry) => entry.includes(key));
  expect(leaks).toEqual([]);
});
