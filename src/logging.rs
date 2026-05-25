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
        // attn at info, deps at warn — but mute webrtc-rs's very chatty ICE/mDNS
        // candidate-gathering WARNs ("pingAllCandidates" before any pairs exist,
        // link-local UDP bind failures, STUN reflexive-address timeouts). Those
        // are expected on networks without direct P2P connectivity (we fall back
        // to the relay) and otherwise drown out attn's own logs.
        .unwrap_or_else(|_| {
            EnvFilter::new(
                "warn,attn=info,webrtc=error,webrtc_ice=error,webrtc_mdns=error,\
                 webrtc_sctp=error,webrtc_dtls=error,webrtc_srtp=error",
            )
        });

    let timer = UtcTime::new(time::format_description::well_known::Rfc3339);

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_timer(timer)
        // The daemon sends stdout to /dev/null and redirects stderr into
        // attn.log, so we MUST write to stderr or every log line is discarded.
        .with_writer(std::io::stderr)
        // attn.log is a file, not a TTY — color escape codes would be noise.
        .with_ansi(false)
        // Show the module target (e.g. `attn::review::manager`,
        // `attn::review::transport::mailbox::ws`) so each line names exactly
        // which subsystem emitted it. This is more precise than the legacy
        // `review:`/`ws:` message prefixes (which remain, slightly redundant).
        .with_target(true)
        .try_init();
}
