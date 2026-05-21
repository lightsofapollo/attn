//! Confidence-weight & cutoff calibration sweep over the 3.6 anchor corpus.
//!
//! Per `attn-nnj.3.7`: the resolver constants in `resolve.rs::conf` are
//! "ship as starting values, calibrate post-Phase 1" (amendments #15). This
//! file owns the *measurement* side: it replays the 53-case corpus at
//! `planning/collab/test-vectors/anchor-cases/` with perturbed
//! `ResolverConfig`s and counts how many cases disagree with `expected.json`.
//!
//! The sweep test is `#[ignore]`d — it does not run in the default
//! `cargo test` run (the corpus_replay test in `resolve.rs` is the gating
//! correctness check). To populate the calibration report, run:
//!
//! ```text
//! cargo test calibration -- --ignored --nocapture
//! ```
//!
//! The output is plain text, formatted as markdown tables, and is the
//! source of the numbers in `planning/collab/confidence-calibration.md`.
//!
//! This file MUST NOT mutate any shipped constant. All perturbations are
//! applied via `ResolverConfig` field overrides; the production resolver
//! continues to use `ResolverConfig::DEFAULT`.

#![cfg(test)]

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::review::anchors::index::build_anchor_index;
use crate::review::anchors::resolve::{ResolverConfig, resolve_anchor_with_config};
use crate::review::crypto::ids::content_hash;
use crate::review::ids::SnapshotId;
use crate::review::model::{Anchor, ResolvedAnchor};

// Perturbation table rows: a labelled config mutator plus the from/to values
// printed in the calibration report. Aliased to keep the table literals legible.
/// `(label, mutate(cfg), from, to)` — cutoff sweep rows.
type CutoffPerturbation = (&'static str, fn(&mut ResolverConfig), f64, f64);
/// `(label, mutate(cfg, delta), default)` — weight stress rows.
type WeightPerturbation = (&'static str, fn(&mut ResolverConfig, f64), f64);
/// `(label, mutate(cfg, delta))` — per-weight flip detail rows.
type WeightMutator = (&'static str, fn(&mut ResolverConfig, f64));

// ---------------------------------------------------------------------------
// Corpus loader (mirrors planning/collab/test-vectors/anchor-cases/ layout)
// ---------------------------------------------------------------------------

const CORPUS_DIR: &str = "planning/collab/test-vectors/anchor-cases";

#[derive(Debug, Clone)]
struct Case {
    name: String,
    anchor: Anchor,
    edited_bytes: Vec<u8>,
    snapshot_id: SnapshotId,
    expected_status: String,
    expected_reason: String,
}

fn snap_id(s: &str) -> SnapshotId {
    serde_json::from_value(Value::String(s.to_string())).expect("snap id")
}

fn load_corpus() -> Vec<Case> {
    let dir = Path::new(CORPUS_DIR);
    assert!(
        dir.exists(),
        "corpus not found at {} — calibration depends on 3.6",
        dir.display()
    );

    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("read anchor-cases")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && !p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.starts_with('_'))
                    .unwrap_or(true)
        })
        .collect();
    paths.sort();

    let mut cases = Vec::with_capacity(paths.len());
    for path in paths {
        let anchor_path = path.join("anchor.json");
        let edited_path = path.join("edited.md");
        let expected_path = path.join("expected.json");
        if !anchor_path.exists() || !edited_path.exists() || !expected_path.exists() {
            continue;
        }

        let anchor: Anchor =
            serde_json::from_slice(&std::fs::read(&anchor_path).expect("read anchor.json"))
                .expect("parse anchor.json");
        let edited_bytes = std::fs::read(&edited_path).expect("read edited.md");
        let expected: Value =
            serde_json::from_slice(&std::fs::read(&expected_path).expect("read expected.json"))
                .expect("parse expected.json");

        let expected_status = expected["status"]
            .as_str()
            .expect("expected.status is string")
            .to_string();
        // For ambiguous cases the top-level "reason" is a free-form string;
        // the per-step reason lives in candidates[0].reason. For others the
        // top-level reason is the wire reason.
        let expected_reason = if expected_status == "ambiguous" {
            expected["candidates"][0]["reason"]
                .as_str()
                .unwrap_or("ambiguous")
                .to_string()
        } else if expected_status == "stale" {
            "stale".to_string()
        } else {
            expected["reason"].as_str().unwrap_or("?").to_string()
        };

        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("?")
            .to_string();
        let snap = snap_id(&format!("snapshot-{}", &name[..3]));

        cases.push(Case {
            name,
            anchor,
            edited_bytes,
            snapshot_id: snap,
            expected_status,
            expected_reason,
        });
    }

    cases
}

