// Shell detection and what it decides (attn-64iy.5).
//
// Run with:
//
//   cd web && npx tsx src/lib/shell.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandPlacement, isNativeShell, reservesWindowControls } from './shell';

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

/** Stand up a minimal `window` and run `fn` against it. */
function withWindow(mockIpc: boolean | undefined, fn: () => void): void {
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const previous = g.window;
  g.window = mockIpc === undefined ? {} : { __attnMockIpc: mockIpc };
  try {
    fn();
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

defineCase('a browser tab is not the native shell', () => {
  withWindow(true, () => {
    assert(!isNativeShell(), 'the mock-IPC flag means there is no wry host');
    assert(
      !reservesWindowControls(),
      'a browser tab has no traffic lights, so it must reserve no space for them',
    );
  });
});

defineCase('the wry window is the native shell', () => {
  // The real host never sets `__attnMockIpc` — `installMockIpc` bails before
  // it does when it finds `window.ipc` already present.
  withWindow(undefined, () => {
    assert(isNativeShell(), 'no mock flag means a real wry host is behind us');
    assert(reservesWindowControls(), 'the desktop window must keep clearing its traffic lights');
  });
});

defineCase('the flag is read, not window.ipc', () => {
  // The mock installs its OWN `window.ipc` shim, so that property is truthy in
  // BOTH shells. A detector keyed on it would report every browser tab as
  // native — which is the exact bug this module exists to prevent.
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const previous = g.window;
  g.window = { ipc: { postMessage() {} }, __attnMockIpc: true };
  try {
    assert(!isNativeShell(), 'a mock window.ipc must not be mistaken for a wry host');
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'shell.ts'),
    'utf8',
  );
  assert(
    !/return[^\n]*Boolean\(window\.ipc\)/.test(src),
    'shell detection must not key off window.ipc',
  );
});

defineCase('the brand takes the free corner only when there is one', () => {
  withWindow(true, () => {
    assert(
      brandPlacement(true) === 'sidebar',
      'browser + sidebar: the freed top-left corner is the brand’s',
    );
    assert(
      brandPlacement(false) === 'header',
      'browser with no sidebar: the brand falls back to the header rather than vanishing',
    );
  });
  withWindow(undefined, () => {
    assert(brandPlacement(true) === 'header', 'desktop keeps the brand in the header');
    assert(brandPlacement(false) === 'header', 'desktop keeps the brand in the header');
  });
});

defineCase('server-side / test environments do not claim a native shell', () => {
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const previous = g.window;
  delete g.window;
  try {
    assert(!isNativeShell(), 'no window at all must not report a wry host');
  } finally {
    if (had) g.window = previous;
  }
});

const libDir = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => fs.readFileSync(path.join(libDir, relative), 'utf8');

defineCase('App.svelte spends the predicate, it does not re-derive it', () => {
  const app = read('../App.svelte');
  assert(
    app.includes("import { brandPlacement, reservesWindowControls } from './lib/shell'"),
    'App must take both decisions from the shared module',
  );
  assert(
    app.includes('const nativeChrome = reservesWindowControls();'),
    'the shell must be resolved once, not re-tested per call site',
  );
  assert(
    !app.includes('__attnMockIpc'),
    'App must not re-implement shell detection inline — that is how it drifts',
  );
});

defineCase('nothing is reserved for window controls in a browser tab', () => {
  const app = read('../App.svelte');
  assert(
    app.includes("hasSidebar || !nativeChrome ? 'pl-3' : 'pl-[6.5rem]'"),
    'the 6.5rem traffic-light indent must be owed only where traffic lights exist',
  );
  assert(
    app.includes('showWindowDragRegion={nativeChrome}'),
    'the 46px drag strip must be owed only where traffic lights exist',
  );
  assert(
    app.includes('onmousedown={nativeChrome ? dragWindow : undefined}')
      && app.includes('ondblclick={nativeChrome ? zoomWindow : undefined}'),
    'window drag/zoom must not post commands no daemon is listening for',
  );
});

defineCase('the brand is in exactly one place at a time', () => {
  const app = read('../App.svelte');
  const sidebar = read('Sidebar.svelte');
  assert(app.includes('{#if brandInHeader}'), 'the header brand must be conditional');
  assert(app.includes('showBrand={!brandInHeader}'), 'the sidebar brand takes the other branch');
  // Mutually exclusive by construction: one boolean, both branches.
  assert(
    sidebar.includes('showBrand = false'),
    'showBrand must default false so hosted surfaces keep their own brand',
  );
  assert(
    sidebar.includes('data-slot="sidebar-brand"'),
    'the sidebar brand needs a stable automation slot',
  );
  assert(
    sidebar.includes("import BrandMark from './BrandMark.svelte'"),
    'the sidebar renders the same mark as the header, not a second drawing of it',
  );
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
