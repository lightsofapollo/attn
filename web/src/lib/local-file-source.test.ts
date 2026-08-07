// Manual harness for the browser-side local file source.
//
//   cd web && npx tsx src/lib/local-file-source.test.ts

import { buildTree, openLocalFiles, resetLocalFiles, type PickedPath } from './local-file-source';
import type { ContentPayload, TreeNode } from './types';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`PASS ${msg}`);
  else {
    failed += 1;
    console.error(`FAIL ${msg}`);
  }
}

/* `openLocalFiles` reads File.text() and pushes through window.__attn__, so a
   Node run needs both. File exists on Node 20+; the bridge we stand up here. */
const pick = (path: string, text = '# doc', size?: number): PickedPath => ({
  path,
  file: Object.defineProperty(new File([text], path.split('/').at(-1) ?? path), 'size', {
    value: size ?? text.length,
  }) as File,
});

let lastPayload: ContentPayload | null = null;
(globalThis as unknown as { window: unknown }).window = {
  __attn__: {
    setContent(data: ContentPayload) {
      lastPayload = data;
    },
  },
};

const names = (nodes: TreeNode[]): string => nodes.map((n) => n.name).join(',');

// --- buildTree -------------------------------------------------------------

// The returned nodes are the ROOT'S CHILDREN, matching read_tree_root_snapshot
// on the Rust side — the root folder itself is never a node in the list.
const tree = buildTree(['proj/a.md', 'proj/docs/b.md', 'proj/docs/c.md'], 'proj');
assert(names(tree) === 'docs,a.md', 'directories sort before files, each alphabetical');
assert(tree[0].isDir && tree[0].children?.length === 2, 'nested directory keeps its children');
assert(tree[0].children?.[0].path === 'proj/docs/b.md', 'child paths stay root-qualified');
assert(tree[1].fileType === 'markdown' && !tree[1].isDir, 'leaves are markdown files');

// A file directly under the root, with no shared subdirectory, still lands.
const flat = buildTree(['a.md', 'b.md'], '');
assert(names(flat) === 'a.md,b.md', 'an empty root treats every path as top level');

// --- openLocalFiles --------------------------------------------------------

const run = async (): Promise<void> => {
  // Non-markdown is excluded rather than shown as a broken entry: images and
  // HTML resolve through the attn:// protocol, which no browser tab has.
  resetLocalFiles();
  lastPayload = null;
  let result = await openLocalFiles([
    pick('proj/plan.md'),
    pick('proj/logo.png'),
    pick('proj/page.html'),
  ]);
  assert(result.opened === 1, 'only markdown is retained');
  assert(result.skippedKind === 2, 'non-markdown files are counted as skipped');

  // A lone file gets no tree, so hasSidebar stays false and the window is chromeless.
  resetLocalFiles();
  lastPayload = null;
  await openLocalFiles([pick('notes.md', '# hello')]);
  assert(lastPayload?.filePath === 'notes.md', 'the single file becomes the active path');
  assert(lastPayload?.markdown === '# hello', 'its text is delivered inline');
  assert(lastPayload?.fileTree === undefined, 'a single file is delivered without a sidebar tree');

  // A folder pick does get a tree, and the root is recovered from the shared prefix.
  resetLocalFiles();
  lastPayload = null;
  await openLocalFiles([pick('proj/a.md'), pick('proj/docs/b.md')]);
  assert(lastPayload?.rootPath === 'proj', 'the common directory prefix becomes rootPath');
  assert(lastPayload?.fileTree !== undefined, 'a folder pick delivers a sidebar tree');
  assert(lastPayload?.filePath === 'proj/a.md', 'the first path alphabetically opens');

  // Skip lists mirror src/files.rs so a picked project folder is not swamped.
  resetLocalFiles();
  result = await openLocalFiles([
    pick('proj/keep.md'),
    pick('proj/node_modules/dep/readme.md'),
    pick('proj/.git/notes.md'),
  ]);
  assert(result.opened === 1, 'node_modules and dotted directories are skipped');

  // Oversized files are refused, not truncated.
  resetLocalFiles();
  result = await openLocalFiles([pick('big.md', '# big', 9 * 1024 * 1024)]);
  assert(result.opened === 0 && result.skippedLimit === 1, 'a file past the size cap is refused');

  if (failed > 0) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
};

void run();
