import type {
  AnchorIndex,
  SnapshotPlaintext,
  WorkspaceManifestEntry,
  WorkspaceManifestScope,
  WorkspaceSnapshotManifest,
} from '../types';
import {
  base64UrlDecode,
  base64UrlEncode,
  contentHash,
} from './browser-crypto';
import { normalizeEntryPath } from './browser-workspace-schema';

const MIME_TYPE = /^[!#$&+.^_0-9A-Za-z-]+\/[!#$&+.^_0-9A-Za-z-]+$/u;
const encoder = new TextEncoder();

export function isValidSnapshotMediaType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    encoder.encode(value).length <= 255 &&
    MIME_TYPE.test(value)
  );
}

export function compareManifestPathsUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export function createWorkspaceManifest(
  scope: WorkspaceManifestScope,
  entries: readonly WorkspaceManifestEntry[],
): WorkspaceSnapshotManifest {
  const manifest: WorkspaceSnapshotManifest = {
    v: 1,
    kind: 'attn_workspace_snapshot',
    scope,
    entries: entries.map((entry) => ({ ...entry, path: normalizeEntryPath(entry.path) })),
  };
  manifest.entries.sort((a, b) => compareManifestPathsUtf8(a.path, b.path));
  return validateWorkspaceManifest(manifest);
}

export function validateWorkspaceManifest(value: unknown): WorkspaceSnapshotManifest {
  if (!isRecordWithKeys(value, ['v', 'kind', 'scope', 'entries'])) {
    throw new Error('workspace manifest has an invalid schema');
  }
  if (value.v !== 1 || value.kind !== 'attn_workspace_snapshot') {
    throw new Error('workspace manifest version/kind is unsupported');
  }
  if (value.scope !== 'file' && value.scope !== 'entries' && value.scope !== 'workspace') {
    throw new Error('workspace manifest scope is invalid');
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error('workspace manifest must contain at least one entry');
  }
  const entries: WorkspaceManifestEntry[] = [];
  let previousPath: string | undefined;
  const fileIds = new Set<string>();
  const snapshotIds = new Set<string>();
  for (const raw of value.entries) {
    const entry = validateManifestEntry(raw);
    if (previousPath !== undefined && compareManifestPathsUtf8(previousPath, entry.path) >= 0) {
      throw new Error(
        previousPath === entry.path
          ? `workspace manifest contains duplicate path: ${entry.path}`
          : 'workspace manifest entries are not in canonical UTF-8 path order',
      );
    }
    if (fileIds.has(entry.fileId)) throw new Error(`duplicate manifest fileId: ${entry.fileId}`);
    if (snapshotIds.has(entry.snapshotId)) {
      throw new Error(`duplicate manifest snapshotId: ${entry.snapshotId}`);
    }
    fileIds.add(entry.fileId);
    snapshotIds.add(entry.snapshotId);
    previousPath = entry.path;
    entries.push(entry);
  }
  if (
    value.scope === 'file'
    && (entries.filter((entry) => entry.kind === 'markdown' || entry.kind === 'html').length !== 1
      || entries.some((entry) => entry.kind === 'asset' && !isValidSnapshotMediaType(entry.mediaType)))
  ) {
    throw new Error('file-scoped workspace manifest must contain one document and its asset dependencies');
  }
  return {
    v: 1,
    kind: 'attn_workspace_snapshot',
    scope: value.scope,
    entries,
  };
}

