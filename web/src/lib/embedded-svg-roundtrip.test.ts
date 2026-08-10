// Byte-exact round-trip for embedded SVG blocks (attn-vlmz.4.2).
//
// The hard invariant: sanitising must NEVER rewrite the user's file. The
// ProseMirror document carries the raw source in `embedded_svg.source` and the
// serializer emits exactly those bytes, so `serialize(parse(md)) === md` holds
// for every block the `attn_svg_block` rule recognises — including blocks the
// sanitiser would empty completely, which is the case that would expose any
// leak of the cleaned form into serialization.
//
// Run with:
//
//   cd web && npx tsx src/lib/embedded-svg-roundtrip.test.ts

import { markdownParser, markdownSerializer, schema } from './schema';
import type { Node as PmNode } from 'prosemirror-model';

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult> | CaseResult> = [];

function defineCase(name: string, fn: () => void | string | Promise<void | string>): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(md: string): PmNode {
  const doc = markdownParser.parse(md);
  assert(doc !== null, 'parser returned null');
  return doc;
}

function serialize(doc: PmNode): string {
  return markdownSerializer.serialize(doc);
}

function countNodes(doc: PmNode, typeName: string): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === typeName) n += 1;
    return true;
  });
  return n;
}

function svgSources(doc: PmNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'embedded_svg') out.push(String(node.attrs.source));
    return true;
  });
  return out;
}

/** Asserts the markdown survives a parse/serialize cycle byte for byte. */
function assertRoundTrip(md: string): PmNode {
  const doc = parse(md);
  const out = serialize(doc);
  assert(
    out === md,
    `round trip changed the source\n--- in ---\n${JSON.stringify(md)}\n--- out ---\n${JSON.stringify(out)}`,
  );
  return doc;
}

// ---------------------------------------------------------------------------
// The node exists and parses
// ---------------------------------------------------------------------------

defineCase('the schema has an embedded_svg atom node', () => {
  const type = schema.nodes.embedded_svg;
  assert(type !== undefined, 'embedded_svg is missing from the schema');
  assert(type.isAtom, 'embedded_svg must be an atom');
  assert(type.isBlock, 'embedded_svg must be a block node');
});

defineCase('a standalone SVG block becomes one embedded_svg node', () => {
  const md = '# Title\n\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n\nAfter.';
  const doc = parse(md);
  assert(countNodes(doc, 'embedded_svg') === 1, 'expected exactly one embedded_svg node');
  assert(
    svgSources(doc)[0] === '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    `stored source is wrong: ${JSON.stringify(svgSources(doc)[0])}`,
  );
});

// ---------------------------------------------------------------------------
// Byte-exact round trips
// ---------------------------------------------------------------------------

