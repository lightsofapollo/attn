# anchor-cases/

Cross-implementation test corpus for the anchor resolver.

This corpus is the **canonical contract** every implementation of the anchor
resolver (Rust `src/review/anchors/` per `attn-nnj.3.4`, TS
`web/src/lib/review/anchors/` per `attn-nnj.3.5`) must satisfy. The same
markdown pair + anchor descriptor must produce the same `ResolvedAnchor`
out of every resolver — that is how we know the two languages cannot drift
in production where one client comments and the other receives.

Spec sources of truth:

- `planning/collab/data-model.md` §Anchor Index, §Anchors, §Anchor
  Resolution (the four `ResolvedAnchor` states, confidence weights).
- `planning/collab/amendments.md` decision #15 (the **locked** resolution
  policy: run all steps, dedupe by `currentRange`, ≥ 0.70 single =
  `remapped`, two within 0.10 = `ambiguous`, ≥ 0.35 = `remapped` low,
  else `stale`).
- `src/review/anchors/index.rs` (the `AnchorIndex` builder shipped by
  `attn-nnj.3.1`; the corpus's hashes were generated to match its
  fingerprint composition exactly).

## Layout

```text
anchor-cases/
  README.md                       (this file)
  _tools/
    build_case.py                 (low-level hash + AnchorSpec helpers)
    build_all.py                  (single source of truth for all cases)
    verify_cases.py               (self-consistency checker)
  NNN-short-slug/
    original.md                   markdown the anchor was authored against
    edited.md                     the same content after edits
    anchor.json                   full Anchor (per data-model.md §Anchors)
    expected.json                 expected ResolvedAnchor against edited.md
```

`NNN` is a zero-padded three-digit number whose hundreds digit groups by
primary outcome:

| Range   | Outcome                       | Count |
| ------- | ----------------------------- | ----- |
| 001-008 | `exact` (and trivial remap)   | 8     |
| 010-019 | `remapped`, `quote_match`     | 10    |
| 020-024 | `remapped`, `block_fp_match`  | 5     |
| 030-034 | `remapped`, `structure_quote` | 5     |
| 040-042 | `remapped`, `context_match`   | 3     |
| 050-052 | `remapped`, `fuzzy_quote`     | 3     |
| 060-065 | `ambiguous`                   | 6     |
| 070-074 | `stale`                       | 5     |
| 080-087 | edge cases (front-matter, unicode, links, three-way ambiguous, etc.) | 8 |

Total: 53 cases (≥ 45 per `attn-nnj.3.6` acceptance).

The `block_fingerprint_match`, `structure_quote_match`, `context_match`,
and `fuzzy_quote_match` reasons are tagged on the **lowest** confidence
step a resolver might fall back to for that case. In practice the locked
policy runs all steps, so a resolver MAY return a higher-confidence reason
like `quote_match` (0.90) instead — that is acceptable as long as
`status`, `currentRange`, and confidence ≥ the expected floor.

Mapped-through-local-steps (`mapped_through_local_steps`, confidence
0.98) is **not** covered here. Local pmStep JSON wire format is not yet
specified (see `attn-nnj.3.x` follow-on); add cases under `090-` once it
lands.

## anchor.json shape

A full `Anchor` per `data-model.md` §Anchors:

```json
{
  "v": 2,
  "fileId": "file-corpus-fixture",
  "snapshotId": "snapshot-NNN",
  "baseHash": "<base64url-no-pad SHA-256 of original.md bytes>",
  "position": { "byteRange": [lo, hi], "lineRange": [l1, l2] },
  "quote":     { "exact", "exactHash", "normalized", "normalizedHash" },
  "block":     { "snapshotBlockId", "contentFingerprint", "kind",
                 "offsetInBlockBytes", "blockByteRange", "blockLineRange" },
  "context":   { "prefix", "suffix", "prefixHash", "suffixHash",
                 "previousBlockHash?", "nextBlockHash?" },
  "structure": { "headingPath": [...], "ordinalInParent" }
}
```

All cases populate every layer (`position`, `quote`, `block`, `context`,
`structure`) — the resolver should fall back to weaker layers on its own.
If you need to test "block-level comment with no quote", omit the `quote`
field in the generated anchor.json (no current case exercises this — add
under `088-` if needed).

## expected.json shape

Matches the `ResolvedAnchor` union from `data-model.md` §Anchor Resolution,
with `status` as the discriminant:

```json
{ "status": "exact",      "confidence": 1.0,
  "currentRange": {...},  "reason": "base_hash_match" }

{ "status": "remapped",   "confidence": 0.70 .. 0.98,
  "currentRange": {...},  "reason": "quote_match" | ... }

{ "status": "ambiguous",  "reason": "...",
  "candidates": [ { "confidence", "currentRange", "reason", "preview" }, ... ] }

{ "status": "stale",      "reason": "..." }
```

Confidence values come from the locked weights in `data-model.md` §Anchor
Resolution:

| Reason                     | Confidence  |
| -------------------------- | ----------- |
| `base_hash_match`          | 1.00        |
| `mapped_through_local_steps` | 0.98      |
| `quote_match`              | 0.90        |
| `block_fingerprint_match`  | 0.85        |
| `structure_quote_match`    | 0.80        |
| `context_match`            | 0.70        |
| `fuzzy_quote_match`        | 0.50 – 0.75 |
| (line proximity only)      | ≤ 0.35      |

