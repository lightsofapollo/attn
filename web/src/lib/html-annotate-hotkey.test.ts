// The annotate-mode chord (attn-wrf3.3): ⌘⇧N / Ctrl+Shift+N.
//
//   cd web && npx tsx src/lib/html-annotate-hotkey.test.ts
//
// One predicate is shared by the native App, the hosted reviewer and the
// hosted owner, so the chord cannot drift between surfaces. These cases pin
// what it matches, what it must NOT match (the neighbours it lives beside),
// and that `initKeyboard` routes it — above the editing guard, so a person
// typing a note can leave the mode without clicking out first.

import { htmlAnnotateShortcutLabel, initKeyboard, isHtmlAnnotateHotkey } from './keyboard';

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

type Chord = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key' | 'code'>;

function chord(overrides: Partial<Chord>): Chord {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    key: '',
    code: '',
    ...overrides,
  };
}

defineCase('⌘⇧N matches on a Mac', () => {
  assert(isHtmlAnnotateHotkey(chord({ metaKey: true, shiftKey: true, key: 'N', code: 'KeyN' })), 'meta+shift+N');
});

defineCase('Ctrl+Shift+N matches elsewhere', () => {
  assert(isHtmlAnnotateHotkey(chord({ ctrlKey: true, shiftKey: true, key: 'N', code: 'KeyN' })), 'ctrl+shift+N');
});

defineCase('the physical key carries it on a non-Latin layout', () => {
  // A Cyrillic layout reports key "Т" for the N key; `code` is the constant.
  assert(isHtmlAnnotateHotkey(chord({ metaKey: true, shiftKey: true, key: 'Т', code: 'KeyN' })), 'code alone');
  // And an environment that reports only `key` still binds.
  assert(isHtmlAnnotateHotkey(chord({ metaKey: true, shiftKey: true, key: 'n' })), 'key alone');
});

defineCase('its neighbours do not match', () => {
  assert(!isHtmlAnnotateHotkey(chord({ metaKey: true, key: 'n', code: 'KeyN' })), '⌘N without shift is not ours');
  assert(!isHtmlAnnotateHotkey(chord({ shiftKey: true, key: 'N', code: 'KeyN' })), 'a bare shifted N is typing');
  assert(!isHtmlAnnotateHotkey(chord({ metaKey: true, shiftKey: true, altKey: true, key: 'N', code: 'KeyN' })), 'alt is a different chord');
  assert(!isHtmlAnnotateHotkey(chord({ metaKey: true, shiftKey: true, key: 'S', code: 'KeyS' })), '⌘⇧S is Share');
  assert(!isHtmlAnnotateHotkey(chord({ metaKey: true, shiftKey: true, key: '>', code: 'Period' })), '⌘⇧. is the suggestion composer');
  assert(!isHtmlAnnotateHotkey(chord({ metaKey: true, key: 'j', code: 'KeyJ' })), '⌘J is the rail');
});

defineCase('the tooltip label names the chord for the platform', () => {
  const w = globalThis as unknown as { navigator?: { platform: string } };
  const prev = w.navigator;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
    assert(htmlAnnotateShortcutLabel() === '⌘⇧N', `mac label: ${htmlAnnotateShortcutLabel()}`);
    Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Win32' }, configurable: true });
    assert(htmlAnnotateShortcutLabel() === 'Ctrl+Shift+N', `win label: ${htmlAnnotateShortcutLabel()}`);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: prev, configurable: true });
  }
});

defineCase('initKeyboard routes ⌘⇧N to onToggleHtmlAnnotate, even from a text field', () => {
  const listeners = new Map<string, (e: KeyboardEvent) => void>();
  const fakeWindow = {
    addEventListener(type: string, listener: (e: KeyboardEvent) => void): void {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: (e: KeyboardEvent) => void): void {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const w = globalThis as unknown as {
    window: unknown;
    document?: unknown;
    HTMLElement?: unknown;
  };
  const prev = { window: w.window, document: w.document, HTMLElement: w.HTMLElement };
  w.window = fakeWindow;
  // A focused textarea: the editing guard would swallow a literal key, but
  // review chords live above it.
  class FakeElement {
    tagName = 'TEXTAREA';
    isContentEditable = false;
    closest(): null { return null; }
  }
  w.HTMLElement = FakeElement;
  w.document = { querySelector: () => null, activeElement: new FakeElement() };
  try {
    let fired = 0;
    let prevented = 0;
    const cleanup = initKeyboard({ onToggleHtmlAnnotate: () => { fired += 1; } });
    const handler = listeners.get('keydown');
    assert(typeof handler === 'function', 'initKeyboard binds keydown');
    const base = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      key: 'N',
      code: 'KeyN',
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      target: new FakeElement(),
      preventDefault() { prevented += 1; },
    };
    handler!(base as unknown as KeyboardEvent);
    assert(fired === 1, `fired once from a textarea, got ${fired}`);
    assert(prevented === 1, 'the chord is consumed');

    // Without the handler registered, the chord is left alone (no preventDefault).
    cleanup();
    listeners.clear();
    const cleanup2 = initKeyboard({});
    prevented = 0;
    listeners.get('keydown')!(base as unknown as KeyboardEvent);
    assert(prevented === 0, 'an unbound chord is not consumed');
    cleanup2();
  } finally {
    w.window = prev.window;
    w.document = prev.document;
    w.HTMLElement = prev.HTMLElement;
  }
});

let passed = 0;
const failures: string[] = [];
for (const run of cases) {
  const result = run();
  if (result.ok) {
    passed += 1;
    console.log(`PASS ${result.name}`);
  } else {
    failures.push(result.name);
    console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
  }
}
console.log(`html-annotate hotkey: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
