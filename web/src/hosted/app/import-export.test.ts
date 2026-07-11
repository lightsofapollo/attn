import { zipSync, unzipSync } from 'fflate';
import { buildWorkspaceZip, zipFileName } from './export-zip';
import {
  MAX_IMPORT_FILE_BYTES,
  expandPicked,
  expandZip,
  importName,
  kindForFile,
  toImportFiles,
  type PickedFile,
} from './import-files';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void | string> | void | string): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${message}: expected an error`);
}

function picked(name: string, bytes: Uint8Array, relativePath?: string, type = ''): PickedFile {
  return { name, bytes, type, ...(relativePath === undefined ? {} : { relativePath }) };
}

defineCase('kind and name mapping', () => {
  assertEqual(kindForFile('notes.md'), 'markdown', 'md');
  assertEqual(kindForFile('README.markdown'), 'markdown', 'markdown ext');
  assertEqual(kindForFile('image.png'), 'asset', 'png');
  assertEqual(importName([picked('direction.md', new Uint8Array(1))]), 'direction', 'single md name');
  assertEqual(
    importName([
      picked('a.md', new Uint8Array(1), 'folio/a.md'),
      picked('b.md', new Uint8Array(1), 'folio/b.md'),
    ]),
    'folio',
    'folder name wins for multi-file',
  );
});

defineCase('oversized and traversal inputs are rejected loudly', () => {
  assertThrows(
    () => toImportFiles([picked('huge.bin', new Uint8Array(MAX_IMPORT_FILE_BYTES + 1))]),
    'oversize rejected',
  );
  assertThrows(
    () => toImportFiles([picked('evil.md', new Uint8Array(1), '../evil.md')]),
    'traversal rejected',
  );
  assertThrows(
    () => toImportFiles([picked('abs.md', new Uint8Array(1), '/abs.md')]),
    'absolute rejected',
  );
});

defineCase('zip expansion preserves nested paths and skips junk entries', async () => {
  const zip = zipSync({
    'docs/notes.md': new TextEncoder().encode('# notes'),
    'images/pixel.png': new Uint8Array([137, 80, 78, 71]),
    '__MACOSX/docs/._notes.md': new Uint8Array([0]),
    'docs/.DS_Store': new Uint8Array([0]),
  });
  const files = await expandZip(picked('folio.zip', zip));
  assertEqual(files.length, 2, 'junk skipped');
  const imports = toImportFiles(files);
  const notes = imports.find((file) => file.path === 'docs/notes.md');
  assert(notes, 'nested markdown path preserved');
  assertEqual(notes.kind, 'markdown', 'markdown kind');
  const pixel = imports.find((file) => file.path === 'images/pixel.png');
  assert(pixel, 'nested asset path preserved');
  assertEqual(pixel.mediaType, 'image/png', 'media type from extension');
});

defineCase('zip with traversal paths aborts the whole import', async () => {
  const zip = zipSync({ '../escape.md': new TextEncoder().encode('bad') });
  const files = await expandZip(picked('evil.zip', zip));
  assertThrows(() => toImportFiles(files), 'zip traversal rejected');
});

defineCase('corrupt zip is a clear error', async () => {
  let threw = false;
  try {
    await expandZip(picked('broken.zip', new Uint8Array([1, 2, 3, 4])));
  } catch {
    threw = true;
  }
  assert(threw, 'corrupt zip rejected');
});

defineCase('expandPicked mixes zips and plain files', async () => {
  const zip = zipSync({ 'inner.md': new TextEncoder().encode('inner') });
  const files = await expandPicked([
    picked('outer.md', new TextEncoder().encode('outer')),
    picked('bundle.zip', zip),
  ]);
  assertEqual(files.length, 2, 'zip expanded inline');
  assertEqual(files[0]!.name, 'outer.md', 'plain file passes through');
  assertEqual(files[1]!.name, 'inner.md', 'zip content extracted');
});

defineCase('workspace zip export round-trips exact bytes and paths', async () => {
  const image = new Uint8Array(1024).map((_, index) => index & 0xff);
  const zip = await buildWorkspaceZip([
    { path: 'index.md', bytes: new TextEncoder().encode('# hi'), kind: 'markdown' },
    { path: 'deep/nested/pic.png', bytes: image, kind: 'asset', mediaType: 'image/png' },
  ]);
  const round = unzipSync(zip);
  assertEqual(Object.keys(round).length, 2, 'both files in the archive');
  assertEqual(new TextDecoder().decode(round['index.md']!), '# hi', 'markdown bytes');
  const pic = round['deep/nested/pic.png']!;
  assertEqual(pic.length, image.length, 'asset byte length');
  assert(pic.every((byte, index) => byte === image[index]), 'asset bytes identical');
});

defineCase('zip file names are sanitized', () => {
  assertEqual(zipFileName('Product direction'), 'Product-direction.zip', 'spaces to dashes');
  assertEqual(zipFileName('///'), 'workspace.zip', 'degenerate names fall back');
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`import-export: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
