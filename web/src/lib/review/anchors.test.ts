// Manual test harness for `anchors.ts` (planning issue attn-nnj.3.3).
//
// The web/ package has no test runner yet (see resolver.test.ts header).
// Run with:
//
//   cd web && npx tsx src/lib/review/anchors.test.ts
//
// Each `defineCase` builds:
//   * a fake AnchorIndex (blocks + headings) modelling a small markdown doc,
//   * a stub EditorView that implements only the surface anchorFromSelection
//     reads (`state.doc.textBetween`, `state.doc.forEach`, `state.doc.content.size`,
//     `state.doc.nodeSize`),
//   * a selection range `[from, to]`,
// then asserts the resulting Anchor's layer shape.

import { anchorFromSelection, normalizeText, type ConstructAnchorContext } from './anchors';
import type {
  Anchor,
  AnchorBlock,
  AnchorBlockKind,
  AnchorHeadingRef,
  AnchorIndex,
  ContentHash,
  FileId,
  SnapshotId,
} from '../types';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

// ---------------------------------------------------------------------------
// Tiny harness (matches resolver.test.ts / store.test.ts conventions)
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
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
// EditorView stub
//
// Anchors only reads:
//   view.state.doc.textBetween(from, to, blockSep, leafSep)
//   view.state.doc.forEach((child) => …)  // top-level children
//   view.state.doc.content.size
// Each child needs `nodeSize`. We model a doc as a list of `Block` records;
// `textBetween` slices into the synthesised plaintext "doc text" while
// `forEach` walks the blocks with the pmStart/pmEnd math the production
// code relies on (pmPos increments by nodeSize per child).
// ---------------------------------------------------------------------------

interface Block {
  /** Block text — what `textBetween` returns over this block's interior. */
  text: string;
  /** Block-break string emitted between this block and the next (one "\n"
   * per block break in a real PM doc; we model the canonical case where
   * top-level blocks are separated by one newline in the textBetween view). */
  trailingBlockSep?: '\n' | '';
}

interface StubDocInternals {
  blocks: Block[];
}

interface BuiltStub {
  view: EditorView;
  index: AnchorIndex;
  internals: StubDocInternals;
  /** Maps each block index → its pmStart in the synthesised PM doc. */
  blockPmStarts: number[];
  /** Maps each block index → its pmEnd in the synthesised PM doc. */
  blockPmEnds: number[];
}

/**
 * Build the synthesised concatenated text the way PM's textBetween would
 * emit it: block contents joined by blockSep ("\n" by default in our stub).
 */
function joinBlocks(blocks: Block[], blockSep: string): string {
  let out = '';
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) out += blockSep;
    out += blocks[i]!.text;
  }
  return out;
}

/**
 * Build a stub EditorView + matching AnchorIndex.
 *
 * For each block we synthesise:
 *   - pmStart / pmEnd via `nodeSize = block.text.length + 2` (the +2 mimics
 *     the PM convention of one boundary token at each end of a block).
 *   - byteRange / lineRange in the markdown source, derived from utf-8
 *     byte offsets in `joinBlocks(...)` plus newline counts.
 */