Per decision #15, **ambiguous** cases require the top two candidates to be
within 0.10 of each other — `verify_cases.py` enforces this.

## Generating / regenerating

The corpus is hand-curated by editing
`_tools/build_all.py`. **Do not edit
the per-case JSON or markdown files directly** — `build_all.py` overwrites
them on every run.

```bash
# Regenerate every case directory:
python3 planning/collab/test-vectors/anchor-cases/_tools/build_all.py

# Verify self-consistency (baseHash, byteRange spans, ambiguous policy):
python3 planning/collab/test-vectors/anchor-cases/_tools/verify_cases.py

# JSON parse check (CI-friendly):
for f in planning/collab/test-vectors/anchor-cases/*/*.json; do jq empty "$f"; done
```

`build_case.py` mirrors the subset of `src/review/anchors/index.rs` needed
to fill in deterministic hash fields:

- `content_hash(bytes)` → base64url-no-pad SHA-256 (matches
  `crypto/ids.rs::content_hash`).
- `normalize_text(s)` → lowercase + collapse whitespace + strip ASCII
  punctuation (matches `index.rs::normalize_text`).
- `content_fingerprint(kind, normText, path, dupOrdinal)` and
  `snapshot_block_id(snapshotId, byteRange, fp)` → mirror the
  `\x1f`-delimited byte composition used in `index.rs`.

If the Rust builder's normalisation rule changes, update
`build_case.py::normalize_text` to match and re-run `build_all.py`. The
Python and Rust outputs MUST agree byte-for-byte on the hash fields.

> Why a Python helper instead of a Rust binary? Per `attn-nnj.3.6`:
> "Don't generate anchor.json from a real resolver run yet — hand-curate
> so the corpus drives the resolver, not the other way around." Python
> computes the deterministic hashes without depending on the resolver
> being correct.

## How the resolver consumes the corpus

The Rust and TS resolvers each own their own replay test; this directory
holds only the data. Sketch (Rust):

```rust
const CORPUS_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/planning/collab/test-vectors/anchor-cases",
);

#[test]
fn anchor_corpus_replay() {
    for entry in std::fs::read_dir(CORPUS_DIR).unwrap() {
        let case = entry.unwrap().path();
        if case.file_name().unwrap().to_string_lossy().starts_with('_') { continue; }
        if !case.is_dir() { continue; }

        let original = std::fs::read(case.join("original.md")).unwrap();
        let edited   = std::fs::read(case.join("edited.md")).unwrap();
        let anchor: Anchor = serde_json::from_slice(
            &std::fs::read(case.join("anchor.json")).unwrap()
        ).unwrap();
        let expected: ResolvedAnchor = serde_json::from_slice(
            &std::fs::read(case.join("expected.json")).unwrap()
        ).unwrap();

        let got = resolve_anchor(&anchor, &original, &edited);
        assert_eq!(got.status_tag(), expected.status_tag(),
                   "case {}: status mismatch", case.display());
        // Looser equality on confidence: within 0.05.
        // Stricter equality on currentRange.byteRange.
        // For `ambiguous`, sort candidates by currentRange before comparing.
        assert_anchor_match(case.display(), got, expected);
    }
}
```

TS mirror under `web/src/lib/review/anchors/__tests__/` reads the same
files via `import.meta.url`-based path resolution (vitest can do this
without a bundler).

Resolvers SHOULD treat expected confidence values as a floor:

- For `exact` / `remapped`, the resolver may produce a HIGHER confidence
  reason (e.g., the corpus tags `context_match` but the resolver finds an
  exact quote match) — that is acceptable.
- For `ambiguous`, the resolver must return >= 2 candidates with the top
  two within 0.10 (per decision #15). The exact set of candidates is
  resolver-defined; the test asserts the policy invariant, not the
  precise list.
- For `stale`, the resolver must return `status: "stale"` (no
  `currentRange` allowed).

## Contribution guide

Add a new case when:

- A real-world markdown edit pattern surfaces during dogfooding that
  isn't represented (e.g., a CRDT-induced split-merge sequence).
- A resolver bug is fixed — add a regression case that would have caught
  it. Naming convention: `NNN-regression-<short-bug-id>`.
- A new resolution reason or step is added to `data-model.md` §Anchor
  Resolution.

Steps:

1. Add a `Case(...)` entry to `build_all.py` in the appropriate number
   range. Pick the next free `NNN` — gaps inside a band are fine.
2. Run `python3 _tools/build_all.py` to regenerate files.
3. Run `python3 _tools/verify_cases.py` to confirm self-consistency.
4. Run the Rust corpus replay test (lands in `attn-nnj.3.4`); update
   its tolerances if you intentionally broaden a contract.
5. Update the count table in this README.

Do NOT add cases that are mere permutations of an existing input — the
corpus is a contract, not a fuzzing harness. Hand-curate edits that
isolate one resolver decision per case.

## Version

- Schema v2 (matches `Anchor.v: 2` in `data-model.md`).
- Last regenerated against `build_case.py` mirroring `index.rs` as of
  the merge of `attn-nnj.3.1` (AnchorIndex builder).
