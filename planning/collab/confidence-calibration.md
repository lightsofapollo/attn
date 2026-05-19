# Confidence calibration sweep (attn-nnj.3.7)

Calibration of the anchor-resolver weights and cutoffs introduced by the
v2 spec (`data-model.md` §Anchor Resolution, lines 491–505) and pinned as
"starting values, calibrate post-Phase 1" by `amendments.md` decision #15.

Method: replay the 53-case corpus from `attn-nnj.3.6`
(`planning/collab/test-vectors/anchor-cases/`) through `resolve_anchor`
with the shipped `ResolverConfig::DEFAULT` and with one-at-a-time
perturbations. Count cases whose returned `status` disagrees with
`expected.json::status` (the corpus's confidence numbers themselves are
allowed to drift per amendments #15; status is the contract).

The sweep itself is `src/review/anchors/calibration.rs::calibration_sweep`,
marked `#[ignore]`. Reproduce with:

```bash
cargo test calibration -- --ignored --nocapture
```

## 1. Corpus distribution

53 cases, distributed exactly as `anchor-cases/README.md` documents:

| status     | count |
|------------|-------|
| exact      |   5   |
| remapped   |  35   |
| ambiguous  |   7   |
| stale      |   6   |

## 2. Per-reason coverage

Counted per `expected.json::reason` (for `exact`/`remapped`/`stale`) and
per `expected.candidates[0].reason` (for `ambiguous`). Numbers from the
sweep, grouped by resolution step:

| step | reason                       | cases |
|------|------------------------------|-------|
|  1   | `base_hash_match`            |   5   |
|  3   | `quote_match` (non-amb)      |  19   |
|  3   | `quote_match` (ambiguous)    |   7   |
|  4   | `block_fingerprint_match`    |   5   |
|  5   | `structure_quote_match`      |   5   |
|  6   | `context_match`              |   3   |
|  7   | `fuzzy_quote_match`          |   3   |
|  8   | (line proximity, terminal)   |   0   |
| n/a  | `stale` (no candidate)       |   6   |

Total quote_match references (incl. ambiguous candidates) = 26, matching
the breakdown the corpus README gives.

## 3. Default-weights behavior

Running every case through `ResolverConfig::DEFAULT` (the shipped spec
weights: BASE_HASH=1.00, QUOTE_UNIQUE=0.90, BLOCK_FP=0.85,
STRUCTURE_QUOTE=0.80, CONTEXT=0.70, FUZZY_MAX=0.75, FUZZY_MIN=0.50,
LINE_PROX_MAX=0.35; locked cutoffs: ambiguous_delta=0.10,
ambiguous_include=0.50, high_confidence=0.70, stale_floor=0.35):

**14 of 53 cases disagree with `expected.json::status`** under the
shipped defaults. The disagreements fall into three clusters:

### Cluster A — corpus bug (4 cases): `ambiguous → exact`

| case | expected | got |
|------|----------|-----|
| 060-ambiguous-duplicate-paragraph        | ambiguous | exact |
| 061-ambiguous-list-item-duplicate-text   | ambiguous | exact |
| 065-ambiguous-table-cell-duplicate       | ambiguous | exact |
| 085-ambiguous-three-way-collision        | ambiguous | exact |

These four anchor.json files have `baseHash == sha256(edited.md)` (not
`sha256(original.md)`). With `original.md == edited.md` byte-for-byte,
step 1 (`base_hash_match`) always returns `exact` regardless of what the
resolver does downstream. Verified manually: e.g. for case 060,
`anchor.baseHash` is `gePQbS8YxrDxhE2k…` which equals
`sha256(edited.md)` exactly. Cannot be fixed by tuning — this is a 3.6
corpus build_all.py bug; report against `attn-nnj.3.6`.

### Cluster B — adjacent-step ambiguity (4 cases): `remapped → ambiguous`

| case | expected | got |
|------|----------|-----|
| 014-remap-list-item-reordered             | remapped | ambiguous |
| 018-remap-quote-survives-bullet-to-ordered | remapped | ambiguous |
| 082-remap-checkbox-state-toggled          | remapped | ambiguous |
| 083-remap-emphasis-added-around-quote     | remapped | ambiguous |

Diagnostic dump from the sweep (top candidates per case under DEFAULT):

```text
014: quote_match conf=0.9000 range=[34, 44]   "write docs"
     block_fp    conf=0.8500 range=[32, 44]   "- write docs"
018: quote_match conf=0.9000 range=[25, 33]   "two beta"
     block_fp    conf=0.8500 range=[22, 33]   "2. two beta"
082: quote_match conf=0.9000 range=[15, 39]   "write tests for resolver"
     block_fp    conf=0.8500 range=[9, 39]    "- [x] write tests for resolver"
083: quote_match conf=0.9000 range=[35, 47]   "foundational"
     block_fp    conf=0.8500 range=[7, 55]    "The phrase to remember is **foundational** here."
     context_match conf=0.7000 range=[33, 49] "**foundational**"
```

Both candidates are real (the quote fires at the inner range, the block
fingerprint fires at the surrounding list-item / paragraph range). The
gap `quote_unique (0.90) − block_fp (0.85) = 0.05` is strictly less than
`ambiguous_delta (0.10)` so the combine policy correctly flags
ambiguous. The expected.json says remapped — i.e., the corpus author
treats the wider-range block_fp candidate as a corroborating signal for
the same anchor, not a competing one.

### Cluster C — line-proximity floor collision (6 cases): `stale → remapped`

| case | expected | got |
|------|----------|-----|
| 070-stale-paragraph-deleted                       | stale | remapped |
| 071-stale-entire-section-removed                  | stale | remapped |
| 072-stale-quote-and-context-rewritten             | stale | remapped |
| 073-stale-heading-renamed-and-content-rewritten   | stale | remapped |
| 074-stale-list-item-removed                       | stale | remapped |
| 086-stale-blockquote-removed                      | stale | remapped |

Step 8 (`line_proximity_only`) always emits a candidate at
`LINE_PROX_MAX * clamp_ratio`. For these six cases the anchor's original
`lineRange` is still in-bounds of `edited.md`, so `clamp_ratio = 1.0`
and the candidate ships at exactly `0.35`. The combine policy then
checks `top.confidence >= stale_floor` — and `0.35 >= 0.35` is true, so
every "no signal" stale case is silently promoted to remapped with
`reason: fuzzy_quote_match` (the fallback wire name used by
LineProximityOnly). The result is technically defensible (the panel
"remapped" UI still shows the user a useful guess), but it disagrees
with the corpus's stale contract.

## 4. Cutoff stress test

Per amendments #15 the four cutoffs (`ambiguous_delta=0.10`,
`ambiguous_include=0.50`, `high_confidence=0.70`, `stale_floor=0.35`)
are **locked**. The matrix below is informational — it confirms the
recommendation does not depend on touching them, and quantifies what a
future amendment would cost if it did.

