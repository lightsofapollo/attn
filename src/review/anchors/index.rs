//! Build an `AnchorIndex` from canonical UTF-8 markdown bytes using comrak.
//!
//! Spec: `planning/collab/data-model.md` §Anchor Index. The canonical bytes
//! the snapshot is hashed from MUST produce the canonical anchor index —
//! both go through this builder. The frontend never re-hashes; it consumes
//! the index from `SnapshotCreated` events.
//!
//! Math + mermaid kinds per `planning/collab/amendments.md` decision #16
//! (otherwise anchor fingerprints inside ProseMirror's math/mermaid
//! nodeviews fall through to `unknown` and break stability).

#![allow(dead_code)]

use comrak::nodes::{AstNode, ListType, NodeValue, Sourcepos};
use comrak::{Arena, Options, parse_document};
use sha2::{Digest, Sha256};

use crate::review::crypto::ids::content_hash;
use crate::review::ids::SnapshotId;
use crate::review::model::{
    AnchorBlock, AnchorBlockKind, AnchorHeading, AnchorHeadingRef, AnchorIndex, CanonicalEncoding,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum AnchorIndexError {
    /// The supplied byte slice was not valid UTF-8. comrak only accepts
    /// `&str`, so an invalid encoding can't even reach the parser.
    #[error("invalid UTF-8 in markdown bytes")]
    InvalidUtf8,
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/// Build an `AnchorIndex` from canonical UTF-8 markdown bytes.
///
/// `snapshot_id` is required because `snapshotBlockId` is per-snapshot:
/// `snapshotBlockId = sha256(snapshotId || byteRange || contentFingerprint)`.
pub fn build_anchor_index(
    markdown_bytes: &[u8],
    snapshot_id: &SnapshotId,
) -> Result<AnchorIndex, AnchorIndexError> {
    let markdown = std::str::from_utf8(markdown_bytes).map_err(|_| AnchorIndexError::InvalidUtf8)?;

    let doc_hash = content_hash(markdown_bytes);
    let line_count = count_lines(markdown_bytes);

    // Per-line byte starts in the ORIGINAL bytes. comrak normalises the input
    // (BOM stripping, line-ending coercion) but sourcepos reports positions in
    // its post-normalised view. For our purposes the canonical bytes are
    // assumed already clean (no BOM, LF line endings — see crypto-spec.md
    // §ContentHash), so the line index over the input bytes matches what
    // comrak sees.
    let line_starts = compute_line_starts(markdown_bytes);

    let arena = Arena::new();
    let options = build_options();
    let root = parse_document(&arena, markdown, &options);

    let snapshot_id_str = serde_id_to_string(snapshot_id);

    let mut walker = Walker::new(markdown_bytes, &line_starts, &snapshot_id_str);
    walker.walk(root);
    let (blocks, headings) = walker.finish();

    Ok(AnchorIndex {
        doc_hash,
        canonical_encoding: CanonicalEncoding::Utf8Bytes,
        line_count,
        blocks,
        headings,
    })
}

// ---------------------------------------------------------------------------
// Comrak setup
// ---------------------------------------------------------------------------

/// GFM extensions matched to the spec — the canonical bytes hashed for
/// `SnapshotNode.baseHash` must parse the same way wherever they are
/// re-indexed. `src/markdown.rs` does its own line-by-line task scan and
/// doesn't currently invoke comrak, so the configuration is local to this
/// module and mirrors the GFM defaults the spec assumes.
fn build_options<'c>() -> Options<'c> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    options.extension.multiline_block_quotes = true;
    options.extension.alerts = true;
    // Math + mermaid: math is a comrak extension; mermaid is detected via the
    // code-block `info` string in `classify_kind`.
    options.extension.math_dollars = true;
    options.extension.math_code = true;
    options
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

struct Walker<'a> {
    bytes: &'a [u8],
    line_starts: &'a [usize],
    snapshot_id: &'a str,
    /// Active heading stack — innermost (deepest level) last.
    heading_stack: Vec<AnchorHeadingRef>,
    /// Cumulative ordinals seen for each heading level (1-based level index).
    /// Used so `AnchorHeadingRef.ordinalAtLevel` is monotonic in document
    /// order across the whole document.
    heading_ordinals: [u32; 7],
    /// Blocks accumulated in document order.
    blocks: Vec<AnchorBlock>,
    /// Headings accumulated in document order.
    headings: Vec<AnchorHeading>,
    /// `(canonical_path_bytes, provisional_fingerprint) -> next
    /// duplicateOrdinal` so two identical paragraphs under the same heading
    /// section get 0 and 1. We key by the canonical path BYTES (a
    /// `Vec<u8>`) rather than `Vec<AnchorHeadingRef>` so the model's
    /// `AnchorHeadingRef` doesn't have to derive `Hash`.
    duplicate_counters: std::collections::HashMap<(Vec<u8>, String), u32>,
    /// `canonical_path_bytes -> next ordinalInParent` so blocks within the
    /// same heading-section get 0,1,2,... in document order.
    section_ordinals: std::collections::HashMap<Vec<u8>, u32>,
}

impl<'a> Walker<'a> {
    fn new(bytes: &'a [u8], line_starts: &'a [usize], snapshot_id: &'a str) -> Self {
        Self {
            bytes,
            line_starts,
            snapshot_id,
            heading_stack: Vec::new(),
            heading_ordinals: [0; 7],
            blocks: Vec::new(),
            headings: Vec::new(),
            duplicate_counters: std::collections::HashMap::new(),
            section_ordinals: std::collections::HashMap::new(),
        }
    }

    fn walk(&mut self, node: &'a AstNode<'a>) {
        for child in node.children() {
            self.visit_block(child);
        }
    }

    /// Visit one top-level block under the current container (document, list,
    /// blockquote, etc.). Recursion is selective: list-items, blockquote
    /// content, etc. become their own AnchorBlocks; we descend into lists to
    /// emit one block per item but do NOT descend into a paragraph to emit
    /// its inlines as separate blocks.
    fn visit_block(&mut self, node: &'a AstNode<'a>) {
        let value = node.data.borrow().value.clone();
        let sourcepos = node.data.borrow().sourcepos;
        match &value {
            // Heading: emit AnchorBlock + AnchorHeading, then push onto stack
            // so subsequent siblings get this heading in their path. A new
            // same-or-shallower heading pops down to that level first.
            NodeValue::Heading(h) => {
                let level = h.level as u32;
                self.pop_heading_stack_to(level);
                let text = extract_text(node);
                let text_hash = sha256_hex(text.as_bytes());

                // Bump the per-level ordinal counter BEFORE pushing — the
                // heading's own ref records its own ordinalAtLevel, which is
                // the count of preceding headings at this level plus one.
                let level_index = (level as usize).min(6);
                self.heading_ordinals[level_index] = self
                    .heading_ordinals[level_index]
                    .saturating_add(1);
                let ordinal_at_level = self.heading_ordinals[level_index] - 1;

                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);

                // AnchorBlock for the heading itself uses its path WITHOUT
                // including itself (a heading lives under its parents).
                self.emit_block(
                    AnchorBlockKind::Heading,
                    byte_range,
                    line_range,
                    &path,
                    &text,
                    &text_hash,
                );

                self.headings.push(AnchorHeading {
                    level,
                    text: text.clone(),
                    text_hash: text_hash.clone(),
                    line: line_range[0],
                    byte_range,
                    path: path.clone(),
                });

                self.heading_stack.push(AnchorHeadingRef {
                    level,
                    text_hash,
                    ordinal_at_level,
                });
            }

            NodeValue::Paragraph => {
                let text = extract_text(node);
                let text_hash = sha256_hex(text.as_bytes());
                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);
                self.emit_block(
                    AnchorBlockKind::Paragraph,
                    byte_range,
                    line_range,
                    &path,
                    &text,
                    &text_hash,
                );
            }

            // A List node owns Item children; the spec says one AnchorBlock
            // per list item. Walk the items directly.
            NodeValue::List(_) => {
                for item in node.children() {
                    self.visit_block(item);
                }
            }

            NodeValue::Item(_) | NodeValue::TaskItem(_) => {
                let text = extract_text(node);
                let text_hash = sha256_hex(text.as_bytes());
                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);
                self.emit_block(
                    AnchorBlockKind::ListItem,
                    byte_range,
                    line_range,
                    &path,
                    &text,
                    &text_hash,
                );
            }

            NodeValue::CodeBlock(cb) => {
                let kind = classify_code_block(&cb.info);
                let text = cb.literal.clone();
                let text_hash = sha256_hex(text.as_bytes());
                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);
                self.emit_block(kind, byte_range, line_range, &path, &text, &text_hash);
            }

            NodeValue::HtmlBlock(hb) => {
                let text = hb.literal.clone();
                let text_hash = sha256_hex(text.as_bytes());
                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);
                self.emit_block(
                    AnchorBlockKind::Html,
                    byte_range,
                    line_range,
                    &path,
                    &text,
                    &text_hash,
                );
            }

            NodeValue::BlockQuote
            | NodeValue::MultilineBlockQuote(_)
            | NodeValue::Alert(_) => {
                // A blockquote/alert is its own block AND a container. The
                // resolver treats the whole quote as the block; nested
                // structure is not separately addressable in v2. Recursing
                // into children here would emit duplicate blocks for the
                // inner paragraphs that already live inside the quote span.
                let text = extract_text(node);
                let text_hash = sha256_hex(text.as_bytes());
                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);
                self.emit_block(
                    AnchorBlockKind::Blockquote,
                    byte_range,
                    line_range,
                    &path,
                    &text,
                    &text_hash,
                );
            }

            NodeValue::Table(_) => {
                let text = extract_text(node);
                let text_hash = sha256_hex(text.as_bytes());
                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);
                self.emit_block(
                    AnchorBlockKind::Table,
                    byte_range,
                    line_range,
                    &path,
                    &text,
                    &text_hash,
                );
            }

            NodeValue::ThematicBreak => {
                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);
                // No textual content — use an empty string so the
                // fingerprint still composes deterministically. Two
                // thematic breaks under the same heading section will be
                // disambiguated by duplicateOrdinal.
                self.emit_block(
                    AnchorBlockKind::ThematicBreak,
                    byte_range,
                    line_range,
                    &path,
                    "",
                    &sha256_hex(b""),
                );
            }

            // Comrak may emit a Math node at the block level when the doc
            // opens with display-math. Inline math is encountered while
            // walking paragraph children and is absorbed into the parent
            // paragraph's text via `extract_text`.
            NodeValue::Math(_) => {
                let text = extract_text(node);
                let text_hash = sha256_hex(text.as_bytes());
                let path = self.heading_stack.clone();
                let byte_range = self.byte_range_of(sourcepos);
                let line_range = line_range_of(sourcepos);
                self.emit_block(
                    AnchorBlockKind::Math,
                    byte_range,
                    line_range,
                    &path,
                    &text,
                    &text_hash,
                );
            }

            // FrontMatter, FootnoteDefinition, DescriptionList, etc.
            // Fall through with kind=Unknown so the resolver still gets a
            // stable fingerprint for the span (per `amendments.md`
            // decision #16, `unknown` is the documented safety fallback).
            _ => {
                if is_block_value(&value) {
                    let text = extract_text(node);
                    let text_hash = sha256_hex(text.as_bytes());
                    let path = self.heading_stack.clone();
                    let byte_range = self.byte_range_of(sourcepos);
                    let line_range = line_range_of(sourcepos);
                    self.emit_block(
                        AnchorBlockKind::Unknown,
                        byte_range,
                        line_range,
                        &path,
                        &text,
                        &text_hash,
                    );
                }
                // Inlines reaching this method (shouldn't happen for a
                // well-formed AST) are silently ignored.
            }
        }
    }

    /// Drop heading-stack entries deeper than `level - 1`. A new heading at
    /// `level` lives under everything strictly above it; same-level headings
    /// are siblings, not children.
    fn pop_heading_stack_to(&mut self, level: u32) {
        while self
            .heading_stack
            .last()
            .is_some_and(|h| h.level >= level)
        {
            self.heading_stack.pop();
        }
    }

    fn byte_range_of(&self, sp: Sourcepos) -> [u64; 2] {
        let start = source_offset_to_byte(self.line_starts, self.bytes, sp.start.line, sp.start.column);
        let end_inclusive = source_offset_to_byte(self.line_starts, self.bytes, sp.end.line, sp.end.column);
        // Sourcepos's end is the LAST byte of the node (inclusive). The
        // AnchorBlock byteRange is a half-open [start, end_exclusive) pair —
        // bump by 1, clamped to the buffer length so we never overshoot.
        let end_exclusive = (end_inclusive.saturating_add(1)).min(self.bytes.len() as u64);
        [start, end_exclusive]
    }

    fn emit_block(
        &mut self,
        kind: AnchorBlockKind,
        byte_range: [u64; 2],
        line_range: [u32; 2],
        path: &[AnchorHeadingRef],
        text: &str,
        text_hash: &str,
    ) {
        let normalized = normalize_text(text);
        let normalized_text_hash = sha256_hex(normalized.as_bytes());
        let path_vec = path.to_vec();

        // contentFingerprint = sha256(kind || normalizedText || headingPath
        // || duplicateOrdinal). duplicateOrdinal participates in the
        // fingerprint, so two identical paragraphs under the same heading
        // section produce DIFFERENT fingerprints — exactly the property the
        // resolver depends on.
        let kind_str = kind_wire_name(kind);
        let path_bytes = canonical_path_bytes(&path_vec);
        let provisional_fp_input = compose_fingerprint_input(
            kind_str,
            &normalized,
            &path_bytes,
            // duplicateOrdinal not known yet — we look up using a fingerprint
            // computed with ordinal=0, then bump.
            0,
        );
        let provisional_fp = sha256_hex(&provisional_fp_input);

        let dup_key = (path_bytes.clone(), provisional_fp);
        let duplicate_ordinal = *self
            .duplicate_counters
            .entry(dup_key)
            .and_modify(|n| *n = n.saturating_add(1))
            .or_insert(0);

        let final_fp_input = compose_fingerprint_input(
            kind_str,
            &normalized,
            &path_bytes,
            duplicate_ordinal,
        );
        let content_fingerprint = sha256_hex(&final_fp_input);

        // snapshotBlockId = sha256(snapshotId || byteRange || contentFingerprint).
        let snapshot_block_id =
            compute_snapshot_block_id(self.snapshot_id, byte_range, &content_fingerprint);

        let ordinal_in_parent = *self
            .section_ordinals
            .entry(path_bytes)
            .and_modify(|n| *n = n.saturating_add(1))
            .or_insert(0);

        self.blocks.push(AnchorBlock {
            snapshot_block_id,
            content_fingerprint,
            kind,
            byte_range,
            line_range,
            pm_range: None,
            heading_path: path_vec,
            ordinal_in_parent,
            duplicate_ordinal,
            text_hash: text_hash.to_string(),
            normalized_text_hash,
            previous_block_hash: None, // filled in finish_blocks
            next_block_hash: None,     // filled in finish_blocks
        });
    }

    /// Stitch previous/next textHash pointers into the emitted blocks and
    /// return the (blocks, headings) pair. Doing this in a second pass
    /// keeps `emit_block` linear and avoids the chicken-and-egg of needing
    /// the next block's hash before we've seen it.
    fn finish(mut self) -> (Vec<AnchorBlock>, Vec<AnchorHeading>) {
        let hashes: Vec<String> = self.blocks.iter().map(|b| b.text_hash.clone()).collect();
        for (i, block) in self.blocks.iter_mut().enumerate() {
            if i > 0 {
                block.previous_block_hash = Some(hashes[i - 1].clone());
            }
            if i + 1 < hashes.len() {
                block.next_block_hash = Some(hashes[i + 1].clone());
            }
        }
        (self.blocks, self.headings)
    }
}

