// Construct a layered `Anchor` from a ProseMirror selection plus the active
// `AnchorIndex` for the current snapshot (planning issue attn-nnj.3.3).
//
// This module is the *authoring* side counterpart to `resolver.ts` (3.5):
//   - `anchorFromSelection(view, from, to, ctx)` builds the 5-layer Anchor
//     that gets serialized into review events.
//   - The resulting Anchor is consumed by the local resolver and by remote
//     peers when they import the event against their own replica.
//
// Layered Anchor (`planning/collab/data-model.md` §Anchors):
//   * `position`  — byte/line/pm coordinates of the selection.
//   * `quote`     — exact + normalized selected text (omitted when
//     `from === to`, i.e. a block-level cursor).
//   * `block`     — fingerprint + offset of the containing AnchorBlock.
//   * `context`   — ≤160-char prefix/suffix surrounding the selection plus
//                   the prev/next block hashes.
//   * `structure` — headingPath + ordinalInParent of the matched block.
//
// Notes on byte coordinates
// -------------------------
// The canonical persisted coordinate system is UTF-8 byte offsets into the
// owner's markdown source. The frontend does NOT have direct access to those
// bytes from the EditorView; instead it must reconstruct an approximate byte
// mapping by walking the AnchorIndex.blocks alongside the PM doc's top-level
// children.
//
// Concretely: for the block containing the selection start, we use the
// block's `byteRange` from the index for the block-level layers (block /
// structure), and we derive `position.byteRange` by offsetting from the
// block start using the UTF-8 byte length of the in-block text returned by
// `view.state.doc.textBetween(...)`. The resolver's quote/block/structure
// steps don't depend on byte-perfect position values — only line proximity
// (step 8) reads `position.lineRange`, which we derive directly from the
// block's lineRange (start) plus newline counting inside the selection.

import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type {
  Anchor,
  AnchorBlock,
  AnchorHeadingRef,
  AnchorIndex,
  BlockAnchor,
  ContentHash,
  ContextAnchor,
  FileId,
  PositionAnchor,
  QuoteAnchor,
  SnapshotId,
  StructureAnchor,
} from '../types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot-scoped inputs the caller (review composer / decoration plugin)
 * supplies alongside the PM selection. The `index` is the AnchorIndex for
 * the snapshot identified by `snapshotId` / `baseHash` (and must have been
 * built from the same canonical markdown bytes that hash to `baseHash`).
 *
 * @see planning/collab/data-model.md §Anchors
 */
export interface ConstructAnchorContext {
  /** Anchor index built from the snapshot's canonical markdown bytes. */
  index: AnchorIndex;
  /** Opaque shared-document identifier the snapshot belongs to. */
  fileId: FileId;
  /** Snapshot the anchor is being authored against. */
  snapshotId: SnapshotId;
  /**
   * Content hash of the canonical markdown bytes the snapshot was built from
   * (must equal `index.docHash`).
   */
  baseHash: ContentHash;
}

/**
 * Construct a fully-populated `Anchor` from a ProseMirror selection.
 *
 * - When `from < to`: produces a 5-layer anchor (position + quote + block +
 *   context + structure).
 * - When `from === to` (block-level cursor): omits `quote`; the position
 *   layer's byteRange covers the entire containing block; block / context /
 *   structure layers are still populated.
 *
 * The function never throws on an empty document or out-of-range positions;
 * callers receive a best-effort anchor with whatever layers could be built.
 */
export function anchorFromSelection(
  view: EditorView,
  from: number,
  to: number,
  ctx: ConstructAnchorContext,
): Anchor {
  // Defensive: normalise order so callers can hand us either bound first.
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const isBlockLevel = lo === hi;

  // Build a PM↔block mapping over the active index. Top-level children of
  // the PM doc are assumed to correspond 1:1 with `index.blocks` entries
  // emitted in document order by the canonical indexer (see
  // src/review/anchors/index.rs `Walker::visit_block`).
  const blockMap = buildBlockMap(view.state.doc, ctx.index);

  // Find which block (if any) contains the selection start.
  const blockMatch = findBlockAt(blockMap, lo);

  const position = buildPositionLayer(view, lo, hi, blockMap, blockMatch);
  const quote = isBlockLevel ? undefined : buildQuoteLayer(view, lo, hi);
  const block = blockMatch ? buildBlockLayer(view, lo, hi, blockMatch, isBlockLevel) : undefined;
  const context = buildContextLayer(view, lo, hi, blockMap, blockMatch);
  const structure = blockMatch ? buildStructureLayer(blockMatch.block) : undefined;

  const anchor: Anchor = {
    v: 2,
    fileId: ctx.fileId,
    snapshotId: ctx.snapshotId,
    baseHash: ctx.baseHash,
    position,
  };
  if (quote) anchor.quote = quote;
  if (block) anchor.block = block;
  if (context) anchor.context = context;
  if (structure) anchor.structure = structure;
  return anchor;
}

