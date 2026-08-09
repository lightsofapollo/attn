// The whole of attn-64iy, verified in a real browser tab.
//
// Every item in that epic was reported from a running app, and the two biggest
// are invisible to a unit test by construction: the comment round trip only
// breaks once a real share has published (or failed to publish) a snapshot, and
// the chrome differs BY SHELL, so it cannot be checked from one environment.
// Source-level tests pin the wiring; this pins the behaviour.
//
// This is the BROWSER half. The desktop half is a manual pass — a wry window
// cannot be driven from Playwright — and is recorded in the issue.
//
//   cd web && npx playwright test --config playwright.native-share.config.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');

/**
 * Boot the raw dev loop with a FOLDER open.
 *
 * Two files, not one: `openLocalFiles` deliberately delivers a single file
 * without a tree ("one file does not deserve a file browser"), and the sidebar
 * is exactly what the brand-placement half of this epic is about.
 */
async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  const picker = page.locator('input[type=file]').first();
  await picker.waitFor({ state: 'attached' });
  await picker.setInputFiles([
    path.join(FIXTURES, 'basic.md'),
    path.join(FIXTURES, 'typography.md'),
  ]);
  await expect(page.locator('[data-sidebar-controls="true"]')).toBeVisible();
}

/**
 * Share the open workspace and get back to the document.
 *
 * `[data-slot=share-start]` is one button through the whole flow — "Create
 * review link…", then "Minting…", then "Done" — so it is clicked twice. The
 * second click matters: the sheet stays up showing the invite links, and a
 * modal left open swallows every later click on the page behind it.
 */
async function share(page: Page): Promise<void> {
  await page.locator('[data-slot=native-header-share]').click();
  const namePrompt = page.getByRole('button', { name: /^(Skip|Continue)$/u }).first();
  if (await namePrompt.isVisible().catch(() => false)) await namePrompt.click();

  const dialog = page.locator('[data-slot="share-dialog"]');
  await expect(dialog).toBeVisible();
  const startButton = dialog.locator('[data-slot=share-start]');
  await expect(startButton).toBeEnabled();
  await startButton.click();

  await expect(startButton).toHaveText(/Done/u);
  await startButton.click();
  await expect(dialog).toBeHidden();

  // The chip going live is the app's own signal that a room exists.
  await expect(page.locator('[data-slot=share-chip][data-active=true]')).toBeVisible();
}

test.describe('shell-aware chrome (attn-64iy.5)', () => {
  test('the brand takes the freed top-left corner, and reserves nothing for absent traffic lights', async ({
    page,
  }) => {
    await openWorkspace(page);

    // In a browser the corner is free, so the mark belongs in the sidebar.
    const sidebarBrand = page.locator('[data-slot=sidebar-brand]');
    await expect(sidebarBrand).toBeVisible();
    await expect(page.locator('[data-slot=native-brand]')).toHaveCount(0);

    // And it must be ABOVE the project label, not merged into it.
    const brandBox = await sidebarBrand.boundingBox();
    const projectBox = await page.locator('.sidebar-project-row').boundingBox();
    expect(brandBox).not.toBeNull();
    expect(projectBox).not.toBeNull();
    expect(brandBox!.y + brandBox!.height).toBeLessThanOrEqual(projectBox!.y + 1);

    // The 46px drag strip clears traffic lights that a browser does not have.
    // Its absence is what frees the corner above.
    await expect(page.locator('[aria-label="Drag window"]')).toHaveCount(0);
    expect(brandBox!.y).toBeLessThan(40);

    // The header declares which shell it resolved, and drops the 6.5rem
    // traffic-light indent it used to apply unconditionally.
    await expect(page.locator('[data-slot=native-header]')).toHaveAttribute(
      'data-shell',
      'browser',
    );
  });

  test('with no sidebar the brand falls back to the header rather than vanishing', async ({
    page,
  }) => {
    // Nothing opened: the app must not go unbranded in its own empty state.
    await page.goto('/');
    await expect(page.locator('[data-slot=empty-workspace]')).toBeVisible();
    await expect(page.locator('[data-slot=native-brand]')).toBeVisible();
    await expect(page.locator('[data-slot=sidebar-brand]')).toHaveCount(0);
  });
});

