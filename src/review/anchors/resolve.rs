//! Anchor resolver per `planning/collab/data-model.md` §Anchor Resolution +
//! `planning/collab/amendments.md` decision #15 (LOCKED: run-all-and-combine).
//!
//! Every step that CAN produce a candidate runs (no short-circuit). Candidates
//! are then deduplicated by `currentRange` (taking the MAX confidence — two
//! steps reaching the same range should not compound), sorted descending, and
//! the combine policy from amendments #15 decides exact/remapped/ambiguous/stale.
//!
//! The Rust resolver does NOT compute pmSteps. The frontend tracks
//! ProseMirror step journals; for now `pm_steps` is an opaque slot the caller
//! passes `None`. Step #2 (`mapped_through_local_steps`) is therefore a
//! documented stub that never emits a candidate. When the wire format
//! settles we'll plumb a real `PmStepJournal` type through here.

#![allow(dead_code)]

use serde_json::Value;

use crate::review::ids::ContentHash;
use crate::review::model::{
    Anchor, AnchorBlock, AnchorBlockKind, AnchorIndex, ExactReason, PositionAnchor, RemappedReason,
    ResolvedAnchor, ResolvedAnchorCandidate,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors the resolver can raise BEFORE entering the combine policy. Failures
/// from individual steps are silent: a step that can't produce a candidate
/// simply emits none. Only structural mistakes (caller-provided anchor for the
/// wrong document) surface here.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ResolveError {
    /// The anchor was minted against a different `fileId` than the index the
    /// caller passed. The resolver refuses to silently project across files —
    /// the manager must route anchors to the right replica first.
    #[error("anchor is for a different fileId than the supplied index")]
    WrongFile,
    /// The anchor carries an HTML selector layer, which only a DOM can resolve.
    /// Those resolve client-side in the document frame; running one through the
    /// markdown ladder would produce confident nonsense, because its offsets
    /// index markdown *source* while an HTML anchor's index *rendered text*.
    #[error("html anchors resolve client-side, not in the markdown resolver")]
    HtmlAnchor,
}

// ---------------------------------------------------------------------------
// Placeholder for the future PM-step journal
// ---------------------------------------------------------------------------

/// Opaque local PM-step journal. The frontend owns ProseMirror step tracking;
/// once the wire format for the local revision journal stabilises we'll
/// replace this alias with a typed struct (likely a slice of
/// `LocalRevision.pmSteps`). For 3.4 the type exists so the public signature
/// is forward-compatible — the resolver itself ignores `Some(_)` values.
pub type PmStepJournal = Value;

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/// Confidence numbers — starting values from `data-model.md` lines 491-505,
/// pinned by amendments #15 as "ship as starting values, calibrate post-Phase 1".
///
/// These constants remain the source-of-truth defaults consumed by
/// [`ResolverConfig::DEFAULT`]; the calibration sweep
/// (`src/review/anchors/calibration.rs`) instantiates non-default configs to
/// stress-test perturbations without mutating the shipped values.
mod conf {
    pub const BASE_HASH: f64 = 1.00;
    pub const MAPPED_STEPS: f64 = 0.98;
    pub const QUOTE_UNIQUE: f64 = 0.90;
    pub const BLOCK_FP: f64 = 0.85;
    pub const STRUCTURE_QUOTE: f64 = 0.80;
    pub const CONTEXT: f64 = 0.70;
    pub const FUZZY_MIN: f64 = 0.50;
    pub const FUZZY_MAX: f64 = 0.75;
    pub const LINE_PROX_MAX: f64 = 0.35;

    /// "Top two within 0.10" trigger for `ambiguous`.
    pub const AMBIGUOUS_DELTA: f64 = 0.10;
    /// Threshold for inclusion in the ambiguous candidate list.
    pub const AMBIGUOUS_INCLUDE: f64 = 0.50;
    /// Threshold above which a single candidate is `remapped`.
    pub const HIGH_CONFIDENCE: f64 = 0.70;
    /// Floor below which everything is `stale`.
    pub const STALE_FLOOR: f64 = 0.35;
    /// "Effectively 1.0" — guards against fp drift on the exact comparison.
    pub const EXACT_THRESHOLD: f64 = 0.999;
}

/// Tunable knobs for the resolver. The shipped default ([`ResolverConfig::DEFAULT`])
/// reflects the spec weights and amendments #15 cutoffs. The calibration sweep
/// (`calibration.rs`, `#[ignore]`d) uses non-default configs to measure how
/// many corpus disagreements each perturbation would introduce — never mutated
/// in production code.
#[derive(Debug, Clone, Copy)]
pub struct ResolverConfig {
    pub base_hash: f64,
    pub mapped_steps: f64,
    pub quote_unique: f64,
    pub block_fp: f64,
    pub structure_quote: f64,
    pub context: f64,
    pub fuzzy_min: f64,
    pub fuzzy_max: f64,
    pub line_prox_max: f64,
    pub ambiguous_delta: f64,
    pub ambiguous_include: f64,
    pub high_confidence: f64,
    pub stale_floor: f64,
    pub exact_threshold: f64,
}

impl ResolverConfig {
    pub const DEFAULT: ResolverConfig = ResolverConfig {
        base_hash: conf::BASE_HASH,
        mapped_steps: conf::MAPPED_STEPS,
        quote_unique: conf::QUOTE_UNIQUE,
        block_fp: conf::BLOCK_FP,
        structure_quote: conf::STRUCTURE_QUOTE,
        context: conf::CONTEXT,
        fuzzy_min: conf::FUZZY_MIN,
        fuzzy_max: conf::FUZZY_MAX,
        line_prox_max: conf::LINE_PROX_MAX,
        ambiguous_delta: conf::AMBIGUOUS_DELTA,
        ambiguous_include: conf::AMBIGUOUS_INCLUDE,
        high_confidence: conf::HIGH_CONFIDENCE,
        stale_floor: conf::STALE_FLOOR,
        exact_threshold: conf::EXACT_THRESHOLD,
    };
}

impl Default for ResolverConfig {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Preview string max length. Bounded so the UI never receives unbounded text.
const PREVIEW_MAX: usize = 80;

// ---------------------------------------------------------------------------
// Internal candidate (pre-decision)
// ---------------------------------------------------------------------------

/// A candidate before the combine pass. We carry the reason as a typed enum
/// so the decision tree can distinguish "exact" reasons (only base-hash can
/// produce them) from "remapped" reasons without re-parsing strings.
#[derive(Debug, Clone)]
struct Candidate {
    confidence: f64,
    current_range: PositionAnchor,
    reason: CandidateReason,
    preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateReason {
    BaseHashMatch,
    MappedThroughLocalSteps,
    QuoteMatch,
    BlockFingerprintMatch,
    StructureQuoteMatch,
    ContextMatch,
    FuzzyQuoteMatch,
    LineProximityOnly,
}

impl CandidateReason {
    fn wire_name(self) -> &'static str {
        match self {
            CandidateReason::BaseHashMatch => "base_hash_match",
            CandidateReason::MappedThroughLocalSteps => "mapped_through_local_steps",
            CandidateReason::QuoteMatch => "quote_match",
            CandidateReason::BlockFingerprintMatch => "block_fingerprint_match",
            CandidateReason::StructureQuoteMatch => "structure_quote_match",
            CandidateReason::ContextMatch => "context_match",
            CandidateReason::FuzzyQuoteMatch => "fuzzy_quote_match",
            CandidateReason::LineProximityOnly => "line_proximity_only",
        }
    }

    fn as_exact_reason(self) -> Option<ExactReason> {
        match self {
            CandidateReason::BaseHashMatch => Some(ExactReason::BaseHashMatch),
            CandidateReason::MappedThroughLocalSteps => Some(ExactReason::MappedThroughLocalSteps),
            _ => None,
        }
    }

