import { ICON_PACKS } from './vscode-icon-map.generated';
import { getIconPack } from './icon-pack';

const MARKDOWN_NO_ICON = new Set(['md']);

function extensionCandidates(fileName: string): string[] {
  const lower = fileName.toLowerCase();
  const parts = lower.split('.');
  if (parts.length < 2) return [];

  const candidates: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    candidates.push(parts.slice(i).join('.'));
  }
  return candidates;
}

function activePackIcons() {
  return ICON_PACKS[getIconPack()];
}

export function resolveFileIcon(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const extCandidates = extensionCandidates(lower);
  const icons = activePackIcons();

  const byName = icons.FILE_NAME_ICONS[lower];
  if (byName) return byName;

  const isMarkdown =
    extCandidates.length > 0 && MARKDOWN_NO_ICON.has(extCandidates[extCandidates.length - 1]);
  if (isMarkdown) {
    return null;
  }

  for (const ext of extCandidates) {
    const byExt = icons.FILE_EXTENSION_ICONS[ext];
    if (byExt) return byExt;
  }

  return icons.DEFAULT_FILE_ICON;
}

export function resolveFolderIcon(folderName: string, opened: boolean): string {
  const lower = folderName.toLowerCase();
  const icons = activePackIcons();
  if (opened) {
    return icons.FOLDER_NAME_OPEN_ICONS[lower]
      ?? icons.FOLDER_NAME_ICONS[lower]
      ?? icons.DEFAULT_FOLDER_OPEN_ICON;
  }
  return icons.FOLDER_NAME_ICONS[lower] ?? icons.DEFAULT_FOLDER_ICON;
}
