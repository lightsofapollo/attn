import {
  workspaceEntriesToTree,
  workspaceRelativePath,
  workspaceTreePath,
  workspaceVirtualRoot,
} from './workspace-tree';

const entries = [
  { path: 'readme.md', presentation: 'editable' as const, sizeLabel: '1 KB' },
  { path: 'docs/notes.md', presentation: 'editable' as const, sizeLabel: '2 KB' },
  { path: 'images/dot.png', presentation: 'preview' as const, sizeLabel: '3 KB' },
];

const tree = workspaceEntriesToTree('workspace-id', entries);
const root = workspaceVirtualRoot('workspace-id');

if (root !== '/workspace/workspace-id') throw new Error(`unexpected root: ${root}`);
if (tree.map((node) => node.name).join(',') !== 'docs,images,readme.md') {
  throw new Error('workspace tree must sort folders before files');
}
if (tree[0]?.children?.[0]?.path !== `${root}/docs/notes.md`) {
  throw new Error('nested Markdown path was not preserved');
}
if (tree[1]?.children?.[0]?.fileType !== 'image') {
  throw new Error('asset file type was not preserved');
}
if (workspaceTreePath('workspace-id', 'docs/notes.md') !== `${root}/docs/notes.md`) {
  throw new Error('tree path did not bind the virtual workspace root');
}
if (workspaceRelativePath('workspace-id', `${root}/docs/notes.md`) !== 'docs/notes.md') {
  throw new Error('tree navigation did not recover the relative workspace path');
}
if (workspaceRelativePath('workspace-id', '/another/root.md') !== null) {
  throw new Error('foreign tree paths must fail closed');
}
