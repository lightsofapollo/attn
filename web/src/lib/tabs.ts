import type { FileType } from './types';

export interface Tab {
  id: string;
  path: string;
  fileType: FileType;
  label: string;
  scrollY: number;
}

let nextId = 0;
function genId(): string {
  return `tab-${nextId++}`;
}

export function createTab(path: string, fileType: FileType): Tab {
  const label = path.split('/').pop() ?? path;
  return {
    id: genId(),
    path,
    fileType,
    label,
    scrollY: 0,
  };
}

export function findTabByPath(tabs: Tab[], path: string): Tab | undefined {
  return tabs.find((t) => t.path === path);
}
