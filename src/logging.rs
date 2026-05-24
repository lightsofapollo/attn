//! Daemon logging setup.
//!
//! Installs a `tracing` subscriber that writes leveled, timestamped lines to
//! stderr — which the daemon redirects into `<ATTN_HOME>/attn.log` (see
//! `daemon::open_daemon_log`). Levels/targets come from `ATTN_LOG` (falling
//! back to `RUST_LOG`), defaulting to `warn` for dependencies and `info` for
//! attn's own modules, e.g.:
//!
//! ```text
//! ATTN_LOG=debug            # everything at debug
//! ATTN_LOG=attn=debug       # attn at debug, deps at their default
//! ATTN_LOG=attn::review=trace
//! ```

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::time::UtcTime;

/// Install the global tracing subscriber for the daemon. Idempotent: a second
/// call (e.g. from a test or a re-entry) is a no-op rather than a panic.
pub fn init() {
    let filter = EnvFilter::try_from_env("ATTN_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new("warn,attn=info"));

    let timer = UtcTime::new(time::format_description::well_known::Rfc3339);

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_timer(timer)
        // The daemon sends stdout to /dev/null and redirects stderr into
        // attn.log, so we MUST write to stderr or every log line is discarded.
        .with_writer(std::io::stderr)
        // attn.log is a file, not a TTY — color escape codes would be noise.
        .with_ansi(false)
        // The messages already carry `attn:` / `review:` / `ws:` subsystem
        // prefixes, so printing the module target too just doubles it up. We
        // hide the target from the OUTPUT (filtering by target via ATTN_LOG,
        // e.g. `attn::review=debug`, still works — that reads the event target,
        // not the formatter).
        .with_target(false)
        .try_init();
}
