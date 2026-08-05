// Manual test harness for `injectDocRuntime` (attn-61t / attn-17g).
//
//   cd web && npx tsx src/lib/review/html-annotation-inject.test.ts
//
// The runtime is spliced into whatever HTML the shell was handed — a local
// file, or bytes decrypted from a peer. That input is arbitrary and often
// malformed, so the splice deliberately does not parse it: a trailing script is
// placed in <body> by every HTML parser and runs after the document above it.
// These cases pin that behavior, including the shapes where a naive
// "insert before </body>" would corrupt the document or silently no-op.

import { injectDocRuntime } from './html-annotation-bridge';

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

const MARKER = 'data-attn-runtime';

function scriptCount(html: string): number {
  return html.split(MARKER).length - 1;
}

defineCase('injects before a closing body tag', () => {
  const out = injectDocRuntime('<html><body><p>hi</p></body></html>');
  assert(scriptCount(out) === 1, 'expected exactly one runtime script');
  const scriptAt = out.indexOf(MARKER);
  const bodyAt = out.indexOf('</body>');
  assert(scriptAt < bodyAt, 'runtime must land inside <body>');
  assert(out.includes('<p>hi</p>'), 'original content must survive');
});

defineCase('appends when there is no body tag', () => {
  const out = injectDocRuntime('<p>fragment</p>');
  assert(scriptCount(out) === 1, 'expected exactly one runtime script');
  assert(out.startsWith('<p>fragment</p>'), 'original content must lead');
  assert(out.indexOf(MARKER) > out.indexOf('fragment'), 'runtime must trail the content');
});

defineCase('handles an uppercase or spaced closing tag', () => {
  for (const closing of ['</BODY>', '</body >', '</Body>']) {
    const out = injectDocRuntime(`<body><p>hi</p>${closing}</html>`);
    assert(scriptCount(out) === 1, `expected one script for ${closing}`);
    assert(out.indexOf(MARKER) < out.indexOf('</html>'), `runtime misplaced for ${closing}`);
  }
});

defineCase('injects once even when body appears more than once', () => {
  // A malformed document can carry several closing body tags; injecting into
  // each would run the runtime repeatedly and register duplicate listeners.
  const out = injectDocRuntime('<body><p>a</p></body><body><p>b</p></body>');
  assert(scriptCount(out) === 1, `expected one script, got ${scriptCount(out)}`);
});

defineCase('preserves an empty document', () => {
  const out = injectDocRuntime('');
  assert(scriptCount(out) === 1, 'expected the runtime even in an empty document');
});

defineCase('does not disturb content that merely mentions body', () => {
  const source = '<p>the &lt;/body&gt; tag closes a document</p>';
  const out = injectDocRuntime(source);
  assert(out.startsWith(source), 'escaped text must be untouched');
  assert(scriptCount(out) === 1, 'expected exactly one runtime script');
});

defineCase('carries a non-trivial bundle', () => {
  const out = injectDocRuntime('<body></body>');
  // Guards against the generated artifact silently becoming empty — the page
  // would then render fine and simply never annotate.
  assert(out.length > 5000, `bundle looks empty (${out.length} bytes)`);
  return `${out.length} bytes`;
});

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
