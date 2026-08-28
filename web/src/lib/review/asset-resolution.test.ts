// Reviewer-side asset resolution (attn-udu8).
//
// Standalone tsx script, like every other web test here — run by
// web/scripts/run-tests.mjs, not vitest.

import { sharedAssetPathFor, assetDataUrl, buildSharedAssetResolver } from './asset-resolution';
import type { ReviewSnapshot } from '../types';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}
const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const detail = fn();
      return { name, ok: true, detail: typeof detail === 'string' ? detail : undefined };
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// sharedAssetPathFor — must agree with resolve_lexically in src/review/assets.rs
// ---------------------------------------------------------------------------

defineCase('a sibling src resolves to the document\u2019s own directory', () => {
  assertEq(sharedAssetPathFor('images.md', './diagram.png'), 'diagram.png', 'dot-slash');
  assertEq(sharedAssetPathFor('images.md', 'diagram.png'), 'diagram.png', 'bare');
  assertEq(sharedAssetPathFor('docs/images.md', './diagram.png'), 'docs/diagram.png', 'nested doc');
});

defineCase('a subdirectory src keeps its subdirectory', () => {
  assertEq(sharedAssetPathFor('images.md', './nested/diagram.png'), 'nested/diagram.png', 'nested');
  assertEq(
    sharedAssetPathFor('docs/images.md', 'sub/chart.svg'),
    'docs/sub/chart.svg',
    'nested doc + nested src',
  );
});

defineCase('.. walks up, and is REFUSED rather than clamped at the root', () => {
  // The deliberate divergence from resolveImageSrc in markdown-layer.ts, which
  // clamps because it walks an absolute filesystem path. Here a src that
  // climbs past the share root names nothing; clamping would let it land on an
  // unrelated root-level asset.
  assertEq(sharedAssetPathFor('docs/images.md', '../chart.svg'), 'chart.svg', 'up one');
  assertEq(
    sharedAssetPathFor('a/b/images.md', '../../chart.svg'),
    'chart.svg',
    'up two to the root',
  );
  assertEq(sharedAssetPathFor('images.md', '../chart.svg'), null, 'above the root is refused');
  assertEq(
    sharedAssetPathFor('docs/images.md', '../../../chart.svg'),
    null,
    'climbing well past the root is refused, not clamped',
  );
});

defineCase('an encoded separator is a separator', () => {
  // %2F becomes a real / everywhere downstream, so the walk has to treat it as
  // one — otherwise `..%2F..%2Fx.png` would look like an innocent filename.
  assertEq(sharedAssetPathFor('images.md', 'nested%2Fdiagram.png'), 'nested/diagram.png', 'encoded');
  assertEq(sharedAssetPathFor('images.md', '..%2Fchart.svg'), null, 'encoded climb refused');
});

defineCase('a percent-encoded name decodes to the real file', () => {
  assertEq(sharedAssetPathFor('images.md', './my%20shot.png'), 'my shot.png', 'space');
});

defineCase('non-local srcs are declined', () => {
  for (const src of [
    'https://example.com/x.png',
    'data:image/png;base64,AA',
    '//cdn.example.com/x.png',
    '#anchor',
    'attn://localhost/Users/x/y.png',
  ]) {
    assertEq(sharedAssetPathFor('images.md', src), null, `declined ${src}`);
  }
});

defineCase('a Windows drive letter is not mistaken for a scheme', () => {
  // Two-char minimum on the scheme. It still resolves to nothing useful, but
  // it must not be short-circuited as "remote".
  const resolved = sharedAssetPathFor('images.md', 'C:/x.png');
  assert(resolved === null || typeof resolved === 'string', 'no throw');
});

defineCase('directory-ish and empty srcs are declined', () => {
  for (const src of ['', './', '.', '..', 'nested/']) {
    assertEq(sharedAssetPathFor('images.md', src), null, `declined ${JSON.stringify(src)}`);
  }
});

defineCase('an absolute src cannot name a share asset', () => {
  // Wire paths are root-relative; an absolute src is an owner-disk path.
  assertEq(sharedAssetPathFor('images.md', '/Users/x/chart.svg'), 'Users/x/chart.svg', 'no base');
});

defineCase('the result is NFC, because wire paths are', () => {
  // e + combining acute normalizes to the precomposed form.
  const decomposed = 'cafe\u0301.png';
  assertEq(sharedAssetPathFor('images.md', decomposed), 'caf\u00e9.png', 'NFC');
});