function buildStub(opts: {
  blocks: Array<{
    text: string;
    kind: AnchorBlockKind;
    fingerprint?: string;
    headingPath?: AnchorHeadingRef[];
    ordinalInParent?: number;
    snapshotBlockId?: string;
    textHash?: string;
  }>;
}): BuiltStub {
  const blocks: Block[] = opts.blocks.map((b) => ({ text: b.text }));
  const docText = joinBlocks(blocks, '\n');

  // PM-position bookkeeping. nodeSize for a leaf-bearing block is
  // `text.length + 2` (one open + one close token). textBetween reads the
  // inner text only, so block[i].pmStart is "before-open", inner runs from
  // pmStart+1 to pmEnd-1.
  const blockPmStarts: number[] = [];
  const blockPmEnds: number[] = [];
  let pmPos = 0;
  for (const b of blocks) {
    const nodeSize = b.text.length + 2;
    blockPmStarts.push(pmPos);
    blockPmEnds.push(pmPos + nodeSize);
    pmPos += nodeSize;
  }
  const docSize = pmPos;

  // Byte ranges via utf-8 encoding of the textual representation.
  const enc = new TextEncoder();
  let cursorBytes = 0;
  let cursorLine = 0;
  const indexBlocks: AnchorBlock[] = [];
  for (let i = 0; i < opts.blocks.length; i++) {
    const b = opts.blocks[i]!;
    const startBytes = cursorBytes;
    const blockBytes = enc.encode(b.text).length;
    const startLine = cursorLine;
    const inlineNewlines = (b.text.match(/\n/g) ?? []).length;
    const endLine = startLine + inlineNewlines;
    indexBlocks.push({
      snapshotBlockId: b.snapshotBlockId ?? `block-${i}`,
      contentFingerprint: b.fingerprint ?? `fp-${i}`,
      kind: b.kind,
      byteRange: [startBytes, startBytes + blockBytes],
      lineRange: [startLine, endLine],
      headingPath: b.headingPath ?? [],
      ordinalInParent: b.ordinalInParent ?? i,
      duplicateOrdinal: 0,
      textHash: b.textHash ?? `text-hash-${i}`,
      normalizedTextHash: `norm-${i}`,
    });
    cursorBytes += blockBytes;
    cursorLine = endLine;
    if (i < opts.blocks.length - 1) {
      cursorBytes += 1; // block separator "\n"
      cursorLine += 1;
    }
  }
  const totalBytes = cursorBytes;

  const index: AnchorIndex = {
    docHash: 'faux:doc-hash' as ContentHash,
    canonicalEncoding: 'utf8-bytes',
    lineCount: cursorLine + 1,
    blocks: indexBlocks,
    headings: [],
  };

  // ---- Stub PMNode ----
  // We only need the subset anchors.ts touches: forEach yields top-level
  // children with a `nodeSize` field, plus a `content.size` on the doc and
  // a `textBetween(from, to, blockSep, leafSep)` method.

  function textBetween(from: number, to: number, blockSep: string, _leafSep: string): string {
    // Walk blocks, accumulate the slice of any block-text overlapping
    // [from, to] in PM coords. For block i the inner-text range is
    // [blockPmStarts[i]+1, blockPmEnds[i]-1] mapping to characters
    // [0..text.length] of block.text. Block separators of length 0 in PM
    // coords (PM has no token between top-level blocks) get rendered as
    // `blockSep` in the output whenever the range spans the gap.
    let out = '';
    let firstHit = true;
    for (let i = 0; i < blocks.length; i++) {
      const innerStart = blockPmStarts[i]! + 1;
      const innerEnd = blockPmEnds[i]! - 1;
      const sliceStart = Math.max(from, innerStart);
      const sliceEnd = Math.min(to, innerEnd);
      if (sliceStart < sliceEnd) {
        if (!firstHit) out += blockSep;
        firstHit = false;
        const localFrom = sliceStart - innerStart;
        const localTo = sliceEnd - innerStart;
        out += blocks[i]!.text.slice(localFrom, localTo);
      } else if (!firstHit) {
        // We already emitted at least one block — if `to` lies past this
        // block's start we still want to be ready to emit a separator on
        // the next hit. Nothing to add here.
      }
    }
    return out;
  }

  const stubChildren = blocks.map((b) => ({
    nodeSize: b.text.length + 2,
  })) as unknown as PMNode[];

  const stubDoc = {
    content: { size: docSize },
    nodeSize: docSize + 2,
    textBetween,
    forEach: (cb: (child: PMNode, offset: number, index: number) => void) => {
      let off = 0;
      for (let i = 0; i < stubChildren.length; i++) {
        cb(stubChildren[i]!, off, i);
        off += (stubChildren[i] as unknown as { nodeSize: number }).nodeSize;
      }
    },
  } as unknown as PMNode;

  const view = {
    state: {
      doc: stubDoc,
    },
  } as unknown as EditorView;

  // Sanity: build a doc text that matches the index byte total so tests can
  // map index byteRange back into the synth text deterministically.
  const observedBytes = new TextEncoder().encode(docText).length;
  if (observedBytes !== totalBytes) {
    throw new Error(`docText bytes (${observedBytes}) != index totalBytes (${totalBytes})`);
  }

  return {
    view,
    index,
    internals: { blocks },
    blockPmStarts,
    blockPmEnds,
  };
}

