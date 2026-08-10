// Table schema contract (attn-11g4.8). `web/` has no vitest config, so — like
// markdown-paste.test.ts / PeerStrip.test.ts — this is a tsx-runnable set of
// contract cases run against the SAME schema/parser/serializer the editor
// loads with.
//
// Two things are locked down here:
//
//  1. prosemirror-tables' requirements. Every cell must carry colspan, rowspan
//     and colwidth. The library reads them without checking they exist —
//     `findWidth()` does `rowWidth += cell.attrs.colspan` — so a missing
//     colspan makes the table width NaN, TableMap comes back zero-length, and
//     `CellSelection.create` / `TableMap.colCount` throw RangeError. Those two
//     throws are what made cell selection impossible and made hovering a
//     cell's right edge raise an uncaught exception. The harness below is the
//     one that diagnosed it; it is kept as the regression test.
//
//  2. Serialization is unchanged by (1). Markdown has no spans or pixel
//     widths, so adding the attrs must not alter a single byte of output for
//     ordinary tables. This is the hard invariant — a schema change that
//     quietly rewrote every table on save would be far worse than the bug.
//
// Run with:
//
//   cd web && npx tsx src/lib/prosemirror/table-schema.test.ts

import { TableMap, CellSelection } from 'prosemirror-tables';
import { Node } from 'prosemirror-model';
import type { Node as PmNode } from 'prosemirror-model';
import { markdownParser, markdownSerializer, schema } from '../schema';

// ---------------------------------------------------------------------------
// Tiny harness (matches markdown-paste.test.ts conventions)
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
// Fixtures
// ---------------------------------------------------------------------------

const PLAIN = '| a | b |\n| --- | --- |\n| 1 | 2 |';
const THREE_BY_THREE =
  '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';

function parse(md: string): PmNode {
  const doc = markdownParser.parse(md);
  assert(doc !== null, 'parser returned null');
  return doc;
}

/** First table in the doc, with the position its content starts at. */
function firstTable(doc: PmNode): { table: PmNode; start: number } {
  let found: { table: PmNode; start: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'table') {
      found = { table: node, start: pos + 1 };
      return false;
    }
    return true;
  });
  assert(found !== null, 'no table node in doc');
  return found;
}

// ---------------------------------------------------------------------------
// 1. The attrs exist and default correctly
// ---------------------------------------------------------------------------

defineCase('markdown cells carry colspan/rowspan/colwidth defaults', () => {
  const { table } = firstTable(parse(PLAIN));
  let cells = 0;
  table.descendants((node) => {
    if (node.type.name !== 'table_header' && node.type.name !== 'table_cell') return true;
    cells += 1;
    assert(node.attrs.colspan === 1, `colspan should default to 1, got ${node.attrs.colspan}`);
    assert(node.attrs.rowspan === 1, `rowspan should default to 1, got ${node.attrs.rowspan}`);
    assert(node.attrs.colwidth === null, `colwidth should default to null, got ${node.attrs.colwidth}`);
    return true;
  });
  assert(cells === 4, `expected 4 cells, saw ${cells}`);
  return `${cells} cells`;
});

// ---------------------------------------------------------------------------
// 2. TableMap is no longer NaN-poisoned — the original diagnosis, inverted
// ---------------------------------------------------------------------------

defineCase('TableMap resolves real width/height/map (was NaN / [])', () => {
  const { table } = firstTable(parse(THREE_BY_THREE));
  const map = TableMap.get(table);
  assert(map.width === 3, `width should be 3, got ${map.width}`);
  assert(map.height === 3, `height should be 3, got ${map.height}`);
  assert(map.map.length === 9, `map should hold 9 entries, got ${map.map.length}`);
  assert(
    map.map.every((offset) => typeof offset === 'number' && Number.isFinite(offset)),
    `map holds non-finite offsets: ${JSON.stringify(map.map)}`,
  );
  assert(map.problems == null, `TableMap reported problems: ${JSON.stringify(map.problems)}`);
  return `${map.width}x${map.height}`;
});

