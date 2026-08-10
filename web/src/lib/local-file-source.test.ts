// Manual harness for the browser-side local file source.
//
//   cd web && npx tsx src/lib/local-file-source.test.ts

import {
  activeLocalPath,
  buildTree,
  deliverLocalPath,
  localMarkdown,
  openLocalFiles,
  resetLocalFiles,
  writeLocalMarkdown,
  type PickedPath,
} from './local-file-source';
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

/* Read through a function boundary, not directly: `lastPayload` is only ever
   assigned inside the bridge callback above, which TypeScript's control-flow
   analysis cannot see into — so after a literal `lastPayload = null` it
   narrows the variable to `null` and every later `delivered()?.field`
   collapses to `never`. A call expression resets the narrowing without
   changing a single runtime behaviour. */
const delivered = (): ContentPayload | null => lastPayload;

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
  assert(delivered()?.filePath === 'notes.md', 'the single file becomes the active path');
  assert(delivered()?.markdown === '# hello', 'its text is delivered inline');
  assert(delivered()?.fileTree === undefined, 'a single file is delivered without a sidebar tree');

  // A folder pick does get a tree, and the root is recovered from the shared prefix.
  resetLocalFiles();
  lastPayload = null;
  await openLocalFiles([pick('proj/a.md'), pick('proj/docs/b.md')]);
  assert(delivered()?.rootPath === 'proj', 'the common directory prefix becomes rootPath');
  assert(delivered()?.fileTree !== undefined, 'a folder pick delivers a sidebar tree');
  assert(delivered()?.filePath === 'proj/a.md', 'the first path alphabetically opens');

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

  /* ---------------------------------------------------------------------- *
   * Edits to picked files survive (Codex review, 2026-08-10).
   *
   * THE BUG: `edit_save` was accepted by the mock IPC and never applied. The
   * store holds immutable `File` objects, so the app reported a successful
   * save and the next read of that path returned the ORIGINAL bytes —
   * switching tabs, sharing, or reopening silently reverted the user's work,
   * with the save chip having already told them it was safe.
   * ---------------------------------------------------------------------- */
  resetLocalFiles();
  await openLocalFiles([pick('/w/a.md', '# original a'), pick('/w/b.md', '# original b')]);

  assert(activeLocalPath() === '/w/a.md', 'the first delivered file is the active one');

  assert(writeLocalMarkdown('/w/a.md', '# edited a'), 'an edit to a picked file is accepted');
  assert((await localMarkdown('/w/a.md')) === '# edited a', 'and the next read returns the EDIT');

  // The failure end-to-end: leave the file, come back, and the edit must still
  // be there rather than the bytes off the user's disk.
  await deliverLocalPath('/w/b.md');
  assert(activeLocalPath() === '/w/b.md', 'navigating moves the write target');
  await deliverLocalPath('/w/a.md');
  assert(
    delivered()?.markdown === '# edited a',
    'returning to the edited file redelivers the edit, not the original',
  );

  assert(!writeLocalMarkdown('/w/missing.md', 'x'), 'a write to an unknown path is refused');

  // mtime must move forward, or the app reads its own save back as someone
  // else's concurrent write and raises a disk conflict against itself.
  const mtimeBefore = delivered()?.contentMtimeMs ?? 0;
  writeLocalMarkdown('/w/a.md', '# edited again');
  await deliverLocalPath('/w/a.md');
  assert((delivered()?.contentMtimeMs ?? 0) > mtimeBefore, 'each write advances lastModified');
  assert(
    delivered()?.contentBytes === new Blob(['# edited again']).size,
    'the delivered size matches the edited bytes, not the original',
  );

  resetLocalFiles();
  assert(activeLocalPath() === '', 'reset clears the write target');

  if (failed > 0) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
};

void run();