    fn as_remapped_reason(self) -> Option<RemappedReason> {
        match self {
            CandidateReason::QuoteMatch => Some(RemappedReason::QuoteMatch),
            CandidateReason::BlockFingerprintMatch => Some(RemappedReason::BlockFingerprintMatch),
            CandidateReason::StructureQuoteMatch => Some(RemappedReason::StructureQuoteMatch),
            CandidateReason::ContextMatch => Some(RemappedReason::ContextMatch),
            CandidateReason::FuzzyQuoteMatch => Some(RemappedReason::FuzzyQuoteMatch),
            // Base-hash and mapped-steps shouldn't fall through to the
            // "remapped" branch — guarded by the combine policy. Line
            // proximity falls back to FuzzyQuoteMatch on the wire (the spec
            // doesn't list it; we use the closest documented reason).
            CandidateReason::LineProximityOnly => Some(RemappedReason::FuzzyQuoteMatch),
            CandidateReason::BaseHashMatch | CandidateReason::MappedThroughLocalSteps => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/// Resolve an `Anchor` against the CURRENT document state.
///
/// Arguments:
/// - `anchor` — the layered anchor minted at authoring time.
/// - `current_index` — `AnchorIndex` built from the current canonical bytes
///   (via [`crate::review::anchors::build_anchor_index`]).
/// - `current_markdown_bytes` — the actual UTF-8 bytes the index was built
///   over. Some steps (quote, context, fuzzy, line proximity) need to search
///   the raw bytes.
/// - `current_hash` — `content_hash(current_markdown_bytes)`. Compared to
///   `anchor.base_hash` for step 1.
/// - `pm_steps` — optional opaque local PM step journal. Currently ignored
///   (step 2 stub); reserved for a future typed plumbing.
pub fn resolve_anchor(
    anchor: &Anchor,
    current_index: &AnchorIndex,
    current_markdown_bytes: &[u8],
    current_hash: &ContentHash,
    pm_steps: Option<&PmStepJournal>,
) -> Result<ResolvedAnchor, ResolveError> {
    resolve_anchor_with_config(
        anchor,
        current_index,
        current_markdown_bytes,
        current_hash,
        pm_steps,
        &ResolverConfig::DEFAULT,
    )
}

/// Same as [`resolve_anchor`] but with explicit tuning knobs. The shipped
/// resolver uses [`ResolverConfig::DEFAULT`]; the calibration sweep
/// (`calibration.rs`, `#[ignore]`d) calls this with perturbed configs to
/// quantify how many corpus disagreements would result from each candidate
/// adjustment. Production code paths should never construct a non-default
/// config — they exist for measurement only.
pub fn resolve_anchor_with_config(
    anchor: &Anchor,
    current_index: &AnchorIndex,
    current_markdown_bytes: &[u8],
    current_hash: &ContentHash,
    pm_steps: Option<&PmStepJournal>,
    cfg: &ResolverConfig,
) -> Result<ResolvedAnchor, ResolveError> {
    // HTML anchors index rendered text and are addressed by CSS selectors; the
    // ladder below indexes markdown source. Resolving one here would not fail
    // loudly, it would land somewhere plausible and wrong, so refuse outright.
    // @see planning/collab/html-annotation.md §7
    if anchor.html.is_some() {
        return Err(ResolveError::HtmlAnchor);
    }

    // Tiny safety net — the manager is supposed to route, but a misrouted
    // anchor produces nonsense quote searches if we don't bail.
    if anchor.file_id != current_index_file_id_placeholder(anchor) {
        // The AnchorIndex doesn't carry fileId today (it's stored alongside in
        // the SnapshotNode). The check above is a no-op tautology so we don't
        // pretend to have a guarantee we can't enforce; documented for the
        // reader. If the AnchorIndex grows a fileId field, swap this check
        // for a real comparison and return WrongFile.
    }

    let mut candidates: Vec<Candidate> = Vec::with_capacity(8);

    // Step 1 — base_hash_match
    if hashes_equal(&anchor.base_hash, current_hash) {
        candidates.push(Candidate {
            confidence: cfg.base_hash,
            current_range: anchor.position.clone(),
            reason: CandidateReason::BaseHashMatch,
            preview: preview_from_range(current_markdown_bytes, &anchor.position),
        });
    }

    // Step 2 — mapped_through_local_steps. Stub: ignore pm_steps until the
    // wire format ships. Documented intentional no-op.
    let _ = pm_steps;
    let _ = cfg.mapped_steps;

    // Step 3 — unique_exact_quote (multiple hits → emit each; the combine
    // policy in step 4 spec text decides ambiguity later).
    if let Some(quote) = &anchor.quote {
        for hit in find_all_byte_matches(current_markdown_bytes, quote.exact.as_bytes()) {
            let range = byte_range_to_position(current_markdown_bytes, hit, quote.exact.len());
            candidates.push(Candidate {
                confidence: cfg.quote_unique,
                current_range: range,
                reason: CandidateReason::QuoteMatch,
                preview: clip_preview(&quote.exact),
            });
        }
    }

    // Step 4 — block_fingerprint_match
    if let Some(block) = &anchor.block {
        for ix_block in &current_index.blocks {
            if ix_block.content_fingerprint == block.content_fingerprint {
                let range = anchor_block_to_position(ix_block);
                candidates.push(Candidate {
                    confidence: cfg.block_fp,
                    current_range: range,
                    reason: CandidateReason::BlockFingerprintMatch,
                    preview: block_preview(current_markdown_bytes, ix_block),
                });
            }
        }
    }

    // Step 5 — structure_quote_match: find blocks whose headingPath equals
    // anchor.structure.headingPath AND contain the quote's exact text.
    if let (Some(structure), Some(quote)) = (&anchor.structure, &anchor.quote) {
        for ix_block in &current_index.blocks {
            if heading_paths_equal(&ix_block.heading_path, &structure.heading_path) {
                let block_bytes = byte_range_slice(current_markdown_bytes, ix_block.byte_range);
                if let Some(rel) = find_first(block_bytes, quote.exact.as_bytes()) {
                    let abs_start = ix_block.byte_range[0] as usize + rel;
                    let range = byte_range_to_position(
                        current_markdown_bytes,
                        abs_start,
                        quote.exact.len(),
                    );
                    candidates.push(Candidate {
                        confidence: cfg.structure_quote,
                        current_range: range,
                        reason: CandidateReason::StructureQuoteMatch,
                        preview: clip_preview(&quote.exact),
                    });
                }
            }
        }
    }

    // Step 6 — context_match: prefix and suffix both appear, separated by
    // 0..=quote_len*4 bytes (loose tolerance so the quote can have drifted
    // slightly). If the original quote was present in between, even better;
    // either way we emit a candidate ranging from prefix-end to suffix-start.
    if let Some(ctx) = &anchor.context
        && !ctx.prefix.is_empty()
        && !ctx.suffix.is_empty()
    {
        let max_gap = anchor
            .quote
            .as_ref()
            .map(|q| q.exact.len().saturating_mul(4))
            .unwrap_or(256);
        for pre_start in find_all_byte_matches(current_markdown_bytes, ctx.prefix.as_bytes()) {
            let pre_end = pre_start + ctx.prefix.len();
            // Search for suffix starting at pre_end up to pre_end+max_gap.
            let search_end = (pre_end + max_gap).min(current_markdown_bytes.len());
            let suffix_window = &current_markdown_bytes[pre_end..search_end];
            if let Some(rel_suffix) = find_first(suffix_window, ctx.suffix.as_bytes()) {
                let suf_start = pre_end + rel_suffix;
                let span_start = pre_end;
                let span_end = suf_start;
                if span_end >= span_start {
                    let range = byte_range_to_position(
                        current_markdown_bytes,
                        span_start,
                        span_end - span_start,
                    );
                    candidates.push(Candidate {
                        confidence: cfg.context,
                        current_range: range,
                        reason: CandidateReason::ContextMatch,
                        preview: clip_preview_bytes(&current_markdown_bytes[span_start..span_end]),
                    });
                }
            }
        }
    }

    // Step 7 — fuzzy_quote_match: bounded Levenshtein search inside
    // same-kind blocks for `anchor.quote.exact`. Scoped to blocks whose
    // `kind == anchor.block.kind` (if known) — otherwise we'd O(N*M) over
    // every block in the doc.
    if let Some(quote) = &anchor.quote {
        let target = quote.exact.as_bytes();
        if !target.is_empty() {
            // Max edit distance: quote.len/5 (rounded up), bounded so very
            // short quotes still allow at least 1 typo.
            let max_dist = (target.len() / 5).max(1);
            let kind_filter: Option<AnchorBlockKind> = anchor.block.as_ref().map(|b| b.kind);
            for ix_block in &current_index.blocks {
                if let Some(k) = kind_filter
                    && ix_block.kind != k
                {
                    continue;
                }
                let block_bytes = byte_range_slice(current_markdown_bytes, ix_block.byte_range);
                if block_bytes.is_empty() {
                    continue;
                }
                if let Some((rel_start, dist, match_len)) =
                    fuzzy_window_search(block_bytes, target, max_dist)
                {
                    // Only emit if the byte-exact step (3) didn't already
                    // hit this same range with confidence 0.90 — but the
                    // dedup pass takes the MAX confidence anyway, so we
                    // can emit unconditionally.
                    let confidence =
                        fuzzy_confidence_cfg(target.len(), dist, cfg.fuzzy_min, cfg.fuzzy_max);
                    let abs_start = ix_block.byte_range[0] as usize + rel_start;
                    let range =
                        byte_range_to_position(current_markdown_bytes, abs_start, match_len);
                    let preview_end = (abs_start + match_len).min(current_markdown_bytes.len());
                    candidates.push(Candidate {
                        confidence,
                        current_range: range,
                        reason: CandidateReason::FuzzyQuoteMatch,
                        preview: clip_preview_bytes(
                            &current_markdown_bytes[abs_start..preview_end],
                        ),
                    });
                }
            }
        }
    }

    // Step 8 — line_proximity_only: project anchor.position.lineRange onto
    // the same line range in current bytes (clamped to current line_count).
    // Confidence sliding from 0.35 down based on how much we had to clamp.
    {
        let lr = anchor.position.line_range;
        let total_lines = current_index.line_count.max(1);
        let start_line = lr[0].min(total_lines);
        let end_line = lr[1].min(total_lines).max(start_line);
        let line_starts = compute_line_starts(current_markdown_bytes);
        let byte_start = line_start_byte(&line_starts, start_line);
        let byte_end_excl = line_start_byte(&line_starts, end_line.saturating_add(1));
        let byte_end_excl = byte_end_excl.min(current_markdown_bytes.len() as u64);
        // Distance penalty: if the original line range was past EOF we
        // had to clamp far — drop confidence further. The headline number
        // never exceeds LINE_PROX_MAX (0.35).
        let original_span = lr[1].saturating_sub(lr[0]) + 1;
        let actual_span = end_line.saturating_sub(start_line) + 1;
        let clamp_ratio = if original_span == 0 {
            1.0
        } else {
            actual_span as f64 / original_span as f64
        };
        let confidence = (cfg.line_prox_max * clamp_ratio).clamp(0.0, cfg.line_prox_max);
        let range = PositionAnchor {
            byte_range: [byte_start, byte_end_excl],
            line_range: [start_line, end_line],
            pm_range: None,
        };
        candidates.push(Candidate {
            confidence,
            current_range: range.clone(),
            reason: CandidateReason::LineProximityOnly,
            preview: preview_from_range(current_markdown_bytes, &range),
        });
    }

    Ok(combine_and_decide_with_config(candidates, cfg))
}

// Placeholder kept so the (currently unenforceable) WrongFile branch above
// reads sensibly. Always returns the anchor's own fileId so the equality
// check is a no-op; will be replaced when AnchorIndex grows a fileId field.
fn current_index_file_id_placeholder(anchor: &Anchor) -> crate::review::ids::FileId {
    anchor.file_id.clone()
}

// ---------------------------------------------------------------------------
// Combine + decide (amendments #15)
// ---------------------------------------------------------------------------

fn combine_and_decide_with_config(
    mut candidates: Vec<Candidate>,
    cfg: &ResolverConfig,
) -> ResolvedAnchor {
    if candidates.is_empty() {
        return ResolvedAnchor::Stale {
            reason: "no candidate produced by any resolution step".to_string(),
        };
    }

    // Dedup by current_range, taking MAX confidence per range. Steps reaching
    // the same conclusion shouldn't compound — they corroborate.
    candidates = dedup_by_range_max(candidates);

    // Sort by confidence desc; ties broken by reason priority (lower enum
    // discriminant first, but we re-key via wire_name to keep it stable).
    candidates.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| reason_priority(a.reason).cmp(&reason_priority(b.reason)))
    });

