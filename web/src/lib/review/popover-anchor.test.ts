import type { EditorView } from 'prosemirror-view';
import { nativeTextSelectionRange } from './popover-anchor';

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
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeView(options?: {
  positions?: Map<object, number>;
  members?: Set<object>;
  docSize?: number;
  throwAt?: object;
}): EditorView {
  const positions = options?.positions ?? new Map<object, number>();
  const members = options?.members ?? new Set<object>();
  return {
    dom: {
      contains(node: object): boolean {
        return members.has(node);
      },
    },
    state: { doc: { content: { size: options?.docSize ?? 100 } } },
    posAtDOM(node: object): number {
      if (node === options?.throwAt) throw new RangeError('detached node');
      const position = positions.get(node);
      if (position === undefined) throw new RangeError('outside editor');
      return position;
    },
  } as unknown as EditorView;
}

function selection(
  anchorNode: object | null,
  focusNode: object | null,
  options?: { anchorOffset?: number; focusOffset?: number; collapsed?: boolean },
): Selection {
  return {
    anchorNode,
    anchorOffset: options?.anchorOffset ?? 0,
    focusNode,
    focusOffset: options?.focusOffset ?? 0,
    isCollapsed: options?.collapsed ?? false,
  } as unknown as Selection;
}

defineCase('maps a forward native selection inside the editor', () => {
  const start = {};
  const end = {};
  const view = makeView({
    positions: new Map([[start, 12], [end, 29]]),
    members: new Set([start, end]),
  });
  const range = nativeTextSelectionRange(view, selection(start, end));
  assert(range?.from === 12 && range.to === 29, `unexpected range ${JSON.stringify(range)}`);
});

defineCase('normalizes a backwards native selection', () => {
  const start = {};
  const end = {};
  const view = makeView({
    positions: new Map([[start, 41], [end, 8]]),
    members: new Set([start, end]),
  });
  const range = nativeTextSelectionRange(view, selection(start, end));
  assert(range?.from === 8 && range.to === 41, `unexpected range ${JSON.stringify(range)}`);
});

defineCase('ignores collapsed and cross-surface selections', () => {
  const inside = {};
  const outside = {};
  const view = makeView({
    positions: new Map([[inside, 3]]),
    members: new Set([inside]),
  });
  assert(
    nativeTextSelectionRange(view, selection(inside, inside, { collapsed: true })) === null,
    'collapsed selection should be ignored',
  );
  assert(
    nativeTextSelectionRange(view, selection(inside, outside)) === null,
    'selection leaving the editor should be ignored',
  );
});

defineCase('clamps positions and tolerates a replaced editor DOM', () => {
  const start = {};
  const end = {};
  const view = makeView({
    positions: new Map([[start, -4], [end, 140]]),
    members: new Set([start, end]),
    docSize: 80,
  });
  const range = nativeTextSelectionRange(view, selection(start, end));
  assert(range?.from === 0 && range.to === 80, `unexpected clamped range ${JSON.stringify(range)}`);

  const replaced = makeView({
    positions: new Map([[start, 1], [end, 2]]),
    members: new Set([start, end]),
    throwAt: end,
  });
  assert(
    nativeTextSelectionRange(replaced, selection(start, end)) === null,
    'detached endpoint should be ignored',
  );
});

let failures = 0;
for (const run of cases) {
  const result = run();
  if (result.ok) console.log(`PASS ${result.name}`);
  else {
    failures += 1;
    console.error(`FAIL ${result.name}: ${result.detail}`);
  }
}
if (failures > 0) process.exit(1);
