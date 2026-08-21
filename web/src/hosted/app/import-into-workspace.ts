// Importing files into ONE workspace, whatever the user does next
// (attn-e9r2.1).
//
// THE FAILURE THIS PINS. Desktop switches workspaces in place — same
// EditorShell, new `workspace` prop — and an import is several awaits long:
// reading bytes off the OS, draining the autosave debounce, writing entries.
// The import ran against `workspace.id` read LIVE at each step, so dropping a
// folder on A and clicking B in the switcher before it finished deleted B's
// untitled.md, renamed B after A's import, and navigated the user back out of
// the workspace they had just opened.
//
// The workspace id is therefore a parameter, not a lookup. Everything that
// mutates names the captured id; everything that reads the live route (the
// placeholder heuristic, which asks the editor for its text; the workspace's
// current name; the follow-up navigation) goes through `scope` and is skipped
// once that workspace is no longer on screen — those decisions are about what
// the user is looking at, and off-screen they would be answers about the
// wrong document. The files still land, because a half-read import is the one
// outcome nobody can recover from.

import { dedupeWorkspaceName, importName, toImportFiles, type PickedFile } from './import-files';
import type { ImportFileInput } from './types';

/** The workspace mutations an import performs, as the service exposes them. */
export interface WorkspaceImportPort {
  addAssetFiles(workspaceId: string, files: ImportFileInput[]): Promise<void>;
  deleteEntry(workspaceId: string, path: string): Promise<void>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  listWorkspaces(): Promise<readonly { id: string; name: string }[]>;
}

/** Everything the import needs from the live route, and nothing more. */
export interface WorkspaceImportScope {
  /** True while the importing workspace is still the one on screen. */
  isOnScreen(): boolean;
  /** Drain the autosave debounce: a keystroke inside it is content, and the
   *  placeholder check has to see it before calling the file empty. */
  flushPendingEdits(): Promise<void>;
  /** The empty `untitled.md` this import supersedes, or null. Reads the live
   *  editor, so it is only meaningful while on screen. */
  supersededPlaceholder(importedPaths: string[]): string | null;
  /** The workspace's name right now. */
  currentName(): string;
  /** Refresh entry metadata and open what was imported. */
  follow(openPath: string | undefined): Promise<void>;
}

export interface WorkspaceImportRequest {
  /** The only workspace this import may touch. */
  workspaceId: string;
  /** Read the drop/picker into files. Slow: this is where the switch happens. */
  read(): Promise<PickedFile[]>;
  port: WorkspaceImportPort;
  scope: WorkspaceImportScope;
}

/**
 * A workspace still called "Untitled" takes the import's name.
 *
 * Same call the desk's import route makes (prepareImport → importName), so a
 * document that arrives by the desk and the same document that arrives by the
 * canvas end up on a desk row with the same title. Only for the auto-name: a
 * workspace someone has named is theirs.
 *
 * The target and its name are both passed in rather than read live — this can
 * run after the user has switched away, and renaming whatever is on screen now
 * would put this import's name on somebody else's document.
 */
async function adoptImportedName(
  port: WorkspaceImportPort,
  workspaceId: string,
  currentName: string | null,
  picked: PickedFile[],
): Promise<void> {
  if (currentName !== 'Untitled') return;
  try {
    const proposed = importName(picked);
    if (!proposed || proposed === currentName) return;
    const taken = (await port.listWorkspaces())
      .filter((candidate) => candidate.id !== workspaceId)
      .map((candidate) => candidate.name);
    await port.renameWorkspace(workspaceId, dedupeWorkspaceName(proposed, taken));
  } catch {
    // The auto-name is a courtesy; the import already succeeded.
  }
}

/** Read the picked/dropped files into `workspaceId`. Throws what the port throws. */
export async function importIntoWorkspace(request: WorkspaceImportRequest): Promise<void> {
  const { workspaceId, port, scope } = request;
  const picked = await request.read();
  const files = toImportFiles(picked);
  await scope.flushPendingEdits();

  // One reading of "am I still on screen" for both live questions, so an
  // import cannot delete a placeholder it decided on and then adopt a name
  // from a workspace that arrived in between.
  const onScreen = scope.isOnScreen();
  const superseded = onScreen ? scope.supersededPlaceholder(files.map((file) => file.path)) : null;
  const nameBefore = onScreen ? scope.currentName() : null;

  await port.addAssetFiles(workspaceId, files);
  // After the add, never before: a failed import must leave the workspace
  // exactly as it was, placeholder included.
  if (superseded !== null) {
    try {
      await port.deleteEntry(workspaceId, superseded);
    } catch {
      // A stray untitled.md is untidy; a half-imported workspace is not
      // recoverable. Keep the import and leave the placeholder.
    }
    await adoptImportedName(port, workspaceId, nameBefore, picked);
  }

  // Navigation is about the workspace on screen. Following an import into a
  // workspace the user has left would move them out of the one they opened.
  if (!scope.isOnScreen()) return;
  const openPath = files.find((file) => file.kind === 'markdown' || file.kind === 'html')?.path
    ?? files[0]?.path;
  await scope.follow(openPath);
}
