import { getIconPack, subscribeIconPack } from '../../lib/icon-pack';
import { resolveFileIconFromPack, resolveFolderIconFromPack } from '../../lib/file-icon-resolution';
import { loadIconPack, type IconPack, type IconPackIcons } from '../../lib/vscode-icon-map.generated';
import type { FileIconResolver } from '../../lib/file-icon-resolver';

/**
 * Browser-desk icon registry.
 *
 * Keep this beside the desktop frame rather than the shared Sidebar/FileTree:
 * each selected pack is an independent dynamic import, so a browser desk does
 * not inherit the native app's 2,776-SVG all-pack registry. The resolver is
 * intentionally injected into the shared tree; those components stay pack-
 * agnostic and remain reusable by native attn.
 */
export function createHostedFileIconResolver(): FileIconResolver {
  const loadedPacks = new Map<IconPack, IconPackIcons>();
  const loadingPacks = new Map<IconPack, Promise<void>>();
  const listeners = new Set<() => void>();
  let selectedPack = getIconPack();
  let stopIconPackSubscription: (() => void) | undefined;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function loadSelectedPack(pack: IconPack): void {
    if (loadedPacks.has(pack) || loadingPacks.has(pack)) return;
    const pending = loadIconPack(pack)
      .then((icons) => {
        loadedPacks.set(pack, icons);
        if (selectedPack === pack) notify();
      })
      .catch(() => {
        // Icons are decorative. The tree preserves its text fallback when an
        // optional pack chunk cannot be fetched (for example, offline).
      })
      .finally(() => loadingPacks.delete(pack));
    loadingPacks.set(pack, pending);
  }

  function currentIcons(): IconPackIcons | undefined {
    const icons = loadedPacks.get(selectedPack);
    if (!icons) loadSelectedPack(selectedPack);
    return icons;
  }

  return {
    resolveFileIcon(fileName) {
      const icons = currentIcons();
      return icons ? resolveFileIconFromPack(icons, fileName) : null;
    },
    resolveFolderIcon(folderName, opened) {
      const icons = currentIcons();
      return icons ? resolveFolderIconFromPack(icons, folderName, opened) : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!stopIconPackSubscription) {
        stopIconPackSubscription = subscribeIconPack((pack) => {
          const changed = selectedPack !== pack;
          selectedPack = pack;
          loadSelectedPack(pack);
          // subscribeIconPack deliberately emits its current value
          // synchronously. There is nothing to redraw for that first value:
          // `currentIcons()` already started the matching lazy load during
          // render. Notifying here would write every recursive FileTree's
          // revision from inside its own subscription effect.
          if (changed) notify();
        });
      }
      loadSelectedPack(selectedPack);
      // Do not invoke the listener while the subscribing FileTree effect is
      // still running. That synchronous state write makes Svelte re-run the
      // subscription effect until it reaches its update-depth guard. The
      // first render already asks `currentIcons()` for this pack; later pack
      // loads and changes notify asynchronously.
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopIconPackSubscription?.();
          stopIconPackSubscription = undefined;
        }
      };
    },
  };
}