// ---------------------------------------------------------------------------
// Helpers — text extraction
// ---------------------------------------------------------------------------

/// Recursively extract textual content from a node. Inline-level nodes
/// concatenate their text; block-level nodes that contain inlines
/// (paragraphs, headings, table cells) flatten to the visible string.
///
/// Code spans, math spans, and HTML inlines contribute their literal text
/// because the resolver's normalized text should reflect what the reader
/// actually sees.
fn extract_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut out = String::new();
    collect_text(node, &mut out);
    out
}

fn collect_text<'a>(node: &'a AstNode<'a>, out: &mut String) {
    let value = node.data.borrow().value.clone();
    match value {
        NodeValue::Text(s) => out.push_str(&s),
        NodeValue::Code(c) => out.push_str(&c.literal),
        NodeValue::HtmlInline(s) => out.push_str(&s),
        NodeValue::Math(m) => out.push_str(&m.literal),
        NodeValue::CodeBlock(cb) => out.push_str(&cb.literal),
        NodeValue::HtmlBlock(hb) => out.push_str(&hb.literal),
        NodeValue::LineBreak | NodeValue::SoftBreak => out.push(' '),
        // Container inlines — recurse.
        _ => {
            for child in node.children() {
                collect_text(child, out);
            }
        }
    }
}