function ctx(index: AnchorIndex): ConstructAnchorContext {
  return {
    index,
    fileId: 'file_test' as FileId,
    snapshotId: 'snap_test' as SnapshotId,
    baseHash: index.docHash,
  };
}

function expectLayers(a: Anchor, want: Array<keyof Anchor>): void {
  for (const k of want) {
    assert(a[k] !== undefined, `expected anchor.${String(k)} to be present`);
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

defineCase('single-word selection → 5-layer anchor', () => {
  const stub = buildStub({
    blocks: [
      { text: 'Hello world here', kind: 'paragraph' },
      { text: 'second block', kind: 'paragraph' },
    ],
  });
  // Inner text of block 0 starts at pmStart+1. "Hello" runs 0..5 in text →
  // PM positions [pmStart+1, pmStart+6].
  const pm0 = stub.blockPmStarts[0]!;
  const a = anchorFromSelection(stub.view, pm0 + 1, pm0 + 6, ctx(stub.index));

  expectLayers(a, ['position', 'quote', 'block', 'context', 'structure']);
  assert(a.quote?.exact === 'Hello', `quote.exact=${a.quote?.exact}`);
  assert(a.quote?.normalized === 'hello', `quote.normalized=${a.quote?.normalized}`);
  assert(a.block?.kind === 'paragraph', `block.kind=${a.block?.kind}`);
  assert(a.position.byteRange[0] === 0, `position.byteRange[0]=${a.position.byteRange[0]}`);
  assert(a.position.byteRange[1] === 5, `position.byteRange[1]=${a.position.byteRange[1]}`);
  assert((a.context?.suffix.length ?? 0) > 0, 'context.suffix should contain trailing text');
  assert(a.context?.prefix === '', `prefix at doc start should be empty, got: ${a.context?.prefix}`);
  // Next block hash should be the second block's textHash.
  assert(
    a.context?.nextBlockHash === stub.index.blocks[1]?.textHash,
    `nextBlockHash=${a.context?.nextBlockHash}`,
  );
  assert(a.context?.previousBlockHash === undefined, 'previousBlockHash should be undefined at doc start');
});

defineCase('multi-line selection → quote captures both lines', () => {
  // Two adjacent paragraphs; selection spans the end of block 0 + start of
  // block 1, so quote.exact must contain a newline (the block separator).
  const stub = buildStub({
    blocks: [
      { text: 'line one alpha', kind: 'paragraph' },
      { text: 'line two beta', kind: 'paragraph' },
    ],
  });
  const pm0 = stub.blockPmStarts[0]!;
  const pm1 = stub.blockPmStarts[1]!;
  // "alpha" → block 0 chars [9..14] → PM [pm0+10..pm0+15]
  // "line two" → block 1 chars [0..8] → PM [pm1+1..pm1+9]
  const a = anchorFromSelection(stub.view, pm0 + 10, pm1 + 9, ctx(stub.index));

  assert(a.quote !== undefined, 'quote should exist');
  assert(a.quote!.exact.includes('alpha'), `quote should include "alpha": ${a.quote!.exact}`);
  assert(a.quote!.exact.includes('line two'), `quote should include "line two": ${a.quote!.exact}`);
  assert(a.quote!.exact.includes('\n'), `quote should span a newline: ${JSON.stringify(a.quote!.exact)}`);
});

defineCase('selection at doc start → context.prefix empty', () => {
  const stub = buildStub({
    blocks: [{ text: 'abc xyz', kind: 'paragraph' }],
  });
  const pm0 = stub.blockPmStarts[0]!;
  const a = anchorFromSelection(stub.view, pm0 + 1, pm0 + 4, ctx(stub.index));
  assert(a.context?.prefix === '', `prefix=${JSON.stringify(a.context?.prefix)}`);
  assert(a.quote?.exact === 'abc', `quote.exact=${a.quote?.exact}`);
});

defineCase('selection at doc end → context.suffix empty', () => {
  const stub = buildStub({
    blocks: [{ text: 'abc xyz', kind: 'paragraph' }],
  });
  const pm0 = stub.blockPmStarts[0]!;
  // "xyz" is at text chars [4..7]
  const a = anchorFromSelection(stub.view, pm0 + 5, pm0 + 8, ctx(stub.index));
  assert(a.quote?.exact === 'xyz', `quote.exact=${a.quote?.exact}`);
  assert(a.context?.suffix === '', `suffix=${JSON.stringify(a.context?.suffix)}`);
  assert((a.context?.prefix.length ?? 0) > 0, `prefix should not be empty: ${JSON.stringify(a.context?.prefix)}`);
});

defineCase('block-level cursor (from === to) omits quote, covers full block', () => {
  const stub = buildStub({
    blocks: [{ text: 'paragraph one', kind: 'paragraph' }, { text: 'paragraph two', kind: 'paragraph' }],
  });
  const pm1 = stub.blockPmStarts[1]!;
  const a = anchorFromSelection(stub.view, pm1 + 1, pm1 + 1, ctx(stub.index));
  assert(a.quote === undefined, 'block-level cursor must omit quote');
  // Position should cover the whole second block.
  const blk = stub.index.blocks[1]!;
  assert(
    a.position.byteRange[0] === blk.byteRange[0] && a.position.byteRange[1] === blk.byteRange[1],
    `position.byteRange should equal block byteRange, got ${JSON.stringify(a.position.byteRange)} vs ${JSON.stringify(blk.byteRange)}`,
  );
  // Block layer: offsetInBlockBytes spans the full block.
  const blockLen = blk.byteRange[1] - blk.byteRange[0];
  assert(
    a.block?.offsetInBlockBytes[0] === 0 && a.block?.offsetInBlockBytes[1] === blockLen,
    `block.offsetInBlockBytes should be [0, ${blockLen}], got ${JSON.stringify(a.block?.offsetInBlockBytes)}`,
  );
});

defineCase('selection inside code_block → block.kind=code_block', () => {
  const stub = buildStub({
    blocks: [
      { text: 'normal text', kind: 'paragraph' },
      { text: 'console.log(x)', kind: 'code_block' },
    ],
  });
  const pm1 = stub.blockPmStarts[1]!;
  const a = anchorFromSelection(stub.view, pm1 + 1, pm1 + 8, ctx(stub.index));
  assert(a.block?.kind === 'code_block', `expected code_block, got ${a.block?.kind}`);
  assert(a.quote?.exact === 'console', `quote.exact=${a.quote?.exact}`);
});

defineCase('selection inside list_item → block.kind=list_item', () => {
  const stub = buildStub({
    blocks: [
      { text: 'preamble', kind: 'paragraph' },
      { text: 'first item content', kind: 'list_item' },
    ],
  });
  const pm1 = stub.blockPmStarts[1]!;
  const a = anchorFromSelection(stub.view, pm1 + 1, pm1 + 6, ctx(stub.index));
  assert(a.block?.kind === 'list_item', `expected list_item, got ${a.block?.kind}`);
  assert(a.quote?.exact === 'first', `quote.exact=${a.quote?.exact}`);
});

defineCase('unicode (emoji + accent) selection preserves bytes', () => {
  const stub = buildStub({
    blocks: [{ text: 'café 🚀 done', kind: 'paragraph' }],
  });
  const pm0 = stub.blockPmStarts[0]!;
  // text JS length: "café 🚀 done" — code units. 'c'=1,'a'=1,'f'=1,'é'=1,' '=1,'🚀'=2 (surrogate pair),' '=1,'d'=1,'o'=1,'n'=1,'e'=1.
  // We want to select "café 🚀": chars (JS code units) 0..7.
  const a = anchorFromSelection(stub.view, pm0 + 1, pm0 + 8, ctx(stub.index));
  assert(a.quote?.exact === 'café 🚀', `quote.exact=${JSON.stringify(a.quote?.exact)}`);
  // Byte length of 'café 🚀' in UTF-8 = 4 (c,a,f) + 2 (é) + 1 (space) + 4 (🚀) = 11.
  const enc = new TextEncoder();
  const expectedBytes = enc.encode('café 🚀').length;
  const gotBytes = a.position.byteRange[1] - a.position.byteRange[0];
  assert(gotBytes === expectedBytes, `bytes ${gotBytes} != expected ${expectedBytes}`);
});

defineCase('structure layer carries headingPath from matched block', () => {
  const headingRef: AnchorHeadingRef = { level: 1, textHash: 'h:A', ordinalAtLevel: 1 };
  const stub = buildStub({
    blocks: [
      { text: '# A', kind: 'heading' },
      { text: 'under A', kind: 'paragraph', headingPath: [headingRef], ordinalInParent: 2 },
    ],
  });
  const pm1 = stub.blockPmStarts[1]!;
  const a = anchorFromSelection(stub.view, pm1 + 1, pm1 + 6, ctx(stub.index));
  assert(a.structure !== undefined, 'structure layer required');
  assert(a.structure!.headingPath.length === 1, `headingPath len=${a.structure!.headingPath.length}`);
  const got = a.structure!.headingPath[0]!;
  assert(got.level === 1 && got.textHash === 'h:A' && got.ordinalAtLevel === 1, 'headingPath mismatch');
  assert(a.structure!.ordinalInParent === 2, `ordinalInParent=${a.structure!.ordinalInParent}`);
});

defineCase('quote longer than 256 chars is truncated', () => {
  const longText = 'x'.repeat(400);
  const stub = buildStub({ blocks: [{ text: longText, kind: 'paragraph' }] });
  const pm0 = stub.blockPmStarts[0]!;
  const a = anchorFromSelection(stub.view, pm0 + 1, pm0 + 1 + 400, ctx(stub.index));
  assert(a.quote !== undefined, 'quote should exist');
  assert(a.quote!.exact.length === 256, `expected 256, got ${a.quote!.exact.length}`);
});

defineCase('normalizeText matches Rust rule (case/whitespace/punct)', () => {
  assert(normalizeText('Hello, World!') === 'hello world', `got ${normalizeText('Hello, World!')}`);
  assert(normalizeText('  Many\t  spaces\n') === 'many spaces', `got ${normalizeText('  Many\t  spaces\n')}`);
  assert(normalizeText('') === '', 'empty stays empty');
  assert(normalizeText('foo,bar') === 'foo bar', `got ${normalizeText('foo,bar')}`);
});

defineCase('context prefix/suffix are bounded to 160 chars', () => {
  const pre = 'A'.repeat(300);
  const post = 'B'.repeat(300);
  const stub = buildStub({
    blocks: [{ text: pre + 'TARGET' + post, kind: 'paragraph' }],
  });
  const pm0 = stub.blockPmStarts[0]!;
  const targetStart = pm0 + 1 + pre.length;
  const targetEnd = targetStart + 'TARGET'.length;
  const a = anchorFromSelection(stub.view, targetStart, targetEnd, ctx(stub.index));
  assert(a.context !== undefined, 'context required');
  assert(a.context!.prefix.length === 160, `prefix len=${a.context!.prefix.length}`);
  assert(a.context!.suffix.length === 160, `suffix len=${a.context!.suffix.length}`);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
for (const run of cases) {
  const r = run();
  if (r.ok) {
    passed += 1;
    console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);

interface NodeProcessShape {
  exit?: (code: number) => void;
}
const nodeProcess: NodeProcessShape | undefined = (
  globalThis as unknown as { process?: NodeProcessShape }
).process;
if (failed > 0) nodeProcess?.exit?.(1);