export function validateSnapshotPlaintext(value: unknown): SnapshotPlaintext {
  if (!isPlainRecord(value) || typeof value.docType !== 'string') {
    throw new Error('snapshot plaintext has an invalid schema');
  }
  switch (value.docType) {
    case 'markdown': {
      if (!hasOnlyKeys(value, ['docType', 'content', 'anchorIndex']) || typeof value.content !== 'string') {
        throw new Error('markdown snapshot has an invalid schema');
      }
      if (value.anchorIndex !== undefined && !isAnchorIndex(value.anchorIndex)) {
        throw new Error('markdown snapshot anchor index is invalid');
      }
      return {
        docType: 'markdown',
        content: value.content,
        ...(value.anchorIndex === undefined ? {} : { anchorIndex: value.anchorIndex }),
      };
    }
    case 'html': {
      // `annotation` is the client-side capability declaration that makes an
      // HTML doc commentable (html-annotation.md §6). Only the html arm may
      // carry it, only with a known value, and it must survive validation —
      // stripping it here silently downgrades every hosted reviewer to the
      // read-only viewer. Mirrors SnapshotPlaintext::validate() in
      // src/review/model.rs.
      if (
        !hasOnlyKeys(value, ['docType', 'content', 'annotation']) ||
        typeof value.content !== 'string'
      ) {
        throw new Error('HTML snapshot has an invalid schema');
      }
      if (value.annotation !== undefined && value.annotation !== 'html_selectors_v1') {
        throw new Error('HTML snapshot annotation is unsupported');
      }
      return {
        docType: 'html',
        content: value.content,
        ...(value.annotation === undefined ? {} : { annotation: value.annotation }),
      };
    }
    case 'asset': {
      if (
        !isRecordWithKeys(value, ['docType', 'content', 'mediaType', 'encoding']) ||
        value.encoding !== 'base64url' ||
        typeof value.content !== 'string' ||
        !isValidSnapshotMediaType(value.mediaType)
      ) {
        throw new Error('asset snapshot has an invalid schema');
      }
      const decoded = decodeCanonicalBase64Url(value.content);
      decoded.fill(0);
      return {
        docType: 'asset',
        content: value.content,
        mediaType: value.mediaType,
        encoding: 'base64url',
      };
    }
    case 'workspace_manifest':
      if (!isRecordWithKeys(value, ['docType', 'manifest'])) {
        throw new Error('workspace manifest snapshot has an invalid schema');
      }
      return { docType: 'workspace_manifest', manifest: validateWorkspaceManifest(value.manifest) };
    default:
      throw new Error('snapshot plaintext docType is unsupported');
  }
}

export function decodeCanonicalBase64Url(content: string): Uint8Array {
  const decoded = base64UrlDecode(content);
  if (base64UrlEncode(decoded) !== content) {
    decoded.fill(0);
    throw new Error('asset content is not canonical unpadded base64url');
  }
  return decoded;
}

export function assertManifestEntryMatchesBytes(
  entry: WorkspaceManifestEntry,
  bytes: Uint8Array,
  mediaType?: string,
): void {
  if (entry.byteLength !== bytes.length) throw new Error(`byte length mismatch for ${entry.path}`);
  if (entry.contentHash !== contentHash(bytes)) throw new Error(`content hash mismatch for ${entry.path}`);
  if (entry.kind === 'asset') {
    if (!isValidSnapshotMediaType(mediaType) || entry.mediaType !== mediaType) {
      throw new Error(`media type mismatch for ${entry.path}`);
    }
  } else if (mediaType !== undefined || entry.mediaType !== undefined) {
    throw new Error(`non-asset entry cannot declare a media type: ${entry.path}`);
  }
}

function validateManifestEntry(value: unknown): WorkspaceManifestEntry {
  if (!isPlainRecord(value)) throw new Error('workspace manifest entry has an invalid schema');
  const kind = value.kind;
  const expectedKeys = kind === 'asset'
    ? ['fileId', 'snapshotId', 'path', 'kind', 'mediaType', 'byteLength', 'contentHash']
    : ['fileId', 'snapshotId', 'path', 'kind', 'byteLength', 'contentHash'];
  if (!hasExactKeys(value, expectedKeys)) throw new Error('workspace manifest entry fields are invalid');
  if (kind !== 'markdown' && kind !== 'html' && kind !== 'asset') {
    throw new Error('workspace manifest entry kind is invalid');
  }
  if (typeof value.path !== 'string' || normalizeEntryPath(value.path) !== value.path) {
    throw new Error('workspace manifest entry path is not canonical');
  }
  requireBase64UrlBytes(value.fileId, 16, 'manifest fileId');
  requireBase64UrlBytes(value.snapshotId, 16, 'manifest snapshotId');
  requireBase64UrlBytes(value.contentHash, 32, 'manifest contentHash');
  if (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) {
    throw new Error('workspace manifest entry byteLength is invalid');
  }
  if (kind === 'asset') {
    if (!isValidSnapshotMediaType(value.mediaType)) {
      throw new Error('asset manifest entry mediaType is invalid');
    }
  } else if (value.mediaType !== undefined) {
    throw new Error('non-asset manifest entry cannot declare mediaType');
  }
  return value as unknown as WorkspaceManifestEntry;
}

