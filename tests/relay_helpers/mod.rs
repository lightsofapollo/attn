//! Helpers for the relay conformance integration test (attn-nnj.6.7).
//!
//! Spec: `planning/collab/relay-spec.md` §Test Plan (the canonical scenario
//! list the conformance corpus implements).
//!
//! Why a sub-module under `tests/`:
//!   - The integration test (`tests/relay_conformance.rs`) is the only consumer
//!     of these helpers — keeping them next door avoids the "fake crate" trick
//!     where you'd otherwise need to make every helper `pub(crate)` on the
//!     binary side just for tests.
//!   - Cargo discovers `tests/relay_helpers/mod.rs` as a sibling module of the
//!     test crate via `#[path = "relay_helpers/mod.rs"]` in the test file. This
//!     is the same trick the rust-lang/cargo book recommends for shared
//!     integration-test utilities (see "Tests" → "Submodules in Integration
//!     Tests").
//!
//! Surface:
//!   - `is_wrangler_available()` — does the host have a usable wrangler?
//!   - `WranglerHandle::start()` — spawn `wrangler dev --local` from `relay/`
//!     on a random free port; killed on `Drop` so a panicking test never
//!     leaks the child.
//!   - `wait_for_health(port)` — poll `GET /health` until 200 or timeout.
//!   - `MailboxClient` — thin reqwest wrapper bound to a `(host, port)`. The
//!     conformance scenarios drive it via HTTP; deeper wiring (admission HMAC,
//!     PoW) is the corpus's responsibility — the helper exposes raw
//!     request/response semantics so the test stays decoupled from the
//!     production crypto stack (which lives in the `attn` binary crate and
//!     is not reachable from a `tests/` integration test).

#![allow(dead_code)]

use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use reqwest::Client;
use serde_json::Value;

/// Environment variable callers set to bypass the test entirely. CI uses this
/// when wrangler is unavailable (the action is gated separately) so the suite
/// stays green on hosts without Node installed.
pub const SKIP_ENV_VAR: &str = "ATTN_SKIP_CONFORMANCE";

/// Optional override telling the test "I already have a relay running, point
/// at this port instead of spawning wrangler". Set by CI to attach the test
/// to a pre-baked Miniflare instance shared across the matrix.
pub const PRE_STARTED_PORT_ENV_VAR: &str = "ATTN_RELAY_PORT";

/// Optional override for the relay host. Defaults to `127.0.0.1`. The Rust
/// transport defaults to `http://127.0.0.1` in dev — keeping the helper's
/// default in lock-step avoids a footgun where a stray IPv6 binding makes
/// the test hang on `connect`.
pub const HOST_ENV_VAR: &str = "ATTN_RELAY_HOST";

/// Maximum wait for `GET /health` to return 200 after launching wrangler.
/// Miniflare boot on a cold machine is typically <2s; 30s is a generous
/// ceiling that still trips a CI alarm if something is genuinely wedged.
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Poll interval while waiting for /health.
pub const HEALTH_POLL: Duration = Duration::from_millis(250);

/// Return `true` if the caller asked us to skip via `ATTN_SKIP_CONFORMANCE=1`.
/// Treats any truthy value (`1`, `true`, `yes`) the same way so a Makefile
/// `export ATTN_SKIP_CONFORMANCE=true` works as expected.
pub fn skip_requested() -> bool {
    matches!(
        env::var(SKIP_ENV_VAR).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

/// Locate the relay directory (`<repo>/relay`). Tests run from the workspace
/// root by default, but we walk up from `CARGO_MANIFEST_DIR` to be safe in
/// case the harness ever shells out from a sub-crate.
pub fn relay_dir() -> Result<PathBuf> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .context("CARGO_MANIFEST_DIR not set (only available under `cargo test`)")?;
    let candidate = Path::new(&manifest_dir).join("relay");
    if candidate.is_dir() {
        return Ok(candidate);
    }
    Err(anyhow!(
        "relay/ directory not found at {}",
        candidate.display()
    ))
}

/// Path to the conformance cases corpus (attn-nnj.5.14). Absent until 5.14
/// merges; the test calls `cases_path().exists()` and short-circuits with a
/// log line so this can land before the TS-side corpus does.
pub fn cases_path() -> Result<PathBuf> {
    Ok(relay_dir()?
        .join("test")
        .join("conformance")
        .join("cases.json"))
}

/// Locate a usable wrangler binary. Prefers the relay-local
/// `node_modules/.bin/wrangler` (the pinned version from
/// `relay/package.json`) because the system-wide install — if any — can drift
/// by major versions and surface as cryptic "DO migration mismatch" errors.
/// Falls back to `PATH` lookup so a dev who never ran `npm install` in
/// `relay/` can still smoke-test against a global wrangler.
pub fn locate_wrangler() -> Option<PathBuf> {
    if let Ok(dir) = relay_dir() {
        let local = dir.join("node_modules").join(".bin").join("wrangler");
        if local.is_file() {
            return Some(local);
        }
    }
    which_in_path("wrangler")
}

/// `which`-lite for the few places where we need to probe `PATH` directly.
/// Returning `Option` rather than `Result` keeps the call sites short — the
/// only failure case here is "not found", which the caller treats as "skip".
fn which_in_path(bin: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
        // npm scripts sometimes ship as `.cmd` shims on Windows; the relay
        // is unlikely to ship that way in CI but staying portable is cheap.
        let cmd = dir.join(format!("{bin}.cmd"));
        if cmd.is_file() {
            return Some(cmd);
        }
    }
    None
}