/**
 * Construct a minimal `PositionAnchor` from a PM selection without an
 * `AnchorIndex` in hand. Used by the manual re-anchor flow (attn-nnj.4.8),
 * which sends a PositionAnchor over the `reviewResolveAnchor` IPC; the
 * Rust resolver then reconciles against the current snapshot.
 *
 * The byte / line numbers are PM-derived (canonical-markdown-approximate)
 * — the same fallback path `buildPositionLayer` takes when no block
 * matches. That's sufficient for the resolver because the `pmRange`
 * is the authoritative coordinate for in-process re-anchoring; bytes
 * and lines are best-effort metadata.
 */
export function positionAnchorFromSelection(
  view: EditorView,
  from: number,
  to: number,
): PositionAnchor {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const leadText = view.state.doc.textBetween(0, lo, '\n', '');
  const selectionText = view.state.doc.textBetween(lo, hi, '\n', '');
  const startByte = utf8ByteLength(leadText);
  const endByte = startByte + utf8ByteLength(selectionText);
  // lineRange is 1-indexed in the canonical schema, matching how the
  // Rust resolver expects it. PM is 0-indexed for nodes so we add 1
  // here to be consistent with the rest of this module.
  const startLine = countNewlines(leadText) + 1;
  const endLine = startLine + countNewlines(selectionText);
  return {
    byteRange: [startByte, endByte],
    lineRange: [startLine, endLine],
    pmRange: [lo, hi],
  };
}

// ---------------------------------------------------------------------------
// Internal: PM-block alignment with the AnchorIndex
// ---------------------------------------------------------------------------

/**
 * Per-PM-block bookkeeping built once per call. Aligns each top-level PM
 * child to the matching `AnchorBlock` in the index (positionally; see the
 * file header on PM↔index alignment assumptions).
 */
interface PmBlock {
  /** PM position immediately before this block's opening token. */
  pmStart: number;
  /** PM position immediately after this block's closing token. */
  pmEnd: number;
  /** Inclusive index into `index.blocks`. May be undefined if PM has more
   * top-level children than the index (defensive — should not happen). */
  block: AnchorBlock | undefined;
}

function buildBlockMap(doc: PMNode, index: AnchorIndex): PmBlock[] {
  const result: PmBlock[] = [];
  let pmPos = 0;
  let blockIdx = 0;
  doc.forEach((child) => {
    const pmStart = pmPos;
    const pmEnd = pmPos + child.nodeSize;
    const block = index.blocks[blockIdx];
    result.push({ pmStart, pmEnd, block });
    pmPos = pmEnd;
    blockIdx++;
  });
  return result;
}

interface BlockMatch {
  pm: PmBlock;
  block: AnchorBlock;
}