/// Normalisation rule used for both `normalizedTextHash` and the
/// `contentFingerprint` input:
///
/// 1. Lowercase (ASCII).
/// 2. Collapse runs of whitespace (any unicode whitespace) into one space.
/// 3. Strip ASCII punctuation.
/// 4. Trim leading/trailing whitespace.
///
/// This is a deliberately simple, deterministic rule: the resolver wants two
/// paragraphs that differ only in casing/whitespace/punctuation to share a
/// fingerprint. The full unicode normalization tree (NFKD + grapheme rules)
/// would be more accurate but is over-spec for v2.
fn normalize_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_was_space = true; // suppress leading whitespace
    for ch in input.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
            continue;
        }
        if ch.is_ascii_punctuation() {
            // Treat stripped punctuation like whitespace so "foo,bar" and
            // "foo bar" normalize the same way.
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
            continue;
        }
        for lower in ch.to_lowercase() {
            out.push(lower);
        }
        last_was_space = false;
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

// ---------------------------------------------------------------------------
// Helpers — kind classification
// ---------------------------------------------------------------------------

fn classify_code_block(info: &str) -> AnchorBlockKind {
    // GFM info strings are case-sensitive in the spec but conventionally
    // lower-case; we trim and lower to match the frontend's mermaid
    // nodeview detection (web/src/lib/prosemirror/mermaid/...).
    let lang = info.trim().split_whitespace().next().unwrap_or("");
    let lower = lang.to_ascii_lowercase();
    match lower.as_str() {
        "mermaid" => AnchorBlockKind::Mermaid,
        // `math` is detected here in addition to the comrak math extension
        // because some authoring tools write LaTeX in a ```math fence.
        "math" | "latex" | "tex" => AnchorBlockKind::Math,
        _ => AnchorBlockKind::CodeBlock,
    }
}