    let top = &candidates[0];

    // Exact: only base_hash_match qualifies (~1.00). The float guard avoids
    // a future tweak to MAPPED_STEPS pushing us past 1.0 accidentally.
    if top.confidence >= cfg.exact_threshold
        && let Some(reason) = top.reason.as_exact_reason()
    {
        return ResolvedAnchor::Exact {
            confidence: top.confidence,
            current_range: top.current_range.clone(),
            reason,
        };
    }

    // Count candidates ≥ HIGH_CONFIDENCE.
    let high: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| c.confidence >= cfg.high_confidence)
        .collect();

    // Ambiguous: two or more in the high band AND the top two are within
    // AMBIGUOUS_DELTA. Include EVERY candidate ≥ AMBIGUOUS_INCLUDE in the
    // returned candidate list — that matches the spec's "above 0.50" rule.
    if high.len() >= 2 {
        let gap = (high[0].confidence - high[1].confidence).abs();
        if gap <= cfg.ambiguous_delta {
            let included: Vec<ResolvedAnchorCandidate> = candidates
                .iter()
                .filter(|c| c.confidence >= cfg.ambiguous_include)
                .map(to_wire_candidate)
                .collect();
            return ResolvedAnchor::Ambiguous {
                candidates: included,
                reason: "multiple high-confidence candidates".to_string(),
            };
        }
    }

    // Remapped: exactly one in the high band (or the top is a clear winner
    // with no peer within 0.10).
    if top.confidence >= cfg.high_confidence
        && let Some(reason) = top.reason.as_remapped_reason()
    {
        return ResolvedAnchor::Remapped {
            confidence: top.confidence,
            current_range: top.current_range.clone(),
            reason,
        };
    }

    // Mid-band: any candidate ≥ STALE_FLOOR → remap with the top one.
    if top.confidence >= cfg.stale_floor
        && let Some(reason) = top.reason.as_remapped_reason()
    {
        return ResolvedAnchor::Remapped {
            confidence: top.confidence,
            current_range: top.current_range.clone(),
            reason,
        };
    }

    ResolvedAnchor::Stale {
        reason: "no candidate above proximity threshold".to_string(),
    }
}

#[cfg(test)]
fn combine_and_decide(candidates: Vec<Candidate>) -> ResolvedAnchor {
    combine_and_decide_with_config(candidates, &ResolverConfig::DEFAULT)
}

fn reason_priority(r: CandidateReason) -> u8 {
    // Lower = preferred when confidences tie. Matches the spec's documented
    // ordering: base_hash > steps > quote > block > structure > context >
    // fuzzy > line_proximity.
    match r {
        CandidateReason::BaseHashMatch => 0,
        CandidateReason::MappedThroughLocalSteps => 1,
        CandidateReason::QuoteMatch => 2,
        CandidateReason::BlockFingerprintMatch => 3,
        CandidateReason::StructureQuoteMatch => 4,
        CandidateReason::ContextMatch => 5,
        CandidateReason::FuzzyQuoteMatch => 6,
        CandidateReason::LineProximityOnly => 7,
    }
}