function findBlockAt(blockMap: PmBlock[], pmPos: number): BlockMatch | undefined {
  for (const pm of blockMap) {
    // pmStart is the boundary BEFORE the block content; pmEnd is the
    // boundary AFTER. A cursor exactly at pmEnd belongs to the *next* block
    // for purposes of block-level anchoring, except at the document tail.
    if (pmPos >= pm.pmStart && pmPos < pm.pmEnd && pm.block) {
      return { pm, block: pm.block };
    }
  }
  // Tail fallback: if pmPos is at or past the last block's pmEnd, anchor to
  // the final block so the empty trailing position still has structural
  // context.
  for (let i = blockMap.length - 1; i >= 0; i--) {
    const candidate = blockMap[i];
    if (candidate?.block) return { pm: candidate, block: candidate.block };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal: layer builders (Position / Quote / Block / Context / Structure)
// ---------------------------------------------------------------------------

function buildPositionLayer(
  view: EditorView,
  from: number,
  to: number,
  blockMap: PmBlock[],
  blockMatch: BlockMatch | undefined,
): PositionAnchor {
  // Block-level cursor: position covers the whole containing block.
  if (from === to && blockMatch) {
    return {
      byteRange: [blockMatch.block.byteRange[0], blockMatch.block.byteRange[1]],
      lineRange: [blockMatch.block.lineRange[0], blockMatch.block.lineRange[1]],
      pmRange: [blockMatch.pm.pmStart, blockMatch.pm.pmEnd],
    };
  }

  // Selection range: derive byte offsets by walking from the block start
  // forward via PM text. This produces "best effort" byte coordinates that
  // approximate canonical markdown bytes (see file header).
  if (blockMatch) {
    const blockTextLead = view.state.doc.textBetween(
      blockMatch.pm.pmStart,
      Math.min(from, blockMatch.pm.pmEnd),
      '\n',
      '',
    );
    const selectionText = view.state.doc.textBetween(from, to, '\n', '');
    const leadBytes = utf8ByteLength(blockTextLead);
    const selBytes = utf8ByteLength(selectionText);
    const startByte = blockMatch.block.byteRange[0] + leadBytes;
    const endByte = startByte + selBytes;
    const startLine = blockMatch.block.lineRange[0] + countNewlines(blockTextLead);
    const endLine = startLine + countNewlines(selectionText);
    return {
      byteRange: [startByte, endByte],
      lineRange: [startLine, endLine],
      pmRange: [from, to],
    };
  }

  // No matching block (empty document, etc.) — fall back to PM-derived bytes.
  const leadText = view.state.doc.textBetween(0, from, '\n', '');
  const selectionText = view.state.doc.textBetween(from, to, '\n', '');
  const startByte = utf8ByteLength(leadText);
  const endByte = startByte + utf8ByteLength(selectionText);
  const startLine = countNewlines(leadText);
  const endLine = startLine + countNewlines(selectionText);
  return {
    byteRange: [startByte, endByte],
    lineRange: [startLine, endLine],
    pmRange: [from, to],
  };
}

const QUOTE_MAX = 256;

function buildQuoteLayer(view: EditorView, from: number, to: number): QuoteAnchor {
  // Use zero-width space as the leaf-boundary separator — matches the
  // pattern used elsewhere in the codebase (popover-anchor.ts companion uses
  // `\n` between blocks). The empty leaf separator keeps mark boundaries
  // from inserting stray characters into the captured text.
  const raw = view.state.doc.textBetween(from, to, '\n', '​');
  const exact = raw.length > QUOTE_MAX ? raw.slice(0, QUOTE_MAX) : raw;
  const normalized = normalizeText(exact);
  return {
    exact,
    exactHash: sha256Base64UrlSync(exact),
    normalized,
    normalizedHash: sha256Base64UrlSync(normalized),
  };
}

function buildBlockLayer(
  view: EditorView,
  from: number,
  to: number,
  match: BlockMatch,
  isBlockLevel: boolean,
): BlockAnchor {
  const blockByteStart = match.block.byteRange[0];
  const blockByteEnd = match.block.byteRange[1];

  let offStart: number;
  let offEnd: number;
  if (isBlockLevel) {
    offStart = 0;
    offEnd = blockByteEnd - blockByteStart;
  } else {
    const lead = view.state.doc.textBetween(
      match.pm.pmStart,
      Math.min(from, match.pm.pmEnd),
      '\n',
      '',
    );
    const selText = view.state.doc.textBetween(from, to, '\n', '');
    offStart = utf8ByteLength(lead);
    offEnd = offStart + utf8ByteLength(selText);
    // Clamp into the block.
    const blockLen = blockByteEnd - blockByteStart;
    offStart = Math.max(0, Math.min(offStart, blockLen));
    offEnd = Math.max(offStart, Math.min(offEnd, blockLen));
  }

  return {
    snapshotBlockId: match.block.snapshotBlockId,
    contentFingerprint: match.block.contentFingerprint,
    kind: match.block.kind,
    offsetInBlockBytes: [offStart, offEnd],
    blockByteRange: [blockByteStart, blockByteEnd],
    blockLineRange: [match.block.lineRange[0], match.block.lineRange[1]],
  };
}

const CONTEXT_MAX = 160;

function buildContextLayer(
  view: EditorView,
  from: number,
  to: number,
  blockMap: PmBlock[],
  blockMatch: BlockMatch | undefined,
): ContextAnchor {
  const prefixRaw = view.state.doc.textBetween(Math.max(0, from - CONTEXT_MAX * 4), from, '\n', '');
  const suffixRaw = view.state.doc.textBetween(
    to,
    Math.min(view.state.doc.content.size, to + CONTEXT_MAX * 4),
    '\n',
    '',
  );
  const prefix = sliceLastChars(prefixRaw, CONTEXT_MAX);
  const suffix = sliceFirstChars(suffixRaw, CONTEXT_MAX);

  const ctx: ContextAnchor = {
    prefix,
    suffix,
    prefixHash: sha256Base64UrlSync(prefix),
    suffixHash: sha256Base64UrlSync(suffix),
  };

  if (blockMatch) {
    const idx = blockMap.indexOf(blockMatch.pm);
    const prev = idx > 0 ? blockMap[idx - 1]?.block : undefined;
    const next = idx >= 0 && idx + 1 < blockMap.length ? blockMap[idx + 1]?.block : undefined;
    if (prev?.textHash) ctx.previousBlockHash = prev.textHash;
    if (next?.textHash) ctx.nextBlockHash = next.textHash;
  }

  return ctx;
}

function buildStructureLayer(block: AnchorBlock): StructureAnchor {
  const headingPath: AnchorHeadingRef[] = block.headingPath.map((h) => ({
    level: h.level,
    textHash: h.textHash,
    ordinalAtLevel: h.ordinalAtLevel,
  }));
  return {
    headingPath,
    ordinalInParent: block.ordinalInParent,
  };
}

// ---------------------------------------------------------------------------
// Internal: utf-8 / line / text helpers
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) n++;
  }
  return n;
}

