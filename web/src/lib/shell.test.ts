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
    // Owner-directed 2026-08-10: the desktop app shows no brand at all. The
    // OS already supplies identity (Dock icon, window, app menu), so the
    // header belongs entirely to the document. This is why the answer is
    // three-way — "nowhere" is a position, not a missing case.
    assert(brandPlacement(true) === 'none', 'desktop shows no brand');
    assert(brandPlacement(false) === 'none', 'desktop shows no brand even with no sidebar');
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
  assert(
    app.includes("showBrand={brandSlot === 'sidebar'}"),
    'the sidebar brand must test the slot directly — with three outcomes, the ' +
      'negation of "header" is no longer "sidebar" (it is also "none")',
  );
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

defineCase('the hosted owner header reads mark · workspace · file', () => {
  const frame = read('../hosted/app/HostedDesktopWorkspaceFrame.svelte');

  // The mark is the way out of the app; the desk has its own named routes.
  assert(
    /<a class="owner-brand" href="\/"/.test(frame),
    'the hosted mark must be a real link to the marketing home',
  );
  assert(
    !frame.includes('triggerLabel='),
    'the switcher trigger must name the WORKSPACE it lists, not the open file',
  );
  assert(
    frame.includes('data-slot="owner-file-name"'),
    'the open file needs its own segment and a stable automation slot',
  );
  // Order is the whole point of the ruling: the workspace opens the switcher,
  // the file is the leaf it contains.
  assert(
    frame.indexOf('data-slot="owner-brand"') <
      frame.indexOf('<ProjectPicker') &&
      frame.indexOf('<ProjectPicker') < frame.indexOf('data-slot="owner-file-name"'),
    'the header must read mark, then workspace, then file',
  );

  // One divider, used twice. A breadcrumb chevron between the last two turned
  // one line of chrome into a wordmark plus a path in two grammars.
  assert(
    !frame.includes('chevron-right'),
    'the header separates its three names with the same hairline, not a chevron',
  );

  // The placeholder untitled.md exists from the moment a workspace is minted,
  // so a non-empty path is not evidence anyone chose a file.
  assert(
    frame.includes('fileChosen && activeEntryPath'),
    'the file segment must require a chosen file, not merely a non-empty path',
  );
  assert(
    read('../hosted/app/EditorShell.svelte').includes('fileChosen={!showCanvasInvite}'),
    'the header must go quiet on exactly the condition that raises the canvas invitation',
  );
});

defineCase('the two names in the header are one typeface', () => {
  const css = read('../app.css');
  const picker = read('ProjectPicker.svelte');

  // Same declaration for both, or the header reads as a mistake rather than a
  // path. Compare the blocks rather than trusting the comment above them.
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    assert(start !== -1, `${selector} must exist`);
    return css.slice(start, css.indexOf('}', start));
  };
  const typography = (body: string): string[] =>
    body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(font-family|font-size|font-weight|line-height|color):/.test(line))
      .sort()
      .join('|')
      .split('|');
  assert(
    typography(block('.owner-file-name')).join('|') ===
      typography(block('.owner-project-name')).join('|'),
    'the workspace and the file must be set in the same face, size, weight and colour',
  );

  // With the chevron gone from the header, hover and focus ARE the affordance.
  assert(
    picker.includes("{#if variant !== 'header'}"),
    'the header trigger must not hang a chevron off the middle of the path',
  );
  assert(
    css.includes('.owner-project-trigger:hover .owner-project-name'),
    'the header trigger must say it is interactive on hover',
  );
});

defineCase('the rail carries the way back to the desk', () => {
  const sidebar = read('Sidebar.svelte');
  const frame = read('../hosted/app/HostedDesktopWorkspaceFrame.svelte');

  assert(
    sidebar.includes('data-slot="sidebar-back"'),
    'the back row needs a stable automation slot',
  );
  assert(
    sidebar.includes('{#if onOpenDesk}'),
    'the back row must be opt-in, so the native app (which has no desk) renders none',
  );
  assert(
    sidebar.indexOf('data-slot="sidebar-back"') < sidebar.indexOf('data-slot="sidebar-brand"'),
    'the way out of this workspace belongs above everything about it',
  );
  assert(
    frame.includes('{onOpenDesk}'),
    'the hosted frame must forward its desk route to the rail',
  );
});

defineCase('renaming a workspace edits the word, not a field over it', () => {
  const css = read('../app.css');
  const shell = read('../hosted/app/EditorShell.svelte');

  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    assert(start !== -1, `${selector} must exist`);
    return css.slice(start, css.indexOf('}', start));
  };

  // No box: the three declarations that made the old control announce itself.
  const input = block('.owner-title-input');
  assert(/border:\s*0/.test(input), 'the rename must not draw a border');
  assert(/background:\s*transparent/.test(input), 'the rename must not fill a field');
  assert(!/max-width/.test(input), 'a fixed width is the box by another name');

  // The sizer is what lets a borderless field hug its own text.
  assert(
    block('.owner-name-edit::after').includes('content: attr(data-value)'),
    'the wrapper must measure what is typed, in the same type',
  );
  assert(
    shell.includes('class="owner-name-edit" data-value={titleValue}'),
    'the sizer needs the live value, or the field stops tracking the text',
  );
  // An <input> measures from `size`, not from CSS width — the same trap the
  // sidebar filter documents. Without this the track stays ~126px wide.
  assert(
    /class="owner-title-input"[\s\S]{0,120}size="1"/.test(shell),
    'the rename field must drop its intrinsic 20-character width',
  );

  // Its focus indicator is the underline; the global ring would redraw the box,
  // so the unlayered override has to be there to beat chrome.css.
  assert(
    read('../hosted/app/app-shell.css').includes('.owner-title-input:focus-visible'),
    'the borderless rename needs the unlayered outline override',
  );
  assert(
    block('.owner-name-edit::before').includes('background: var(--primary)'),
    'the rust underline is what says the word is live',
  );
});