| knob              | from | to   | disagreements |
|-------------------|------|------|---------------|
| (baseline)        | —    | —    | 14 |
| ambiguous_delta   | 0.10 | 0.05 | 10 |
| ambiguous_delta   | 0.10 | 0.15 | 14 |
| high_confidence   | 0.70 | 0.85 | 14 |
| high_confidence   | 0.70 | 0.65 | 14 |
| stale_floor       | 0.35 | 0.50 |  8 |
| stale_floor       | 0.35 | 0.25 | 14 |
| ambiguous_include | 0.50 | 0.40 | 14 |
| ambiguous_include | 0.50 | 0.60 | 14 |

Per the task brief's mandated cutoff stresses (these are LOCKED and we
do not recommend changing them, but the brief asked for the numbers):

- **ambiguous_delta 0.10 → 0.05** flips 4 cases (cluster B becomes
  remapped — gap 0.05 is now > 0.05, so they stop being ambiguous), but
  it does NOT fix cluster A or C. Net change: −4. (Same 10
  disagreements would remain if the corpus bug were also fixed.)
- **Inline cutoff (high_confidence) 0.90 → 0.85**: not directly a
  resolver knob — the inline-vs-panel UI cutoff per spec is `0.85`
  inside the highlight renderer. Mapping it onto `high_confidence`
  (closest analog) and shifting 0.70 → 0.85 yields no net change (14)
  because all of cluster B's quote_match candidates remain ≥ 0.85.
- **Proximity floor (stale_floor) 0.35 → 0.50** flips 6 cases (cluster
  C becomes stale — `0.35 < 0.50`), net change: −6. But this is the
  *cutoff* being locked at 0.35; the same effect can be achieved by
  pulling `LINE_PROX_MAX` (a weight) below 0.35, which is **not**
  locked.

## 5. Weight stress test

Each weight perturbed ±0.05 from default, in isolation, against the
locked cutoffs. Disagreement count vs baseline (14):

| weight          | default | −0.05 | +0.05 |
|-----------------|---------|-------|-------|
| quote_unique    | 0.90    | 14    | 10    |
| block_fp        | 0.85    | 15    | 14    |
| structure_quote | 0.80    | 14    | 14    |
| context         | 0.70    | 14    | 19    |
| fuzzy_max       | 0.75    | 14    | 14    |
| fuzzy_min       | 0.50    | 14    | 14    |

Notes:

- `quote_unique + 0.05 = 0.95` widens the gap to `block_fp (0.85)` from
  0.05 to 0.10, which the floating-point gap (~0.10000000000000009)
  trips past `<= 0.10` and removes the cluster-B ambiguity. Net −4.
- `block_fp − 0.05 = 0.80` ties structure_quote at 0.80 and produces
  one new disagreement (case 021 flips remap-block_fp → ambiguous when
  structure_quote also fires at a different range).
- `context + 0.05 = 0.75` overlaps `fuzzy_max = 0.75`, producing 5 new
  ambiguous-band collisions among context/fuzzy cases (040-052 partly).

