// TypeScript mirror of the Rust anchor resolver (planning issue attn-nnj.3.5).
//
// The canonical 8-step algorithm lives in
// `planning/collab/data-model.md` §Anchor Resolution. The combine + decide
// stage is pinned by `planning/collab/amendments.md` Decision #15
// ("run-all + combine"). The Rust implementation in
// `src/review/anchors/resolve.rs` (issue 3.4) is the canonical reference —
// this module MUST produce identical verdicts for identical inputs.
//
// What this file owns:
//   * `resolveAnchor(anchor, ctx)` — the single entry point a decoration
//     plugin or panel selector calls with a serialized Anchor + the current
//     local replica (anchor index + UTF-8 markdown bytes + content hash).
//   * Internal candidate generators for each of the 8 spec'd steps. Steps
//     that have no useful signal for a particular Anchor return an empty
//     candidate list.
//   * The combine/dedup/decide pipeline.
//
// What this file does NOT own:
//   * ProseMirror step mapping (`mapped_through_local_steps`). The
//     `pmSteps` field on `ResolveContext` is intentionally opaque (`unknown`)
//     until a step-journal wire format is agreed; step 2 always returns
//     no candidate today.
//   * Re-hashing the markdown — `ResolveContext.currentHash` is computed by
//     the caller (Rust ships it on the snapshot, the dev/mock pipeline
//     computes it via `crypto.subtle.digest`).
//   * Wiring the resolver to the review store / decoration plugin.
//     Phase 2 issue 4.6 does that.

import type {
  Anchor,
  AnchorBlock,
  AnchorIndex,
  ContentHash,
  PositionAnchor,
  ResolvedAnchor,
  ResolvedAnchorCandidate,
} from '../types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inputs required to resolve an `Anchor` against a local replica.
 *
 * @see planning/collab/data-model.md §Anchor Resolution
 */
export interface ResolveContext {
  /** Anchor index built from the current local markdown bytes. */
  currentIndex: AnchorIndex;
  /** Raw canonical UTF-8 markdown bytes for the current local replica. */
  currentMarkdownBytes: Uint8Array;
  /** Content hash of `currentMarkdownBytes` (caller-precomputed). */
  currentHash: ContentHash;
  /**
   * Optional local ProseMirror step journal mapping `anchor.baseHash` →
   * `currentHash`. Wire format is intentionally undefined for now — step 2
   * is stubbed and always returns no candidate. Once a journal lands, this
   * type will narrow.
   */
  pmSteps?: unknown;
}

/** Confidence weights from `planning/collab/data-model.md` §Anchor Resolution. */
const CONF_EXACT = 1.0;
const CONF_LOCAL_STEPS = 0.98;
const CONF_QUOTE_UNIQUE = 0.9;
const CONF_BLOCK_FINGERPRINT = 0.85;
const CONF_STRUCTURE_QUOTE = 0.8;
const CONF_CONTEXT = 0.7;
const CONF_FUZZY_MAX = 0.75;
const CONF_FUZZY_MIN = 0.5;
const CONF_LINE_PROXIMITY_MAX = 0.35;

/** Decision-tree thresholds (mirror of Rust + amendments.md Decision #15). */
const REMAPPED_THRESHOLD = 0.7;
const AMBIGUOUS_BAND = 0.1;
const AMBIGUOUS_FLOOR = 0.5;
const FALLBACK_THRESHOLD = 0.35;

/**
 * Resolve an anchor authored against `anchor.baseHash` into a position in
 * the local replica described by `ctx`.
 *
 * Runs all eight steps, dedups candidates by `currentRange`, then applies
 * the combine+decide rules from `amendments.md` Decision #15.
 */