/// Cheap "is wrangler reachable at all" check the test entrypoint uses to
/// decide whether to spawn or skip.
pub fn is_wrangler_available() -> bool {
    locate_wrangler().is_some()
}

/// Reserve an OS-allocated free TCP port. We bind, read the assigned port,
/// then drop the listener — there's a TOCTOU window where another process
/// could grab the port before wrangler boots, but it's narrow enough that
/// "retry once on bind failure" is the right contingency rather than
/// inflating the helper with a port-allocation cache.
pub fn pick_free_port() -> Result<u16> {
    let listener =
        TcpListener::bind("127.0.0.1:0").context("bind 127.0.0.1:0 to pick free port")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Owning handle to a child `wrangler dev --local` process. Killed on `Drop`
/// so a `?` early-return from a scenario never leaves a stray Miniflare
/// holding a port hostage for the next test run.
pub struct WranglerHandle {
    child: Option<Child>,
    pub host: String,
    pub port: u16,
    pub base_url: String,
    /// `true` if we own the process (spawned by `start`); `false` if we
    /// attached to a pre-started relay via `ATTN_RELAY_PORT`. Borrowed
    /// processes are NOT killed on Drop.
    owns_process: bool,
}

impl WranglerHandle {
    /// Spawn `wrangler dev --local --port <free>` from `relay/` and wait for
    /// /health to come up.
    ///
    /// Honors `ATTN_RELAY_PORT` for CI: if set, the helper assumes the relay
    /// is already running on `127.0.0.1:$ATTN_RELAY_PORT` (or the host in
    /// `ATTN_RELAY_HOST`) and only does the /health wait — no spawn.
    pub async fn start() -> Result<Self> {
        let host = env::var(HOST_ENV_VAR).unwrap_or_else(|_| "127.0.0.1".to_string());

        // Pre-started instance: just verify /health, don't spawn.
        if let Ok(port_str) = env::var(PRE_STARTED_PORT_ENV_VAR) {
            let port: u16 = port_str
                .parse()
                .with_context(|| format!("parse {PRE_STARTED_PORT_ENV_VAR}={port_str} as u16"))?;
            wait_for_health(&host, port).await?;
            let base_url = format!("http://{host}:{port}");
            return Ok(Self {
                child: None,
                host,
                port,
                base_url,
                owns_process: false,
            });
        }

        let wrangler = locate_wrangler().ok_or_else(|| {
            anyhow!("wrangler binary not found (looked under relay/node_modules/.bin/ and $PATH)")
        })?;
        let relay = relay_dir()?;
        let port = pick_free_port()?;

        // `--local` forces Miniflare instead of the cloud worker preview —
        // we MUST NOT accidentally hit prod from CI.
        // `--ip 127.0.0.1` pins the bind interface so the helper's
        // `127.0.0.1:port` connect matches.
        // We deliberately omit `--persist-to` so each test run is hermetic.
        let mut cmd = Command::new(&wrangler);
        cmd.arg("dev")
            .arg("--local")
            .arg("--ip")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            // Local conformance clients have no edge-derived source
            // attribution. Production keeps this fail-closed; the isolated
            // Miniflare process must explicitly allow test room creation.
            .arg("--var")
            .arg("QUOTA_ALLOW_UNATTRIBUTED_CREATES:true")
            .current_dir(&relay)
            // wrangler scrapes the terminal width from stderr to decide
            // whether to spew its dashboard — piping both to null keeps the
            // test output readable and avoids the "broken pipe" SIGPIPE that
            // can otherwise kill wrangler when the buffer fills.
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());

        let child = cmd
            .spawn()
            .with_context(|| format!("spawn {}", wrangler.display()))?;

        let base_url = format!("http://{host}:{port}");
        let handle = Self {
            child: Some(child),
            host: host.clone(),
            port,
            base_url,
            owns_process: true,
        };

        // If health-check fails, Drop kills the child — propagate the error
        // up so the test prints a useful diagnostic instead of hanging.
        if let Err(e) = wait_for_health(&host, port).await {
            return Err(anyhow!("wrangler started but /health never came up: {e}"));
        }
        Ok(handle)
    }
}

