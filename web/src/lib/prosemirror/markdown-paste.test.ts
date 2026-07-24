// Manual smoke harness for markdown-paste (attn-o7sq). `web/` has no vitest
// config yet, so — like PeerStrip.test.ts / ShareDialog.test.ts — this is a
// tsx-runnable set of contract cases over the pure paste helpers. The
// handlePaste plugin body itself needs a live EditorView + ClipboardEvent
// (exercised via Playwright against the running app); here we lock down the
// two pure decisions it delegates to: `looksLikeMarkdown` (when to override a
// rich HTML paste) and `markdownPasteSlice` (parse text → insertable slice),
// both run against the SAME markdownParser/serializer the editor loads with.
//
// Run with:
//
//   cd web && npx tsx src/lib/prosemirror/markdown-paste.test.ts

import { markdownParser, markdownSerializer } from '../schema';
import { looksLikeMarkdown, markdownPasteSlice } from './markdown-paste';

// ---------------------------------------------------------------------------
// Tiny harness (matches PeerStrip.test.ts conventions)
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
// looksLikeMarkdown — block-level detection only
// ---------------------------------------------------------------------------

defineCase('heading line reads as markdown', () => {
  assert(looksLikeMarkdown('# Title\n\nbody'), 'ATX heading should be detected');
  assert(looksLikeMarkdown('body\n### Later heading'), 'heading on a later line detected');
});

defineCase('lists / quotes / fences / tables / rules read as markdown', () => {
  assert(looksLikeMarkdown('- one\n- two'), 'bullet list');
  assert(looksLikeMarkdown('1. one\n2. two'), 'ordered list');
  assert(looksLikeMarkdown('> quoted'), 'blockquote');
  assert(looksLikeMarkdown('```ts\ncode\n```'), 'fenced code');
  assert(looksLikeMarkdown('| a | b |\n| - | - |'), 'table row');
  assert(looksLikeMarkdown('---'), 'thematic break');
});

defineCase('plain prose and inline-only markers do NOT trigger override', () => {
  assert(!looksLikeMarkdown('Just a normal sentence.'), 'plain prose is not markdown');
  assert(
    !looksLikeMarkdown('A sentence with **bold** and a [link](x).'),
    'inline-only markers are too common in prose to override rich HTML',
  );
  assert(!looksLikeMarkdown(''), 'empty string is not markdown');
});

// ---------------------------------------------------------------------------
// markdownPasteSlice — parse → slice, round-trips through the serializer
// ---------------------------------------------------------------------------

function sliceToMarkdown(text: string): string {
  const slice = markdownPasteSlice(markdownParser, text);
  assert(slice !== null, `expected a slice for: ${JSON.stringify(text)}`);
  // Wrap the slice content in a throwaway doc to serialize it back, proving the
  // pasted structure survives as real nodes (not literal syntax).
  const doc = markdownParser.schema.topNodeType.create(null, slice.content);
  return markdownSerializer.serialize(doc).trim();
}

defineCase('multi-block markdown parses to real heading + list nodes', () => {
  const md = '# Heading\n\n- a\n- b';
  const slice = markdownPasteSlice(markdownParser, md);
  assert(slice !== null, 'slice should exist');
  const doc = markdownParser.schema.topNodeType.create(null, slice.content);
  assert(doc.firstChild?.type.name === 'heading', `first block should be a heading, got ${doc.firstChild?.type.name}`);
  assert(doc.firstChild?.attrs.level === 1, 'heading level 1');
  const out = markdownSerializer.serialize(doc).trim();
  assert(out.startsWith('# Heading'), `round-trip should keep the heading, got: ${out}`);
  assert(/[-*]\s+a/.test(out) && /[-*]\s+b/.test(out), `round-trip should keep the list, got: ${out}`);
});

defineCase('single paragraph becomes an inline slice (open depth 0, flows into caret block)', () => {
  const slice = markdownPasteSlice(markdownParser, 'hello **world**');
  assert(slice !== null, 'slice should exist');
  // Inline content: the top fragment is inline text/marks, not a block node.
  assert(slice.content.firstChild?.isText === true, 'single-paragraph paste yields inline content');
  assert(slice.openStart === 0 && slice.openEnd === 0, 'inline slice has closed ends');
});

defineCase('empty / whitespace text yields no slice', () => {
  assert(markdownPasteSlice(markdownParser, '') === null, 'empty → null');
  assert(markdownPasteSlice(markdownParser, '   \n  ') === null, 'whitespace-only → null');
});

defineCase('literal markdown source round-trips cleanly (no double-escaping)', () => {
  const md = '## Notes\n\nSome text with a [link](https://example.com) and `code`.';
  const out = sliceToMarkdown(md);
  assert(out.includes('## Notes'), `heading preserved, got: ${out}`);
  assert(out.includes('[link](https://example.com)'), `link preserved, got: ${out}`);
  assert(out.includes('`code`'), `inline code preserved, got: ${out}`);
});

// ---------------------------------------------------------------------------
// Runner — same shape as PeerStrip.test.ts
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
