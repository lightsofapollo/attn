// The sidebar's controls must fit the sidebar at every width it can be
// dragged to (2026-08-10, reported on the desktop app).
//
// THE BUG. The sidebar is user-resizable between SIDEBAR_MIN_WIDTH (180px) and
// SIDEBAR_MAX_WIDTH (480px). Near the bottom of that range the filter bar
// stopped shrinking at 194px and hung out over the document — visible as a
// search field crossing the sidebar's own edge.
//
// TWO CAUSES, BOTH REQUIRED FOR THE FIX, which is why this test measures the
// controls rather than eyeballing a screenshot:
//
//  1. `.sidebar-controls` is a GRID, and grid items default to
//     `min-width: auto` — they refuse to shrink below their own min-content.
//  2. That min-content was dominated by the text input's INTRINSIC width. An
//     `<input>` is sized from its `size` attribute (default 20 characters,
//     ~130px), and `min-width: 0` on the input does NOT remove it: that
//     declaration governs flex shrinking inside the filter, not the filter's
//     min-content contribution to the grid above it.
//
// Fixing either alone leaves the overflow, so this asserts the OUTCOME (every
// control inside its container at every width) rather than the mechanism.
//
//   cd web && npx playwright test --config playwright.native-share.config.ts sidebar-narrow
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = [
  path.join(DIR, '../../tests/fixtures/reading-palette.md'),
  path.join(DIR, '../../tests/fixtures/basic.md'),
];

/** SIDEBAR_MIN_WIDTH / SIDEBAR_MAX_WIDTH in ui/sidebar/constants.ts, plus the
 *  default. 170 is deliberately BELOW the clamp: the layout should not depend
 *  on the clamp holding, and a future minimum must not silently reintroduce
 *  the overflow. */
const WIDTHS = [170, 180, 200, 240, 320, 480];

test.describe('resizable sidebar', () => {
  for (const width of WIDTHS) {
    test(`controls fit at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.goto('/');
      const picker = page.locator('input[type=file]').first();
      await picker.waitFor({ state: 'attached' });
      await picker.setInputFiles(FIXTURES);
      await expect(page.locator('[data-sidebar-controls="true"]')).toBeVisible();

      await page.evaluate((w) => {
        const wrapper = document.querySelector('[data-slot=sidebar-wrapper]') as HTMLElement;
        wrapper.style.setProperty('--sidebar-width', `${w}px`);
      }, width);
      await page.waitForTimeout(250);

      const overflows = await page.evaluate(() => {
        const container = document.querySelector('[data-slot=sidebar-container]');
        if (!container) return ['no sidebar container'];
        const bounds = container.getBoundingClientRect();
        const offenders: string[] = [];
        // Every laid-out descendant of the sidebar, not just the filter: the
        // next control to acquire an intrinsic floor should fail here too.
        for (const el of Array.from(container.querySelectorAll('*'))) {
          const style = getComputedStyle(el);
          if (style.position === 'fixed' || style.position === 'absolute') continue;
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          // 1px of tolerance for subpixel rounding.
          if (r.right > bounds.right + 1) {
            const cls = (el.className || '').toString().split(' ')[0] || el.tagName.toLowerCase();
            offenders.push(
              `${cls}: right=${Math.round(r.right)} > sidebar right=${Math.round(bounds.right)} (w=${Math.round(r.width)})`,
            );
          }
        }
        return [...new Set(offenders)];
      });

      expect(overflows).toEqual([]);
    });
  }

  test('the filter still works once it can shrink', async ({ page }) => {
    // Shrinking must not cost the control its job: `size="1"` removes an
    // intrinsic WIDTH, not the field's behaviour, and the `/` hint and clear
    // affordance both live in the same flex row that now shrinks.
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto('/');
    const picker = page.locator('input[type=file]').first();
    await picker.waitFor({ state: 'attached' });
    await picker.setInputFiles(FIXTURES);
    await expect(page.locator('[data-sidebar-controls="true"]')).toBeVisible();
    await page.evaluate(() => {
      const wrapper = document.querySelector('[data-slot=sidebar-wrapper]') as HTMLElement;
      wrapper.style.setProperty('--sidebar-width', '180px');
    });

    const input = page.locator('.sidebar-filter-input');
    await input.fill('basic');
    await expect(page.locator('.sidebar-filter-clear')).toBeVisible();
    // Filtering still narrows the tree to the match.
    const rows = page.locator('[data-sidebar=menu-button]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('basic.md');
  });
});
