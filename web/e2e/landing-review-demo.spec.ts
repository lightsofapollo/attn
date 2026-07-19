import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function selectDemoText(page: Page, text: string): Promise<void> {
  await page.evaluate((targetText) => {
    const target = window as unknown as {
      __attnLandingReviewDemoView?: {
        state: {
          doc: {
            descendants: (callback: (node: { isText: boolean; text?: string }, position: number) => void) => void;
          };
          tr: { setSelection: (selection: unknown) => unknown };
        };
        dispatch: (transaction: unknown) => void;
      };
    };
    const view = target.__attnLandingReviewDemoView;
    if (!view) throw new Error('landing review demo editor is unavailable');
    let range: [number, number] | null = null;
    view.state.doc.descendants((node, position) => {
      if (!node.isText || range) return;
      const index = node.text?.indexOf(targetText) ?? -1;
      if (index >= 0) range = [position + index, position + index + targetText.length];
    });
    if (!range) throw new Error(`could not find demo text: ${targetText}`);
    const Selection = (window as unknown as { __attnTextSelection?: { create: (...args: unknown[]) => unknown } })
      .__attnTextSelection;
    if (!Selection) throw new Error('TextSelection test bridge is unavailable');
    view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, range[0], range[1])));
    document.dispatchEvent(new Event('selectionchange'));
  }, text);
}

test('landing demo shows agent feedback and lets the visitor join the review', async ({ page }) => {
  await page.goto('/app?surface=landing-review-demo');
  await expect(page.locator('body')).toHaveAttribute('data-surface', 'landing-review-demo');
  await expect(page.locator('.ProseMirror')).toContainText('Launch direction');

  const cards = page.getByTestId('review-margin-card');
  await expect(cards).toHaveCount(3);
  await expect(page.getByLabel(/suggestion by Claude/u)).toBeVisible();
  await expect(page.getByLabel(/comment by Claude/u)).toBeVisible();
  await expect(page.getByLabel(/comment by Codex/u)).toBeVisible();

  await selectDemoText(page, 'The owner decides');
  await page.getByRole('button', { name: 'Comment' }).click();
  await page.getByPlaceholder('Add a comment…').fill('This makes the human decision point unmistakable.');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect(cards).toHaveCount(4);
  await expect(page.getByLabel(/comment by You/u)).toContainText(
    'This makes the human decision point unmistakable.',
  );
  await expect(page.getByText('You joined the review.')).toBeVisible();

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    axe.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')).slice(0, 3),
    })),
  ).toEqual([]);
});

test('alternate homepage embeds the production review surface', async ({ page }) => {
  await page.goto('/homepage-alt');
  await page.locator('#try-review').scrollIntoViewIfNeeded();
  const frame = page.frameLocator('iframe[title^="Interactive attn Markdown review"]');
  await expect(frame.locator('.ProseMirror')).toContainText('Launch direction');
  await expect(frame.getByTestId('review-margin-card')).toHaveCount(3);
});

test('only the landing demo surface permits same-origin framing', async ({ request }) => {
  const demo = await request.get('/app?surface=landing-review-demo');
  expect(demo.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
  expect(demo.headers()['x-frame-options']).toBe('SAMEORIGIN');

  const app = await request.get('/app');
  expect(app.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(app.headers()['x-frame-options']).toBe('DENY');
});

test('landing demo remains contained at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/app?surface=landing-review-demo');
  await expect(page.locator('.ProseMirror')).toBeVisible();
  await expect(page.getByTestId('review-margin-card')).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