impl Drop for WranglerHandle {
    fn drop(&mut self) {
        if !self.owns_process {
            return;
        }
        if let Some(mut child) = self.child.take() {
            // Best-effort kill — if the child is already dead we don't care.
            // `wait()` reaps the zombie so successive runs of the test don't
            // accumulate <defunct> processes on Linux.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Poll `GET http://<host>:<port>/health` until it returns 200 or
/// `HEALTH_TIMEOUT` elapses. The relay's `/health` is unauthenticated and
/// returns `{status:"ok", build, ts}` (see relay/src/index.ts).
pub async fn wait_for_health(host: &str, port: u16) -> Result<()> {
    let url = format!("http://{host}:{port}/health");
    let client = Client::builder()
        // Short per-request timeout — we're polling, not transferring data.
        .timeout(Duration::from_secs(2))
        .build()
        .context("build reqwest client for /health probe")?;
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    let mut last_err: Option<String> = None;
    while Instant::now() < deadline {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                // Optional: sanity-check body has `status:"ok"` so we don't
                // mistake a random 200 from a proxy for the real relay.
                // Production reqwest is built without the `json` feature
                // (see Cargo.toml — every prod call site uses
                // serde_json::to_vec/from_slice directly). Mirror that here so
                // tests don't accidentally re-enable a feature we dropped to
                // keep the release binary lean (attn-nnj.11.9).
                if let Ok(bytes) = resp.bytes().await
                    && let Ok(body) = serde_json::from_slice::<Value>(&bytes)
                    && body.get("status").and_then(Value::as_str) == Some("ok")
                {
                    return Ok(());
                }
                // Any 200 from /health, even with a wonky body, indicates a
                // server is up — but we treat the body check as authoritative
                // for the "wrong server" guard above. Fall through to retry.
            }
            Ok(resp) => {
                last_err = Some(format!("status {}", resp.status()));
            }
            Err(e) => {
                last_err = Some(e.to_string());
            }
        }
        tokio::time::sleep(HEALTH_POLL).await;
    }
    Err(anyhow!(
        "/health at {url} did not return 200 within {:?} (last error: {})",
        HEALTH_TIMEOUT,
        last_err.unwrap_or_else(|| "no response".to_string())
    ))
}

/// Lightweight HTTP client bound to a running relay. Used by the conformance
/// scenario runner to issue raw requests against the relay surface.
///
/// Deliberately thin: each scenario in `cases.json` already carries the full
/// `method + path + headers + body` and the expected response; this wrapper's
/// only job is to fire that request and surface the actual response shape so
/// the runner can diff. The production crypto stack (admission HMAC, PoW)
/// is exercised by the unit tests in `src/review/transport/mailbox/mod.rs`;
/// here we trust the corpus to have pre-computed any signature material.
pub struct MailboxClient {
    base_url: String,
    http: Client,
}

impl MailboxClient {
    pub fn new(base_url: impl Into<String>) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .context("build MailboxClient reqwest::Client")?;
        Ok(Self {
            base_url: base_url.into(),
            http,
        })
    }

    /// `GET /health` — useful as a smoke test in the scenario runner before
    /// firing the actual case so we don't blame the relay for a flake we
    /// could have caught earlier.
    pub async fn health(&self) -> Result<Value> {
        let url = format!("{}/health", self.base_url.trim_end_matches('/'));
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            return Err(anyhow!("GET {url} returned {}", resp.status()));
        }
        // serde_json::from_slice instead of reqwest's `.json()` — see comment
        // in `wait_for_relay_health` (json feature dropped per attn-nnj.11.9).
        let bytes = resp
            .bytes()
            .await
            .with_context(|| format!("read body from {url}"))?;
        serde_json::from_slice::<Value>(&bytes).with_context(|| format!("parse JSON from {url}"))
    }

    /// Drive a generic scenario step. Returns `(status, body_json_or_null)`.
    /// Headers and body are passed straight through — the corpus owns
    /// canonicalization (and admission HMAC) so the helper doesn't second-
    /// guess byte-level concerns.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(String, String)],
        body: Option<&[u8]>,
    ) -> Result<(u16, Value)> {
        let url = format!(
            "{}{}",
            self.base_url.trim_end_matches('/'),
            if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        );
        let mut req = match method.to_ascii_uppercase().as_str() {
            "GET" => self.http.get(&url),
            "POST" => self.http.post(&url),
            "PUT" => self.http.put(&url),
            "DELETE" => self.http.delete(&url),
            "PATCH" => self.http.patch(&url),
            other => return Err(anyhow!("unsupported HTTP method: {other}")),
        };
        for (k, v) in headers {
            req = req.header(k, v);
        }
        if let Some(b) = body {
            req = req.body(b.to_vec());
        }
        let resp = req
            .send()
            .await
            .with_context(|| format!("{method} {url}"))?;
        let status = resp.status().as_u16();
        let bytes = resp
            .bytes()
            .await
            .with_context(|| format!("read body for {method} {url}"))?;
        // Best-effort JSON decode — the corpus's `expectedResponse.body` is
        // shape-matched as JSON, but the relay returns plain text on a few
        // hard error paths. Surfacing `null` for non-JSON keeps the runner's
        // shape-diff stable.
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)
        };
        Ok((status, body))
    }
}

