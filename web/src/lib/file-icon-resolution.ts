import type { IconPackIcons } from './vscode-icon-map.generated';

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

export function resolveFileIconFromPack(icons: IconPackIcons, fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const extCandidates = extensionCandidates(lower);

  const byName = icons.FILE_NAME_ICONS[lower];
  if (byName) return byName;

  for (const ext of extCandidates) {
    const byExt = icons.FILE_EXTENSION_ICONS[ext];
    if (byExt) return byExt;
  }

  return icons.DEFAULT_FILE_ICON;
}

export function resolveFolderIconFromPack(icons: IconPackIcons, folderName: string, opened: boolean): string {
  const lower = folderName.toLowerCase();
  if (opened) {
    return icons.FOLDER_NAME_OPEN_ICONS[lower]
      ?? icons.FOLDER_NAME_ICONS[lower]
      ?? icons.DEFAULT_FOLDER_OPEN_ICON;
  }
  return icons.FOLDER_NAME_ICONS[lower] ?? icons.DEFAULT_FOLDER_ICON;
}
