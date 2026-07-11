import type { AnchorIndex } from '../types';

interface AnchorWasmModule {
  default(): Promise<unknown>;
  build_anchor_index_json(markdownBytes: Uint8Array, snapshotId: string): string;
}

let modulePromise: Promise<AnchorWasmModule> | undefined;

/**
 * Load the canonical Rust/comrak indexer only when a browser-owned snapshot
 * needs it. Keeping the generated package behind this dynamic import avoids
 * adding WASM or comrak to unrelated hosted route entry chunks.
 */
function loadAnchorWasm(): Promise<AnchorWasmModule> {
  modulePromise ??= import('./anchor-wasm-pkg/attn_anchor_wasm.js').then(async (wasm) => {
    await wasm.default();
    return wasm;
  });
  return modulePromise;
}

/** Build the exact native wire-format AnchorIndex for canonical UTF-8 bytes. */
export async function buildCanonicalAnchorIndex(
  markdown: Uint8Array,
  snapshotId: string,
): Promise<AnchorIndex> {
  const wasm = await loadAnchorWasm();
  return JSON.parse(wasm.build_anchor_index_json(markdown, snapshotId)) as AnchorIndex;
}
