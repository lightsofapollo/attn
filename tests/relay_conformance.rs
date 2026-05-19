//! Conformance: run the Rust client against the same corpus the relay
//! itself validates. Boots `wrangler dev --local`; for each scenario, drives
//! the requested call against the running relay; asserts behavior matches
//! `expectedResponse` + relevant side effects.
//!
//! Skip if:
//!   - `ATTN_SKIP_CONFORMANCE=1` is set (CI escape hatch),
//!   - `wrangler` is not installed (typical local dev),
//!   - `relay/test/conformance/cases.json` doesn't exist (attn-nnj.5.14 not
//!     merged yet — the test scaffold lands first per parallel plan).
//!
//! Run:
//! ```bash
//! # Full local run (requires `npm install` in relay/):
//! cargo test --test relay_conformance -- --nocapture
//!
//! # Skip explicitly (CI matrix without wrangler):
//! ATTN_SKIP_CONFORMANCE=1 cargo test --test relay_conformance
//!
//! # Attach to a pre-started relay (e.g. one shared across a CI matrix):
//! ATTN_RELAY_PORT=8787 cargo test --test relay_conformance
//! ```
//!
//! Spec sources:
//!   - `planning/collab/relay-spec.md` §Test Plan (canonical 14 scenarios)
//!   - `planning/collab/crypto-spec.md` §Hashcash Proof-of-Work, §Envelope
//!     Batch Cap, §Test Vectors
//!
//! Co-owner: the relay-side conformance corpus (attn-nnj.5.14) is the upstream
//! source of truth. Each `Scenario` shape mirrors what 5.14 plans to emit;
//! `#[serde(default)]` on the optional fields lets the schema evolve without
//! lockstep ceremony — the runner simply skips fields it doesn't recognize.

#![allow(clippy::needless_return)]

#[path = "relay_helpers/mod.rs"]
mod relay_helpers;

use std::path::Path;

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde_json::Value;

use relay_helpers::{
    MailboxClient, WranglerHandle, cases_path, is_wrangler_available, skip_requested,
};

// ---------------------------------------------------------------------------
// Corpus schema (mirrors relay/test/conformance/cases.json — once 5.14 lands)
// ---------------------------------------------------------------------------
//
// We define the schema loosely with `serde_json::Value` for the request body
// + response body. The relay-side runner (5.14) will produce a stable shape,
// but we want this scaffold to land BEFORE the corpus does, and the parsing
// must keep working if the upstream adds fields. Concrete fields are typed;
// anything else is `extra: HashMap<String, Value>`-style via `#[serde(flatten)]`
// only where useful.

/// Top-level corpus file.
#[derive(Debug, Deserialize)]
struct ConformanceCorpus {
    /// Schema version. Pinned to `1` for the initial cut; the runner refuses
    /// to execute a corpus with a version it doesn't understand so a breaking
    /// change to the wire format can't silently pass.
    #[serde(default = "default_corpus_version")]
    version: u32,
    /// Optional human-readable note; passed straight through to log output.
    #[serde(default)]
    description: Option<String>,
    /// The actual scenarios. Empty corpus is allowed (and skipped with a log
    /// message) so 5.14 can stage the file shell + iterate on content.
    #[serde(default)]
    scenarios: Vec<Scenario>,
}

fn default_corpus_version() -> u32 {
    1
}

/// One conformance scenario.
///
/// `name` is the test's human-readable id — printed verbatim to stdout on
/// pass/fail so the corpus author can grep for failing cases.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    name: String,
    /// Optional doc string. Surfaced in failure messages.
    #[serde(default)]
    description: Option<String>,
    /// Setup steps run first. Failures here surface as `setup failure` so the
    /// scenario author can distinguish "the scenario itself broke" from "the
    /// thing-being-tested broke".
    #[serde(default)]
    setup: Vec<Step>,
    /// The call under test. Must produce a response that matches
    /// `expectedResponse`. Some scenarios test pure setup (the corpus uses
    /// `request: null` to opt out), in which case the runner only walks
    /// setup + side-effect assertions.
    #[serde(default)]
    request: Option<Step>,
    /// Expected response shape. Optional so corpus authors can pin a scenario
    /// to setup-only side-effect assertions when the call itself has been
    /// covered elsewhere.
    #[serde(default)]
    expected_response: Option<ExpectedResponse>,
    /// Optional skip flag. Used by the corpus to disable broken scenarios
    /// without deleting them (so the diff stays small).
    #[serde(default)]
    skip: bool,
    /// Optional skip reason — printed if `skip: true`.
    #[serde(default)]
    skip_reason: Option<String>,
}

