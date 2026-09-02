// Per-tab runtime for verified shared image bytes.
//
// Snapshot plaintext and the Svelte review store deliberately never retain an
// asset payload. A session stages a hash-verified byte buffer here, then the
// signed workspace manifest activates the exact matching entry as a Blob URL.
// That keeps encrypted document bytes out of persisted app state while still
// giving ProseMirror a synchronous URL resolver.

import type { WorkspaceManifestEntry } from '../types';
import {
  bytesMatchSharedImageMediaType,
  hasSafeSharedImageDimensions,
  isSupportedSharedImageMediaType,
  MAX_SHARED_IMAGE_BYTES,
  MAX_SHARED_IMAGE_COUNT,
  MAX_SHARED_IMAGE_TOTAL_BYTES,
} from './shared-image-policy';
import { sharedImageDataUrl } from './image-data-url';

export interface VerifiedBrowserAsset {
  roomId: string;
  fileId: string;
  snapshotId: string;
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

interface ActiveAsset {
  roomId: string;
  snapshotId: string;
  path: string;
  url: string;
  // Opaque sandboxed HTML frames cannot fetch a parent-origin Blob URL. This
  // transient representation is therefore only used by HtmlViewer; Markdown
  // continues to use `url` and gets Blob lifetime management.
  htmlDataUrl: string;
  byteLength: number;
}

export interface BrowserObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

function defaultObjectUrls(): BrowserObjectUrlApi | null {
  if (typeof URL === 'undefined' || typeof Blob === 'undefined') return null;
  if (typeof URL.createObjectURL !== 'function' || typeof URL.revokeObjectURL !== 'function') return null;
  return URL;
}

function snapshotKey(roomId: string, snapshotId: string): string {
  return `${roomId}\u0000${snapshotId}`;
}

function pathKey(roomId: string, path: string): string {
  return `${roomId}\u0000${path}`;
}

/**
 * A room-scoped, tab-local registry. Ownership of `bytes` moves to `stage`;
 * callers must not read or retain that buffer afterwards.
 */
export class BrowserAssetRegistry {
  private readonly pending = new Map<string, VerifiedBrowserAsset>();
  private readonly activeBySnapshot = new Map<string, ActiveAsset>();
  private readonly activeByPath = new Map<string, ActiveAsset>();

  constructor(private readonly objectUrls: BrowserObjectUrlApi | null = defaultObjectUrls()) {}

  stage(asset: VerifiedBrowserAsset): void {
    const key = snapshotKey(asset.roomId, asset.snapshotId);
    if (this.activeBySnapshot.has(key)) {
      // Replay may repeat a snapshot that is already bound and rendered. Keep
      // the known-good URL rather than allocating a second plaintext Blob.
      asset.bytes.fill(0);
      return;
    }
    const previous = this.pending.get(key);
    previous?.bytes.fill(0);
    this.pending.delete(key);
    if (!isAllowedAsset(asset) || !this.canStage(asset)) {
      asset.bytes.fill(0);
      return;
    }
    this.pending.set(key, asset);
  }