defineCase('colCount resolves for every cell (the resize-hover throw)', () => {
  // This is the exact call that threw: columnResizing's `decorations` prop ->
  // handleDecorations -> map.colCount($cell.pos - start). It runs whenever the
  // pointer comes within 5px of a cell's right edge.
  const { table } = firstTable(parse(THREE_BY_THREE));
  const map = TableMap.get(table);
  const seen: number[] = [];
  for (const offset of map.map) seen.push(map.colCount(offset));
  assert(seen.length === 9, `expected 9 lookups, got ${seen.length}`);
  assert(
    seen.every((col) => col >= 0 && col < map.width),
    `colCount returned out-of-range columns: ${JSON.stringify(seen)}`,
  );
  // Row-major: each row runs 0,1,2.
  assert(
    JSON.stringify(seen) === JSON.stringify([0, 1, 2, 0, 1, 2, 0, 1, 2]),
    `columns should read row-major 0,1,2 per row; got ${JSON.stringify(seen)}`,
  );
});

defineCase('CellSelection.create selects the intended cells (was RangeError)', () => {
  const doc = parse(THREE_BY_THREE);
  const { start } = firstTable(doc);
  const map = TableMap.get(firstTable(doc).table);

  // Single cell.
  const one = CellSelection.create(doc, start + map.map[0]);
  let count = 0;
  one.forEachCell(() => count++);
  assert(count === 1, `single-cell selection should hold 1 cell, held ${count}`);

  // Rectangle: top-left through the middle cell of a 3x3 => 2x2 = 4 cells.
  const rect = CellSelection.create(doc, start + map.map[0], start + map.map[4]);
  count = 0;
  rect.forEachCell(() => count++);
  assert(count === 4, `2x2 rectangle should hold 4 cells, held ${count}`);
});

// ---------------------------------------------------------------------------
// 3. Serialization is untouched — the hard invariant
// ---------------------------------------------------------------------------

const ROUND_TRIP: Array<[name: string, markdown: string]> = [
  ['plain', PLAIN],
  ['aligned', '| left | center | right |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'],
  ['single column', '| only |\n| --- |\n| x |'],
  ['wide', THREE_BY_THREE],
  ['empty cells', '| a | b |\n| --- | --- |\n|  | 2 |\n| 3 |  |'],
  ['surrounded by prose', '# Title\n\nBefore.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.'],
  ['two tables', '| a |\n| --- |\n| 1 |\n\ntext\n\n| b |\n| --- |\n| 2 |'],
];

for (const [name, md] of ROUND_TRIP) {
  defineCase(`round-trip is byte-identical: ${name}`, () => {
    const out = markdownSerializer.serialize(parse(md));
    assert(out === md, `expected:\n${JSON.stringify(md)}\ngot:\n${JSON.stringify(out)}`);
  });
}

defineCase('column alignment still survives the round trip', () => {
  const { table } = firstTable(parse('| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'));
  const header = table.child(0);
  const aligns = [0, 1, 2].map((i) => header.child(i).attrs.align);
  assert(
    JSON.stringify(aligns) === JSON.stringify(['left', 'center', 'right']),
    `alignments should be left/center/right, got ${JSON.stringify(aligns)}`,
  );
});

// ---------------------------------------------------------------------------
// 4. DOM mapping — exercised through the spec's own hooks, so no DOM needed
// ---------------------------------------------------------------------------

/** Minimal stand-in for the `<td>`/`<th>` a paste would hand to getAttrs. */
function fakeCellDom(attrs: Record<string, string>, textAlign = ''): HTMLElement {
  return {
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    style: { textAlign },
  } as unknown as HTMLElement;
}

function cellGetAttrs(typeName: 'table_cell' | 'table_header') {
  const rule = schema.nodes[typeName].spec.parseDOM?.[0];
  assert(rule != null && typeof rule.getAttrs === 'function', `${typeName} has no parseDOM getAttrs`);
  return rule.getAttrs as (dom: HTMLElement) => Record<string, unknown>;
}

defineCase('parseDOM reads colspan/rowspan/data-colwidth off a pasted cell', () => {
  const got = cellGetAttrs('table_cell')(
    fakeCellDom({ colspan: '2', rowspan: '3', 'data-colwidth': '100,200' }, 'center'),
  );
  assert(got.colspan === 2, `colspan should be 2, got ${got.colspan}`);
  assert(got.rowspan === 3, `rowspan should be 3, got ${got.rowspan}`);
  assert(
    JSON.stringify(got.colwidth) === JSON.stringify([100, 200]),
    `colwidth should be [100,200], got ${JSON.stringify(got.colwidth)}`,
  );
  assert(got.align === 'center', `align should be center, got ${got.align}`);
});

