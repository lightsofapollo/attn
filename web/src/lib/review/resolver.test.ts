// Manual test harness for `resolver.ts` (planning issue attn-nnj.3.5).
//
// The web/ package does not configure a test runner yet (see sibling
// `popover-anchor.ts` TODO note). Run this file directly with:
//
//   cd web && npx tsx src/lib/review/resolver.test.ts
//
// Or wire it into vitest later by mapping each `defineCase` block to an `it`.
// Each case is a self-contained assertion: it builds an anchor + a context,
// calls `resolveAnchor`, and compares the verdict against an expected
// status / confidence band. Test cases mirror the Rust resolver corpus from
// issue 3.4 so verdicts stay in lockstep.

import { boundedLevenshtein, resolveAnchor, type ResolveContext } from './resolver';
import type {
  Anchor,
  AnchorBlock,
  AnchorHeading,
  AnchorHeadingRef,
  AnchorIndex,
  ContentHash,
  ResolvedAnchor,
} from '../types';

// ---------------------------------------------------------------------------
// Tiny harness
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

function expectStatus(r: ResolvedAnchor, status: ResolvedAnchor['status']): void {
  assert(r.status === status, `expected status=${status}, got ${r.status} (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

/** Deterministic stand-in for a SHA-256 hex digest. We only check equality
 * inside the resolver, so any stable function suffices for the harness. */
function fauxHash(b: Uint8Array): ContentHash {
  let h = 0xcafebabe;
  for (let i = 0; i < b.length; i++) {
    h = ((h << 5) - h + b[i]!) | 0;
  }
  return `faux:${(h >>> 0).toString(16)}`;
}

function buildIndex(opts: {
  markdown: string;
  blocks?: AnchorBlock[];
  headings?: AnchorHeading[];
}): { index: AnchorIndex; hash: ContentHash; bytes: Uint8Array } {
  const md = bytes(opts.markdown);
  const lineCount = opts.markdown.split('\n').length;
  const index: AnchorIndex = {
    docHash: fauxHash(md),
    canonicalEncoding: 'utf8-bytes',
    lineCount,
    blocks: opts.blocks ?? [],
    headings: opts.headings ?? [],
  };
  return { index, hash: index.docHash, bytes: md };
}

function ctx(markdown: string, blocks?: AnchorBlock[], headings?: AnchorHeading[]): ResolveContext {
  const built = buildIndex({ markdown, blocks, headings });
  return {
    currentIndex: built.index,
    currentMarkdownBytes: built.bytes,
    currentHash: built.hash,
  };
}

function paragraphBlock(opts: {
  markdown: string;
  text: string;
  fingerprint: string;
  headingPath?: AnchorHeadingRef[];
  ordinalInParent?: number;
  duplicateOrdinal?: number;
  snapshotBlockId?: string;
}): AnchorBlock {
  const md = opts.markdown;
  const start = md.indexOf(opts.text);
  if (start < 0) throw new Error(`text not found: ${opts.text}`);
  const end = start + opts.text.length;
  const startLine = md.slice(0, start).split('\n').length - 1;
  const endLine = md.slice(0, end).split('\n').length - 1;
  return {
    snapshotBlockId: opts.snapshotBlockId ?? `block-${start}-${end}`,
    contentFingerprint: opts.fingerprint,
    kind: 'paragraph',
    byteRange: [start, end],
    lineRange: [startLine, endLine],
    headingPath: opts.headingPath ?? [],
    ordinalInParent: opts.ordinalInParent ?? 0,
    duplicateOrdinal: opts.duplicateOrdinal ?? 0,
    textHash: `text:${opts.fingerprint}`,
    normalizedTextHash: `norm:${opts.fingerprint}`,
  };
}

function anchorWithQuote(opts: {
  baseHash: ContentHash;
  byteRange: [number, number];
  lineRange: [number, number];
  exact: string;
  normalized?: string;
}): Anchor {
  const normalized = opts.normalized ?? opts.exact.trim().toLowerCase();
  return {
    v: 2,
    fileId: 'file_test' as Anchor['fileId'],
    snapshotId: 'snap_test' as Anchor['snapshotId'],
    baseHash: opts.baseHash,
    position: {
      byteRange: opts.byteRange,
      lineRange: opts.lineRange,
    },
    quote: {
      exact: opts.exact,
      exactHash: `qh:${opts.exact.length}`,
      normalized,
      normalizedHash: `nh:${normalized.length}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

// Case 1: empty anchor unchanged doc → exact 1.00
defineCase('base_hash_match returns exact 1.00', () => {
  const md = 'Hello world.';
  const c = ctx(md);
  const a = anchorWithQuote({
    baseHash: c.currentHash,
    byteRange: [0, 5],
    lineRange: [0, 0],
    exact: 'Hello',
  });
  const r = resolveAnchor(a, c);
  expectStatus(r, 'exact');
  if (r.status !== 'exact') throw new Error('unreachable');
  assert(r.confidence === 1.0, `expected 1.0, got ${r.confidence}`);
  assert(r.reason === 'base_hash_match', `expected base_hash_match reason`);
  assert(r.currentRange.byteRange[0] === 0 && r.currentRange.byteRange[1] === 5, 'preserves byteRange');
});

// Case 2: quote unique → remapped 0.90
defineCase('unique exact quote → remapped 0.90', () => {
  const oldMd = 'Hello world.\n\nThe quick brown fox.';
  const newMd = '# Title\n\nHello world.\n\nThe quick brown fox.';
  const oldCtx = ctx(oldMd);
  const c = ctx(newMd);
  const a = anchorWithQuote({
    baseHash: oldCtx.currentHash,
    byteRange: [14, 33],
    lineRange: [2, 2],
    exact: 'The quick brown fox',
  });
  const r = resolveAnchor(a, c);
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  assert(Math.abs(r.confidence - 0.9) < 1e-9, `expected 0.90, got ${r.confidence}`);
  assert(r.reason === 'quote_match', `expected quote_match`);
  const slice = newMd.slice(r.currentRange.byteRange[0], r.currentRange.byteRange[1]);
  assert(slice === 'The quick brown fox', `quote slice mismatch: ${slice}`);
});

// Case 3: ambiguous (two equal-confidence matches via quote AND block) → ambiguous
defineCase('two strong candidates within 0.10 → ambiguous', () => {
  // Build two paragraphs with same fingerprint to get two block_fingerprint
  // hits, then add quote that matches one of them — three candidates total,
  // but the top two should be the two block hits at 0.85 each.
  const oldMd = 'Para A.\n\nPara B.';
  const newMd = 'Para A.\n\nPara B.';
  const fp = 'fp_dup';
  const blocks = [
    paragraphBlock({ markdown: newMd, text: 'Para A.', fingerprint: fp }),
    paragraphBlock({ markdown: newMd, text: 'Para B.', fingerprint: fp }),
  ];
  const c = ctx(newMd, blocks);
  const oldCtx = ctx(oldMd);
  const a: Anchor = {
    v: 2,
    fileId: 'file_test' as Anchor['fileId'],
    snapshotId: 'snap_test' as Anchor['snapshotId'],
    baseHash: oldCtx.currentHash,
    position: { byteRange: [0, 7], lineRange: [0, 0] },
    block: {
      snapshotBlockId: 'snap-block',
      contentFingerprint: fp,
      kind: 'paragraph',
      offsetInBlockBytes: [0, 7],
      blockByteRange: [0, 7],
      blockLineRange: [0, 0],
    },
  };
  // Force a hash mismatch so step 1 doesn't short-circuit.
  a.baseHash = (a.baseHash + '_x') as ContentHash;
  const r = resolveAnchor(a, c);
  expectStatus(r, 'ambiguous');
  if (r.status !== 'ambiguous') throw new Error('unreachable');
  assert(r.candidates.length === 2, `expected 2 candidates, got ${r.candidates.length}`);
});

// Case 4: stale → stale
defineCase('no quote/block/context matches → stale', () => {
  const oldMd = 'A wholly different document.';
  const newMd = 'Completely unrelated.';
  const c = ctx(newMd);
  const oldCtx = ctx(oldMd);
  const a = anchorWithQuote({
    baseHash: oldCtx.currentHash,
    byteRange: [0, 7],
    lineRange: [0, 0],
    exact: 'A wholly',
  });
  // Anchor.position.lineRange is in-range for the new doc (single line, so
  // line 0 always exists) — but we drop the line-proximity contribution by
  // pushing the line index past the new doc's lineCount so step 8 also
  // returns nothing meaningful. Simplest: clear pos.lineRange to invalid.
  a.position = { byteRange: [999, 1000], lineRange: [-1, -1] };
  const r = resolveAnchor(a, c);
  expectStatus(r, 'stale');
});

// Case 5: quote appears twice → ambiguous (or remapped if quote is the only
// signal: the unique-exact step requires uniqueness, so duplicates leave only
// fuzzy + line-proximity, which fall below 0.70).
defineCase('duplicate quote → no unique-quote candidate, falls back', () => {
  const oldMd = 'foo bar foo bar';
  const newMd = 'foo bar foo bar';
  const c = ctx(newMd);
  const oldCtx = ctx(oldMd);
  const a = anchorWithQuote({
    baseHash: oldCtx.currentHash + '_x',
    byteRange: [0, 3],
    lineRange: [0, 0],
    exact: 'foo',
  });
  const r = resolveAnchor(a, c);
  // No unique-quote (two `foo` occurrences); fuzzy step skipped because
  // floor(3/5) = 0; line-proximity ceiling = 0.35 → step 6 picks line band.
  // That's the fallback (≥ 0.35) branch → remapped at 0.35.
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  assert(r.confidence <= 0.35 + 1e-9, `expected line-proximity ceiling, got ${r.confidence}`);
});

// Case 6: block fingerprint single-hit → remapped 0.85
defineCase('block fingerprint unique → remapped 0.85', () => {
  const oldMd = 'Top.\n\nMiddle.\n\nBottom.';
  const newMd = '# H1\n\nTop.\n\nMiddle.\n\nBottom.';
  const blocks = [paragraphBlock({ markdown: newMd, text: 'Middle.', fingerprint: 'mid' })];
  const c = ctx(newMd, blocks);
  const oldCtx = ctx(oldMd);
  const a: Anchor = {
    v: 2,
    fileId: 'file_test' as Anchor['fileId'],
    snapshotId: 'snap_test' as Anchor['snapshotId'],
    baseHash: (oldCtx.currentHash + '_x') as ContentHash,
    position: { byteRange: [6, 13], lineRange: [2, 2] },
    block: {
      snapshotBlockId: 'snap-mid',
      contentFingerprint: 'mid',
      kind: 'paragraph',
      offsetInBlockBytes: [0, 7],
      blockByteRange: [6, 13],
      blockLineRange: [2, 2],
    },
  };
  const r = resolveAnchor(a, c);
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  assert(Math.abs(r.confidence - 0.85) < 1e-9, `expected 0.85, got ${r.confidence}`);
  assert(r.reason === 'block_fingerprint_match', `expected block_fingerprint_match`);
});

// Case 7: structure + quote → remapped 0.80
defineCase('structure + quote → remapped 0.80', () => {
  const oldMd = '# A\n\nfoo\n\n# B\n\nfoo';
  const newMd = '# A\n\nfoo bar\n\n# B\n\nfoo';
  const headingRefA: AnchorHeadingRef = { level: 1, textHash: 'h:A', ordinalAtLevel: 1 };
  const blocks: AnchorBlock[] = [
    paragraphBlock({
      markdown: newMd,
      text: 'foo bar',
      fingerprint: 'p-A',
      headingPath: [headingRefA],
    }),
    paragraphBlock({
      markdown: newMd,
      text: 'foo',
      fingerprint: 'p-B',
      headingPath: [{ level: 1, textHash: 'h:B', ordinalAtLevel: 2 }],
      duplicateOrdinal: 1,
    }),
  ];
  const c = ctx(newMd, blocks);
  const oldCtx = ctx(oldMd);
  const a: Anchor = {
    v: 2,
    fileId: 'file_test' as Anchor['fileId'],
    snapshotId: 'snap_test' as Anchor['snapshotId'],
    baseHash: (oldCtx.currentHash + '_x') as ContentHash,
    position: { byteRange: [6, 9], lineRange: [2, 2] },
    quote: {
      exact: 'foo',
      exactHash: 'qh',
      normalized: 'foo',
      normalizedHash: 'nh',
    },
    structure: { headingPath: [headingRefA], ordinalInParent: 0 },
  };
  const r = resolveAnchor(a, c);
  // The non-unique 'foo' quote rules out step 3. structure_quote picks up the
  // one under # A and the duplicate is filtered out by heading path.
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  // Could be 0.80 (structure_quote) — winning candidate.
  assert(r.confidence >= 0.8 - 1e-9, `expected ≥ 0.80, got ${r.confidence}`);
});

// Case 8: context match → remapped 0.70
defineCase('prefix+suffix context match → remapped 0.70', () => {
  const newMd = 'before-the-needle is in the middle after the rest';
  const c = ctx(newMd);
  const a: Anchor = {
    v: 2,
    fileId: 'file_test' as Anchor['fileId'],
    snapshotId: 'snap_test' as Anchor['snapshotId'],
    baseHash: ('faux:deadbeef' + '_x') as ContentHash,
    position: { byteRange: [11, 17], lineRange: [0, 0] },
    context: {
      prefix: 'before-the-',
      suffix: ' is in',
      prefixHash: 'p',
      suffixHash: 's',
    },
  };
  const r = resolveAnchor(a, c);
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  assert(r.reason === 'context_match', `expected context_match, got ${r.reason}`);
  assert(Math.abs(r.confidence - 0.7) < 1e-9, `expected 0.70, got ${r.confidence}`);
});

// Case 9: fuzzy quote (one edit) → remapped 0.50..0.75
defineCase('fuzzy quote, single edit → remapped within fuzzy band', () => {
  const newMd = 'The quikc brown fox jumps over the lazy dog.';
  const c = ctx(newMd);
  const a = anchorWithQuote({
    baseHash: (c.currentHash + '_x') as ContentHash,
    byteRange: [0, 19],
    lineRange: [0, 0],
    exact: 'The quick brown fox',
    normalized: 'the quick brown fox',
  });
  const r = resolveAnchor(a, c);
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  // 19-char quote, max distance = floor(19/5) = 3. One edit ⇒ distance 1.
  // ratio = 1 - 1/3 ≈ 0.666; conf = 0.5 + 0.25 * 0.666 ≈ 0.667.
  assert(r.confidence >= 0.5 - 1e-9 && r.confidence <= 0.75 + 1e-9, `fuzzy band, got ${r.confidence}`);
  assert(r.reason === 'fuzzy_quote_match', `expected fuzzy_quote_match`);
});

// Case 10: line proximity only → remapped ≤ 0.35
defineCase('only line proximity available → remapped ≤ 0.35', () => {
  const newMd = 'line0\nline1\nline2\nline3\n';
  const c = ctx(newMd);
  const a: Anchor = {
    v: 2,
    fileId: 'file_test' as Anchor['fileId'],
    snapshotId: 'snap_test' as Anchor['snapshotId'],
    baseHash: (c.currentHash + '_x') as ContentHash,
    position: { byteRange: [12, 17], lineRange: [2, 2] },
  };
  const r = resolveAnchor(a, c);
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  assert(r.confidence <= 0.35 + 1e-9, `expected ≤ 0.35, got ${r.confidence}`);
});

// Case 11: multi-byte (utf-8) quote uniqueness still works
defineCase('multi-byte utf-8 unique quote → remapped 0.90', () => {
  const newMd = 'before\nGreetings 你好世界 friends\nafter';
  const c = ctx(newMd);
  const a = anchorWithQuote({
    baseHash: (c.currentHash + '_x') as ContentHash,
    byteRange: [0, 0], // not used
    lineRange: [1, 1],
    exact: '你好世界',
  });
  const r = resolveAnchor(a, c);
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  assert(r.reason === 'quote_match', `expected quote_match`);
  assert(Math.abs(r.confidence - 0.9) < 1e-9, `expected 0.90, got ${r.confidence}`);
  const slice = new TextDecoder().decode(
    c.currentMarkdownBytes.subarray(r.currentRange.byteRange[0], r.currentRange.byteRange[1]),
  );
  assert(slice === '你好世界', `expected 你好世界, got ${slice}`);
});

// Case 12: dedup by currentRange (quote + context land on same range)
defineCase('quote and context resolve to same range → single winner', () => {
  const newMd = 'before XYZ after';
  const c = ctx(newMd);
  const a: Anchor = {
    v: 2,
    fileId: 'file_test' as Anchor['fileId'],
    snapshotId: 'snap_test' as Anchor['snapshotId'],
    baseHash: (c.currentHash + '_x') as ContentHash,
    position: { byteRange: [7, 10], lineRange: [0, 0] },
    quote: {
      exact: 'XYZ',
      exactHash: 'q',
      normalized: 'xyz',
      normalizedHash: 'n',
    },
    context: {
      prefix: 'before ',
      suffix: ' after',
      prefixHash: 'p',
      suffixHash: 's',
    },
  };
  const r = resolveAnchor(a, c);
  expectStatus(r, 'remapped');
  if (r.status !== 'remapped') throw new Error('unreachable');
  // Quote (0.90) wins after dedup; should not become ambiguous since the
  // duplicate range collapses to a single candidate.
  assert(Math.abs(r.confidence - 0.9) < 1e-9, `expected 0.90 after dedup, got ${r.confidence}`);
});

// Case 13: bounded Levenshtein sanity (helper)
defineCase('boundedLevenshtein basic distances', () => {
  assert(boundedLevenshtein('abc', 'abc', 0) === 0, 'identity');
  assert(boundedLevenshtein('kitten', 'sitting', 3) === 3, 'classic 3');
  assert(boundedLevenshtein('kitten', 'sitting', 2) === null, 'over cap returns null');
  assert(boundedLevenshtein('', '', 0) === 0, 'empty-empty');
  assert(boundedLevenshtein('abc', '', 3) === 3, 'all delete');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function run(): number {
  let pass = 0;
  let fail = 0;
  for (const fn of cases) {
    const res = fn();
    const tag = res.ok ? 'PASS' : 'FAIL';
    const detail = res.detail ? ` — ${res.detail}` : '';
    // eslint-disable-next-line no-console
    console.log(`${tag}  ${res.name}${detail}`);
    if (res.ok) pass++;
    else fail++;
  }
  // eslint-disable-next-line no-console
  console.log(`\n${pass}/${pass + fail} passed`);
  return fail === 0 ? 0 : 1;
}

// Run when invoked as a script. `import.meta.main` isn't a thing in tsx;
// instead, check that this module is the entry by URL. We dodge depending
// on @types/node by reading `globalThis.process` through a narrow shape.
interface NodeProcessShape {
  argv?: string[];
  exit?: (code: number) => void;
}

const nodeProcess: NodeProcessShape | undefined = (
  globalThis as unknown as { process?: NodeProcessShape }
).process;

const isMain =
  nodeProcess !== undefined &&
  Array.isArray(nodeProcess.argv) &&
  nodeProcess.argv[1] !== undefined &&
  nodeProcess.argv[1].endsWith('resolver.test.ts');

if (isMain) {
  const code = run();
  nodeProcess?.exit?.(code);
}

export { run as runResolverTests };