export function resolveAnchor(anchor: Anchor, ctx: ResolveContext): ResolvedAnchor {
  // Step 1: base-hash exact. If the current bytes hash matches what the
  // anchor was authored against, the position is canonical — no need to run
  // the rest of the pipeline.
  if (anchor.baseHash === ctx.currentHash) {
    return {
      status: 'exact',
      confidence: CONF_EXACT,
      currentRange: clonePosition(anchor.position),
      reason: 'base_hash_match',
    };
  }

  const candidates: InternalCandidate[] = [];

  // Step 2: mapped through local ProseMirror steps. Stubbed — see
  // `ResolveContext.pmSteps`. When wired, a hit returns confidence 0.98 with
  // reason 'mapped_through_local_steps' and short-circuits like step 1.
  void ctx.pmSteps;

  // Steps 3–8: each step pushes zero or more candidates with a reason and
  // an `exactReason` for the typed verdict (when the candidate becomes the
  // winner).
  pushUniqueExactQuote(candidates, anchor, ctx);
  pushBlockFingerprint(candidates, anchor, ctx);
  pushStructureQuote(candidates, anchor, ctx);
  pushContextMatch(candidates, anchor, ctx);
  pushFuzzyQuote(candidates, anchor, ctx);
  pushLineProximity(candidates, anchor, ctx);

  return decide(candidates);
}

// ---------------------------------------------------------------------------
// Internal candidate representation
// ---------------------------------------------------------------------------

type RemappedReason =
  | 'quote_match'
  | 'block_fingerprint_match'
  | 'structure_quote_match'
  | 'context_match'
  | 'fuzzy_quote_match';

interface InternalCandidate {
  confidence: number;
  currentRange: PositionAnchor;
  /** Human-readable description used in `ResolvedAnchorCandidate.reason`. */
  reason: string;
  /** Typed reason emitted when this candidate is the sole winner. */
  exactReason: RemappedReason;
  /** Short snippet shown in the ambiguous picker UI. */
  preview: string;
}

// ---------------------------------------------------------------------------
// Decision pipeline (mirror Rust)
// ---------------------------------------------------------------------------

function decide(raw: InternalCandidate[]): ResolvedAnchor {
  if (raw.length === 0) {
    return { status: 'stale', reason: 'no_candidates' };
  }

  // (1) Dedup by currentRange — keep the highest-confidence reason. Order of
  // first-insertion is preserved so the preview stays the earliest hit.
  const deduped = dedupByRange(raw);

  // (2) Sort by confidence descending. Stable on ties so the highest-priority
  // step (registered earliest) wins.
  deduped.sort((a, b) => b.confidence - a.confidence);

  const top = deduped[0]!;

  // (3) Exact handled in resolveAnchor before steps 3–8 run; no candidate
  // here ever reaches 1.00. Keep the branch for symmetry with Rust.
  if (top.confidence >= CONF_EXACT) {
    return {
      status: 'exact',
      confidence: CONF_EXACT,
      currentRange: clonePosition(top.currentRange),
      reason: 'base_hash_match',
    };
  }

  // (4) & (5): ambiguous vs single-remapped distinction lives at ≥ 0.70.
  const strong = deduped.filter((c) => c.confidence >= REMAPPED_THRESHOLD);

  if (strong.length >= 2) {
    const [first, second] = strong;
    if (first && second && first.confidence - second.confidence < AMBIGUOUS_BAND) {
      const picker = deduped.filter((c) => c.confidence >= AMBIGUOUS_FLOOR);
      return {
        status: 'ambiguous',
        candidates: picker.map(toExternal),
        reason: `top_two_within_${AMBIGUOUS_BAND.toFixed(2)}`,
      };
    }
  }

  if (strong.length >= 1) {
    return {
      status: 'remapped',
      confidence: top.confidence,
      currentRange: clonePosition(top.currentRange),
      reason: top.exactReason,
    };
  }

  // (6) Weak-but-present fallback band.
  if (top.confidence >= FALLBACK_THRESHOLD) {
    return {
      status: 'remapped',
      confidence: top.confidence,
      currentRange: clonePosition(top.currentRange),
      reason: top.exactReason,
    };
  }

  // (7) Nothing usable.
  return { status: 'stale', reason: 'all_below_threshold' };
}