defineCase('renaming a file edits its row, not a field at the foot of the rail', () => {
  const tree = read('FileTree.svelte');
  const sidebar = read('Sidebar.svelte');
  const frame = read('../hosted/app/HostedDesktopWorkspaceFrame.svelte');
  const shell = read('../hosted/app/EditorShell.svelte');
  const css = read('../app.css');

  // The field goes where the name is.
  assert(
    tree.includes('node.path === renamingPath'),
    'the tree must render the field on the row being renamed',
  );
  // An <input> inside a <button> is invalid and unusable, so the row has to
  // stop being a button for as long as it is a field.
  assert(
    tree.includes('data-slot="tree-row-renaming"'),
    'the renaming row needs its own non-button element and a stable slot',
  );
  // Pass-through, both layers, including the recursive call — a nested file
  // would otherwise never see it.
  assert(
    sidebar.includes('{renamingPath} {renameField}'),
    'Sidebar must forward the rename slot to the tree',
  );
  assert(
    (tree.match(/\{renamingPath\} \{renameField\}/g) ?? []).length >= 1,
    'FileTree must forward the rename slot to its own children',
  );
  assert(
    frame.includes('renamingPath={renamingEntryPath ? workspaceTreePath('),
    'the frame owns the relative-path to tree-path conversion',
  );

  // And it is gone from the footer, which is the actual complaint.
  const footerStart = shell.indexOf('{#snippet desktopSidebarFooter()}');
  const footerEnd = shell.indexOf('{/snippet}', footerStart);
  assert(footerStart !== -1 && footerEnd !== -1, 'the sidebar footer snippet must exist');
  assert(
    !shell.slice(footerStart, footerEnd).includes('aria-label="New path"'),
    'the rename field must not render at the foot of the rail',
  );

  // Same no-box treatment as the workspace rename, and the same intrinsic-width
  // trap disarmed.
  const input = css.slice(
    css.indexOf('.sidebar-rename-input {'),
    css.indexOf('}', css.indexOf('.sidebar-rename-input {')),
  );
  assert(/border:\s*0/.test(input), 'the row rename must not draw a border');
  assert(/background:\s*transparent/.test(input), 'the row rename must not fill a field');
  assert(
    /class="sidebar-rename-input"[\s\S]{0,120}size="1"/.test(shell),
    'the row rename field must drop its intrinsic 20-character width',
  );
  assert(
    read('../hosted/app/app-shell.css').includes('.sidebar-rename-input:focus-visible'),
    'the borderless row rename needs the unlayered outline override',
  );
});

defineCase('file-tree disclosure and selection stay inside the branch guide', () => {
  const tree = read('FileTree.svelte');
  const reviewTree = read('ReviewFileTree.svelte');
  const css = read('../app.css');

  assert(
    tree.includes("sidebar-tree-chevron--open") && tree.includes('exp ?'),
    'the owner tree chevron must derive its direction from the folder open state',
  );
  assert(
    reviewTree.includes('review-tree-chevron--open') && reviewTree.includes('collapsed.has(node.path)'),
    'the review tree chevron must derive its direction from the folder collapsed state',
  );
  assert(
    css.includes('transition: transform var(--t) var(--ease)')
      && css.includes('.sidebar-tree-chevron--open')
      && css.includes('.review-tree-chevron--open'),
    'both trees need the shared eased disclosure motion',
  );
  assert(
    css.includes('margin-inline-start: calc(var(--tree-depth, 0) * 20px)')
      && css.includes('width: calc(100% - var(--tree-depth, 0) * 20px)')
      && css.includes('padding-left: 10px !important'),
    'nested row fills must be inset from the containing guide while preserving label spacing',
  );
  assert(
    css.includes('@media (prefers-reduced-motion: reduce)')
      && css.includes('.sidebar-tree-chevron,\n    .review-tree-chevron'),
    'disclosure motion must respect reduced-motion preferences',
  );
});

defineCase('hosted import uses one files-or-folder chooser', () => {
  const shell = read('../hosted/app/EditorShell.svelte');
  const openPage = read('../hosted/app/OpenPage.svelte');
  const chooser = read('../hosted/app/ImportChooser.svelte');

  assert(
    chooser.includes('Choose one or more files') && chooser.includes('Keep the folder structure'),
    'the chooser must expose files and folders as explicit menu choices',
  );
  assert(
    (shell.match(/<ImportChooser/g) ?? []).length >= 3,
    'sidebar, empty canvas, and mobile sheet must share the chooser',
  );
  assert(
    shell.includes('webkitdirectory') && shell.includes('bind:this={assetFolderInput}'),
    'the folder input must remain available behind the shared chooser',
  );
  assert(
    openPage.includes('<ImportChooser') && openPage.includes('bind:this={folderInput}')
      && openPage.includes('webkitdirectory'),
    'the desk import route must offer the same folder choice',
  );
  assert(
    !shell.includes('data-action="add-folder"'),
    'the sidebar must not expose a second competing folder button',
  );
  assert(
    shell.includes('Open a fresh import to use the current folder contents.')
      && shell.includes('href="/open"'),
    'duplicate imports must explain the stale-workspace path and link to a fresh import',
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