// ---------------------------------------------------------------------------
// Disagreement counter
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct SweepResult {
    total: usize,
    status_mismatches: usize,
    /// Status mismatches grouped by (expected_status, got_status).
    transitions: Vec<(String, String, String)>, // (case_name, expected_status, got_status)
}

fn resolve_status_of(got: &ResolvedAnchor) -> &'static str {
    match got {
        ResolvedAnchor::Exact { .. } => "exact",
        ResolvedAnchor::Remapped { .. } => "remapped",
        ResolvedAnchor::Ambiguous { .. } => "ambiguous",
        ResolvedAnchor::Stale { .. } => "stale",
    }
}

fn run_sweep(cases: &[Case], cfg: &ResolverConfig) -> SweepResult {
    let mut out = SweepResult::default();
    for case in cases {
        let idx = build_anchor_index(&case.edited_bytes, &case.snapshot_id)
            .expect("build_anchor_index over edited.md");
        let h = content_hash(&case.edited_bytes);
        let got = resolve_anchor_with_config(&case.anchor, &idx, &case.edited_bytes, &h, None, cfg)
            .expect("resolve_anchor_with_config");
        let got_status = resolve_status_of(&got);
        out.total += 1;
        if got_status != case.expected_status {
            out.status_mismatches += 1;
            out.transitions.push((
                case.name.clone(),
                case.expected_status.clone(),
                got_status.to_string(),
            ));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Default-weights baseline + reason-coverage table
// ---------------------------------------------------------------------------

fn print_baseline_and_coverage(cases: &[Case]) {
    let cfg = ResolverConfig::DEFAULT;
    let baseline = run_sweep(cases, &cfg);
    println!("## Baseline (ResolverConfig::DEFAULT)");
    println!("total cases:          {}", baseline.total);
    println!("status disagreements: {}", baseline.status_mismatches);
    if !baseline.transitions.is_empty() {
        println!();
        println!("### Status transitions (expected -> got)");
        for (name, exp, got) in &baseline.transitions {
            println!("- {name}: {exp} -> {got}");
        }
    }
    println!();

    println!("## Expected reason coverage (per-step)");
    let mut by_reason: std::collections::BTreeMap<String, usize> = Default::default();
    for c in cases {
        *by_reason.entry(c.expected_reason.clone()).or_insert(0) += 1;
    }
    for (r, n) in &by_reason {
        println!("- {r}: {n}");
    }
    println!();
}

// ---------------------------------------------------------------------------
// Cutoff stress matrix
// ---------------------------------------------------------------------------

fn print_cutoff_stress(cases: &[Case]) {
    println!("## Cutoff stress test");
    println!();
    println!("| knob | from | to | disagreements |");
    println!("|------|------|-----|---------------|");

    let baseline_d = run_sweep(cases, &ResolverConfig::DEFAULT).status_mismatches;
    println!("| (baseline) | n/a | n/a | {} |", baseline_d);

    let perturbations: &[CutoffPerturbation] = &[
        ("ambiguous_delta", |c| c.ambiguous_delta = 0.05, 0.10, 0.05),
        ("ambiguous_delta", |c| c.ambiguous_delta = 0.15, 0.10, 0.15),
        // Inline cutoff = HIGH_CONFIDENCE (boundary between remapped and stale).
        ("high_confidence", |c| c.high_confidence = 0.85, 0.70, 0.85),
        ("high_confidence", |c| c.high_confidence = 0.65, 0.70, 0.65),
        // Proximity / stale floor.
        ("stale_floor", |c| c.stale_floor = 0.50, 0.35, 0.50),
        ("stale_floor", |c| c.stale_floor = 0.25, 0.35, 0.25),
        // Ambiguous inclusion threshold.
        (
            "ambiguous_include",
            |c| c.ambiguous_include = 0.40,
            0.50,
            0.40,
        ),
        (
            "ambiguous_include",
            |c| c.ambiguous_include = 0.60,
            0.50,
            0.60,
        ),
    ];

    for (name, mutate, from, to) in perturbations {
        let mut cfg = ResolverConfig::DEFAULT;
        mutate(&mut cfg);
        let r = run_sweep(cases, &cfg);
        println!("| {name} | {from} | {to} | {} |", r.status_mismatches);
    }
    println!();

    // Detailed flip listing for the spec-mandated knobs only.
    println!("### Detail: ambiguous_delta 0.10 -> 0.05");
    {
        let mut cfg = ResolverConfig::DEFAULT;
        cfg.ambiguous_delta = 0.05;
        let r = run_sweep(cases, &cfg);
        for (n, e, g) in &r.transitions {
            println!("- {n}: {e} -> {g}");
        }
        if r.transitions.is_empty() {
            println!("- (none)");
        }
    }
    println!();

    println!("### Detail: high_confidence (inline cutoff) 0.70 -> 0.85");
    {
        let mut cfg = ResolverConfig::DEFAULT;
        cfg.high_confidence = 0.85;
        let r = run_sweep(cases, &cfg);
        for (n, e, g) in &r.transitions {
            println!("- {n}: {e} -> {g}");
        }
        if r.transitions.is_empty() {
            println!("- (none)");
        }
    }
    println!();

    println!("### Detail: stale_floor (proximity floor) 0.35 -> 0.50");
    {
        let mut cfg = ResolverConfig::DEFAULT;
        cfg.stale_floor = 0.50;
        let r = run_sweep(cases, &cfg);
        for (n, e, g) in &r.transitions {
            println!("- {n}: {e} -> {g}");
        }
        if r.transitions.is_empty() {
            println!("- (none)");
        }
    }
    println!();
}

// ---------------------------------------------------------------------------
// Per-weight stress matrix (each weight perturbed ±0.05)
// ---------------------------------------------------------------------------

fn print_weight_stress(cases: &[Case]) {
    println!("## Weight stress test (per-step, +/- 0.05)");
    println!();
    println!("| weight | default | -0.05 | +0.05 |");
    println!("|--------|---------|-------|-------|");

    let perturbations: &[WeightPerturbation] = &[
        (
            "quote_unique",
            |c, d| c.quote_unique = (c.quote_unique + d).clamp(0.0, 1.0),
            0.90,
        ),
        (
            "block_fp",
            |c, d| c.block_fp = (c.block_fp + d).clamp(0.0, 1.0),
            0.85,
        ),
        (
            "structure_quote",
            |c, d| c.structure_quote = (c.structure_quote + d).clamp(0.0, 1.0),
            0.80,
        ),
        (
            "context",
            |c, d| c.context = (c.context + d).clamp(0.0, 1.0),
            0.70,
        ),
        (
            "fuzzy_max",
            |c, d| c.fuzzy_max = (c.fuzzy_max + d).clamp(c.fuzzy_min, 1.0),
            0.75,
        ),
        (
            "fuzzy_min",
            |c, d| c.fuzzy_min = (c.fuzzy_min + d).clamp(0.0, c.fuzzy_max),
            0.50,
        ),
    ];

    for (name, mutate, default) in perturbations {
        let mut down = ResolverConfig::DEFAULT;
        mutate(&mut down, -0.05);
        let down_r = run_sweep(cases, &down).status_mismatches;

        let mut up = ResolverConfig::DEFAULT;
        mutate(&mut up, 0.05);
        let up_r = run_sweep(cases, &up).status_mismatches;

        println!("| {name} | {default} | {down_r} | {up_r} |");
    }
    println!();

    // Detail dump for any weight whose perturbation flipped a case.
    println!("### Detail: per-weight flips (only listed if non-zero)");
    let detail: &[WeightMutator] = &[
        ("quote_unique", |c, d| c.quote_unique += d),
        ("block_fp", |c, d| c.block_fp += d),
        ("structure_quote", |c, d| c.structure_quote += d),
        ("context", |c, d| c.context += d),
        ("fuzzy_max", |c, d| c.fuzzy_max += d),
        ("fuzzy_min", |c, d| c.fuzzy_min += d),
    ];
    for (name, mutate) in detail {
        for delta in &[-0.05f64, 0.05] {
            let mut cfg = ResolverConfig::DEFAULT;
            mutate(&mut cfg, *delta);
            let r = run_sweep(cases, &cfg);
            if r.transitions.is_empty() {
                continue;
            }
            println!("- {name} delta {:+.2}:", delta);
            for (n, e, g) in &r.transitions {
                println!("  - {n}: {e} -> {g}");
            }
        }
    }
    println!();
}

// ---------------------------------------------------------------------------
// Per-case ambiguous diagnostic — print all candidates for the 4 cases that
// flip remapped→ambiguous under DEFAULT, so the report can name the second
// candidate that's tripping ambiguity.
// ---------------------------------------------------------------------------

fn print_ambiguous_diagnostic(cases: &[Case]) {
    println!("## Ambiguous diagnostic (remapped→ambiguous flips)");
    println!();
    let names = ["014", "018", "082", "083"];
    let cfg = ResolverConfig::DEFAULT;
    for prefix in names {
        let Some(case) = cases.iter().find(|c| c.name.starts_with(prefix)) else {
            continue;
        };
        let idx = build_anchor_index(&case.edited_bytes, &case.snapshot_id).unwrap();
        let h = content_hash(&case.edited_bytes);
        let got =
            resolve_anchor_with_config(&case.anchor, &idx, &case.edited_bytes, &h, None, &cfg)
                .unwrap();
        println!("### {}", case.name);
        match got {
            ResolvedAnchor::Ambiguous { candidates, reason } => {
                println!("- ambiguous ({})", reason);
                for c in &candidates {
                    println!(
                        "  - {} conf={:.4} range={:?} preview={:?}",
                        c.reason, c.confidence, c.current_range.byte_range, c.preview
                    );
                }
            }
            other => println!("- (got {other:?})"),
        }
        println!();
    }
}

// ---------------------------------------------------------------------------
// Candidate adjustments tested as full configs (for the recommendation)
// ---------------------------------------------------------------------------

fn print_candidate_adjustments(cases: &[Case]) {
    println!("## Candidate adjustments (full configs)");
    println!();
    println!("| label | disagreements |");
    println!("|-------|---------------|");

    let configs: Vec<(&str, ResolverConfig)> = vec![
        ("default (spec weights)", ResolverConfig::DEFAULT),
        // line_prox_max strictly < stale_floor so the line-proximity-only
        // step never accidentally promotes a stale case to remapped.
        ("line_prox_max=0.30", {
            let mut c = ResolverConfig::DEFAULT;
            c.line_prox_max = 0.30;
            c
        }),
        ("line_prox_max=0.34", {
            let mut c = ResolverConfig::DEFAULT;
            c.line_prox_max = 0.34;
            c
        }),
        // Widen the quote/block gap so adjacent-step ambiguity disappears.
        ("structure_quote=0.78, context=0.68", {
            let mut c = ResolverConfig::DEFAULT;
            c.structure_quote = 0.78;
            c.context = 0.68;
            c
        }),
        // Combine both fixes — should drive disagreements down to the corpus-bug floor (4).
        ("line_prox_max=0.30 + structure/context spread", {
            let mut c = ResolverConfig::DEFAULT;
            c.line_prox_max = 0.30;
            c.structure_quote = 0.78;
            c.context = 0.68;
            c
        }),
        // Widen quote↔block_fp gap past the 0.10 ambiguous_delta.
        ("block_fp=0.79", {
            let mut c = ResolverConfig::DEFAULT;
            c.block_fp = 0.79;
            c
        }),
        ("line_prox_max=0.30 + block_fp=0.79", {
            let mut c = ResolverConfig::DEFAULT;
            c.line_prox_max = 0.30;
            c.block_fp = 0.79;
            c
        }),
        // Floor proposal: line_prox_max=0.30 + block_fp=0.79 + cascade
        // structure_quote/context down so the rest of the cascade
        // preserves >0.10 gaps everywhere.
        (
            "full recommendation (line_prox=0.30, block_fp=0.79, struct=0.74, ctx=0.64)",
            {
                let mut c = ResolverConfig::DEFAULT;
                c.line_prox_max = 0.30;
                c.block_fp = 0.79;
                c.structure_quote = 0.74;
                c.context = 0.64;
                c
            },
        ),
    ];

    for (label, cfg) in &configs {
        let r = run_sweep(cases, cfg);
        println!("| {label} | {} |", r.status_mismatches);
    }
    println!();

    println!("### Detail: line_prox_max=0.30");
    let mut cfg = ResolverConfig::DEFAULT;
    cfg.line_prox_max = 0.30;
    let r = run_sweep(cases, &cfg);
    for (n, e, g) in &r.transitions {
        println!("- {n}: {e} -> {g}");
    }
    println!();

    println!("### Detail: line_prox_max=0.30 + structure_quote=0.78 + context=0.68");
    let mut cfg = ResolverConfig::DEFAULT;
    cfg.line_prox_max = 0.30;
    cfg.structure_quote = 0.78;
    cfg.context = 0.68;
    let r = run_sweep(cases, &cfg);
    for (n, e, g) in &r.transitions {
        println!("- {n}: {e} -> {g}");
    }
    println!();
}

// ---------------------------------------------------------------------------
// The ignored sweep test (entry point for the report)
// ---------------------------------------------------------------------------

#[test]
#[ignore]
fn calibration_sweep() {
    let cases = load_corpus();
    println!("# Calibration sweep — {} cases loaded\n", cases.len());

    let mut by_status: std::collections::BTreeMap<String, usize> = Default::default();
    for c in &cases {
        *by_status.entry(c.expected_status.clone()).or_insert(0) += 1;
    }
    println!("## Corpus distribution");
    for (s, n) in &by_status {
        println!("- {s}: {n}");
    }
    println!();

    print_baseline_and_coverage(&cases);
    print_cutoff_stress(&cases);
    print_weight_stress(&cases);
    print_ambiguous_diagnostic(&cases);
    print_candidate_adjustments(&cases);

    println!("# End calibration sweep");
}

// ---------------------------------------------------------------------------
// Smoke test (cheap, runs in default cargo test, verifies the loader)
// ---------------------------------------------------------------------------

#[test]
fn calibration_loader_smoke() {
    let cases = load_corpus();
    assert!(
        cases.len() >= 45,
        "corpus must have ≥ 45 cases (got {}) per attn-nnj.3.6",
        cases.len()
    );
    // Distribution sanity per the README.
    let exacts = cases
        .iter()
        .filter(|c| c.expected_status == "exact")
        .count();
    let stales = cases
        .iter()
        .filter(|c| c.expected_status == "stale")
        .count();
    assert!(exacts >= 4, "expected ≥4 exact cases, got {exacts}");
    assert!(stales >= 5, "expected ≥5 stale cases, got {stales}");
}
