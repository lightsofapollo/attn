import { readFile } from 'node:fs/promises';
import {
  base64UrlDecode,
  base64UrlEncode,
  contentHash,
  deriveWorkspaceManifestFileId,
  toCanonicalBytes,
} from './browser-crypto';
import {
  assertManifestEntryMatchesBytes,
  createWorkspaceManifest,
  decodeCanonicalBase64Url,
  validateSnapshotPlaintext,
  validateWorkspaceManifest,
} from './browser-workspace-manifest';
import type { WorkspaceManifestEntry } from '../types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function rejects(fn: () => unknown, message: string): void {
  try { fn(); } catch { return; }
  throw new Error(`${message}: expected rejection`);
}

const vector = JSON.parse(await readFile(new URL('../../../../planning/collab/test-vectors/workspace-snapshot.json', import.meta.url), 'utf8')) as {
  manifestFileId: { roomSecretBase64url: string; fileId: string };
  cases: Array<{ name: string; value: unknown; canonicalJson: string; canonicalBytesBase64url: string; rawBytesBase64url?: string }>;
};
for (const item of vector.cases) {
  const validated = validateSnapshotPlaintext(item.value);
  const canonical = toCanonicalBytes(validated);
  equal(new TextDecoder().decode(canonical), item.canonicalJson, `${item.name} canonical JSON`);
  equal(base64UrlEncode(canonical), item.canonicalBytesBase64url, `${item.name} canonical bytes`);
  if (item.rawBytesBase64url) {
    const decoded = decodeCanonicalBase64Url((validated as { content: string }).content);
    equal(base64UrlEncode(decoded), item.rawBytesBase64url, `${item.name} binary round-trip`);
    assert(decoded[0] === 0 && decoded.includes(255), 'binary vector preserves NUL/invalid UTF-8');
  }
}
equal(
  deriveWorkspaceManifestFileId(base64UrlDecode(vector.manifestFileId.roomSecretBase64url)),
  vector.manifestFileId.fileId,
  'synthetic manifest FileId matches Rust vector',
);

const raw = new Uint8Array([0, 255, 0, 65]);
const asset: WorkspaceManifestEntry = {
  fileId: base64UrlEncode(new Uint8Array(16).fill(1)),
  snapshotId: base64UrlEncode(new Uint8Array(16).fill(2)),
  path: 'z/raw.bin', kind: 'asset', mediaType: 'application/octet-stream',
  byteLength: raw.length, contentHash: contentHash(raw),
};
const markdown: WorkspaceManifestEntry = {
  fileId: base64UrlEncode(new Uint8Array(16).fill(3)),
  snapshotId: base64UrlEncode(new Uint8Array(16).fill(4)),
  path: 'e\u0301/readme.md', kind: 'markdown', byteLength: 2,
  contentHash: contentHash(new TextEncoder().encode('ok')),
};
const built = createWorkspaceManifest('workspace', [asset, markdown]);
equal(built.entries.map((entry) => entry.path), ['z/raw.bin', 'é/readme.md'], 'NFC-normalized UTF-8 sort');
assertManifestEntryMatchesBytes(asset, raw, 'application/octet-stream');
rejects(() => assertManifestEntryMatchesBytes({ ...asset, byteLength: 99 }, raw, asset.mediaType), 'length mismatch');
rejects(() => assertManifestEntryMatchesBytes({ ...asset, contentHash: contentHash(new Uint8Array()) }, raw, asset.mediaType), 'hash mismatch');
rejects(() => assertManifestEntryMatchesBytes(asset, raw, 'image/png'), 'media mismatch');
rejects(() => validateSnapshotPlaintext({ docType: 'asset', content: 'AA==', encoding: 'base64url', mediaType: 'x/y' }), 'padded asset');
rejects(() => validateSnapshotPlaintext({ docType: 'asset', content: 'AA', encoding: 'base64url', mediaType: 'text/plain; charset=utf-8' }), 'parameterized media');
rejects(() => validateSnapshotPlaintext({ docType: 'html', content: '<b>x</b>', anchorIndex: {} }), 'active/extra HTML field');
// The annotation capability must SURVIVE validation on html (dropping it
// silently downgrades hosted reviewers to read-only), be limited to known
// values, and stay off every other docType — mirrors model.rs validate().
equal(
  (validateSnapshotPlaintext({ docType: 'html', content: '<b>x</b>', annotation: 'html_selectors_v1' }) as { annotation?: string }).annotation,
  'html_selectors_v1',
  'html annotation capability survives validation',
);
rejects(() => validateSnapshotPlaintext({ docType: 'html', content: '<b>x</b>', annotation: 'html_selectors_v2' }), 'unknown annotation value');
rejects(() => validateSnapshotPlaintext({ docType: 'markdown', content: 'x', annotation: 'html_selectors_v1' }), 'annotation on markdown');
rejects(() => validateWorkspaceManifest({ ...built, entries: [built.entries[0], built.entries[0]] }), 'duplicate paths/ids');
rejects(() => validateWorkspaceManifest({ ...built, entries: [...built.entries].reverse() }), 'unsorted paths');
rejects(() => validateWorkspaceManifest({ ...built, scope: 'file' }), 'file scope with many entries');
rejects(() => validateWorkspaceManifest({ ...built, entries: [{ ...built.entries[0], path: '../raw.bin' }] }), 'escaping path');
rejects(() => validateWorkspaceManifest({ ...built, entries: [{ ...built.entries[0], contentHash: 'AA' }] }), 'short hash');

console.log(`browser-workspace-manifest: ${vector.cases.length + 14} passed, 0 failed`);
