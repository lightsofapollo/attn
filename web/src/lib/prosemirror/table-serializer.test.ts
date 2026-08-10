// Table serializer fidelity (attn-11g4.10). `web/` has no vitest config, so —
// like table-schema.test.ts / markdown-paste.test.ts — this is a tsx-runnable
// set of contract cases over the REAL parser and serializer the editor loads.
//
// Two defects are locked out here, both silent data loss on save, and both
// reachable without the user ever touching the table: `serializeAccepted()`
// (Editor.svelte:169-176) serializes the WHOLE document, so editing one
// paragraph rewrites every table in the file.
//
//  1. INLINE MARKS STRIPPED. `renderTableRow` serialized each cell node
//     directly, and `MarkdownSerializer.serialize()` runs `renderContent`,
//     which walks children as blocks — mark delimiters are only ever emitted
//     by `renderInline`. So bold saved as plain text and a link lost its
//     target. The parser was never at fault: the marks were correct in the
//     document and destroyed on the way out.
//
//  2. ESCAPED PIPE CORRUPTED THE TABLE. A cell's `\|` serialized as a bare
//     `|`, which markdown then reads as a column delimiter. The loss takes TWO
//     saves to become unrecoverable — save one widens the row past the header's
//     column count, save two truncates it and drops the overflowing cell — so
//     every pipe case below is asserted over two cycles, not one.
//
// Run with:
//
//   cd web && npx tsx src/lib/prosemirror/table-serializer.test.ts

import { markdownParser, markdownSerializer, schema } from '../schema';
import type { Node as PmNode } from 'prosemirror-model';

// ---------------------------------------------------------------------------
// Tiny harness (matches table-schema.test.ts conventions)
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

/** One save: parse the markdown and serialize it back. */
function save(md: string): string {
  const doc = markdownParser.parse(md);
  assert(doc !== null, 'parser returned null');
  return markdownSerializer.serialize(doc);
}

/** Cells in the first body row after re-reading the markdown. */
function bodyCellCount(md: string): number {
  const doc = markdownParser.parse(md);
  assert(doc !== null, 'parser returned null');
  let row: PmNode | null = null;
  doc.descendants((n) => {
    if (row === null && n.type.name === 'table') row = n.child(1);
    return row === null;
  });
  assert(row !== null, 'no body row found');
  return (row as PmNode).childCount;
}

/**
 * Assert the source survives `cycles` saves unchanged.
 *
 * Two cycles is the floor for anything involving pipes: a single-cycle test
 * passes while the document is already broken, because the row only loses its
 * overflowing cell when the widened markdown is re-read.
 */
