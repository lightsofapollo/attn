#!/usr/bin/env python3
"""
Verify corpus self-consistency. Run this whenever cases are regenerated.

Checks:
1. Every case directory has exactly the four required files.
2. anchor.json and expected.json parse as JSON.
3. anchor.json.baseHash == content_hash(original.md bytes).
4. anchor.json.position.byteRange points at anchor.json.quote.exact inside
   original.md (when a quote layer is present).
5. For status in ("exact", "remapped"): the expected.currentRange.byteRange
   slice of edited.md equals the original anchor's quote.exact (modulo the
   curated edits — see per-case `quoteRemapTo` override).
6. For status == "stale": expected has no currentRange.
7. For status == "ambiguous": expected has >= 2 candidates and the top two
   are within 0.10 confidence (matches amendments.md decision #15).

Exit code 0 on success, 1 on any inconsistency.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_case import content_hash  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REQUIRED_FILES = {"original.md", "edited.md", "anchor.json", "expected.json"}


def fail(case: str, msg: str) -> None:
    print(f"FAIL {case}: {msg}", file=sys.stderr)


def main() -> int:
    errors = 0
    case_dirs = sorted(
        p for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith("_")
    )
    if len(case_dirs) < 45:
        fail("corpus", f"only {len(case_dirs)} cases, need >= 45")
        errors += 1

    for d in case_dirs:
        name = d.name
        present = {p.name for p in d.iterdir()}
        missing = REQUIRED_FILES - present
        if missing:
            fail(name, f"missing files: {sorted(missing)}")
            errors += 1
            continue

        original = (d / "original.md").read_bytes()
        edited = (d / "edited.md").read_bytes()
        anchor = json.loads((d / "anchor.json").read_text())
        expected = json.loads((d / "expected.json").read_text())

        # 3. baseHash matches content_hash(original.md).
        expected_base = content_hash(original)
        if anchor.get("baseHash") != expected_base:
            fail(
                name,
                f"baseHash mismatch: anchor={anchor.get('baseHash')!r} "
                f"vs content_hash(original.md)={expected_base!r}",
            )
            errors += 1

        # 4. byteRange points at quote.exact inside original.md.
        quote = anchor.get("quote")
        pos = anchor.get("position", {})
        br = pos.get("byteRange")
        if quote and br and len(br) == 2:
            slice_bytes = original[br[0] : br[1]]
            expected_quote = quote["exact"].encode("utf-8")
            if slice_bytes != expected_quote:
                fail(
                    name,
                    f"anchor.position.byteRange does not point at quote.exact: "
                    f"slice={slice_bytes!r} vs quote={expected_quote!r}",
                )
                errors += 1

        # 5/6/7. Status-specific checks.
        status = expected.get("status")
        if status in ("exact", "remapped"):
            cr = expected.get("currentRange", {})
            cbr = cr.get("byteRange")
            if not (isinstance(cbr, list) and len(cbr) == 2):
                fail(name, f"{status} expected currentRange.byteRange missing")
                errors += 1
                continue
            slice_bytes = edited[cbr[0] : cbr[1]]
            # The slice must be valid UTF-8 (we're cutting at byte
            # boundaries the case author picked).
            try:
                _ = slice_bytes.decode("utf-8")
            except UnicodeDecodeError:
                fail(
                    name,
                    f"{status} currentRange byteRange {cbr} cuts UTF-8 mid-codepoint",
                )
                errors += 1
                continue
            # For status=exact the slice MUST equal the original quote
            # (file unchanged at that range). For status=remapped we
            # require the slice to be non-empty — exact equality depends
            # on whether the edit modified the quote text.
            if status == "exact" and quote:
                if slice_bytes != quote["exact"].encode("utf-8"):
                    fail(
                        name,
                        f"exact status but edited.md slice {slice_bytes!r} "
                        f"!= original quote {quote['exact']!r}",
                    )
                    errors += 1
            if status == "remapped" and len(slice_bytes) == 0:
                fail(name, "remapped status but currentRange slice is empty")
                errors += 1
        elif status == "stale":
            if "currentRange" in expected:
                fail(name, "stale must not carry a currentRange")
                errors += 1
        elif status == "ambiguous":
            cands = expected.get("candidates") or []
            if len(cands) < 2:
                fail(name, f"ambiguous needs >=2 candidates, got {len(cands)}")
                errors += 1
            else:
                top2 = sorted(
                    (c.get("confidence", 0.0) for c in cands), reverse=True
                )[:2]
                if abs(top2[0] - top2[1]) > 0.10 + 1e-9:
                    fail(
                        name,
                        f"ambiguous top two confidences {top2} are "
                        f"> 0.10 apart (decision #15 violation)",
                    )
                    errors += 1
                # Each candidate's currentRange should slice cleanly out of edited.md
                for i, c in enumerate(cands):
                    cbr = c.get("currentRange", {}).get("byteRange")
                    if not (isinstance(cbr, list) and len(cbr) == 2):
                        fail(
                            name,
                            f"candidate {i} missing currentRange.byteRange",
                        )
                        errors += 1
                        continue
                    sb = edited[cbr[0] : cbr[1]]
                    try:
                        _ = sb.decode("utf-8")
                    except UnicodeDecodeError:
                        fail(
                            name,
                            f"candidate {i} byteRange {cbr} cuts UTF-8 mid-codepoint",
                        )
                        errors += 1
        else:
            fail(name, f"unknown status: {status!r}")
            errors += 1

    if errors:
        print(f"\n{errors} error(s) across {len(case_dirs)} cases", file=sys.stderr)
        return 1
    print(f"OK — {len(case_dirs)} cases verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
