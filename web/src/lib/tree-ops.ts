import type { TreeOp } from './types';

/**
 * The paths a tree-op batch genuinely DELETES — removed and not also re-added by
 * an upsert in the same batch.
 *
 * A remove+upsert of the same path is a replace/rename, NOT a deletion: the
 * owner's atomic save writes `foo.md.attn-tmp` then renames it onto `foo.md`,
 * and the file-watcher surfaces that as `[remove foo.md, upsert foo.md]`. Treat
 * that as a deletion and we close the tab the owner is actively editing — the
 * editor unmounts to "No file selected" mid-collab. So a path that is removed
 * AND re-upserted in the same batch must be excluded from pruning.
 */
export function netRemovedPaths(treeOps: TreeOp[]): string[] {
  const upserted = new Set<string>();
  for (const op of treeOps) {
    if (op.op === 'upsert') upserted.add(op.node.path);
  }
  const removed: string[] = [];
  for (const op of treeOps) {
    if (op.op === 'remove' && !upserted.has(op.path)) removed.push(op.path);
  }
  return removed;
}