test.describe('header action cluster (attn-64iy.3 / .4 / .6)', () => {
  test('no zero-width flex child survives in the dock', async ({ page }) => {
    await openWorkspace(page);
    await share(page);

    // THE BUG: three wrapper divs rendered even when their children rendered
    // nothing, and an empty flex item still consumes the row's gap on both
    // sides. That dead space all landed between the share control and the
    // comments toggle, which is the uneven spacing that was reported.
    const empties = await page.evaluate(() => {
      const dock = document.querySelector('[data-slot=review-bar-dock]');
      if (!dock) return ['no dock'];
      return Array.from(dock.children)
        .filter((el) => {
          const style = getComputedStyle(el);
          if (style.position === 'absolute' || style.display === 'none') return false;
          return el.getBoundingClientRect().width === 0;
        })
        .map((el) => el.outerHTML.slice(0, 80));
    });
    expect(empties).toEqual([]);
  });

  test('gaps between the header controls are uniform', async ({ page }) => {
    await openWorkspace(page);
    await share(page);

    const gaps = await page.evaluate(() => {
      const cluster = document.querySelector('[data-slot=native-header] .ml-auto');
      if (!cluster) return null;
      // Every laid-out leaf control in the cluster, in visual order.
      const boxes = Array.from(cluster.querySelectorAll('button, [role=status]'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0)
        .sort((a, b) => a.left - b.left);
      const out: number[] = [];
      for (let i = 1; i < boxes.length; i += 1) out.push(Math.round(boxes[i]!.left - boxes[i - 1]!.right));
      return out;
    });
    expect(gaps).not.toBeNull();
    expect(gaps!.length).toBeGreaterThan(1);
    // One divider is allowed to widen a single seam; nothing may be a chasm.
    // Before the fix the share→toggle seam was ~5x its neighbours.
    const max = Math.max(...gaps!);
    const min = Math.min(...gaps!);
    expect(max - min).toBeLessThanOrEqual(14);
  });

  test('the share chip rests borderless and pills when its popover opens', async ({ page }) => {
    await openWorkspace(page);
    await share(page);

    const chip = page.locator('[data-slot=share-chip]');
    // The chip's own state marker first: if this is already 'open' with no
    // popover showing, the bug is in what feeds `surfaceOpen`, not in the CSS.
    await expect(chip).toHaveAttribute('data-surface', 'closed');
    // POLLED, because the chip carries `transition-colors`: closing the share
    // sheet flips the class immediately but the paint eases over ~150ms, so a
    // single synchronous read catches the outgoing colour, not the resting one.
    // `border-transparent` settles to a fully transparent colour.
    await expect
      .poll(async () => chip.evaluate((el) => getComputedStyle(el).borderTopColor))
      .toMatch(/(rgba\(.*,\s*0\)|\/\s*0\))/u);
    const restingBorder = await chip.evaluate((el) => getComputedStyle(el).borderTopColor);

    await chip.click();
    await expect(chip).toHaveAttribute('data-surface', 'open');
    await expect
      .poll(async () => chip.evaluate((el) => getComputedStyle(el).borderTopColor))
      .not.toBe(restingBorder);
  });

  test('the comments toggle uses the panel-right glyph pair', async ({ page }) => {
    await openWorkspace(page);
    await share(page);

    const toggle = page.locator('[data-slot=review-bar-rail-toggle]');
    await expect(toggle).toBeVisible();

    // lucide renders the glyph name onto the <svg> class list.
    const glyphFor = async () =>
      toggle.locator('svg').first().getAttribute('class');
    const pressed = await toggle.getAttribute('aria-pressed');
    expect(await glyphFor()).toMatch(pressed === 'true' ? /panel-right-close/u : /panel-right-open/u);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
    expect(await glyphFor()).toMatch(pressed === 'true' ? /panel-right-open/u : /panel-right-close/u);

    // A speech bubble would say "add a comment"; this opens a panel.
    await expect(toggle.locator('svg.lucide-message-square-text')).toHaveCount(0);
  });
});

test.describe('sidebar filter (attn-64iy.7)', () => {
  test('draws its box at rest and still shows focus', async ({ page }) => {
    await openWorkspace(page);
    const filter = page.locator('.sidebar-filter');
    await expect(filter).toBeVisible();

    const resting = await filter.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopColor, shadow: s.boxShadow };
    });
    expect(resting.border).not.toMatch(/rgba\(.*,\s*0\)/u);

    await filter.locator('input').focus();
    const focused = await filter.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopColor, shadow: s.boxShadow };
    });
    // Focus must remain distinguishable now that the box is always drawn.
    expect(focused.border !== resting.border || focused.shadow !== resting.shadow).toBe(true);
    expect(focused.shadow).not.toBe('none');
  });
});

