import type { TreeNode } from './types';

export interface SidebarPresenceLocation {
  id: string;
  path: string;
}

export interface SidebarPresenceBadge {
  count: number;
  inherited: boolean;
}

export function normalizeSidebarPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
}

export function pathIsWithinSidebarNode(path: string, node: TreeNode): boolean {
  const target = normalizeSidebarPath(path);
  const nodePath = normalizeSidebarPath(node.path);
  if (target === nodePath) return true;
  return node.isDir && target.startsWith(`${nodePath}/`);
}

export function sidebarPresenceBadgeForNode(
  node: TreeNode,
  locations: SidebarPresenceLocation[],
  isExpanded: boolean,
): SidebarPresenceBadge | null {
  const matches = locations.filter((location) => pathIsWithinSidebarNode(location.path, node));
  if (matches.length === 0) return null;

  const visibleChildren = node.isDir && isExpanded ? (node.children ?? []) : [];
  const localMatches = visibleChildren.length === 0
    ? matches
    : matches.filter(
      (location) => !visibleChildren.some((child) => pathIsWithinSidebarNode(location.path, child)),
    );
  if (localMatches.length === 0) return null;

  const nodePath = normalizeSidebarPath(node.path);
  const hasExactMatch = localMatches.some(
    (location) => normalizeSidebarPath(location.path) === nodePath,
  );
  return {
    count: localMatches.length,
    inherited: !hasExactMatch,
  };
}
