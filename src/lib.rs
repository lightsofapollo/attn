//! Library crate exposing the modules integration tests reach into.
//!
//! `attn` ships as a single binary (`src/main.rs`), but a handful of
//! integration tests (e.g. `tests/webrtc_e2e.rs` for attn-nnj.7.7) need
//! to instantiate types from the `review` module tree directly — that
//! requires a `lib` target so the test binaries can `use attn::review::...`.
//!
//! This file keeps the surface minimal: only re-exports what tests need.
//! The daemon entry point lives in `src/main.rs` and uses these same
//! modules via the `crate::` path, so there's no duplication.
//!
//! NOTE: keep this file additive — don't move modules out of `src/main.rs`
//! into here unless you have a specific reason. The bin target already
//! compiles the modules directly; the lib target is purely for cross-target
//! reuse by integration tests.

#![allow(dead_code)]

pub mod review;

/// Subset of the `daemon` module needed by `review` when compiled as a
/// library target. The bin target builds `src/daemon.rs` directly; for the
/// lib target we re-export only the helpers `review::store` /
/// `review::bootstrap` reach for so we don't drag the full daemon
/// (tao/wry, unix-socket plumbing, etc) into the test binaries.
pub mod daemon {
    use std::path::PathBuf;

    use anyhow::{Context, Result};

    /// Resolve the per-process runtime directory.
    ///
    /// Mirrors `src/daemon.rs::runtime_dir` (kept in lock-step via the lib
    /// target test build). Honors `ATTN_HOME` first; falls back to a
    /// per-executable namespace under `/tmp` in debug builds and `~/.attn`
    /// in release builds.
    pub fn runtime_dir() -> Result<PathBuf> {
        if let Ok(value) = std::env::var("ATTN_HOME") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(PathBuf::from(trimmed));
            }
        }

        #[cfg(debug_assertions)]
        {
            let exe = std::env::current_exe().context("could not determine executable path")?;
            let namespace = short_exe_namespace(&exe);
            Ok(PathBuf::from("/tmp").join(format!("attn-{namespace}")))
        }
        #[cfg(not(debug_assertions))]
        {
            let home = dirs::home_dir().context("could not determine home directory")?;
            Ok(home.join(".attn"))
        }
    }

    #[cfg(debug_assertions)]
    fn short_exe_namespace(path: &std::path::Path) -> String {
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in path.as_os_str().as_encoded_bytes() {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("{hash:016x}")
    }
}
