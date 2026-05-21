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

use std::path::PathBuf;
use std::sync::Arc;

use crate::review::anchors::resolve::{PmStepJournal, resolve_anchor};
use crate::review::crypto::ids::content_hash;
use crate::review::ids::{ContentHash, EventId, FileId, RoomId};
use crate::review::model::{
    AnchorIndex, LocalRevision, PositionAnchor, ResolvedAnchor, ResolvedAnchorCandidate,
    ReviewEventBody, SuggestionOperation,
};
use crate::review::store::ReviewStore;
use crate::review::working_copy::{SaveRequest, SaveSource, WorkingCopyError, WorkingCopyService};
use unicode_normalization::UnicodeNormalization;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors the resolver can raise before producing an `ApplyVerdict`. Anchor
/// resolution failures do NOT live here — they are folded into the verdict
/// (`Stale` / `Ambiguous`). Only structural caller mistakes surface as errors.
///
/// The `apply_ready_verdict` entry-point reuses this enum so the orchestrator
/// has a single error type. Write-path failures (stale-hash drift, IO,
/// non-`Ready` verdicts) get their own variants below; resolver-path failures
/// keep the original variants.
#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    /// The caller passed a `ReviewEventBody` that wasn't a `SuggestionCreated`.
    /// The apply pipeline is suggestion-specific; routing belongs to the
    /// caller.
    #[error("event is not a suggestion")]
    NotSuggestion,
    /// `apply_ready_verdict` was called with a non-`Ready` verdict. Applying a
    /// `RequiresThreeWay` / `Ambiguous` / `Stale` verdict without first
    /// resolving it is a caller bug — the orchestrator never silently
    /// converts those into writes.
    #[error("verdict is not Ready and cannot be applied directly: {kind}")]
    NotApplicable { kind: &'static str },
    /// The verdict's target byte range falls outside the supplied current
    /// markdown bytes, or lands inside a multi-byte UTF-8 codepoint. The
    /// resolver guarantees codepoint-aligned ranges, so this is defensive —
    /// surfaces a programmer error rather than producing mangled UTF-8.
    #[error("target byte range {start}..{end} is not a valid UTF-8 boundary in {len}-byte content")]
    BadByteRange {
        start: usize,
        end: usize,
        len: usize,
    },
    /// Disk-side drift: the document on disk hashed to something different
    /// than the bytes the caller resolved the verdict against. The
    /// `WorkingCopyService` stale-hash guard refused to write, and the file
    /// is left untouched. Caller should re-resolve the suggestion against
    /// the fresh document.
    #[error("file changed underneath us: expected hash {expected:?} but disk is {actual:?}")]
    StaleHash {
        expected: ContentHash,
        actual: ContentHash,
    },
    /// Filesystem failure during the working-copy write or read.
    #[error("io: {0}")]
    Io(String),
    /// Revision journal append failed. The file was written but the journal
    /// could not record the transition — surfaces as a hard error because
    /// the apply flow's promise to issue 8.5 (SuggestionAccepted emit) is
    /// that the journal entry exists by the time the event is emitted.
    #[error("revision journal: {0}")]
    Journal(String),
    /// Catch-all for unexpected resolver errors (e.g. anchor was routed to
    /// the wrong file). Currently unused by the happy paths but exists so the
    /// signature stays forward-compatible.
    #[error("apply: {0}")]
    Other(String),
}

impl From<WorkingCopyError> for ApplyError {
    fn from(err: WorkingCopyError) -> Self {
        match err {
            WorkingCopyError::StaleHash { expected, actual } => {
                ApplyError::StaleHash { expected, actual }
            }
            WorkingCopyError::Io(e) => ApplyError::Io(e.to_string()),
        }
    }
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
    let suggestion_id_typed: EventId =
        serde_json::from_value(serde_json::Value::String(suggestion_id.clone()))
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
// Apply orchestrator
// ---------------------------------------------------------------------------

/// Dependencies the apply orchestrator needs to write a `Ready` verdict to
/// disk and record the resulting `LocalRevision`.
///
/// Held by `ReviewManager` (issue 8.5 onwards); for the apply pipeline itself
/// the struct is a plain bundle so the function signature stays trivially
/// callable from tests without a half-mocked manager.
pub struct ApplyContext {
    /// Shared working-copy service — the only path that may write the file.
    /// We never call `std::fs::write` directly from the apply flow.
    pub working_copy: Arc<WorkingCopyService>,
    /// Shared review store. We use it solely to append the resulting
    /// `LocalRevision` to the room's revision journal.
    pub store: Arc<ReviewStore>,
    /// Room the suggestion lives in. Recorded on the `SaveSource` and used to
    /// pick the per-room revisions directory in the store.
    pub room_id: RoomId,
    /// File the suggestion targets. Used to pick the per-file JSONL inside
    /// the room's revisions directory.
    pub file_id: FileId,
    /// On-disk path of the working copy. Passed straight to
    /// `WorkingCopyService::save`.
    pub path: PathBuf,
}

/// What the orchestrator produced when a `Ready` verdict was applied.
///
/// Returned to the caller (eventually `ReviewManager`) so it can emit a
/// `SuggestionAccepted` event carrying the resulting `ContentHash` (issue
/// 8.5).
#[derive(Debug, Clone)]
pub struct ApplyOutcome {
    /// The suggestion id from the verdict — re-exposed so callers don't have
    /// to plumb the original verdict through to the event emitter.
    pub suggestion_id: EventId,
    /// The revision recorded in the journal. Already persisted by the time
    /// this outcome returns.
    pub revision: LocalRevision,
    /// Hash of the working copy after the apply landed. Equal to
    /// `revision.next_hash` — duplicated for readability at the
    /// call site that wants "the hash the event should advertise".
    pub resulting_hash: ContentHash,
}

/// Apply a `Ready` verdict by:
/// 1. Splicing the verdict's `replacement` into `current_markdown_bytes` at
///    `target_byte_range`,
/// 2. Saving the result through `ctx.working_copy` with
///    `SaveSource::AcceptedSuggestion`,
/// 3. Appending the returned `LocalRevision` to `ctx.store`.
///
/// Non-`Ready` verdicts return `ApplyError::NotApplicable` — the orchestrator
/// never silently rewrites three-way/ambiguous/stale verdicts into writes.
///
/// The `current_markdown_bytes` MUST be the bytes the caller fed to
/// `resolve_suggestion` (i.e. the bytes the verdict's `target_byte_range` is
/// indexed against). The stale-hash guard on `WorkingCopyService::save`
/// double-checks that this is still what is on disk; a mismatch surfaces as
/// `ApplyError::StaleHash` and the file is left untouched.
pub fn apply_ready_verdict(
    verdict: &ApplyVerdict,
    ctx: &ApplyContext,
    current_markdown_bytes: &[u8],
) -> Result<ApplyOutcome, ApplyError> {
    // (1) Only Ready verdicts are applicable. Convert the other variants to
    // an error tagged with a human-readable kind so the caller's logs say
    // *which* non-Ready verdict slipped through.
    let (suggestion_id, target_byte_range, replacement) = match verdict {
        ApplyVerdict::Ready {
            suggestion_id,
            target_byte_range,
            replacement,
            ..
        } => (
            suggestion_id.clone(),
            *target_byte_range,
            replacement.clone(),
        ),
        ApplyVerdict::RequiresThreeWay { .. } => {
            return Err(ApplyError::NotApplicable {
                kind: "RequiresThreeWay",
            });
        }
        ApplyVerdict::Ambiguous { .. } => {
            return Err(ApplyError::NotApplicable { kind: "Ambiguous" });
        }
        ApplyVerdict::Stale { .. } => {
            return Err(ApplyError::NotApplicable { kind: "Stale" });
        }
    };

    let (start, end) = target_byte_range;

    // (2) Defensive UTF-8-boundary check. The resolver guarantees codepoint
    // alignment on the byte range, but we are about to splice raw bytes into
    // a String — an off-by-one bug upstream would otherwise produce mangled
    // UTF-8 and a `from_utf8` panic deep inside the save path. Surface it
    // here with a precise error.
    let len = current_markdown_bytes.len();
    if start > end
        || end > len
        || !is_char_boundary(current_markdown_bytes, start)
        || !is_char_boundary(current_markdown_bytes, end)
    {
        return Err(ApplyError::BadByteRange { start, end, len });
    }

    // (3) Splice. Replace, Delete, InsertBefore, InsertAfter all collapse to
    // the same byte-level operation: `bytes[..start] + replacement +
    // bytes[end..]`. Delete passes replacement="" and a non-zero range;
    // insertions pass replacement=<text> and a zero-length range. No
    // operation-specific branches needed.
    let mut new_bytes: Vec<u8> = Vec::with_capacity(len + replacement.len());
    new_bytes.extend_from_slice(&current_markdown_bytes[..start]);
    new_bytes.extend_from_slice(replacement.as_bytes());
    new_bytes.extend_from_slice(&current_markdown_bytes[end..]);
    // The splice operates on UTF-8 boundaries (checked above) of UTF-8
    // inputs, so the result is guaranteed valid UTF-8 by construction.
    // `from_utf8` is still cheap (a scan) and gives us a defensive panic-
    // free path if upstream invariants ever loosen.
    let new_content = String::from_utf8(new_bytes)
        .map_err(|e| ApplyError::Other(format!("spliced bytes are not UTF-8: {e}")))?;

    // (4) Pin the stale-hash guard to the bytes the caller resolved against.
    // If anything has changed on disk since `current_markdown_bytes` was
    // read, `WorkingCopyService::save` refuses to write and we surface a
    // typed StaleHash error.
    let expected_hash = content_hash_canonical(current_markdown_bytes);

    let req = SaveRequest {
        path: ctx.path.clone(),
        content: new_content,
        expected_hash: Some(expected_hash),
        source: SaveSource::AcceptedSuggestion {
            room_id: ctx.room_id.clone(),
            suggestion_id: suggestion_id.clone(),
        },
    };
    let save_result = ctx.working_copy.save(req)?;

    // (5) Persist the revision. The WorkingCopyService returns it un-
    // persisted by design (a non-collab save would skip this step); the
    // apply orchestrator always journals so issue 8.5's event emitter can
    // rely on the entry existing.
    ctx.store
        .append_revision(&ctx.room_id, &ctx.file_id, &save_result.revision)
        .map_err(|e| ApplyError::Journal(e.to_string()))?;

    Ok(ApplyOutcome {
        suggestion_id,
        revision: save_result.revision,
        resulting_hash: save_result.next_hash,
    })
}

/// Canonical hash matches what `WorkingCopyService::save` computes for the
/// previous-bytes guard: LF-normalize before hashing so the apply flow's
/// expected_hash agrees with the service's view of the file. We re-derive
/// rather than expose `working_copy::hash_canonical` so the apply module
/// stays decoupled from working_copy's internal helpers.
fn content_hash_canonical(bytes: &[u8]) -> ContentHash {
    // Fast path: pure-LF input is hashed unchanged.
    if !bytes.contains(&b'\r') {
        return content_hash(bytes);
    }
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            i += 1;
            continue;
        }
        normalized.push(bytes[i]);
        i += 1;
    }
    content_hash(&normalized)
}

