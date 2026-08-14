// Manual test harness for the doc-runtime's text bounds helpers (attn-61t).
//
//   cd web && npx tsx src/doc-runtime/text-bounds.test.ts
//
// Every string the runtime emits is re-validated by the shell's parser in
// UTF-8 BYTES; these helpers are what keep the producers under those caps on
// CJK/emoji documents (where character slices overrun by up to 4×) and map
// normalized-text matches back to raw offsets exactly.

import { clampText, normalizeText, normalizeTextWithMap } from './selectors';

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

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------------------
// clampText
// ---------------------------------------------------------------------------

defineCase('clampText: short ASCII passes through untouched', () => {
  assert(clampText('hello', 200, 256) === 'hello', 'must be identity under both caps');
});

defineCase('clampText: enforces the char cap on ASCII', () => {
  const out = clampText('a'.repeat(300), 200, 4096);
  assert(out.length === 200, `expected 200 chars, got ${out.length}`);
});

defineCase('clampText: enforces the BYTE cap on CJK', () => {
  // 200 CJK chars = 600 bytes — the exact shape that used to blow the
  // 256-byte scopePreview cap and get the whole message dropped.
  const out = clampText('漢'.repeat(200), 200, 256);
  assert(byteLen(out) <= 256, `byte cap violated: ${byteLen(out)}`);
  assert(out.length === 85, `expected 85 chars (255 bytes), got ${out.length}`);
});

defineCase('clampText: never splits a surrogate pair', () => {
  // Each 🙂 is 2 code units / 4 bytes. A cut that lands mid-pair would leave
  // a lone surrogate that encodes as U+FFFD and never matches the doc again.
  const out = clampText('🙂'.repeat(100), 4000, 30);
  assert(byteLen(out) <= 30, `byte cap violated: ${byteLen(out)}`);
  assert(out.length % 2 === 0, 'a split pair leaves an odd code-unit count');
  assert(!out.includes('�'), 'no replacement characters');
  assert([...out].length === 7, `expected 7 emoji (28 bytes), got ${[...out].length}`);
});

defineCase('clampText: quote cap keeps CJK quotes under the 4096-byte wire cap', () => {
  const out = clampText('漢'.repeat(4000), 4000, 4096);
  assert(byteLen(out) <= 4096, `byte cap violated: ${byteLen(out)}`);
});

// ---------------------------------------------------------------------------
// normalizeTextWithMap
// ---------------------------------------------------------------------------

const TRICKY = [
  'plain text',
  '  leading and trailing  ',
  'smart ‘quotes’ and “doubles” — with dashes – everywhere',
  'runs   of\t\twhitespace\n\nacross lines',
  '',
  '   ',
  '🙂 emoji 漢字 mixed – content',
];

defineCase('normalizeTextWithMap: normalized output matches normalizeText exactly', () => {
  for (const input of TRICKY) {
    const { normalized } = normalizeTextWithMap(input);
    assert(
      normalized === normalizeText(input),
      `divergence for ${JSON.stringify(input)}: ${JSON.stringify(normalized)}`,
    );
  }
});

defineCase('normalizeTextWithMap: one start and end per normalized char', () => {
  for (const input of TRICKY) {
    const { normalized, starts, ends } = normalizeTextWithMap(input);
    assert(starts.length === normalized.length, `starts length for ${JSON.stringify(input)}`);
    assert(ends.length === normalized.length, `ends length for ${JSON.stringify(input)}`);
    for (let i = 0; i < normalized.length; i += 1) {
      assert(starts[i] < ends[i], `empty span at ${i} for ${JSON.stringify(input)}`);
      if (i > 0) assert(starts[i] >= starts[i - 1], `starts must be monotonic at ${i}`);
    }
  }
});

defineCase('normalizeTextWithMap: maps a match through a smart-quote edit in the lead', () => {
  // The regression this map fixes: the cosmetic edit falls in the first 24
  // chars, where the old raw-text probe failed exactly when the tier should
  // succeed. "don’t" (curly) vs the recorded "don't" (straight).
  const raw = 'Header text. We don’t ship on Fridays, ever.';
  const quote = normalizeText("don't ship on Fridays");
  const { normalized, starts, ends } = normalizeTextWithMap(raw);
  const at = normalized.indexOf(quote);
  assert(at !== -1, 'normalized match must exist');
  const rawStart = starts[at];
  const rawEnd = ends[at + quote.length - 1];
  assert(
    raw.slice(rawStart, rawEnd) === 'don’t ship on Fridays',
    `mapped to ${JSON.stringify(raw.slice(rawStart, rawEnd))}`,
  );
});

defineCase('normalizeTextWithMap: end offset spans collapsed whitespace correctly', () => {
  // Applying the normalized length to raw text under-shoots across every
  // collapsed run; the map must land on the true raw end — without swallowing
  // the whitespace that follows the match.
  const raw = 'alpha    beta\n\n\tgamma delta';
  const quote = 'beta gamma';
  const { normalized, starts, ends } = normalizeTextWithMap(raw);
  const at = normalized.indexOf(quote);
  assert(at !== -1, 'normalized match must exist');
  const rawStart = starts[at];
  const rawEnd = ends[at + quote.length - 1];
  assert(
    raw.slice(rawStart, rawEnd) === 'beta\n\n\tgamma',
    `mapped to ${JSON.stringify(raw.slice(rawStart, rawEnd))}`,
  );
});

defineCase('normalizeTextWithMap: trailing whitespace is trimmed from the maps too', () => {
  const raw = 'word   ';
  const { normalized, ends } = normalizeTextWithMap(raw);
  assert(normalized === 'word', 'trailing run must be trimmed');
  assert(ends[normalized.length - 1] === 4, `last end should sit after "word", got ${ends[normalized.length - 1]}`);
});

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
