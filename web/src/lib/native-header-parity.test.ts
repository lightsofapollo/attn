import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string): string => fs.readFileSync(path.join(libDir, relative), 'utf8');

const app = source('../App.svelte');
const frame = source('WorkspaceEditorFrame.svelte');
const hostedFrame = source('../hosted/app/HostedDesktopWorkspaceFrame.svelte');
const hostedShell = source('../hosted/app/EditorShell.svelte');
const saveChip = source('SaveChip.svelte');

assert(app.includes('{#snippet nativeHeader()}'), 'native app must own one in-flow header');
assert(app.includes('data-slot="native-header"'), 'native header needs a stable automation slot');
// One shared chip preserves the canonical label in a title and real sr-only
// content rather than rendering it as an always-visible header pill.
assert(app.includes("from './lib/SaveChip.svelte'"), 'native must use the shared save chip');
assert(hostedShell.includes("from '../../lib/SaveChip.svelte'"), 'hosted must use the shared save chip');
assert(saveChip.includes('title={title}') && saveChip.includes('class="sr-only"'), 'save copy must stay available');
assert(app.includes('railToggle={true}'), 'native comments toggle must live in the shared header');
assert(app.includes('inline={true}'), 'native ReviewBar must render in header flow');
assert(
  app.indexOf('dataSlot="native-save-chip"') < app.indexOf('data-slot="native-header-share"'),
  'native status must precede Share in the right-side action cluster',
);

assert(
  frame.indexOf('{@render chrome?.()}') < frame.indexOf('{@render banner?.()}'),
  'workspace chrome must span the content and review rail before the body',
);
assert(frame.includes('{#if railToggleInHeader}'), 'rail-local toggle must collapse when header owns it');

assert(
  hostedFrame.indexOf('{@render actions()}') < hostedFrame.indexOf('data-slot="owner-header-share"'),
  'hosted desktop must keep status and Share together like mobile and native',
);
assert(hostedFrame.includes('compactShare={true}'), 'hosted desktop Share must be compact like native');
assert(
  hostedFrame.includes("reviewStore.railMode !== 'hidden' || savedHistoryOpen")
    && !hostedFrame.includes("reviewStore.railMode !== 'hidden' || reviewHistoryAvailable"),
  'saved history must not pin a closed 48px rail',
);

// --- Cluster reconciliation (attn-o17v) -------------------------------------
//
// attn-64iy fixed three non-shell-specific things in the native cluster; these
// assertions are what keeps the other two headers from drifting off them
// again. The empty-slot collapse (attn-64iy.3) needs no per-surface assertion:
// it was hoisted into ReviewBar itself, which the native and hosted owner
// headers both mount, and review-bar-cluster.test.ts pins it there.

const reviewApp = source('../BrowserReviewApp.svelte');
const reviewBar = source('ReviewBar.svelte');

// Comments toggles use the panel glyph pair everywhere a toggle exists
// (attn-64iy.4). A speech bubble says "add a comment"; these open a panel.
for (const [name, src] of [
  ['ReviewBar (native + hosted owner)', reviewBar],
  ['BrowserReviewApp (reviewer)', reviewApp],
] as const) {
  assert(
    src.includes("panel-right-close'") && src.includes("panel-right-open'"),
    `${name} must import the panel-right glyph pair`,
  );
  assert(
    !/message-square-text/.test(src),
    `${name} must not fall back to the comment bubble on its rail toggle`,
  );
}

// The reviewer toggle carries the shared active treatment (attn-11g4.6 /
// attn-64iy.6): ghost at rest, accent pill while its surface is open. Labels
// stay the reviewer page's own — reading/review mode is surface-specific copy.
const reviewerToggle = reviewApp.slice(
  reviewApp.indexOf('data-slot="browser-review-rail-toggle"') - 700,
  reviewApp.indexOf('data-slot="browser-review-rail-toggle"') + 500,
);
assert(
  reviewerToggle.includes('border-primary/35 bg-primary/10 text-primary'),
  'the reviewer rail toggle must promote to the shared active pill',
);
assert(
  reviewerToggle.includes('border-transparent'),
  'the reviewer rail toggle must rest as a borderless ghost',
);
assert(
  reviewApp.includes('desktopLayout && railVisible'),
  'the reviewer rail aside must unmount when its toggle closes',
);

// Header share controls are icon-cluster members on both owner surfaces.
const shareChip = source('ShareChip.svelte');
assert(
  shareChip.includes('Both native and hosted owner') && shareChip.includes('title and'),
  'the ShareChip contract must document compact hosted parity and retained disclosure',
);

console.log('  ok  native/mobile header grammar stays aligned');
