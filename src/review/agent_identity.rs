//! Agent identity registry — per-agent Ed25519 keypairs persisted under
//! `~/.attn/agents/<name>/identity.json` (or `$ATTN_HOME/agents/<name>/...`).
//!
//! Spec: `planning/collab/amendments.md` §Agent CLI key handling
//! (the “register-agent” + “--as-agent” + remote-agent pinned bullets).
//!
//! Why a separate registry instead of reusing `~/.attn/identity.json`:
//!
//! - The daemon identity is the **owner** of the local rooms. Any comment
//!   the daemon writes is attributed to the owner participant. Agents
//!   (local or remote) need *their own* identity so their comments are
//!   attributed to a `kind: "agent"` participant — that's the whole point
//!   of the remote-agent-participant type pinned in 9.6.
//! - Multiple agents can coexist on the same machine (e.g.
//!   `agent-rufus` + `agent-alex`). One file per name keeps the registry
//!   trivially extensible without a schema/index file.
//!
//! Disk layout:
//!
//! ```text
//! $ATTN_HOME/
//!   identity.json                 ← daemon (owner) identity
//!   agents/
//!     rufus/identity.json         ← agent “rufus”
//!     alex/identity.json          ← agent “alex”
//!     ci-bot/identity.json        ← remote-CI bot
//! ```
//!
//! Each `identity.json` here uses the SAME on-disk shape as
//! [`crate::review::bootstrap::DeviceIdentity`] so the bootstrap pipeline
//! can swap in an agent identity instead of the daemon's without a custom
//! code path. (See [`crate::review::bootstrap::join_as_agent`].)

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use crate::daemon::runtime_dir;
use crate::review::bootstrap::{
    BootstrapError, DeviceIdentity, IDENTITY_FILENAME, load_identity_from, save_identity_to,
};

/// Directory name under `runtime_dir()` that holds per-agent identities.
pub const AGENTS_DIRNAME: &str = "agents";

/// Reject names that would let an agent escape its directory or collide
/// with the daemon identity. Returns the normalized name on success.
///
/// Allowed characters: ascii alphanumeric, `-`, `_`, `.` (but never a
/// leading dot — no `.hidden` agents).
pub fn validate_agent_name(raw: &str) -> Result<&str, BootstrapError> {
    if raw.is_empty() {
        return Err(BootstrapError::Identity(
            "agent name must not be empty".into(),
        ));
    }
    if raw.starts_with('.') {
        return Err(BootstrapError::Identity(
            "agent name must not start with '.'".into(),
        ));
    }
    if raw.len() > 64 {
        return Err(BootstrapError::Identity(
            "agent name must be ≤ 64 chars".into(),
        ));
    }
    for ch in raw.chars() {
        match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => {}
            _ => {
                return Err(BootstrapError::Identity(format!(
                    "agent name contains invalid character: {ch:?} (allowed: a-z A-Z 0-9 - _ .)"
                )));
            }
        }
    }
    Ok(raw)
}

/// Resolve `$ATTN_HOME/agents` honoring `runtime_dir()`. Used by production
/// code; tests reach for [`agents_dir_in`] with an explicit base instead.
pub fn agents_dir() -> Result<PathBuf, BootstrapError> {
    Ok(runtime_dir()
        .map_err(|e| BootstrapError::Identity(format!("runtime_dir: {e}")))?
        .join(AGENTS_DIRNAME))
}

/// Resolve the agents directory under an explicit base — used by tests and
/// by callers that already know their `ATTN_HOME`-equivalent.
pub fn agents_dir_in(base: &Path) -> PathBuf {
    base.join(AGENTS_DIRNAME)
}

/// Resolve the on-disk directory for a single agent (e.g.
/// `$ATTN_HOME/agents/rufus/`).
pub fn agent_dir_in(base: &Path, name: &str) -> Result<PathBuf, BootstrapError> {
    let name = validate_agent_name(name)?;
    Ok(agents_dir_in(base).join(name))
}

/// Path to the per-agent `identity.json` under `base`.
pub fn agent_identity_path_in(base: &Path, name: &str) -> Result<PathBuf, BootstrapError> {
    Ok(agent_dir_in(base, name)?.join(IDENTITY_FILENAME))
}

/// Register a new agent under `base`. Generates a fresh Ed25519 keypair and
/// writes `identity.json` atomically. Errors with `IDENTITY_EXISTS` if the
/// agent already has an identity on disk — registration is intentionally
/// non-destructive so a stray `register-agent` call cannot rotate a
/// remote-agent's key out from under the relay's device directory.
pub fn register_agent_in(base: &Path, name: &str) -> Result<DeviceIdentity, BootstrapError> {
    let dir = agent_dir_in(base, name)?;
    let path = dir.join(IDENTITY_FILENAME);
    if path.exists() {
        return Err(BootstrapError::Identity(format!(
            "agent identity already exists at {}; remove it first to re-register",
            path.display()
        )));
    }
    let identity = DeviceIdentity::generate()?;
    save_identity_to(&dir, &identity)?;
    Ok(identity)
}

