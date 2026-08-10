// The reading palette, measured on screen rather than read off the token file
// (attn-evme.5).
//
// Every value in the attn-evme epic is a contrast claim, and contrast claims are
// exactly the kind that look right in `tokens.css` and fail in the document.
// This suite renders one fixture exercising every prose construct, flips both
// themes, and measures what a reader actually sees.
//
// TWO THINGS MAKE THIS HONEST WHERE A TOKEN-FILE CHECK WOULD NOT BE:
//
//  1. Colours are resolved through a CANVAS, not parsed. The tokens are authored
//     in oklch and `getComputedStyle` hands back oklch strings; hand-rolling an
//     oklch -> sRGB conversion in the test would mean the test and the browser
//     could disagree about the very thing under test. Painting the computed
//     string onto a 1x1 canvas and reading the pixel back asks the browser to do
//     its own conversion, so the number measured is the number rendered.
//
//  2. Backgrounds are RESOLVED UP THE TREE. Prose elements are transparent; the
//     surface behind a table cell is the table's, behind a paragraph is the
//     page's. Measuring text against `rgba(0,0,0,0)` would pass everything.
//
//   cd web && npx playwright test --config playwright.native-share.config.ts reading-palette
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/reading-palette.md',
);

/** WCAG AA for body-size text. */
const AA_TEXT = 4.5;
/** WCAG AA for large text, and the floor for non-text/UI boundaries. */
const AA_LARGE = 3;

type Theme = 'light' | 'dark';

interface Measurement {
  label: string;
  selector: string;
  /** Contrast of the element's text against its effective background. */
  vsBackground: number;
  /** Contrast of the element's text against body prose ink. */
  vsBodyText: number;
  color: string;
  background: string;
  /** Present only for links: whether a rest-state underline is drawn. */
  underlined?: boolean;
}

/**
 * Injected into the page. Everything inside runs in the browser, so it may not
 * close over anything from the Node scope.
 */