function assertStable(md: string, cycles = 2): void {
  let current = md;
  for (let i = 1; i <= cycles; i++) {
    current = save(current);
    assert(
      current === md,
      `save ${i} changed the document\n  expected: ${JSON.stringify(md)}\n  got:      ${JSON.stringify(current)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. Every mark survives a cell
// ---------------------------------------------------------------------------

const MARK_CASES: Array<[name: string, cell: string]> = [
  ['strong', '**bold**'],
  ['em', '*em*'],
  ['inline code', '`code`'],
  ['link', '[label](https://example.com/a)'],
  ['strikethrough', '~~gone~~'],
];

for (const [name, cell] of MARK_CASES) {
  defineCase(`${name} survives a body cell`, () => {
    assertStable(`| h |\n| --- |\n| ${cell} |`);
  });

  defineCase(`${name} survives a HEADER cell`, () => {
    assertStable(`| ${cell} |\n| --- |\n| body |`);
  });
}

defineCase('a link keeps its href — the silent URL destroyer', () => {
  // Called out specifically: the old serializer emitted the link TEXT and
  // dropped the destination, so the URL was gone with nothing on screen to
  // show for it.
  const md = '| doc |\n| --- |\n| [spec](https://example.com/deep/path?q=1) |';
  assertStable(md);
  const out = save(md);
  assert(out.includes('https://example.com/deep/path?q=1'), `href missing from: ${out}`);
});

defineCase('marks combined in one cell', () => {
  assertStable('| a |\n| --- |\n| **bold** and *em* and `code` and [l](https://e.com) |');
});

defineCase('nested marks in one cell', () => {
  assertStable('| a |\n| --- |\n| ***both*** |');
});

defineCase('the same mark in adjacent cells', () => {
  assertStable('| a | b | c |\n| --- | --- | --- |\n| **one** | **two** | **three** |');
});

defineCase('different marks in adjacent cells', () => {
  assertStable('| a | b | c |\n| --- | --- | --- |\n| `code` | **bold** | [l](https://e.com) |');
});

defineCase('marks in header AND body of the same table', () => {
  assertStable('| **h1** | `h2` |\n| --- | --- |\n| *b1* | [b2](https://e.com) |');
});

defineCase('marks survive alongside column alignment', () => {
  assertStable('| l | c | r |\n| :--- | :---: | ---: |\n| **a** | *b* | `c` |');
});

// ---------------------------------------------------------------------------
// 2. Pipes — asserted over two save cycles
// ---------------------------------------------------------------------------

defineCase('escaped pipe survives two saves (content was destroyed on save 2)', () => {
  // Before the fix:
  //   save 1: "| x | y | keep |"   <- row widened past the header
  //   save 2: "| x | y |"          <- "keep" gone for good
  const md = '| a | b |\n| --- | --- |\n| x \\| y | keep |';
  assertStable(md);
  const out = save(save(md));
  assert(out.includes('keep'), `the trailing cell was dropped: ${out}`);
});

defineCase('escaped pipe in a header cell survives two saves', () => {
  assertStable('| x \\| y | b |\n| --- | --- |\n| 1 | 2 |');
});

defineCase('multiple escaped pipes in one cell survive two saves', () => {
  assertStable('| a | b |\n| --- | --- |\n| p \\| q \\| r | keep |');
});

defineCase('escaped pipe inside inline code survives two saves', () => {
  // Code spans skip `esc()` entirely (the code mark carries `escape: false`),
  // so this pipe is only reached because the escape runs over the FULLY
  // rendered cell rather than through `escapeExtraCharacters`.
  assertStable('| a | b |\n| --- | --- |\n| `a \\| b` | keep |');
});

defineCase('a pipe in a link destination cannot break the row', () => {
  // Hrefs bypass `esc()` (prosemirror-markdown escapes only `( ) "` there), so
  // this looked like the other dangerous path. It isn't, for a reason worth
  // recording: markdown-it percent-encodes the destination at PARSE time, so
  // the href holds `%7C` and never delivers a raw pipe to the row. That is
  // table-independent — a link in a paragraph normalizes identically — so it
  // is URL normalization, not loss. Byte-identity therefore does not hold on
  // the first save; equivalence and convergence do.
  const md = '| a | b |\n| --- | --- |\n| [l](https://e.com/x\\|y) | keep |';
  const first = save(md);
  const second = save(first);
  assert(first === second, `should converge after one save\n  1: ${first}\n  2: ${second}`);
  assert(first.includes('%7C'), `pipe should be percent-encoded, got: ${first}`);
  assert(first.includes('keep'), `the trailing cell was dropped: ${first}`);
  assert(bodyCellCount(first) === 2, `row should still hold 2 cells, holds ${bodyCellCount(first)}`);
});

defineCase('a literal pipe that never came from markdown is escaped on the way out', () => {
  // Unreachable through the parser — a bare `|` in source IS a delimiter — but
  // reachable through a paste or a programmatic edit, and it is the same
  // corruption once it reaches the row.
  const t = schema.nodes;
  const cell = (s: string) => t.table_cell.create(null, schema.text(s));
  const hdr = (s: string) => t.table_header.create(null, schema.text(s));
  const doc = t.doc.create(null, [
    t.table.create(null, [
      t.table_row.create(null, [hdr('a'), hdr('b')]),
      t.table_row.create(null, [cell('x | y'), cell('keep')]),
    ]),
  ]);
  const out = markdownSerializer.serialize(doc);
  assert(out.includes('x \\| y'), `literal pipe should be escaped, got: ${out}`);

  // And the row must still read back as two cells with the text intact.
  const reparsed = markdownParser.parse(out);
  assert(reparsed !== null, 'reparse failed');
  let row: PmNode | null = null;
  reparsed.descendants((n) => {
    if (n.type.name === 'table') row = n.child(1);
    return row === null;
  });
  assert(row !== null, 'no body row after reparse');
  const bodyRow = row as PmNode;
  assert(bodyRow.childCount === 2, `row should still hold 2 cells, holds ${bodyRow.childCount}`);
  assert(
    bodyRow.child(0).textContent === 'x | y',
    `cell text should survive, got ${JSON.stringify(bodyRow.child(0).textContent)}`,
  );
  assert(bodyRow.child(1).textContent === 'keep', 'the trailing cell was dropped');
});

// ---------------------------------------------------------------------------
// 3. Byte-identity for ordinary tables — the constraint from attn-11g4.8
// ---------------------------------------------------------------------------

const PLAIN_CASES: Array<[name: string, markdown: string]> = [
  ['plain', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
  ['aligned', '| left | center | right |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'],
  ['single column', '| only |\n| --- |\n| x |'],
  ['wide', '| a | b | c | d | e |\n| --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |\n| 6 | 7 | 8 | 9 | 10 |'],
  ['empty cells', '| a | b |\n| --- | --- |\n|  | 2 |\n| 3 |  |'],
  ['surrounded by prose', '# Title\n\nBefore.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.'],
  ['two tables', '| a |\n| --- |\n| 1 |\n\ntext\n\n| b |\n| --- |\n| 2 |'],
];

for (const [name, md] of PLAIN_CASES) {
  defineCase(`ordinary table is untouched: ${name}`, () => {
    assertStable(md);
  });
}

defineCase('prose around a table keeps its own escaping rules', () => {
  // A pipe outside a table must NOT gain a backslash — the escape is scoped to
  // the cell renderer, not the document.
  const md = 'a | b\n\n| h |\n| --- |\n| c |';
  assertStable(md);
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
    const proc = (globalThis as { process?: NodeProcessShape }).process;
    proc?.exit?.(1);
  }
}

void runAllCases();