defineCase('parseDOM drops a colwidth list that does not match colspan', () => {
  // TableView sizes columns straight off this list; a mismatched one is not
  // this cell's, and letting it through lays out the table against garbage.
  const got = cellGetAttrs('table_cell')(fakeCellDom({ colspan: '2', 'data-colwidth': '100' }));
  assert(got.colwidth === null, `mismatched colwidth should be dropped, got ${JSON.stringify(got.colwidth)}`);
  const malformed = cellGetAttrs('table_cell')(fakeCellDom({ 'data-colwidth': 'abc' }));
  assert(malformed.colwidth === null, `malformed colwidth should be dropped, got ${JSON.stringify(malformed.colwidth)}`);
});

defineCase('parseDOM defaults a bare cell to colspan/rowspan 1', () => {
  const got = cellGetAttrs('table_header')(fakeCellDom({}));
  assert(got.colspan === 1 && got.rowspan === 1, `bare cell should be 1x1, got ${got.colspan}x${got.rowspan}`);
  assert(got.colwidth === null, `bare cell should have no colwidth, got ${JSON.stringify(got.colwidth)}`);
  assert(got.align === null, `bare cell should have no align, got ${got.align}`);
});

defineCase('toDOM omits every default — ordinary cells gain no attributes', () => {
  // Copy/paste and the collab DOM both go through toDOM. An ordinary markdown
  // cell must serialize as a bare <td>, exactly as it did before this change.
  const { table } = firstTable(parse(PLAIN));
  const cell = table.child(1).child(0);
  const spec = cell.type.spec.toDOM;
  assert(typeof spec === 'function', 'table_cell has no toDOM');
  const [tag, attrs] = spec(cell) as [string, Record<string, string>];
  assert(tag === 'td', `expected td, got ${tag}`);
  assert(
    Object.keys(attrs).length === 0,
    `ordinary cell should emit no attributes, got ${JSON.stringify(attrs)}`,
  );
});

defineCase('toDOM emits non-default spans and widths', () => {
  const cell = schema.nodes.table_cell.create({ colspan: 2, rowspan: 3, colwidth: [100, 200] });
  const spec = cell.type.spec.toDOM;
  assert(typeof spec === 'function', 'table_cell has no toDOM');
  const [, attrs] = spec(cell) as [string, Record<string, string>];
  assert(attrs.colspan === '2', `colspan should be "2", got ${attrs.colspan}`);
  assert(attrs.rowspan === '3', `rowspan should be "3", got ${attrs.rowspan}`);
  assert(attrs['data-colwidth'] === '100,200', `data-colwidth should be "100,200", got ${attrs['data-colwidth']}`);
});

// ---------------------------------------------------------------------------
// 5. Attribute validation — these arrive over collab as untrusted JSON
// ---------------------------------------------------------------------------

// prosemirror-model runs attr validators from `Node.fromJSON` and `check()`,
// not from `create()` — which is the path that matters: JSON is what arrives
// off the collab wire and out of a stored snapshot.

function cellFromJSON(attrs: Record<string, unknown>): void {
  Node.fromJSON(schema, { type: 'table_cell', attrs });
}

defineCase('colwidth validation rejects non-numeric arrays from JSON', () => {
  let threw = false;
  try {
    cellFromJSON({ colwidth: ['wide'] });
  } catch {
    threw = true;
  }
  assert(threw, 'a non-numeric colwidth should be rejected by the attr validator');
});

defineCase('colspan validation rejects non-numbers from JSON', () => {
  let threw = false;
  try {
    cellFromJSON({ colspan: '2' });
  } catch {
    threw = true;
  }
  assert(threw, 'a string colspan should be rejected by the attr validator');
});

defineCase('a well-formed cell still round-trips through JSON', () => {
  cellFromJSON({ colspan: 2, rowspan: 1, colwidth: [100, 200], align: 'center' });
  // A doc persisted before this change has no cell attrs at all; defaults must
  // fill them rather than the node failing to load.
  const legacy = Node.fromJSON(schema, { type: 'table_cell', attrs: { align: null } });
  assert(legacy.attrs.colspan === 1, `legacy cell should default colspan to 1, got ${legacy.attrs.colspan}`);
  assert(legacy.attrs.colwidth === null, `legacy cell should default colwidth to null, got ${legacy.attrs.colwidth}`);
});

// ---------------------------------------------------------------------------
// Runner — same shape as markdown-paste.test.ts
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
