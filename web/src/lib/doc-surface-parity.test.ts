// One document surface, one owner per rule (design-system consolidation,
// 2026-08-08 — issues 5 and 7 of the conflict inventory).
//
// The only document surface in the app is the editor mount:
// `div.prosemirror-mount.attn-doc > div.ProseMirror` (Editor.svelte).
// base.css owns the document GRAMMAR — typography, links, blockquotes, lists,
// code, and the table surface — in `@layer doc`, reaching the editor via
// `.attn-doc` descendant selectors through the mount. prosemirror.css owns
// EDITOR MECHANICS in `@layer components`, which outranks doc by declared
// order (`@layer theme, base, chrome, doc, components, utilities;` in app.css).
//
// HISTORY, because the shape of this test is the shape of a bug that existed:
// before the doc tier, base.css sat wholesale in `@layer base` and the table
// surface had to be declared TWICE (components-beats-base forced a documented
// twin in prosemirror.css), and the prose-link rule hid OUTSIDE all layers to
// survive the hosted chrome reset. Issue 5 first made the twins drift-proof;
// issue 7 collapsed them. This test now enforces the end state: the surface
// exists once, the editor side declares mechanics only, and the layer
// architecture that makes that possible stays declared.
//
// Run with:
//
//   cd web && npx tsx src/lib/doc-surface-parity.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void): void {
  cases.push(() => {
    try {
      fn();
      return { name, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(libDir, rel), 'utf8');

const base = read('../../styles/base.css');
const pm = read('../../styles/prosemirror.css');
const editor = read('Editor.svelte');

/** Strip comments, then map `selector -> {prop: value}` for every rule. */
function parse(css: string): Map<string, Record<string, string>> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, Record<string, string>>();
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.replace(/\s+/g, ' ').trim();
    const body: Record<string, string> = {};
    for (const decl of m[2]!.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).replace(/\s+/g, ' ').trim();
      if (prop) body[prop] = value;
    }
    const existing = out.get(sel);
    out.set(sel, existing ? { ...existing, ...body } : body);
  }
  return out;
}

const baseRules = parse(base);
const pmRules = parse(pm);

/**
 * Every declaration reaching `wanted`, merged across rules in file order.
 * Merging matters: base.css declares the cell padding on `.attn-doc th,
 * .attn-doc td` and the eyebrow type on `.attn-doc th` — asking for `th` must
 * see both, the way the cascade does, or the test reports a missing property
 * that is very much applied.
 */
function rule(rules: Map<string, Record<string, string>>, wanted: string): Record<string, string> | null {
  let merged: Record<string, string> | null = null;
  for (const [sel, body] of rules) {
    const parts = sel.split(/,(?![^()]*\))/).map((s) => s.replace(/\s+/g, ' ').trim());
    if (parts.includes(wanted)) merged = { ...(merged ?? {}), ...body };
  }
  return merged;
}

/**
 * SINGLE-SOURCE CONTRACT (rewritten when issue 7 collapsed the twins).
 *
 * base.css owns the table SURFACE in `@layer doc` and reaches the editor
 * through the mount. prosemirror.css may declare only what the EDITOR adds
 * to a table — today that is `position` on cells (attn-11g4.7) and nothing
 * else. Any surface property reappearing on the editor side recreates the
 * twin this architecture just retired, and wins the cascade silently.
 */
const SURFACE: Record<string, string[]> = {
  '.attn-doc table': [
    'border-collapse', 'border-spacing', 'background', 'border',
    'border-radius', 'box-shadow', 'width', 'font-size', 'margin-bottom',
  ],
  '.attn-doc td': ['padding', 'text-align', 'border-bottom'],
  '.attn-doc th': [
    'font-family', 'font-weight', 'font-size', 'text-transform',
    'letter-spacing', 'color', 'border-bottom-color',
  ],
  '.attn-doc table > :last-child > tr:last-child > :is(th, td)': ['border-bottom'],
};