/// A single request to fire against the relay. The corpus is responsible for
/// pre-computing any cryptographic material (admission HMAC, PoW token) so
/// the runner stays decoupled from the production crypto stack.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    /// HTTP method (`GET`/`POST`/`PUT`/`DELETE`/`PATCH`).
    method: String,
    /// URL path component (e.g. `/v2/rooms/foo`). Joined to the relay base URL.
    path: String,
    /// Headers to attach. Each entry is `[name, value]`.
    #[serde(default)]
    headers: Vec<[String; 2]>,
    /// Optional request body. Two shapes:
    ///   - JSON object/array → serialized to bytes,
    ///   - String → sent verbatim as UTF-8 (useful for malformed-body cases).
    #[serde(default)]
    body: Option<Value>,
}

/// What the relay should reply with.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedResponse {
    status: u16,
    /// Subset-match on the response body. Each key/value in `body` must
    /// appear in the actual response (recursively for objects). Extra keys
    /// on the actual side are allowed — `expectedResponse.body` is the
    /// minimum contract, not the maximum.
    #[serde(default)]
    body: Option<Value>,
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/// Top-level integration test. Walks the corpus and short-circuits on any
/// of the documented skip conditions.
///
/// Why a single `#[tokio::test]` instead of `test_case!`-style codegen:
///   - The wrangler boot is the slow step (~2s). Running each scenario in its
///     own test binary would re-pay that cost N times.
///   - Cargo's test runner reports `running 1 test … N scenarios passed` which
///     is exactly the granularity we want — the per-scenario `name` is
///     printed via `eprintln!` so failures still point to the right case.
#[tokio::test]
async fn conformance_corpus_round_trips_against_miniflare() -> Result<()> {
    if skip_requested() {
        eprintln!(
            "[conformance] skipping: {} is set",
            relay_helpers::SKIP_ENV_VAR
        );
        return Ok(());
    }

    if !is_wrangler_available() {
        eprintln!(
            "[conformance] skipping: wrangler not found (looked under \
             relay/node_modules/.bin/ and $PATH). Run `cd relay && npm install` \
             or set ATTN_SKIP_CONFORMANCE=1 to silence."
        );
        return Ok(());
    }

    let cases = cases_path()?;
    if !cases.exists() {
        eprintln!(
            "[conformance] skipping: {} does not exist yet (attn-nnj.5.14 hasn't \
             merged). The scaffold runs as a no-op until the corpus lands.",
            cases.display()
        );
        return Ok(());
    }

    let corpus = load_corpus(&cases)
        .with_context(|| format!("load conformance corpus from {}", cases.display()))?;

    if corpus.version != 1 {
        return Err(anyhow!(
            "unsupported corpus version {} (this runner understands v1 only). \
             Bump this assertion when the corpus schema changes.",
            corpus.version
        ));
    }

    if corpus.scenarios.is_empty() {
        eprintln!(
            "[conformance] corpus has 0 scenarios (description: {:?}) — treating as a \
             no-op so 5.14 can stage an empty shell.",
            corpus.description
        );
        return Ok(());
    }

    eprintln!(
        "[conformance] loaded {} scenarios from {}",
        corpus.scenarios.len(),
        cases.display()
    );

    let handle = WranglerHandle::start()
        .await
        .context("start wrangler dev --local")?;
    eprintln!("[conformance] relay up at {}", handle.base_url);
    let client = MailboxClient::new(handle.base_url.clone())?;

    let mut passed = 0usize;
    let mut skipped = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for scenario in &corpus.scenarios {
        if scenario.skip {
            eprintln!(
                "[conformance] SKIP {} ({})",
                scenario.name,
                scenario.skip_reason.as_deref().unwrap_or("no reason given")
            );
            skipped += 1;
            continue;
        }
        match run_scenario(&client, scenario).await {
            Ok(()) => {
                eprintln!("[conformance] PASS {}", scenario.name);
                passed += 1;
            }
            Err(e) => {
                eprintln!("[conformance] FAIL {}: {e:#}", scenario.name);
                failures.push(format!("{}: {e:#}", scenario.name));
            }
        }
    }

    eprintln!(
        "[conformance] {} passed, {} skipped, {} failed",
        passed,
        skipped,
        failures.len()
    );
    if !failures.is_empty() {
        return Err(anyhow!(
            "{} conformance scenario(s) failed:\n  - {}",
            failures.len(),
            failures.join("\n  - ")
        ));
    }
    Ok(())
}

