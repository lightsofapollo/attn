//! Suggestion resolver: given a `SuggestionCreated` event + the current owner
//! replica, decide whether the suggestion can apply cleanly, requires a
//! three-way dialog, or has gone stale.
//!
//! Does NOT perform the write — caller (Phase 5 issue 8.4) calls
//! `WorkingCopyService::save` once the user accepts.
//!
//! Spec: `planning/collab/data-model.md` §Suggestion Events + §Apply Flow.
//! The resolver runs ON TOP of the anchor resolver from issue 3.4
//! (`src/review/anchors/resolve.rs`): we re-resolve the suggestion's anchor
//! against the current owner replica, then layer the suggestion-specific
//! semantics (expected-text drift detection) on top.

#![allow(dead_code)]

use crate::review::anchors::resolve::{PmStepJournal, resolve_anchor};
use crate::review::ids::{ContentHash, EventId};
use crate::review::model::{
    AnchorIndex, PositionAnchor, ResolvedAnchor, ResolvedAnchorCandidate, ReviewEventBody,
    SuggestionOperation,
};
use unicode_normalization::UnicodeNormalization;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors the resolver can raise before producing an `ApplyVerdict`. Anchor
/// resolution failures do NOT live here — they are folded into the verdict
/// (`Stale` / `Ambiguous`). Only structural caller mistakes surface as errors.
#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    /// The caller passed a `ReviewEventBody` that wasn't a `SuggestionCreated`.
    /// The apply pipeline is suggestion-specific; routing belongs to the
    /// caller.
    #[error("event is not a suggestion")]
    NotSuggestion,
    /// Catch-all for unexpected resolver errors (e.g. anchor was routed to
    /// the wrong file). Currently unused by the happy paths but exists so the
    /// signature stays forward-compatible.
    #[error("apply: {0}")]
    Other(String),
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/// How the snapshot's `expected_text` compared to what is currently at the
/// target byte range. Produced by [`classify_text_match`] and consumed by the
/// resolver to choose between `Ready` (exact / safely-normalized) and
/// `RequiresThreeWay` (real drift).
///
/// Variants are ordered from "no doubt" → "real difference". The resolver
/// only treats `Mismatch` as a reason to escalate to three-way review;
/// `TrailingWhitespace` becomes a soft warning attached to `Ready`, and
/// `NormalizedUnicode` is accepted silently (NFC vs NFD render identically).
///
/// Intentionally NOT considered equivalent:
/// - **CRLF vs LF**: `WorkingCopyService` LF-normalizes on write, so the
///   on-disk current text is always LF. If a suggestion's `expected_text`
///   contains CR bytes, that is a real authoring-time / wire-format issue and
///   must surface as `Mismatch`.
/// - **Case differences**: never folded. "Foo" vs "foo" is a real edit.
/// - **BOM**: handled by upstream UTF-8 decoding; treated as a content byte
///   here, so a stray BOM on one side is `Mismatch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextMatchKind {
    /// Byte-identical.
    Exact,
    /// NFC and NFD differ between the two strings, but NFC-normalized forms
    /// are equal. Safe to apply silently — visually identical to the user.
    NormalizedUnicode,
    /// One or more lines differ only in trailing horizontal whitespace
    /// (`' '` / `'\t'`) or trailing newline characters. Apply is allowed but
    /// the verdict carries a confidence note so the UI can surface it.
    TrailingWhitespace,
    /// Real semantic difference. Forces the three-way dialog.
    Mismatch,
}

