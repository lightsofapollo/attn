// Dialog scrolling — real layout, real components, real compiled CSS.
//
// attn-11g4.1.1: the share modal could not be scrolled. The ScrollArea viewport
// sized itself with `size-full` (`height: 100%`), which only resolves against a
// containing block with a DEFINITE height. `DialogContent` is `max-h-[85vh]`
// with `height: auto`, so the ScrollArea root's height comes out of flex layout
// of an indefinite-height container and is not definite for percentage
// resolution. `height: 100%` fell back to `auto`, the viewport grew to its full
// content height (`scrollHeight === clientHeight` — nothing to scroll) and the
// overflow was silently clipped by the dialog's `overflow-hidden`.
//
// Measured against this very spec on a pre-fix bundle, at a 420px window:
// dialog 357px, viewport clientHeight 529px, last section's bottom edge 150px
// BELOW the dialog's bottom edge and unreachable. After the fix: viewport
// 355px, scrollHeight 529px, scrolls to the last line.
//
// Why the Settings dialog and not the share modal: this spec drives the NATIVE
// bundle, where `dialog-content.svelte` is shared by every dialog. Settings is
// the one that opens in a single click with no fixture state, and it is a real
// product surface. It was broken by the same bug — it simply needs a short
// window rather than long content, which is why nobody had noticed. The share
// modal needs an open document, and the hosted build's share sheet is a bespoke
// component that does not use `Dialog.Content` at all.
//
// Companion: `src/lib/components/ui/scroll-area/scroll-area-sizing.test.ts`
// pins the class contract under the (layout-free) Node unit harness. THIS file
// is the one that proves a scrollable box actually results.
//
// Requires the native bundle: `cd web && npm run build`. No server needed — the
// bundle is single-file and boots its own mock IPC when no wry bridge is found.
// Run with: `npx playwright test e2e/dialog-scroll.spec.ts`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.html');
const BUNDLE_URL = `file://${BUNDLE}`;

/** The 85vh ceiling `dialog-content.svelte` puts on every dialog. */
const CAP_RATIO = 0.85;

test.beforeAll(() => {
  test.skip(
    !fs.existsSync(BUNDLE),
    `native bundle missing at ${BUNDLE} — run \`npm run build\` in web/ first`,
  );
});

/**
 * Open the Settings dialog and return a handle to it.
 *
 * `SettingsDialog` passes its own `data-slot`, which REPLACES
 * `dialog-content`'s — hence the role selector rather than
 * `[data-slot="dialog-content"]`.
 */
async function openDialog(page: Page) {
  await page.goto(BUNDLE_URL);
  const settings = page.getByRole('button', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await settings.click();
  const dialog = page.locator('[role="dialog"][data-state="open"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="dialog-content-body"]')).toBeVisible();
  return dialog;
}

/**
 * Scroll the dialog's body to the bottom and measure whether its last element
 * ended up inside the dialog's own box.
 *
 * Deliberately NOT `toBeInViewport()`: the dialog clips with `overflow-hidden`,
 * so a clipped element can still intersect the browser viewport and pass. At a
 * 560px window the pre-fix build put the last section at y=549 — inside the
 * window, invisible in the dialog. The containment test has to be against the
 * DIALOG's rect, not the window's.
 */
async function scrollToEnd(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][data-state="open"]');
    if (!dialog) throw new Error('no open dialog');
    const viewport = dialog.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const body = dialog.querySelector('[data-slot="dialog-content-body"]');
    if (!viewport || !body) throw new Error('dialog is missing its scrolling body');
    const last = body.lastElementChild;
    if (!last) throw new Error('dialog body is empty');

    viewport.scrollTop = viewport.scrollHeight;
    const lastRect = last.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    return {
      windowHeight: window.innerHeight,
      dialogHeight: dialogRect.height,
      viewportClientHeight: viewport.clientHeight,
      viewportScrollHeight: viewport.scrollHeight,
      overflows: viewport.scrollHeight > viewport.clientHeight,
      // 1px of slack throughout: subpixel layout, not a real gap.
      lastInsideDialog: lastRect.bottom <= dialogRect.bottom + 1 && lastRect.top >= dialogRect.top - 1,
      lastOverhang: lastRect.bottom - dialogRect.bottom,
    };
  });
}

test('a dialog taller than the window scrolls to its last element', async ({ page }) => {
  // 420px window → 357px cap against ~529px of Settings content.
  await page.setViewportSize({ width: 1200, height: 420 });
  await openDialog(page);

  const result = await scrollToEnd(page);

  // The bug, stated directly: the box must actually be scrollable. Pre-fix this
  // was false — clientHeight had grown to equal scrollHeight.
  expect(result.overflows).toBe(true);
  expect(result.viewportScrollHeight).toBeGreaterThan(result.viewportClientHeight);
  // And the last element must be reachable, not clipped away. Pre-fix it
  // overhung the dialog's bottom edge by ~150px.
  expect(result.lastInsideDialog).toBe(true);
  expect(result.lastOverhang).toBeLessThanOrEqual(1);
});

test('the dialog honours its 85vh ceiling instead of growing past the window', async ({ page }) => {
  // Guards the other way out of the bug: capping content or dropping the
  // ceiling would also make "nothing is clipped" true, and would be wrong.
  await page.setViewportSize({ width: 1200, height: 420 });
  await openDialog(page);
  const { dialogHeight, windowHeight } = await scrollToEnd(page);
  expect(dialogHeight).toBeLessThanOrEqual(CAP_RATIO * windowHeight + 1);
});

