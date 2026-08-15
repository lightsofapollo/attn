// Manual test harness for `doc-protocol.ts` (attn-61t / attn-lon).
//
//   cd web && npx tsx src/lib/review/doc-protocol.test.ts
//
// `parseDocMessage` is the shell's trust boundary: every one of these payloads
// arrives from a document frame that shares a JavaScript context with untrusted
// page scripts (planning/collab/amendments.md #20). The cases below are written
// from the attacker's side — malformed shapes, oversized fields, inverted
// ranges, unbounded arrays — because a validator is only worth what it rejects.

import { DOC_PROTOCOL_VERSION, parseDocMessage } from './doc-protocol';

// ---------------------------------------------------------------------------
// Tiny harness (matches resolver.test.ts / anchors.test.ts conventions)
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
// Fixtures
// ---------------------------------------------------------------------------

const v = DOC_PROTOCOL_VERSION;

function rect(x = 1, y = 2, width = 3, height = 4) {
  return { x, y, width, height };
}

function htmlAnchor(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    target: 'text_range',
    cssSelector: 'p:nth-of-type(2)',
    fallbackSelectors: ['body > p:nth-of-type(2)'],
    textPosition: { start: 10, end: 42 },
    context: {
      tagName: 'p',
      role: 'paragraph',
      scopePreview: 'second paragraph',
      domPath: ['section', 'p'],
    },
    ...overrides,
  };
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    html: htmlAnchor(),
    quote: 'the quick brown fox',
    prefix: 'before ',
    suffix: ' after',
    textStart: 10,
    textEnd: 42,
    ...overrides,
  };
}

function selectionMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'selection',
    v,
    proposal: proposal(),
    rects: [rect()],
    caret: rect(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

defineCase('accepts a well-formed selection', () => {
  const parsed = parseDocMessage(selectionMessage());
  assert(parsed !== null, 'expected the message to parse');
  assert(parsed.type === 'selection', `expected selection, got ${parsed.type}`);
  assert(parsed.proposal.html.cssSelector === 'p:nth-of-type(2)', 'selector lost');
  assert(parsed.proposal.html.context.tagName === 'p', 'context lost');
});

defineCase('accepts an element proposal via scopePicked', () => {
  const parsed = parseDocMessage({
    type: 'scopePicked',
    v,
    proposal: proposal({ html: htmlAnchor({ target: 'element' }) }),
    rects: [rect()],
  });
  assert(parsed !== null && parsed.type === 'scopePicked', 'expected scopePicked');
  assert(parsed.proposal.html.target === 'element', 'target lost');
});

defineCase('accepts anchorsResolved with every status', () => {
  for (const status of ['exact', 'remapped', 'ambiguous', 'stale']) {
    const parsed = parseDocMessage({
      type: 'anchorsResolved',
      v,
      results: [{ anchorId: 'a1', status, rects: [rect()] }],
    });
    assert(parsed !== null, `status ${status} should parse`);
  }
});

defineCase('drops optional fields cleanly when absent', () => {
  const parsed = parseDocMessage(
    selectionMessage({
      proposal: proposal({
        html: {
          v: 1,
          target: 'text_range',
          cssSelector: 'p',
          context: { tagName: 'p', scopePreview: 'para' },
        },
      }),
    }),
  );
  assert(parsed !== null && parsed.type === 'selection', 'expected selection');
  assert(parsed.proposal.html.fallbackSelectors === undefined, 'fallbacks should be absent');
  assert(parsed.proposal.html.context.role === undefined, 'role should be absent');
});

// ---------------------------------------------------------------------------
// Rejection — protocol framing
// ---------------------------------------------------------------------------

defineCase('rejects a mismatched protocol version', () => {
  assert(parseDocMessage(selectionMessage({ v: v + 1 })) === null, 'newer version accepted');
  assert(parseDocMessage(selectionMessage({ v: undefined })) === null, 'missing version accepted');
});

defineCase('rejects unknown message types (forward-compat drop)', () => {
  assert(parseDocMessage({ type: 'createComment', v }) === null, 'unknown type accepted');
});

defineCase('rejects non-objects', () => {
  for (const junk of [null, undefined, 'selection', 42, []]) {
    assert(parseDocMessage(junk) === null, `accepted ${String(junk)}`);
  }
});

// ---------------------------------------------------------------------------
// Rejection — the frame is hostile
// ---------------------------------------------------------------------------

defineCase('rejects an oversized css selector', () => {
  const parsed = parseDocMessage(
    selectionMessage({ proposal: proposal({ html: htmlAnchor({ cssSelector: 'a'.repeat(1025) }) }) }),
  );
  assert(parsed === null, 'oversized selector accepted');
});

defineCase('rejects an empty css selector', () => {
  const parsed = parseDocMessage(
    selectionMessage({ proposal: proposal({ html: htmlAnchor({ cssSelector: '   ' }) }) }),
  );
  assert(parsed === null, 'blank selector accepted');
});

defineCase('rejects too many fallback selectors', () => {
  const parsed = parseDocMessage(
    selectionMessage({
      proposal: proposal({ html: htmlAnchor({ fallbackSelectors: new Array(9).fill('p') }) }),
    }),
  );
  assert(parsed === null, 'unbounded fallbacks accepted');
});

defineCase('rejects an oversized quote', () => {
  const parsed = parseDocMessage(
    selectionMessage({ proposal: proposal({ quote: 'x'.repeat(4097) }) }),
  );
  assert(parsed === null, 'oversized quote accepted');
});

defineCase('rejects an oversized dom path', () => {
  const parsed = parseDocMessage(
    selectionMessage({
      proposal: proposal({
        html: htmlAnchor({
          context: { tagName: 'p', scopePreview: 'p', domPath: new Array(33).fill('div') },
        }),
      }),
    }),
  );
  assert(parsed === null, 'unbounded domPath accepted');
});

defineCase('rejects an inverted text position', () => {
  const parsed = parseDocMessage(
    selectionMessage({
      proposal: proposal({ html: htmlAnchor({ textPosition: { start: 99, end: 10 } }) }),
    }),
  );
  assert(parsed === null, 'inverted textPosition accepted');
});

defineCase('rejects an inverted proposal range', () => {
  const parsed = parseDocMessage(
    selectionMessage({ proposal: proposal({ textStart: 99, textEnd: 10 }) }),
  );
  assert(parsed === null, 'inverted proposal range accepted');
});

defineCase('rejects non-finite geometry', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const parsed = parseDocMessage(selectionMessage({ caret: rect(bad) }));
    assert(parsed === null, `accepted ${String(bad)} in a rect`);
  }
});