/// `str::is_char_boundary` lifted onto a byte slice without paying for a
/// `from_utf8` validation pass over the whole document. Returns `true` for
/// positions that fall on a UTF-8 codepoint boundary (including 0 and len).
///
/// Implementation note: a byte is a codepoint boundary iff it is NOT a UTF-8
/// continuation byte (top two bits != `10`). End-of-slice is trivially a
/// boundary. We accept the loose definition (bytes that are not continuation
/// bytes) because invalid UTF-8 cannot reach this function — the canonical
/// markdown bytes the apply pipeline receives are guaranteed UTF-8 upstream
/// by the snapshot/anchor index pipeline.
fn is_char_boundary(bytes: &[u8], pos: usize) -> bool {
    if pos == bytes.len() {
        return true;
    }
    if pos > bytes.len() {
        return false;
    }
    // Continuation byte iff (b & 0xC0) == 0x80.
    bytes[pos] & 0xC0 != 0x80
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
                let la_t = la.trim_end_matches([' ', '\t']);
                let lb_t = lb.trim_end_matches([' ', '\t']);
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
    fn suggestion_event(
        suggestion_id: &str,
        anchor: Anchor,
        op: SuggestionOperation,
    ) -> ReviewEventBody {
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
        let verdict =
            resolve_suggestion(&event_id("evt-1"), &body, &idx, md, &h, None).expect("verdict");
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
        let verdict =
            resolve_suggestion(&event_id("evt-2"), &body, &idx, md, &h, None).expect("verdict");
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
        let verdict =
            resolve_suggestion(&event_id("evt-6"), &body, &idx, md, &h, None).expect("verdict");
        match verdict {
            ApplyVerdict::Ambiguous { candidates, .. } => {
                assert!(
                    candidates.len() >= 3,
                    "expected >=3 candidates, got {}",
                    candidates.len()
                );
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
            ApplyVerdict::Stale {
                reason,
                suggestion_id,
            } => {
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
        let op = SuggestionOperation::InsertBefore {
            text: "very ".into(),
        };
        let body = suggestion_event("sug-8", anchor, op);
        let verdict =
            resolve_suggestion(&event_id("evt-8"), &body, &idx, md, &h, None).expect("verdict");
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
        let op = SuggestionOperation::InsertAfter {
            text: " (auburn)".into(),
        };
        let body = suggestion_event("sug-9", anchor, op);
        let verdict =
            resolve_suggestion(&event_id("evt-9"), &body, &idx, md, &h, None).expect("verdict");
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
        let verdict =
            resolve_suggestion(&event_id("evt-10"), &body, &idx, md, &h, None).expect("verdict");
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
        let verdict =
            resolve_suggestion(&event_id("evt-11"), &body, &idx, md, &h, None).expect("verdict");
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
            "café",         // NFC
            "cafe\u{0301}", // NFD
            "🚀 ship",
        ] {
            assert_eq!(
                classify_text_match(s, s),
                TextMatchKind::Exact,
                "self: {s:?}"
            );
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
        let verdict =
            resolve_suggestion(&event_id("evt-nfd"), &body, &idx, md, &h, None).expect("verdict");
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
        let verdict =
            resolve_suggestion(&event_id("evt-trail"), &body, &idx, md, &h, None).expect("verdict");
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
        let verdict =
            resolve_suggestion(&event_id("evt-crlf"), &body, &idx, md, &h, None).expect("verdict");
        assert!(
            matches!(verdict, ApplyVerdict::RequiresThreeWay { .. }),
            "expected RequiresThreeWay (CRLF mismatch), got {verdict:?}",
        );
    }

    // ====== apply_ready_verdict (attn-nnj.8.4) =============================
    //
    // The orchestrator wires three subsystems together: byte splicing,
    // WorkingCopyService::save (stale-hash guarded), and ReviewStore::
    // append_revision. These tests pin down each link of the chain plus the
    // UTF-8-boundary safety net so a future refactor that drops one of them
    // is caught loudly.

    use crate::review::ids::RoomId;
    use crate::review::store::ReviewStore;
    use crate::review::working_copy::WorkingCopyService;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn room_id(s: &str) -> RoomId {
        serde_json::from_value(Value::String(s.to_string())).expect("room id")
    }

    /// Build an `ApplyContext` rooted in a fresh tempdir. Returns the
    /// context plus the tempdir guard (so callers can keep it alive for the
    /// duration of the test) and the working-copy `path` so the test can
    /// seed the file or read it back after the apply.
    fn make_ctx(initial_bytes: &[u8]) -> (ApplyContext, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let path = tmp.path().join("doc.md");
        std::fs::write(&path, initial_bytes).expect("seed");
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("open store");
        let ctx = ApplyContext {
            working_copy: Arc::new(WorkingCopyService::new()),
            store: Arc::new(store),
            room_id: room_id("room-apply"),
            file_id: file_id("f1"),
            path,
        };
        (ctx, tmp)
    }

    /// Construct a `Ready` verdict directly without going through the
    /// resolver. Lets each apply test pick its own splice target precisely
    /// instead of fighting the resolver's quote-matching heuristics.
    fn ready_verdict(suggestion: &str, range: (usize, usize), replacement: &str) -> ApplyVerdict {
        ApplyVerdict::Ready {
            suggestion_id: event_id(suggestion),
            target_byte_range: range,
            replacement: replacement.to_string(),
            confidence: 1.0,
            match_kind: TextMatchKind::Exact,
            confidence_note: None,
        }
    }

    /// Replace path: a `Ready` verdict that swaps "brown" → "auburn" lands
    /// on disk and produces a `LocalRevision` in the room/file journal whose
    /// next_hash matches what the working-copy service computed.
    #[test]
    fn apply_ready_replace_writes_file_and_journals_revision() {
        let initial = b"the quick brown fox\n";
        let (ctx, _tmp) = make_ctx(initial);
        // "brown" sits at bytes 10..15.
        let verdict = ready_verdict("sug-r1", (10, 15), "auburn");

        let outcome = apply_ready_verdict(&verdict, &ctx, initial).expect("apply succeeds");

        // (a) Disk reflects the splice.
        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(on_disk, b"the quick auburn fox\n");

        // (b) Outcome's resulting_hash matches the canonical hash of the
        //     new bytes (LF-only here, so no normalization difference).
        assert_eq!(outcome.resulting_hash, content_hash(&on_disk));
        assert_eq!(outcome.resulting_hash, outcome.revision.next_hash);

        // (c) Suggestion id round-trips into the outcome.
        assert_eq!(outcome.suggestion_id, event_id("sug-r1"));

        // (d) Revision journal has exactly one entry, equal to the
        //     outcome's revision.
        let revs: Vec<_> = ctx
            .store
            .iter_revisions(&ctx.room_id, &ctx.file_id)
            .expect("iter")
            .collect::<Result<Vec<_>, _>>()
            .expect("revs");
        assert_eq!(revs.len(), 1, "expected one journaled revision");
        assert_eq!(revs[0].revision_id, outcome.revision.revision_id);
        assert_eq!(
            revs[0].source,
            crate::review::model::RevisionSource::AcceptedSuggestion,
            "journaled source must reflect the apply path",
        );
    }

    /// Delete path: a `Ready` verdict with replacement="" shrinks the file
    /// by the byte-range width and removes exactly those bytes.
    #[test]
    fn apply_ready_delete_removes_bytes() {
        let initial = b"the quick brown fox\n";
        let (ctx, _tmp) = make_ctx(initial);
        // Delete "brown " (bytes 10..16) — note the trailing space so the
        // result reads cleanly: "the quick fox\n".
        let verdict = ready_verdict("sug-del", (10, 16), "");

        let outcome = apply_ready_verdict(&verdict, &ctx, initial).expect("apply succeeds");

        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(on_disk, b"the quick fox\n");
        assert_eq!(on_disk.len(), initial.len() - 6);
        assert_eq!(outcome.resulting_hash, content_hash(&on_disk));
    }

    /// InsertBefore path: a `Ready` verdict with a zero-length range and
    /// non-empty replacement splices text at exactly position N.
    #[test]
    fn apply_ready_insert_before_splices_at_byte_index() {
        let initial = b"the quick brown fox\n";
        let (ctx, _tmp) = make_ctx(initial);
        // Insert "very " immediately before "brown" (byte 10).
        let verdict = ready_verdict("sug-ib", (10, 10), "very ");

        apply_ready_verdict(&verdict, &ctx, initial).expect("apply succeeds");

        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(on_disk, b"the quick very brown fox\n");
    }

    /// InsertAfter path: zero-length range at the END of "brown" splices
    /// text at byte 15.
    #[test]
    fn apply_ready_insert_after_splices_at_end_of_range() {
        let initial = b"the quick brown fox\n";
        let (ctx, _tmp) = make_ctx(initial);
        // Insert " (auburn)" immediately after "brown" (byte 15).
        let verdict = ready_verdict("sug-ia", (15, 15), " (auburn)");

        apply_ready_verdict(&verdict, &ctx, initial).expect("apply succeeds");

        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(on_disk, b"the quick brown (auburn) fox\n");
    }

    /// Stale-write guard: when the bytes on disk differ from the
    /// `current_markdown_bytes` the verdict was resolved against, the
    /// WorkingCopyService's stale-hash check fires and we surface a typed
    /// `ApplyError::StaleHash`. File is left untouched.
    #[test]
    fn apply_ready_stale_write_returns_stale_hash() {
        // Disk has one document, but we resolve the verdict against
        // *different* bytes — simulating "owner accepted a suggestion based
        // on a stale snapshot of the doc".
        let on_disk_initial = b"the QUICK brown fox\n";
        let resolved_against = b"the quick brown fox\n";
        let (ctx, _tmp) = make_ctx(on_disk_initial);
        let verdict = ready_verdict("sug-stale", (10, 15), "auburn");

        let err = apply_ready_verdict(&verdict, &ctx, resolved_against)
            .expect_err("stale apply must fail");

        match err {
            ApplyError::StaleHash { expected, actual } => {
                // `expected` is what the caller pinned (hash of
                // `resolved_against`), `actual` is what the file currently
                // hashes to.
                assert_eq!(expected, content_hash(resolved_against));
                assert_eq!(actual, content_hash(on_disk_initial));
            }
            other => panic!("expected StaleHash, got {other:?}"),
        }

        // File untouched.
        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(on_disk, on_disk_initial);

        // Journal still empty — no revision was recorded.
        let revs: Vec<_> = ctx
            .store
            .iter_revisions(&ctx.room_id, &ctx.file_id)
            .expect("iter")
            .collect::<Result<Vec<_>, _>>()
            .expect("revs");
        assert!(revs.is_empty(), "no revision on stale-hash refusal");
    }

    /// Non-`Ready` verdict (Ambiguous) → `ApplyError::NotApplicable`. The
    /// orchestrator never silently rewrites a three-way / ambiguous / stale
    /// verdict into a write.
    #[test]
    fn apply_non_ready_verdict_returns_not_applicable() {
        let initial = b"the quick brown fox\n";
        let (ctx, _tmp) = make_ctx(initial);
        let verdict = ApplyVerdict::Ambiguous {
            suggestion_id: event_id("sug-amb"),
            candidates: vec![ResolvedAnchorCandidate {
                confidence: 0.5,
                current_range: PositionAnchor {
                    byte_range: [0, 3],
                    line_range: [1, 1],
                    pm_range: None,
                },
                reason: "ambiguous quote".into(),
                preview: "the".into(),
            }],
        };

        let err =
            apply_ready_verdict(&verdict, &ctx, initial).expect_err("non-Ready apply must fail");
        match err {
            ApplyError::NotApplicable { kind } => assert_eq!(kind, "Ambiguous"),
            other => panic!("expected NotApplicable, got {other:?}"),
        }

        // Also test RequiresThreeWay and Stale — each must surface a kind
        // string that identifies the rejected variant.
        let three_way = ApplyVerdict::RequiresThreeWay {
            suggestion_id: event_id("sug-3w"),
            target_byte_range: (10, 15),
            snapshot_expected: "brown".into(),
            current_text: "BROWN".into(),
            proposed_replacement: "auburn".into(),
            confidence: 0.9,
        };
        match apply_ready_verdict(&three_way, &ctx, initial).expect_err("3w") {
            ApplyError::NotApplicable { kind } => assert_eq!(kind, "RequiresThreeWay"),
            other => panic!("expected NotApplicable(RequiresThreeWay), got {other:?}"),
        }
        let stale = ApplyVerdict::Stale {
            suggestion_id: event_id("sug-stale"),
            reason: "anchor lost".into(),
        };
        match apply_ready_verdict(&stale, &ctx, initial).expect_err("stale") {
            ApplyError::NotApplicable { kind } => assert_eq!(kind, "Stale"),
            other => panic!("expected NotApplicable(Stale), got {other:?}"),
        }

        // File untouched throughout.
        assert_eq!(std::fs::read(&ctx.path).expect("read disk"), initial);
    }

    /// Multi-byte UTF-8: a paragraph containing emoji has byte ranges that
    /// straddle multi-byte codepoints. The splice MUST treat byte ranges
    /// literally (the resolver promises codepoint-aligned boundaries) and
    /// produce valid UTF-8 with the emoji intact on either side.
    #[test]
    fn apply_ready_replace_inside_paragraph_with_emoji_is_byte_accurate() {
        // "ship 🚀 fast" — 🚀 (U+1F680) is 4 bytes (F0 9F 9A 80).
        // Layout:                 s h i p _ 🚀(4) _ f a s t
        // Byte indices:           0 1 2 3 4 5..9   9 10 11 12 13
        // We replace "fast" (bytes 10..14) with "now". The rocket emoji
        // sits before the splice; its bytes must be preserved unchanged.
        let initial = "ship 🚀 fast".as_bytes();
        let (ctx, _tmp) = make_ctx(initial);
        // Find "fast" by scanning — keeps the test resilient if the emoji
        // encoding helper changes.
        let fast_start = initial
            .windows(4)
            .position(|w| w == b"fast")
            .expect("fast in initial");
        let fast_end = fast_start + 4;
        let verdict = ready_verdict("sug-emoji", (fast_start, fast_end), "now");

        apply_ready_verdict(&verdict, &ctx, initial).expect("apply succeeds");

        let on_disk_bytes = std::fs::read(&ctx.path).expect("read");
        // Round-trip via String to confirm valid UTF-8 — would panic on
        // mangled bytes (e.g. if we'd sliced through the emoji).
        let on_disk = String::from_utf8(on_disk_bytes).expect("valid UTF-8");
        assert_eq!(on_disk, "ship 🚀 now");
    }

    /// Defensive: a verdict whose `target_byte_range` lands inside a
    /// multi-byte codepoint surfaces as `ApplyError::BadByteRange`. The
    /// resolver guarantees alignment, but the orchestrator's safety net
    /// must catch upstream bugs before producing mangled UTF-8.
    #[test]
    fn apply_ready_misaligned_utf8_range_returns_bad_byte_range() {
        // 🚀 occupies bytes 0..4. A range starting at byte 1 is INSIDE the
        // emoji's continuation bytes.
        let initial = "🚀ok".as_bytes();
        let (ctx, _tmp) = make_ctx(initial);
        let verdict = ready_verdict("sug-bad", (1, 4), "x");
        let err =
            apply_ready_verdict(&verdict, &ctx, initial).expect_err("misaligned range must fail");
        match err {
            ApplyError::BadByteRange { start, end, .. } => {
                assert_eq!(start, 1);
                assert_eq!(end, 4);
            }
            other => panic!("expected BadByteRange, got {other:?}"),
        }
        // File untouched on rejection.
        assert_eq!(std::fs::read(&ctx.path).expect("read"), initial);
    }

    /// Defensive: a verdict whose `target_byte_range` extends past the end
    /// of `current_markdown_bytes` surfaces as `ApplyError::BadByteRange`.
    /// Same rationale as the misaligned-UTF-8 test — catch upstream bugs
    /// before they corrupt the file.
    #[test]
    fn apply_ready_out_of_bounds_range_returns_bad_byte_range() {
        let initial = b"short\n";
        let (ctx, _tmp) = make_ctx(initial);
        // Range past the end (start within bounds, end > len).
        let verdict = ready_verdict("sug-oob", (3, 100), "x");
        let err = apply_ready_verdict(&verdict, &ctx, initial)
            .expect_err("out-of-bounds range must fail");
        assert!(
            matches!(
                err,
                ApplyError::BadByteRange {
                    start: 3,
                    end: 100,
                    len: 6
                }
            ),
            "got {err:?}",
        );
    }

    /// Through-the-resolver smoke: drive `resolve_suggestion` to produce a
    /// `Ready` verdict and then immediately apply it via the orchestrator.
    /// Locks down the two halves of attn-nnj.8 (8.1 resolver + 8.4 apply)
    /// composing without per-test glue.
    #[test]
    fn resolve_then_apply_replace_full_pipeline() {
        let initial = b"the quick brown fox\n";
        let (ctx, _tmp) = make_ctx(initial);
        let snap = "s-pipe";
        let idx = build_anchor_index(initial, &snap_id(snap)).expect("idx");
        let h = content_hash(initial);
        let anchor = quote_anchor(initial, "brown", snap);
        let op = SuggestionOperation::Replace {
            expected_text: "brown".into(),
            replacement: "tawny".into(),
        };
        let body = suggestion_event("sug-pipe", anchor, op);
        let verdict = resolve_suggestion(&event_id("evt-pipe"), &body, &idx, initial, &h, None)
            .expect("verdict");
        assert!(matches!(verdict, ApplyVerdict::Ready { .. }));

        let outcome = apply_ready_verdict(&verdict, &ctx, initial).expect("apply succeeds");

        assert_eq!(
            std::fs::read(&ctx.path).expect("read"),
            b"the quick tawny fox\n"
        );
        // The pipeline-produced revision id must match the journaled one.
        let revs: Vec<_> = ctx
            .store
            .iter_revisions(&ctx.room_id, &ctx.file_id)
            .expect("iter")
            .collect::<Result<Vec<_>, _>>()
            .expect("revs");
        assert_eq!(revs.len(), 1);
        assert_eq!(revs[0].revision_id, outcome.revision.revision_id);
    }

    // ====== END-TO-END APPLY INTEGRATION (attn-nnj.8.6) ====================
    //
    // These tests exercise the full owner-side accept/reject pipeline as a
    // single composed flow:
    //
    //   (1) seed a snapshot + the owner's evolved working copy
    //   (2) author a SuggestionCreated event against the snapshot
    //   (3) resolve_suggestion against the *current* (drifted) markdown — the
    //       anchor must REMAP, not exact-match
    //   (4) apply_ready_verdict writes the file via WorkingCopyService and
    //       journals a LocalRevision with source=AcceptedSuggestion
    //   (5) construct a SuggestionAccepted (or SuggestionRejected) review
    //       event and assemble it into an outbox MailboxEnvelope
    //   (6) store.append_outbox + store.iter_outbox round-trips the envelope
    //   (7) assert: file content matches expected; revision journal has the
    //       UserEdit + AcceptedSuggestion entries; outbox has the accept
    //       envelope; resulting_hash carried by the event matches the disk
    //       hash byte-for-byte.
    //
    // 8.5 (the ReviewManager wiring that owns the AcceptSuggestion command)
    // is still a stub at the time this test lands. The pipeline pieces all
    // exist as standalone helpers (apply orchestrator, store, envelope
    // assembler, working-copy service) — these tests glue them together the
    // same way 8.5 will, so 8.5 will inherit the contract without needing to
    // rediscover it. When 8.5 lands, the wiring inside `accept_suggestion_e2e`
    // can be replaced by a single `ReviewManager::submit(AcceptSuggestion)`
    // call and the assertions stay byte-identical.

    use crate::review::crypto::kdf::derive_room_keys;
    use crate::review::crypto::signing::DeviceSigningKey;
    use crate::review::envelope::{AssembleInput, assemble_event_envelope};
    use crate::review::ids::{DeviceId, ParticipantId};
    use crate::review::model::{EnvelopeKind, RevisionSource, SuggestionDraft};

    // ----- E2E fixtures ------------------------------------------------------

    /// Snapshot-time markdown. Two paragraphs; the second one contains the
    /// "old text" the suggestion is going to rewrite. Authored once and
    /// frozen — the owner's evolved copy below is derived from this by
    /// inserting an extra paragraph above, which forces the anchor resolver
    /// to *remap* (not exact-match) because the byte offsets shift.
    const E2E_SNAPSHOT_MD: &str = "\
# Title

intro paragraph

second paragraph with old text inside
";

    /// Owner's working copy after a UserEdit since the snapshot was taken:
    /// they added an `extra paragraph` above the target. The "old text"
    /// substring is still present, but its byte offset has shifted, so the
    /// anchor resolver must locate it via the quote step (which yields a
    /// Remapped, not Exact, verdict at high confidence).
    const E2E_CURRENT_MD: &str = "\
# Title

intro paragraph

extra paragraph added by owner

second paragraph with old text inside
";

    /// What the suggestion would write — replaces "old text" with
    /// "new text".
    const E2E_REPLACEMENT: &str = "new text";
    const E2E_EXPECTED_TEXT: &str = "old text";

    /// Expected on-disk markdown AFTER the apply lands.
    const E2E_FINAL_MD: &str = "\
# Title

intro paragraph

extra paragraph added by owner

second paragraph with new text inside
";

    /// Pinned room secret + signing seed for reproducibility. Distinct
    /// from envelope.rs's `TEST_ROOM_SECRET` / `TEST_SIGNING_SEED` so a
    /// cross-import never silently masks a regression in those tests.
    const E2E_ROOM_SECRET: [u8; 32] = [0x88u8; 32];
    const E2E_SIGNING_SEED: [u8; 32] = [0x99u8; 32];

    /// Build the SuggestionCreated event body that the reviewer would
    /// originally have authored against the snapshot. The anchor points at
    /// "old text" inside the snapshot bytes — at the snapshot offset, NOT
    /// the current offset, so resolve_suggestion has to remap.
    fn e2e_suggestion_body(suggestion_id: &str) -> ReviewEventBody {
        let snap_bytes = E2E_SNAPSHOT_MD.as_bytes();
        // Locate "old text" in the snapshot bytes — snapshot-time offsets.
        let needle = E2E_EXPECTED_TEXT.as_bytes();
        let pos = snap_bytes
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("snapshot contains the suggestion needle");
        let anchor = Anchor {
            v: 2,
            file_id: file_id("f-e2e"),
            snapshot_id: snap_id("snap-e2e"),
            // base_hash is the snapshot's hash, NOT the current hash —
            // this is the trigger that makes the resolver bypass its fast
            // exact-match path and fall through to quote/structure matching
            // (which produces a Remapped verdict).
            base_hash: content_hash(snap_bytes),
            position: PositionAnchor {
                byte_range: [pos as u64, (pos + needle.len()) as u64],
                line_range: [5, 5],
                pm_range: None,
            },
            quote: Some(quote(E2E_EXPECTED_TEXT)),
            block: None,
            context: None,
            structure: None,
        };
        ReviewEventBody::SuggestionCreated {
            suggestion_id: suggestion_id.to_string(),
            anchor,
            operation: SuggestionOperation::Replace {
                expected_text: E2E_EXPECTED_TEXT.to_string(),
                replacement: E2E_REPLACEMENT.to_string(),
            },
            note: Some("typo fix".to_string()),
        }
    }

    /// Build an `AssembleInput` for the owner-side SuggestionAccepted /
    /// SuggestionRejected emit step. Pinned room + signer so envelope ids
    /// and ciphertext are deterministic enough for assertions; the AEAD
    /// nonce itself is still fresh-random (we never override it — that path
    /// is reserved for the test-vector regenerator).
    fn e2e_emit_input(body: ReviewEventBody, created_at_ms: u64) -> AssembleInput {
        let keys = derive_room_keys(&E2E_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&E2E_SIGNING_SEED).expect("signing key");
        AssembleInput {
            event_key,
            signing_key: sk,
            room_id: room_id("room-e2e"),
            author_id: serde_json::from_value::<ParticipantId>(Value::String(
                "owner-1".to_string(),
            ))
            .expect("participant id"),
            device_id: serde_json::from_value::<DeviceId>(Value::String(
                "owner-device-1".to_string(),
            ))
            .expect("device id"),
            created_at_ms,
            expires_at_ms: created_at_ms + 7 * 24 * 60 * 60 * 1000,
            parent_event_ids: vec![],
            snapshot_id: Some(snap_id("snap-e2e")),
            body,
            kind: EnvelopeKind::Event,
            client_nonce: None,
        }
    }

    /// Seed an `ApplyContext` whose working copy holds the OWNER's current
    /// markdown (E2E_CURRENT_MD), AND record the corresponding UserEdit
    /// revision in the journal — mirroring what would have happened when the
    /// owner saved their edit before the suggestion arrived.
    fn seed_e2e_ctx() -> (ApplyContext, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let path = tmp.path().join("doc.md");
        // Start from the snapshot bytes on disk so the first save mirrors a
        // real owner edit (snapshot -> evolved-current).
        std::fs::write(&path, E2E_SNAPSHOT_MD).expect("seed snapshot bytes");

        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());

        // Record the UserEdit: snapshot → current. This is what the owner's
        // editor would have produced before the suggestion arrived.
        let user_edit_req = SaveRequest {
            path: path.clone(),
            content: E2E_CURRENT_MD.to_string(),
            expected_hash: Some(content_hash(E2E_SNAPSHOT_MD.as_bytes())),
            source: SaveSource::UserEdit,
        };
        let user_save = working_copy
            .save(user_edit_req)
            .expect("user edit must save");
        store
            .append_revision(&room_id("room-e2e"), &file_id("f-e2e"), &user_save.revision)
            .expect("journal user edit");

        let ctx = ApplyContext {
            working_copy,
            store,
            room_id: room_id("room-e2e"),
            file_id: file_id("f-e2e"),
            path,
        };
        (ctx, tmp)
    }

    /// (1) Happy path: snapshot + UserEdit drift → suggestion REMAPS →
    /// Ready verdict → apply writes file → outbox carries SuggestionAccepted
    /// envelope whose `resulting_hash` matches the disk hash.
    #[test]
    fn e2e_accept_suggestion_remap_writes_file_and_emits_accept_envelope() {
        let (ctx, _tmp) = seed_e2e_ctx();

        // (2) Reviewer's suggestion (authored against the snapshot).
        let suggestion_body = e2e_suggestion_body("sug-e2e-accept");

        // (3) Resolve against the current (drifted) markdown. Build the
        //     anchor index over the CURRENT bytes — the resolver inspects
        //     that to find the needle.
        let current_bytes = E2E_CURRENT_MD.as_bytes();
        let current_idx = crate::review::anchors::index::build_anchor_index(
            current_bytes,
            &snap_id("snap-current-e2e"),
        )
        .expect("anchor index over current bytes");
        let current_hash = content_hash(current_bytes);
        let verdict = resolve_suggestion(
            &event_id("evt-e2e-accept"),
            &suggestion_body,
            &current_idx,
            current_bytes,
            &current_hash,
            None,
        )
        .expect("resolver runs");

        // Lock down the remap path: must be Ready, must report a quote-style
        // remap (NOT an exact base_hash match), and the target range must
        // land on "old text" inside the CURRENT bytes — proving the anchor
        // moved through the resolver, not through the raw snapshot offset.
        match &verdict {
            ApplyVerdict::Ready {
                target_byte_range: (s, e),
                replacement,
                ..
            } => {
                assert_eq!(
                    &current_bytes[*s..*e],
                    E2E_EXPECTED_TEXT.as_bytes(),
                    "remapped target must land on the current `old text` bytes",
                );
                assert_eq!(replacement, E2E_REPLACEMENT, "replacement preserved");
                // Read-only checks done; let the orchestrator handle the rest.
            }
            other => panic!("expected Ready (remap), got {other:?}"),
        }

        // (4) Apply the verdict.
        let outcome = apply_ready_verdict(&verdict, &ctx, current_bytes).expect("apply succeeds");

        // (a) File on disk reflects the splice.
        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(
            std::str::from_utf8(&on_disk).expect("utf-8"),
            E2E_FINAL_MD,
            "disk content must match expected final markdown",
        );

        // (b) `resulting_hash` is the actual hash of the bytes on disk.
        assert_eq!(
            outcome.resulting_hash,
            content_hash(&on_disk),
            "outcome.resulting_hash must match the on-disk hash byte-for-byte",
        );

        // (c) Revision journal has BOTH entries:
        //       [0] UserEdit  (snapshot -> evolved-current)
        //       [1] AcceptedSuggestion (evolved-current -> final)
        //     in that exact order.
        let revs: Vec<_> = ctx
            .store
            .iter_revisions(&ctx.room_id, &ctx.file_id)
            .expect("iter revisions")
            .collect::<Result<Vec<_>, _>>()
            .expect("revs decode");
        assert_eq!(revs.len(), 2, "expected UserEdit + AcceptedSuggestion");
        assert_eq!(revs[0].source, RevisionSource::ProsemirrorEdit);
        assert_eq!(revs[1].source, RevisionSource::AcceptedSuggestion);
        // The accept revision must chain: its parent_hash equals the
        // user-edit's next_hash (i.e. the post-edit / pre-accept disk hash).
        assert_eq!(
            revs[1].parent_hash, revs[0].next_hash,
            "accept revision must chain off the user edit",
        );
        assert_eq!(
            revs[1].next_hash, outcome.resulting_hash,
            "journal next_hash must equal the outcome's resulting hash",
        );

        // (5) Build the SuggestionAccepted review event body and assemble
        //     the outbox envelope. This is what 8.5's emit_suggestion_accepted
        //     will produce.
        let accept_body = ReviewEventBody::SuggestionAccepted {
            suggestion_id: "sug-e2e-accept".to_string(),
            applied_revision_id: outcome.revision.revision_id.clone(),
            resulting_hash: outcome.resulting_hash.clone(),
        };
        let envelope = assemble_event_envelope(e2e_emit_input(accept_body, 1_700_000_010_000))
            .expect("envelope assembles");

        // (6) Outbox round-trip.
        assert!(
            ctx.store
                .append_outbox(&ctx.room_id, &envelope)
                .expect("append outbox"),
            "envelope should be newly written (not a dedup)",
        );
        let envelopes: Vec<_> = ctx
            .store
            .iter_outbox(&ctx.room_id)
            .expect("iter outbox")
            .collect::<Result<Vec<_>, _>>()
            .expect("envelopes decode");
        assert_eq!(
            envelopes.len(),
            1,
            "outbox holds exactly the accept envelope"
        );
        assert_eq!(envelopes[0].envelope_id, envelope.envelope_id);
        assert_eq!(envelopes[0].kind, EnvelopeKind::Event);
        assert_eq!(envelopes[0].room_id, ctx.room_id);
    }

    /// (2) RequiresThreeWay path: the owner edited the very bytes the
    /// suggestion targets, so resolve_suggestion produces a three-way
    /// verdict. The orchestrator MUST refuse to apply (NotApplicable) and
    /// the caller MUST emit a SuggestionRejected envelope instead — never
    /// a SuggestionAccepted. The on-disk file is untouched, and the
    /// revision journal still only carries the original UserEdit.
    #[test]
    fn e2e_requires_three_way_rejects_and_outbox_carries_reject() {
        // Seed exactly like the accept test, then mutate the working copy
        // so the targeted span no longer reads "old text" — that's what
        // forces the resolver to surface RequiresThreeWay.
        let (ctx, _tmp) = seed_e2e_ctx();
        // Owner concurrently changed "old text" → "stale text" — the quote
        // step still finds the *paragraph* via structure/context, but the
        // expected_text check fails and the verdict escalates to three-way.
        let drifted = E2E_CURRENT_MD.replace("old text", "stale text");
        let drifted_bytes = drifted.as_bytes();
        // Bump the disk state to match. Pin against the pre-drift hash so
        // the stale-hash guard agrees the caller knows what they're writing.
        let pre_drift_hash = content_hash(E2E_CURRENT_MD.as_bytes());
        ctx.working_copy
            .save(SaveRequest {
                path: ctx.path.clone(),
                content: drifted.clone(),
                expected_hash: Some(pre_drift_hash.clone()),
                source: SaveSource::UserEdit,
            })
            .expect("second user edit");
        // Journal that second edit so the journal mirrors the on-disk state
        // (otherwise the test's "journal still has only the original" check
        // is degenerate — by recording it we ensure the assertion below is
        // *specifically* "no AcceptedSuggestion entry was added".
        let second_rev = ctx
            .working_copy
            .build_external_change_revision(&ctx.path, pre_drift_hash)
            .expect("derive second revision");
        // Re-source it as a UserEdit so the journal stays semantically
        // accurate (it WAS a user edit, just simulated through a different
        // helper to avoid double-saving the bytes).
        let mut second_rev = second_rev;
        second_rev.source = RevisionSource::ProsemirrorEdit;
        ctx.store
            .append_revision(&ctx.room_id, &ctx.file_id, &second_rev)
            .expect("journal second edit");

        let suggestion_body = e2e_suggestion_body("sug-e2e-3way");
        let current_idx = crate::review::anchors::index::build_anchor_index(
            drifted_bytes,
            &snap_id("snap-current-e2e"),
        )
        .expect("anchor index over drifted bytes");
        let drifted_hash = content_hash(drifted_bytes);
        let verdict = resolve_suggestion(
            &event_id("evt-e2e-3way"),
            &suggestion_body,
            &current_idx,
            drifted_bytes,
            &drifted_hash,
            None,
        )
        .expect("resolver runs");

        // Must be RequiresThreeWay (NOT Ready). The owner UI would then
        // surface the three-way dialog; for this test, we simulate the user
        // clicking Reject.
        assert!(
            matches!(verdict, ApplyVerdict::RequiresThreeWay { .. }),
            "expected RequiresThreeWay verdict, got {verdict:?}",
        );

        // The orchestrator refuses to apply non-Ready verdicts.
        let err = apply_ready_verdict(&verdict, &ctx, drifted_bytes)
            .expect_err("apply must refuse a three-way verdict");
        assert!(
            matches!(err, ApplyError::NotApplicable { kind } if kind == "RequiresThreeWay"),
            "expected NotApplicable(RequiresThreeWay), got {err:?}",
        );

        // Disk untouched (still the drifted bytes the owner saved, NOT the
        // suggestion's would-be replacement).
        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(on_disk, drifted_bytes);

        // Journal has the two UserEdits (original + drift) — NO
        // AcceptedSuggestion entry, because we refused to apply.
        let revs: Vec<_> = ctx
            .store
            .iter_revisions(&ctx.room_id, &ctx.file_id)
            .expect("iter revisions")
            .collect::<Result<Vec<_>, _>>()
            .expect("revs decode");
        assert_eq!(revs.len(), 2, "journal must not gain an Accepted entry");
        for rev in &revs {
            assert_ne!(
                rev.source,
                RevisionSource::AcceptedSuggestion,
                "no accepted-suggestion entry must be journaled on three-way refusal",
            );
        }

        // Emit SuggestionRejected with the three-way reason and put it on
        // the outbox.
        let reject_body = ReviewEventBody::SuggestionRejected {
            suggestion_id: "sug-e2e-3way".to_string(),
            reason: Some("requires_three_way".to_string()),
        };
        let envelope = assemble_event_envelope(e2e_emit_input(reject_body, 1_700_000_020_000))
            .expect("reject envelope assembles");
        assert!(
            ctx.store
                .append_outbox(&ctx.room_id, &envelope)
                .expect("append outbox"),
            "reject envelope newly written",
        );
        let envelopes: Vec<_> = ctx
            .store
            .iter_outbox(&ctx.room_id)
            .expect("iter outbox")
            .collect::<Result<Vec<_>, _>>()
            .expect("envelopes decode");
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].envelope_id, envelope.envelope_id);
    }

    /// (3) Stale path: the document has changed so radically that the
    /// resolver returns Stale. We never reach apply; the caller emits a
    /// SuggestionRejected with reason="stale". File untouched, no
    /// AcceptedSuggestion in the journal, exactly one reject envelope on
    /// the outbox.
    #[test]
    fn e2e_stale_anchor_rejects_with_stale_reason() {
        let (ctx, _tmp) = seed_e2e_ctx();
        // Replace the entire working copy with an unrelated short doc so the
        // anchor can't be remapped — every resolver step misses and confidence
        // drops below STALE_FLOOR. This mirrors "owner rewrote the file" /
        // "wrong file open" / "snapshot is days old" scenarios.
        let unrelated = "# Wholly Unrelated Doc\n\nnothing to see here\n";
        let pre = content_hash(E2E_CURRENT_MD.as_bytes());
        ctx.working_copy
            .save(SaveRequest {
                path: ctx.path.clone(),
                content: unrelated.to_string(),
                expected_hash: Some(pre),
                source: SaveSource::UserEdit,
            })
            .expect("rewrite working copy");

        let suggestion_body = e2e_suggestion_body("sug-e2e-stale");
        // Build the suggestion with a position that's past-EOF in the unrelated
        // doc AND a line range >> the unrelated doc's line count, so the
        // line-proximity resolver step has to clamp heavily and falls below
        // STALE_FLOOR. We replace the anchor's position field here to force
        // the stale outcome — the original e2e_suggestion_body targets the
        // snapshot offset, which happens to be in-bounds for short docs by
        // coincidence.
        let mut suggestion_body = suggestion_body;
        if let ReviewEventBody::SuggestionCreated {
            ref mut anchor,
            ref mut operation,
            ..
        } = suggestion_body
        {
            anchor.position = PositionAnchor {
                byte_range: [9999, 10009],
                line_range: [900, 1000],
                pm_range: None,
            };
            anchor.quote = Some(quote("nonexistent token never appearing anywhere"));
            *operation = SuggestionOperation::Replace {
                expected_text: "nonexistent token never appearing anywhere".to_string(),
                replacement: "x".to_string(),
            };
        }

        let unrelated_bytes = unrelated.as_bytes();
        let current_idx = crate::review::anchors::index::build_anchor_index(
            unrelated_bytes,
            &snap_id("snap-stale-e2e"),
        )
        .expect("anchor index");
        let h = content_hash(unrelated_bytes);
        let verdict = resolve_suggestion(
            &event_id("evt-e2e-stale"),
            &suggestion_body,
            &current_idx,
            unrelated_bytes,
            &h,
            None,
        )
        .expect("resolver runs");
        assert!(
            matches!(verdict, ApplyVerdict::Stale { .. }),
            "expected Stale verdict, got {verdict:?}",
        );

        // Apply must refuse a Stale verdict.
        let err = apply_ready_verdict(&verdict, &ctx, unrelated_bytes)
            .expect_err("apply must refuse stale");
        assert!(
            matches!(err, ApplyError::NotApplicable { kind } if kind == "Stale"),
            "expected NotApplicable(Stale), got {err:?}",
        );

        // Disk still holds the unrelated rewrite (not the suggestion).
        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(on_disk, unrelated_bytes);

        // Emit reject with stale reason.
        let reject_body = ReviewEventBody::SuggestionRejected {
            suggestion_id: "sug-e2e-stale".to_string(),
            reason: Some("stale".to_string()),
        };
        let envelope = assemble_event_envelope(e2e_emit_input(reject_body, 1_700_000_030_000))
            .expect("envelope assembles");
        assert!(
            ctx.store
                .append_outbox(&ctx.room_id, &envelope)
                .expect("append outbox"),
            "reject envelope newly written",
        );

        let envelopes: Vec<_> = ctx
            .store
            .iter_outbox(&ctx.room_id)
            .expect("iter outbox")
            .collect::<Result<Vec<_>, _>>()
            .expect("envelopes decode");
        assert_eq!(envelopes.len(), 1);
        // No AcceptedSuggestion ever journaled — only the seed UserEdit and
        // the unrelated-rewrite UserEdit may exist.
        let revs: Vec<_> = ctx
            .store
            .iter_revisions(&ctx.room_id, &ctx.file_id)
            .expect("iter revisions")
            .collect::<Result<Vec<_>, _>>()
            .expect("revs decode");
        assert!(
            revs.iter()
                .all(|r| r.source != RevisionSource::AcceptedSuggestion),
            "stale rejection must NOT journal an AcceptedSuggestion",
        );
    }

    /// (4) Resulting-hash binding: round-trip an accept envelope through the
    /// outbox and verify the `resulting_hash` carried by the decrypted
    /// SuggestionAccepted body equals the actual hash of the file on disk.
    ///
    /// This is the contract Phase 6 sync depends on: a remote peer importing
    /// the SuggestionAccepted event must be able to advance its own replica
    /// to the exact bytes the owner committed, using only the hash on the
    /// event — there's no out-of-band channel.
    #[test]
    fn e2e_resulting_hash_in_accept_envelope_matches_disk_hash() {
        let (ctx, _tmp) = seed_e2e_ctx();
        let suggestion_body = e2e_suggestion_body("sug-e2e-hash");
        let current_bytes = E2E_CURRENT_MD.as_bytes();
        let current_idx = crate::review::anchors::index::build_anchor_index(
            current_bytes,
            &snap_id("snap-current-hash"),
        )
        .expect("idx");
        let h = content_hash(current_bytes);
        let verdict = resolve_suggestion(
            &event_id("evt-e2e-hash"),
            &suggestion_body,
            &current_idx,
            current_bytes,
            &h,
            None,
        )
        .expect("resolver");
        assert!(matches!(verdict, ApplyVerdict::Ready { .. }));
        let outcome = apply_ready_verdict(&verdict, &ctx, current_bytes).expect("apply");

        // Build + emit the accept envelope.
        let accept_body = ReviewEventBody::SuggestionAccepted {
            suggestion_id: "sug-e2e-hash".to_string(),
            applied_revision_id: outcome.revision.revision_id.clone(),
            resulting_hash: outcome.resulting_hash.clone(),
        };
        let envelope = assemble_event_envelope(e2e_emit_input(accept_body, 1_700_000_040_000))
            .expect("envelope assembles");
        ctx.store
            .append_outbox(&ctx.room_id, &envelope)
            .expect("append");

        // Re-read the envelope from the outbox and decrypt it. The
        // `resulting_hash` it carries MUST equal the actual hash of the
        // file as it sits on disk RIGHT NOW.
        use crate::review::envelope::{DisassembleInput, disassemble_event_envelope};
        use std::collections::HashMap;
        let envelopes: Vec<_> = ctx
            .store
            .iter_outbox(&ctx.room_id)
            .expect("iter")
            .collect::<Result<Vec<_>, _>>()
            .expect("decode");
        assert_eq!(envelopes.len(), 1);
        let env = &envelopes[0];

        let keys = derive_room_keys(&E2E_ROOM_SECRET);
        let event_key = *keys.event_key.as_bytes();
        let sk = DeviceSigningKey::from_bytes(&E2E_SIGNING_SEED).expect("sk");
        let vk = sk.verifying_key();
        let key_id = vk.signing_key_id_base64url();
        let mut vks = HashMap::new();
        vks.insert(key_id, vk);
        let recovered = disassemble_event_envelope(DisassembleInput {
            envelope: env,
            event_key,
            verifying_keys: &vks,
        })
        .expect("envelope opens cleanly");

        let resulting_hash = match recovered.body {
            ReviewEventBody::SuggestionAccepted {
                resulting_hash,
                applied_revision_id,
                suggestion_id,
            } => {
                assert_eq!(suggestion_id, "sug-e2e-hash");
                assert_eq!(applied_revision_id, outcome.revision.revision_id);
                resulting_hash
            }
            other => panic!("expected SuggestionAccepted body, got {other:?}"),
        };

        let on_disk = std::fs::read(&ctx.path).expect("read disk");
        assert_eq!(
            resulting_hash,
            content_hash(&on_disk),
            "envelope's resulting_hash must equal the on-disk content hash",
        );
        // And it must equal what the apply outcome reported — the entire
        // chain is one consistent identifier.
        assert_eq!(
            resulting_hash, outcome.resulting_hash,
            "envelope hash must match the apply outcome hash",
        );
    }

    /// (5) Bonus: a SuggestionDraft round-trips through the resolver +
    /// apply orchestrator without losing information. Locks down the
    /// contract between `ReviewCommand::CreateSuggestion { draft }` (which
    /// 3a will use to ingest frontend drafts) and the apply pipeline 8.x
    /// owns — they share the same Anchor + SuggestionOperation shapes.
    #[test]
    fn e2e_suggestion_draft_to_apply_round_trip() {
        let (ctx, _tmp) = seed_e2e_ctx();
        let suggestion_body = e2e_suggestion_body("sug-e2e-draft");
        // Project the suggestion body back into a draft (the shape the
        // frontend sends in). If the projection is lossy this assertion
        // would fail — proves the draft type is a strict subset of what
        // the wire body carries.
        let draft = match &suggestion_body {
            ReviewEventBody::SuggestionCreated {
                anchor,
                operation,
                note,
                ..
            } => SuggestionDraft {
                anchor: anchor.clone(),
                operation: operation.clone(),
                note: note.clone(),
            },
            _ => unreachable!("e2e_suggestion_body always returns SuggestionCreated"),
        };
        // Rebuild the wire body from the draft and assert byte equality of
        // the projection.
        let rebuilt_body = ReviewEventBody::SuggestionCreated {
            suggestion_id: "sug-e2e-draft".to_string(),
            anchor: draft.anchor,
            operation: draft.operation,
            note: draft.note,
        };
        assert_eq!(rebuilt_body, suggestion_body);

        // The rebuilt body must produce the same Ready verdict as the
        // original — proving the projection has no semantic effect.
        let current_bytes = E2E_CURRENT_MD.as_bytes();
        let current_idx = crate::review::anchors::index::build_anchor_index(
            current_bytes,
            &snap_id("snap-draft"),
        )
        .expect("idx");
        let h = content_hash(current_bytes);
        let verdict = resolve_suggestion(
            &event_id("evt-e2e-draft"),
            &rebuilt_body,
            &current_idx,
            current_bytes,
            &h,
            None,
        )
        .expect("resolver");
        assert!(matches!(verdict, ApplyVerdict::Ready { .. }));
        let outcome = apply_ready_verdict(&verdict, &ctx, current_bytes).expect("apply");
        assert_eq!(
            std::fs::read(&ctx.path).expect("read"),
            E2E_FINAL_MD.as_bytes(),
        );
        assert_eq!(
            outcome.resulting_hash,
            content_hash(E2E_FINAL_MD.as_bytes())
        );
    }
}