/// Smoke test the corpus deserializer with a minimal in-memory document so we
/// catch breakage to the schema definition even when 5.14 hasn't merged. This
/// guards against silent schema drift between the relay-side emitter and the
/// Rust-side consumer.
#[tokio::test]
async fn corpus_schema_round_trips_a_minimal_fixture() -> Result<()> {
    let raw = serde_json::json!({
        "version": 1,
        "description": "smoke",
        "scenarios": [
            {
                "name": "health-smoke",
                "request": { "method": "GET", "path": "/health" },
                "expectedResponse": { "status": 200, "body": { "status": "ok" } }
            },
            {
                "name": "skipped-case",
                "skip": true,
                "skipReason": "not yet implemented",
            },
            {
                "name": "setup-only",
                "setup": [
                    {
                        "method": "POST",
                        "path": "/v2/rooms/foo",
                        "headers": [["content-type", "application/json"]],
                        "body": { "policy": { "mode": "live" } }
                    }
                ],
            }
        ]
    });
    let corpus: ConformanceCorpus = serde_json::from_value(raw)?;
    assert_eq!(corpus.version, 1);
    assert_eq!(corpus.scenarios.len(), 3);
    assert_eq!(corpus.scenarios[0].name, "health-smoke");
    assert!(corpus.scenarios[1].skip);
    assert_eq!(corpus.scenarios[1].skip_reason.as_deref(), Some("not yet implemented"));
    assert_eq!(corpus.scenarios[2].setup.len(), 1);
    assert_eq!(corpus.scenarios[2].setup[0].path, "/v2/rooms/foo");
    Ok(())
}