function measureInPage(): Measurement[] {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  /** Ask the browser to resolve any colour string to sRGB. */
  const toRgb = (css: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };

  const luminance = ([r, g, b]: [number, number, number, number]): number => {
    const lin = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };

  const contrast = (a: string, b: string): number => {
    const la = luminance(toRgb(a));
    const lb = luminance(toRgb(b));
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  /**
   * The first painted surface behind `el`. Walks ancestors until it finds a
   * background whose alpha is 1; anything translucent en route is composited
   * onto what is behind it, which is what the eye sees.
   */
  const effectiveBackground = (el: Element): string => {
    const layers: Array<[number, number, number, number]> = [];
    let node: Element | null = el;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      const rgba = toRgb(bg);
      if (rgba[3] > 0) {
        layers.push(rgba);
        if (rgba[3] >= 1) break;
      }
      node = node.parentElement;
    }
    if (layers.length === 0) return 'rgb(255, 255, 255)';
    // Composite back-to-front.
    let [r, g, b] = layers[layers.length - 1]!;
    for (let i = layers.length - 2; i >= 0; i -= 1) {
      const [sr, sg, sb, sa] = layers[i]!;
      r = sr * sa + r * (1 - sa);
      g = sg * sa + g * (1 - sa);
      b = sb * sa + b * (1 - sa);
    }
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  };

  const root = document.querySelector('.ProseMirror') ?? document.querySelector('.attn-doc');
  if (!root) throw new Error('no rendered document found');

  const bodyEl = root.querySelector('p');
  if (!bodyEl) throw new Error('no body paragraph found');
  const bodyInk = getComputedStyle(bodyEl).color;

  const targets: Array<{ label: string; selector: string }> = [
    { label: 'body prose', selector: 'p' },
    { label: 'heading h1', selector: 'h1' },
    { label: 'heading h2', selector: 'h2' },
    { label: 'list item', selector: 'li' },
    { label: 'blockquote prose', selector: 'blockquote p' },
    { label: 'link in prose', selector: 'p a' },
    { label: 'table cell', selector: 'td' },
    { label: 'table header eyebrow', selector: 'th' },
    { label: 'inline code in prose', selector: 'p code' },
    { label: 'inline code in cell', selector: 'td code' },
    { label: 'code block text', selector: 'pre code, .code-block code' },
    { label: 'frontmatter card', selector: '.frontmatter-card' },
    // The keys are a SANCTIONED accent exception (One Pencil Rule), which
    // means they are accent-on-code-block — the one pairing where moving the
    // block surface changes a documented contrast claim. They only exist when
    // the card is expanded, which is why `openFixture` expands it.
    { label: 'frontmatter key', selector: '.frontmatter-pairs dt' },
    { label: 'frontmatter value', selector: '.frontmatter-pairs dd' },
  ];


  const out: Measurement[] = [];
  for (const { label, selector } of targets) {
    const el = root.querySelector(selector);
    if (!el) continue;
    const style = getComputedStyle(el);
    const bg = effectiveBackground(el);
    const m: Measurement = {
      label,
      selector,
      color: style.color,
      background: bg,
      vsBackground: contrast(style.color, bg),
      vsBodyText: contrast(style.color, bodyInk),
    };
    if (selector.includes('a')) {
      const decoration = `${style.textDecorationLine} ${style.textDecoration}`;
      m.underlined = decoration.includes('underline');
    }
    out.push(m);
  }

  // The header is chrome, not prose, but it hosts the OTHER sanctioned accent
  // exception (the saved save-state glyph) plus the doc name — and its surface
  // is now its own token (--header-surface, 2026-08-09), so its documented
  // ratios move whenever that token does. Measured from the real header DOM.
  const headerTargets: Array<{ label: string; selector: string }> = [
    { label: 'header doc name', selector: '[data-slot=native-doc-name]' },
    { label: 'header muted icon', selector: '[data-slot=native-header-settings]' },
    { label: 'header saved glyph (accent)', selector: '[data-slot=native-save-chip] svg' },
  ];
  for (const { label, selector } of headerTargets) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = getComputedStyle(el);
    const bg = effectiveBackground(el);
    out.push({
      label,
      selector,
      color: style.color,
      background: bg,
      vsBackground: contrast(style.color, bg),
      vsBodyText: contrast(style.color, bodyInk),
    });
  }

  // Every shiki token family actually rendered in the code block, against the
  // code surface. This is the risk the surface change carries: github-light is
  // tuned for a white ground.
  const codeHost = root.querySelector('pre, .code-block');
  if (codeHost) {
    const bg = effectiveBackground(codeHost);
    const seen = new Set<string>();
    for (const span of Array.from(codeHost.querySelectorAll('span'))) {
      const c = getComputedStyle(span).color;
      if (seen.has(c)) continue;
      seen.add(c);
      const text = (span.textContent ?? '').trim();
      if (text.length === 0) continue;
      out.push({
        label: `syntax token ${JSON.stringify(text.slice(0, 12))}`,
        selector: 'shiki-token',
        color: c,
        background: bg,
        vsBackground: contrast(c, bg),
        vsBodyText: contrast(c, bodyInk),
      });
    }
  }

  return out;
}

async function openFixture(page: Page): Promise<void> {
  await page.goto('/');
  const picker = page.locator('input[type=file]').first();
  await picker.waitFor({ state: 'attached' });
  await picker.setInputFiles(FIXTURE);
  await expect(page.locator('.ProseMirror').first()).toBeVisible();
  // Shiki highlights asynchronously; without this the code block measures as
  // undifferentiated plain text and the syntax sweep silently checks nothing.
  await expect(page.locator('.ProseMirror pre, .ProseMirror .code-block').first()).toBeVisible();
  // The frontmatter card ships collapsed, and its key/value pairs are the one
  // place a documented accent-on-code-block contrast claim lives. Left closed,
  // the sweep would silently skip the pairing most exposed to a surface move.
  const frontmatterToggle = page.locator('.frontmatter-card [role=button], .frontmatter-card button, .frontmatter-card summary').first();
  if (await frontmatterToggle.count()) {
    await frontmatterToggle.click().catch(() => {});
  }
  await page.waitForTimeout(600);
}

