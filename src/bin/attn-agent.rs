//! Slim, GUI-free headless review agent (attn-8zd).
//!
//! A thin wrapper over `attn::review::agent::run` that links **only** the
//! `attn` library's review stack — no `wry`/`tao`/`webkit2gtk`. That makes it
//! runnable in a lightweight Linux container (glibc + ca-certificates), which
//! the full `attn` daemon can't be (it needs a display), so the Docker
//! topology harness (attn-orf) can run N peers and assert convergence.
//!
//! The full `attn` binary reaches the same logic via `attn review agent`.
//!
//! Args (all optional):
//!   --share <PATH>            share this path on startup (owner role)
//!   --mode  <live|async|hybrid>
//!   --relay-url <URL>         else $ATTN_RELAY_URL, else dev default
//!
//! Identity + store come from $ATTN_HOME. Driven over stdin (JSON lines),
//! emits `@update <json>` / `@agent <msg>` lines on stdout. See
//! `attn::review::agent` for the protocol.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut share: Option<String> = None;
    let mut mode = "live".to_string();
    let mut relay: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--share" => {
                i += 1;
                share = args.get(i).cloned();
            }
            "--mode" => {
                i += 1;
                if let Some(m) = args.get(i) {
                    mode = m.clone();
                }
            }
            "--relay-url" => {
                i += 1;
                relay = args.get(i).cloned();
            }
            "-h" | "--help" => {
                eprintln!(
                    "attn-agent [--share PATH] [--mode live|async|hybrid] [--relay-url URL]\n\
                     stdin: one JSON command per line; stdout: @update/@agent lines.\n\
                     env: ATTN_HOME (identity+store), ATTN_RELAY_URL (relay)."
                );
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("attn-agent: unknown arg {other:?} (try --help)");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }

    match attn::review::agent::run(share.as_deref(), &mode, relay.as_deref()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("attn-agent: {e:#}");
            ExitCode::FAILURE
        }
    }
}