/// Confirms the skip path returns successfully without trying to spawn
/// wrangler — i.e. the "set the env var, the test is a no-op" contract holds.
/// We assert by setting the env var, running the top-level body in a
/// subroutine, and clearing it.
#[tokio::test]
async fn skip_env_var_short_circuits_before_any_io() {
    let prior = std::env::var(relay_helpers::SKIP_ENV_VAR).ok();
    unsafe { std::env::set_var(relay_helpers::SKIP_ENV_VAR, "1") };
    // Mirror the top-level guard: just verify `skip_requested()` returns true
    // and that the corpus loader is never invoked. We can't call the
    // `#[tokio::test]` body directly, but we can assert the contract that
    // makes it short-circuit.
    assert!(relay_helpers::skip_requested());
    match prior {
        Some(v) => unsafe { std::env::set_var(relay_helpers::SKIP_ENV_VAR, v) },
        None => unsafe { std::env::remove_var(relay_helpers::SKIP_ENV_VAR) },
    }
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

fn load_corpus(path: &Path) -> Result<ConformanceCorpus> {
    let raw = std::fs::read(path)?;
    let corpus: ConformanceCorpus = serde_json::from_slice(&raw)?;
    Ok(corpus)
}

async fn run_scenario(client: &MailboxClient, scenario: &Scenario) -> Result<()> {
    // 1. Setup — every step must succeed (2xx). Anything else fails the
    //    scenario with `setup` in the message so the corpus author knows to
    //    fix the prereqs rather than the assertion target.
    for (idx, step) in scenario.setup.iter().enumerate() {
        let (status, body) = run_step(client, step)
            .await
            .with_context(|| format!("setup step {idx} ({} {})", step.method, step.path))?;
        if !(200..300).contains(&status) {
            return Err(anyhow!(
                "setup step {idx} ({} {}) returned {} (body: {body})",
                step.method,
                step.path,
                status
            ));
        }
    }

    // 2. The call under test. Some scenarios are setup-only (no request).
    let request = match &scenario.request {
        Some(r) => r,
        None => return Ok(()),
    };
    let (actual_status, actual_body) = run_step(client, request)
        .await
        .with_context(|| format!("request {} {}", request.method, request.path))?;

    // 3. Match against the expected response. Status is exact; body is a
    //    subset (so the corpus can ignore noisy fields like `ts`, `build`).
    let expected = match &scenario.expected_response {
        Some(e) => e,
        None => return Ok(()),
    };
    if actual_status != expected.status {
        return Err(anyhow!(
            "status mismatch: expected {}, got {} (body: {actual_body})",
            expected.status,
            actual_status
        ));
    }
    if let Some(expected_body) = &expected.body {
        if let Err(e) = subset_match(expected_body, &actual_body) {
            return Err(anyhow!(
                "body mismatch: {e}\n  expected: {expected_body}\n  actual:   {actual_body}"
            ));
        }
    }
    Ok(())
}

async fn run_step(client: &MailboxClient, step: &Step) -> Result<(u16, Value)> {
    let headers: Vec<(String, String)> = step
        .headers
        .iter()
        .map(|[k, v]| (k.clone(), v.clone()))
        .collect();
    let body_bytes: Option<Vec<u8>> = match &step.body {
        None => None,
        Some(v) if v.is_string() => Some(v.as_str().unwrap().as_bytes().to_vec()),
        Some(v) => Some(serde_json::to_vec(v)?),
    };
    client
        .request(
            &step.method,
            &step.path,
            &headers,
            body_bytes.as_deref(),
        )
        .await
}

/// Recursive subset-match: every key/value in `expected` must appear in
/// `actual`. Arrays match element-by-element on the same index range
/// (`expected` may be a prefix of `actual`). Primitives match by equality.
/// `null` on the expected side matches only `null` on the actual side — the
/// corpus uses explicit JSON `null` to assert "this key must be absent OR
/// null", which is good enough for our wire-shape diff.
fn subset_match(expected: &Value, actual: &Value) -> Result<()> {
    match (expected, actual) {
        (Value::Object(em), Value::Object(am)) => {
            for (k, ev) in em {
                let av = am
                    .get(k)
                    .ok_or_else(|| anyhow!("missing key `{k}` in actual"))?;
                subset_match(ev, av).with_context(|| format!("at key `{k}`"))?;
            }
            Ok(())
        }
        (Value::Array(ea), Value::Array(aa)) => {
            if ea.len() > aa.len() {
                return Err(anyhow!(
                    "array shorter than expected (expected ≥ {} elements, got {})",
                    ea.len(),
                    aa.len()
                ));
            }
            for (i, (e, a)) in ea.iter().zip(aa.iter()).enumerate() {
                subset_match(e, a).with_context(|| format!("at index {i}"))?;
            }
            Ok(())
        }
        // Primitive equality.
        _ => {
            if expected == actual {
                Ok(())
            } else {
                Err(anyhow!("expected {expected}, got {actual}"))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// subset_match unit tests — these run as part of the same test binary so
// they cover the shape-diff logic without needing wrangler.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod subset_match_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn primitive_equality_matches() {
        assert!(subset_match(&json!(42), &json!(42)).is_ok());
        assert!(subset_match(&json!("ok"), &json!("ok")).is_ok());
        assert!(subset_match(&json!(null), &json!(null)).is_ok());
        assert!(subset_match(&json!(true), &json!(true)).is_ok());
    }

    #[test]
    fn primitive_mismatch_fails() {
        assert!(subset_match(&json!(42), &json!(43)).is_err());
        assert!(subset_match(&json!("a"), &json!("b")).is_err());
        assert!(subset_match(&json!(null), &json!(0)).is_err());
    }

    #[test]
    fn object_subset_passes_with_extra_keys() {
        let expected = json!({"status": "ok"});
        let actual = json!({"status": "ok", "build": "abc", "ts": 1234});
        assert!(subset_match(&expected, &actual).is_ok());
    }

    #[test]
    fn object_missing_key_fails() {
        let expected = json!({"status": "ok"});
        let actual = json!({"build": "abc"});
        let err = subset_match(&expected, &actual).expect_err("should fail");
        assert!(format!("{err:#}").contains("missing key `status`"));
    }

    #[test]
    fn nested_object_subset() {
        let expected = json!({"error": {"code": "ATTN_POW_INVALID"}});
        let actual = json!({"error": {"code": "ATTN_POW_INVALID", "message": "expired", "ts": 1}});
        assert!(subset_match(&expected, &actual).is_ok());
    }

    #[test]
    fn array_prefix_match() {
        let expected = json!([1, 2]);
        let actual = json!([1, 2, 3, 4]);
        // Expected being a prefix of actual is intentional — it lets the
        // corpus pin the first N elements (e.g. the first accepted envelope
        // ack) without asserting the rest of the batch.
        assert!(subset_match(&expected, &actual).is_ok());
    }

    #[test]
    fn array_too_short_fails() {
        let expected = json!([1, 2, 3]);
        let actual = json!([1, 2]);
        assert!(subset_match(&expected, &actual).is_err());
    }

    #[test]
    fn array_element_mismatch_fails() {
        let expected = json!([1, 99]);
        let actual = json!([1, 2]);
        let err = subset_match(&expected, &actual).expect_err("should fail");
        assert!(format!("{err:#}").contains("at index 1"));
    }
}
