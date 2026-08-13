import { DEFAULT_ICON_PACK, loadIconPack, type IconPack, type IconPackIcons } from './vscode-icon-map.generated';
import { ICON_PACK as defaultPackIcons } from './vscode-icon-packs/eyecons.generated';
import { getIconPack, subscribeIconPack } from './icon-pack';
import type { FileIconResolver } from './file-icon-resolver';
import { resolveFileIconFromPack, resolveFolderIconFromPack } from './file-icon-resolution';

// The native app keeps its default pack immediately available, then loads a
// non-default selection on demand. It retains responsive pack switching while
// avoiding an eager multi-pack graph in every consumer of the resolver.
const loadedPacks = new Map<IconPack, IconPackIcons>([[DEFAULT_ICON_PACK, defaultPackIcons]]);
const loadingPacks = new Map<IconPack, Promise<void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function loadPack(pack: IconPack): void {
  if (loadedPacks.has(pack) || loadingPacks.has(pack)) return;
  const pending = loadIconPack(pack)
    .then((icons) => {
      loadedPacks.set(pack, icons);
      if (getIconPack() === pack) notify();
    })
    .catch(() => {
      // The selected pack is an appearance enhancement. Keep the default
      // images rather than leave the tree unusable if an optional chunk fails.
    })
    .finally(() => loadingPacks.delete(pack));
  loadingPacks.set(pack, pending);
}

function activePackIcons(): IconPackIcons {
  const selected = getIconPack();
  const loaded = loadedPacks.get(selected);
  if (loaded) return loaded;
  loadPack(selected);
  return defaultPackIcons;
}

/**
 * Every file gets an icon, Markdown included (attn-n01r.7).
 *
 * The resolver remains synchronous for its existing native consumers. When a
 * remembered non-default pack is still loading it temporarily uses eyecons,
 * then emits a resolver update so mounted views repaint with the selection.
 */
export function resolveFileIcon(fileName: string): string | null {
  return resolveFileIconFromPack(activePackIcons(), fileName);
}

export function resolveFolderIcon(folderName: string, opened: boolean): string {
  return resolveFolderIconFromPack(activePackIcons(), folderName, opened);
}

export const nativeFileIconResolver: FileIconResolver = {
  resolveFileIcon,
  resolveFolderIcon,
  subscribe(listener) {
    listeners.add(listener);
    // `subscribeIconPack` deliberately emits its current value synchronously.
    // Forwarding that first emission calls the listener while the subscribing
    // FileTree effect is STILL RUNNING, so `iconRevision += 1` lands inside
    // the effect that registered it; Svelte re-runs that effect until it trips
    // `effect_update_depth_exceeded`, which kills the reactive graph and
    // leaves every document — markdown included — rendering as one empty
    // paragraph. There is nothing to redraw for the initial value anyway: the
    // first render already resolved icons for this pack and started any lazy
    // load. Genuine pack changes and completed loads notify afterwards.
    // Same reasoning, same shape as hosted-icon-registry.ts.
    let selected = getIconPack();
    const unsubscribePack = subscribeIconPack((pack) => {
      const changed = selected !== pack;
      selected = pack;
      loadPack(pack);
      if (changed) listener();
    });
    return () => {
      listeners.delete(listener);
      unsubscribePack();
    };
  },
};

export { resolveFileIconFromPack, resolveFolderIconFromPack } from './file-icon-resolution';
