import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Real-browser tests for the injected HTML annotation runtime (attn-61t).
 *
 * This code cannot be tested without a browser engine: it depends on live
 * `Range` geometry, `getClientRects`, `document.getSelection`, the CSS Custom
 * Highlight API, and — most of all — on `postMessage` and `MessageChannel`
 * behaving the way they do across a real *opaque-origin* sandboxed iframe,
 * which is the whole premise of the design (html-annotation.md §1).
 *
 * The page below plays the shell: it builds a `srcdoc` iframe with the runtime
 * injected, performs the `hello` → `MessageChannel` handshake, and records
 * whatever the frame reports. Assertions then run against those records.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = (() => {
  const generated = readFileSync(
    resolve(here, '../src/lib/review/doc-runtime.generated.ts'),
    'utf8',
  );
  // The artifact is `export const DOC_RUNTIME_SOURCE = "<json string>";`
  const match = generated.match(/DOC_RUNTIME_SOURCE = ("(?:[^"\\]|\\.)*");/s);
  if (!match) throw new Error('could not read the generated runtime artifact');
  return JSON.parse(match[1]) as string;
})();

const DOC = `<!doctype html>
<html><body>
  <h1 id="title">Quarterly report</h1>
  <p class="intro">The quick brown fox jumps over the lazy dog.</p>
  <p>A second paragraph mentioning the lazy dog again.</p>
  <table class="results">
    <thead><tr><th>Method</th><th>Confidence</th></tr></thead>
    <tbody>
      <tr><td>Exact quote</td><td>1.00</td></tr>
      <tr><td>Fuzzy quote</td><td>0.50-0.75</td></tr>
    </tbody>
  </table>
  <p class="links">See <a id="jump" href="#appendix">the appendix</a> for detail.</p>
  <button id="ping" onclick="window.__ping = (window.__ping || 0) + 1">Recalculate</button>
  <div class="callout"><span id="bare">Wrapped in markup with no scope tag of its own.</span></div>
</body></html>`;

/**
 * Shell-side harness installed into the top-level page. Mirrors
 * HtmlAnnotationBridge closely enough to exercise the same protocol, without
 * pulling the app's module graph into the test.
 */
const HARNESS = `
window.__attn_events = [];
window.__attn_ready = false;
window.__attn_port = null;

window.__attn_boot = (docHtml, runtimeSource) => {
  const frame = document.createElement('iframe');
  frame.id = 'doc';
  // Opaque origin: allow-scripts WITHOUT allow-same-origin, exactly as
  // HtmlViewer renders it.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.cssText = 'width:800px;height:600px;border:0';
  frame.srcdoc = docHtml + '<script>' + runtimeSource + '<\\/script>';
  document.body.appendChild(frame);

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    if (!event.data || event.data.type !== 'attn:doc:hello') return;
    const channel = new MessageChannel();
    window.__attn_port = channel.port1;
    channel.port1.onmessage = (e) => {
      window.__attn_events.push(e.data);
      if (e.data && e.data.type === 'ready') window.__attn_ready = true;
    };
    channel.port1.start();
    frame.contentWindow.postMessage({ type: 'attn:shell:init', v: 1 }, '*', [channel.port2]);
  });
};

window.__attn_send = (message) => window.__attn_port?.postMessage(message);
window.__attn_last = (type) => {
  const matching = window.__attn_events.filter((e) => e && e.type === type);
  return matching[matching.length - 1] ?? null;
};
window.__attn_clear = () => { window.__attn_events.length = 0; };
`;

async function boot(page: import('@playwright/test').Page, doc = DOC) {
  await page.goto('about:blank');
  await page.addScriptTag({ content: HARNESS });
  await page.evaluate(
    ([docHtml, runtime]) => {
      (window as unknown as { __attn_boot: (a: string, b: string) => void }).__attn_boot(
        docHtml,
        runtime,
      );
    },
    [doc, RUNTIME] as const,
  );
  await page.waitForFunction(() => (window as unknown as { __attn_ready: boolean }).__attn_ready, {
    timeout: 15_000,
  });
}

/**
 * Turn on inspect mode, as the shell does once a document is genuinely under
 * review. Hover chrome and element clicks are both gated on it: a document that
 * cannot take a comment is left strictly alone.
 */
async function inspect(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    (window as unknown as { __attn_send: (m: unknown) => void }).__attn_send({
      type: 'inspect',
      v: 1,
      enabled: true,
    });
  });
}