// ---------------------------------------------------------------------------
// Tests for the helpers themselves. Keeping them inside the helper module
// (rather than in relay_conformance.rs) means they run in the same `cargo
// test --test relay_conformance` invocation without needing to spin up
// wrangler — they exercise the pure-Rust glue only.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_requested_honors_truthy_values() {
        // Save+restore so we don't pollute the rest of the test process.
        // (Each test binary gets its own env, but the runner runs every
        // #[test] in the same binary so we still need to clean up.)
        let prior = env::var(SKIP_ENV_VAR).ok();
        for val in ["1", "true", "TRUE", "yes", "YES"] {
            unsafe {
                env::set_var(SKIP_ENV_VAR, val);
            }
            assert!(
                skip_requested(),
                "ATTN_SKIP_CONFORMANCE={val} should be honored"
            );
        }
        for val in ["0", "false", "no", "", "maybe"] {
            unsafe {
                env::set_var(SKIP_ENV_VAR, val);
            }
            assert!(
                !skip_requested(),
                "ATTN_SKIP_CONFORMANCE={val} should NOT be honored"
            );
        }
        match prior {
            Some(v) => unsafe { env::set_var(SKIP_ENV_VAR, v) },
            None => unsafe { env::remove_var(SKIP_ENV_VAR) },
        }
    }

    #[test]
    fn relay_dir_resolves_from_workspace_root() {
        let dir = relay_dir().expect("relay dir exists in this workspace");
        assert!(dir.ends_with("relay"), "got {}", dir.display());
        assert!(dir.is_dir(), "relay/ must be a directory");
    }

    #[test]
    fn cases_path_points_inside_relay_test_conformance() {
        let p = cases_path().expect("relay dir");
        // We don't assert that the file exists — it lands with 5.14. We just
        // make sure the path we'd open is the right one.
        assert!(
            p.ends_with("relay/test/conformance/cases.json"),
            "got {}",
            p.display()
        );
    }

    #[test]
    fn locate_wrangler_prefers_local_node_modules_if_installed() {
        // In this workspace the relay's wrangler is `npm install`-ed, so the
        // helper must find it. If a future contributor clears node_modules,
        // this test will skip rather than fail — but the test framework
        // can't conditionally skip individual #[test]s, so we just verify
        // the lookup path doesn't panic and either returns the local path
        // or None.
        match locate_wrangler() {
            Some(p) => {
                let s = p.display().to_string();
                assert!(
                    s.ends_with("wrangler") || s.ends_with("wrangler.cmd"),
                    "got: {s}"
                );
            }
            None => {
                // Acceptable on hosts without wrangler installed — the test
                // entrypoint guards on this same predicate.
            }
        }
    }

    #[test]
    fn pick_free_port_returns_a_bindable_port() {
        let port = pick_free_port().expect("pick free port");
        // Sanity: bind it ourselves to make sure the kernel will hand it
        // back. If something raced us we'll get an error and that's the
        // intended signal (the production code path is "fail loudly").
        let listener = std::net::TcpListener::bind(("127.0.0.1", port))
            .expect("re-bind same port should succeed in tight loop");
        drop(listener);
    }

    #[tokio::test]
    async fn mailbox_client_request_handles_missing_relay_gracefully() {
        // Pick an unbound port and confirm the helper bubbles up a connect
        // error rather than panicking. Real conformance runs always go
        // against a live relay, so this is just the "what if" path.
        let port = pick_free_port().expect("pick port");
        let client = MailboxClient::new(format!("http://127.0.0.1:{port}")).expect("client");
        let err = client.request("GET", "/health", &[], None).await;
        assert!(err.is_err(), "expected connect-refused error");
    }
}
