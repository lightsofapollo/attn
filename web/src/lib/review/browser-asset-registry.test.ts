import { BrowserAssetRegistry, type BrowserObjectUrlApi } from './browser-asset-registry';
import type { WorkspaceManifestEntry } from '../types';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assetEntry(overrides: Partial<WorkspaceManifestEntry> = {}): WorkspaceManifestEntry {
  return {
    fileId: 'file-a',
    snapshotId: 'snapshot-a',
    path: 'images/chart.png',
    kind: 'asset',
    mediaType: 'image/png',
    byteLength: 24,
    contentHash: 'hash-a',
    ...overrides,
  };
}

function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 2, 0, 0, 0, 2], 16);
  return bytes;
}

const revoked: string[] = [];
let serial = 0;
const objectUrls: BrowserObjectUrlApi = {
  createObjectURL: () => `blob:test-${++serial}`,
  revokeObjectURL: (url) => revoked.push(url),
};
const registry = new BrowserAssetRegistry(objectUrls);
const source = pngBytes();

registry.stage({
  roomId: 'room-a', fileId: 'file-a', snapshotId: 'snapshot-a', path: 'images/chart.png',
  mediaType: 'image/png', bytes: source,
});
registry.activateManifest('room-a', [assetEntry()]);
assert(registry.urlFor('room-a', 'snapshot-a') === 'blob:test-1', 'bound asset receives a Blob URL');
assert(source.every((byte) => byte === 0), 'source bytes are zeroed after the Blob takes a copy');

const unbound = pngBytes();
registry.stage({
  roomId: 'room-a', fileId: 'file-b', snapshotId: 'snapshot-b', path: 'images/other.png',
  mediaType: 'image/png', bytes: unbound,
});
registry.activateManifest('room-a', [assetEntry({ snapshotId: 'snapshot-b', path: 'images/forged.png' })]);
assert(registry.urlFor('room-a', 'snapshot-b') === null, 'a manifest path mismatch cannot mint a Blob URL');
assert(unbound.some((byte) => byte !== 0), 'unbound data remains pending for a later authentic manifest');

const rejected = new Uint8Array([0, 1, 2, 3]);
registry.stage({
  roomId: 'room-a', fileId: 'file-rejected', snapshotId: 'snapshot-rejected', path: 'images/not-an-image',
  mediaType: 'application/octet-stream', bytes: rejected,
});
assert(rejected.every((byte) => byte === 0), 'unsupported payloads are zeroed before they enter the registry');
assert(registry.urlFor('room-a', 'snapshot-rejected') === null, 'unsupported payloads cannot activate');

const replacement = pngBytes();
registry.stage({
  roomId: 'room-a', fileId: 'file-c', snapshotId: 'snapshot-c', path: 'images/chart.png',
  mediaType: 'image/png', bytes: replacement,
});
registry.activateManifest('room-a', [assetEntry({ fileId: 'file-c', snapshotId: 'snapshot-c' })]);
assert(registry.urlFor('room-a', 'snapshot-a') === null, 'a replacement releases the old snapshot URL');
assert(registry.urlFor('room-a', 'snapshot-c') === 'blob:test-2', 'a replacement activates the latest verified asset');
assert(revoked.includes('blob:test-1'), 'replaced URLs are revoked');

registry.clearRoom('room-a');
assert(registry.urlFor('room-a', 'snapshot-c') === null, 'room teardown clears active URLs');
assert(revoked.includes('blob:test-2'), 'room teardown revokes active URLs');
assert(unbound.every((byte) => byte === 0), 'room teardown zeroes pending bytes');

console.log('browser-asset-registry: 10 passed, 0 failed');