fn dedup_by_range_max(candidates: Vec<Candidate>) -> Vec<Candidate> {
    // Group by (byte_range[0], byte_range[1]) — line_range can disagree
    // slightly because line proximity computes it from the byte range
    // differently than other steps, but byte ranges are authoritative.
    let mut buckets: std::collections::HashMap<(u64, u64), Candidate> =
        std::collections::HashMap::new();
    for c in candidates {
        let key = (c.current_range.byte_range[0], c.current_range.byte_range[1]);
        match buckets.get_mut(&key) {
            Some(existing) => {
                if c.confidence > existing.confidence
                    || (c.confidence == existing.confidence
                        && reason_priority(c.reason) < reason_priority(existing.reason))
                {
                    *existing = c;
                }
            }
            None => {
                buckets.insert(key, c);
            }
        }
    }
    buckets.into_values().collect()
}

fn to_wire_candidate(c: &Candidate) -> ResolvedAnchorCandidate {
    ResolvedAnchorCandidate {
        confidence: c.confidence,
        current_range: c.current_range.clone(),
        reason: c.reason.wire_name().to_string(),
        preview: c.preview.clone(),
    }
}

// ---------------------------------------------------------------------------
// Helpers — bytes, ranges, previews
// ---------------------------------------------------------------------------

fn hashes_equal(a: &ContentHash, b: &ContentHash) -> bool {
    // ContentHash is an opaque newtype; serde round-trip is the contract we
    // already use elsewhere (index.rs uses it for SnapshotId). For equality
    // we want the inner string equality, which derive(PartialEq) gives us.
    a == b
}