async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
  await page.waitForTimeout(250);
}

for (const theme of ['light', 'dark'] as Theme[]) {
  test.describe(`${theme === 'light' ? 'Paper' : 'Ink'} reading palette`, () => {
    test('every prose element clears AA against its own surface', async ({ page }) => {
      await openFixture(page);
      await applyTheme(page, theme);
      const measurements = await page.evaluate(measureInPage);
      expect(measurements.length).toBeGreaterThan(8);

      // Print the sweep. This is the deliverable half of attn-evme.5 as much as
      // the assertions are: DESIGN.md quotes specific ratios for the sanctioned
      // accent exceptions, and those numbers go stale the moment a surface
      // moves. Running this suite should hand you the current values without
      // anyone having to rebuild the measurement rig.
      console.log(
        `\n--- ${theme} contrast sweep ---\n` +
          measurements
            .map((m) => `${m.label.padEnd(34)} ${String(m.vsBackground).padStart(6)}:1  ${m.color} on ${m.background}`)
            .join('\n'),
      );

      // A selector that matches nothing is skipped by `measureInPage`, so an
      // absent construct would quietly pass. Pin the ones that must exist.
      for (const required of ['body prose', 'link in prose', 'table cell', 'frontmatter key']) {
        expect(
          measurements.some((m) => m.label === required),
          `the fixture must render "${required}" — a missing construct passes silently`,
        ).toBe(true);
      }

      const failures = measurements.filter((m) => {
        // Headings are large text. The saved-state glyph is a 14px 2px-stroke
        // ICON, not text — WCAG 1.4.11 non-text contrast owes 3:1, which is
        // also the standard DESIGN.md documented for it from the start ("a
        // 14px 2px-stroke glyph owes 3:1"). Everything else is body-size text.
        const floor =
          m.selector.startsWith('h') || m.label.includes('saved glyph')
            ? AA_LARGE
            : AA_TEXT;
        return m.vsBackground < floor;
      });
      expect(
        failures.map((f) => `${f.label}: ${f.vsBackground}:1 (${f.color} on ${f.background})`),
      ).toEqual([]);
    });

    test('prose reads in one ink', async ({ page }) => {
      await openFixture(page);
      await applyTheme(page, theme);
      const measurements = await page.evaluate(measureInPage);

      // The whole point of attn-evme.1/.2: running prose is one colour. A link
      // is the sanctioned exception (it carries the accent AND an underline);
      // the `th` eyebrow is the other, being a label rather than prose.
      const prose = measurements.filter((m) =>
        ['body prose', 'heading h1', 'heading h2', 'list item', 'blockquote prose', 'table cell'].includes(
          m.label,
        ),
      );
      expect(prose.length).toBeGreaterThan(4);
      const distinct = [...new Set(prose.map((m) => m.color))];
      expect(
        distinct.length === 1 ? [] : prose.map((m) => `${m.label}=${m.color}`),
      ).toEqual([]);
    });

    test('links are distinguishable without relying on colour alone', async ({ page }) => {
      await openFixture(page);
      await applyTheme(page, theme);
      const measurements = await page.evaluate(measureInPage);
      const link = measurements.find((m) => m.label === 'link in prose');
      expect(link, 'the fixture must contain a link in prose').toBeDefined();

      // WCAG G183: a link distinguished from surrounding body text by colour
      // alone owes 3:1 against that text. attn-evme.1 proves no lightness on
      // this palette satisfies that AND 4.5:1 against the page at the same
      // time — so the rest-state underline is what carries the distinction,
      // and it is not optional. This asserts the pair, not either half.
      const colourAloneWouldSuffice = link!.vsBodyText >= AA_LARGE;
      expect(
        link!.underlined || colourAloneWouldSuffice,
        `link is ${link!.vsBodyText}:1 against body text and has no rest underline`,
      ).toBe(true);
      expect(link!.vsBackground).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test('embedded blocks step toward the ink, never away from the page', async ({ page }) => {
      await openFixture(page);
      await applyTheme(page, theme);
      const surfaces = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const lum = (css: string): number => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#000';
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          const lin = (c: number): number => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
        };
        const root = document.querySelector('.ProseMirror')!;
        const alpha = (css: string): number => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#000';
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
        };
        /**
         * The nearest painted surface at or ABOVE `el`. Correct for the page,
         * whose fill lives far up the tree on body/html.
         */
        const paintedAbove = (start: Element | null): number | null => {
          let node: Element | null = start;
          while (node) {
            const bg = getComputedStyle(node).backgroundColor;
            if (alpha(bg) >= 1) return lum(bg);
            node = node.parentElement;
          }
          return null;
        };
        /**
         * The surface a BLOCK paints for itself — self first, then descendants.
         *
         * Walking upward here silently measured the wrong thing: in the editor a
         * code block is a transparent `div.code-block` wrapping a `pre` that
         * carries the actual fill, and `querySelector('pre, .code-block')`
         * returns the wrapper (it comes first in document order). The upward
         * walk then sailed past the fill entirely and resolved to the page, so
         * block and page measured identical and the assertion failed for a
         * reason that had nothing to do with the tokens.
         */
        const paintedSelf = (start: Element | null): number | null => {
          if (!start) return null;
          const own = getComputedStyle(start).backgroundColor;
          if (alpha(own) >= 1) return lum(own);
          for (const child of Array.from(start.querySelectorAll('*'))) {
            const bg = getComputedStyle(child).backgroundColor;
            if (alpha(bg) >= 1) return lum(bg);
          }
          return null;
        };
        const grab = (sel: string): number | null => paintedSelf(root.querySelector(sel));
        return {
          // The page as PAINTED, for the same reason: the token is not
          // necessarily what ends up behind the prose.
          page: paintedAbove(root),
          isDark: document.documentElement.classList.contains('dark'),
          codeBlock: grab('pre, .code-block'),
          table: grab('table'),
          frontmatter: grab('.frontmatter-card'),
          nestedChip: grab('td code'),
        };
      });

      // Paper: the page is the lightest surface, so a block goes darker.
      // Ink: the page is the darkest, so a block goes lighter. Both mean
      // "more ink here" — the rule attn-evme.4 writes into DESIGN.md.
      expect(surfaces.page, 'the page must have a painted background').not.toBeNull();
      const towardInk = (block: number | null, label: string): void => {
        if (block === null) return;
        const stepsCorrectly = surfaces.isDark
          ? block > surfaces.page!
          : block < surfaces.page!;
        expect(
          stepsCorrectly,
          `${label} luminance ${block.toFixed(4)} vs page ${surfaces.page!.toFixed(4)}`,
        ).toBe(true);
      };
      towardInk(surfaces.codeBlock, 'code block');
      towardInk(surfaces.table, 'table');
      towardInk(surfaces.frontmatter, 'frontmatter card');

      // A nested block takes one FURTHER step in the same direction, so an
      // inline chip inside a table cell still reads as recessed rather than
      // becoming the lightest thing in the table.
      if (surfaces.nestedChip !== null && surfaces.table !== null) {
        const stepsFurther = surfaces.isDark
          ? surfaces.nestedChip > surfaces.table
          : surfaces.nestedChip < surfaces.table;
        expect(
          stepsFurther,
          `nested chip ${surfaces.nestedChip.toFixed(4)} vs table ${surfaces.table.toFixed(4)}`,
        ).toBe(true);
      }
    });
  });
}