defineCase('single-line SVG round-trips byte-exact', () => {
  assertRoundTrip('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
});

defineCase('multi-line SVG round-trips byte-exact', () => {
  assertRoundTrip(
    [
      '<svg viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg">',
      '  <rect x="0" y="0" width="120" height="60" fill="#f5f0e8"/>',
      '  <text x="60" y="35" text-anchor="middle">attn</text>',
      '</svg>',
    ].join('\n'),
  );
});

defineCase("the bug reporter's preserveAspectRatio block round-trips byte-exact", () => {
  const md = [
    '# Diagram',
    '',
    '<svg preserveAspectRatio="xMinYMin meet" viewBox="0 0 640 360">',
    '  <rect width="640" height="360" fill="#f5f0e8"/>',
    '</svg>',
    '',
    'Body copy after the figure.',
  ].join('\n');
  const doc = assertRoundTrip(md);
  assert(countNodes(doc, 'embedded_svg') === 1, 'the SVG should have become a node, not a paragraph');
});

defineCase('interior blank lines inside the SVG survive', () => {
  assertRoundTrip('<svg viewBox="0 0 10 10">\n\n  <rect width="10" height="10"/>\n\n</svg>');
});

defineCase('a block the sanitiser would empty still round-trips byte-exact', () => {
  // This is the case that catches any leak of the sanitised form into
  // serialization: nothing inside survives the allowlist, yet the file must be
  // returned unchanged.
  const md = '<svg onload="alert(1)"><script>alert(1)</script><foreignObject/></svg>';
  const doc = assertRoundTrip(md);
  assert(svgSources(doc)[0] === md, 'the raw source must be stored verbatim');
});

defineCase('a block the sanitiser REJECTS still round-trips byte-exact', () => {
  // Unparseable to the tokenizer (unquoted attribute) — renders as a fallback
  // <details>, but the bytes are untouched.
  assertRoundTrip('<svg><rect fill=red /></svg>');
});

defineCase('an indented (<4 spaces) SVG keeps its indentation', () => {
  const doc = assertRoundTrip('  <svg viewBox="0 0 4 4"><rect/></svg>');
  assert(
    svgSources(doc)[0] === '  <svg viewBox="0 0 4 4"><rect/></svg>',
    'the leading indent must be part of the stored source',
  );
});

defineCase('nested <svg> elements round-trip as one block', () => {
  const md = '<svg viewBox="0 0 20 20">\n  <svg viewBox="0 0 10 10"><rect/></svg>\n</svg>';
  const doc = assertRoundTrip(md);
  assert(countNodes(doc, 'embedded_svg') === 1, 'nested svg must not split into two blocks');
});

defineCase('a self-closing root <svg/> round-trips', () => {
  assertRoundTrip('<svg viewBox="0 0 1 1"/>');
});

defineCase('two SVG blocks in one document round-trip', () => {
  const md = '<svg viewBox="0 0 1 1"><rect/></svg>\n\nBetween.\n\n<svg viewBox="0 0 2 2"><circle/></svg>';
  const doc = assertRoundTrip(md);
  assert(countNodes(doc, 'embedded_svg') === 2, 'expected two embedded_svg nodes');
});

defineCase('SVG alongside frontmatter, code and tables round-trips', () => {
  const md = [
    '---',
    'title: Spec',
    '---',
    '',
    '# Spec',
    '',
    '<svg viewBox="0 0 10 10"><rect/></svg>',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1;',
    '```',
  ].join('\n');
  const doc = assertRoundTrip(md);
  assert(countNodes(doc, 'embedded_svg') === 1, 'the SVG should still be recognised in a mixed document');
});

defineCase('SVG next to a task list is recognised', () => {
  // Not asserted byte-exact: the task_list serializer re-indents and loosens
  // list items, which is pre-existing behaviour unrelated to this feature.
  const md = '<svg viewBox="0 0 10 10"><rect/></svg>\n\n- [ ] review the diagram\n- [x] check the numbers';
  const doc = parse(md);
  assert(countNodes(doc, 'embedded_svg') === 1, 'the SVG should be recognised beside a task list');
  assert(
    serialize(doc).startsWith('<svg viewBox="0 0 10 10"><rect/></svg>\n\n'),
    'the SVG block itself must still serialize verbatim',
  );
});

// ---------------------------------------------------------------------------
// The conditions that keep round-tripping unconditional
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Glued shapes (widened 2026-08-09 — "we should be able to render SVGs")
//
// These two are what agents actually write: the SVG hard against the next or
// previous prose line. They used to be deliberately unrecognised to keep the
// fired-rule roundtrip byte-exact; the cost was a diagram rendering as a
// paragraph of escaped source, which is what got reported. The contract now:
// glued shapes RENDER, and normalise to the blank-separated shape on first
// serialize — after which they are byte-exact. parse∘serialize is idempotent.
// ---------------------------------------------------------------------------

defineCase('SVG glued to the FOLLOWING line renders, and normalises stably', () => {
  const md = '<svg viewBox="0 0 1 1"><rect/></svg>\nImmediately following text.';
  const doc = parse(md);
  assert(countNodes(doc, 'embedded_svg') === 1, 'the glued-next shape must render');
  const out = serialize(doc);
  assert(
    out.includes('</svg>\n\nImmediately following text.'),
    `first serialize separates the blocks conventionally: ${JSON.stringify(out)}`,
  );
  assert(serialize(parse(out)) === out, 'and the separated shape is a fixed point');
});

defineCase('SVG glued under the PRECEDING line interrupts the paragraph', () => {
  // Like a heading or a fence: `<svg` at the start of a line terminates a
  // running paragraph rather than being swallowed as a lazy continuation.
  const md = 'Lead-in prose.\n<svg viewBox="0 0 1 1"><rect/></svg>\n\nAfter.';
  const doc = parse(md);
  assert(countNodes(doc, 'embedded_svg') === 1, 'the glued-prev shape must render');
  const out = serialize(doc);
  assert(
    out.includes('Lead-in prose.\n\n<svg'),
    `first serialize separates the paragraph from the block: ${JSON.stringify(out)}`,
  );
  assert(serialize(parse(out)) === out, 'and the separated shape is a fixed point');
});

defineCase('blank-line-separated SVG still round-trips byte-exact', () => {
  // The widening must not have weakened the original guarantee where it held.
  const md = 'Before.\n\n<svg viewBox="0 0 1 1"><rect/></svg>\n\nAfter.';
  assert(serialize(parse(md)) === md, 'the separated shape stays byte-exact');
});

defineCase('trailing content on the </svg> line is NOT recognised', () => {
  const md = '<svg viewBox="0 0 1 1"><rect/></svg> trailing';
  const doc = parse(md);
  assert(countNodes(doc, 'embedded_svg') === 0, 'the rule must not fire with trailing content');
});

defineCase('SVG inside a list item is NOT recognised (top level only)', () => {
  const md = '- item\n\n  <svg viewBox="0 0 1 1"><rect/></svg>';
  const doc = parse(md);
  assert(countNodes(doc, 'embedded_svg') === 0, 'the rule must not fire inside a list item');
});

defineCase('4-space indented SVG stays an indented code block', () => {
  const md = '    <svg viewBox="0 0 1 1"><rect/></svg>';
  const doc = parse(md);
  assert(countNodes(doc, 'embedded_svg') === 0, 'indented code must win');
  assert(countNodes(doc, 'code_block') === 1, 'expected an indented code block');
});

defineCase('SVG inside a fenced code block stays code', () => {
  const md = '```html\n<svg viewBox="0 0 1 1"><rect/></svg>\n```';
  const doc = assertRoundTrip(md);
  assert(countNodes(doc, 'embedded_svg') === 0, 'a fenced block must not be parsed as an SVG node');
});

defineCase('mid-paragraph SVG is NOT recognised (block level only)', () => {
  const md = 'Text before <svg viewBox="0 0 1 1"><rect/></svg> text after.';
  const doc = parse(md);
  assert(countNodes(doc, 'embedded_svg') === 0, 'inline SVG is out of scope');
});

defineCase('general raw HTML is still escaped, not rendered', () => {
  const doc = parse('<div onclick="alert(1)">hello</div>');
  assert(countNodes(doc, 'embedded_svg') === 0, 'only <svg> gets a node; html:false still governs the rest');
});

// ---------------------------------------------------------------------------
// Existing behaviour is unchanged
// ---------------------------------------------------------------------------

defineCase('documents without SVG are unaffected', () => {
  // `*` bullets, not `-`: prosemirror-markdown's own list marker, unrelated to
  // this feature.
  assertRoundTrip('# Heading\n\nA paragraph with **bold** and `code`.\n\n* one\n\n* two');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

async function runAllCases(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
    nodeProcess?.exit?.(1);
  }
}

void runAllCases();
