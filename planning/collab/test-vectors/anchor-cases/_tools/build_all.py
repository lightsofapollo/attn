#!/usr/bin/env python3
"""
Build all corpus cases under planning/collab/test-vectors/anchor-cases/.

Each case is described inline (markdown text + range + expected outcome).
This file is the single source of truth for the corpus contents. Re-run
when adding or modifying a case to regenerate the four files for each.

Run with:
    python3 planning/collab/test-vectors/anchor-cases/_tools/build_all.py

The script writes original.md, edited.md, anchor.json, expected.json into
each NNN-description/ directory.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_case import (  # noqa: E402
    AnchorSpec,
    HeadingRef,
    build_anchor,
    content_hash,
    content_fingerprint,
    dump_json,
    normalize_text,
    snapshot_block_id,
    sha256_hex,
)

ROOT = Path(__file__).resolve().parent.parent
FILE_ID = "file-corpus-fixture"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def find_byte_range(md: str, needle: str) -> tuple[int, int]:
    """Locate `needle` in `md` and return its UTF-8 byte range [lo, hi)."""
    b = md.encode("utf-8")
    n = needle.encode("utf-8")
    idx = b.find(n)
    if idx < 0:
        raise ValueError(f"needle {needle!r} not found in markdown")
    return (idx, idx + len(n))


def find_line_range(md: str, needle: str) -> tuple[int, int]:
    """1-based inclusive line range of the first occurrence of `needle`."""
    idx = md.find(needle)
    if idx < 0:
        raise ValueError(f"needle {needle!r} not found in markdown (line lookup)")
    start_line = md.count("\n", 0, idx) + 1
    end_line = md.count("\n", 0, idx + len(needle)) + 1
    return (start_line, end_line)


@dataclass
class Case:
    """One corpus case description."""

    number: int
    slug: str  # short kebab description
    original_md: str
    edited_md: str
    # The anchor refers to a substring of original_md. We find it by content
    # to avoid hand-counting bytes.
    quote: str  # the selected text in original_md
    block_text: str  # text of the enclosing block in original_md (for fingerprint)
    block_kind: str = "paragraph"
    heading_path: list[HeadingRef] = field(default_factory=list)
    ordinal_in_parent: int = 0
    duplicate_ordinal: int = 0
    # Surrounding context. If None, the script derives a ~80-char window
    # before/after the quote within original_md.
    prefix: str | None = None
    suffix: str | None = None
    previous_block_text: str | None = None
    next_block_text: str | None = None
    # Hand-curated expected resolution. The shape matches the
    # ResolvedAnchor union — caller fills in the right keys.
    #
    # For status in ("exact", "remapped"): set expected["currentRangeNeedle"]
    # to a string that appears at the resolved location in edited_md and the
    # build step rewrites it into a real byteRange + lineRange. (This avoids
    # hand-counting bytes after every wording tweak.)
    #
    # For status == "ambiguous": each candidate may carry
    # `currentRangeNeedle` (preferred) AND/OR `currentRangeNeedleOccurrence`
    # (0-based index when the needle appears more than once in edited_md).
    expected: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Case builder driver
# ---------------------------------------------------------------------------


def _expand_context(md: str, idx_lo: int, idx_hi: int, span: int = 80) -> tuple[str, str]:
    bs = md.encode("utf-8")
    lo = max(0, idx_lo - span)
    hi = min(len(bs), idx_hi + span)
    # Be careful around UTF-8 boundaries — back up until we hit a char start.
    while lo > 0 and (bs[lo] & 0xC0) == 0x80:
        lo -= 1
    while hi < len(bs) and (bs[hi] & 0xC0) == 0x80:
        hi += 1
    prefix = bs[lo:idx_lo].decode("utf-8", errors="replace")
    suffix = bs[idx_hi:hi].decode("utf-8", errors="replace")
    return prefix, suffix


def _block_range(md: str, block_text: str) -> tuple[tuple[int, int], tuple[int, int]]:
    bs = md.encode("utf-8")
    nb = block_text.encode("utf-8")
    idx = bs.find(nb)
    if idx < 0:
        raise ValueError(
            f"block_text {block_text[:40]!r}... not found in markdown — "
            "did the markdown drift away from the case definition?"
        )
    line_range = find_line_range(md, block_text)
    return (idx, idx + len(nb)), line_range


def _resolve_needle_range(
    edited_md: str, needle: str, occurrence: int = 0
) -> tuple[tuple[int, int], tuple[int, int]]:
    """Find the n-th occurrence of `needle` in edited_md.
    Returns ((byteLo, byteHi), (lineLo, lineHi)).
    """
    bs = edited_md.encode("utf-8")
    nb = needle.encode("utf-8")
    start = 0
    found = -1
    for _ in range(occurrence + 1):
        found = bs.find(nb, start)
        if found < 0:
            break
        start = found + 1
    if found < 0:
        raise ValueError(
            f"needle {needle!r} occurrence {occurrence} not found in edited.md"
        )
    end = found + len(nb)
    # line range: count newlines BEFORE found / before end-1
    prefix = edited_md.encode("utf-8")[:found].decode("utf-8", errors="replace")
    line_start = prefix.count("\n") + 1
    body = edited_md.encode("utf-8")[:end].decode("utf-8", errors="replace")
    line_end = body.count("\n") + 1
    return (found, end), (line_start, line_end)


def _resolve_expected(case: Case) -> dict[str, Any]:
    """Walk case.expected, rewriting any `currentRangeNeedle` fields into
    a real currentRange.byteRange + currentRange.lineRange computed against
    edited.md. Returns a new dict — the original `case.expected` is left
    untouched.
    """
    exp = json.loads(json.dumps(case.expected))  # deep copy via JSON
    status = exp.get("status")

    def fill(node: dict[str, Any]) -> None:
        needle = node.pop("currentRangeNeedle", None)
        occ = node.pop("currentRangeNeedleOccurrence", 0)
        if needle is None:
            return
        br, lr = _resolve_needle_range(case.edited_md, needle, occ)
        node["currentRange"] = {
            "byteRange": [br[0], br[1]],
            "lineRange": [lr[0], lr[1]],
        }
        # If the candidate doesn't specify a preview, default it to the
        # needle text (matches what the resolver would surface in the UI).
        if "preview" in node and node["preview"] is None:
            node["preview"] = needle

    if status in ("exact", "remapped"):
        fill(exp)
    elif status == "ambiguous":
        for c in exp.get("candidates", []):
            fill(c)
    return exp


def write_case(case: Case) -> None:
    name = f"{case.number:03d}-{case.slug}"
    out = ROOT / name
    out.mkdir(exist_ok=True)
    (out / "original.md").write_text(case.original_md)
    (out / "edited.md").write_text(case.edited_md)

    snapshot_id = f"snapshot-{case.number:03d}"

    quote_range = find_byte_range(case.original_md, case.quote)
    quote_line_range = find_line_range(case.original_md, case.quote)
    block_range, block_line_range = _block_range(case.original_md, case.block_text)
    prefix, suffix = _expand_context(case.original_md, quote_range[0], quote_range[1])
    if case.prefix is not None:
        prefix = case.prefix
    if case.suffix is not None:
        suffix = case.suffix

    spec = AnchorSpec(
        file_id=FILE_ID,
        snapshot_id=snapshot_id,
        original_md=case.original_md.encode("utf-8"),
        byte_range=quote_range,
        line_range=quote_line_range,
        quote_exact=case.quote,
        block_kind=case.block_kind,
        block_text=case.block_text,
        block_byte_range=block_range,
        block_line_range=block_line_range,
        heading_path=case.heading_path,
        ordinal_in_parent=case.ordinal_in_parent,
        duplicate_ordinal=case.duplicate_ordinal,
        prefix=prefix,
        suffix=suffix,
        previous_block_text=case.previous_block_text,
        next_block_text=case.next_block_text,
    )

    anchor = build_anchor(spec)
    dump_json(out / "anchor.json", anchor)
    dump_json(out / "expected.json", _resolve_expected(case))


# ---------------------------------------------------------------------------
# The corpus
#
# Each case is one Case() instance. Conventions:
#   - original_md/edited_md ALWAYS end with a trailing newline.
#   - `quote` is the selected text in original_md; the anchor's byteRange is
#     derived from this string's first occurrence.
#   - `block_text` is the FULL enclosing block (e.g., the whole paragraph) —
#     used to compute the block fingerprint.
#   - `expected` is hand-curated against amendments.md decision #15.
#
# Cases are grouped by primary ResolvedAnchor outcome.
# ---------------------------------------------------------------------------


def cases() -> list[Case]:
    out: list[Case] = []

    # =====================================================================
    # EXACT (~8) — status: exact, reason: base_hash_match
    # =====================================================================

    md_basic = (
        "# Title\n"
        "\n"
        "Alpha paragraph one.\n"
        "\n"
        "Beta paragraph two.\n"
        "\n"
        "Gamma paragraph three.\n"
    )

    out.append(
        Case(
            number=1,
            slug="exact-unchanged",
            original_md=md_basic,
            edited_md=md_basic,
            quote="Beta paragraph two.",
            block_text="Beta paragraph two.",
            heading_path=[HeadingRef(1, "Title", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "exact",
                "confidence": 1.0,
                "currentRangeNeedle": "Beta paragraph two.",
                "reason": "base_hash_match",
            },
        )
    )

    out.append(
        Case(
            number=2,
            slug="exact-whitespace-far-away",
            original_md=md_basic,
            edited_md=md_basic.replace(
                "Gamma paragraph three.", "Gamma paragraph three.   "
            ),
            quote="Beta paragraph two.",
            block_text="Beta paragraph two.",
            heading_path=[HeadingRef(1, "Title", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Beta paragraph two.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=3,
            slug="exact-distant-heading-rename",
            original_md=(
                "# Title\n"
                "\n"
                "Alpha paragraph one.\n"
                "\n"
                "## Sub\n"
                "\n"
                "Beta paragraph two.\n"
                "\n"
                "## Other\n"
                "\n"
                "Gamma paragraph three.\n"
            ),
            edited_md=(
                "# Title\n"
                "\n"
                "Alpha paragraph one.\n"
                "\n"
                "## Sub\n"
                "\n"
                "Beta paragraph two.\n"
                "\n"
                "## Renamed\n"
                "\n"
                "Gamma paragraph three.\n"
            ),
            quote="Beta paragraph two.",
            block_text="Beta paragraph two.",
            heading_path=[HeadingRef(1, "Title", 0), HeadingRef(2, "Sub", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Beta paragraph two.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=4,
            slug="exact-other-section-code-edit",
            original_md=(
                "## Notes\n\nBeta paragraph two.\n\n## Code\n\n```rust\nfn old() {}\n```\n"
            ),
            edited_md=(
                "## Notes\n\nBeta paragraph two.\n\n## Code\n\n```rust\nfn renamed() {}\n```\n"
            ),
            quote="Beta paragraph two.",
            block_text="Beta paragraph two.",
            heading_path=[HeadingRef(2, "Notes", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Beta paragraph two.",
                "reason": "quote_match",
            },
        )
    )

    md_list = (
        "# Tasks\n\n- first item\n- second item\n- third item\n\nClosing paragraph.\n"
    )
    out.append(
        Case(
            number=5,
            slug="exact-list-untouched",
            original_md=md_list,
            edited_md=md_list,
            quote="second item",
            block_text="- second item",
            block_kind="list_item",
            heading_path=[HeadingRef(1, "Tasks", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "exact",
                "confidence": 1.0,
                "currentRangeNeedle": "second item",
                "reason": "base_hash_match",
            },
        )
    )

    md_with_trailing = "# Title\n\nAlpha paragraph one.\n\nBeta paragraph two.\n"
    out.append(
        Case(
            number=6,
            slug="exact-only-new-paragraph-appended",
            original_md=md_with_trailing,
            edited_md=md_with_trailing + "\nNew tail paragraph.\n",
            quote="Alpha paragraph one.",
            block_text="Alpha paragraph one.",
            heading_path=[HeadingRef(1, "Title", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Alpha paragraph one.",
                "reason": "quote_match",
            },
        )
    )

    md_table = (
        "# Data\n\n"
        "| Col A | Col B |\n"
        "| ----- | ----- |\n"
        "| one   | two   |\n"
        "\n"
        "Trailing paragraph.\n"
    )
    out.append(
        Case(
            number=7,
            slug="exact-table-untouched",
            original_md=md_table,
            edited_md=md_table,
            quote="| one   | two   |",
            block_text=(
                "| Col A | Col B |\n| ----- | ----- |\n| one   | two   |"
            ),
            block_kind="table",
            heading_path=[HeadingRef(1, "Data", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "exact",
                "confidence": 1.0,
                "currentRangeNeedle": "| one   | two   |",
                "reason": "base_hash_match",
            },
        )
    )

    md_blockquote = (
        "# Notes\n\n> The quick brown fox\n> jumps over the lazy dog.\n\nFollow-up.\n"
    )
    out.append(
        Case(
            number=8,
            slug="exact-blockquote-untouched",
            original_md=md_blockquote,
            edited_md=md_blockquote,
            quote="quick brown fox",
            block_text="> The quick brown fox\n> jumps over the lazy dog.",
            block_kind="blockquote",
            heading_path=[HeadingRef(1, "Notes", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "exact",
                "confidence": 1.0,
                "currentRangeNeedle": "quick brown fox",
                "reason": "base_hash_match",
            },
        )
    )

    # =====================================================================
    # REMAPPED quote_match (~10) — status: remapped, reason: quote_match,
    # confidence: 0.90
    # =====================================================================

    md_three = (
        "# Doc\n\nAlpha paragraph one.\n\nBeta paragraph two.\n\nGamma paragraph three.\n"
    )
    out.append(
        Case(
            number=10,
            slug="remap-paragraph-moved-up",
            original_md=md_three,
            edited_md=(
                "# Doc\n\nBeta paragraph two.\n\nAlpha paragraph one.\n\nGamma paragraph three.\n"
            ),
            quote="Beta paragraph two.",
            block_text="Beta paragraph two.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Beta paragraph two.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=11,
            slug="remap-paragraph-moved-into-other-section",
            original_md=(
                "# Doc\n\n## A\n\nBeta paragraph two.\n\n## B\n\nOther text.\n"
            ),
            edited_md=(
                "# Doc\n\n## A\n\nReplacement.\n\n## B\n\nBeta paragraph two.\n\nOther text.\n"
            ),
            quote="Beta paragraph two.",
            block_text="Beta paragraph two.",
            heading_path=[HeadingRef(1, "Doc", 0), HeadingRef(2, "A", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Beta paragraph two.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=12,
            slug="remap-quote-preserved-surrounding-changed",
            original_md=(
                "# Doc\n\nIntro line A.\n\nThe golden ratio is approximately 1.618.\n\nOutro line A.\n"
            ),
            edited_md=(
                "# Doc\n\nCompletely different intro.\n\nThe golden ratio is approximately 1.618.\n\nA brand new closing line.\n"
            ),
            quote="The golden ratio is approximately 1.618.",
            block_text="The golden ratio is approximately 1.618.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "The golden ratio is approximately 1.618.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=13,
            slug="remap-paragraph-bumped-down-by-insert",
            original_md=md_basic,
            edited_md=(
                "# Title\n\nNEW intro paragraph.\n\nAlpha paragraph one.\n\nBeta paragraph two.\n\nGamma paragraph three.\n"
            ),
            quote="Beta paragraph two.",
            block_text="Beta paragraph two.",
            heading_path=[HeadingRef(1, "Title", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Beta paragraph two.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=14,
            slug="remap-list-item-reordered",
            original_md="# Tasks\n\n- buy milk\n- write docs\n- ship code\n",
            edited_md="# Tasks\n\n- ship code\n- buy milk\n- write docs\n",
            quote="write docs",
            block_text="- write docs",
            block_kind="list_item",
            heading_path=[HeadingRef(1, "Tasks", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "write docs",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=15,
            slug="remap-quote-survives-paragraph-split",
            original_md=(
                "# Notes\n\nFirst sentence. The middle sentence is unique. Final sentence.\n"
            ),
            edited_md=(
                "# Notes\n\nFirst sentence.\n\nThe middle sentence is unique.\n\nFinal sentence.\n"
            ),
            quote="The middle sentence is unique.",
            block_text=(
                "First sentence. The middle sentence is unique. Final sentence."
            ),
            heading_path=[HeadingRef(1, "Notes", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "The middle sentence is unique.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=16,
            slug="remap-quote-survives-paragraph-merge",
            original_md=(
                "# Notes\n\nFirst sentence.\n\nThe unique middle.\n\nFinal sentence.\n"
            ),
            edited_md=(
                "# Notes\n\nFirst sentence. The unique middle. Final sentence.\n"
            ),
            quote="The unique middle.",
            block_text="The unique middle.",
            heading_path=[HeadingRef(1, "Notes", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "The unique middle.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=17,
            slug="remap-quote-survives-heading-promotion",
            original_md=(
                "# Top\n\n## Sub\n\nDistinctive content here.\n"
            ),
            edited_md=(
                "# Top\n\n# Promoted\n\nDistinctive content here.\n"
            ),
            quote="Distinctive content here.",
            block_text="Distinctive content here.",
            heading_path=[HeadingRef(1, "Top", 0), HeadingRef(2, "Sub", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Distinctive content here.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=18,
            slug="remap-quote-survives-bullet-to-ordered",
            original_md="# Tasks\n\n- one alpha\n- two beta\n- three gamma\n",
            edited_md="# Tasks\n\n1. one alpha\n2. two beta\n3. three gamma\n",
            quote="two beta",
            block_text="- two beta",
            block_kind="list_item",
            heading_path=[HeadingRef(1, "Tasks", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "two beta",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=19,
            slug="remap-section-reordered",
            original_md=(
                "# Doc\n\n## A\n\nA-body.\n\n## B\n\nDistinctive sentence here.\n\n## C\n\nC-body.\n"
            ),
            edited_md=(
                "# Doc\n\n## C\n\nC-body.\n\n## A\n\nA-body.\n\n## B\n\nDistinctive sentence here.\n"
            ),
            quote="Distinctive sentence here.",
            block_text="Distinctive sentence here.",
            heading_path=[HeadingRef(1, "Doc", 0), HeadingRef(2, "B", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Distinctive sentence here.",
                "reason": "quote_match",
            },
        )
    )

    # =====================================================================
    # REMAPPED block_fingerprint_match (~5) — confidence 0.85
    #
    # Pre-condition: kind + normalizedText + headingPath match, but the
    # quote layer is missing OR doesn't help (e.g., a block-level comment
    # with no quote text), and byte range has shifted.
    # =====================================================================

    # block_fingerprint_match (0.85) — the quote text in original.md changed
    # in edited.md (e.g., punctuation tweak), so the unique-quote search
    # FAILS, but the block's normalizedText + kind + headingPath still match
    # via contentFingerprint. The resolver should fall through quote_match,
    # then land on block_fingerprint_match.
    out.append(
        Case(
            number=20,
            slug="remap-block-fingerprint-punctuation-changed",
            original_md=(
                "# Title\n\nIntro.\n\nFingerprint target paragraph, here.\n\nTrailing.\n"
            ),
            edited_md=(
                "# Title\n\nIntro is now substantially longer.\n\nFingerprint target paragraph here!\n\nTrailing.\n"
            ),
            quote="Fingerprint target paragraph, here.",
            block_text="Fingerprint target paragraph, here.",
            heading_path=[HeadingRef(1, "Title", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.85,
                "currentRangeNeedle": "Fingerprint target paragraph here!",
                "reason": "block_fingerprint_match",
            },
        )
    )

    out.append(
        Case(
            number=21,
            slug="remap-block-fingerprint-whitespace-collapsed",
            original_md=(
                "# H\n\nFingerprintable paragraph A.\n\nLater paragraph B.\n"
            ),
            edited_md=(
                "# H\n\nPrepended new line.\n\nFingerprintable    paragraph   A.\n\nLater paragraph B.\n"
            ),
            quote="Fingerprintable paragraph A.",
            block_text="Fingerprintable paragraph A.",
            heading_path=[HeadingRef(1, "H", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.85,
                "currentRangeNeedle": "Fingerprintable    paragraph   A.",
                "reason": "block_fingerprint_match",
            },
        )
    )

    out.append(
        Case(
            number=22,
            slug="remap-block-fingerprint-casing-tweak",
            original_md=(
                "# Gallery\n\nIntro.\n\nBlock body with Specific Wording here.\n\nClosing.\n"
            ),
            edited_md=(
                "# Gallery\n\nIntro is longer now.\n\nBlock body with specific WORDING here.\n\nClosing.\n"
            ),
            quote="Block body with Specific Wording here.",
            block_text="Block body with Specific Wording here.",
            heading_path=[HeadingRef(1, "Gallery", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.85,
                "currentRangeNeedle": "Block body with specific WORDING here.",
                "reason": "block_fingerprint_match",
            },
        )
    )

    out.append(
        Case(
            number=23,
            slug="remap-block-fingerprint-code-block",
            original_md=(
                "# Snippets\n\n```rust\nfn one() {}\n```\n\n```rust\nfn target() { /* keep me */ }\n```\n"
            ),
            # Code-block normalization treats punctuation+whitespace as
            # equivalent — the slightly-reformatted code block still
            # fingerprints the same.
            edited_md=(
                "# Snippets\n\n```rust\nfn target() {  /* keep me */  }\n```\n\n```rust\nfn one() {}\n```\n"
            ),
            quote="fn target() { /* keep me */ }",
            block_text=(
                "```rust\nfn target() { /* keep me */ }\n```"
            ),
            block_kind="code_block",
            heading_path=[HeadingRef(1, "Snippets", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "remapped",
                "confidence": 0.85,
                "currentRangeNeedle": "fn target() {  /* keep me */  }",
                "reason": "block_fingerprint_match",
            },
        )
    )

    out.append(
        Case(
            number=24,
            slug="remap-block-fingerprint-table-cell-repunctuated",
            original_md=(
                "# Data\n\n| H1 | H2 |\n| -- | -- |\n| aa, alpha | bb |\n"
            ),
            edited_md=(
                "# Data\n\n| H1 | H2 |\n| -- | -- |\n| aa alpha | bb |\n"
            ),
            quote="aa, alpha",
            block_text="| H1 | H2 |\n| -- | -- |\n| aa, alpha | bb |",
            block_kind="table",
            heading_path=[HeadingRef(1, "Data", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.85,
                "currentRangeNeedle": "aa alpha",
                "reason": "block_fingerprint_match",
            },
        )
    )

    # =====================================================================
    # REMAPPED structure_quote_match (~5) — confidence 0.80
    #
    # Quote unchanged, headingPath unchanged, position shifted within the
    # same section. (Quote is exact, but to set up this category we craft
    # cases where the resolver leans on structure+quote rather than the
    # bare quote match. In practice the resolver may upgrade these to
    # quote_match at 0.90; we tag the LAYER expectation here.)
    # =====================================================================

    # structure_quote_match (0.80) — exact quote text changed (so the
    # 0.90 quote_match step misses), but the NORMALIZED quote text still
    # matches within the original heading path. The structure layer
    # narrows the search to a single section, where a normalized-match
    # fires. (If we let the quote also exist elsewhere, the resolver
    # might return ambiguous; we keep one normalized match per case.)
    out.append(
        Case(
            number=30,
            slug="remap-structure-quote-normalized-within-section",
            original_md=(
                "# Top\n\n## Stable\n\nTarget sentence inside stable.\n\n## Other\n\nUnrelated.\n"
            ),
            edited_md=(
                "# Top\n\n## Stable\n\nThe target sentence, inside Stable!\n\n## Other\n\nUnrelated.\n"
            ),
            quote="Target sentence inside stable.",
            block_text="Target sentence inside stable.",
            heading_path=[HeadingRef(1, "Top", 0), HeadingRef(2, "Stable", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.80,
                "currentRangeNeedle": "The target sentence, inside Stable!",
                "reason": "structure_quote_match",
            },
        )
    )

    out.append(
        Case(
            number=31,
            slug="remap-structure-quote-list-item-repunctuated",
            original_md=(
                "# Top\n\n## Tasks\n\n- beta task\n\n## Misc\n\n- other\n"
            ),
            edited_md=(
                "# Top\n\n## Tasks\n\n- Beta, task!\n\n## Misc\n\n- other\n"
            ),
            quote="beta task",
            block_text="- beta task",
            block_kind="list_item",
            heading_path=[HeadingRef(1, "Top", 0), HeadingRef(2, "Tasks", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.80,
                "currentRangeNeedle": "Beta, task!",
                "reason": "structure_quote_match",
            },
        )
    )

    out.append(
        Case(
            number=32,
            slug="remap-structure-quote-casing-changed-in-section",
            original_md=(
                "# Top\n\n## Stable\n\nAnchored sentence inside Stable.\n\n## Other\n\nUnrelated.\n"
            ),
            edited_md=(
                "# Top\n\n## Stable\n\nANCHORED SENTENCE inside STABLE.\n\n## Other\n\nUnrelated.\n"
            ),
            quote="Anchored sentence inside Stable.",
            block_text="Anchored sentence inside Stable.",
            heading_path=[HeadingRef(1, "Top", 0), HeadingRef(2, "Stable", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.80,
                "currentRangeNeedle": "ANCHORED SENTENCE inside STABLE.",
                "reason": "structure_quote_match",
            },
        )
    )

    out.append(
        Case(
            number=33,
            slug="remap-structure-quote-blockquote-repunctuated",
            original_md=(
                "# Top\n\n## Notes\n\n> Anchored quote text inside notes.\n\n## Other\n\nNothing.\n"
            ),
            edited_md=(
                "# Top\n\n## Notes\n\n> Anchored quote text, inside notes!\n\n## Other\n\nNothing.\n"
            ),
            quote="Anchored quote text inside notes.",
            block_text="> Anchored quote text inside notes.",
            block_kind="blockquote",
            heading_path=[HeadingRef(1, "Top", 0), HeadingRef(2, "Notes", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.80,
                "currentRangeNeedle": "Anchored quote text, inside notes!",
                "reason": "structure_quote_match",
            },
        )
    )

    out.append(
        Case(
            number=34,
            slug="remap-structure-quote-deep-path-disambiguates",
            original_md=(
                "# Top\n\n## A\n\n### Inner\n\nDistinctive line under A/Inner.\n\n## B\n\nNothing.\n"
            ),
            # Quote rewritten with extra punctuation; only the original
            # heading-path section contains a normalized match.
            edited_md=(
                "# Top\n\n## A\n\n### Inner\n\nDistinctive! Line under A/Inner.\n\n## B\n\nNothing.\n"
            ),
            quote="Distinctive line under A/Inner.",
            block_text="Distinctive line under A/Inner.",
            heading_path=[
                HeadingRef(1, "Top", 0),
                HeadingRef(2, "A", 0),
                HeadingRef(3, "Inner", 0),
            ],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.80,
                "currentRangeNeedle": "Distinctive! Line under A/Inner.",
                "reason": "structure_quote_match",
            },
        )
    )

    # =====================================================================
    # REMAPPED context_match (~3) — confidence 0.70
    #
    # Quote text was slightly modified (typo fix, casing change). The
    # prefix and suffix still match exactly so the resolver remaps via
    # context.
    # =====================================================================

    out.append(
        Case(
            number=40,
            slug="remap-context-quote-typo-fixed",
            original_md=(
                "# Doc\n\nIntro text before. The quik brown fox runs. Outro text after.\n"
            ),
            edited_md=(
                "# Doc\n\nIntro text before. The quick brown fox runs. Outro text after.\n"
            ),
            quote="quik brown fox",
            block_text=(
                "Intro text before. The quik brown fox runs. Outro text after."
            ),
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.70,
                "currentRangeNeedle": "quick brown fox",
                "reason": "context_match",
            },
        )
    )

    out.append(
        Case(
            number=41,
            slug="remap-context-casing-change",
            original_md=(
                "# Doc\n\nPrefix sentence. webcrypto api support. Suffix sentence.\n"
            ),
            edited_md=(
                "# Doc\n\nPrefix sentence. WebCrypto API support. Suffix sentence.\n"
            ),
            quote="webcrypto api support",
            block_text=(
                "Prefix sentence. webcrypto api support. Suffix sentence."
            ),
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.70,
                "currentRangeNeedle": "WebCrypto API support",
                "reason": "context_match",
            },
        )
    )

    out.append(
        Case(
            number=42,
            slug="remap-context-punctuation-tweak",
            original_md=(
                "# Doc\n\nLeading bit. there are 3 cases here. Trailing bit.\n"
            ),
            edited_md=(
                "# Doc\n\nLeading bit. There are 3 cases here! Trailing bit.\n"
            ),
            quote="there are 3 cases here.",
            block_text=(
                "Leading bit. there are 3 cases here. Trailing bit."
            ),
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.70,
                "currentRangeNeedle": "There are 3 cases here",
                "reason": "context_match",
            },
        )
    )

    # =====================================================================
    # REMAPPED fuzzy_quote_match (~3) — confidence 0.50-0.75
    # =====================================================================

    out.append(
        Case(
            number=50,
            slug="remap-fuzzy-mild-rewording",
            original_md=(
                "# Doc\n\nThe quick brown fox jumps over the lazy dog.\n"
            ),
            edited_md=(
                "# Doc\n\nA quick brown fox jumps over a lazy dog.\n"
            ),
            quote="The quick brown fox jumps over the lazy dog.",
            block_text="The quick brown fox jumps over the lazy dog.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.60,
                "currentRangeNeedle": "quick brown fox jumps over",
                "reason": "fuzzy_quote_match",
            },
        )
    )

    out.append(
        Case(
            number=51,
            slug="remap-fuzzy-word-inserted",
            original_md=(
                "# Doc\n\nWe need to ship before EOQ.\n"
            ),
            edited_md=(
                "# Doc\n\nWe really need to ship well before EOQ.\n"
            ),
            quote="We need to ship before EOQ.",
            block_text="We need to ship before EOQ.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.65,
                "currentRangeNeedle": "We really need to ship well before EOQ",
                "reason": "fuzzy_quote_match",
            },
        )
    )

    out.append(
        Case(
            number=52,
            slug="remap-fuzzy-synonym-substitution",
            original_md=(
                "# Doc\n\nThe service must be available 24/7.\n"
            ),
            edited_md=(
                "# Doc\n\nThe service has to be online 24/7.\n"
            ),
            quote="The service must be available 24/7.",
            block_text="The service must be available 24/7.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.55,
                "currentRangeNeedle": "The service has to be online 24/7",
                "reason": "fuzzy_quote_match",
            },
        )
    )

    # =====================================================================
    # AMBIGUOUS (~6) — status: ambiguous, two+ candidates within 0.10
    # =====================================================================

    out.append(
        Case(
            number=60,
            slug="ambiguous-duplicate-paragraph",
            original_md=(
                "# Doc\n\nIntro.\n\nShared sentence.\n\nMiddle.\n\nShared sentence.\n\nOutro.\n"
            ),
            edited_md=(
                "# Doc\n\nIntro.\n\nShared sentence.\n\nMiddle.\n\nShared sentence.\n\nOutro.\n"
            ),
            quote="Shared sentence.",
            block_text="Shared sentence.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=1,
            duplicate_ordinal=0,
            expected={
                "status": "ambiguous",
                "reason": "two_quote_matches_within_0.10",
                "candidates": [
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "Shared sentence.",
                        "reason": "quote_match",
                        "preview": "Shared sentence.",
                    },
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "Shared sentence.", "currentRangeNeedleOccurrence": 1,
                        "reason": "quote_match",
                        "preview": "Shared sentence.",
                    },
                ],
            },
        )
    )

    out.append(
        Case(
            number=61,
            slug="ambiguous-list-item-duplicate-text",
            original_md=(
                "# Tasks\n\n- review PR\n- write tests\n- review PR\n- ship build\n"
            ),
            edited_md=(
                "# Tasks\n\n- review PR\n- write tests\n- review PR\n- ship build\n"
            ),
            quote="review PR",
            block_text="- review PR",
            block_kind="list_item",
            heading_path=[HeadingRef(1, "Tasks", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "ambiguous",
                "reason": "two_quote_matches_within_0.10",
                "candidates": [
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "review PR",
                        "reason": "quote_match",
                        "preview": "review PR",
                    },
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "review PR", "currentRangeNeedleOccurrence": 1,
                        "reason": "quote_match",
                        "preview": "review PR",
                    },
                ],
            },
        )
    )

    out.append(
        Case(
            number=62,
            slug="ambiguous-paragraph-was-duplicated-in-edit",
            original_md=(
                "# Doc\n\nIntro.\n\nUnique target paragraph.\n\nOutro.\n"
            ),
            edited_md=(
                "# Doc\n\nIntro.\n\nUnique target paragraph.\n\nMiddle.\n\nUnique target paragraph.\n\nOutro.\n"
            ),
            quote="Unique target paragraph.",
            block_text="Unique target paragraph.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "ambiguous",
                "reason": "two_quote_matches_within_0.10",
                "candidates": [
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "Unique target paragraph.",
                        "reason": "quote_match",
                        "preview": "Unique target paragraph.",
                    },
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "Unique target paragraph.", "currentRangeNeedleOccurrence": 1,
                        "reason": "quote_match",
                        "preview": "Unique target paragraph.",
                    },
                ],
            },
        )
    )

    out.append(
        Case(
            number=63,
            slug="ambiguous-fingerprint-collision-across-sections",
            original_md=(
                "# Top\n\n## A\n\nShared body paragraph.\n\n## B\n\nDifferent body.\n"
            ),
            edited_md=(
                "# Top\n\n## A\n\nShared body paragraph.\n\n## B\n\nShared body paragraph.\n"
            ),
            quote="Shared body paragraph.",
            block_text="Shared body paragraph.",
            heading_path=[HeadingRef(1, "Top", 0), HeadingRef(2, "A", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "ambiguous",
                "reason": "two_quote_matches_within_0.10",
                "candidates": [
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "Shared body paragraph.",
                        "reason": "quote_match",
                        "preview": "Shared body paragraph.",
                    },
                    {
                        "confidence": 0.80,
                        "currentRangeNeedle": "Shared body paragraph.", "currentRangeNeedleOccurrence": 1,
                        "reason": "structure_quote_match",
                        "preview": "Shared body paragraph.",
                    },
                ],
            },
        )
    )

    out.append(
        Case(
            number=64,
            slug="ambiguous-heading-text-duplicated",
            original_md=(
                "# Doc\n\n## Notes\n\nTarget under first Notes.\n\n## Other\n\nfoo.\n"
            ),
            edited_md=(
                "# Doc\n\n## Notes\n\nTarget under first Notes.\n\n## Notes\n\nTarget under first Notes.\n"
            ),
            quote="Target under first Notes.",
            block_text="Target under first Notes.",
            heading_path=[HeadingRef(1, "Doc", 0), HeadingRef(2, "Notes", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "ambiguous",
                "reason": "two_quote_matches_within_0.10",
                "candidates": [
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "Target under first Notes.",
                        "reason": "quote_match",
                        "preview": "Target under first Notes.",
                    },
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "Target under first Notes.", "currentRangeNeedleOccurrence": 1,
                        "reason": "quote_match",
                        "preview": "Target under first Notes.",
                    },
                ],
            },
        )
    )

    out.append(
        Case(
            number=65,
            slug="ambiguous-table-cell-duplicate",
            original_md=(
                "# Data\n\n| Col |\n| --- |\n| same |\n| same |\n"
            ),
            edited_md=(
                "# Data\n\n| Col |\n| --- |\n| same |\n| same |\n"
            ),
            quote="| same |",
            block_text="| Col |\n| --- |\n| same |\n| same |",
            block_kind="table",
            heading_path=[HeadingRef(1, "Data", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "ambiguous",
                "reason": "two_quote_matches_within_0.10",
                "candidates": [
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "| same |",
                        "reason": "quote_match",
                        "preview": "| same |",
                    },
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "| same |", "currentRangeNeedleOccurrence": 1,
                        "reason": "quote_match",
                        "preview": "| same |",
                    },
                ],
            },
        )
    )

    # =====================================================================
    # STALE (~5) — status: stale, no current range
    # =====================================================================

    out.append(
        Case(
            number=70,
            slug="stale-paragraph-deleted",
            original_md=(
                "# Doc\n\nIntro paragraph.\n\nDeletable target paragraph.\n\nOutro paragraph.\n"
            ),
            edited_md=(
                "# Doc\n\nIntro paragraph.\n\nOutro paragraph.\n"
            ),
            quote="Deletable target paragraph.",
            block_text="Deletable target paragraph.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "stale",
                "reason": "no_candidate_above_0.35",
            },
        )
    )

    out.append(
        Case(
            number=71,
            slug="stale-entire-section-removed",
            original_md=(
                "# Doc\n\n## KeepMe\n\nKept body.\n\n## RemoveMe\n\nAnchored sentence in removed section.\n"
            ),
            edited_md=(
                "# Doc\n\n## KeepMe\n\nKept body.\n"
            ),
            quote="Anchored sentence in removed section.",
            block_text="Anchored sentence in removed section.",
            heading_path=[HeadingRef(1, "Doc", 0), HeadingRef(2, "RemoveMe", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "stale",
                "reason": "no_candidate_above_0.35",
            },
        )
    )

    out.append(
        Case(
            number=72,
            slug="stale-quote-and-context-rewritten",
            original_md=(
                "# Doc\n\nBefore part. The originally anchored phrase here. After part.\n"
            ),
            edited_md=(
                "# Doc\n\nCompletely different wording with no overlap whatsoever.\n"
            ),
            quote="The originally anchored phrase here.",
            block_text=(
                "Before part. The originally anchored phrase here. After part."
            ),
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "stale",
                "reason": "no_candidate_above_0.35",
            },
        )
    )

    out.append(
        Case(
            number=73,
            slug="stale-heading-renamed-and-content-rewritten",
            original_md=(
                "# Doc\n\n## ChapterA\n\nThe one true sentence of ChapterA.\n"
            ),
            edited_md=(
                "# Doc\n\n## ChapterB\n\nA brand new sentence about other topics.\n"
            ),
            quote="The one true sentence of ChapterA.",
            block_text="The one true sentence of ChapterA.",
            heading_path=[HeadingRef(1, "Doc", 0), HeadingRef(2, "ChapterA", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "stale",
                "reason": "no_candidate_above_0.35",
            },
        )
    )

    out.append(
        Case(
            number=74,
            slug="stale-list-item-removed",
            original_md=(
                "# Tasks\n\n- alpha\n- beta\n- delete-me unique\n- gamma\n"
            ),
            edited_md=(
                "# Tasks\n\n- alpha\n- beta\n- gamma\n"
            ),
            quote="delete-me unique",
            block_text="- delete-me unique",
            block_kind="list_item",
            heading_path=[HeadingRef(1, "Tasks", 0)],
            ordinal_in_parent=2,
            expected={
                "status": "stale",
                "reason": "no_candidate_above_0.35",
            },
        )
    )

    # =====================================================================
    # Additional spread to cross 45 and exercise edge cases
    # =====================================================================

    out.append(
        Case(
            number=80,
            slug="exact-front-matter-unchanged",
            original_md=(
                "---\ntitle: doc\n---\n\n# Body\n\nUnique sentence here.\n"
            ),
            edited_md=(
                "---\ntitle: doc\n---\n\n# Body\n\nUnique sentence here.\n"
            ),
            quote="Unique sentence here.",
            block_text="Unique sentence here.",
            heading_path=[HeadingRef(1, "Body", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "exact",
                "confidence": 1.0,
                "currentRangeNeedle": "Unique sentence here.",
                "reason": "base_hash_match",
            },
        )
    )

    out.append(
        Case(
            number=81,
            slug="remap-front-matter-edited-body-untouched",
            original_md=(
                "---\ntitle: doc\nauthor: a\n---\n\n# Body\n\nUnique anchored line.\n"
            ),
            edited_md=(
                "---\ntitle: doc\nauthor: b\n---\n\n# Body\n\nUnique anchored line.\n"
            ),
            quote="Unique anchored line.",
            block_text="Unique anchored line.",
            heading_path=[HeadingRef(1, "Body", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Unique anchored line.",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=82,
            slug="remap-checkbox-state-toggled",
            original_md=(
                "# Tasks\n\n- [ ] write tests for resolver\n- [ ] ship release\n"
            ),
            edited_md=(
                "# Tasks\n\n- [x] write tests for resolver\n- [ ] ship release\n"
            ),
            quote="write tests for resolver",
            block_text="- [ ] write tests for resolver",
            block_kind="list_item",
            heading_path=[HeadingRef(1, "Tasks", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "write tests for resolver",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=83,
            slug="remap-emphasis-added-around-quote",
            original_md=(
                "# Doc\n\nThe phrase to remember is foundational here.\n"
            ),
            edited_md=(
                "# Doc\n\nThe phrase to remember is **foundational** here.\n"
            ),
            quote="foundational",
            block_text=(
                "The phrase to remember is foundational here."
            ),
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "foundational",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=84,
            slug="remap-link-target-changed-quote-stable",
            original_md=(
                "# Doc\n\nSee [the spec](old-url) for details.\n"
            ),
            edited_md=(
                "# Doc\n\nSee [the spec](new-url) for details.\n"
            ),
            quote="the spec",
            block_text="See [the spec](old-url) for details.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "the spec",
                "reason": "quote_match",
            },
        )
    )

    out.append(
        Case(
            number=85,
            slug="ambiguous-three-way-collision",
            original_md=(
                "# Doc\n\nrepeat me.\n\nrepeat me.\n\nrepeat me.\n"
            ),
            edited_md=(
                "# Doc\n\nrepeat me.\n\nrepeat me.\n\nrepeat me.\n"
            ),
            quote="repeat me.",
            block_text="repeat me.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "ambiguous",
                "reason": "three_quote_matches_within_0.10",
                "candidates": [
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "repeat me.",
                        "reason": "quote_match",
                        "preview": "repeat me.",
                    },
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "repeat me.", "currentRangeNeedleOccurrence": 1,
                        "reason": "quote_match",
                        "preview": "repeat me.",
                    },
                    {
                        "confidence": 0.90,
                        "currentRangeNeedle": "repeat me.", "currentRangeNeedleOccurrence": 2,
                        "reason": "quote_match",
                        "preview": "repeat me.",
                    },
                ],
            },
        )
    )

    out.append(
        Case(
            number=86,
            slug="stale-blockquote-removed",
            original_md=(
                "# Doc\n\nPreamble.\n\n> Anchored note inside the quote.\n\nClosing.\n"
            ),
            edited_md=(
                "# Doc\n\nPreamble.\n\nClosing.\n"
            ),
            quote="Anchored note inside the quote.",
            block_text="> Anchored note inside the quote.",
            block_kind="blockquote",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=1,
            expected={
                "status": "stale",
                "reason": "no_candidate_above_0.35",
            },
        )
    )

    out.append(
        Case(
            number=87,
            slug="remap-quote-unicode-preserved",
            original_md=(
                "# Doc\n\nLe café est délicieux aujourd'hui.\n"
            ),
            edited_md=(
                "# Doc\n\nIntro.\n\nLe café est délicieux aujourd'hui.\n"
            ),
            quote="Le café est délicieux aujourd'hui.",
            block_text="Le café est délicieux aujourd'hui.",
            heading_path=[HeadingRef(1, "Doc", 0)],
            ordinal_in_parent=0,
            expected={
                "status": "remapped",
                "confidence": 0.90,
                "currentRangeNeedle": "Le café est délicieux aujourd'hui.",
                "reason": "quote_match",
            },
        )
    )

    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    written = 0
    nums: set[int] = set()
    for c in cases():
        if c.number in nums:
            print(f"duplicate case number {c.number}", file=sys.stderr)
            return 1
        nums.add(c.number)
        write_case(c)
        written += 1
    print(f"wrote {written} cases to {ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