fn is_block_value(value: &NodeValue) -> bool {
    matches!(
        value,
        NodeValue::Document
            | NodeValue::FrontMatter(_)
            | NodeValue::BlockQuote
            | NodeValue::List(_)
            | NodeValue::Item(_)
            | NodeValue::DescriptionList
            | NodeValue::DescriptionItem(_)
            | NodeValue::DescriptionTerm
            | NodeValue::DescriptionDetails
            | NodeValue::CodeBlock(_)
            | NodeValue::HtmlBlock(_)
            | NodeValue::Paragraph
            | NodeValue::Heading(_)
            | NodeValue::ThematicBreak
            | NodeValue::FootnoteDefinition(_)
            | NodeValue::Table(_)
            | NodeValue::TableRow(_)
            | NodeValue::TableCell
            | NodeValue::TaskItem(_)
            | NodeValue::MultilineBlockQuote(_)
            | NodeValue::Alert(_)
            | NodeValue::Subtext
            | NodeValue::BlockDirective(_)
    )
}

#[allow(dead_code)]
fn list_type_name(t: ListType) -> &'static str {
    match t {
        ListType::Bullet => "bullet",
        ListType::Ordered => "ordered",
    }
}

// ---------------------------------------------------------------------------
// Helpers — fingerprint composition
// ---------------------------------------------------------------------------

fn kind_wire_name(k: AnchorBlockKind) -> &'static str {
    match k {
        AnchorBlockKind::Heading => "heading",
        AnchorBlockKind::Paragraph => "paragraph",
        AnchorBlockKind::ListItem => "list_item",
        AnchorBlockKind::CodeBlock => "code_block",
        AnchorBlockKind::Blockquote => "blockquote",
        AnchorBlockKind::Table => "table",
        AnchorBlockKind::ThematicBreak => "thematic_break",
        AnchorBlockKind::Html => "html",
        AnchorBlockKind::Math => "math",
        AnchorBlockKind::Mermaid => "mermaid",
        AnchorBlockKind::Unknown => "unknown",
    }
}