/** Select a text run inside the frame by its exact string. */
async function selectText(page: import('@playwright/test').Page, needle: string) {
  const frame = page.frameLocator('#doc');
  await frame.locator('body').evaluate((body, text) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const at = (node.nodeValue ?? '').indexOf(text);
      if (at !== -1) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
      node = walker.nextNode();
    }
    throw new Error(`text not found in document: ${text}`);
  }, needle);
}

test.describe('HTML annotation runtime', () => {
  test('completes the handshake across an opaque-origin frame', async ({ page }) => {
    await boot(page);
    const ready = await page.evaluate(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('ready'),
    );
    expect(ready).toMatchObject({ type: 'ready', v: 1, title: '' });
    expect((ready as { textLength: number }).textLength).toBeGreaterThan(50);
  });

  test('proposes a text anchor carrying every selector layer', async ({ page }) => {
    await boot(page);
    await selectText(page, 'quick brown fox');

    const selection = await page.waitForFunction(
      () => (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('selection'),
      { timeout: 10_000 },
    );
    const payload = (await selection.jsonValue()) as {
      proposal: {
        quote: string;
        prefix: string;
        suffix: string;
        html: {
          target: string;
          cssSelector: string;
          fallbackSelectors?: string[];
          textPosition?: { start: number; end: number };
          context: { tagName: string; scopePreview: string; domPath?: string[] };
        };
      };
      rects: { width: number; height: number }[];
    };

    expect(payload.proposal.quote).toBe('quick brown fox');
    expect(payload.proposal.html.target).toBe('text_range');
    // The selection sits inside <p class="intro">, so the anchoring element is
    // that paragraph — not the body and not a text node.
    expect(payload.proposal.html.cssSelector).toContain('p');
    expect(payload.proposal.html.context.tagName).toBe('p');
    expect(payload.proposal.html.textPosition!.end).toBeGreaterThan(
      payload.proposal.html.textPosition!.start,
    );
    // Context is what disambiguates a repeated quote later.
    expect(payload.proposal.prefix).toContain('The ');
    expect(payload.proposal.suffix).toContain('jumps');
    // Geometry must be real, or the rail has nothing to align to.
    expect(payload.rects.length).toBeGreaterThan(0);
    expect(payload.rects[0].width).toBeGreaterThan(0);
  });

  test('resolves an unchanged anchor as exact', async ({ page }) => {
    await boot(page);
    await selectText(page, 'quick brown fox');
    const selection = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('selection'),
    );
    const proposal = (await selection.jsonValue()) as { proposal: { html: unknown; quote: string } };

    await page.evaluate((p) => {
      const w = window as unknown as {
        __attn_clear: () => void;
        __attn_send: (m: unknown) => void;
      };
      w.__attn_clear();
      w.__attn_send({
        type: 'renderAnchors',
        v: 1,
        anchors: [{ anchorId: 'a1', html: p.proposal.html, state: 'default', quote: p.proposal.quote }],
      });
    }, proposal);

    const resolved = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('anchorsResolved'),
    );
    const results = (await resolved.jsonValue()) as {
      results: { anchorId: string; status: string; rects: unknown[] }[];
    };
    expect(results.results).toHaveLength(1);
    expect(results.results[0]).toMatchObject({ anchorId: 'a1', status: 'exact' });
    expect(results.results[0].rects.length).toBeGreaterThan(0);
  });

  /**
   * The point of writing every selector layer at creation time: when the
   * document shifts, the quote still finds the text even though the recorded
   * offsets no longer hold.
   */
  test('re-anchors by quote after the document shifts', async ({ page }) => {
    await boot(page);
    await selectText(page, 'quick brown fox');
    const selection = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('selection'),
    );
    const proposal = (await selection.jsonValue()) as { proposal: { html: unknown; quote: string } };

    // Insert a paragraph above the anchored text, invalidating its offsets.
    await page
      .frameLocator('#doc')
      .locator('body')
      .evaluate((body) => {
        const inserted = document.createElement('p');
        inserted.textContent = 'An inserted paragraph that shifts every later offset.';
        body.insertBefore(inserted, body.querySelector('p.intro'));
      });

    await page.evaluate((p) => {
      const w = window as unknown as {
        __attn_clear: () => void;
        __attn_send: (m: unknown) => void;
      };
      w.__attn_clear();
      w.__attn_send({
        type: 'renderAnchors',
        v: 1,
        anchors: [{ anchorId: 'a1', html: p.proposal.html, state: 'default', quote: p.proposal.quote }],
      });
    }, proposal);

    const resolved = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('anchorsResolved'),
    );
    const results = (await resolved.jsonValue()) as {
      results: { status: string; rects: { width: number }[] }[];
    };
    // Not stale, and not falsely exact — the text moved and was found again.
    expect(['exact', 'remapped']).toContain(results.results[0].status);
    expect(results.results[0].rects.length).toBeGreaterThan(0);
  });

  test('reports stale when the anchored content is gone', async ({ page }) => {
    await boot(page);
    await selectText(page, 'quick brown fox');
    const selection = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('selection'),
    );
    const proposal = (await selection.jsonValue()) as { proposal: { html: unknown; quote: string } };

    await page
      .frameLocator('#doc')
      .locator('body')
      .evaluate((body) => {
        body.innerHTML = '<section><em>Entirely different content.</em></section>';
      });

    await page.evaluate((p) => {
      const w = window as unknown as {
        __attn_clear: () => void;
        __attn_send: (m: unknown) => void;
      };
      w.__attn_clear();
      w.__attn_send({
        type: 'renderAnchors',
        v: 1,
        anchors: [{ anchorId: 'a1', html: p.proposal.html, state: 'default', quote: p.proposal.quote }],
      });
    }, proposal);

    const resolved = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('anchorsResolved'),
    );
    const results = (await resolved.jsonValue()) as { results: { status: string }[] };
    expect(results.results[0].status).toBe('stale');
  });

  test('offers a cell/row/table scope chain when hovering a table', async ({ page }) => {
    await boot(page);
    await inspect(page);
    await page.frameLocator('#doc').locator('td', { hasText: 'Fuzzy quote' }).hover();

    const hover = await page.waitForFunction(
      () => (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopeHover'),
      { timeout: 10_000 },
    );
    const payload = (await hover.jsonValue()) as {
      chain: { title: string; preview: string | null; selector: string; commentCount: number }[];
    };

    // Innermost first: the cell, its row, then the table.
    const titles = payload.chain.map((c) => c.title);
    expect(titles[0]).toBe('cell');
    expect(titles).toContain('row 2');
    expect(titles).toContain('table');
    // Each scope carries a human preview so the breadcrumb reads meaningfully.
    const row = payload.chain.find((c) => c.title === 'row 2');
    expect(row!.preview).toContain('Fuzzy quote');
    expect(row!.selector).toContain('tr');
  });

  test('paints an element anchor with a persistent, non-blocking overlay', async ({ page }) => {
    await boot(page);
    await inspect(page);
    await page.frameLocator('#doc').locator('td', { hasText: 'Fuzzy quote' }).hover();
    const hover = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopeHover'),
    );
    const chain = (await hover.jsonValue()) as { chain: { scopeId: string; title: string }[] };
    const row = chain.chain.find((c) => c.title === 'row 2')!;

    await page.evaluate((scopeId) => {
      const w = window as unknown as { __attn_send: (m: unknown) => void };
      w.__attn_send({ type: 'pickScope', v: 1, scopeId });
    }, row.scopeId);

    const picked = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
    );
    const payload = (await picked.jsonValue()) as {
      proposal: { html: { target: string; context: { tagName: string; scopePreview: string } } };
    };
    expect(payload.proposal.html.target).toBe('element');
    expect(payload.proposal.html.context.tagName).toBe('tr');
    expect(payload.proposal.html.context.scopePreview).toContain('Fuzzy quote');

    await page.evaluate((p) => {
      const w = window as unknown as { __attn_send: (m: unknown) => void };
      w.__attn_send({
        type: 'renderAnchors',
        v: 1,
        anchors: [{ anchorId: 'row-anchor', html: p.proposal.html, state: 'default', label: '2' }],
      });
    }, payload);

    const frame = page.frameLocator('#doc');
    await expect(frame.locator('.attn-overlay')).toHaveCount(1);
    // The pin is persistent — visible without hovering — so the document reads
    // as annotated at a glance.
    await expect(frame.locator('.attn-pin')).toHaveText('2');

    // The overlay fill must never trap the cursor: text underneath a commented
    // element has to stay selectable so you can comment inside it.
    const pointerEvents = await frame
      .locator('.attn-overlay')
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pointerEvents).toBe('none');
  });

  /**
   * ELEMENT INSPECTION (attn-yqun).
   *
   * The tests above drive the protocol; these drive the *interaction* — real
   * mouse movement over a real opaque-origin frame. That distinction is the
   * whole reason this group exists. Every earlier surface (the shell-side
   * daemon script included) could only observe iframe attributes from outside,
   * so the in-frame hover/click layer shipped with no coverage at all, and both
   * bugs the first human smoke test found lived exactly there.
   */
  test('outlines the element under the cursor and names it on a chip', async ({ page }) => {
    await boot(page);
    await inspect(page);
    const frame = page.frameLocator('#doc');
    await frame.locator('p.intro').hover();

    await expect(frame.locator('.attn-outline')).toBeVisible();
    const chip = frame.locator('.attn-chip');
    await expect(chip).toBeVisible();
    // Names the thing under the cursor, and shows enough of its content to
    // confirm you are pointing at what you think you are.
    await expect(chip.locator('.attn-chip-seg.is-current')).toContainText('p');
    await expect(chip).toContainText('The quick brown fox');
  });

  /**
   * THE REGRESSION THAT REACHED THE USER. The runtime's chrome lives inside the
   * document it annotates, so a cursor moving onto the chip is a mousemove that
   * resolves to no document scope. Treating that as "hovering nothing" hid the
   * affordance out from under the hand reaching for it — a control that cannot
   * be clicked at all, and one no attribute-level assertion could ever see.
   */
  test('keeps the chip alive when the cursor reaches for it', async ({ page }) => {
    await boot(page);
    await inspect(page);
    const frame = page.frameLocator('#doc');
    const paragraph = frame.locator('p.intro');
    await paragraph.hover();
    const chip = frame.locator('.attn-chip');
    await expect(chip).toBeVisible();

    const from = (await paragraph.boundingBox())!;
    const to = (await chip.locator('.attn-chip-seg.is-current').boundingBox())!;
    // Travel the way a hand does — continuously, from inside the element up to
    // the label — rather than teleporting onto the target.
    await page.mouse.move(from.x + 12, from.y + from.height / 2);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
    await page.waitForTimeout(300);

    await expect(chip).toBeVisible();
    await chip.locator('.attn-chip-seg.is-current').click();
    const picked = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
    );
    expect((await picked.jsonValue()) as { explicit: boolean }).toMatchObject({ explicit: true });
  });

  /**
   * Leaving the chip arms the hide timer. Coming straight back to the element
   * the chip was already naming has to disarm it — otherwise a cursor that
   * merely clipped the label on its way past times the chip out while sitting
   * perfectly still on the thing it wants to comment on.
   */
  test('survives a round trip out to the chip and back', async ({ page }) => {
    await boot(page);
    await inspect(page);
    const frame = page.frameLocator('#doc');
    const paragraph = frame.locator('p.intro');
    await paragraph.hover();
    const chip = frame.locator('.attn-chip');
    await expect(chip).toBeVisible();

    const chipBox = (await chip.locator('.attn-chip-seg.is-current').boundingBox())!;
    const from = (await paragraph.boundingBox())!;
    await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2, {
      steps: 8,
    });
    await page.mouse.move(from.x + 12, from.y + from.height / 2, { steps: 8 });
    // Comfortably past HOVER_GRACE_MS.
    await page.waitForTimeout(500);

    await expect(chip).toBeVisible();
  });

  /**
   * The chip's reach corridor sits ON TOP of the document, so a click there can
   * never fall through to the page. If it also did not comment, the strip was
   * dead in both directions — a deliberate press that does nothing at all,
   * which is the exact class of failure this epic exists to remove.
   */
  test('commits from the chip padding, not just its segments', async ({ page }) => {
    await boot(page);
    await inspect(page);
    const frame = page.frameLocator('#doc');
    await frame.locator('p.intro').hover();
    const chip = frame.locator('.attn-chip');
    await expect(chip).toBeVisible();

    const box = (await chip.boundingBox())!;
    // The bottom-most strip of the chip's box is its transparent padding — no
    // segment lives there.
    await page.mouse.click(box.x + box.width - 2, box.y + box.height - 2);

    const picked = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
    );
    expect((await picked.jsonValue()) as { explicit: boolean }).toMatchObject({ explicit: true });
  });

  test('drills to an ancestor scope from the breadcrumb', async ({ page }) => {
    await boot(page);
    await inspect(page);
    const frame = page.frameLocator('#doc');
    await frame.locator('td', { hasText: 'Fuzzy quote' }).hover();

    const chip = frame.locator('.attn-chip');
    // Outermost first, so the label reads the way a path does.
    await expect(chip.locator('.attn-chip-seg')).toHaveText([/table/, /row 2/, /cell/]);
    await chip.locator('.attn-chip-seg', { hasText: 'row 2' }).click();

    const picked = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
    );
    const payload = (await picked.jsonValue()) as {
      explicit: boolean;
      proposal: { html: { target: string; context: { tagName: string; scopePreview: string } } };
    };
    expect(payload.explicit).toBe(true);
    expect(payload.proposal.html.target).toBe('element');
    expect(payload.proposal.html.context.tagName).toBe('tr');
    expect(payload.proposal.html.context.scopePreview).toContain('Fuzzy quote');
  });

  test('offers unscoped markup as a scope of its own', async ({ page }) => {
    await boot(page);
    await inspect(page);
    const frame = page.frameLocator('#doc');
    await frame.locator('#bare').hover();
    await expect(frame.locator('.attn-chip')).toBeVisible();
    await frame.locator('.attn-chip-seg.is-current').click();

    const picked = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
    );
    // No part of a document may be un-commentable just because its author
    // reached for a tag the scope list never anticipated.
    const payload = (await picked.jsonValue()) as {
      proposal: { html: { context: { tagName: string } } };
    };
    expect(payload.proposal.html.context.tagName).toBe('span');
  });

  /** How many times the document's OWN click handler ran, and where it is. */
  function pageState(page: import('@playwright/test').Page) {
    return page
      .frameLocator('#doc')
      .locator('body')
      .evaluate(() => ({
        clicks: (window as unknown as { __ping?: number }).__ping ?? 0,
        hash: location.hash,
      }));
  }

  test('takes the click in inspect mode so the page cannot act on it', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      (window as unknown as { __attn_send: (m: unknown) => void }).__attn_send({
        type: 'inspect',
        v: 1,
        enabled: true,
      });
    });

    await page.frameLocator('#doc').locator('#ping').click();
    const picked = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
    );
    const payload = (await picked.jsonValue()) as {
      explicit: boolean;
      proposal: { html: { context: { tagName: string } } };
    };
    expect(payload).toMatchObject({ explicit: true });
    expect(payload.proposal.html.context.tagName).toBe('button');

    // Commenting on a control is not operating it, and commenting on a link is
    // not following it — the frame must still be showing the same document.
    await page.frameLocator('#doc').locator('#jump').click();
    expect(await pageState(page)).toEqual({ clicks: 0, hash: '' });
  });

  test('leaves a document that cannot take a comment strictly alone', async ({ page }) => {
    await boot(page);
    const frame = page.frameLocator('#doc');

    await frame.locator('p.intro').hover();
    await page.waitForTimeout(200);
    // No chrome at all until the shell says the document is under review. The
    // chip is opaque and painted OVER the page, so raising one here would
    // occlude — and eat clicks on — a document that is only being read, to
    // offer an affordance that could answer nothing but "share this first".
    await expect(frame.locator('.attn-chip')).toBeHidden();
    await expect(frame.locator('.attn-outline')).toHaveCount(0);

    await frame.locator('#ping').click();
    await page.waitForTimeout(200);
    expect(await pageState(page)).toMatchObject({ clicks: 1 });
    expect(
      await page.evaluate(() =>
        (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
      ),
    ).toBeNull();
  });

  /**
   * Reviewability can be taken away while the chrome is on screen — the room is
   * stopped or revoked, or its snapshot goes away. Refusing to raise NEW chrome
   * is not enough: the chip handles its own clicks, so one left mounted goes on
   * eating the page's clicks and proposing comments on a document that is no
   * longer under review.
   */
  test('takes down chrome already on screen when inspection is revoked', async ({ page }) => {
    await boot(page);
    await inspect(page);
    const frame = page.frameLocator('#doc');

    await frame.locator('p.intro').hover();
    await expect(frame.locator('.attn-chip')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __attn_send: (m: unknown) => void }).__attn_send({
        type: 'inspect',
        v: 1,
        enabled: false,
      });
      (window as unknown as { __attn_clear: () => void }).__attn_clear();
    });

    await expect(frame.locator('.attn-chip')).toBeHidden();
    await expect(frame.locator('.attn-outline')).toHaveCount(0);

    // And the document has its own clicks back.
    await frame.locator('#ping').click();
    await page.waitForTimeout(200);
    expect(await pageState(page)).toMatchObject({ clicks: 1 });
    expect(
      await page.evaluate(() =>
        (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
      ),
    ).toBeNull();
  });

  /**
   * The reachable version of "a click committed to something the chip never
   * named": drag-select a sentence to read it, then click elsewhere to dismiss
   * the selection. Chrome is suppressed for the whole gesture, but by click
   * time mousedown has already collapsed the selection — so a guard that only
   * asks "is a selection live?" sees nothing and swallows the click.
   */
  test('does not commit a click that dismisses a selection', async ({ page }) => {
    await boot(page);
    await inspect(page);
    await selectText(page, 'quick brown fox');
    await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('selection'),
    );
    await expect(page.frameLocator('#doc').locator('.attn-chip')).toBeHidden();

    await page.frameLocator('#doc').locator('#ping').click();
    await page.waitForTimeout(250);

    // Nothing was outlined or named, so nothing may be taken: the click is the
    // page's, and no composer opens behind it.
    expect(await pageState(page)).toMatchObject({ clicks: 1 });
    expect(
      await page.evaluate(() =>
        (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('scopePicked'),
      ),
    ).toBeNull();
  });

  /**
   * Pins hang outside the elements they belong to and the pill floats under a
   * selection — neither is the chip, and neither may hold it open. Resting on
   * one used to cancel a pending hide that nothing ever re-armed.
   */
  test('does not let a comment pin hold a stale chip open', async ({ page }) => {
    await boot(page);
    await inspect(page);
    const frame = page.frameLocator('#doc');
    await page.evaluate(() => {
      (window as unknown as { __attn_send: (m: unknown) => void }).__attn_send({
        type: 'renderAnchors',
        v: 1,
        anchors: [
          {
            anchorId: 'pinned',
            html: {
              v: 1,
              target: 'element',
              cssSelector: '#title',
              context: { tagName: 'h1', scopePreview: 'Quarterly report' },
            },
            state: 'default',
            label: '1',
          },
        ],
      });
    });
    await expect(frame.locator('.attn-pin')).toHaveCount(1);

    await frame.locator('p.intro').hover();
    await expect(frame.locator('.attn-chip')).toBeVisible();
    // Leave the paragraph, then come to rest on the pin belonging to another
    // element entirely.
    const pin = (await frame.locator('.attn-pin').boundingBox())!;
    await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2, { steps: 10 });
    await page.waitForTimeout(500);

    await expect(frame.locator('.attn-chip')).toBeHidden();
  });

  test('marks a dragged selection passive and a pressed pill explicit', async ({ page }) => {
    await boot(page);
    await selectText(page, 'quick brown fox');
    await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('selection'),
    );
    // Merely having text selected is not a request to comment on it; a shell
    // that opened a composer here would ambush every ordinary drag.
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __attn_last: (t: string) => { explicit: boolean } }).__attn_last(
            'selection',
          ).explicit,
      ),
    ).toBe(false);

    await page.frameLocator('#doc').locator('.attn-pill').click();
    const explicit = await page.waitForFunction(
      () =>
        (window as unknown as { __attn_last: (t: string) => { explicit: boolean } }).__attn_last(
          'selection',
        ).explicit === true,
    );
    expect(await explicit.jsonValue()).toBe(true);
  });

  test('ignores malformed and unknown shell messages', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const w = window as unknown as { __attn_send: (m: unknown) => void };
      w.__attn_send({ type: 'renderAnchors' }); // no version
      w.__attn_send({ type: 'renderAnchors', v: 99, anchors: [] }); // wrong version
      w.__attn_send({ type: 'somethingNew', v: 1 }); // unknown type
      w.__attn_send(null);
      w.__attn_send('renderAnchors');
    });
    // Still alive and still answering after the junk.
    await page.evaluate(() => {
      const w = window as unknown as { __attn_send: (m: unknown) => void };
      w.__attn_send({ type: 'renderAnchors', v: 1, anchors: [] });
    });
    const resolved = await page.waitForFunction(() =>
      (window as unknown as { __attn_last: (t: string) => unknown }).__attn_last('anchorsResolved'),
    );
    expect((await resolved.jsonValue()) as { results: unknown[] }).toMatchObject({ results: [] });
  });
});