function requireBase64UrlBytes(value: unknown, length: number, label: string): void {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const decoded = decodeCanonicalBase64Url(value);
  const actual = decoded.length;
  decoded.fill(0);
  if (actual !== length) throw new Error(`${label} is invalid`);
}

function isAnchorIndex(value: unknown): value is AnchorIndex {
  if (!isRecordWithKeys(value, ['docHash', 'canonicalEncoding', 'lineCount', 'blocks', 'headings'])) {
    return false;
  }
  return (
    typeof value.docHash === 'string' &&
    value.canonicalEncoding === 'utf8-bytes' &&
    Number.isSafeInteger(value.lineCount) &&
    (value.lineCount as number) >= 0 &&
    Array.isArray(value.blocks) &&
    value.blocks.every(isAnchorBlock) &&
    Array.isArray(value.headings) &&
    value.headings.every(isAnchorHeading)
  );
}

const ANCHOR_BLOCK_KINDS = new Set([
  'heading', 'paragraph', 'list_item', 'code_block', 'blockquote', 'table',
  'thematic_break', 'html', 'math', 'mermaid', 'unknown',
]);

function isAnchorBlock(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const required = [
    'snapshotBlockId', 'contentFingerprint', 'kind', 'byteRange', 'lineRange',
    'headingPath', 'ordinalInParent', 'duplicateOrdinal', 'textHash', 'normalizedTextHash',
  ];
  const optional = ['pmRange', 'previousBlockHash', 'nextBlockHash'];
  if (!required.every((key) => key in value) || !hasOnlyKeys(value, [...required, ...optional])) return false;
  return (
    isNonEmptyString(value.snapshotBlockId) &&
    isNonEmptyString(value.contentFingerprint) &&
    typeof value.kind === 'string' && ANCHOR_BLOCK_KINDS.has(value.kind) &&
    isRange(value.byteRange) && isRange(value.lineRange) &&
    (value.pmRange === undefined || isRange(value.pmRange)) &&
    Array.isArray(value.headingPath) && value.headingPath.every(isAnchorHeadingRef) &&
    isNonNegativeInteger(value.ordinalInParent) &&
    isNonNegativeInteger(value.duplicateOrdinal) &&
    isNonEmptyString(value.textHash) && isNonEmptyString(value.normalizedTextHash) &&
    (value.previousBlockHash === undefined || isNonEmptyString(value.previousBlockHash)) &&
    (value.nextBlockHash === undefined || isNonEmptyString(value.nextBlockHash))
  );
}

function isAnchorHeading(value: unknown): boolean {
  return isRecordWithKeys(value, ['level', 'text', 'textHash', 'line', 'byteRange', 'path']) &&
    Number.isSafeInteger(value.level) && (value.level as number) >= 1 && (value.level as number) <= 6 &&
    typeof value.text === 'string' && isNonEmptyString(value.textHash) &&
    isNonNegativeInteger(value.line) && isRange(value.byteRange) &&
    Array.isArray(value.path) && value.path.every(isAnchorHeadingRef);
}

function isAnchorHeadingRef(value: unknown): boolean {
  return isRecordWithKeys(value, ['level', 'textHash', 'ordinalAtLevel']) &&
    Number.isSafeInteger(value.level) && (value.level as number) >= 1 && (value.level as number) <= 6 &&
    isNonEmptyString(value.textHash) && isNonNegativeInteger(value.ordinalAtLevel);
}

function isRange(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 &&
    isNonNegativeInteger(value[0]) && isNonNegativeInteger(value[1]) && value[1] >= value[0];
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isRecordWithKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  return isPlainRecord(value) && hasExactKeys(value, expected);
}
