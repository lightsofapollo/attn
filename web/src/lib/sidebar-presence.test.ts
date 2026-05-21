// Run with: cd web && npx tsx src/lib/sidebar-presence.test.ts

import {
  normalizeSidebarPath,
  pathIsWithinSidebarNode,
  sidebarPresenceBadgeForNode,
  type SidebarPresenceLocation,
} from './sidebar-presence';
import type { TreeNode } from './types';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult> | CaseResult> = [];

function defineCase(name: string, fn: () => void | string | Promise<void | string>): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function dir(path: string, children: TreeNode[] = []): TreeNode {
  return {
    name: path.split('/').at(-1) || path,
    path,
    isDir: true,
    children,
    fileType: 'directory',
  };
}

function file(path: string): TreeNode {
  return {
    name: path.split('/').at(-1) || path,
    path,
    isDir: false,
    fileType: 'markdown',
  };
}

function loc(path: string): SidebarPresenceLocation {
  return { id: path, path };
}

defineCase('normalizes trailing slashes and backslashes', () => {
  assert(normalizeSidebarPath('/a/b/') === '/a/b', 'trailing slash removed');
  assert(normalizeSidebarPath('C:\\a\\b') === 'C:/a/b', 'backslashes normalized');
});

defineCase('file node only matches exact path', () => {
  const node = file('/repo/docs/a.md');
  assert(pathIsWithinSidebarNode('/repo/docs/a.md', node), 'exact file should match');
  assert(!pathIsWithinSidebarNode('/repo/docs/a.md/nested', node), 'nested path should not match file');
});

defineCase('collapsed parent shows inherited badge for deep viewer', () => {
  const node = dir('/repo/docs', [dir('/repo/docs/deep')]);
  const badge = sidebarPresenceBadgeForNode(node, [loc('/repo/docs/deep/a.md')], false);
  assert(badge?.count === 1, `expected count=1, got ${badge?.count}`);
  assert(badge.inherited, 'collapsed parent badge should be inherited');
});

defineCase('expanded parent delegates badge to visible child', () => {
  const node = dir('/repo/docs', [dir('/repo/docs/deep')]);
  const badge = sidebarPresenceBadgeForNode(node, [loc('/repo/docs/deep/a.md')], true);
  assert(badge === null, `expected delegated parent badge, got ${JSON.stringify(badge)}`);
});

defineCase('visible child folder receives inherited badge', () => {
  const node = dir('/repo/docs/deep', [file('/repo/docs/deep/a.md')]);
  const badge = sidebarPresenceBadgeForNode(node, [loc('/repo/docs/deep/a.md')], false);
  assert(badge?.count === 1, `expected count=1, got ${badge?.count}`);
  assert(badge.inherited, 'folder badge should be inherited when file is hidden');
});

defineCase('exact file receives non-inherited badge', () => {
  const node = file('/repo/docs/deep/a.md');
  const badge = sidebarPresenceBadgeForNode(node, [loc('/repo/docs/deep/a.md')], false);
  assert(badge?.count === 1, `expected count=1, got ${badge?.count}`);
  assert(!badge.inherited, 'file badge should be exact');
});

defineCase('expanded folder keeps exact folder viewer while delegating child viewer', () => {
  const node = dir('/repo/docs', [file('/repo/docs/a.md')]);
  const badge = sidebarPresenceBadgeForNode(
    node,
    [loc('/repo/docs'), loc('/repo/docs/a.md')],
    true,
  );
  assert(badge?.count === 1, `expected only exact folder count, got ${badge?.count}`);
  assert(!badge.inherited, 'exact folder viewer should not be inherited');
});

async function run(): Promise<void> {
  let failures = 0;
  for (const runCase of cases) {
    const result = await runCase();
    if (result.ok) {
      console.log(`PASS ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    } else {
      failures += 1;
      console.error(`FAIL ${result.name}: ${result.detail ?? 'unknown error'}`);
    }
  }
  if (failures > 0) process.exit(1);
}

void run();
