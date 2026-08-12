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
