#!/usr/bin/env python3
"""
Build anchor.json + expected.json for one corpus case.

This script mirrors the small subset of `src/review/anchors/index.rs` math
that anchor.json fields depend on — content hashes, text hashes, content
fingerprint, snapshot block id, normalized text. It does NOT parse markdown
(it doesn't need to — the human authoring the case picks the byte range and
heading path explicitly).

Usage: edit a per-case `build.py` next to `original.md` / `edited.md`, then
import this module and call `build_case(...)`. See `001-exact-unchanged/build.py`
for the simplest example.

Why a script and not real Rust: per attn-nnj.3.6 we "Don't generate anchor.json
from a real resolver run yet — hand-curate so the corpus drives the resolver".
This helper computes only the deterministic hashes; the resolution outcome is
hand-curated.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Canonical hashes (mirror src/review/anchors/index.rs + crypto/ids.rs)
# ---------------------------------------------------------------------------


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_b64url(data: bytes) -> str:
    """base64url-no-pad of SHA-256(data) — matches ContentHash wire format."""
    digest = hashlib.sha256(data).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def content_hash(canonical_bytes: bytes) -> str:
    """Spec: crypto-spec.md §ContentHash. Caller pre-canonicalizes bytes."""
    return sha256_b64url(canonical_bytes)


def normalize_text(text: str) -> str:
    """Mirrors `normalize_text` in src/review/anchors/index.rs.

    1. Lowercase (ASCII).
    2. Collapse runs of unicode whitespace into one space.
    3. Strip ASCII punctuation (treated as whitespace, so collapses with it).
    4. Trim leading/trailing whitespace.
    """
    out = []
    last_was_space = True  # suppress leading whitespace
    for ch in text:
        if ch.isspace():
            if not last_was_space:
                out.append(" ")
                last_was_space = True
            continue
        if _is_ascii_punctuation(ch):
            if not last_was_space:
                out.append(" ")
                last_was_space = True
            continue
        out.append(ch.lower())
        last_was_space = False
    s = "".join(out)
    if s.endswith(" "):
        s = s[:-1]
    return s


def _is_ascii_punctuation(ch: str) -> bool:
    o = ord(ch)
    return (
        (33 <= o <= 47)
        or (58 <= o <= 64)
        or (91 <= o <= 96)
        or (123 <= o <= 126)
    )


# ---------------------------------------------------------------------------
# Anchor index types (subset)
# ---------------------------------------------------------------------------


@dataclass
class HeadingRef:
    level: int
    text: str  # the heading's visible text — we hash here
    ordinal_at_level: int  # 0-based count of preceding same-level headings

    def to_json(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "textHash": sha256_hex(self.text.encode("utf-8")),
            "ordinalAtLevel": self.ordinal_at_level,
        }


def canonical_path_bytes(path: list[HeadingRef]) -> bytes:
    """Mirror `canonical_path_bytes` in index.rs.
    Each ref: `level:textHash:ordinalAtLevel`, joined with `/`.
    """
    parts: list[bytes] = []
    for r in path:
        text_hash = sha256_hex(r.text.encode("utf-8"))
        parts.append(f"{r.level}:{text_hash}:{r.ordinal_at_level}".encode("ascii"))
    return b"/".join(parts)


def content_fingerprint(
    kind: str,
    normalized_text: str,
    path: list[HeadingRef],
    duplicate_ordinal: int,
) -> str:
    """sha256( kind || US || normalizedText || US || pathBytes || US || dupOrdinal )"""
    buf = bytearray()
    buf.extend(kind.encode("ascii"))
    buf.append(0x1F)
    buf.extend(normalized_text.encode("utf-8"))
    buf.append(0x1F)
    buf.extend(canonical_path_bytes(path))
    buf.append(0x1F)
    buf.extend(str(duplicate_ordinal).encode("ascii"))
    return sha256_hex(bytes(buf))


def snapshot_block_id(
    snapshot_id: str, byte_range: tuple[int, int], fingerprint: str
) -> str:
    """sha256( snapshotId || US || lo:hi || US || contentFingerprint )"""
    buf = bytearray()
    buf.extend(snapshot_id.encode("utf-8"))
    buf.append(0x1F)
    buf.extend(f"{byte_range[0]}:{byte_range[1]}".encode("ascii"))
    buf.append(0x1F)
    buf.extend(fingerprint.encode("ascii"))
    return sha256_hex(bytes(buf))


# ---------------------------------------------------------------------------
# High-level helpers
# ---------------------------------------------------------------------------


@dataclass
class AnchorSpec:
    """Inputs for building one `anchor.json`.

    The author picks the byte range by hand (open original.md in an editor or
    use `wc -c` against a slice). All other fields are derived.

    `block_kind` and `block_text` describe the *enclosing block* (paragraph,
    heading, list_item, etc.) — the resolver uses these for the block layer.

    `heading_path` is the chain of ancestor headings as `HeadingRef`s.
    """

    file_id: str
    snapshot_id: str
    original_md: bytes
    byte_range: tuple[int, int]
    line_range: tuple[int, int]
    quote_exact: str | None
    block_kind: str | None
    block_text: str | None
    block_byte_range: tuple[int, int] | None
    block_line_range: tuple[int, int] | None
    heading_path: list[HeadingRef]
    ordinal_in_parent: int
    duplicate_ordinal: int
    prefix: str | None
    suffix: str | None
    previous_block_text: str | None = None
    next_block_text: str | None = None


def build_anchor(spec: AnchorSpec) -> dict[str, Any]:
    base_hash = content_hash(spec.original_md)
    anchor: dict[str, Any] = {
        "v": 2,
        "fileId": spec.file_id,
        "snapshotId": spec.snapshot_id,
        "baseHash": base_hash,
        "position": {
            "byteRange": [spec.byte_range[0], spec.byte_range[1]],
            "lineRange": [spec.line_range[0], spec.line_range[1]],
        },
    }
    if spec.quote_exact is not None:
        normalized = normalize_text(spec.quote_exact)
        anchor["quote"] = {
            "exact": spec.quote_exact,
            "exactHash": sha256_hex(spec.quote_exact.encode("utf-8")),
            "normalized": normalized,
            "normalizedHash": sha256_hex(normalized.encode("utf-8")),
        }
    if spec.block_kind is not None:
        assert spec.block_text is not None
        assert spec.block_byte_range is not None
        assert spec.block_line_range is not None
        norm_block = normalize_text(spec.block_text)
        fp = content_fingerprint(
            spec.block_kind, norm_block, spec.heading_path, spec.duplicate_ordinal
        )
        sbi = snapshot_block_id(spec.snapshot_id, spec.block_byte_range, fp)
        offset_lo = spec.byte_range[0] - spec.block_byte_range[0]
        offset_hi = spec.byte_range[1] - spec.block_byte_range[0]
        anchor["block"] = {
            "snapshotBlockId": sbi,
            "contentFingerprint": fp,
            "kind": spec.block_kind,
            "offsetInBlockBytes": [offset_lo, offset_hi],
            "blockByteRange": [spec.block_byte_range[0], spec.block_byte_range[1]],
            "blockLineRange": [spec.block_line_range[0], spec.block_line_range[1]],
        }
    if spec.prefix is not None or spec.suffix is not None:
        prefix = spec.prefix or ""
        suffix = spec.suffix or ""
        ctx: dict[str, Any] = {
            "prefix": prefix,
            "suffix": suffix,
            "prefixHash": sha256_hex(prefix.encode("utf-8")),
            "suffixHash": sha256_hex(suffix.encode("utf-8")),
        }
        if spec.previous_block_text is not None:
            ctx["previousBlockHash"] = sha256_hex(
                spec.previous_block_text.encode("utf-8")
            )
        if spec.next_block_text is not None:
            ctx["nextBlockHash"] = sha256_hex(spec.next_block_text.encode("utf-8"))
        anchor["context"] = ctx
    if spec.heading_path:
        anchor["structure"] = {
            "headingPath": [r.to_json() for r in spec.heading_path],
            "ordinalInParent": spec.ordinal_in_parent,
        }
    return anchor


def dump_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