function dedupByRange(raw: InternalCandidate[]): InternalCandidate[] {
  const byKey = new Map<string, InternalCandidate>();
  for (const cand of raw) {
    const key = rangeKey(cand.currentRange);
    const prior = byKey.get(key);
    if (!prior || cand.confidence > prior.confidence) {
      byKey.set(key, cand);
    }
  }
  return Array.from(byKey.values());
}

function rangeKey(p: PositionAnchor): string {
  return `${p.byteRange[0]}:${p.byteRange[1]}`;
}

function toExternal(c: InternalCandidate): ResolvedAnchorCandidate {
  return {
    confidence: c.confidence,
    currentRange: clonePosition(c.currentRange),
    reason: c.reason,
    preview: c.preview,
  };
}

function clonePosition(p: PositionAnchor): PositionAnchor {
  const out: PositionAnchor = {
    byteRange: [p.byteRange[0], p.byteRange[1]],
    lineRange: [p.lineRange[0], p.lineRange[1]],
  };
  if (p.pmRange) {
    out.pmRange = [p.pmRange[0], p.pmRange[1]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 3: unique exact quote match
// ---------------------------------------------------------------------------

function pushUniqueExactQuote(
  out: InternalCandidate[],
  anchor: Anchor,
  ctx: ResolveContext,
): void {
  const quote = anchor.quote;
  if (!quote || quote.exact.length === 0) return;

  const needle = encodeUtf8(quote.exact);
  if (needle.length === 0) return;

  const hits = findAllByteOccurrences(ctx.currentMarkdownBytes, needle);
  if (hits.length !== 1) return;

  const start = hits[0]!;
  const end = start + needle.length;
  const position = positionFromByteRange(ctx, start, end);
  out.push({
    confidence: CONF_QUOTE_UNIQUE,
    currentRange: position,
    reason: 'quote_match',
    exactReason: 'quote_match',
    preview: makePreview(quote.exact),
  });
}

// ---------------------------------------------------------------------------
// Step 4: block fingerprint match
// ---------------------------------------------------------------------------

function pushBlockFingerprint(
  out: InternalCandidate[],
  anchor: Anchor,
  ctx: ResolveContext,
): void {
  const block = anchor.block;
  if (!block) return;

  const matching: AnchorBlock[] = ctx.currentIndex.blocks.filter(
    (b) => b.contentFingerprint === block.contentFingerprint && b.kind === block.kind,
  );

  for (const match of matching) {
    const range = clampOffsetIntoBlock(match, block.offsetInBlockBytes);
    const position = positionFromByteRange(ctx, range[0], range[1]);
    out.push({
      confidence: CONF_BLOCK_FINGERPRINT,
      currentRange: position,
      reason: 'block_fingerprint_match',
      exactReason: 'block_fingerprint_match',
      preview: makePreviewFromBytes(ctx.currentMarkdownBytes, range[0], range[1]),
    });
  }
}

function clampOffsetIntoBlock(
  block: AnchorBlock,
  offset: [number, number],
): [number, number] {
  const blockStart = block.byteRange[0];
  const blockEnd = block.byteRange[1];
  const blockLen = blockEnd - blockStart;
  const offStart = Math.max(0, Math.min(offset[0], blockLen));
  const offEnd = Math.max(offStart, Math.min(offset[1], blockLen));
  return [blockStart + offStart, blockStart + offEnd];
}

// ---------------------------------------------------------------------------
// Step 5: structure + quote match
// ---------------------------------------------------------------------------

function pushStructureQuote(
  out: InternalCandidate[],
  anchor: Anchor,
  ctx: ResolveContext,
): void {
  const structure = anchor.structure;
  const quote = anchor.quote;
  if (!structure || !quote || quote.exact.length === 0) return;

  const needle = encodeUtf8(quote.exact);
  if (needle.length === 0) return;

  // Restrict the search to blocks under the same heading path.
  const targets = ctx.currentIndex.blocks.filter((b) =>
    headingPathEquals(b.headingPath, structure.headingPath),
  );
  if (targets.length === 0) return;

  for (const block of targets) {
    const blockBytes = ctx.currentMarkdownBytes.subarray(
      block.byteRange[0],
      block.byteRange[1],
    );
    const localHits = findAllByteOccurrences(blockBytes, needle);
    for (const localStart of localHits) {
      const start = block.byteRange[0] + localStart;
      const end = start + needle.length;
      const position = positionFromByteRange(ctx, start, end);
      out.push({
        confidence: CONF_STRUCTURE_QUOTE,
        currentRange: position,
        reason: 'structure_quote_match',
        exactReason: 'structure_quote_match',
        preview: makePreview(quote.exact),
      });
    }
  }
}

function headingPathEquals(
  a: ReadonlyArray<{ level: number; textHash: string; ordinalAtLevel: number }>,
  b: ReadonlyArray<{ level: number; textHash: string; ordinalAtLevel: number }>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.level !== y.level || x.textHash !== y.textHash || x.ordinalAtLevel !== y.ordinalAtLevel) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step 6: prefix/suffix context match
// ---------------------------------------------------------------------------

function pushContextMatch(
  out: InternalCandidate[],
  anchor: Anchor,
  ctx: ResolveContext,
): void {
  const context = anchor.context;
  if (!context) return;

  const prefix = encodeUtf8(context.prefix);
  const suffix = encodeUtf8(context.suffix);
  if (prefix.length === 0 && suffix.length === 0) return;

  // Search for either:
  //   prefix + ??? + suffix → the bytes between are the anchored selection.
  //   prefix alone or suffix alone → degenerate; use the matched edge.
  const prefixHits = prefix.length > 0
    ? findAllByteOccurrences(ctx.currentMarkdownBytes, prefix)
    : [];
  const suffixHits = suffix.length > 0
    ? findAllByteOccurrences(ctx.currentMarkdownBytes, suffix)
    : [];

  // Quote length is preferred to size the gap. Fall back to original range.
  const expectedGap = anchor.quote
    ? encodeUtf8(anchor.quote.exact).length
    : Math.max(0, anchor.position.byteRange[1] - anchor.position.byteRange[0]);

  if (prefix.length > 0 && suffix.length > 0) {
    for (const pStart of prefixHits) {
      const selStart = pStart + prefix.length;
      for (const sStart of suffixHits) {
        if (sStart <= selStart) continue;
        const gap = sStart - selStart;
        // Accept any gap within 50% of the expected size (or just non-negative
        // if no expectation). Larger drifts get scored down via the fuzzy
        // step instead.
        if (expectedGap > 0 && Math.abs(gap - expectedGap) > Math.max(8, expectedGap)) {
          continue;
        }
        const position = positionFromByteRange(ctx, selStart, sStart);
        out.push({
          confidence: CONF_CONTEXT,
          currentRange: position,
          reason: 'context_match',
          exactReason: 'context_match',
          preview: makePreviewFromBytes(ctx.currentMarkdownBytes, selStart, sStart),
        });
      }
    }
    return;
  }

  if (prefix.length > 0) {
    for (const pStart of prefixHits) {
      const selStart = pStart + prefix.length;
      const selEnd = Math.min(ctx.currentMarkdownBytes.length, selStart + Math.max(1, expectedGap));
      const position = positionFromByteRange(ctx, selStart, selEnd);
      out.push({
        confidence: CONF_CONTEXT,
        currentRange: position,
        reason: 'context_match',
        exactReason: 'context_match',
        preview: makePreviewFromBytes(ctx.currentMarkdownBytes, selStart, selEnd),
      });
    }
    return;
  }

  for (const sStart of suffixHits) {
    const selEnd = sStart;
    const selStart = Math.max(0, selEnd - Math.max(1, expectedGap));
    const position = positionFromByteRange(ctx, selStart, selEnd);
    out.push({
      confidence: CONF_CONTEXT,
      currentRange: position,
      reason: 'context_match',
      exactReason: 'context_match',
      preview: makePreviewFromBytes(ctx.currentMarkdownBytes, selStart, selEnd),
    });
  }
}

// ---------------------------------------------------------------------------
// Step 7: fuzzy quote match (bounded Levenshtein)
// ---------------------------------------------------------------------------

function pushFuzzyQuote(
  out: InternalCandidate[],
  anchor: Anchor,
  ctx: ResolveContext,
): void {
  const quote = anchor.quote;
  if (!quote || quote.exact.length === 0) return;

  // Use the normalized form if available — it tracks lighter edits better.
  const needleStr = quote.normalized.length > 0 ? quote.normalized : quote.exact;
  const needle = encodeUtf8(needleStr);
  if (needle.length === 0) return;

  // Cap distance at quote.length / 5 per the spec. For very short quotes the
  // cap collapses to 0; treat that as "exact-only" — handled by step 3.
  const maxDistance = Math.floor(needleStr.length / 5);
  if (maxDistance === 0) return;

  // Bounded sliding window over the current bytes. We use a window of the
  // needle's length ± maxDistance so insertions/deletions still register.
  const bytes = ctx.currentMarkdownBytes;
  const minLen = Math.max(1, needle.length - maxDistance);
  const maxLen = needle.length + maxDistance;

  let best: { start: number; end: number; distance: number } | null = null;
  // Step through codepoint boundaries to avoid mid-utf8 slices.
  for (let i = 0; i < bytes.length; i++) {
    if (!isUtf8Boundary(bytes, i)) continue;
    for (let len = minLen; len <= maxLen; len++) {
      const end = i + len;
      if (end > bytes.length) break;
      if (!isUtf8Boundary(bytes, end)) continue;
      // Decode and compare. We bail out of expensive Levenshtein on length
      // skew alone: if |len - needle.length| > maxDistance, distance is
      // guaranteed to exceed the cap.
      const candidateBytes = bytes.subarray(i, end);
      const candidateStr = decodeUtf8(candidateBytes);
      const distance = boundedLevenshtein(candidateStr, needleStr, maxDistance);
      if (distance === null) continue;
      if (!best || distance < best.distance) {
        best = { start: i, end, distance };
        if (distance === 0) break;
      }
    }
    if (best && best.distance === 0) break;
  }

  if (!best) return;

  // Confidence: 0 distance → 0.75 cap; max distance → 0.50 floor. Linear in
  // between to mirror the Rust scale.
  const ratio = 1 - best.distance / maxDistance;
  const confidence = CONF_FUZZY_MIN + (CONF_FUZZY_MAX - CONF_FUZZY_MIN) * ratio;
  const position = positionFromByteRange(ctx, best.start, best.end);
  out.push({
    confidence,
    currentRange: position,
    reason: 'fuzzy_quote_match',
    exactReason: 'fuzzy_quote_match',
    preview: makePreviewFromBytes(ctx.currentMarkdownBytes, best.start, best.end),
  });
}

// ---------------------------------------------------------------------------
// Step 8: line proximity only (low-confidence fallback)
// ---------------------------------------------------------------------------

function pushLineProximity(
  out: InternalCandidate[],
  anchor: Anchor,
  ctx: ResolveContext,
): void {
  const [startLine, endLine] = anchor.position.lineRange;
  if (startLine < 0 || endLine < startLine) return;

  // Clamp lines into the current document.
  const clampedStartLine = Math.min(startLine, Math.max(0, ctx.currentIndex.lineCount - 1));
  const clampedEndLine = Math.min(endLine, Math.max(0, ctx.currentIndex.lineCount - 1));

  const lineStarts = computeLineStarts(ctx.currentMarkdownBytes);
  const startByte = lineStarts[clampedStartLine] ?? 0;
  const endByte = clampedEndLine + 1 < lineStarts.length
    ? lineStarts[clampedEndLine + 1]! // include trailing newline
    : ctx.currentMarkdownBytes.length;

  // Confidence drops with how far the line range moved (or got clamped).
  // We approximate "moved" as the line-range shift — without step maps we
  // simply award the spec ceiling (0.35) and let downstream pickers decide.
  out.push({
    confidence: CONF_LINE_PROXIMITY_MAX,
    currentRange: positionFromByteRange(ctx, startByte, endByte),
    reason: 'line_proximity',
    // exactReason: there's no enum variant for this; fold into fuzzy.
    exactReason: 'fuzzy_quote_match',
    preview: makePreviewFromBytes(ctx.currentMarkdownBytes, startByte, endByte),
  });
}

// ---------------------------------------------------------------------------
// Position / utf-8 helpers
// ---------------------------------------------------------------------------

function positionFromByteRange(
  ctx: ResolveContext,
  byteStart: number,
  byteEnd: number,
): PositionAnchor {
  const lineStarts = computeLineStarts(ctx.currentMarkdownBytes);
  const startLine = byteToLine(lineStarts, byteStart);
  const endLine = byteToLine(lineStarts, Math.max(byteStart, byteEnd - 1));
  return {
    byteRange: [byteStart, byteEnd],
    lineRange: [startLine, endLine],
  };
}

function byteToLine(lineStarts: number[], byte: number): number {
  // Binary search for the last line-start ≤ byte.
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const start = lineStarts[mid]!;
    if (start <= byte) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function computeLineStarts(bytes: Uint8Array): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function findAllByteOccurrences(haystack: Uint8Array, needle: Uint8Array): number[] {
  const hits: number[] = [];
  if (needle.length === 0 || needle.length > haystack.length) return hits;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: false });

function encodeUtf8(s: string): Uint8Array {
  return ENCODER.encode(s);
}

function decodeUtf8(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

/**
 * UTF-8 codepoint boundary: index is at a byte that is either ASCII or the
 * start of a multi-byte sequence (i.e., NOT 10xxxxxx). `length` always
 * qualifies. Used by the fuzzy step to avoid slicing mid-codepoint.
 */
function isUtf8Boundary(bytes: Uint8Array, idx: number): boolean {
  if (idx >= bytes.length) return true;
  if (idx <= 0) return true;
  const b = bytes[idx]!;
  return (b & 0xc0) !== 0x80;
}

// ---------------------------------------------------------------------------
// Bounded Levenshtein
// ---------------------------------------------------------------------------

/**
 * Returns the Levenshtein distance between `a` and `b`, or `null` if it
 * provably exceeds `max`. Uses two rolling rows and early termination on
 * the per-row minimum.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  if (a === b) return 0;

  // Cheap prefix/suffix trim.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const aa = a.slice(start, endA);
  const bb = b.slice(start, endB);
  if (aa.length === 0) return bb.length <= max ? bb.length : null;
  if (bb.length === 0) return aa.length <= max ? aa.length : null;

  const m = aa.length;
  const n = bb.length;
  let prev: number[] = new Array<number>(n + 1);
  let cur: number[] = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = cur[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      const v = Math.min(del, ins, sub);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return null;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const distance = prev[n]!;
  return distance <= max ? distance : null;
}

// ---------------------------------------------------------------------------
// Quote / context helpers
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 64;

function makePreview(s: string): string {
  if (s.length <= PREVIEW_MAX) return s;
  return s.slice(0, PREVIEW_MAX - 1) + '…';
}

function makePreviewFromBytes(bytes: Uint8Array, start: number, end: number): string {
  const safeEnd = Math.min(bytes.length, Math.max(start, end));
  return makePreview(decodeUtf8(bytes.subarray(start, safeEnd)));
}

// ---------------------------------------------------------------------------
// Re-exports for tests / consumers that want the internal helpers
// ---------------------------------------------------------------------------

export const __testing__ = {
  computeLineStarts,
  byteToLine,
  findAllByteOccurrences,
  positionFromByteRange,
  clampOffsetIntoBlock,
  headingPathEquals,
  isUtf8Boundary,
  decide,
};
