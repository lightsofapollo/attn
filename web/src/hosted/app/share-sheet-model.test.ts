import type { WorkspaceEntry } from './types';
import {
  SHARE_TTL_ONE_DAY,
  SHARE_TTL_ONE_HOUR,
  createShareRequest,
  durabilityState,
  entriesForScope,
  formatByteCount,
  maskInviteUrl,
  remainingTimeLabel,
  summarizeEntries,
} from './share-sheet-model';

interface Result { name: string; ok: boolean; detail?: string }
const cases: Array<() => Result> = [];

function test(name: string, run: () => void): void {
  cases.push(() => {
    try {
      run();
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const entries: WorkspaceEntry[] = [
  { path: 'notes.md', kind: 'markdown', presentation: 'editable', sizeBytes: 1536, sizeLabel: '1.5 KB' },
  { path: 'image.png', kind: 'asset', presentation: 'preview', sizeBytes: 2048, sizeLabel: '2 KB' },
  { path: 'data.bin', kind: 'asset', presentation: 'download-only', sizeBytes: 512, sizeLabel: '512 B' },
];

test('durability gate never allows unavailable or quota-pressure modes', () => {
  for (const mode of ['unavailable', 'quota-pressure'] as const) {
    equal(durabilityState(mode, true), {
      allowed: false,
      hardBlocked: true,
      needsAcknowledgement: false,
      canRequestPersistence: false,
    }, `${mode} remains blocked`);
  }
});

test('best-effort and session-only require explicit risk acknowledgement', () => {
  equal(durabilityState('best-effort', false).allowed, false, 'best effort starts locked');
  equal(durabilityState('best-effort', true).allowed, true, 'best effort unlocks after acknowledgement');
  equal(durabilityState('best-effort', false).canRequestPersistence, true, 'best effort can request persistence');
  equal(durabilityState('session-only', true).allowed, true, 'private session can be explicitly acknowledged');
});

test('scope resolution and manifest summary preserve exact paths and sizes', () => {
  const selected = entriesForScope(entries, 'entries', 'notes.md', ['notes.md', 'image.png']);
  equal(selected.map((entry) => entry.path), ['notes.md', 'image.png'], 'selected paths');
  equal(summarizeEntries(entries), {
    entryCount: 3,
    markdownCount: 1,
    previewableAssetCount: 1,
    downloadOnlyAssetCount: 1,
    totalBytes: 4096,
  }, 'manifest summary');
});

test('request construction uses the configured scope, mode, lifetime, and risk flag', () => {
  equal(createShareRequest({
    scope: 'file',
    activePath: 'notes.md',
    selectedPaths: [],
    mode: 'async',
    ttlMs: SHARE_TTL_ONE_HOUR,
    riskAcknowledged: true,
  }), {
    selection: { kind: 'file', path: 'notes.md' },
    mode: 'async',
    ttlMs: SHARE_TTL_ONE_HOUR,
    riskAcknowledged: true,
  }, 'file request');
  equal(createShareRequest({
    scope: 'workspace',
    selectedPaths: [],
    mode: 'hybrid',
    ttlMs: SHARE_TTL_ONE_DAY,
    riskAcknowledged: false,
  })?.selection, { kind: 'workspace' }, 'workspace request');
});

test('invite masking hides fragment material and utility labels remain stable', () => {
  equal(maskInviteUrl('https://attn.sh/review/room#key=secret-value'),
    'https://attn.sh/review/room#key=••••••••••••••••', 'masked invite');
  equal(formatByteCount(1536), '1.5 KB', 'byte count');
  equal(remainingTimeLabel(1_000_000 + 60 * 60 * 1000, 1_000_000), '1 hr remaining', 'remaining time');
});

const results = cases.map((run) => run());
for (const result of results) {
  console.log(`${result.ok ? 'ok' : 'not ok'} - ${result.name}`);
  if (result.detail) console.error(result.detail);
}
if (results.some((result) => !result.ok)) process.exitCode = 1;
