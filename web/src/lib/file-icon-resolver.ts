/**
 * The small contract the shared file views need to render an icon.
 *
 * Icon assets are deliberately not imported here. `Sidebar` and `FileTree`
 * are used by both the native shell and the browser desk; making the registry
 * an injected capability keeps a browser-only pack out of the reusable shell.
 */
export interface FileIconResolver {
  resolveFileIcon(fileName: string): string | null;
  resolveFolderIcon(folderName: string, opened: boolean): string | null;
  /** Notify mounted trees when a pack changes or finishes loading. */
  subscribe(listener: () => void): () => void;
}