/**
 * The suite above drives the protocol with an inline harness, which proves the
 * document side but says nothing about the code the app ships. These run
 * against the real `HtmlAnnotationBridge` and `injectDocRuntime`.
 */
test.describe('HtmlAnnotationBridge (shell side)', () => {
  let harnessBundle: string;

  test.beforeAll(async () => {
    const result = await build({
      entryPoints: [resolve(here, 'fixtures/bridge-harness.ts')],
      bundle: true,
      format: 'iife',
      target: 'es2022',
      platform: 'browser',
      write: false,
    });
    harnessBundle = result.outputFiles[0].text;
  });

  async function bootBridge(page: import('@playwright/test').Page, doc = DOC) {
    await page.goto('about:blank');
    await page.addScriptTag({ content: harnessBundle });
    await page.evaluate((docHtml) => {
      (window as unknown as { __boot: (d: string) => void }).__boot(docHtml);
    }, doc);
    await page.waitForFunction(() => (window as unknown as { __ready: boolean }).__ready, {
      timeout: 15_000,
    });
  }

  test('handshakes with a real frame using the shipped injector', async ({ page }) => {
    await bootBridge(page);
    expect(await page.evaluate(() => (window as unknown as { __ready: boolean }).__ready)).toBe(
      true,
    );
  });

  test('converts frame rects into shell coordinates', async ({ page }) => {
    await bootBridge(page);
    // Offset the frame so the two coordinate spaces cannot coincide by accident.
    await page.evaluate(() => {
      const frame = document.getElementById('doc') as HTMLIFrameElement;
      frame.style.position = 'absolute';
      frame.style.top = '150px';
      frame.style.left = '75px';
    });

    await selectText(page, 'quick brown fox');
    const proposal = await page.waitForFunction(() => {
      const list = (window as unknown as { __proposals: unknown[] }).__proposals;
      return list.length > 0 ? list[list.length - 1] : null;
    });
    const payload = (await proposal.jsonValue()) as { html: unknown; quote: string };

    await page.evaluate((p) => {
      (window as unknown as { __render: (a: unknown[]) => void }).__render([
        { anchorId: 'a1', html: p.html, state: 'default', quote: p.quote },
      ]);
    }, payload);

    const geometry = await page.waitForFunction(() => {
      const g = (window as unknown as { __geometry: unknown[] }).__geometry;
      return g.length > 0 ? g : null;
    });
    const results = (await geometry.jsonValue()) as { anchorId: string; rects: { y: number }[] }[];
    expect(results[0].anchorId).toBe('a1');
    // The frame sits 150px down the page, so a shell-space top must clear it.
    expect(results[0].rects[0].y).toBeGreaterThan(150);
  });

  /**
   * The channel is bound on `event.source`, because an opaque frame's origin is
   * the useless string "null". A forged hello from the page itself — or from
   * any window that is not this frame — must not claim the channel.
   */
  test('ignores a hello that did not come from its own frame', async ({ page }) => {
    await bootBridge(page);
    const before = await page.evaluate(
      () => (window as unknown as { __resolutions: unknown[] }).__resolutions.length,
    );

    await page.evaluate(() => {
      const w = window as unknown as { __rawPost: (p: unknown) => void };
      w.__rawPost({ type: 'attn:doc:hello', v: 1 });
      w.__rawPost({ type: 'attn:doc:hello', v: 99 });
      w.__rawPost({ type: 'attn:shell:init', v: 1 });
    });
    await page.waitForTimeout(200);

    // The real frame's channel still works after the forgeries.
    await page.evaluate(() => {
      (window as unknown as { __render: (a: unknown[]) => void }).__render([]);
    });
    const after = await page.waitForFunction(
      (prev) => {
        const w = window as unknown as { __resolutions: unknown[] };
        return w.__resolutions.length >= prev ? w.__resolutions : null;
      },
      before,
    );
    expect(await after.jsonValue()).toEqual([]);
  });

  /**
   * Anchors queued before the handshake completes must not be dropped — the
   * shell renders threads as soon as it has them, which is routinely earlier
   * than the frame finishes booting.
   */
  test('flushes anchors queued before the port exists', async ({ page }) => {
    await page.goto('about:blank');
    await page.addScriptTag({ content: harnessBundle });
    await page.evaluate((docHtml) => {
      const w = window as unknown as {
        __boot: (d: string) => void;
        __render: (a: unknown[]) => void;
      };
      w.__boot(docHtml);
      // Immediately — before `ready` could possibly have arrived.
      w.__render([
        {
          anchorId: 'early',
          html: {
            v: 1,
            target: 'element',
            cssSelector: '#title',
            context: { tagName: 'h1', scopePreview: 'Quarterly report' },
          },
          state: 'default',
        },
      ]);
    }, DOC);

    const resolutions = await page.waitForFunction(
      () => {
        const list = (window as unknown as { __resolutions: { anchorId: string }[] }).__resolutions;
        return list.length > 0 ? list : null;
      },
      undefined,
      { timeout: 15_000 },
    );
    const results = (await resolutions.jsonValue()) as { anchorId: string; status: string }[];
    expect(results[0]).toMatchObject({ anchorId: 'early', status: 'exact' });
  });

  /**
   * The end-to-end path a person actually walks: point at something, click it,
   * and have the shell receive a proposal it owes an answer to. Driven through
   * the real bridge and the real injector, because the two pieces that carry
   * this — `explicit` and `setInspect` — are exactly what decides whether the
   * shell opens a composer or stays silent.
   */
  test('delivers an element click as an explicit proposal', async ({ page }) => {
    await bootBridge(page);
    await page.evaluate(() => {
      (window as unknown as { __inspect: (e: boolean) => void }).__inspect(true);
    });

    await page.frameLocator('#doc').locator('td', { hasText: 'Fuzzy quote' }).click();

    const proposal = await page.waitForFunction(() => {
      const list = (window as unknown as { __explicit: unknown[] }).__explicit;
      return list.length > 0 ? list[list.length - 1] : null;
    });
    expect((await proposal.jsonValue()) as { html: { context: { tagName: string } } }).toMatchObject(
      { html: { target: 'element', context: { tagName: 'td' } } },
    );
  });

  /**
   * THE BUG THAT MADE EVERY PIN VANISH. Anchors are built from the review
   * store, and Svelte 5 hands out a Proxy for every object it tracks —
   * structured clone, which `postMessage` uses, throws `DataCloneError` on one.
   * The throw surfaced nowhere near the cause: the frame simply never received
   * the anchor set, so no pin was painted, no resolution came back, and the
   * rail had no geometry to align to. Every previous test here passed plain
   * literals, which is exactly why none of them caught it.
   */
  test('renders anchors that arrive as reactive proxies', async ({ page }) => {
    await bootBridge(page);
    await page.evaluate(() => {
      (window as unknown as { __renderProxied: (a: unknown[]) => void }).__renderProxied([
        {
          anchorId: 'proxied',
          html: {
            v: 1,
            target: 'element',
            cssSelector: '#title',
            context: { tagName: 'h1', scopePreview: 'Quarterly report' },
          },
          state: 'default',
          label: '1',
        },
      ]);
    });

    const resolutions = await page.waitForFunction(() => {
      const list = (window as unknown as { __resolutions: { anchorId: string }[] }).__resolutions;
      return list.length > 0 ? list : null;
    });
    expect((await resolutions.jsonValue()) as { anchorId: string; status: string }[]).toMatchObject([
      { anchorId: 'proxied', status: 'exact' },
    ]);
    // The pin is the whole point: a document has to read as annotated.
    await expect(page.frameLocator('#doc').locator('.attn-pin')).toHaveText('1');
  });

  test('replays the full anchor state after an in-place frame reload', async ({ page }) => {
    await bootBridge(page);
    await page.evaluate(() => {
      (window as unknown as { __render: (a: unknown[]) => void }).__render([
        {
          anchorId: 'reload-pin',
          html: {
            v: 1,
            target: 'element',
            cssSelector: '#title',
            context: { tagName: 'h1', scopePreview: 'Quarterly report' },
          },
          state: 'default',
        },
      ]);
    });
    await page.waitForFunction(() =>
      (window as unknown as { __resolutions: { anchorId: string }[] }).__resolutions
        .some((result) => result.anchorId === 'reload-pin'),
    );

    await page.evaluate(() => {
      const target = window as unknown as { __resolutions: unknown[] };
      target.__resolutions = [];
      const frame = document.getElementById('doc') as HTMLIFrameElement;
      frame.srcdoc = frame.srcdoc;
    });

    await page.waitForFunction(() =>
      (window as unknown as { __resolutions: { anchorId: string }[] }).__resolutions
        .some((result) => result.anchorId === 'reload-pin'),
      undefined,
      { timeout: 15_000 },
    );
  });
});