defineCase('rejects an unbounded rect list', () => {
  const parsed = parseDocMessage(selectionMessage({ rects: new Array(257).fill(rect()) }));
  assert(parsed === null, 'unbounded rects accepted');
});

defineCase('rejects an unbounded scope chain', () => {
  const parsed = parseDocMessage({
    type: 'scopeHover',
    v,
    chain: new Array(17).fill({
      scopeId: 's',
      title: 't',
      preview: null,
      selector: 'p',
      commentCount: 0,
      rects: [],
    }),
  });
  assert(parsed === null, 'unbounded scope chain accepted');
});

defineCase('rejects an unbounded resolution list', () => {
  const parsed = parseDocMessage({
    type: 'anchorsResolved',
    v,
    results: new Array(513).fill({ anchorId: 'a', status: 'exact', rects: [] }),
  });
  assert(parsed === null, 'unbounded results accepted');
});

defineCase('rejects an unknown resolution status', () => {
  const parsed = parseDocMessage({
    type: 'anchorsResolved',
    v,
    results: [{ anchorId: 'a1', status: 'totally-fine', rects: [] }],
  });
  assert(parsed === null, 'bogus status accepted');
});

defineCase('rejects out-of-range confidence', () => {
  for (const confidence of [-0.1, 1.1]) {
    const parsed = parseDocMessage({
      type: 'anchorsResolved',
      v,
      results: [{ anchorId: 'a1', status: 'exact', rects: [], confidence }],
    });
    assert(parsed === null, `accepted confidence ${confidence}`);
  }
});

defineCase('rejects a bad html anchor version', () => {
  const parsed = parseDocMessage(
    selectionMessage({ proposal: proposal({ html: htmlAnchor({ v: 2 }) }) }),
  );
  assert(parsed === null, 'unknown anchor version accepted');
});

defineCase('rejects an unknown anchor target', () => {
  const parsed = parseDocMessage(
    selectionMessage({ proposal: proposal({ html: htmlAnchor({ target: 'whole_document' }) }) }),
  );
  assert(parsed === null, 'unknown target accepted');
});

defineCase('rejects a missing context block', () => {
  const parsed = parseDocMessage(
    selectionMessage({ proposal: proposal({ html: htmlAnchor({ context: undefined }) }) }),
  );
  assert(parsed === null, 'missing context accepted');
});

defineCase('counts bytes, not code units, for size limits', () => {
  // 512 astral-plane characters is 512 code points but 2048 UTF-8 bytes, so a
  // naive `.length` check would let this through the 1024-byte selector bound.
  const parsed = parseDocMessage(
    selectionMessage({ proposal: proposal({ html: htmlAnchor({ cssSelector: '𝄞'.repeat(512) }) }) }),
  );
  assert(parsed === null, 'multi-byte payload slipped past the byte bound');
});

defineCase('accepts an anchorHover for a committed anchor', () => {
  const parsed = parseDocMessage({
    type: 'anchorHover',
    v: DOC_PROTOCOL_VERSION,
    anchorId: 'thread-42',
  });
  assert(parsed !== null, 'anchorHover was rejected');
  assert(parsed.type === 'anchorHover', `expected anchorHover, got ${parsed.type}`);
  assert(parsed.anchorId === 'thread-42', 'anchorId did not survive parsing');
});

defineCase('accepts a null anchorHover — the pointer left every anchor', () => {
  const parsed = parseDocMessage({ type: 'anchorHover', v: DOC_PROTOCOL_VERSION, anchorId: null });
  assert(parsed !== null, 'null anchorHover was rejected');
  assert(parsed.type === 'anchorHover' && parsed.anchorId === null, 'null did not survive');
});

defineCase('rejects an oversized anchorHover id', () => {
  const parsed = parseDocMessage({
    type: 'anchorHover',
    v: DOC_PROTOCOL_VERSION,
    anchorId: 'x'.repeat(100_000),
  });
  assert(parsed === null, 'an unbounded anchorId slipped through');
});

defineCase('rejects a non-string, non-null anchorHover id', () => {
  const parsed = parseDocMessage({ type: 'anchorHover', v: DOC_PROTOCOL_VERSION, anchorId: 7 });
  assert(parsed === null, 'a numeric anchorId slipped through');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const results = cases.map((run) => run());
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;

for (const r of results) {
  if (r.ok) {
    console.log(`  PASS ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  } else {
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