test.describe('the comment round trip (attn-64iy.1 / .2)', () => {
  test('a share publishes a snapshot for every shared file', async ({ page }) => {
    await openWorkspace(page);
    await share(page);

    // THE ROOT CAUSE. With no snapshot, `ownerFileIdForPath` could never
    // resolve the open document to a FileId, so `currentFileId` stayed null and
    // every composer entry point bailed. "I highlight text but nothing appears."
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const store = (window as unknown as {
            __attn_review_store__?: { snapshots: Array<Record<string, unknown>> };
          }).__attn_review_store__;
          return store?.snapshots.length ?? 0;
        }),
      )
      .toBeGreaterThan(0);

    const snapshot = await page.evaluate(() => {
      const store = (window as unknown as {
        __attn_review_store__?: {
          snapshots: Array<{
            content?: string;
            anchorIndex?: unknown;
            ownerDisplayPath?: string;
            baseHash?: string;
          }>;
          currentFileId: string | null;
        };
      }).__attn_review_store__;
      const s = store?.snapshots[0];
      return {
        hasContent: typeof s?.content === 'string' && s.content.length > 0,
        hasAnchors: Boolean(s?.anchorIndex),
        hasPath: Boolean(s?.ownerDisplayPath),
        hasHash: Boolean(s?.baseHash),
        currentFileId: store?.currentFileId ?? null,
      };
    });
    // A snapshot with invented content or a hand-rolled index produces anchors
    // that resolve nowhere, so these are load-bearing, not incidental.
    expect(snapshot.hasContent).toBe(true);
    expect(snapshot.hasAnchors).toBe(true);
    expect(snapshot.hasPath).toBe(true);
    expect(snapshot.hasHash).toBe(true);
    // The whole point: the open document now HAS a file identity.
    expect(snapshot.currentFileId).not.toBeNull();
  });

  test('highlighting text offers a live Comment action, and it round-trips to a card', async ({
    page,
  }) => {
    await openWorkspace(page);
    await share(page);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as { __attn_review_store__?: { currentFileId: string | null } })
              .__attn_review_store__?.currentFileId ?? null,
        ),
      )
      .not.toBeNull();

    // Select a paragraph the way a person does.
    const paragraph = page.locator('.ProseMirror p').first();
    await paragraph.waitFor();
    await paragraph.click({ clickCount: 3 });

    const toolbar = page.locator('[data-slot=selection-toolbar]');
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveAttribute('data-comment-state', 'ready');

    const commentButton = page.locator('[data-slot=selection-toolbar-comment]');
    await expect(commentButton).toBeEnabled();
    await commentButton.click();

    const composer = page.locator('.comment-composer');
    await expect(composer).toBeVisible();
    await composer.locator('textarea').fill('Does this paragraph still hold?');
    await composer.getByRole('button', { name: /comment|submit|save/iu }).first().click();

    // The card is the payoff: the event came back, resolved against a real
    // anchor index, and found a position to render at.
    await expect(page.locator('[data-testid=review-margin-card]').first()).toBeVisible();
  });

  test('an unavailable Comment action explains itself instead of vanishing', async ({ page }) => {
    await openWorkspace(page);

    // Reproduce the ORIGINAL broken state exactly: a room exists, but no
    // snapshot ever arrives for it. That is precisely where the browser dev
    // loop sat before attn-64iy.1, and where the desktop build still sits for
    // the moment between minting a room and its first snapshot landing.
    //
    // Dropped at the bridge rather than by poking the store: App re-derives
    // `currentFileId` from the snapshot list on every activePath change, so a
    // forced store value is overwritten before the assertion can read it.
    await page.evaluate(() => {
      const bridge = (window as unknown as {
        __attn__?: { reviewSnapshot(payload: unknown): void };
      }).__attn__;
      if (!bridge) throw new Error('no window.__attn__ — the app bridge is missing');
      bridge.reviewSnapshot = () => {};
    });
    await share(page);

    const paragraph = page.locator('.ProseMirror p').first();
    await paragraph.waitFor();
    await paragraph.click({ clickCount: 3 });

    const toolbar = page.locator('[data-slot=selection-toolbar]');
    await expect(toolbar).toBeVisible();
    await expect(toolbar).not.toHaveAttribute('data-comment-state', 'ready');

    // Disabled, not enabled-and-inert; and the reason is visible TEXT, not a
    // tooltip a touch user could never reach.
    await expect(page.locator('[data-slot=selection-toolbar-comment]')).toBeDisabled();
    const reason = page.locator('[data-slot=selection-toolbar-reason]');
    await expect(reason).toBeVisible();
    await expect(reason).not.toBeEmpty();
  });
});