/// Encode the headingPath as a stable byte string for hashing. Each ref
/// contributes `level:textHash:ordinalAtLevel`; refs are joined with `/`.
fn canonical_path_bytes(path: &[AnchorHeadingRef]) -> Vec<u8> {
    let mut out = Vec::with_capacity(path.len() * 64);
    for (i, r) in path.iter().enumerate() {
        if i > 0 {
            out.push(b'/');
        }
        out.extend_from_slice(r.level.to_string().as_bytes());
        out.push(b':');
        out.extend_from_slice(r.text_hash.as_bytes());
        out.push(b':');
        out.extend_from_slice(r.ordinal_at_level.to_string().as_bytes());
    }
    out
}

/// Build the byte input for `contentFingerprint` exactly per
/// `data-model.md`: `sha256(kind || normalizedText || headingPath
/// || duplicateOrdinal)`. The `||` is byte-concatenation with a unit
/// separator so distinct field combinations can't alias.
fn compose_fingerprint_input(
    kind: &str,
    normalized_text: &str,
    heading_path_bytes: &[u8],
    duplicate_ordinal: u32,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(
        kind.len() + normalized_text.len() + heading_path_bytes.len() + 16,
    );
    buf.extend_from_slice(kind.as_bytes());
    buf.push(0x1f); // unit separator
    buf.extend_from_slice(normalized_text.as_bytes());
    buf.push(0x1f);
    buf.extend_from_slice(heading_path_bytes);
    buf.push(0x1f);
    buf.extend_from_slice(duplicate_ordinal.to_string().as_bytes());
    buf
}

fn compute_snapshot_block_id(
    snapshot_id: &str,
    byte_range: [u64; 2],
    content_fingerprint: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(snapshot_id.as_bytes());
    hasher.update([0x1f]);
    hasher.update(byte_range[0].to_string().as_bytes());
    hasher.update(b":");
    hasher.update(byte_range[1].to_string().as_bytes());
    hasher.update([0x1f]);
    hasher.update(content_fingerprint.as_bytes());
    hex(&hasher.finalize())
}

// ---------------------------------------------------------------------------
// Helpers — byte/line math
// ---------------------------------------------------------------------------

fn count_lines(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }
    let nl = bytes.iter().filter(|b| **b == b'\n').count();
    // Empty trailing line after a final \n still counts visually as one row
    // in editors, but the spec's `lineCount` is "newlines + 1" if the file
    // does NOT end in a newline, and exactly "newlines" if it does. We
    // pick "newlines + 1" only when the last byte is not \n, matching how
    // ProseMirror counts lines for cursor positions.
    if bytes.last() == Some(&b'\n') {
        nl as u32
    } else {
        nl as u32 + 1
    }
}

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

/// Convert a 1-based comrak (line, column) into a byte offset within the
/// canonical bytes. Columns are byte-counted (not char-counted) per the
/// comrak default. Past-EOF positions clamp to `bytes.len()`.
fn source_offset_to_byte(
    line_starts: &[usize],
    bytes: &[u8],
    line: usize,
    column: usize,
) -> u64 {
    if line == 0 {
        // Sourcepos of (0,0,0,0) — comrak sometimes emits this for synthetic
        // nodes. Treat as start of buffer.
        return 0;
    }
    let line_idx = line.saturating_sub(1);
    let line_start = line_starts
        .get(line_idx)
        .copied()
        .unwrap_or(bytes.len());
    let col_offset = column.saturating_sub(1);
    let offset = line_start.saturating_add(col_offset);
    offset.min(bytes.len()) as u64
}

fn line_range_of(sp: Sourcepos) -> [u32; 2] {
    [
        u32::try_from(sp.start.line).unwrap_or(u32::MAX),
        u32::try_from(sp.end.line).unwrap_or(u32::MAX),
    ]
}

// ---------------------------------------------------------------------------
// Helpers — id and hashing
// ---------------------------------------------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(hex_nibble(b >> 4));
        s.push(hex_nibble(b & 0x0f));
    }
    s
}

fn hex_nibble(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'a' + (n - 10)) as char,
        _ => unreachable!(),
    }
}