/**
 * Take up to `max` trailing characters (codepoint-safe). Used for the
 * context prefix so we keep the characters *closest* to the selection.
 */
function sliceLastChars(s: string, max: number): string {
  // Convert to codepoint array so a 4-byte emoji doesn't get cut mid-surrogate.
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(cps.length - max).join('');
}

/**
 * Take up to `max` leading characters (codepoint-safe). Used for the
 * context suffix.
 */
function sliceFirstChars(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, max).join('');
}

/**
 * Normalisation rule that mirrors `normalize_text` in
 * `src/review/anchors/index.rs`:
 *
 *   1. Lowercase.
 *   2. Strip ASCII punctuation (treated like whitespace so "foo,bar" and
 *      "foo bar" normalise the same way).
 *   3. Collapse runs of whitespace into one space.
 *   4. Trim leading/trailing whitespace.
 */
export function normalizeText(input: string): string {
  let out = '';
  let lastWasSpace = true;
  for (const ch of input) {
    if (isUnicodeWhitespace(ch)) {
      if (!lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
      }
      continue;
    }
    if (isAsciiPunctuation(ch)) {
      if (!lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
      }
      continue;
    }
    out += ch.toLowerCase();
    lastWasSpace = false;
  }
  if (out.endsWith(' ')) out = out.slice(0, -1);
  return out;
}

function isUnicodeWhitespace(ch: string): boolean {
  // \s in JS covers ASCII + many unicode whitespace categories; aligns with
  // Rust's `char::is_whitespace` close enough for the resolver's tolerance.
  return /^\s$/u.test(ch);
}

function isAsciiPunctuation(ch: string): boolean {
  if (ch.length === 0) return false;
  const code = ch.charCodeAt(0);
  // ASCII punctuation ranges per `char::is_ascii_punctuation` in Rust:
  // !"#$%&'()*+,-./, :;<=>?@, [\]^_`, {|}~
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

// ---------------------------------------------------------------------------
// Internal: SHA-256 / base64url
//
// We mirror the format used by the Rust side for `textHash` /
// `normalizedTextHash` (sha256 hex), and use base64url for the quote /
// context hashes which are bounded short strings. The native `crypto.subtle`
// API is async; for the synchronous return shape this function needs, we
// fall back to a deterministic pure-JS sha256. That keeps the harness test
// running under tsx without depending on Web Crypto.
// ---------------------------------------------------------------------------

function sha256Base64UrlSync(input: string): string {
  const bytes = TEXT_ENCODER.encode(input);
  const digest = sha256(bytes);
  return bytesToBase64Url(digest);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  // btoa is available in browsers + node ≥ 16 + tsx, which covers every
  // environment this module runs in (the webview, the dev mock harness, and
  // tsx-based unit tests).
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Pure-JS SHA-256 (FIPS 180-4). Adapted from public-domain references.
// ---------------------------------------------------------------------------

const K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256(message: Uint8Array): Uint8Array {
  // Pre-processing: padding.
  const bitLen = message.length * 8;
  const padLen = (56 - ((message.length + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(message.length + 1 + padLen + 8);
  padded.set(message, 0);
  padded[message.length] = 0x80;
  // 64-bit big-endian length.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, hi, false);
  dv.setUint32(padded.length - 4, lo, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = dv.getUint32(chunk + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15]!;
      const w2 = W[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [H[0]!, H[1]!, H[2]!, H[3]!, H[4]!, H[5]!, H[6]!, H[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, H[i]!, false);
  return out;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