for (const height of [420, 560, 700, 900, 1400]) {
  test(`the last element is reachable at a ${height}px window`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height });
    await openDialog(page);
    const result = await scrollToEnd(page);

    // Holds whether or not the content overflows: short windows scroll, tall
    // windows simply fit. Pre-fix, 420 and 560 both failed here.
    expect(result.lastInsideDialog).toBe(true);
    // Whenever the dialog IS at its ceiling, it must be scrollable rather than
    // clipped — the two must never both be true.
    if (result.dialogHeight >= CAP_RATIO * result.windowHeight - 1) {
      expect(result.overflows).toBe(true);
    }
  });
}

test('the close button stays pinned to the frame while the body scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 420 });
  const dialog = await openDialog(page);
  const close = dialog.getByRole('button', { name: 'Close' });
  await expect(close).toBeVisible();

  const before = await close.boundingBox();
  await scrollToEnd(page);
  const after = await close.boundingBox();

  // The close affordance lives outside the scrolling body on purpose. If it
  // ever moves with the content, it has been pulled inside the scroller.
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  await expect(close).toBeInViewport();
});

// ---------------------------------------------------------------------------
// Horizontal axis (attn-mz25)
//
// The vertical bug above was fixed and guarded; the SAME dialog then shipped
// the mirror-image bug on the other axis, unguarded, and reached a user. A
// bare `grid` has one implicit column sized `auto` = `minmax(auto,
// max-content)`. Inside a scroll container that resolves to the widest child's
// max-content width rather than the dialog's own, so one unbreakable string —
// a `font-mono` filesystem path in the share modal — laid every row out wider
// than the dialog, where `overflow-hidden` silently CLIPPED it. Measured on
// the pre-fix bundle in the real app: a 542px column inside a 446px content
// box, 32 elements up to 70px past the right edge, buttons cut in half.
//
// `grid-cols-[minmax(0,1fr)]` resolves against the dialog instead. These two
// tests are the guard the first fix should have come with.
// ---------------------------------------------------------------------------

/** Every descendant laid out past either vertical edge of the dialog. */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][data-state="open"]');
    if (!dialog) throw new Error('no open dialog');
    const rect = dialog.getBoundingClientRect();
    const offenders: { tag: string; classes: string; pastRight: number; pastLeft: number }[] = [];
    for (const el of dialog.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      // 1px of slack: subpixel layout, not a real escape.
      if (r.right > rect.right + 1 || r.left < rect.left - 1) {
        offenders.push({
          tag: el.tagName,
          classes: String((el as HTMLElement).className).slice(0, 60),
          pastRight: Math.round(r.right - rect.right),
          pastLeft: Math.round(rect.left - r.left),
        });
      }
    }
    return { dialogWidth: Math.round(rect.width), offenders };
  });
}

for (const width of [480, 760, 1200]) {
  test(`no dialog content escapes horizontally at a ${width}px window`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openDialog(page);
    const { offenders } = await horizontalOverflow(page);
    expect(offenders).toEqual([]);
  });
}

test('an unbreakable string truncates instead of widening the dialog', async ({ page }) => {
  // The share modal's real trigger, reduced: a long token with no break
  // opportunity has an enormous max-content width. It must be the CHILD that
  // gives (truncate/ellipsis), never the dialog that grows. Pre-fix this
  // widened the implicit grid column and pushed every sibling off the edge,
  // so it fails loudly on the old bundle.
  await page.setViewportSize({ width: 900, height: 900 });
  await openDialog(page);

  const widthBefore = (await horizontalOverflow(page)).dialogWidth;

  await page.evaluate(() => {
    const body = document.querySelector('[data-slot="dialog-content-body"]');
    if (!body) throw new Error('dialog body missing');
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'unbreakable-probe');
    row.className = 'flex items-center gap-3 text-xs';
    const label = document.createElement('span');
    label.className = 'min-w-0 truncate font-mono';
    label.textContent = `/Users/someone/${'a-very-long-path-segment/'.repeat(12)}document.md`;
    row.appendChild(label);
    body.appendChild(row);
  });

  const after = await horizontalOverflow(page);
  expect(after.offenders).toEqual([]);
  // And the dialog itself must not have been stretched by the intruder.
  expect(after.dialogWidth).toBeLessThanOrEqual(widthBefore + 1);
});

test('no ScrollArea viewport outgrows its own root', async ({ page }) => {
  // Blast-radius guard. The fix changed the SHARED ScrollArea, so assert the
  // invariant generically across every ScrollArea the app has mounted, not just
  // the one in the dialog. A viewport taller than its root IS the bug's
  // signature — that is how content escapes and gets clipped.
  await page.setViewportSize({ width: 1200, height: 420 });
  await openDialog(page);

  const offenders = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="scroll-area"]')]
      .map((root) => {
        const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
        if (!viewport) return null;
        const rootHeight = root.getBoundingClientRect().height;
        const viewportHeight = viewport.getBoundingClientRect().height;
        return viewportHeight > rootHeight + 1
          ? { rootHeight, viewportHeight, classes: root.className }
          : null;
      })
      .filter((entry) => entry !== null),
  );

  expect(offenders).toEqual([]);
});