The line-proximity ceiling (`line_prox_max`) is not in the ±0.05 matrix
because it isn't a per-step weight in the same sense — it's a cap on a
calculated value. Tested separately below.

## 6. Recommendation

**Adjust line_prox_max from 0.35 to 0.30** (a weight, not a locked
cutoff) and leave every other shipped value as-is.

Rationale:

- This single weight change resolves all 6 cluster-C (stale →
  remapped) disagreements with no other side effects. Verified by full
  sweep:

  | config | disagreements |
  |--------|---------------|
  | default (shipped)                                  | 14 |
  | `line_prox_max = 0.30`                             |  8 |
  | `line_prox_max = 0.34`                             |  8 |
  | `block_fp = 0.79` (widens quote↔block gap, alone)  | 15 |
  | `line_prox_max = 0.30` + `block_fp = 0.79`         |  9 |
  | `line_prox_max=0.30`, `block_fp=0.79`, `struct=0.74`, `ctx=0.64` | 4 |

- The 4 remaining disagreements at `line_prox_max = 0.30` are all
  corpus bugs (cluster A — `original.md == edited.md` for cases 060,
  061, 065, 085). They cannot be fixed by any weight or cutoff change
  and are tracked separately.

- The 4 cluster-B (`remapped → ambiguous`) disagreements are NOT
  resolved by any per-weight ±0.05 perturbation that stays within
  amendments #15. The only weight perturbation that fixes them is
  `quote_unique + 0.05 → 0.95`, which exploits floating-point drift
  past `<= 0.10` rather than a real semantic gap. The cleaner fix is
  the "full recommendation" config in the sweep table (4 disagreements
  total), which cascades structure_quote and context down so each
  adjacent step is > 0.10 apart. **We deliberately do NOT recommend
  this** because:
  1. It rewrites three weights to chase 4 cases, where the underlying
     issue is the resolver's dedup policy (block_fp's outer range
     containing the quote_match's inner range is arguably a
     corroborating, not competing, signal).
  2. Per `data-model.md` §Anchor Resolution the published cascade is
     1.00 / 0.98 / 0.90 / 0.85 / 0.80 / 0.70. Compressing it changes
     the published UI semantics (confidence numbers shown to users)
     for marginal real-world gain on 4 quote-inside-listitem cases.
  3. A future cleaner fix is to teach `dedup_by_range_max` to also
     collapse candidates whose ranges fully contain one another, which
     is a code change (not weights) and outside this calibration scope.

- `LINE_PROX_MAX = 0.30` keeps line proximity strictly below the locked
  `stale_floor = 0.35`, restoring the spec's intent: line proximity is
  a soft signal that should never alone qualify as a remap. The spec
  text in `data-model.md` line 505 says `line proximity only: <=0.35`
  which is consistent (still ≤ 0.35); the change tightens the upper
  bound from "exactly the floor" to "strictly below the floor".

- Net effect on a 53-case corpus: 14 disagreements → 8 (only the
  remaining 4 corpus bugs + 4 cluster-B cases survive). The change
  affects only step 8's confidence ceiling; no published spec-cascade
  number moves.

## 7. Implementation steps

1. **resolve.rs** — change `conf::LINE_PROX_MAX` from `0.35` to `0.30`.
   Update the doc comment on the constant to note the change rationale
   ("strictly below stale_floor so line-proximity-only never short-
   circuits the stale path"). The `ResolverConfig::DEFAULT.line_prox_max`
   field will pick the new value automatically.

2. **resolve.rs** — update the comment block above the `conf` module
   (currently says "starting values, calibrate post-Phase 1") to point
   at this report and note that the calibration sweep has been run.

3. **data-model.md §Anchor Resolution** — change the line
   `line proximity only:          <=0.35` to `line proximity only:
   <=0.30 (was 0.35; see planning/collab/confidence-calibration.md)`.
   Locked cutoffs in amendments #15 are untouched.

4. **anchor-cases corpus (3.6 follow-on)** — file a follow-up bd issue
   against `attn-nnj.3.6` for the 4 corpus bugs (060, 061, 065, 085
   where `original.md == edited.md`). The `_tools/build_all.py` script
   needs to emit a distinct `edited.md` for ambiguous duplication
   cases. Until that lands the corpus_replay test in resolve.rs will
   continue to report 4 status mismatches on those cases (or skip them
   in the assertion — currently it only compares status, so they pass
   today by accident because of cluster A).

5. **resolve.rs (optional, follow-up)** — consider extending
   `dedup_by_range_max` to also collapse candidates whose ranges fully
   contain one another, keeping the higher-confidence (inner) one. This
   would fix cluster B (4 cases) without touching weights. Tracked as
   a separate concern, not part of this calibration recommendation.

6. **calibration sweep** — re-run after step 1 to confirm the new
   baseline disagreement count is 8 (4 corpus bugs + 4 cluster-B
   cases). Update this report's section-3 numbers in place.