  /**
   * Activate the assets whose complete metadata exactly matches this signed
   * manifest. A missing/stale asset remains unavailable instead of becoming a
   * plausible URL from an unbound snapshot.
   */
  activateManifest(roomId: string, entries: readonly WorkspaceManifestEntry[]): void {
    for (const entry of entries) {
      if (entry.kind !== 'asset') continue;
      const key = snapshotKey(roomId, entry.snapshotId);
      const pending = this.pending.get(key);
      if (!pending || !matches(entry, pending)) continue;
      this.pending.delete(key);
      if (!this.objectUrls) {
        pending.bytes.fill(0);
        continue;
      }
      const replaced = this.activeByPath.get(pathKey(roomId, entry.path));
      if (replaced) this.revoke(replaced);
      let url: string | null = null;
      let blobBytes: Uint8Array | null = null;
      try {
        // Blob's DOM typing requires an ArrayBuffer-backed view; copy out of
        // a possibly SharedArrayBuffer-backed wire buffer, then zero both
        // mutable buffers as soon as the Blob has taken its immutable copy.
        blobBytes = new Uint8Array(pending.bytes);
        const blob = new Blob([blobBytes.buffer as ArrayBuffer], { type: pending.mediaType });
        url = this.objectUrls.createObjectURL(blob);
        const active: ActiveAsset = {
          roomId,
          snapshotId: pending.snapshotId,
          path: pending.path,
          url,
          htmlDataUrl: sharedImageDataUrl(pending.mediaType, pending.bytes),
          byteLength: pending.bytes.length,
        };
        this.activeBySnapshot.set(key, active);
        this.activeByPath.set(pathKey(roomId, pending.path), active);
      } finally {
        blobBytes?.fill(0);
        pending.bytes.fill(0);
        // A malformed platform implementation must not leak an inactive URL.
        if (url !== null && !this.activeBySnapshot.has(key)) this.objectUrls.revokeObjectURL(url);
      }
    }
  }

  urlFor(roomId: string, snapshotId: string): string | null {
    return this.activeBySnapshot.get(snapshotKey(roomId, snapshotId))?.url ?? null;
  }

  /** A runtime-only data URL for an image inside an opaque sandboxed iframe. */
  dataUrlFor(roomId: string, snapshotId: string): string | null {
    return this.activeBySnapshot.get(snapshotKey(roomId, snapshotId))?.htmlDataUrl ?? null;
  }

  clearRoom(roomId: string): void {
    for (const [key, asset] of this.pending) {
      if (asset.roomId !== roomId) continue;
      asset.bytes.fill(0);
      this.pending.delete(key);
    }
    for (const asset of [...this.activeBySnapshot.values()]) {
      if (asset.roomId === roomId) this.revoke(asset);
    }
  }

  close(): void {
    for (const asset of this.pending.values()) asset.bytes.fill(0);
    this.pending.clear();
    for (const asset of [...this.activeBySnapshot.values()]) this.revoke(asset);
  }

  private revoke(asset: ActiveAsset): void {
    this.activeBySnapshot.delete(snapshotKey(asset.roomId, asset.snapshotId));
    const key = pathKey(asset.roomId, asset.path);
    if (this.activeByPath.get(key) === asset) this.activeByPath.delete(key);
    this.objectUrls?.revokeObjectURL(asset.url);
  }

  private canStage(asset: VerifiedBrowserAsset): boolean {
    let count = 1;
    let bytes = asset.bytes.length;
    for (const pending of this.pending.values()) {
      if (pending.roomId !== asset.roomId) continue;
      count += 1;
      bytes += pending.bytes.length;
    }
    for (const active of this.activeBySnapshot.values()) {
      if (active.roomId !== asset.roomId) continue;
      count += 1;
      bytes += active.byteLength;
    }
    return count <= MAX_SHARED_IMAGE_COUNT && bytes <= MAX_SHARED_IMAGE_TOTAL_BYTES;
  }
}

function matches(entry: WorkspaceManifestEntry, asset: VerifiedBrowserAsset): boolean {
  return (
    entry.fileId === asset.fileId
    && entry.snapshotId === asset.snapshotId
    && entry.path === asset.path
    && entry.mediaType === asset.mediaType
    && entry.byteLength === asset.bytes.length
  );
}

function isAllowedAsset(asset: VerifiedBrowserAsset): boolean {
  return (
    isSupportedSharedImageMediaType(asset.mediaType)
    && asset.bytes.length <= MAX_SHARED_IMAGE_BYTES
    && bytesMatchSharedImageMediaType(asset.bytes, asset.mediaType)
    && hasSafeSharedImageDimensions(asset.bytes, asset.mediaType)
  );
}

// A module instance belongs to one browser tab. Keeping it here rather than in
// a Svelte singleton avoids serializing Blob URLs or plaintext through app
// state, while callers still share one resolver view of a room in that tab.
export const browserAssetRegistry = new BrowserAssetRegistry();