/// Load an existing agent identity by name from `base`. Returns
/// `BootstrapError::Identity` if the agent isn't registered — callers
/// should surface that as “run `attn review register-agent <name>` first.”
pub fn load_agent_in(base: &Path, name: &str) -> Result<DeviceIdentity, BootstrapError> {
    let dir = agent_dir_in(base, name)?;
    match load_identity_from(&dir)? {
        Some(id) => Ok(id),
        None => Err(BootstrapError::Identity(format!(
            "agent {name:?} is not registered (no identity at {})",
            dir.join(IDENTITY_FILENAME).display()
        ))),
    }
}

/// List the names of every registered agent under `base`. Returns an empty
/// vec when the agents directory doesn't exist yet — a fresh install has
/// no agents and that's not an error.
pub fn list_agents_in(base: &Path) -> Result<Vec<String>, BootstrapError> {
    let dir = agents_dir_in(base);
    let entries = match std::fs::read_dir(&dir) {
        Ok(it) => it,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(BootstrapError::Identity(format!(
                "read {}: {err}",
                dir.display()
            )));
        }
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| BootstrapError::Identity(e.to_string()))?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        // Only surface entries that actually have an identity.json — a
        // half-written agent directory shouldn't pretend to exist.
        if entry.path().join(IDENTITY_FILENAME).is_file() {
            out.push(name_str.to_string());
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn validate_agent_name_accepts_simple_names() {
        for name in ["rufus", "ci-bot", "alex_42", "agent.v2", "A", "0"] {
            assert!(
                validate_agent_name(name).is_ok(),
                "{name} should be accepted"
            );
        }
    }

    #[test]
    fn validate_agent_name_rejects_path_traversal_and_friends() {
        for bad in ["", ".hidden", "../escape", "with space", "with/slash", "💀"] {
            assert!(
                validate_agent_name(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn register_then_load_round_trips() {
        let tmp = TempDir::new().expect("tempdir");
        let id = register_agent_in(tmp.path(), "rufus").expect("register");
        let loaded = load_agent_in(tmp.path(), "rufus").expect("load");
        assert_eq!(id, loaded, "registered identity should round-trip on load");

        // Path exists where we expect.
        let on_disk = agent_identity_path_in(tmp.path(), "rufus").expect("path");
        assert!(on_disk.is_file(), "identity.json must be on disk");
    }

    #[test]
    fn register_twice_is_non_destructive() {
        let tmp = TempDir::new().expect("tempdir");
        let _ = register_agent_in(tmp.path(), "rufus").expect("register once");
        let err = register_agent_in(tmp.path(), "rufus").expect_err("second register");
        match err {
            BootstrapError::Identity(msg) => {
                assert!(
                    msg.contains("already exists"),
                    "expected duplicate error, got: {msg}"
                );
            }
            other => panic!("expected Identity error, got {other:?}"),
        }
    }

    #[test]
    fn multiple_agents_have_independent_keys() {
        // The whole point of 9.6 is that agent-rufus and agent-alex can live
        // side-by-side as distinct participants.
        let tmp = TempDir::new().expect("tempdir");
        let rufus = register_agent_in(tmp.path(), "rufus").expect("rufus");
        let alex = register_agent_in(tmp.path(), "alex").expect("alex");
        assert_ne!(rufus.public_signing_key, alex.public_signing_key);
        assert_ne!(rufus.device_id, alex.device_id);
        assert_ne!(rufus.participant_id, alex.participant_id);
    }

    #[test]
    fn list_agents_returns_sorted_names() {
        let tmp = TempDir::new().expect("tempdir");
        assert!(list_agents_in(tmp.path()).expect("empty list").is_empty());

        let _ = register_agent_in(tmp.path(), "rufus").expect("rufus");
        let _ = register_agent_in(tmp.path(), "alex").expect("alex");
        let _ = register_agent_in(tmp.path(), "ci-bot").expect("ci-bot");

        let listed = list_agents_in(tmp.path()).expect("list");
        assert_eq!(listed, vec!["alex", "ci-bot", "rufus"]);
    }

    #[test]
    fn load_missing_agent_is_an_identity_error() {
        let tmp = TempDir::new().expect("tempdir");
        let err = load_agent_in(tmp.path(), "nobody").expect_err("missing");
        match err {
            BootstrapError::Identity(msg) => {
                assert!(
                    msg.contains("not registered"),
                    "expected helpful error, got: {msg}"
                );
            }
            other => panic!("expected Identity error, got {other:?}"),
        }
    }
}