defineCase('base.css carries the whole table surface in the doc layer', () => {
  assert(/@layer doc \{/.test(base), 'base.css must declare the doc layer');
  for (const [sel, props] of Object.entries(SURFACE)) {
    const body = rule(baseRules, sel);
    assert(body !== null, `${sel} must exist in base.css`);
    for (const prop of props) {
      assert(prop in body!, `${sel} must declare ${prop} — it is the single copy of the surface`);
    }
  }
});

defineCase('the editor side declares mechanics only, never the surface', () => {
  assert(
    rule(pmRules, '.ProseMirror table') === null,
    '.ProseMirror table must not exist — the surface lives in base.css via the mount',
  );
  assert(
    rule(pmRules, '.ProseMirror table > :last-child > tr:last-child > :is(th, td)') === null,
    'the last-row trim must not be restated on the editor side',
  );
  for (const sel of ['.ProseMirror th', '.ProseMirror td']) {
    const body = rule(pmRules, sel);
    if (body === null) continue;
    const extras = Object.keys(body).filter((prop) => prop !== 'position');
    assert(
      extras.length === 0,
      `${sel} may declare only editor mechanics (position); found: ${extras.join(', ')}`,
    );
  }
});

defineCase('the cascade order is declared where every entry loads it', () => {
  const appCss = read('../app.css');
  assert(
    /@layer theme, base, chrome, doc, components, utilities;/.test(appCss),
    'app.css must declare the six-layer order before importing Tailwind',
  );
  const chromeCss = read('../hosted/chrome.css');
  assert(
    /@layer chrome \{/.test(chromeCss),
    'the hosted bare-tag resets must live in @layer chrome, not outside the layers',
  );
});

defineCase('the mount carries the hinge class', () => {
  // base.css reaches the editor ONLY because the mount stacks `attn-doc`
  // beside `prosemirror-mount`. Drop it and every document rule — links,
  // blockquotes, code surfaces, the lot — silently detaches, which would
  // present as "the whole reading surface lost its styling" with no error.
  assert(
    /class="prosemirror-mount attn-doc"/.test(editor),
    'Editor.svelte must mount `prosemirror-mount attn-doc`',
  );
});

defineCase('the dead static renderer stays dead', () => {
  // Viewer.svelte (comrak HTML into `article.attn-doc`) lost its last caller
  // and was deleted; the child-combinator rules that could only match its DOM
  // went with it. A returning `article.attn-doc` selector would be a rule that
  // can never match — the place the next person hides a fix that never applies.
  // Comment-stripped on purpose: the comments explaining the deletion may (and
  // do) NAME the dead selector; only a rule that would actually match matters.
  const bareBase = base.replace(/\/\*[\s\S]*?\*\//g, '');
  const barePm = pm.replace(/\/\*[\s\S]*?\*\//g, '');
  assert(
    !/article\.attn-doc/.test(bareBase) && !/article\.attn-doc/.test(barePm),
    'no stylesheet may target article.attn-doc — that DOM no longer exists',
  );
  assert(
    !fs.existsSync(path.join(libDir, 'Viewer.svelte')),
    'Viewer.svelte must not return without a consumer',
  );
});

defineCase('grammar stays single-sourced outside the twins', () => {
  // base.css owns the document grammar. prosemirror.css restating any of it
  // beyond the sanctioned table twins recreates the disease this file exists
  // to contain — the restatement wins the layer war and base.css becomes
  // decorative without anyone noticing.
  const banned = ['a', 'blockquote', 'blockquote p', 'code', 'pre code', 'li', 'ol', 'ul'];
  for (const tail of banned) {
    assert(
      rule(pmRules, `.ProseMirror ${tail}`) === null,
      `.ProseMirror ${tail} must not exist — base.css owns "${tail}" via the mount`,
    );
  }
});

let failed = 0;
for (const run of cases) {
  const result = run();
  if (result.ok) {
    console.log(`PASS ${result.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${result.name}`);
    if (result.detail) console.error(`  ${result.detail}`);
  }
}

if (failed > 0) process.exit(1);