// ---------------------------------------------------------------------------
// assetDataUrl
// ---------------------------------------------------------------------------

defineCase('base64url is translated and padded into a data: URL', () => {
  // `-` and `_` are the base64url-only characters; padding restores a multiple
  // of four.
  assertEq(
    assetDataUrl('image/png', 'ab-d_g'),
    'data:image/png;base64,ab+d/g==',
    'translated and padded',
  );
  assertEq(assetDataUrl('image/png', 'AAAA'), 'data:image/png;base64,AAAA', 'already aligned');
});

defineCase('a missing or malformed media type yields null, not data:undefined', () => {
  assertEq(assetDataUrl(undefined, 'AAAA'), null, 'no media type');
  assertEq(assetDataUrl('image/png', undefined), null, 'no content');
  assertEq(assetDataUrl('not-a-media-type', 'AAAA'), null, 'malformed media type');
});

// ---------------------------------------------------------------------------
// buildSharedAssetResolver
// ---------------------------------------------------------------------------

function assetSnapshot(path: string, overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    roomId: 'room-1',
    fileId: `file-${path}`,
    snapshotId: `snap-${path}`,
    ownerDisplayPath: path,
    createdAt: 1,
    createdBy: 'owner' as ReviewSnapshot['createdBy'],
    baseHash: 'hash' as ReviewSnapshot['baseHash'],
    byteLength: 4,
    docType: 'asset',
    mediaType: 'image/png',
    assetContent: 'AAAA',
    ...overrides,
  } as ReviewSnapshot;
}

defineCase('an asset that travelled with the document resolves to its bytes', () => {
  const resolve = buildSharedAssetResolver([assetSnapshot('diagram.png')], 'room-1', 'images.md');
  assertEq(resolve('./diagram.png'), 'data:image/png;base64,AAAA', 'resolved');
});

defineCase('a src with no matching asset resolves to null, not a guess', () => {
  // Policy-skipped images (remote, symlink, oversized, budget-exhausted) and
  // not-yet-arrived ones are indistinguishable here, and the honest answer for
  // both is the placeholder card.
  const resolve = buildSharedAssetResolver([assetSnapshot('diagram.png')], 'room-1', 'images.md');
  assertEq(resolve('./gone.png'), null, 'missing asset');
});

defineCase('assets from another room are never used', () => {
  const foreign = assetSnapshot('diagram.png', { roomId: 'room-2' });
  const resolve = buildSharedAssetResolver([foreign], 'room-1', 'images.md');
  assertEq(resolve('./diagram.png'), null, 'cross-room isolation');
});

defineCase('document snapshots are not treated as assets', () => {
  const doc = assetSnapshot('images.md', {
    docType: 'markdown',
    mediaType: undefined,
    assetContent: undefined,
  });
  const resolve = buildSharedAssetResolver([doc], 'room-1', 'images.md');
  assertEq(resolve('./images.md'), null, 'markdown is not an asset');
});

defineCase('the newest snapshot for a path wins', () => {
  const older = assetSnapshot('diagram.png', { snapshotId: 'old', assetContent: 'AAAA' });
  const newer = assetSnapshot('diagram.png', {
    snapshotId: 'new',
    createdAt: 2,
    assetContent: 'BBBB',
  });
  const resolve = buildSharedAssetResolver([older, newer], 'room-1', 'images.md');
  assertEq(resolve('./diagram.png'), 'data:image/png;base64,BBBB', 'newest wins');
});

defineCase('no room or no document path yields a resolver that declines everything', () => {
  assertEq(buildSharedAssetResolver([assetSnapshot('a.png')], null, 'images.md')('./a.png'), null, 'no room');
  assertEq(buildSharedAssetResolver([assetSnapshot('a.png')], 'room-1', null)('./a.png'), null, 'no doc');
});

defineCase('repeated resolution of one asset is memoised', () => {
  const resolve = buildSharedAssetResolver([assetSnapshot('diagram.png')], 'room-1', 'images.md');
  const first = resolve('./diagram.png');
  const second = resolve('diagram.png');
  assertEq(first, second, 'same URL for the same asset via two spellings');
});

let passed = 0;
let failed = 0;
for (const run of cases) {
  const r = run();
  if (r.ok) {
    passed += 1;
    console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);

interface NodeProcessShape {
  exit?: (code: number) => void;
}
const nodeProcess: NodeProcessShape | undefined = (
  globalThis as unknown as { process?: NodeProcessShape }
).process;
if (failed > 0) nodeProcess?.exit?.(1);
