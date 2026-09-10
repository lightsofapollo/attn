// Annotate mode is OFF by default, on every surface (attn-wrf3).
//
//   cd web && npx tsx src/lib/html-annotate-toggle.test.ts
//
// Source-level parity pins, in the same spirit as native-header-parity and
// BrowserReviewApp.external-images: the three shells each own a copy of the
// wiring, and what this guards is that none of them slides back to
// `setInspect(htmlAnnotatable)` — the line that made every dashboard tab and
// prototype button in a shared HTML document stop working the moment it was
// under review. The wire-level half (what the frame is actually told) lives in
// review/html-annotation-bridge-inspect.test.ts; the in-frame half runs in a
// real browser in e2e/html-annotation-runtime.spec.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const libDir = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string): string => fs.readFileSync(path.join(libDir, relative), 'utf8');

const toggle = source('HtmlAnnotateToggle.svelte');
const viewer = source('HtmlViewer.svelte');
const keyboard = source('keyboard.ts');
const nativeShortcuts = source('KeyboardShortcutsDialog.svelte');
const hostedShortcuts = source('../hosted/app/ShortcutsSheet.svelte');
const runtime = source('../doc-runtime/index.ts');

const shells = {
  'App.svelte (native)': source('../App.svelte'),
  'BrowserReviewApp.svelte (hosted reviewer)': source('../BrowserReviewApp.svelte'),
  'EditorShell.svelte (hosted owner)': source('../hosted/app/EditorShell.svelte'),
};

for (const [name, src] of Object.entries(shells)) {
  defineCase(`${name}: annotate mode starts off`, () => {
    assert(src.includes('let htmlAnnotateMode = $state(false);'), 'mode state must default to false');
  });

  defineCase(`${name}: the frame is gated on annotatable AND the mode`, () => {
    assert(
      src.includes('setInspect(htmlAnnotatable && htmlAnnotateMode)'),
      'setInspect must take both halves',
    );
    assert(
      !/setInspect\(htmlAnnotatable\)/.test(src),
      'the old "under review means inspect on" wiring must be gone',
    );
  });

  defineCase(`${name}: the toggle is shell-owned and only shown when annotatable`, () => {
    assert(src.includes('<HtmlAnnotateToggle'), 'the toggle component must be rendered');
    // Rendered as HtmlViewer children so it pins to the document viewport,
    // and hidden unless the document can take a note.
    const uses = src.match(/<HtmlAnnotateToggle[\s\S]*?\/>/g) ?? [];
    assert(uses.length > 0, 'at least one toggle render');
    for (const use of uses) {
      assert(use.includes('active={htmlAnnotateMode}'), `toggle reflects the mode: ${use}`);
      assert(use.includes('hidden={!htmlAnnotatable}'), `toggle hides when not annotatable: ${use}`);
      assert(use.includes('onToggle={toggleHtmlAnnotateMode}'), `toggle drives the mode: ${use}`);
    }
    const viewerBlocks = src.match(/<HtmlViewer[\s\S]*?<\/HtmlViewer>/g) ?? [];
    assert(
      viewerBlocks.length === uses.length && viewerBlocks.every((block) => block.includes('<HtmlAnnotateToggle')),
      'every toggle must render inside an HtmlViewer, pinned to the document viewport',
    );
  });

  defineCase(`${name}: the mode resets when the displayed document changes`, () => {
    assert(/htmlAnnotateMode = false;/.test(src), 'a reset path must exist');
  });

  defineCase(`${name}: the toggle only flips on an annotatable document`, () => {
    assert(
      src.includes('function toggleHtmlAnnotateMode(): void {\n    if (!htmlAnnotatable) return;'),
      'toggle must no-op when the document cannot take a note',
    );
  });

  defineCase(`${name}: ⌘⇧N and Escape are wired`, () => {
    assert(src.includes('isHtmlAnnotateHotkey'), 'the shared chord predicate must be used');
    assert(src.includes("'Escape'") && src.includes('htmlAnnotateMode = false'), 'Escape must leave the mode');
    // Escape leaves the mode only beneath an open composer.
    assert(
      /htmlAnnotateMode && !htmlComposer/.test(src) ||
        /!htmlAnnotateMode\) return;\s*\n[\s\S]{0,400}if \(htmlComposer/.test(src),
      'Escape must defer to an open HTML composer',
    );
  });
}

defineCase('the toggle component carries the automation slot, aria-pressed and the copy', () => {
  assert(toggle.includes('data-slot="html-annotate-toggle"'), 'stable automation slot');
  assert(toggle.includes('aria-pressed={active}'), 'a toggle button exposes pressed state');
  assert(toggle.includes("'Done annotating'") && toggle.includes("'Add a note'"), 'tooltip copy');
  assert(toggle.includes("'Annotation on'") && toggle.includes("'Annotation off'"), 'live-region copy');
  assert(toggle.includes('aria-live="polite"'), 'a polite live region announces the change');
  assert(toggle.includes('focus-visible:ring-2'), 'visible focus ring');
  assert(toggle.includes('motion-reduce:transition-none'), 'reduced motion: no animated transition');
  assert(toggle.includes('rounded-full') && toggle.includes('shadow-lg'), 'a lifted pill, per DESIGN.md floating surfaces');
  assert(toggle.includes('{#if !hidden}'), 'hidden renders nothing at all');
  assert(!/window\.(alert|confirm|prompt)\(/.test(toggle), 'no native dialogs');
  assert(toggle.includes("from '@lucide/svelte/icons/message-square-plus'"), 'one Lucide glyph everywhere');
  assert(toggle.includes('safe-area-inset-bottom'), 'respects the safe-area inset');
});

defineCase('the toggle sits inside the HtmlViewer wrapper, not the window', () => {
  assert(viewer.includes('children?: Snippet'), 'HtmlViewer takes shell chrome as children');
  assert(viewer.includes('{@render children?.()}'), 'and renders it inside the wrapper');
  assert(!toggle.includes('fixed'), 'the toggle is never window-fixed');
  assert(toggle.includes('absolute'), 'it is positioned within its container');
});

defineCase('the chord is registered once and listed in both shortcut references', () => {
  assert(keyboard.includes('onToggleHtmlAnnotate'), 'initKeyboard exposes the hook');
  assert(keyboard.includes('export function isHtmlAnnotateHotkey'), 'the predicate is shared');
  assert(nativeShortcuts.includes("'Annotate an HTML document'"), 'native shortcuts dialog row');
  assert(hostedShortcuts.includes("'Annotate an HTML document'"), 'hosted shortcuts sheet row');
  assert(hostedShortcuts.includes("['⌘', '⇧', 'N']"), 'hosted sheet names the chord');
});

defineCase('the runtime refuses to propose after the mode is off', () => {
  assert(
    runtime.includes('function pickScope(scopeId: string): void {') &&
      /function pickScope\(scopeId: string\): void \{[\s\S]*?if \(!inspectEnabled\) return;/.test(runtime),
    'pickScope must be gated on inspectEnabled',
  );
  assert(
    /case 'inspect': \{[\s\S]*?if \(!enabled\) \{[\s\S]*?hideHover\(\);[\s\S]*?currentScopeId = null;[\s\S]*?scopeElements\.clear\(\);/.test(runtime),
    'inspect:false must take down hover chrome, the current scope, and the offered scopes',
  );
  assert(runtime.includes('let inspectEnabled = false;'), 'the frame boots with the surface off');
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
console.log(`html-annotate toggle: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
