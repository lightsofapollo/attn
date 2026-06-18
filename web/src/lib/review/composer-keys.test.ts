// Manual smoke harness for the composer Enter-key policy (attn-2aj).
//
// Run with:
//
//   cd web && npx tsx src/lib/review/composer-keys.test.ts

import { shouldSubmitOnEnter } from './composer-keys';

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

defineCase('plain Enter submits', () => {
  assert(shouldSubmitOnEnter({ key: 'Enter' }), 'Enter → submit');
});

defineCase('Cmd/Ctrl+Enter still submits (muscle memory)', () => {
  assert(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false }), 'Cmd+Enter → submit');
});

defineCase('Shift+Enter and Alt+Enter insert a newline instead', () => {
  assert(!shouldSubmitOnEnter({ key: 'Enter', shiftKey: true }), 'Shift+Enter → newline');
  assert(!shouldSubmitOnEnter({ key: 'Enter', altKey: true }), 'Alt+Enter → newline');
});

defineCase('Enter during IME composition belongs to the IME', () => {
  assert(!shouldSubmitOnEnter({ key: 'Enter', isComposing: true }), 'composing Enter ignored');
});

defineCase('WebKit IME commit-Enter (keyCode 229, isComposing false) is ignored', () => {
  // WebKit fires the candidate-confirm Enter AFTER compositionend with
  // isComposing already false — only keyCode 229 marks it as the IME's.
  assert(
    !shouldSubmitOnEnter({ key: 'Enter', isComposing: false, keyCode: 229 }),
    'post-compositionend Enter ignored',
  );
});

defineCase('auto-repeat Enter never submits', () => {
  assert(!shouldSubmitOnEnter({ key: 'Enter', repeat: true }), 'held Enter ignored');
});

defineCase('non-Enter keys never submit', () => {
  assert(!shouldSubmitOnEnter({ key: 'a' }), 'letter');
  assert(!shouldSubmitOnEnter({ key: 'Escape' }), 'escape');
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
