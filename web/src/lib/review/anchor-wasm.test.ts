import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCanonicalAnchorIndex } from './browser-anchor-index';

interface Result { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<Result>> = [];

function test(name: string, fn: () => Promise<void>): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack : String(error),
      };
    }
  });
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const nativeManifest = path.resolve(webRoot, 'Cargo.toml');
const snapshotId = 'native-wasm-equivalence-snapshot';
const wasmUrl = new URL('./anchor-wasm-pkg/attn_anchor_wasm_bg.wasm', import.meta.url);
const markdown = `---
title: Canonical bridge
---

# Alpha & βeta

First **paragraph** with unicode: café 👋.

## Details

- [x] shipped
- repeated value
- repeated value

> A quoted line with *emphasis*.

| Name | Value |
| --- | ---: |
| wasm | exact |

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

---

<aside>raw html</aside>
`;

test('WASM full JSON exactly equals the native Rust/comrak output', async () => {
  // Node cannot fetch file: URLs. Initialize the same generated web module
  // from bytes first; the production loader's subsequent init is idempotent.
  const generated = await import('./anchor-wasm-pkg/attn_anchor_wasm.js');
  await generated.default({ module_or_path: readFileSync(wasmUrl) });
  const bytes = new TextEncoder().encode(markdown);
  const wasmJson = JSON.stringify(await buildCanonicalAnchorIndex(bytes, snapshotId));
  const nativeJson = execFileSync(
    'cargo',
    [
      'run',
      '--quiet',
      '--manifest-path', nativeManifest,
      '--example',
      'native-anchor-index',
      '--',
      snapshotId,
    ],
    { input: bytes, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  ).trim();

  assertEqual(wasmJson, nativeJson, 'serialized AnchorIndex');
  const parsed = JSON.parse(wasmJson) as { blocks: unknown[]; headings: unknown[] };
  if (parsed.blocks.length < 10 || parsed.headings.length < 2) {
    throw new Error(
      `equivalence fixture AST was unexpectedly small (${parsed.blocks.length} blocks, ${parsed.headings.length} headings)`,
    );
  }
});

test('WASM rejects invalid UTF-8 before parsing markdown', async () => {
  let rejected = false;
  try {
    await buildCanonicalAnchorIndex(new Uint8Array([0xff, 0xfe]), snapshotId);
  } catch (error) {
    rejected = String(error).includes('invalid UTF-8');
  }
  if (!rejected) throw new Error('expected an invalid UTF-8 error from WASM');
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`anchor-wasm: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
