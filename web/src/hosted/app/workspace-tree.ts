import { detectFileType } from '../../lib/markdown-layer';
import type { TreeNode } from '../../lib/types';
import type { WorkspaceEntry } from './types';

export function workspaceVirtualRoot(workspaceId: string): string {
  return `/workspace/${workspaceId}`;
}

export function workspaceTreePath(workspaceId: string, entryPath: string): string {
  const root = workspaceVirtualRoot(workspaceId);
  return entryPath ? `${root}/${entryPath.replace(/^\/+/, '')}` : root;
}

export function workspaceRelativePath(workspaceId: string, treePath: string): string | null {
  const root = workspaceVirtualRoot(workspaceId);
  if (treePath === root) return '';
  const prefix = `${root}/`;
  return treePath.startsWith(prefix) ? treePath.slice(prefix.length) : null;
}

export function workspaceEntriesToTree(
  workspaceId: string,
  entries: readonly WorkspaceEntry[],
): TreeNode[] {
  const root = workspaceVirtualRoot(workspaceId);
  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let children = nodes;
    let parentPath = root;

    for (const [index, name] of parts.entries()) {
      const path = `${parentPath}/${name}`;
      const isDir = index < parts.length - 1;
      let node = children.find((candidate) => candidate.path === path);
      if (!node) {
        node = {
          name,
          path,
          isDir,
          fileType: isDir ? 'directory' : detectFileType(entry.path),
          ...(isDir ? { children: [] } : {}),
        };
        children.push(node);
        children.sort((left, right) => {
          if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
          return left.name.localeCompare(right.name);
        });
      }
      if (!isDir) break;
      children = node.children ?? (node.children = []);
      parentPath = path;
    }
  }

  return nodes;
}