/// Outcome of resolving a suggestion against the owner's current document.
///
/// The owner UI consumes this directly to decide whether to surface a single
/// "Apply" button, a three-way diff, a candidate picker, or a stale warning.
#[derive(Debug, Clone)]
pub enum ApplyVerdict {
    /// Ready to apply — anchor resolved cleanly AND the expected text (for
    /// `Replace` / `Delete`) matches what is currently at the target range.
    /// Insertion variants always reach `Ready` when the anchor resolves
    /// (there is no expected text to drift).
    Ready {
        suggestion_id: EventId,
        /// Byte range in the current markdown that the caller will overwrite.
        /// For insertions this is a zero-length range positioned at the
        /// insertion cursor.
        target_byte_range: (usize, usize),
        /// Bytes to write. For `Delete` this is the empty string; for inserts
        /// it is the inserted text; for `Replace` it is the replacement.
        replacement: String,
        /// The anchor was exact OR remapped with confidence >= 0.90.
        confidence: f64,
        /// How the expected text compared to current. `Exact` for insertions
        /// (no expected text to compare).
        match_kind: TextMatchKind,
        /// Soft note when `match_kind` was not `Exact` — e.g. "trailing
        /// whitespace differs from snapshot". `None` when `match_kind` is
        /// `Exact`. The UI is free to render this as an inline hint.
        confidence_note: Option<String>,
    },
    /// Anchor resolved, but the expected text DOESN'T match what's at the
    /// target range. The owner needs a three-way diff (their edits + the
    /// suggestion's intent + the snapshot the suggestion was authored
    /// against) to decide what to do.
    RequiresThreeWay {
        suggestion_id: EventId,
        target_byte_range: (usize, usize),
        /// Text the suggestion expected to find at the target range when it
        /// was authored.
        snapshot_expected: String,
        /// Text actually present at the target range right now.
        current_text: String,
        /// Text the suggestion would write if accepted.
        proposed_replacement: String,
        confidence: f64,
    },
    /// Multiple candidate positions. The owner picks one before apply.
    Ambiguous {
        suggestion_id: EventId,
        candidates: Vec<ResolvedAnchorCandidate>,
    },
    /// Anchor stale — suggestion cannot apply automatically. The owner can
    /// still manually re-anchor (separate flow, owned by 8.6), but auto-apply
    /// is off the table.
    Stale {
        suggestion_id: EventId,
        reason: String,
    },
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/// Resolve a suggestion event against the current document.
///
/// `body` MUST be a `SuggestionCreated`; otherwise `ApplyError::NotSuggestion`.
///
/// Confidence policy (matches the band semantics in the resolver):
/// - Exact (resolver confidence ~1.0) or Remapped >= 0.90: the suggestion
///   can be `Ready` if expected text matches, `RequiresThreeWay` if it
///   doesn't.
/// - Remapped in [0.70, 0.90): same logic — expected-text mismatch is still
///   the trigger for `RequiresThreeWay`. (The lower confidence itself is a
///   warning the caller can render alongside `Ready`.)
/// - Remapped below 0.70: always `RequiresThreeWay` — the user must visually
///   confirm the position even if the expected text matches by coincidence.
/// - Ambiguous: forwarded as `ApplyVerdict::Ambiguous`.
/// - Stale: forwarded as `ApplyVerdict::Stale`.
pub fn resolve_suggestion(
    event_id: &EventId,
    body: &ReviewEventBody,
    current_index: &AnchorIndex,
    current_markdown_bytes: &[u8],
    current_hash: &ContentHash,
    pm_steps: Option<&PmStepJournal>,
) -> Result<ApplyVerdict, ApplyError> {
    let _ = event_id; // suggestion_id below is what the verdict carries; event_id reserved.
    let (suggestion_id, anchor, operation) = match body {
        ReviewEventBody::SuggestionCreated {
            suggestion_id,
            anchor,
            operation,
            ..
        } => (suggestion_id.clone(), anchor, operation),
        _ => return Err(ApplyError::NotSuggestion),
    };

    // The verdict carries the suggestion_id as an EventId (it is the stable
    // handle the owner UI uses to refer to the suggestion). Mint it from the
    // wire string the same way `model::tests` does — through serde — so we
    // never expose a constructor for typed ids outside the crypto module.
    let suggestion_id_typed: EventId = serde_json::from_value(
        serde_json::Value::String(suggestion_id.clone()),
    )
    .map_err(|e| ApplyError::Other(format!("suggestion id not serializable: {e}")))?;

    let resolved = resolve_anchor(
        anchor,
        current_index,
        current_markdown_bytes,
        current_hash,
        pm_steps,
    )
    .map_err(|e| ApplyError::Other(format!("anchor resolver: {e}")))?;

    Ok(decide(
        suggestion_id_typed,
        operation,
        resolved,
        current_markdown_bytes,
    ))
}

// ---------------------------------------------------------------------------
// Decision tree
// ---------------------------------------------------------------------------

/// Confidence threshold above which an exact-text mismatch is the ONLY thing
/// that triggers three-way dialog (resolver confidence is trusted).
const APPLY_HIGH_CONFIDENCE: f64 = 0.90;

/// Confidence threshold below which we always force three-way review — even
/// if the expected text happens to match by coincidence, the position is too
/// uncertain to apply silently.
const APPLY_REVIEW_FLOOR: f64 = 0.70;

/// Translate a `(ResolvedAnchor, SuggestionOperation)` pair into an
/// `ApplyVerdict`. Pure function — no IO.
fn decide(
    suggestion_id: EventId,
    operation: &SuggestionOperation,
    resolved: ResolvedAnchor,
    current_markdown_bytes: &[u8],
) -> ApplyVerdict {
    match resolved {
        ResolvedAnchor::Exact {
            confidence,
            current_range,
            ..
        } => decide_at_range(
            suggestion_id,
            operation,
            current_range,
            confidence,
            current_markdown_bytes,
            /*force_review=*/ false,
        ),
        ResolvedAnchor::Remapped {
            confidence,
            current_range,
            ..
        } => {
            // Below APPLY_REVIEW_FLOOR we force three-way review regardless of
            // expected-text match — position is too uncertain.
            let force_review = confidence < APPLY_REVIEW_FLOOR;
            decide_at_range(
                suggestion_id,
                operation,
                current_range,
                confidence,
                current_markdown_bytes,
                force_review,
            )
        }
        ResolvedAnchor::Ambiguous { candidates, .. } => ApplyVerdict::Ambiguous {
            suggestion_id,
            candidates,
        },
        ResolvedAnchor::Stale { reason } => ApplyVerdict::Stale {
            suggestion_id,
            reason,
        },
    }
}

/// Common branch: an anchor resolved to a single `PositionAnchor`. Apply the
/// suggestion-operation-specific rules.
fn decide_at_range(
    suggestion_id: EventId,
    operation: &SuggestionOperation,
    current_range: PositionAnchor,
    confidence: f64,
    current_markdown_bytes: &[u8],
    force_review: bool,
) -> ApplyVerdict {
    let (start, end) = position_to_usize_range(&current_range, current_markdown_bytes.len());

    match operation {
        SuggestionOperation::Replace {
            expected_text,
            replacement,
        } => {
            let current_text = slice_to_string(current_markdown_bytes, start, end);
            let kind = classify_text_match(expected_text, &current_text);
            // `Mismatch` is the only verdict that forces three-way drift. The
            // soft tiers (Exact / NormalizedUnicode / TrailingWhitespace) all
            // become `Ready`; `confidence_note` carries the soft-match hint.
            if !force_review && kind != TextMatchKind::Mismatch {
                ApplyVerdict::Ready {
                    suggestion_id,
                    target_byte_range: (start, end),
                    replacement: replacement.clone(),
                    confidence,
                    match_kind: kind,
                    confidence_note: match_kind_note(kind),
                }
            } else {
                ApplyVerdict::RequiresThreeWay {
                    suggestion_id,
                    target_byte_range: (start, end),
                    snapshot_expected: expected_text.clone(),
                    current_text,
                    proposed_replacement: replacement.clone(),
                    confidence,
                }
            }
        }
        SuggestionOperation::Delete { expected_text } => {
            let current_text = slice_to_string(current_markdown_bytes, start, end);
            let kind = classify_text_match(expected_text, &current_text);
            if !force_review && kind != TextMatchKind::Mismatch {
                ApplyVerdict::Ready {
                    suggestion_id,
                    target_byte_range: (start, end),
                    replacement: String::new(),
                    confidence,
                    match_kind: kind,
                    confidence_note: match_kind_note(kind),
                }
            } else {
                ApplyVerdict::RequiresThreeWay {
                    suggestion_id,
                    target_byte_range: (start, end),
                    snapshot_expected: expected_text.clone(),
                    current_text,
                    proposed_replacement: String::new(),
                    confidence,
                }
            }
        }
        SuggestionOperation::InsertBefore { text } => {
            // Zero-length range at the START of the anchor's current range —
            // the insertion cursor sits immediately before the anchored text.
            // No expected-text check (there is no "current text" at a cursor).
            //
            // If low confidence forces review, we still send three-way — but
            // with empty current_text/snapshot_expected because there's no
            // textual ground truth to compare. The UI rendering for that case
            // is the responsibility of 8.3 (three-way UI).
            if force_review {
                ApplyVerdict::RequiresThreeWay {
                    suggestion_id,
                    target_byte_range: (start, start),
                    snapshot_expected: String::new(),
                    current_text: String::new(),
                    proposed_replacement: text.clone(),
                    confidence,
                }
            } else {
                ApplyVerdict::Ready {
                    suggestion_id,
                    target_byte_range: (start, start),
                    replacement: text.clone(),
                    confidence,
                    // Insertions have no expected text to compare; treat
                    // them as `Exact` so the UI shows no soft warning.
                    match_kind: TextMatchKind::Exact,
                    confidence_note: None,
                }
            }
        }
        SuggestionOperation::InsertAfter { text } => {
            // Symmetric to InsertBefore but at the END of the anchor range.
            if force_review {
                ApplyVerdict::RequiresThreeWay {
                    suggestion_id,
                    target_byte_range: (end, end),
                    snapshot_expected: String::new(),
                    current_text: String::new(),
                    proposed_replacement: text.clone(),
                    confidence,
                }
            } else {
                ApplyVerdict::Ready {
                    suggestion_id,
                    target_byte_range: (end, end),
                    replacement: text.clone(),
                    confidence,
                    match_kind: TextMatchKind::Exact,
                    confidence_note: None,
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Project a `PositionAnchor.byte_range` (`[u64; 2]`) into a `(usize, usize)`
/// clamped to `bytes_len`. The resolver already guarantees `start <= end`
/// (its range constructor is `byte_range_to_position`), so this is a
/// straightforward narrowing.
fn position_to_usize_range(pos: &PositionAnchor, bytes_len: usize) -> (usize, usize) {
    let start = (pos.byte_range[0] as usize).min(bytes_len);
    let end = (pos.byte_range[1] as usize).min(bytes_len).max(start);
    (start, end)
}

/// Decode a byte range into a `String`, treating invalid UTF-8 conservatively
/// as the empty string. The canonical markdown bytes the apply pipeline
/// receives are guaranteed UTF-8 (the snapshot/anchor pipeline rejects
/// non-UTF-8 upstream), so this is defensive.
fn slice_to_string(bytes: &[u8], start: usize, end: usize) -> String {
    std::str::from_utf8(&bytes[start..end])
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// Classify how `current` (text actually at the target byte range right now)
/// compares to `snapshot` (the suggestion's `expected_text` captured at
/// authoring time). The returned [`TextMatchKind`] drives whether the apply
/// resolver issues `Ready` or `RequiresThreeWay`.
///
/// Tier order (first match wins):
/// 1. **Exact** — byte equality. Cheapest, hottest path; we exit before
///    paying for any normalization.
/// 2. **NormalizedUnicode** — equal after NFC normalization of both sides.
///    This catches NFC↔NFD round-trips (e.g. precomposed `é` vs `e` + combining
///    acute) that render identically. Case is NEVER folded. CR / LF differences
///    are NOT folded — they go to `Mismatch` below.
/// 3. **TrailingWhitespace** — line-by-line, both sides agree on the
///    non-trailing content of every line; only `' '` / `'\t'` / trailing
///    newlines differ. The on-disk text the resolver compares against has
///    already gone through `WorkingCopyService`'s LF-normalization, so the
///    only realistic source of this drift is the editor stripping trailing
///    spaces between the author capturing `expected_text` and the owner
///    receiving the suggestion. Surfaces a soft warning on the `Ready`
///    verdict but does NOT block apply.
/// 4. **Mismatch** — anything else, including CRLF↔LF, case differences, BOM
///    on one side, internal whitespace differences, and structural edits.
pub fn classify_text_match(snapshot: &str, current: &str) -> TextMatchKind {
    // (1) Cheap exact path. This is the hottest branch in practice.
    if snapshot == current {
        return TextMatchKind::Exact;
    }

    // (2) Unicode normalization. NFC is the canonical form per Unicode 15 and
    // matches what most macOS / Windows text editors produce; NFD shows up
    // from HFS+ paths and some Asian IMEs. Both sides go through NFC so we
    // catch the cross-form case symmetrically. We deliberately do NOT do
    // case folding or compatibility normalization (NFKC/NFKD) — those would
    // erase information the user might care about (e.g. wide vs narrow
    // digits, ﬁ ligature vs `f` + `i`).
    if needs_nfc_normalization(snapshot, current) {
        let snap_nfc: String = snapshot.nfc().collect();
        let cur_nfc: String = current.nfc().collect();
        if snap_nfc == cur_nfc {
            return TextMatchKind::NormalizedUnicode;
        }
    }

    // (3) Trailing whitespace tolerance. Line-by-line: every pair of lines
    // must agree once trailing `' '`/`'\t'` is stripped, AND the strings must
    // have the same line count modulo a single trailing newline difference.
    if trailing_whitespace_equal(snapshot, current) {
        return TextMatchKind::TrailingWhitespace;
    }

    TextMatchKind::Mismatch
}

/// Fast path guard for NFC normalization: skip allocating the NFC strings
/// when both inputs are pure ASCII (NFC is identity on ASCII). Returns true
/// if either side contains a non-ASCII byte.
#[inline]
fn needs_nfc_normalization(a: &str, b: &str) -> bool {
    !a.is_ascii() || !b.is_ascii()
}

/// Two strings are trailing-whitespace-equal when split-by-`'\n'` produces
/// the same sequence of lines after stripping trailing spaces and tabs from
/// each line. A single trailing newline difference (one ends with `\n`, the
/// other doesn't) is folded in — `split('\n')` represents that as a single
/// trailing empty element on the side with the newline.
///
/// `\r` is INTENTIONALLY not stripped: CRLF↔LF must surface as `Mismatch`
/// because `WorkingCopyService` normalizes to LF on write and a stray CR on
/// either side is a real wire-format or encoding bug.
fn trailing_whitespace_equal(a: &str, b: &str) -> bool {
    let mut ai = a.split('\n');
    let mut bi = b.split('\n');
    let mut saw_trailing_ws_diff = false;
    loop {
        match (ai.next(), bi.next()) {
            (None, None) => break,
            (Some(la), Some(lb)) => {
                // Trim ONLY ASCII space + tab. We don't trim '\r' here —
                // CRLF vs LF must be a real mismatch.
                let la_t = la.trim_end_matches(|c: char| c == ' ' || c == '\t');
                let lb_t = lb.trim_end_matches(|c: char| c == ' ' || c == '\t');
                if la_t != lb_t {
                    return false;
                }
                if la_t.len() != la.len() || lb_t.len() != lb.len() {
                    saw_trailing_ws_diff = true;
                }
            }
            // One side has more lines. The only allowable case is a single
            // trailing-newline difference, which manifests as one empty extra
            // element. Anything else is structural drift.
            (Some(extra), None) | (None, Some(extra)) => {
                if !extra.is_empty() || ai.next().is_some() || bi.next().is_some() {
                    return false;
                }
                saw_trailing_ws_diff = true;
            }
        }
    }
    // We only reach here when every pair of lines matched once trimmed. To
    // qualify as `TrailingWhitespace` (not `Exact`) we must have actually
    // observed a difference somewhere — otherwise the caller already would
    // have taken the `Exact` branch.
    saw_trailing_ws_diff
}

/// Map a [`TextMatchKind`] to the human-readable note attached to a
/// [`ApplyVerdict::Ready`]'s `confidence_note`. `None` when no annotation is
/// warranted (the caller is expected to convert `Mismatch` into
/// `RequiresThreeWay` before reaching here).
fn match_kind_note(kind: TextMatchKind) -> Option<String> {
    match kind {
        TextMatchKind::Exact => None,
        TextMatchKind::NormalizedUnicode => {
            Some("text matched after Unicode NFC normalization".to_string())
        }
        TextMatchKind::TrailingWhitespace => {
            Some("trailing whitespace differs from snapshot".to_string())
        }
        // The caller funnels Mismatch into the three-way path before this is
        // ever consulted; surface a defensive note rather than panicking.
        TextMatchKind::Mismatch => Some("text mismatch (forwarded to three-way)".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::anchors::index::build_anchor_index;
    use crate::review::crypto::ids::content_hash;
    use crate::review::ids::{ContentHash, EventId, FileId, SnapshotId};
    use crate::review::model::{
        Anchor, AnchorBlockKind, PositionAnchor, QuoteAnchor, ResolvedAnchor,
        ResolvedAnchorCandidate, ReviewEventBody, SuggestionOperation,
    };
    use serde_json::Value;

    // ----- typed-id helpers (same trick as model.rs / resolve.rs tests) -----

    fn snap_id(s: &str) -> SnapshotId {
        serde_json::from_value(Value::String(s.to_string())).expect("snap id")
    }
    fn file_id(s: &str) -> FileId {
        serde_json::from_value(Value::String(s.to_string())).expect("file id")
    }
    fn event_id(s: &str) -> EventId {
        serde_json::from_value(Value::String(s.to_string())).expect("event id")
    }
    fn hash_id(s: &str) -> ContentHash {
        serde_json::from_value(Value::String(s.to_string())).expect("content hash")
    }

    // ----- anchor builders ---------------------------------------------------

    fn quote(text: &str) -> QuoteAnchor {
        QuoteAnchor {
            exact: text.to_string(),
            exact_hash: "fake-exact-hash".to_string(),
            normalized: text.to_ascii_lowercase(),
            normalized_hash: "fake-norm-hash".to_string(),
        }
    }

    /// Build a quote-bearing anchor that targets `needle` inside `base_md`.
    /// Used for the happy-path tests where we want the anchor to resolve
    /// cleanly via the quote step.
    fn quote_anchor(base_md: &[u8], needle: &str, snap: &str) -> Anchor {
        let needle_bytes = needle.as_bytes();
        let pos_start = base_md
            .windows(needle_bytes.len())
            .position(|w| w == needle_bytes)
            .expect("needle is present in base_md");
        let pos_end = pos_start + needle_bytes.len();
        Anchor {
            v: 2,
            file_id: file_id("f1"),
            snapshot_id: snap_id(snap),
            base_hash: content_hash(base_md),
            position: PositionAnchor {
                byte_range: [pos_start as u64, pos_end as u64],
                line_range: [1, 1],
                pm_range: None,
            },
            quote: Some(quote(needle)),
            block: None,
            context: None,
            structure: None,
        }
    }

    /// Build the `SuggestionCreated` body wrapping `op` + `anchor`.
    fn suggestion_event(suggestion_id: &str, anchor: Anchor, op: SuggestionOperation)
        -> ReviewEventBody
    {
        ReviewEventBody::SuggestionCreated {
            suggestion_id: suggestion_id.to_string(),
            anchor,
            operation: op,
            note: None,
        }
    }

    // ====== TESTS ==========================================================

    /// Exact-resolve (base_hash match) + matching expected_text → Ready.
    #[test]
    fn replace_exact_match_returns_ready() {
        let md = b"the quick brown fox\n";
        let snap = "s1";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "brown", snap);
        let op = SuggestionOperation::Replace {
            expected_text: "brown".into(),
            replacement: "auburn".into(),
        };
        let body = suggestion_event("sug-1", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-1"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::Ready {
                replacement,
                target_byte_range,
                confidence,
                ..
            } => {
                assert_eq!(replacement, "auburn");
                let (s, e) = target_byte_range;
                assert_eq!(&md[s..e], b"brown");
                assert!(confidence >= APPLY_HIGH_CONFIDENCE);
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    /// Exact-resolve + mismatching expected_text → RequiresThreeWay.
    #[test]
    fn replace_expected_text_mismatch_returns_three_way() {
        let md = b"the quick brown fox\n";
        let snap = "s1";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "brown", snap);
        // Owner edited "brown" → "scarlet" before the suggestion arrived. The
        // suggestion still expects "brown" but the current text is "brown"
        // (we don't actually edit here; instead lie about expected_text so the
        // comparison fails — same effect for the decision tree).
        let op = SuggestionOperation::Replace {
            expected_text: "vermilion".into(),
            replacement: "auburn".into(),
        };
        let body = suggestion_event("sug-2", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-2"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::RequiresThreeWay {
                snapshot_expected,
                current_text,
                proposed_replacement,
                ..
            } => {
                assert_eq!(snapshot_expected, "vermilion");
                assert_eq!(current_text, "brown");
                assert_eq!(proposed_replacement, "auburn");
            }
            other => panic!("expected RequiresThreeWay, got {other:?}"),
        }
    }

    /// Remapped 0.95 (synthesized) + match → Ready. We can't easily get the
    /// real resolver to produce a remapped 0.95 result in a one-line test, so
    /// we exercise the `decide` function directly with a synthesized resolver
    /// outcome.
    #[test]
    fn remapped_high_confidence_match_returns_ready() {
        let md = b"the quick brown fox\n";
        let resolved = ResolvedAnchor::Remapped {
            confidence: 0.95,
            current_range: PositionAnchor {
                byte_range: [10, 15],
                line_range: [1, 1],
                pm_range: None,
            },
            reason: crate::review::model::RemappedReason::QuoteMatch,
        };
        let op = SuggestionOperation::Replace {
            expected_text: "brown".into(),
            replacement: "tawny".into(),
        };
        let verdict = decide(event_id("sug-3"), &op, resolved, md);
        match verdict {
            ApplyVerdict::Ready {
                confidence,
                replacement,
                target_byte_range,
                ..
            } => {
                assert!((confidence - 0.95).abs() < 1e-9);
                assert_eq!(replacement, "tawny");
                assert_eq!(target_byte_range, (10, 15));
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    /// Remapped 0.80 + match → Ready (policy: 0.70..0.90 still trusts the
    /// expected-text check; the UI can render the confidence as a soft
    /// warning alongside the Apply button).
    #[test]
    fn remapped_mid_confidence_match_returns_ready() {
        let md = b"the quick brown fox\n";
        let resolved = ResolvedAnchor::Remapped {
            confidence: 0.80,
            current_range: PositionAnchor {
                byte_range: [10, 15],
                line_range: [1, 1],
                pm_range: None,
            },
            reason: crate::review::model::RemappedReason::StructureQuoteMatch,
        };
        let op = SuggestionOperation::Replace {
            expected_text: "brown".into(),
            replacement: "tawny".into(),
        };
        let verdict = decide(event_id("sug-4"), &op, resolved, md);
        match verdict {
            ApplyVerdict::Ready { confidence, .. } => {
                assert!((confidence - 0.80).abs() < 1e-9);
            }
            other => panic!("expected Ready (mid confidence), got {other:?}"),
        }
    }

    /// Remapped 0.50 + match → RequiresThreeWay. Below APPLY_REVIEW_FLOOR
    /// (0.70), force the user to confirm the position even when the
    /// expected text happens to match.
    #[test]
    fn remapped_low_confidence_forces_three_way() {
        let md = b"the quick brown fox\n";
        let resolved = ResolvedAnchor::Remapped {
            confidence: 0.50,
            current_range: PositionAnchor {
                byte_range: [10, 15],
                line_range: [1, 1],
                pm_range: None,
            },
            reason: crate::review::model::RemappedReason::FuzzyQuoteMatch,
        };
        let op = SuggestionOperation::Replace {
            expected_text: "brown".into(),
            replacement: "tawny".into(),
        };
        let verdict = decide(event_id("sug-5"), &op, resolved, md);
        match verdict {
            ApplyVerdict::RequiresThreeWay {
                snapshot_expected,
                current_text,
                confidence,
                ..
            } => {
                assert_eq!(snapshot_expected, "brown");
                assert_eq!(current_text, "brown");
                assert!((confidence - 0.50).abs() < 1e-9);
            }
            other => panic!("expected RequiresThreeWay, got {other:?}"),
        }
    }

    /// Ambiguous → Ambiguous (with all candidates forwarded).
    #[test]
    fn ambiguous_resolution_returns_ambiguous_verdict() {
        let md = b"alpha alpha alpha\n";
        let snap = "s6";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        // base_md DIFFERS from current so base_hash step does NOT fire, and
        // the quote "alpha" matches in three places in the current doc —
        // resolver produces an Ambiguous outcome.
        let base = b"alpha\n";
        let mut anchor = quote_anchor(base, "alpha", snap);
        // Override the file_id so it matches "f1" (quote_anchor already uses f1).
        anchor.base_hash = content_hash(base);
        let op = SuggestionOperation::Replace {
            expected_text: "alpha".into(),
            replacement: "omega".into(),
        };
        let body = suggestion_event("sug-6", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-6"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::Ambiguous { candidates, .. } => {
                assert!(candidates.len() >= 3, "expected >=3 candidates, got {}", candidates.len());
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    /// Stale → Stale. If the document is wholly unrelated and the original
    /// line range was much larger than the current document (forcing the
    /// line-proximity step to clamp heavily), the resolver returns Stale and
    /// the suggestion resolver forwards it.
    #[test]
    fn stale_resolution_returns_stale_verdict() {
        // The base doc had ~100 lines; the current doc has only 3. The quote
        // does not appear, the base hash differs, no block fingerprint
        // matches, no structure/context matches — only line proximity fires,
        // and its confidence drops below STALE_FLOOR (0.35) because the line
        // range had to clamp from 100 lines down to ~3.
        let current = b"# Title\n\nshort doc\n";
        let snap = "s7";
        let idx = build_anchor_index(current, &snap_id(snap)).expect("idx");
        let h = content_hash(current);
        // base_hash is just a synthetic hash — won't match the current doc.
        let synthetic_hash = hash_id("not-a-real-hash-just-doesn-t-match");
        let anchor = Anchor {
            v: 2,
            file_id: file_id("f1"),
            snapshot_id: snap_id(snap),
            base_hash: synthetic_hash,
            position: PositionAnchor {
                // Past-EOF byte range AND a 100-line span the resolver must
                // clamp to fit in a 3-line doc → line-prox confidence drops
                // far below STALE_FLOOR (0.35).
                byte_range: [9999, 10009],
                line_range: [900, 1000],
                pm_range: None,
            },
            quote: Some(quote("nonexistent token never appearing anywhere")),
            block: None,
            context: None,
            structure: None,
        };
        let op = SuggestionOperation::Replace {
            expected_text: "nonexistent token never appearing anywhere".into(),
            replacement: "x".into(),
        };
        let body = suggestion_event("sug-7", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-7"), &body, &idx, current, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::Stale { reason, suggestion_id } => {
                assert!(!reason.is_empty());
                assert_eq!(suggestion_id, event_id("sug-7"));
            }
            other => panic!("expected Stale, got {other:?}"),
        }
    }

    /// InsertBefore at exact anchor → Ready, zero-length target_byte_range
    /// at the start of the anchored span.
    #[test]
    fn insert_before_at_exact_anchor_returns_ready() {
        let md = b"the quick brown fox\n";
        let snap = "s8";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "brown", snap);
        let op = SuggestionOperation::InsertBefore { text: "very ".into() };
        let body = suggestion_event("sug-8", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-8"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::Ready {
                replacement,
                target_byte_range,
                ..
            } => {
                assert_eq!(replacement, "very ");
                let (s, e) = target_byte_range;
                assert_eq!(s, e, "insertion is zero-length");
                // The "brown" needle starts at byte 10 in "the quick brown fox\n".
                assert_eq!(s, 10);
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    /// InsertAfter at exact anchor → Ready, zero-length target_byte_range
    /// at the end of the anchored span.
    #[test]
    fn insert_after_at_exact_anchor_returns_ready() {
        let md = b"the quick brown fox\n";
        let snap = "s9";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "brown", snap);
        let op = SuggestionOperation::InsertAfter { text: " (auburn)".into() };
        let body = suggestion_event("sug-9", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-9"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::Ready {
                replacement,
                target_byte_range,
                ..
            } => {
                assert_eq!(replacement, " (auburn)");
                let (s, e) = target_byte_range;
                assert_eq!(s, e, "insertion is zero-length");
                // "brown" ends at byte 15 (start 10, len 5).
                assert_eq!(s, 15);
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    /// Delete with matching expected_text → Ready (replacement="").
    #[test]
    fn delete_match_returns_ready_with_empty_replacement() {
        let md = b"the quick brown fox\n";
        let snap = "s10";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "brown", snap);
        let op = SuggestionOperation::Delete {
            expected_text: "brown".into(),
        };
        let body = suggestion_event("sug-10", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-10"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::Ready {
                replacement,
                target_byte_range,
                ..
            } => {
                assert_eq!(replacement, "", "delete writes empty replacement");
                let (s, e) = target_byte_range;
                assert_eq!(&md[s..e], b"brown");
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    /// Delete with mismatching expected_text → RequiresThreeWay.
    #[test]
    fn delete_mismatch_returns_three_way() {
        let md = b"the quick brown fox\n";
        let snap = "s11";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "brown", snap);
        let op = SuggestionOperation::Delete {
            expected_text: "scarlet".into(),
        };
        let body = suggestion_event("sug-11", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-11"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::RequiresThreeWay {
                snapshot_expected,
                current_text,
                proposed_replacement,
                ..
            } => {
                assert_eq!(snapshot_expected, "scarlet");
                assert_eq!(current_text, "brown");
                assert_eq!(proposed_replacement, "");
            }
            other => panic!("expected RequiresThreeWay, got {other:?}"),
        }
    }

    /// Wrong event variant (CommentCreated) → ApplyError::NotSuggestion.
    #[test]
    fn non_suggestion_event_returns_not_suggestion_error() {
        let md = b"the quick brown fox\n";
        let snap = "s12";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "brown", snap);
        let body = ReviewEventBody::CommentCreated {
            thread_id: "t1".to_string(),
            anchor,
            body: "nice fox".to_string(),
        };
        let err = resolve_suggestion(&event_id("evt-12"), &body, &idx, md, &h, None)
            .expect_err("must reject non-suggestion");
        assert!(matches!(err, ApplyError::NotSuggestion), "got {err:?}");
    }

    /// Sanity: the verdict is `Clone`. (The struct derives Clone so this is
    /// a compile-time check disguised as a runtime smoke test.)
    #[test]
    fn verdict_is_clone() {
        let v = ApplyVerdict::Stale {
            suggestion_id: event_id("sug-x"),
            reason: "x".into(),
        };
        let _ = v.clone();
    }

    /// Suppress the unused warning on the `hash_id` helper — it stays here
    /// for parity with the other test modules in the review domain.
    #[test]
    fn helper_hash_id_compiles() {
        let _ = hash_id("h-x");
    }

    /// Quiet the unused-import warning if a future refactor drops one of
    /// these — the tests rely on them.
    #[test]
    fn helper_imports_compile() {
        let _ = AnchorBlockKind::Paragraph;
        let _ = ResolvedAnchorCandidate {
            confidence: 1.0,
            current_range: PositionAnchor {
                byte_range: [0, 0],
                line_range: [1, 1],
                pm_range: None,
            },
            reason: "x".into(),
            preview: String::new(),
        };
    }

    // ====== classify_text_match coverage (attn-nnj.8.2) ====================
    //
    // These tests pin down the boundary between safe normalizations (which
    // resolve to `Ready`) and real drift (which forces three-way review).
    // Anything that flips one of these assertions silently is a correctness
    // regression — the apply flow could either reject benign whitespace
    // changes (annoying) or silently overwrite user edits (dangerous).

    /// (1) Byte-identical inputs are `Exact` — the cheap path.
    #[test]
    fn classify_exact_equal_ascii() {
        assert_eq!(
            classify_text_match("hello world", "hello world"),
            TextMatchKind::Exact,
        );
    }

    /// (2) CRLF on one side, LF on the other → `Mismatch`. `WorkingCopyService`
    /// always writes LF; a stray CR is a real wire-format issue and must
    /// escalate to three-way review.
    #[test]
    fn classify_crlf_vs_lf_is_mismatch() {
        assert_eq!(
            classify_text_match("line a\r\nline b\r\n", "line a\nline b\n"),
            TextMatchKind::Mismatch,
        );
    }

    /// (3) NFC (precomposed) vs NFD (decomposed) of the same string →
    /// `NormalizedUnicode`. "é" as U+00E9 vs "e" + U+0301 renders identically;
    /// safe to apply.
    #[test]
    fn classify_nfc_vs_nfd_returns_normalized_unicode() {
        // U+00E9 (LATIN SMALL LETTER E WITH ACUTE)
        let nfc = "café";
        // 'e' followed by U+0301 (COMBINING ACUTE ACCENT)
        let nfd = "cafe\u{0301}";
        assert_ne!(nfc, nfd, "test inputs must differ byte-wise");
        assert_eq!(
            classify_text_match(nfc, nfd),
            TextMatchKind::NormalizedUnicode,
        );
        // Symmetric: snapshot=NFD, current=NFC.
        assert_eq!(
            classify_text_match(nfd, nfc),
            TextMatchKind::NormalizedUnicode,
        );
    }

    /// (4) Accented character authored once with a precomposed glyph and once
    /// with combining marks (a slightly fancier NFC/NFD case using a string
    /// with multiple combining marks) → `NormalizedUnicode`.
    #[test]
    fn classify_combining_marks_round_trip() {
        // "ǻ" (U+01FB) NFC = "a" + U+030A + U+0301 NFD-decomposed form.
        let precomposed = "\u{01FB}";
        let decomposed = "a\u{030A}\u{0301}";
        assert_ne!(precomposed, decomposed);
        assert_eq!(
            classify_text_match(precomposed, decomposed),
            TextMatchKind::NormalizedUnicode,
        );
    }

    /// (5) Case differences are never folded — case is meaningful in
    /// markdown content. "Foo" vs "foo" is a real edit.
    #[test]
    fn classify_case_difference_is_mismatch() {
        assert_eq!(
            classify_text_match("Hello World", "hello world"),
            TextMatchKind::Mismatch,
        );
    }

    /// (6) Trailing space on one side, none on the other → `TrailingWhitespace`.
    /// Editors that strip trailing spaces on save are a common drift source.
    #[test]
    fn classify_trailing_space_returns_trailing_whitespace() {
        assert_eq!(
            classify_text_match("a line   ", "a line"),
            TextMatchKind::TrailingWhitespace,
        );
        // Symmetric.
        assert_eq!(
            classify_text_match("a line", "a line   "),
            TextMatchKind::TrailingWhitespace,
        );
    }

    /// (7) Trailing newline on one side, none on the other → `TrailingWhitespace`.
    /// Common when a snippet was captured mid-line vs end-of-file.
    #[test]
    fn classify_trailing_newline_returns_trailing_whitespace() {
        assert_eq!(
            classify_text_match("line one\n", "line one"),
            TextMatchKind::TrailingWhitespace,
        );
    }

    /// (8) Same line count, internal whitespace difference (extra space INSIDE
    /// a word, not at end of line) → `Mismatch`. Trailing-only tolerance must
    /// not swallow content-shifting whitespace edits.
    #[test]
    fn classify_internal_whitespace_difference_is_mismatch() {
        // "hello  world" (two spaces) vs "hello world" (one space) — the diff
        // is in the middle of the line, not at the end.
        assert_eq!(
            classify_text_match("hello  world\nline two", "hello world\nline two"),
            TextMatchKind::Mismatch,
        );
    }

    /// (9) Empty strings on both sides are `Exact` — degenerate base case the
    /// resolver hits when comparing a zero-length insertion target.
    #[test]
    fn classify_empty_strings_are_exact() {
        assert_eq!(classify_text_match("", ""), TextMatchKind::Exact);
    }

    /// (10) Identical Unicode emoji strings (multi-byte UTF-8 with no
    /// normalization difference) hit the `Exact` fast path — the NFC branch
    /// is correctly skipped via the ASCII guard NOT firing but the byte-eq
    /// check succeeding.
    #[test]
    fn classify_unicode_emoji_exact() {
        let emoji = "ship it 🚀 done ✅";
        assert_eq!(classify_text_match(emoji, emoji), TextMatchKind::Exact);
    }

    /// Bonus: NFD-equal strings that ALSO have a trailing-space difference
    /// fall through to `Mismatch`. The two soft tiers are independent — we
    /// don't NFC-normalize INSIDE the trailing-whitespace check, and the NFC
    /// branch doesn't trim trailing whitespace before comparing. This is a
    /// documented limitation: the two normalizations don't compose. A
    /// suggestion with combined drift (Unicode form + trailing whitespace)
    /// must go through three-way review. Locking this behavior with a test so
    /// a future refactor that composes the two tiers is an explicit decision,
    /// not an accident.
    #[test]
    fn classify_nfd_plus_trailing_space_is_mismatch() {
        let nfc = "café";
        let nfd_with_space = "cafe\u{0301}   ";
        assert_eq!(
            classify_text_match(nfc, nfd_with_space),
            TextMatchKind::Mismatch,
        );
    }

    /// Bonus: structural change — different line count beyond just a trailing
    /// newline → `Mismatch`.
    #[test]
    fn classify_added_line_is_mismatch() {
        assert_eq!(
            classify_text_match("one\ntwo\n", "one\ntwo\nthree\n"),
            TextMatchKind::Mismatch,
        );
    }

    /// Bonus: BOM (U+FEFF) on one side only → `Mismatch`. BOM is a content
    /// byte at this layer; upstream UTF-8 decoding already handled the
    /// encoding-marker question.
    #[test]
    fn classify_bom_on_one_side_is_mismatch() {
        assert_eq!(
            classify_text_match("\u{FEFF}hello", "hello"),
            TextMatchKind::Mismatch,
        );
    }

    /// Bonus property-style: for any string s, classify(s, s) is Exact and
    /// classify(s, s + "x") is Mismatch (the ContentHash spec's
    /// strict-equality invariant on identical bytes, lifted into the
    /// classifier).
    #[test]
    fn classify_property_self_and_append() {
        for s in [
            "",
            "ascii",
            "with\nnewlines",
            "café",          // NFC
            "cafe\u{0301}",  // NFD
            "🚀 ship",
        ] {
            assert_eq!(classify_text_match(s, s), TextMatchKind::Exact, "self: {s:?}");
            let appended = format!("{s}x");
            assert_eq!(
                classify_text_match(s, &appended),
                TextMatchKind::Mismatch,
                "appended: {s:?} vs {appended:?}",
            );
        }
    }

    // --- Integration: classify_text_match wired into resolve_suggestion ---

    /// NFC vs NFD at the apply-flow level → `Ready` with
    /// `match_kind = NormalizedUnicode` and a confidence note. Proves the
    /// classifier is actually wired into the resolver's decision tree, not
    /// just exported as a standalone helper.
    #[test]
    fn resolve_suggestion_nfd_current_text_returns_ready_normalized() {
        // Current doc holds the NFD form of "café"; the suggestion's
        // expected_text is the NFC form. The anchor's quote must also be NFD
        // so the resolver's quote step finds the right byte range.
        let md_str = "the quick cafe\u{0301} fox\n";
        let md = md_str.as_bytes();
        let snap = "s-nfd";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        // Anchor needs to target "cafe\u{0301}" exactly so the quote step
        // resolves to the NFD bytes in the current doc.
        let anchor = quote_anchor(md, "cafe\u{0301}", snap);
        let op = SuggestionOperation::Replace {
            expected_text: "café".into(), // NFC form
            replacement: "espresso".into(),
        };
        let body = suggestion_event("sug-nfd", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-nfd"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::Ready {
                match_kind,
                confidence_note,
                replacement,
                ..
            } => {
                assert_eq!(match_kind, TextMatchKind::NormalizedUnicode);
                assert!(confidence_note.is_some(), "expected a confidence note");
                assert_eq!(replacement, "espresso");
            }
            other => panic!("expected Ready (NormalizedUnicode), got {other:?}"),
        }
    }

    /// Trailing-space difference at the apply-flow level → `Ready` with
    /// `match_kind = TrailingWhitespace` and a "trailing whitespace differs"
    /// note. The resolver accepts the apply but surfaces the soft warning.
    #[test]
    fn resolve_suggestion_trailing_space_returns_ready_with_note() {
        // Current doc has "fox   " (three trailing spaces); the suggestion's
        // expected_text omits them. The anchor targets the "fox   " bytes so
        // the quote step lands precisely on the trailing-whitespace region.
        let md = b"the quick brown fox   \n";
        let snap = "s-trail";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "fox   ", snap);
        let op = SuggestionOperation::Replace {
            expected_text: "fox".into(), // no trailing spaces
            replacement: "wolf".into(),
        };
        let body = suggestion_event("sug-trail", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-trail"), &body, &idx, md, &h, None)
            .expect("verdict");
        match verdict {
            ApplyVerdict::Ready {
                match_kind,
                confidence_note,
                replacement,
                ..
            } => {
                assert_eq!(match_kind, TextMatchKind::TrailingWhitespace);
                assert_eq!(
                    confidence_note.as_deref(),
                    Some("trailing whitespace differs from snapshot"),
                );
                assert_eq!(replacement, "wolf");
            }
            other => panic!("expected Ready (TrailingWhitespace), got {other:?}"),
        }
    }

    /// CRLF vs LF at the apply-flow level → `RequiresThreeWay`. The current
    /// doc is LF (post-WorkingCopyService normalization); the suggestion's
    /// `expected_text` smuggled in CRLF, which is a real mismatch.
    #[test]
    fn resolve_suggestion_crlf_in_expected_text_forces_three_way() {
        let md = b"line a\nline b\n";
        let snap = "s-crlf";
        let idx = build_anchor_index(md, &snap_id(snap)).expect("idx");
        let h = content_hash(md);
        let anchor = quote_anchor(md, "line a\nline b", snap);
        let op = SuggestionOperation::Replace {
            expected_text: "line a\r\nline b".into(), // CRLF — must NOT fold to LF
            replacement: "line A\nline B".into(),
        };
        let body = suggestion_event("sug-crlf", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-crlf"), &body, &idx, md, &h, None)
            .expect("verdict");
        assert!(
            matches!(verdict, ApplyVerdict::RequiresThreeWay { .. }),
            "expected RequiresThreeWay (CRLF mismatch), got {verdict:?}",
        );
    }
}
