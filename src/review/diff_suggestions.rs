//! Convert a one-file unified diff into independently reviewable suggestions.
//!
//! The diff is never applied here.  Every hunk is projected onto a persisted
//! plaintext snapshot and lowered to the existing v2 anchor/draft model.

use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::review::ids::RoomId;
use crate::review::model::{
    Anchor, AnchorBlock, BlockAnchor, ContextAnchor, DocType, PositionAnchor, QuoteAnchor,
    SnapshotNode, StructureAnchor, SuggestionDraft, SuggestionOperation,
};
use crate::review::store::ReviewStore;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnifiedDiff {
    pub old_path: String,
    pub new_path: String,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    pub ordinal: usize,
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<DiffLine>,
    /// The last old/new projection line was followed by the unified-diff
    /// `No newline at end of file` marker.
    pub old_no_newline: bool,
    pub new_no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffLine {
    Context(String),
    Remove(String),
    Add(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSuggestion {
    pub hunk: usize,
    pub room_id: RoomId,
    pub draft: SuggestionDraft,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkFailure {
    pub hunk: usize,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffSuggestionReport {
    pub suggestions: Vec<DiffSuggestion>,
    pub failures: Vec<HunkFailure>,
}

pub fn parse_unified_diff(input: &str) -> Result<UnifiedDiff> {
    if input
        .lines()
        .any(|line| line.starts_with("Binary files ") || line == "GIT binary patch")
    {
        bail!("binary diffs are not supported");
    }

    let lines: Vec<&str> = input.lines().collect();
    let mut cursor = 0;
    while cursor < lines.len() && !lines[cursor].starts_with("--- ") {
        cursor += 1;
    }
    if cursor == lines.len() || cursor + 1 >= lines.len() || !lines[cursor + 1].starts_with("+++ ")
    {
        bail!("malformed unified diff: expected --- and +++ file headers");
    }
    let old_path = parse_file_header(lines[cursor], "--- ")?;
    let new_path = parse_file_header(lines[cursor + 1], "+++ ")?;
    cursor += 2;

    let mut hunks = Vec::new();
    while cursor < lines.len() {
        let line = lines[cursor];
        if line.starts_with("--- ") {
            bail!("multi-file diffs are not supported");
        }
        if line.starts_with("diff --git ") && !hunks.is_empty() {
            bail!("multi-file diffs are not supported");
        }
        if !line.starts_with("@@ ") {
            if line.is_empty() || line.starts_with("index ") {
                cursor += 1;
                continue;
            }
            bail!(
                "malformed unified diff at line {}: expected hunk header",
                cursor + 1
            );
        }
        let (old_start, old_count, new_start, new_count) = parse_hunk_header(line)
            .with_context(|| format!("malformed hunk header at line {}", cursor + 1))?;
        cursor += 1;
        let mut hunk_lines = Vec::new();
        let mut seen_old = 0usize;
        let mut seen_new = 0usize;
        let mut old_no_newline = false;
        let mut new_no_newline = false;
        while cursor < lines.len() && !lines[cursor].starts_with("@@ ") {
            let body = lines[cursor];
            if body.starts_with("--- ") || body.starts_with("diff --git ") {
                break;
            }
            if body == "\\ No newline at end of file" {
                match hunk_lines.last() {
                    Some(DiffLine::Remove(_)) => old_no_newline = true,
                    Some(DiffLine::Add(_)) => new_no_newline = true,
                    Some(DiffLine::Context(_)) => {
                        old_no_newline = true;
                        new_no_newline = true;
                    }
                    None => bail!(
                        "malformed hunk {}: no-newline marker has no preceding line",
                        hunks.len() + 1
                    ),
                }
                cursor += 1;
                continue;
            }
            let (kind, text) = body.split_at_checked(1).ok_or_else(|| {
                anyhow!(
                    "malformed hunk {}: empty line lacks a unified-diff prefix",
                    hunks.len() + 1
                )
            })?;
            match kind {
                " " => {
                    hunk_lines.push(DiffLine::Context(text.to_string()));
                    seen_old += 1;
                    seen_new += 1;
                }
                "-" => {
                    hunk_lines.push(DiffLine::Remove(text.to_string()));
                    seen_old += 1;
                }
                "+" => {
                    hunk_lines.push(DiffLine::Add(text.to_string()));
                    seen_new += 1;
                }
                _ => bail!(
                    "malformed hunk {} at line {}: invalid prefix {kind:?}",
                    hunks.len() + 1,
                    cursor + 1
                ),
            }
            cursor += 1;
        }
        if seen_old != old_count || seen_new != new_count {
            bail!(
                "malformed hunk {}: header declares -{},{} +{},{} but body contains {seen_old} old and {seen_new} new lines",
                hunks.len() + 1,
                old_start,
                old_count,
                new_start,
                new_count
            );
        }
        if !hunk_lines
            .iter()
            .any(|line| !matches!(line, DiffLine::Context(_)))
        {
            bail!(
                "malformed hunk {}: hunk contains no change",
                hunks.len() + 1
            );
        }
        hunks.push(DiffHunk {
            ordinal: hunks.len() + 1,
            old_start,
            old_count,
            new_start,
            new_count,
            lines: hunk_lines,
            old_no_newline,
            new_no_newline,
        });
    }
    if hunks.is_empty() {
        bail!("unified diff contains no hunks");
    }
    Ok(UnifiedDiff {
        old_path,
        new_path,
        hunks,
    })
}

fn parse_file_header(line: &str, prefix: &str) -> Result<String> {
    let raw = line.strip_prefix(prefix).expect("caller checked prefix");
    let path = raw.split('\t').next().unwrap_or(raw).trim();
    if path.is_empty() {
        bail!("empty file path in unified diff header");
    }
    Ok(path.to_string())
}

fn parse_hunk_header(line: &str) -> Result<(usize, usize, usize, usize)> {
    let rest = line
        .strip_prefix("@@ -")
        .ok_or_else(|| anyhow!("expected @@ -"))?;
    let (old, rest) = rest
        .split_once(" +")
        .ok_or_else(|| anyhow!("missing + range"))?;
    let (new, tail) = rest
        .split_once(" @@")
        .ok_or_else(|| anyhow!("missing closing @@"))?;
    if !tail.is_empty() && !tail.starts_with(' ') {
        bail!("invalid text after closing @@");
    }
    let (old_start, old_count) = parse_range(old)?;
    let (new_start, new_count) = parse_range(new)?;
    Ok((old_start, old_count, new_start, new_count))
}

fn parse_range(raw: &str) -> Result<(usize, usize)> {
    let (start, count) = raw.split_once(',').unwrap_or((raw, "1"));
    Ok((
        start.parse().context("invalid range start")?,
        count.parse().context("invalid range count")?,
    ))
}

pub fn suggestions_from_diff(
    store: &ReviewStore,
    diff_text: &str,
    room_filter: Option<&str>,
) -> Result<DiffSuggestionReport> {
    let diff = parse_unified_diff(diff_text)?;
    let candidate = resolve_snapshot(store, &diff, room_filter)?;
    let mut report = DiffSuggestionReport::default();
    for hunk in &diff.hunks {
        match draft_hunk(&candidate.snapshot, hunk) {
            Ok(draft) => report.suggestions.push(DiffSuggestion {
                hunk: hunk.ordinal,
                room_id: candidate.room_id.clone(),
                draft,
            }),
            Err(err) => report.failures.push(HunkFailure {
                hunk: hunk.ordinal,
                message: format!("{err:#}"),
            }),
        }
    }
    Ok(report)
}

#[derive(Clone)]
struct SnapshotCandidate {
    room_id: RoomId,
    paths: Vec<String>,
    snapshot: SnapshotNode,
}

fn resolve_snapshot(
    store: &ReviewStore,
    diff: &UnifiedDiff,
    room_filter: Option<&str>,
) -> Result<SnapshotCandidate> {
    let wanted_room = room_filter.map(parse_room_id).transpose()?;
    let diff_path = if diff.new_path == "/dev/null" {
        &diff.old_path
    } else {
        &diff.new_path
    };
    let mut candidates = Vec::new();
    for room_id in store.list_rooms()? {
        if wanted_room
            .as_ref()
            .is_some_and(|wanted| wanted != &room_id)
        {
            continue;
        }
        let Some(room) = store.load_room(&room_id)? else {
            continue;
        };
        let bindings = store.load_bindings(&room_id)?;
        let mut persisted_file_ids = std::collections::BTreeSet::new();
        for document in room.documents.values() {
            let snapshot = store
                .load_snapshot(&room_id, &document.latest_snapshot_id)?
                .or_else(|| room.snapshots.get(&document.latest_snapshot_id).cloned());
            let Some(snapshot) = snapshot else { continue };
            let Some(plaintext) = snapshot.plaintext.as_ref() else {
                continue;
            };
            if plaintext.doc_type != DocType::Markdown || plaintext.anchor_index.is_none() {
                continue;
            }
            let mut paths = vec![document.owner_display_path.clone()];
            if let Some(binding) = bindings.get(&document.file_id) {
                paths.push(binding.absolute_path.clone());
            }
            candidates.push(SnapshotCandidate {
                room_id: room_id.clone(),
                paths,
                snapshot: {
                    persisted_file_ids.insert(snapshot.file_id.as_str().to_string());
                    snapshot
                },
            });
        }

        // Reviewer stores intentionally keep imported events + decrypted blob
        // payloads without rewriting the owner's room graph. Reconstruct the
        // latest snapshot per file from those durable artifacts so this CLI
        // works on the actual submitting side, not only in an owner store.
        let mut imported_by_file = std::collections::BTreeMap::<String, SnapshotCandidate>::new();
        for event in store.iter_events(&room_id)? {
            let event = event?;
            let crate::review::model::ReviewEventBody::SnapshotCreated {
                file_id,
                snapshot_id,
                owner_display_path,
                parent_snapshot_id,
                base_hash,
                encrypted_blob_ref,
                inline_snapshot,
            } = event.body
            else {
                continue;
            };
            // A room-graph document points at the authoritative latest local
            // snapshot. Do not also add any older imported event for that
            // same stable file identity.
            if persisted_file_ids.contains(file_id.as_str()) {
                continue;
            }
            let plaintext = match inline_snapshot {
                Some(plaintext) => plaintext,
                None => {
                    let Some(blob_ref) = encrypted_blob_ref.as_ref() else {
                        continue;
                    };
                    let Some(bytes) = store.load_snapshot_blob(&room_id, &blob_ref.blob_id)? else {
                        continue;
                    };
                    if bytes.len() as u64 != blob_ref.byte_length
                        || crate::review::crypto::ids::content_hash(&bytes) != blob_ref.content_hash
                    {
                        bail!(
                            "persisted snapshot blob {} for room {} failed signed BlobRef integrity validation",
                            blob_ref.blob_id,
                            id_string(&room_id)
                        );
                    }
                    serde_json::from_slice(&bytes).with_context(|| {
                        format!(
                            "decode persisted snapshot blob {} for room {}",
                            blob_ref.blob_id,
                            id_string(&room_id)
                        )
                    })?
                }
            };
            if plaintext.doc_type != DocType::Markdown || plaintext.anchor_index.is_none() {
                continue;
            }
            let byte_length = encrypted_blob_ref.as_ref().map_or_else(
                || serde_json::to_vec(&plaintext).map(|bytes| bytes.len() as u64),
                |blob_ref| Ok(blob_ref.byte_length),
            )?;
            let key = file_id.as_str().to_string();
            imported_by_file.insert(
                key,
                SnapshotCandidate {
                    room_id: room_id.clone(),
                    paths: owner_display_path.into_iter().collect(),
                    snapshot: SnapshotNode {
                        snapshot_id,
                        file_id,
                        parent_snapshot_id,
                        supersedes_snapshot_id: None,
                        created_at: event.meta.created_at,
                        created_by: event.meta.author_id,
                        base_hash,
                        byte_length,
                        encrypted_blob_ref,
                        plaintext: Some(plaintext),
                    },
                },
            );
        }
        candidates.extend(imported_by_file.into_values());
    }
    if candidates.is_empty() {
        if let Some(room) = room_filter {
            bail!(
                "room {room:?} has no persisted Markdown snapshot with plaintext and AnchorIndex"
            );
        }
        bail!("no persisted Markdown snapshot with plaintext and AnchorIndex was found");
    }
    let mut matching: Vec<_> = candidates
        .iter()
        .filter(|candidate| {
            candidate
                .paths
                .iter()
                .any(|path| path_matches_diff(path, diff_path))
        })
        .cloned()
        .collect();
    if matching.is_empty() && room_filter.is_some() {
        // `--room` exists specifically to disambiguate local persisted state;
        // a single document in that room is unambiguous even when the diff was
        // generated from a differently-rooted worktree.
        let room = wanted_room.expect("filter parsed");
        matching = candidates
            .into_iter()
            .filter(|candidate| candidate.room_id == room)
            .collect();
    }
    match matching.len() {
        1 => Ok(matching.remove(0)),
        0 => bail!(
            "diff path {diff_path:?} does not match any persisted shared Markdown file; pass --room ID to disambiguate"
        ),
        _ => {
            let descriptions = matching
                .iter()
                .map(|c| format!("{} ({})", c.paths.join(", "), id_string(&c.room_id)))
                .collect::<Vec<_>>()
                .join("; ");
            bail!(
                "diff path {diff_path:?} is ambiguous across persisted rooms: {descriptions}; pass --room ID"
            )
        }
    }
}

fn parse_room_id(raw: &str) -> Result<RoomId> {
    serde_json::from_value(serde_json::Value::String(raw.to_string())).context("invalid room id")
}

fn id_string<T: Serialize>(id: &T) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn path_matches_diff(persisted: &str, diff: &str) -> bool {
    fn clean(path: &str) -> &str {
        path.strip_prefix("a/")
            .or_else(|| path.strip_prefix("b/"))
            .unwrap_or(path)
    }
    let persisted = clean(persisted).replace('\\', "/");
    let diff = clean(diff).replace('\\', "/");
    persisted == diff
        || persisted.ends_with(&format!("/{diff}"))
        || diff.ends_with(&format!("/{persisted}"))
        || (Path::new(&persisted).file_name() == Path::new(&diff).file_name()
            && Path::new(&diff).components().count() == 1)
}

#[derive(Clone)]
struct SourceLines<'a> {
    text: &'a str,
    starts: Vec<usize>,
    bodies: Vec<&'a str>,
}

impl<'a> SourceLines<'a> {
    fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        if starts.last() == Some(&text.len()) {
            starts.pop();
        }
        let bodies = starts
            .iter()
            .map(|start| {
                let end = text[*start..].find('\n').map_or(text.len(), |n| *start + n);
                text[*start..end]
                    .strip_suffix('\r')
                    .unwrap_or(&text[*start..end])
            })
            .collect();
        Self {
            text,
            starts,
            bodies,
        }
    }

    fn byte_range(&self, start_line: usize, count: usize) -> Result<[usize; 2]> {
        if start_line > self.bodies.len() || start_line + count > self.bodies.len() {
            bail!(
                "line range {}..{} is outside the {}-line snapshot",
                start_line + 1,
                start_line + count,
                self.bodies.len()
            );
        }
        let start = self
            .starts
            .get(start_line)
            .copied()
            .unwrap_or(self.text.len());
        let end = self
            .starts
            .get(start_line + count)
            .copied()
            .unwrap_or(self.text.len());
        Ok([start, end])
    }
}

fn draft_hunk(snapshot: &SnapshotNode, hunk: &DiffHunk) -> Result<SuggestionDraft> {
    let plaintext = snapshot
        .plaintext
        .as_ref()
        .ok_or_else(|| anyhow!("snapshot plaintext is unavailable"))?;
    let index = plaintext
        .anchor_index
        .as_ref()
        .ok_or_else(|| anyhow!("snapshot AnchorIndex is unavailable"))?;
    let content = plaintext
        .content
        .as_deref()
        .ok_or_else(|| anyhow!("markdown snapshot content is unavailable"))?;
    let source = SourceLines::new(content);
    let old_projection: Vec<&str> = hunk
        .lines
        .iter()
        .filter_map(|line| match line {
            DiffLine::Context(s) | DiffLine::Remove(s) => Some(s.as_str()),
            DiffLine::Add(_) => None,
        })
        .collect();
    // In a zero-count old range, unified-diff coordinates identify the line
    // *before* the insertion: `-1,0` means insert after old line 1. For a
    // non-empty range they identify the first affected one-based line.
    let expected = if hunk.old_count == 0 {
        hunk.old_start
    } else {
        hunk.old_start.saturating_sub(1)
    };
    let located = if source.bodies.get(expected..expected + old_projection.len())
        == Some(old_projection.as_slice())
    {
        expected
    } else {
        let occurrences: Vec<_> = (0..=source.bodies.len().saturating_sub(old_projection.len()))
            .filter(|start| {
                source.bodies.get(*start..*start + old_projection.len())
                    == Some(old_projection.as_slice())
            })
            .collect();
        match occurrences.as_slice() {
            [only] => *only,
            [] => bail!("old/context projection does not anchor in the current persisted snapshot"),
            _ => bail!(
                "old/context projection occurs {} times in the current persisted snapshot",
                occurrences.len()
            ),
        }
    };

    let leading = hunk
        .lines
        .iter()
        .take_while(|line| matches!(line, DiffLine::Context(_)))
        .count();
    let trailing = hunk
        .lines
        .iter()
        .rev()
        .take_while(|line| matches!(line, DiffLine::Context(_)))
        .count();
    let changed = &hunk.lines[leading..hunk.lines.len() - trailing];
    let old_changed: Vec<&str> = changed
        .iter()
        .filter_map(|line| match line {
            DiffLine::Context(s) | DiffLine::Remove(s) => Some(s.as_str()),
            _ => None,
        })
        .collect();
    let new_changed: Vec<&str> = changed
        .iter()
        .filter_map(|line| match line {
            DiffLine::Context(s) | DiffLine::Add(s) => Some(s.as_str()),
            _ => None,
        })
        .collect();
    let leading_old = hunk.lines[..leading]
        .iter()
        .filter(|line| !matches!(line, DiffLine::Add(_)))
        .count();
    let changed_line = located + leading_old;
    let old_range = source.byte_range(changed_line, old_changed.len())?;

    let (anchor_range, operation) = if old_changed.is_empty() {
        let insertion = added_text(
            &new_changed,
            &source,
            changed_line,
            true,
            hunk.new_no_newline,
        );
        if changed_line < source.bodies.len() {
            let range = source.byte_range(changed_line, 1)?;
            (range, SuggestionOperation::InsertBefore { text: insertion })
        } else if !source.bodies.is_empty() {
            let range = source.byte_range(source.bodies.len() - 1, 1)?;
            let text = added_text(
                &new_changed,
                &source,
                changed_line,
                false,
                hunk.new_no_newline,
            );
            (range, SuggestionOperation::InsertAfter { text })
        } else {
            bail!(
                "cannot anchor an insertion into an empty snapshot because no AnchorBlock exists"
            );
        }
    } else {
        let expected_text = source.text[old_range[0]..old_range[1]].to_string();
        if new_changed.is_empty() {
            (old_range, SuggestionOperation::Delete { expected_text })
        } else {
            let mut replacement = new_changed.join("\n");
            if !hunk.new_no_newline && (expected_text.ends_with('\n') || hunk.old_no_newline) {
                replacement.push('\n');
            }
            (
                old_range,
                SuggestionOperation::Replace {
                    expected_text,
                    replacement,
                },
            )
        }
    };
    let anchor = build_anchor(snapshot, index, &source, anchor_range)?;
    Ok(SuggestionDraft {
        anchor,
        operation,
        note: Some(format!("from diff hunk {}", hunk.ordinal)),
    })
}

fn added_text(
    lines: &[&str],
    source: &SourceLines<'_>,
    line: usize,
    before: bool,
    no_trailing_newline: bool,
) -> String {
    let joined = lines.join("\n");
    if before {
        format!("{joined}\n")
    } else if source.text.ends_with('\n') {
        if no_trailing_newline {
            joined
        } else {
            format!("{joined}\n")
        }
    } else if line == source.bodies.len() {
        format!("\n{joined}")
    } else {
        joined
    }
}

fn build_anchor(
    snapshot: &SnapshotNode,
    index: &crate::review::model::AnchorIndex,
    source: &SourceLines<'_>,
    range: [usize; 2],
) -> Result<Anchor> {
    let exact = source
        .text
        .get(range[0]..range[1])
        .ok_or_else(|| anyhow!("anchor byte range is invalid UTF-8"))?
        .to_string();
    // A line-oriented diff commonly includes the trailing newline in a
    // replace/delete operation. Canonical Markdown AnchorBlocks intentionally
    // stop at the visible block text, so such a range is still a valid
    // position/quote/context anchor even though it is not block-contained.
    // Keep the block and structure layers only when their offset invariant is
    // actually satisfied; never shrink the operation range and thereby change
    // the diff's newline semantics merely to manufacture block metadata.
    let block = containing_block(&index.blocks, range);
    let normalized = normalize_text(&exact);
    let prefix = context_chars(&source.text[..range[0]], true);
    let suffix = context_chars(&source.text[range[1]..], false);
    Ok(Anchor {
        v: 2,
        file_id: snapshot.file_id.clone(),
        snapshot_id: snapshot.snapshot_id.clone(),
        base_hash: snapshot.base_hash.clone(),
        position: PositionAnchor {
            byte_range: [range[0] as u64, range[1] as u64],
            line_range: [
                line_at(&source.starts, range[0]) as u32 + 1,
                line_at(&source.starts, range[1].saturating_sub(1)) as u32 + 1,
            ],
            pm_range: block.and_then(|block| block.pm_range),
        },
        quote: Some(QuoteAnchor {
            exact: exact.clone(),
            exact_hash: hash_hex(exact.as_bytes()),
            normalized: normalized.clone(),
            normalized_hash: hash_hex(normalized.as_bytes()),
        }),
        block: block.map(|block| BlockAnchor {
            snapshot_block_id: block.snapshot_block_id.clone(),
            content_fingerprint: block.content_fingerprint.clone(),
            kind: block.kind,
            offset_in_block_bytes: [
                range[0].saturating_sub(block.byte_range[0] as usize) as u64,
                range[1].saturating_sub(block.byte_range[0] as usize) as u64,
            ],
            block_byte_range: block.byte_range,
            block_line_range: block.line_range,
        }),
        context: Some(ContextAnchor {
            prefix: prefix.clone(),
            suffix: suffix.clone(),
            prefix_hash: hash_hex(prefix.as_bytes()),
            suffix_hash: hash_hex(suffix.as_bytes()),
            previous_block_hash: block.and_then(|block| block.previous_block_hash.clone()),
            next_block_hash: block.and_then(|block| block.next_block_hash.clone()),
        }),
        structure: block.map(|block| StructureAnchor {
            heading_path: block.heading_path.clone(),
            ordinal_in_parent: block.ordinal_in_parent,
        }),
        // Diff-derived suggestions are markdown-only; HTML has no suggestion
        // authoring path (`html-annotation.md` §7).
        html: None,
    })
}

fn containing_block(blocks: &[AnchorBlock], range: [usize; 2]) -> Option<&AnchorBlock> {
    blocks
        .iter()
        .filter(|block| {
            let [start, end] = [block.byte_range[0] as usize, block.byte_range[1] as usize];
            start <= range[0] && range[0] < end && range[1] <= end
        })
        .min_by_key(|block| block.byte_range[1] - block.byte_range[0])
}

fn line_at(starts: &[usize], byte: usize) -> usize {
    starts
        .partition_point(|start| *start <= byte)
        .saturating_sub(1)
}

fn context_chars(text: &str, suffix_of_text: bool) -> String {
    if suffix_of_text {
        text.chars()
            .rev()
            .take(160)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        text.chars().take(160).collect()
    }
}

fn normalize_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut spaced = true;
    for ch in input.chars() {
        if ch.is_whitespace() || ch.is_ascii_punctuation() {
            if !spaced {
                out.push(' ');
                spaced = true;
            }
        } else {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
            spaced = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn hash_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::anchors::build_anchor_index;
    use crate::review::crypto::ids::content_hash;
    use crate::review::model::SnapshotPlaintext;

    fn id<T: for<'de> Deserialize<'de>>(raw: &str) -> T {
        serde_json::from_value(serde_json::Value::String(raw.to_string())).expect("typed id")
    }

    fn snapshot(markdown: &str) -> SnapshotNode {
        let snapshot_id: crate::review::ids::SnapshotId = id("snapshot-from-diff");
        SnapshotNode {
            snapshot_id: snapshot_id.clone(),
            file_id: id("file-from-diff"),
            parent_snapshot_id: None,
            supersedes_snapshot_id: None,
            created_at: 1,
            created_by: id("participant-from-diff"),
            base_hash: content_hash(markdown.as_bytes()),
            byte_length: markdown.len() as u64,
            encrypted_blob_ref: None,
            plaintext: Some(SnapshotPlaintext {
                doc_type: DocType::Markdown,
                content: Some(markdown.to_string()),
                anchor_index: Some(
                    build_anchor_index(markdown.as_bytes(), &snapshot_id).expect("anchor index"),
                ),
                media_type: None,
                encoding: None,
                manifest: None,
                annotation: None,
            }),
        }
    }

    #[test]
    fn draft_hunk_rejects_missing_markdown_content_clearly() {
        let parsed = parse_unified_diff("--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n-old\n+new\n")
            .expect("parse");
        let mut snapshot = snapshot("old\n");
        snapshot.plaintext.as_mut().expect("plaintext").content = None;
        let error = draft_hunk(&snapshot, &parsed.hunks[0]).expect_err("missing content");
        assert!(
            error
                .to_string()
                .contains("markdown snapshot content is unavailable")
        );
    }

    #[test]
    fn from_diff_parser_rejects_multifile_and_malformed() {
        let multi = "--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-a\n+b\n--- a/b.md\n+++ b/b.md\n@@ -1 +1 @@\n-x\n+y\n";
        assert!(
            parse_unified_diff(multi)
                .unwrap_err()
                .to_string()
                .contains("multi-file")
        );
        assert!(parse_unified_diff("--- a/x\n+++ b/x\n@@ nope\n").is_err());
        assert!(
            parse_unified_diff("Binary files a/x and b/x differ\n")
                .unwrap_err()
                .to_string()
                .contains("binary")
        );
    }

    #[test]
    fn from_diff_parser_reads_three_realistic_hunks() {
        let diff = "diff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n@@ -1,2 +1,2 @@\n # Title\n-old\n+new\n@@ -4 +4,0 @@\n-delete me\n@@ -6,0 +6 @@\n+insert me\n";
        let parsed = parse_unified_diff(diff).expect("parse");
        assert_eq!(parsed.hunks.len(), 3);
        assert_eq!(
            (parsed.hunks[0].old_start, parsed.hunks[0].old_count),
            (1, 2)
        );
    }

    #[test]
    fn from_diff_three_hunks_create_replace_delete_insert_and_exact_anchors() {
        let markdown = "# Title\n\nOld paragraph.\n\nDelete this paragraph.\n\nLast paragraph.\n";
        let diff = "--- a/doc.md\n+++ b/doc.md\n@@ -3 +3 @@\n-Old paragraph.\n+New paragraph.\n@@ -5 +5,0 @@\n-Delete this paragraph.\n@@ -6,0 +7 @@\n+Inserted paragraph.\n";
        let parsed = parse_unified_diff(diff).expect("parse");
        let snapshot = snapshot(markdown);
        let drafts = parsed
            .hunks
            .iter()
            .map(|hunk| draft_hunk(&snapshot, hunk).expect("draft"))
            .collect::<Vec<_>>();
        assert!(matches!(
            &drafts[0].operation,
            SuggestionOperation::Replace { expected_text, replacement }
                if expected_text == "Old paragraph.\n" && replacement == "New paragraph.\n"
        ));
        assert!(matches!(
            &drafts[1].operation,
            SuggestionOperation::Delete { expected_text }
                if expected_text == "Delete this paragraph.\n"
        ));
        assert!(matches!(
            &drafts[2].operation,
            SuggestionOperation::InsertBefore { text } if text == "Inserted paragraph.\n"
        ));
        assert_eq!(drafts[0].anchor.position.byte_range, [9, 24]);
        assert_eq!(drafts[0].anchor.position.line_range, [3, 3]);
        assert_eq!(
            drafts[0].anchor.quote.as_ref().unwrap().exact,
            "Old paragraph.\n"
        );
        assert_eq!(drafts[0].anchor.v, 2);
        assert_eq!(drafts[0].anchor.base_hash, snapshot.base_hash);
        // Full-line operations include their trailing newline, while Markdown
        // AnchorBlocks exclude separators. Position + quote + context remain
        // exact; block/structure are therefore correctly omitted here.
        assert!(drafts.iter().all(|draft| draft.anchor.block.is_none()));
        assert!(drafts.iter().all(|draft| draft.anchor.structure.is_none()));
        assert!(drafts.iter().all(|draft| {
            let context = draft.anchor.context.as_ref().unwrap();
            context.prefix.chars().count() <= 160 && context.suffix.chars().count() <= 160
        }));
    }

    #[test]
    fn from_diff_nonanchoring_hunk_does_not_prevent_valid_hunks() {
        let markdown = "First paragraph.\n\nSecond paragraph.\n";
        let diff = "--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n-First paragraph.\n+Changed first.\n@@ -3 +3 @@\n-Not in snapshot.\n+Changed missing.\n";
        let parsed = parse_unified_diff(diff).expect("parse");
        let snapshot = snapshot(markdown);
        let outcomes = parsed
            .hunks
            .iter()
            .map(|hunk| (hunk.ordinal, draft_hunk(&snapshot, hunk)))
            .collect::<Vec<_>>();
        assert!(outcomes[0].1.is_ok());
        assert!(
            outcomes[1]
                .1
                .as_ref()
                .unwrap_err()
                .to_string()
                .contains("does not anchor")
        );
    }

    #[test]
    fn from_diff_zero_context_insert_uses_line_before_coordinate() {
        let diff = "--- a/doc.md\n+++ b/doc.md\n@@ -1,0 +2 @@\n+Inserted.\n";
        let parsed = parse_unified_diff(diff).expect("parse");
        let draft = draft_hunk(&snapshot("One.\nTwo.\n"), &parsed.hunks[0]).expect("draft");
        assert!(matches!(
            draft.operation,
            SuggestionOperation::InsertBefore { text } if text == "Inserted.\n"
        ));
        assert_eq!(draft.anchor.quote.as_ref().unwrap().exact, "Two.\n");

        let eof_no_newline =
            "--- a/doc.md\n+++ b/doc.md\n@@ -1,0 +2 @@\n+Added.\n\\ No newline at end of file\n";
        let parsed = parse_unified_diff(eof_no_newline).expect("parse EOF insertion");
        let draft = draft_hunk(&snapshot("One.\n"), &parsed.hunks[0]).expect("draft");
        assert!(matches!(
            draft.operation,
            SuggestionOperation::InsertAfter { text } if text == "Added."
        ));
    }

    #[test]
    fn from_diff_preserves_eof_newline_only_changes() {
        let remove_newline =
            "--- a/doc.md\n+++ b/doc.md\n@@ -2 +2 @@\n-Two.\n+Two.\n\\ No newline at end of file\n";
        let parsed = parse_unified_diff(remove_newline).expect("parse remove newline");
        let draft = draft_hunk(&snapshot("One.\nTwo.\n"), &parsed.hunks[0]).expect("draft");
        assert!(matches!(
            draft.operation,
            SuggestionOperation::Replace { expected_text, replacement }
                if expected_text == "Two.\n" && replacement == "Two."
        ));

        let add_newline =
            "--- a/doc.md\n+++ b/doc.md\n@@ -2 +2 @@\n-Two.\n\\ No newline at end of file\n+Two.\n";
        let parsed = parse_unified_diff(add_newline).expect("parse add newline");
        let draft = draft_hunk(&snapshot("One.\nTwo."), &parsed.hunks[0]).expect("draft");
        assert!(matches!(
            draft.operation,
            SuggestionOperation::Replace { expected_text, replacement }
                if expected_text == "Two." && replacement == "Two.\n"
        ));
    }
}
