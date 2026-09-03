// Resolving a shared document's image srcs against the assets that travelled
// with it (attn-udu8, reviewer half).
//
// A reviewer has no copy of the owner's disk, so the resolver in
// markdown-layer.ts is exactly wrong here: it maps a src onto an
// `attn://localhost/<abs-path>` URL, which on a reviewer's machine is either
// nothing or — worse — some unrelated file that happens to sit at the same
// path. What a reviewer has instead is the set of asset snapshots the owner
// published alongside the document, each carrying the bytes and a wire path.
//
// PATH SPACE. Document `ownerDisplayPath` and asset `ownerDisplayPath` are
// both minted by `selected_share_wire_path` in src/review/bootstrap.rs, which
// strips the share root, admits only `Component::Normal` segments, joins with
// `/`, and NFC-normalises. So they live in one root-relative space and a src
// resolved against the document's own path lands on the asset's key. The
// Browser asset bytes are activated only after their snapshot metadata matches
// the signed manifest, then live as tab-local Blob URLs. Native keeps its
// existing base64 bridge as a backwards-compatible rendering fallback.

import type { ReviewSnapshot } from '../types';
import { browserAssetRegistry } from './browser-asset-registry';

/** The narrow runtime capability a shared-image resolver needs from a tab. */
export interface SharedAssetUrlRegistry {
  urlFor(roomId: string, snapshotId: string): string | null;
  dataUrlFor(roomId: string, snapshotId: string): string | null;
}

/** `scheme:` — 2+ chars so a `C:` drive letter is not mistaken for one.
 *  Mirrors `is_non_local` in src/review/assets.rs. */
function isNonLocal(src: string): boolean {
  if (src.startsWith('//') || src.startsWith('#')) return true;
  const colon = src.indexOf(':');
  if (colon < 0) return false;
  const scheme = src.slice(0, colon);
  return (
    scheme.length >= 2 &&
    /^[a-zA-Z]/.test(scheme) &&
    /^[a-zA-Z0-9+\-.]+$/.test(scheme)
  );
}

/** Decode one segment, falling back to raw bytes on a malformed escape —
 *  same contract as `decodeSegment` in markdown-layer.ts and `decode_segment`
 *  in src/review/assets.rs. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Map an authored src onto the wire path of the asset it names, or `null`.
 *
 * @param docWirePath the document's own `ownerDisplayPath`
 * @param src         `node.attrs.src` exactly as authored
 *
 * Returns `null` for anything that cannot name an asset in this share: a
 * remote or `data:` src, a bare fragment, a directory-ish path, or one that
 * climbs above the share root.
 */
export function sharedAssetPathFor(docWirePath: string, src: string): string | null {
  if (!src || isNonLocal(src)) return null;

  // Decoded first, then re-split: an encoded `%2F` is a real separator to
  // everything downstream, so it has to be one while the walk below reasons
  // about where the path lands.
  const segments = src.split('/').flatMap((piece) => decodeSegment(piece).split('/'));
  const last = segments[segments.length - 1];
  if (last === '' || last === '.' || last === '..') return null;

  // An absolute src cannot name a share asset: wire paths are root-relative.
  // (The owner's own window sees absolute paths on both sides, so the dirname
  // join below still matches there.)
  const base = src.startsWith('/')
    ? []
    : docWirePath.split('/').slice(0, -1).filter((segment) => segment !== '');

  const stack = [...base];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      // Refuse rather than clamp. markdown-layer.ts clamps because it walks an
      // ABSOLUTE path and something has to stop at the filesystem root; here a
      // src that climbs past the share root names nothing, and clamping would
      // let `../../chart.svg` silently resolve onto a root-level asset that
      // the author never referenced.
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) return null;
  // Wire paths are NFC; an authored src need not be.
  return stack.join('/').normalize('NFC');
}

/**
 * Build a `data:` URL from an asset snapshot's payload.
 *
 * `data:` rather than `blob:` on purpose. The bytes arrive already base64url
 * encoded, so this is string work with no `Uint8Array` round trip; there is no
 * object-URL lifetime to manage against Editor.svelte's full docView rebuild
 * (which would revoke URLs still referenced by live `<img>` elements); and it
 * needs nothing of the origin, which for the native app is a custom scheme.
 *
 * Returns `null` without a media type rather than minting `data:undefined;…`.
 */
export function assetDataUrl(
  mediaType: string | undefined,
  base64url: string | undefined,
): string | null {
  if (!mediaType || !base64url) return null;
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) return null;
  const standard = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = standard.length % 4 === 0 ? '' : '='.repeat(4 - (standard.length % 4));
  return `data:${mediaType};base64,${standard}${padding}`;
}

/**
 * A resolver for the reviewer's snapshot editor.
 *
 * Returns `null` for any src with no matching asset, which is the honest
 * answer: an image the owner's policy declined to send (remote, symlinked,
 * oversized, budget-exhausted — see src/review/assets.rs) is indistinguishable
 * from one that has not arrived yet, and inventing a URL for either would be
 * worse than the placeholder card.
 */
export function buildSharedAssetResolver(
  snapshots: readonly ReviewSnapshot[],
  roomId: string | null,
  docWirePath: string | null | undefined,
  registry: SharedAssetUrlRegistry = browserAssetRegistry,
  renderTarget: 'document' | 'opaque-sandbox' = 'document',
): (src: string) => string | null {
  if (!roomId || !docWirePath) return () => null;

  // Newest wins, matching how the document snapshot itself is chosen.
  const assets = new Map<string, ReviewSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.roomId !== roomId) continue;
    if (snapshot.docType !== 'asset') continue;
    const key = snapshot.ownerDisplayPath;
    if (!key) continue;
    const existing = assets.get(key);
    if (!existing || snapshot.createdAt > existing.createdAt) assets.set(key, snapshot);
  }
  if (assets.size === 0) return () => null;

  // Memoised per snapshot: the NodeView calls the resolver on construction and
  // again on every update, and a resolver identity change redraws every image
  // in the document.
  const urls = new Map<string, string | null>();
  return (src: string): string | null => {
    const path = sharedAssetPathFor(docWirePath, src);
    if (path === null) return null;
    const snapshot = assets.get(path);
    if (!snapshot) return null;
    const cached = urls.get(snapshot.snapshotId);
    if (cached !== undefined) return cached;
    // Browser sessions intentionally do not put asset payloads on a
    // ReviewSnapshot. Their hash- and manifest-bound bytes live only in the
    // tab-local registry; native keeps its existing `assetContent` bridge.
    const url = (renderTarget === 'opaque-sandbox'
      ? registry.dataUrlFor(roomId, snapshot.snapshotId)
      : registry.urlFor(roomId, snapshot.snapshotId))
      ?? assetDataUrl(snapshot.mediaType, snapshot.assetContent);
    urls.set(snapshot.snapshotId, url);
    return url;
  };
}
