import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_OPEN_ICON,
  FILE_EXTENSION_ICONS,
  FILE_NAME_ICONS,
  FOLDER_NAME_ICONS,
  FOLDER_NAME_OPEN_ICONS,
} from './vscode-icon-map.generated';

const MARKDOWN_NO_ICON = new Set(['md']);
const SPECIAL_MARKDOWN_FILES = new Set(['agents.md', 'claude.md']);

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

export function resolveFileIcon(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const extCandidates = extensionCandidates(lower);

  const isMarkdown =
    extCandidates.length > 0 && MARKDOWN_NO_ICON.has(extCandidates[extCandidates.length - 1]);
  if (isMarkdown && !SPECIAL_MARKDOWN_FILES.has(lower)) {
    return null;
  }

  const byName = FILE_NAME_ICONS[lower];
  if (byName) return byName;

  for (const ext of extCandidates) {
    const byExt = FILE_EXTENSION_ICONS[ext];
    if (byExt) return byExt;
  }

  return DEFAULT_FILE_ICON;
}

export function resolveFolderIcon(folderName: string, opened: boolean): string {
  const lower = folderName.toLowerCase();
  if (opened) {
    return FOLDER_NAME_OPEN_ICONS[lower] ?? FOLDER_NAME_ICONS[lower] ?? DEFAULT_FOLDER_OPEN_ICON;
  }
  return FOLDER_NAME_ICONS[lower] ?? DEFAULT_FOLDER_ICON;
}