/// Extract the inner string of a typed ID newtype (RoomId, SnapshotId, ...)
/// without depending on private fields. The newtype's serde derive emits a
/// JSON string, so we round-trip through `serde_json::Value`.
fn serde_id_to_string<T: serde::Serialize>(id: &T) -> String {
    match serde_json::to_value(id).expect("typed id newtype serializes") {
        serde_json::Value::String(s) => s,
        _ => panic!("typed id newtype must serialize to a JSON string"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::ids::SnapshotId;
    use serde::Deserialize;
    use serde_json::Value;

    fn snap(label: &str) -> SnapshotId {
        serde_json::from_value::<SnapshotId>(Value::String(label.to_string()))
            .expect("SnapshotId deserializes from string")
    }

    fn build(markdown: &str, snap_label: &str) -> AnchorIndex {
        build_anchor_index(markdown.as_bytes(), &snap(snap_label))
            .expect("build_anchor_index succeeds on UTF-8 input")
    }

    // 1. Empty document → 0 blocks, 0 headings, docHash matches content_hash(b"")
    #[test]
    fn empty_document_has_no_blocks_or_headings() {
        let idx = build("", "snap-empty");
        assert!(idx.blocks.is_empty(), "no blocks, got {:?}", idx.blocks);
        assert!(idx.headings.is_empty(), "no headings");
        assert_eq!(idx.canonical_encoding, CanonicalEncoding::Utf8Bytes);
        assert_eq!(idx.line_count, 0);

        let expected = content_hash(b"");
        // ContentHash newtype — compare via serialization to avoid touching
        // private fields.
        let lhs = serde_json::to_value(&idx.doc_hash).unwrap();
        let rhs = serde_json::to_value(&expected).unwrap();
        assert_eq!(lhs, rhs, "docHash must equal content_hash(b\"\")");
    }

    // 2. Single paragraph → 1 block of kind Paragraph, byte_range covers the paragraph
    #[test]
    fn single_paragraph_emits_one_paragraph_block() {
        let md = "Hello world.\n";
        let idx = build(md, "snap-1");
        assert_eq!(idx.blocks.len(), 1, "expected 1 block, got {:?}", idx.blocks);
        let b = &idx.blocks[0];
        assert_eq!(b.kind, AnchorBlockKind::Paragraph);
        let span = &md.as_bytes()[b.byte_range[0] as usize..b.byte_range[1] as usize];
        // The span should contain the paragraph text.
        assert!(
            std::str::from_utf8(span).unwrap().contains("Hello world."),
            "byte range should cover the paragraph; got {:?}",
            std::str::from_utf8(span)
        );
    }

    // 3. Two paragraphs → 2 blocks; first.previousBlockHash=None,
    //    nextBlockHash=Some(_); second mirrors.
    #[test]
    fn two_paragraphs_chain_prev_next_hashes() {
        let md = "First para.\n\nSecond para.\n";
        let idx = build(md, "snap-2");
        assert_eq!(idx.blocks.len(), 2);
        let a = &idx.blocks[0];
        let b = &idx.blocks[1];
        assert!(a.previous_block_hash.is_none());
        assert_eq!(
            a.next_block_hash.as_deref(),
            Some(b.text_hash.as_str()),
            "first.next should point at second.textHash"
        );
        assert_eq!(
            b.previous_block_hash.as_deref(),
            Some(a.text_hash.as_str()),
            "second.previous should point at first.textHash"
        );
        assert!(b.next_block_hash.is_none());
    }

    // 4. Heading + two paragraphs underneath → both paragraphs share the same headingPath
    #[test]
    fn paragraphs_under_heading_share_heading_path() {
        let md = "# Top\n\nAlpha para.\n\nBeta para.\n";
        let idx = build(md, "snap-3");
        assert_eq!(idx.headings.len(), 1);
        assert_eq!(idx.headings[0].text, "Top");
        // 1 heading block + 2 paragraph blocks
        assert_eq!(idx.blocks.len(), 3);
        let h = &idx.blocks[0];
        let p1 = &idx.blocks[1];
        let p2 = &idx.blocks[2];
        assert_eq!(h.kind, AnchorBlockKind::Heading);
        assert_eq!(p1.kind, AnchorBlockKind::Paragraph);
        assert_eq!(p2.kind, AnchorBlockKind::Paragraph);
        // Heading itself lives at root (no headingPath).
        assert!(h.heading_path.is_empty());
        // Both paragraphs share a single-element path pointing at the H1.
        assert_eq!(p1.heading_path.len(), 1);
        assert_eq!(p2.heading_path.len(), 1);
        assert_eq!(p1.heading_path, p2.heading_path);
        assert_eq!(p1.heading_path[0].level, 1);
        // ordinalInParent: 0 for heading section is empty path → heading
        // itself; 0 and 1 for the two paragraphs under the heading.
        assert_eq!(p1.ordinal_in_parent, 0);
        assert_eq!(p2.ordinal_in_parent, 1);
    }

    // 5. Nested headings (H2 inside H1) → child paragraph headingPath has length 2
    #[test]
    fn nested_headings_build_a_two_element_path() {
        let md = "# Top\n\n## Sub\n\nChild para.\n";
        let idx = build(md, "snap-4");
        assert_eq!(idx.headings.len(), 2);
        // Blocks: H1, H2, Paragraph
        assert_eq!(idx.blocks.len(), 3);
        let para = &idx.blocks[2];
        assert_eq!(para.kind, AnchorBlockKind::Paragraph);
        assert_eq!(para.heading_path.len(), 2, "child path = [H1, H2]");
        assert_eq!(para.heading_path[0].level, 1);
        assert_eq!(para.heading_path[1].level, 2);
        // The H2's own heading-block carries the H1 in its path (length 1).
        let h2 = &idx.blocks[1];
        assert_eq!(h2.heading_path.len(), 1);
        assert_eq!(h2.heading_path[0].level, 1);
    }

    // 6. List with 3 items → 3 AnchorBlocks of kind ListItem
    #[test]
    fn list_emits_one_block_per_item() {
        let md = "- one\n- two\n- three\n";
        let idx = build(md, "snap-5");
        assert_eq!(idx.blocks.len(), 3);
        for b in &idx.blocks {
            assert_eq!(b.kind, AnchorBlockKind::ListItem);
        }
    }

    // 7. Code block with info string `mermaid` → kind == Mermaid (decision #16)
    #[test]
    fn fenced_mermaid_block_is_classified_as_mermaid() {
        let md = "```mermaid\ngraph TD; A-->B;\n```\n";
        let idx = build(md, "snap-mermaid");
        assert_eq!(idx.blocks.len(), 1);
        assert_eq!(
            idx.blocks[0].kind,
            AnchorBlockKind::Mermaid,
            "mermaid fenced block must NOT fall through to code_block"
        );
    }

    // 8. Code block with info string `rust` → kind == CodeBlock
    #[test]
    fn fenced_rust_block_is_classified_as_code_block() {
        let md = "```rust\nfn main() {}\n```\n";
        let idx = build(md, "snap-rust");
        assert_eq!(idx.blocks.len(), 1);
        assert_eq!(idx.blocks[0].kind, AnchorBlockKind::CodeBlock);
    }

    // 9. Duplicate paragraphs → second has duplicateOrdinal=1, first has 0
    #[test]
    fn duplicate_paragraphs_get_distinct_duplicate_ordinals() {
        let md = "Same line here.\n\nSame line here.\n";
        let idx = build(md, "snap-dup");
        assert_eq!(idx.blocks.len(), 2);
        assert_eq!(idx.blocks[0].duplicate_ordinal, 0);
        assert_eq!(idx.blocks[1].duplicate_ordinal, 1);
        // And the fingerprints must differ — that's the whole point of
        // mixing duplicateOrdinal into the input.
        assert_ne!(
            idx.blocks[0].content_fingerprint,
            idx.blocks[1].content_fingerprint,
            "duplicate paragraphs must produce DIFFERENT contentFingerprints"
        );
    }

    // 10. Document with H1 + paragraph + H1 + paragraph → AnchorHeading list has 2 entries
    #[test]
    fn multiple_top_level_headings_appear_in_headings_list() {
        let md = "# Alpha\n\npara A.\n\n# Beta\n\npara B.\n";
        let idx = build(md, "snap-multi-h");
        assert_eq!(idx.headings.len(), 2);
        assert_eq!(idx.headings[0].text, "Alpha");
        assert_eq!(idx.headings[1].text, "Beta");
        // ordinalAtLevel within the second heading-block path should be
        // unique per H1 we've seen.
        let beta_para = idx
            .blocks
            .iter()
            .find(|b| b.kind == AnchorBlockKind::Paragraph
                && b.heading_path
                    .first()
                    .is_some_and(|r| r.ordinal_at_level == 1))
            .expect("para under Beta must reference the 2nd H1 (ordinal 1)");
        assert_eq!(beta_para.heading_path.len(), 1);
    }

    // 11. contentFingerprint stability across rebuilds.
    #[test]
    fn content_fingerprint_is_stable_across_builds() {
        let md = "# Heading\n\nThe quick brown fox.\n";
        let a = build(md, "snap-fp-a");
        let b = build(md, "snap-fp-b");
        // Paragraph is index 1 (heading is 0). Snapshot id should NOT
        // affect contentFingerprint — only normalizedText, kind, path,
        // duplicateOrdinal do.
        assert_eq!(
            a.blocks[1].content_fingerprint,
            b.blocks[1].content_fingerprint,
            "contentFingerprint must be snapshot-id-independent"
        );
    }

    // 12. snapshotBlockId differs across snapshot_ids for the same content.
    #[test]
    fn snapshot_block_id_changes_with_snapshot_id() {
        let md = "# H\n\nbody.\n";
        let a = build(md, "snap-id-1");
        let b = build(md, "snap-id-2");
        assert_eq!(a.blocks.len(), b.blocks.len());
        for (ba, bb) in a.blocks.iter().zip(b.blocks.iter()) {
            assert_ne!(
                ba.snapshot_block_id, bb.snapshot_block_id,
                "snapshotBlockId must change with snapshotId for the same content"
            );
            // But contentFingerprint MUST match — that's its point.
            assert_eq!(ba.content_fingerprint, bb.content_fingerprint);
        }
    }

    // ---- additional sanity coverage ------------------------------------

    #[test]
    fn dollar_display_math_is_absorbed_into_paragraph() {
        // Comrak emits NodeValue::Math as an INLINE inside a paragraph for
        // both `$x$` and `$$x$$`. That's a comrak design choice — block-level
        // math is not a separate AST node. The block kind in that case is
        // `paragraph`, and the math literal flows through `extract_text`
        // into the paragraph's normalized text so the resolver still has
        // something to fingerprint. (Authors who want math addressable as
        // its own block use the ```math fence — covered by the next test.)
        let md = "$$\nE = mc^2\n$$\n";
        let idx = build(md, "snap-math");
        assert_eq!(
            idx.blocks.len(),
            1,
            "comrak collapses dollar-display math into a paragraph; got {:?}",
            idx.blocks.iter().map(|b| b.kind).collect::<Vec<_>>()
        );
        assert_eq!(idx.blocks[0].kind, AnchorBlockKind::Paragraph);
    }

    #[test]
    fn fenced_math_info_string_is_classified_as_math() {
        let md = "```math\nE = mc^2\n```\n";
        let idx = build(md, "snap-math-fence");
        assert_eq!(idx.blocks.len(), 1);
        assert_eq!(idx.blocks[0].kind, AnchorBlockKind::Math);
    }

    // Per attn-nnj.3.2 acceptance: contentFingerprint for a ```math fence
    // must be stable across rebuilds (and independent of snapshotId), so
    // anchors authored inside ProseMirror's math nodeview survive a
    // re-snapshot. Build the same markdown under two different snapshot
    // ids and confirm fingerprint equality + snapshotBlockId divergence.
    #[test]
    fn fenced_math_content_fingerprint_is_stable_across_builds() {
        let md = "```math\nE = mc^2\n```\n";
        let a = build(md, "snap-math-a");
        let b = build(md, "snap-math-b");
        assert_eq!(a.blocks.len(), 1);
        assert_eq!(b.blocks.len(), 1);
        assert_eq!(a.blocks[0].kind, AnchorBlockKind::Math);
        assert_eq!(b.blocks[0].kind, AnchorBlockKind::Math);
        assert_eq!(
            a.blocks[0].content_fingerprint, b.blocks[0].content_fingerprint,
            "math contentFingerprint must be snapshot-id-independent"
        );
        assert_ne!(
            a.blocks[0].snapshot_block_id, b.blocks[0].snapshot_block_id,
            "math snapshotBlockId must vary with snapshotId"
        );
    }

    // Mirror of the math test above for the ```mermaid fence. The frontend
    // mermaid nodeview (web/src/lib/prosemirror/mermaid) renders these
    // blocks as a single addressable node, so the anchor fingerprint must
    // survive a re-snapshot without drifting through `unknown` (decision
    // #16).
    #[test]
    fn fenced_mermaid_content_fingerprint_is_stable_across_builds() {
        let md = "```mermaid\ngraph TD; A-->B;\n```\n";
        let a = build(md, "snap-mermaid-a");
        let b = build(md, "snap-mermaid-b");
        assert_eq!(a.blocks.len(), 1);
        assert_eq!(b.blocks.len(), 1);
        assert_eq!(a.blocks[0].kind, AnchorBlockKind::Mermaid);
        assert_eq!(b.blocks[0].kind, AnchorBlockKind::Mermaid);
        assert_eq!(
            a.blocks[0].content_fingerprint, b.blocks[0].content_fingerprint,
            "mermaid contentFingerprint must be snapshot-id-independent"
        );
        assert_ne!(
            a.blocks[0].snapshot_block_id, b.blocks[0].snapshot_block_id,
            "mermaid snapshotBlockId must vary with snapshotId"
        );
    }

    #[test]
    fn invalid_utf8_returns_error() {
        // 0xFF on its own is invalid UTF-8.
        let bytes = [0xFFu8, 0xFE, 0xFD];
        let err = build_anchor_index(&bytes, &snap("snap-bad"))
            .expect_err("invalid UTF-8 should error");
        assert!(matches!(err, AnchorIndexError::InvalidUtf8));
    }

    #[test]
    fn line_count_matches_newline_plus_one_rule() {
        // No trailing newline → "lines + 1".
        assert_eq!(count_lines(b"abc"), 1);
        assert_eq!(count_lines(b"a\nb"), 2);
        // Trailing newline → exactly the newline count.
        assert_eq!(count_lines(b"a\nb\n"), 2);
        assert_eq!(count_lines(b"\n"), 1);
        // The empty document is the special case: 0 lines.
        assert_eq!(count_lines(b""), 0);
    }

    #[test]
    fn normalize_text_lowercases_and_collapses_whitespace() {
        assert_eq!(normalize_text("Hello, World!"), "hello world");
        assert_eq!(normalize_text("  Many\t  spaces\n"), "many spaces");
        assert_eq!(normalize_text(""), "");
    }

    #[test]
    fn code_block_kind_is_preserved_for_other_langs() {
        let md = "```python\nprint('hi')\n```\n";
        let idx = build(md, "snap-py");
        assert_eq!(idx.blocks[0].kind, AnchorBlockKind::CodeBlock);
    }

    #[test]
    fn blockquote_emits_a_single_blockquote_block() {
        let md = "> quoted line\n> next quoted line\n";
        let idx = build(md, "snap-bq");
        // The quote becomes one container block; the inner paragraph is
        // absorbed (we deliberately do not double-emit).
        assert!(
            idx.blocks
                .iter()
                .any(|b| b.kind == AnchorBlockKind::Blockquote),
            "expected a blockquote block, got {:?}",
            idx.blocks.iter().map(|b| b.kind).collect::<Vec<_>>()
        );
    }

    #[test]
    fn thematic_break_emits_a_thematic_break_block() {
        let md = "before\n\n---\n\nafter\n";
        let idx = build(md, "snap-hr");
        assert!(
            idx.blocks
                .iter()
                .any(|b| b.kind == AnchorBlockKind::ThematicBreak),
            "expected a thematic_break block, got {:?}",
            idx.blocks.iter().map(|b| b.kind).collect::<Vec<_>>()
        );
    }

    #[test]
    fn snapshot_block_id_is_64_hex_chars() {
        let md = "# Heading\n";
        let idx = build(md, "snap-hex");
        for b in &idx.blocks {
            assert_eq!(
                b.snapshot_block_id.len(),
                64,
                "snapshotBlockId should be a 32-byte sha256 in lowercase hex"
            );
            assert!(b.snapshot_block_id.chars().all(|c| c.is_ascii_hexdigit()));
            assert_eq!(b.content_fingerprint.len(), 64);
            assert!(b.content_fingerprint.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }
}