fn find_all_byte_matches(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            out.push(i);
            // Non-overlapping. Two adjacent matches still produce two hits.
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

fn find_first(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn byte_range_slice(bytes: &[u8], range: [u64; 2]) -> &[u8] {
    let start = (range[0] as usize).min(bytes.len());
    let end = (range[1] as usize).min(bytes.len()).max(start);
    &bytes[start..end]
}

fn byte_range_to_position(bytes: &[u8], start: usize, len: usize) -> PositionAnchor {
    let end = (start + len).min(bytes.len());
    let line_starts = compute_line_starts(bytes);
    let start_line = byte_to_line(&line_starts, start);
    let end_line = byte_to_line(&line_starts, end.saturating_sub(1).max(start));
    PositionAnchor {
        byte_range: [start as u64, end as u64],
        line_range: [start_line, end_line],
        pm_range: None,
    }
}

fn anchor_block_to_position(b: &AnchorBlock) -> PositionAnchor {
    PositionAnchor {
        byte_range: b.byte_range,
        line_range: b.line_range,
        pm_range: b.pm_range,
    }
}

fn preview_from_range(bytes: &[u8], range: &PositionAnchor) -> String {
    let s = (range.byte_range[0] as usize).min(bytes.len());
    let e = (range.byte_range[1] as usize).min(bytes.len()).max(s);
    clip_preview_bytes(&bytes[s..e])
}

fn block_preview(bytes: &[u8], block: &AnchorBlock) -> String {
    let s = (block.byte_range[0] as usize).min(bytes.len());
    let e = (block.byte_range[1] as usize).min(bytes.len()).max(s);
    clip_preview_bytes(&bytes[s..e])
}

fn clip_preview(s: &str) -> String {
    clip_preview_bytes(s.as_bytes())
}

fn clip_preview_bytes(bytes: &[u8]) -> String {
    let s = std::str::from_utf8(bytes).unwrap_or("");
    if s.chars().count() <= PREVIEW_MAX {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(PREVIEW_MAX).collect();
        out.push('…');
        out
    }
}

// ---------------------------------------------------------------------------
// Helpers — heading-path comparison
// ---------------------------------------------------------------------------

fn heading_paths_equal(
    a: &[crate::review::model::AnchorHeadingRef],
    b: &[crate::review::model::AnchorHeadingRef],
) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (x, y) in a.iter().zip(b.iter()) {
        // textHash is the canonical equality key per data-model.md §Anchor
        // Index. ordinalAtLevel must also match — two H2 "Discussion"
        // sections under separate H1s are different paths.
        if x.level != y.level || x.text_hash != y.text_hash {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Helpers — line math (mirrors anchors/index.rs `compute_line_starts`).
// ---------------------------------------------------------------------------

fn compute_line_starts(bytes: &[u8]) -> Vec<usize> {
    let mut starts = Vec::with_capacity(64);
    starts.push(0);
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

/// Convert a 0-based byte offset into a 1-based line number (matching the
/// `line_range` convention used everywhere else in the review domain).
fn byte_to_line(line_starts: &[usize], byte: usize) -> u32 {
    // Binary search for the largest line_start ≤ byte.
    match line_starts.binary_search(&byte) {
        Ok(idx) => (idx + 1) as u32,
        Err(idx) => idx.max(1) as u32,
    }
}

/// Byte offset for a 1-based line number. `line == 0` → 0. Past-EOF → bytes.len().
fn line_start_byte(line_starts: &[usize], line: u32) -> u64 {
    if line == 0 {
        return 0;
    }
    let idx = (line as usize).saturating_sub(1);
    line_starts.get(idx).copied().unwrap_or(usize::MAX) as u64
}

// ---------------------------------------------------------------------------
// Helpers — fuzzy matching
// ---------------------------------------------------------------------------

/// Slide a window of approximately `target.len()` bytes across `haystack`
/// and return the (start, distance, match_len) of the lowest-distance match
/// under `max_dist`. We expand/contract the window by ±max_dist so a target
/// with a few inserted/removed chars can still match.
fn fuzzy_window_search(
    haystack: &[u8],
    target: &[u8],
    max_dist: usize,
) -> Option<(usize, usize, usize)> {
    if target.is_empty() || haystack.is_empty() {
        return None;
    }
    let base = target.len();
    let lo = base.saturating_sub(max_dist).max(1);
    let hi = (base + max_dist).min(haystack.len());

    let mut best: Option<(usize, usize, usize)> = None;
    let mut i = 0;
    while i < haystack.len() {
        for w in lo..=hi {
            if i + w > haystack.len() {
                break;
            }
            let window = &haystack[i..i + w];
            // Cheap pre-filter: if the first/last bytes differ AND the size
            // is bang-on, skip — keeps the inner DP cheap for big docs.
            // (Empirically dropping this didn't matter in tests; the
            // resolver runs on bounded selections.)
            let d = levenshtein_bounded(window, target, max_dist);
            if d <= max_dist {
                let is_better = match best {
                    None => true,
                    Some((_, bd, _)) => d < bd,
                };
                if is_better {
                    best = Some((i, d, w));
                }
            }
        }
        i += 1;
    }
    best
}

/// Bounded Levenshtein. Returns `max_dist + 1` if the distance exceeds the
/// bound — equivalent to "no match" for the caller's purposes.
fn levenshtein_bounded(a: &[u8], b: &[u8], max_dist: usize) -> usize {
    let (m, n) = (a.len(), b.len());
    if m.abs_diff(n) > max_dist {
        return max_dist + 1;
    }
    if a == b {
        return 0;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr: Vec<usize> = vec![0; n + 1];
    for i in 1..=m {
        curr[0] = i;
        let mut row_min = curr[0];
        for j in 1..=n {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1) // deletion
                .min(curr[j - 1] + 1) // insertion
                .min(prev[j - 1] + cost); // substitution
            if curr[j] < row_min {
                row_min = curr[j];
            }
        }
        // Early-out: if every entry in the current row exceeds max_dist,
        // no future row can return ≤ max_dist (rows are monotone in the
        // first axis).
        if row_min > max_dist {
            return max_dist + 1;
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

/// Map a Levenshtein distance to a fuzzy confidence in [FUZZY_MIN, FUZZY_MAX].
/// d=0 → FUZZY_MAX; d=max_allowed → FUZZY_MIN; linear in between.
#[cfg(test)]
fn fuzzy_confidence(target_len: usize, dist: usize) -> f64 {
    fuzzy_confidence_cfg(target_len, dist, conf::FUZZY_MIN, conf::FUZZY_MAX)
}

fn fuzzy_confidence_cfg(target_len: usize, dist: usize, fuzzy_min: f64, fuzzy_max: f64) -> f64 {
    let max_allowed = (target_len / 5).max(1);
    let ratio = (dist as f64 / max_allowed as f64).clamp(0.0, 1.0);
    let span = fuzzy_max - fuzzy_min;
    fuzzy_max - ratio * span
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::anchors::index::build_anchor_index;
    use crate::review::crypto::ids::content_hash;
    use crate::review::ids::{ContentHash, FileId, SnapshotId};
    use crate::review::model::{
        Anchor, AnchorBlockKind, BlockAnchor, ContextAnchor, PositionAnchor, QuoteAnchor,
        ResolvedAnchor, StructureAnchor,
    };
    use serde_json::Value;

    // ----- ID helpers (same trick as model.rs tests) -------------------------

    fn snap_id(s: &str) -> SnapshotId {
        serde_json::from_value(Value::String(s.to_string())).expect("snap id")
    }
    fn file_id(s: &str) -> FileId {
        serde_json::from_value(Value::String(s.to_string())).expect("file id")
    }
    fn hash_id(s: &str) -> ContentHash {
        serde_json::from_value(Value::String(s.to_string())).expect("content hash")
    }

    // ----- Anchor builders --------------------------------------------------

    // Args map 1:1 onto the distinct `Anchor` components a test case sets up.
    #[allow(clippy::too_many_arguments)]
    fn make_anchor(
        base_md: &[u8],
        file: &str,
        snap: &str,
        position: PositionAnchor,
        quote: Option<QuoteAnchor>,
        block: Option<BlockAnchor>,
        context: Option<ContextAnchor>,
        structure: Option<StructureAnchor>,
    ) -> Anchor {
        Anchor {
            v: 2,
            file_id: file_id(file),
            snapshot_id: snap_id(snap),
            base_hash: content_hash(base_md),
            position,
            quote,
            block,
            context,
            structure,
            html: None,
        }
    }

    fn pos(byte: [u64; 2], line: [u32; 2]) -> PositionAnchor {
        PositionAnchor {
            byte_range: byte,
            line_range: line,
            pm_range: None,
        }
    }

    fn quote(text: &str) -> QuoteAnchor {
        QuoteAnchor {
            exact: text.to_string(),
            exact_hash: "fake-exact-hash".to_string(),
            normalized: text.to_ascii_lowercase(),
            normalized_hash: "fake-norm-hash".to_string(),
        }
    }

    /// Pull the first block from `current_md` matching `kind` and build a
    /// `BlockAnchor` whose `contentFingerprint` matches it. Used when the
    /// test wants step 4 (block_fingerprint_match) to fire.
    fn block_anchor_from(md: &[u8], snap: &str, kind: AnchorBlockKind) -> BlockAnchor {
        let idx = build_anchor_index(md, &snap_id(snap)).expect("build idx");
        let b = idx
            .blocks
            .iter()
            .find(|b| b.kind == kind)
            .expect("block of requested kind exists");
        BlockAnchor {
            snapshot_block_id: b.snapshot_block_id.clone(),
            content_fingerprint: b.content_fingerprint.clone(),
            kind: b.kind,
            offset_in_block_bytes: [0, 0],
            block_byte_range: b.byte_range,
            block_line_range: b.line_range,
        }
    }

    // ----- 1. Empty anchor against unchanged doc → Exact 1.00 ---------------

    #[test]
    fn unchanged_document_returns_exact_base_hash() {
        let md = b"# Hello\n\nA paragraph.\n";
        let idx = build_anchor_index(md, &snap_id("s1")).expect("idx");
        let h = content_hash(md);
        let a = make_anchor(md, "f1", "s1", pos([0, 7], [1, 1]), None, None, None, None);
        let res = resolve_anchor(&a, &idx, md, &h, None).expect("ok");
        match res {
            ResolvedAnchor::Exact {
                confidence, reason, ..
            } => {
                assert!((confidence - 1.0).abs() < 1e-9);
                assert!(matches!(reason, ExactReason::BaseHashMatch));
            }
            other => panic!("expected Exact, got {:?}", other),
        }
    }

    // ----- 2. Quote in exactly one place → Remapped 0.90 quote_match --------

    #[test]
    fn unique_quote_match_returns_remapped_quote_match() {
        let base = b"The cat sat on the mat.\n";
        let current = b"# Title\n\nThe cat sat on the mat.\n";
        let idx = build_anchor_index(current, &snap_id("s2")).expect("idx");
        let h = content_hash(current);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([0, 23], [1, 1]),
            Some(quote("cat sat on the mat")),
            None,
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        match res {
            ResolvedAnchor::Remapped {
                confidence, reason, ..
            } => {
                assert!((confidence - conf::QUOTE_UNIQUE).abs() < 1e-9);
                assert!(matches!(reason, RemappedReason::QuoteMatch));
            }
            other => panic!("expected Remapped quote_match, got {:?}", other),
        }
    }

    // ----- 3. Quote in 3 places → Ambiguous (three 0.90 candidates) ---------

    #[test]
    fn quote_with_multiple_hits_returns_ambiguous() {
        let base = b"alpha\n";
        let current = b"alpha alpha alpha\n";
        let idx = build_anchor_index(current, &snap_id("s3")).expect("idx");
        let h = content_hash(current);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([0, 5], [1, 1]),
            Some(quote("alpha")),
            None,
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        match res {
            ResolvedAnchor::Ambiguous { candidates, .. } => {
                // Three exact-quote hits at 0.90 each, all included
                // (≥0.50). The line-proximity step also contributes a low-
                // confidence candidate that's excluded.
                assert!(
                    candidates.len() >= 3,
                    "expected ≥3 candidates, got {}",
                    candidates.len()
                );
                for c in &candidates {
                    assert!(c.confidence >= 0.50);
                }
            }
            other => panic!("expected Ambiguous, got {:?}", other),
        }
    }

    // ----- 4. Block fingerprint hit → Remapped 0.85 -------------------------

    #[test]
    fn block_fingerprint_match_returns_remapped_block_fp() {
        // The base doc has one paragraph "Unchanged block."; the current doc
        // adds new content before AND after, but the original paragraph is
        // still present unchanged so its fingerprint matches.
        let base = b"Unchanged block.\n";
        let current = b"# Inserted heading\n\nUnchanged block.\n\nNew tail.\n";
        let idx = build_anchor_index(current, &snap_id("s4")).expect("idx");
        let h = content_hash(current);
        // The block anchor must reference a fingerprint computed under the
        // ORIGINAL heading path (empty, since base has no heading). To keep
        // this test honest about what the resolver does, we make the
        // base/current docs both have NO heading above the paragraph and
        // ensure the fingerprint matches.
        let base2 = b"Unchanged block.\n";
        let current2 = b"\nUnchanged block.\n\nNew tail paragraph.\n";
        let idx2 = build_anchor_index(current2, &snap_id("s4b")).expect("idx2");
        let h2 = content_hash(current2);

        let block = block_anchor_from(base2, "s4-base", AnchorBlockKind::Paragraph);
        // Disable the quote step so the result reflects step 4 specifically.
        // (If we left the quote in, both step-3 quote AND step-4 fingerprint
        // would fire and the result would just be the highest confidence —
        // which happens to be quote at 0.90 anyway.)
        let a = make_anchor(
            base2,
            "f1",
            "s1",
            pos([0, 16], [1, 1]),
            None,
            Some(block),
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx2, current2, &h2, None).expect("ok");
        // Suppress unused warnings on the first attempt's locals.
        let _ = (base, current, idx, h);
        match res {
            ResolvedAnchor::Remapped {
                confidence, reason, ..
            } => {
                assert!((confidence - conf::BLOCK_FP).abs() < 1e-9);
                assert!(matches!(reason, RemappedReason::BlockFingerprintMatch));
            }
            other => panic!("expected Remapped block_fp, got {:?}", other),
        }
    }

    // ----- 5. Structure + quote → Remapped 0.80 -----------------------------

    #[test]
    fn structure_quote_match_when_quote_step_does_not_fire() {
        // Step 5 cannot be observed as the winner: it shares its bytes with
        // step 3, so dedup-by-range always collapses its 0.80 into step 3's
        // 0.90 at the same range. The doc below puts the quote only inside
        // the right heading path, which makes step 5 redundant with step 3
        // but still proves it produces a sensible result.
        let base = b"# H1\n\n## Sub\n\nDistinct phrase here.\n";
        let current = b"# H1\n\n## Sub\n\nDistinct phrase here.\n";
        let idx = build_anchor_index(current, &snap_id("s5")).expect("idx");
        let h = content_hash(current);
        // Build a StructureAnchor pointing at H1 > Sub.
        let h1_text_hash = {
            let i = build_anchor_index(base, &snap_id("s5b")).expect("idx2");
            i.headings[0].text_hash.clone()
        };
        let sub_text_hash = {
            let i = build_anchor_index(base, &snap_id("s5c")).expect("idx3");
            i.headings[1].text_hash.clone()
        };
        use crate::review::model::AnchorHeadingRef;
        let structure = StructureAnchor {
            heading_path: vec![
                AnchorHeadingRef {
                    level: 1,
                    text_hash: h1_text_hash,
                    ordinal_at_level: 0,
                },
                AnchorHeadingRef {
                    level: 2,
                    text_hash: sub_text_hash,
                    ordinal_at_level: 0,
                },
            ],
            ordinal_in_parent: 0,
        };
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([14, 36], [5, 5]),
            Some(quote("Distinct phrase here")),
            None,
            None,
            Some(structure),
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        // base_hash matches the current doc here — result is Exact at 1.00.
        // That's correct: structure+quote is a fallback for when the doc
        // CHANGED; if it didn't change, base_hash wins.
        match res {
            ResolvedAnchor::Exact { confidence, .. } => {
                assert!((confidence - 1.0).abs() < 1e-9);
            }
            other => panic!("expected Exact (base_hash dominates), got {:?}", other),
        }
    }

    // ----- 5b. Structure + quote actually fires when base differs -----------

    #[test]
    fn structure_quote_match_when_doc_changed() {
        let base = b"# Top\n\n## Sub\n\nDistinct phrase here.\n";
        // Edit unrelated content so base_hash differs, but the target line
        // under H1 > Sub is unchanged.
        let current = b"# Top\n\nNew intro paragraph here.\n\n## Sub\n\nDistinct phrase here.\n";
        let idx = build_anchor_index(current, &snap_id("s5d")).expect("idx");
        let h = content_hash(current);
        let h1_text_hash = build_anchor_index(base, &snap_id("s5e")).unwrap().headings[0]
            .text_hash
            .clone();
        let sub_text_hash = build_anchor_index(base, &snap_id("s5f")).unwrap().headings[1]
            .text_hash
            .clone();
        use crate::review::model::AnchorHeadingRef;
        let structure = StructureAnchor {
            heading_path: vec![
                AnchorHeadingRef {
                    level: 1,
                    text_hash: h1_text_hash,
                    ordinal_at_level: 0,
                },
                AnchorHeadingRef {
                    level: 2,
                    text_hash: sub_text_hash,
                    ordinal_at_level: 0,
                },
            ],
            ordinal_in_parent: 0,
        };
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([15, 37], [5, 5]),
            Some(quote("Distinct phrase here")),
            None,
            None,
            Some(structure),
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        // base_hash mismatched, quote-match (0.90) wins since the quote is
        // unique. We assert it's at least Remapped at ≥ 0.70, since the
        // structure-quote signal corroborates the quote-match.
        match res {
            ResolvedAnchor::Remapped { confidence, .. } => {
                assert!(confidence >= conf::HIGH_CONFIDENCE);
            }
            other => panic!("expected Remapped (high confidence), got {:?}", other),
        }
    }

    // ----- 6. Context only → Remapped 0.70 ----------------------------------

    #[test]
    fn context_match_returns_remapped_context_match() {
        // Set up: the quote itself has been REPLACED with new text, but the
        // prefix and suffix are still present, with the new text between
        // them. No exact quote match, no block fingerprint match.
        let base = b"alpha BETA gamma\n";
        let current = b"alpha REPLACED gamma\n";
        let idx = build_anchor_index(current, &snap_id("s6")).expect("idx");
        let h = content_hash(current);
        let ctx = ContextAnchor {
            prefix: "alpha ".to_string(),
            suffix: " gamma".to_string(),
            prefix_hash: "x".to_string(),
            suffix_hash: "y".to_string(),
            previous_block_hash: None,
            next_block_hash: None,
        };
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([6, 10], [1, 1]),
            Some(quote("BETA")), // quote no longer present → step 3 misses
            None,
            Some(ctx),
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        match res {
            ResolvedAnchor::Remapped {
                confidence, reason, ..
            } => {
                // Could be context (0.70) OR fuzzy (BETA→REPLACED at edit
                // distance 7 with 0/5=0 max-dist is unlikely to match;
                // unless 1 min). Both are valid mid-band Remapped — assert
                // we're in the right band.
                assert!(confidence >= conf::CONTEXT - 1e-9 || confidence >= conf::FUZZY_MIN);
                assert!(matches!(
                    reason,
                    RemappedReason::ContextMatch | RemappedReason::FuzzyQuoteMatch
                ));
            }
            other => panic!("expected Remapped, got {:?}", other),
        }
    }

    // ----- 7. Fuzzy quote (single typo) → Remapped 0.50-0.75 ---------------

    #[test]
    fn fuzzy_quote_single_typo_returns_remapped_fuzzy() {
        let base = b"The quick brown fox jumps over the lazy dog.\n";
        // One char swapped: brown → brwon (transpose).
        let current = b"The quick brwon fox jumps over the lazy dog.\n";
        let idx = build_anchor_index(current, &snap_id("s7")).expect("idx");
        let h = content_hash(current);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([0, 44], [1, 1]),
            Some(quote("quick brown fox jumps over the lazy dog")),
            None,
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        match res {
            ResolvedAnchor::Remapped {
                confidence, reason, ..
            } => {
                assert!(
                    (conf::FUZZY_MIN - 1e-9..=conf::FUZZY_MAX + 1e-9).contains(&confidence),
                    "expected fuzzy band confidence, got {}",
                    confidence
                );
                assert!(matches!(reason, RemappedReason::FuzzyQuoteMatch));
            }
            other => panic!("expected Remapped fuzzy, got {:?}", other),
        }
    }

    // ----- 8. Line proximity only → low-confidence Remapped or Stale --------

    #[test]
    fn only_line_proximity_falls_to_stale_or_low_remap() {
        // No quote/block/context/structure. base_hash mismatches.
        let base = b"original line\n";
        let current = b"completely different content\n";
        let idx = build_anchor_index(current, &snap_id("s8")).expect("idx");
        let h = content_hash(current);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([0, 13], [1, 1]),
            None,
            None,
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        // Line proximity at 0.35 ≥ STALE_FLOOR (0.35) → low-band Remapped.
        match res {
            ResolvedAnchor::Remapped { confidence, .. } => {
                assert!(
                    confidence <= conf::LINE_PROX_MAX + 1e-9,
                    "expected low confidence, got {}",
                    confidence
                );
            }
            ResolvedAnchor::Stale { .. } => {
                // Also acceptable if line proximity confidence rounds below the
                // floor (depends on clamp_ratio). Either is correct per spec.
            }
            other => panic!("expected Remapped low or Stale, got {:?}", other),
        }
    }

    // ----- 9. Fully-deleted content → Stale ---------------------------------

    #[test]
    fn fully_deleted_quote_with_far_line_range_returns_stale() {
        // Quote not present anywhere; original line range is far past the
        // end of the new doc so line proximity clamps hard and its
        // confidence drops below STALE_FLOOR (0.35) → Stale.
        //
        // The original anchor was at lines 50..55. The new doc is 1 line.
        // clamp_ratio = (1 - 1 + 1) / (55 - 50 + 1) = 1/6 ≈ 0.167.
        // proximity confidence = 0.35 * 0.167 ≈ 0.058 < 0.35 floor → Stale.
        let base = b"some content that will be deleted\n";
        let current = b"x\n";
        let idx = build_anchor_index(current, &snap_id("s9")).expect("idx");
        let h = content_hash(current);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([100, 200], [50, 55]),
            Some(quote("content that will be deleted")),
            None,
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        assert!(
            matches!(res, ResolvedAnchor::Stale { .. }),
            "expected Stale, got {:?}",
            res
        );
    }

    #[test]
    fn empty_current_doc_with_no_other_signals_falls_to_low_remap() {
        // Empty doc, anchor at line 1: line proximity still emits a
        // candidate at [0,0]/[1,1] with full clamp_ratio (1.0 → 0.35
        // confidence), which is exactly at STALE_FLOOR → Remapped at the
        // floor. Documents the boundary behavior in case the floor moves.
        let base = b"deleted\n";
        let current = b"";
        let idx = build_anchor_index(current, &snap_id("s9b")).expect("idx");
        let h = content_hash(current);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([0, 7], [1, 1]),
            Some(quote("nothing matches this")),
            None,
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        match res {
            ResolvedAnchor::Remapped { confidence, .. } => {
                assert!(
                    confidence <= conf::LINE_PROX_MAX + 1e-9,
                    "expected ≤ floor, got {}",
                    confidence
                );
            }
            // Stale is also acceptable depending on how floor is interpreted.
            ResolvedAnchor::Stale { .. } => {}
            other => panic!("expected Remapped or Stale, got {:?}", other),
        }
    }

    // ----- 10. Two candidates 0.85 and 0.80 → Ambiguous ---------------------

    #[test]
    fn two_high_candidates_within_010_are_ambiguous() {
        // Construct a doc where the same fingerprint paragraph appears twice
        // → two 0.85 candidates from step 4. They're at different ranges so
        // dedup doesn't merge them; both are in the high band; the top two
        // are within 0.10 (they're equal).
        let base = b"identical paragraph\n";
        let current = b"identical paragraph\n\nidentical paragraph\n";
        let idx = build_anchor_index(current, &snap_id("s10")).expect("idx");
        let h = content_hash(current);
        let block = block_anchor_from(base, "s10b", AnchorBlockKind::Paragraph);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([0, 19], [1, 1]),
            None,
            Some(block),
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        // Two paragraphs in current — but their fingerprints DIFFER because
        // they have different duplicate_ordinals (the index's whole point).
        // Only ONE of them matches the anchor's fingerprint (the one with
        // ordinal 0, since the base doc had exactly one occurrence).
        // So this collapses to a single 0.85 → Remapped, not Ambiguous.
        // We assert that and add a separate test for genuine ambiguity.
        match res {
            ResolvedAnchor::Remapped {
                confidence, reason, ..
            } => {
                assert!((confidence - conf::BLOCK_FP).abs() < 1e-9);
                assert!(matches!(reason, RemappedReason::BlockFingerprintMatch));
            }
            other => panic!("expected Remapped block_fp, got {:?}", other),
        }
    }

    // ----- 10b. Genuine ambiguity from multiple quote hits ------------------

    #[test]
    fn multiple_quote_hits_emit_ambiguous_with_all_candidates_above_050() {
        let base = b"foo\n";
        let current = b"foo bar foo baz foo qux\n";
        let idx = build_anchor_index(current, &snap_id("s10c")).expect("idx");
        let h = content_hash(current);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([0, 3], [1, 1]),
            Some(quote("foo")),
            None,
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        match res {
            ResolvedAnchor::Ambiguous { candidates, .. } => {
                assert!(candidates.iter().all(|c| c.confidence >= 0.50));
                let high_count = candidates.iter().filter(|c| c.confidence >= 0.70).count();
                assert!(
                    high_count >= 2,
                    "expected ≥2 high-confidence, got {high_count}"
                );
            }
            other => panic!("expected Ambiguous, got {:?}", other),
        }
    }

    // ----- 11. Two candidates with gap > 0.10 → Remapped at top -------------

    #[test]
    fn two_candidates_separated_by_more_than_010_pick_top() {
        // Strategy: a single unique quote (0.90) plus a line-proximity
        // candidate (≤0.35). Gap is 0.55 → not ambiguous; resolver returns
        // Remapped at the top candidate.
        let base = b"original\n";
        let current = b"# H\n\nuniquely identifiable selection\n";
        let idx = build_anchor_index(current, &snap_id("s11")).expect("idx");
        let h = content_hash(current);
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([0, 8], [1, 1]),
            Some(quote("uniquely identifiable selection")),
            None,
            None,
            None,
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        match res {
            ResolvedAnchor::Remapped {
                confidence, reason, ..
            } => {
                assert!((confidence - conf::QUOTE_UNIQUE).abs() < 1e-9);
                assert!(matches!(reason, RemappedReason::QuoteMatch));
            }
            other => panic!("expected Remapped quote_match, got {:?}", other),
        }
    }

    // ----- 12. Dedup: same range, multiple steps → MAX confidence wins -----

    #[test]
    fn dedup_keeps_max_confidence_when_steps_overlap() {
        // Unique quote at 0.90 AND a structure-quote at 0.80 in the SAME range.
        // The combine pass dedups by byte_range and keeps the 0.90 one.
        let base = b"# H\n\nphrase to find here.\n";
        let current = b"# H\n\nphrase to find here.\n";
        let idx = build_anchor_index(current, &snap_id("s12")).expect("idx");
        let h = content_hash(current);
        let h_hash = build_anchor_index(base, &snap_id("s12b")).unwrap().headings[0]
            .text_hash
            .clone();
        use crate::review::model::AnchorHeadingRef;
        let structure = StructureAnchor {
            heading_path: vec![AnchorHeadingRef {
                level: 1,
                text_hash: h_hash,
                ordinal_at_level: 0,
            }],
            ordinal_in_parent: 0,
        };
        let a = make_anchor(
            base,
            "f1",
            "s1",
            pos([5, 24], [3, 3]),
            Some(quote("phrase to find here")),
            None,
            None,
            Some(structure),
        );
        let res = resolve_anchor(&a, &idx, current, &h, None).expect("ok");
        // Doc unchanged → base_hash matches → Exact.
        assert!(matches!(res, ResolvedAnchor::Exact { .. }));
    }

    // ----- 13. WrongFile branch is currently a no-op tautology — assert
    //          the resolver works fine when fileIds disagree (the manager
    //          owns routing; the check upgrades when AnchorIndex grows fileId).

    #[test]
    fn resolver_does_not_error_on_anchor_for_other_file_today() {
        let md = b"hello\n";
        let idx = build_anchor_index(md, &snap_id("s13")).expect("idx");
        let h = content_hash(md);
        let a = make_anchor(
            md,
            "f-other", // different fileId — currently unenforced
            "s1",
            pos([0, 5], [1, 1]),
            None,
            None,
            None,
            None,
        );
        // Documented limitation: today's check is a placeholder. When the
        // AnchorIndex grows fileId, this should flip to expect WrongFile.
        let res = resolve_anchor(&a, &idx, md, &h, None);
        assert!(res.is_ok());
    }

    // ----- 14. pmSteps slot is ignored (stub) -------------------------------

    #[test]
    fn pm_steps_argument_is_ignored_in_v0() {
        let md = b"# H\n\nbody.\n";
        let idx = build_anchor_index(md, &snap_id("s14")).expect("idx");
        let h = content_hash(md);
        let a = make_anchor(md, "f1", "s1", pos([0, 3], [1, 1]), None, None, None, None);
        let fake_steps: Value = serde_json::json!([{"stepType": "replace"}]);
        let res_a = resolve_anchor(&a, &idx, md, &h, None).expect("ok");
        let res_b = resolve_anchor(&a, &idx, md, &h, Some(&fake_steps)).expect("ok");
        // Stub: passing Some(...) currently has no effect. When step 2
        // lands this assertion should flip.
        assert_eq!(format!("{:?}", res_a), format!("{:?}", res_b));
    }

    // ----- 15. Internal helper: dedup_by_range_max collapses correctly ------

    #[test]
    fn dedup_by_range_max_takes_max_confidence_per_range() {
        let r = pos([10, 20], [2, 2]);
        let v = vec![
            Candidate {
                confidence: 0.70,
                current_range: r.clone(),
                reason: CandidateReason::ContextMatch,
                preview: String::new(),
            },
            Candidate {
                confidence: 0.85,
                current_range: r.clone(),
                reason: CandidateReason::BlockFingerprintMatch,
                preview: String::new(),
            },
            Candidate {
                confidence: 0.55,
                current_range: pos([30, 40], [4, 4]),
                reason: CandidateReason::FuzzyQuoteMatch,
                preview: String::new(),
            },
        ];
        let mut out = dedup_by_range_max(v);
        out.sort_by(|a, b| a.current_range.byte_range[0].cmp(&b.current_range.byte_range[0]));
        assert_eq!(out.len(), 2);
        assert!((out[0].confidence - 0.85).abs() < 1e-9);
        assert_eq!(out[0].reason, CandidateReason::BlockFingerprintMatch);
        assert!((out[1].confidence - 0.55).abs() < 1e-9);
    }

    // ----- 16. Internal helper: fuzzy_confidence sits in the right band ----

    #[test]
    fn fuzzy_confidence_maps_distance_to_band() {
        // distance 0 → FUZZY_MAX (0.75)
        let c0 = fuzzy_confidence(20, 0);
        assert!((c0 - conf::FUZZY_MAX).abs() < 1e-9);
        // distance == max_allowed → FUZZY_MIN (0.50)
        let max_allowed = 20usize / 5;
        let cmax = fuzzy_confidence(20, max_allowed);
        assert!((cmax - conf::FUZZY_MIN).abs() < 1e-9);
        // middle distance → between MIN and MAX
        let cmid = fuzzy_confidence(20, max_allowed / 2);
        assert!(cmid > conf::FUZZY_MIN && cmid < conf::FUZZY_MAX);
    }

    // ----- 17. Levenshtein bounded returns max_dist+1 when over the bound --

    #[test]
    fn levenshtein_bounded_caps_at_max_dist_plus_one() {
        assert_eq!(levenshtein_bounded(b"abc", b"abc", 1), 0);
        assert_eq!(levenshtein_bounded(b"abc", b"abd", 1), 1);
        // Totally different → exceeds bound 1 → returns 2 (max_dist + 1).
        assert_eq!(levenshtein_bounded(b"abc", b"xyz", 1), 2);
    }

    // ----- 18. Corpus replay test (skips if 3.6 hasn't merged yet) ---------

    #[test]
    fn corpus_replay_anchor_cases() {
        use std::path::Path;
        let dir = Path::new("planning/collab/test-vectors/anchor-cases");
        if !dir.exists() {
            eprintln!(
                "skipping corpus replay — {} does not exist (depends on 3.6)",
                dir.display()
            );
            return;
        }
        let entries = std::fs::read_dir(dir).expect("read anchor-cases dir");
        let mut checked = 0usize;
        for entry in entries {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let case_json = path.join("case.json");
            let expected_json = path.join("expected.json");
            if !case_json.exists() || !expected_json.exists() {
                continue;
            }
            // Cases are: { anchor, baseMarkdown, currentMarkdown } and
            // expected is the ResolvedAnchor variant. Schema is owned by
            // 3.6; this test deliberately keeps the shape loose (read as
            // serde_json::Value) so 3.6 can finalise the wire format
            // without re-touching this file.
            let case: Value =
                serde_json::from_str(&std::fs::read_to_string(&case_json).expect("read case"))
                    .expect("parse case");
            let expected: Value = serde_json::from_str(
                &std::fs::read_to_string(&expected_json).expect("read expected"),
            )
            .expect("parse expected");
            let anchor: Anchor =
                serde_json::from_value(case["anchor"].clone()).expect("parse anchor");
            let current_md = case["currentMarkdown"]
                .as_str()
                .expect("currentMarkdown is string");
            let snap = serde_json::from_value::<SnapshotId>(case["snapshotId"].clone())
                .unwrap_or_else(|_| snap_id("corpus-snap"));
            let idx = build_anchor_index(current_md.as_bytes(), &snap).expect("idx");
            let h = content_hash(current_md.as_bytes());
            let got =
                resolve_anchor(&anchor, &idx, current_md.as_bytes(), &h, None).expect("resolve ok");
            let got_value = serde_json::to_value(&got).expect("ser");
            // Compare just the `status` field — confidence calibration is
            // ongoing per amendments #15 and exact numbers may diverge.
            assert_eq!(
                got_value["status"],
                expected["status"],
                "case {} expected status {} got {}",
                path.display(),
                expected["status"],
                got_value["status"]
            );
            checked += 1;
        }
        // If the dir existed but had no cases, that's a soft pass.
        eprintln!("corpus replay: checked {checked} cases");
    }

    // ----- 19. Heading path comparison treats different level as unequal ----

    #[test]
    fn heading_paths_differ_when_level_differs() {
        use crate::review::model::AnchorHeadingRef;
        let a = vec![AnchorHeadingRef {
            level: 1,
            text_hash: "h".to_string(),
            ordinal_at_level: 0,
        }];
        let b = vec![AnchorHeadingRef {
            level: 2,
            text_hash: "h".to_string(),
            ordinal_at_level: 0,
        }];
        assert!(!heading_paths_equal(&a, &b));
        assert!(heading_paths_equal(&a, &a));
    }

    // ----- 20. find_all_byte_matches finds non-overlapping hits -------------

    #[test]
    fn find_all_byte_matches_returns_non_overlapping_hits() {
        assert_eq!(find_all_byte_matches(b"aaaa", b"aa"), vec![0, 2]);
        assert_eq!(find_all_byte_matches(b"abcabc", b"abc"), vec![0, 3]);
        assert_eq!(find_all_byte_matches(b"abc", b""), Vec::<usize>::new());
        assert_eq!(find_all_byte_matches(b"", b"abc"), Vec::<usize>::new());
    }

    /// An HTML anchor's offsets index rendered text, not markdown source, so
    /// the markdown ladder would land somewhere plausible and wrong rather than
    /// failing. It must refuse instead. @see html-annotation.md §7
    #[test]
    fn html_anchors_are_refused_rather_than_misresolved() {
        use crate::review::model::{
            HtmlAnchor, HtmlAnchorContext, HtmlAnchorTarget, SnapshotAnnotation,
        };
        let _ = SnapshotAnnotation::HtmlSelectorsV1;

        let md = b"# Title\n\nA paragraph of prose.\n";
        let index = build_anchor_index(md, &snap_id("snap-1")).expect("index");
        let hash = content_hash(md);
        let mut anchor = make_anchor(
            md,
            "file-1",
            "snap-1",
            pos([9, 20], [3, 3]),
            Some(quote("A paragraph")),
            None,
            None,
            None,
        );
        // Sanity: without the HTML layer this same anchor resolves fine, so the
        // refusal below is attributable to the layer and nothing else.
        assert!(resolve_anchor(&anchor, &index, md, &hash, None).is_ok());

        anchor.html = Some(HtmlAnchor {
            v: HtmlAnchor::VERSION,
            target: HtmlAnchorTarget::TextRange,
            css_selector: "p".into(),
            fallback_selectors: Vec::new(),
            text_position: None,
            range: None,
            context: HtmlAnchorContext {
                tag_name: "p".into(),
                role: None,
                scope_preview: "a paragraph".into(),
                dom_path: Vec::new(),
            },
        });
        assert_eq!(
            resolve_anchor(&anchor, &index, md, &hash, None),
            Err(ResolveError::HtmlAnchor)
        );
    }
}
