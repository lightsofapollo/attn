// Manual harness for net-removed-paths.
//
//   cd web && npx tsx src/lib/tree-ops.test.ts

import { netRemovedPaths } from './tree-ops';
import type { TreeNode, TreeOp } from './types';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`PASS ${msg}`);
  else {
    failed += 1;
    console.error(`FAIL ${msg}`);
  }
}

const node = (path: string): TreeNode => ({
  name: path.split('/').at(-1) ?? path,
  path,
  isDir: false,
  fileType: 'markdown',
});

// A genuine deletion is reported.
assert(
  JSON.stringify(netRemovedPaths([{ op: 'remove', path: '/p/gone.md' }])) ===
    JSON.stringify(['/p/gone.md']),
  'a lone remove is a deletion',
);

// The atomic-save batch: remove + upsert of the active file = a replace, NOT a
// deletion. This is the owner-blank-on-edit regression.
const atomicSave: TreeOp[] = [
  { op: 'remove', path: '/p/basic.md' },
  { op: 'upsert', parentPath: '/p', node: node('/p/basic.md') },
];
assert(netRemovedPaths(atomicSave).length === 0, 'remove+upsert of one path is not a deletion');

// A real delete alongside an unrelated replace: only the deleted one is pruned.
const mixed: TreeOp[] = [
  { op: 'remove', path: '/p/basic.md' },
  { op: 'upsert', parentPath: '/p', node: node('/p/basic.md') },
  { op: 'remove', path: '/p/old.md' },
];
assert(
  JSON.stringify(netRemovedPaths(mixed)) === JSON.stringify(['/p/old.md']),
  'replace is kept, genuine deletion is pruned',
);

assert(netRemovedPaths([]) .length === 0, 'empty batch removes nothing');

process.exit(failed > 0 ? 1 : 0);
