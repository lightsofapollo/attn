import { ICON_PACKS } from './vscode-icon-map.generated';
import { getIconPack } from './icon-pack';

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

/**
 * Every file gets an icon, Markdown included (attn-n01r.7).
 *
 * This used to suppress `.md` behind an `includeMarkdown` opt-in, on the theory
 * that a column of identical Markdown glyphs is noise in a product whose
 * workspaces are almost all Markdown. In practice it read as broken: the
 * filename lookup below runs first, so README.md kept its icon and every other
 * `.md` lost one, and the two call sites disagreed about whether to opt in.
 * Suppression is now gone rather than defaulted — if the density turns out to
 * be the real problem, the answer is a better Markdown glyph, not a missing one.
 */
export function resolveFileIcon(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const extCandidates = extensionCandidates(lower);
  const icons = activePackIcons();

  const byName = icons.FILE_NAME_ICONS[lower];
  if (byName) return byName;

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
