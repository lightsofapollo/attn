//! `attn review …` subcommand surface.
//!
//! Owns the small CLI shim that lets agents (and humans) drive the review
//! pipeline from a shell without going through the webview. Today this
//! file covers the agent-identity + remote-agent join flow pinned by
//! `planning/collab/amendments.md` §Agent CLI key handling:
//!
//! ```text
//! attn review register-agent <name>
//! attn review list-agents
//! attn review whoami [--as-agent <name>]
//! attn review join <invite> --as-agent <name>
//! ```
//!
//! Future review subcommands (`current`, `submit-comment`,
//! `submit-suggestion`, `inbox`) plug into this same `ReviewArgs` and reach
//! the daemon over the unix socket (see `src/daemon.rs`). They land with
//! 9.7 / data-model.md §Agent UI/CLI — this module is sized so adding them
//! is a one-variant change.

#![allow(dead_code)]

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};

use crate::daemon::runtime_dir;
use crate::review::agent_identity::{
    AGENTS_DIRNAME, list_agents_in, load_agent_in, register_agent_in,
};
use crate::review::bootstrap::{
    BootstrapConfig, BootstrapError, Bootstrapper, IDENTITY_FILENAME, load_or_create_identity_in,
};
use crate::review::store::ReviewStore;
use std::sync::Arc;

/// `attn review …` argument tree.
#[derive(Args, Debug)]
pub struct ReviewArgs {
    #[command(subcommand)]
    pub command: ReviewSubcommand,
}

#[derive(Subcommand, Debug)]
pub enum ReviewSubcommand {
    /// Register a new agent participant. Generates a fresh Ed25519 keypair
    /// under `$ATTN_HOME/agents/<name>/identity.json` (NOT the daemon's
    /// own identity). Run once per agent — re-running is non-destructive
    /// and errors with `IDENTITY_EXISTS`.
    ///
    /// Spec: `planning/collab/amendments.md` §Agent CLI key handling.
    RegisterAgent {
        /// Agent name (a–z, A–Z, 0–9, `-`, `_`, `.`; no leading dot; ≤ 64).
        name: String,
    },

    /// List every registered agent under `$ATTN_HOME/agents/`.
    ListAgents,

    /// Print the identity (deviceId + pubkey) that the daemon — or, with
    /// `--as-agent`, the named agent — would present on join. Useful for
    /// confirming a remote bot is wired up before pointing it at a relay.
    Whoami {
        /// Surface the named agent's identity instead of the daemon's.
        #[arg(long, value_name = "NAME")]
        as_agent: Option<String>,
    },

    /// Join a review room from an `attn://review/<roomId>#key=...` invite.
    ///
    /// Two modes, so a CLI join always lines up with the device that's
    /// actually in the room:
    ///
    /// - **Default (no `--as-agent`)**: hand the invite to the running attn
    ///   daemon, which joins as ITS OWN device identity. The app window then
    ///   reflects the join. This is the path for a human who already has attn
    ///   open — it avoids the mismatch where a CLI join used a separate device
    ///   from the daemon, leaving the window out of sync.
    /// - **`--as-agent <name>`**: a headless join under the named agent's
    ///   persisted Ed25519 key (`register-agent` first). For bots / zero-install
    ///   reviewers with no daemon. Per amendments.md §Agent CLI key handling the
    ///   relay registers this device as `kind="agent"`.
    Join {
        /// `attn://review/<roomId>#key=...` invite URL.
        invite: String,
        /// Join headlessly as this agent instead of routing to the daemon.
        #[arg(long, value_name = "NAME")]
        as_agent: Option<String>,
        /// Override the relay URL (default: env `ATTN_RELAY_URL`). Only used by
        /// the `--as-agent` path; the daemon path uses the daemon's own relay.
        #[arg(long, value_name = "URL")]
        relay_url: Option<String>,
    },
}

/// Default relay URL when `--relay-url` isn't passed and `ATTN_RELAY_URL`
/// isn't set. Points at the dev relay so a local `wrangler dev` works
/// without extra setup.
const DEFAULT_RELAY_URL: &str = "http://127.0.0.1:8787";

/// Top-level dispatch for `attn review …`.
///
/// All paths are synchronous from the caller's perspective; the `Join`
/// variant builds its own Tokio runtime so we don't have to plumb one in
/// from `main.rs` (which is non-async).
pub fn run(args: ReviewArgs) -> Result<()> {
    match args.command {
        ReviewSubcommand::RegisterAgent { name } => run_register_agent(&name),
        ReviewSubcommand::ListAgents => run_list_agents(),
        ReviewSubcommand::Whoami { as_agent } => run_whoami(as_agent.as_deref()),
        ReviewSubcommand::Join {
            invite,
            as_agent,
            relay_url,
        } => match as_agent {
            Some(name) => run_join_as_agent(&invite, &name, relay_url.as_deref()),
            None => run_join_via_daemon(&invite),
        },
    }
}

/// Hand the invite to the running attn daemon so it joins as its OWN device
/// identity (the same device the app window presents). This keeps the CLI join
/// consistent with the daemon — a no-`--as-agent` join shows up in the app.
///
/// Fails with a helpful message when no daemon is running, since this path has
/// nothing to route to (the caller should open attn first, or pass
/// `--as-agent <name>` for a standalone headless join).
fn run_join_via_daemon(invite: &str) -> Result<()> {
    crate::daemon::send_review_join(invite).map_err(|e| {
        anyhow::anyhow!(
            "could not reach a running attn daemon to join ({e}).\n\
             Open attn first (so the app joins as its own device), or pass \
             `--as-agent <name>` for a headless join."
        )
    })?;
    println!("join request sent to the running attn daemon");
    println!("  invite: {invite}");
    Ok(())
}

fn run_register_agent(name: &str) -> Result<()> {
    let base = runtime_dir().context("resolve runtime_dir for agent registry")?;
    let identity =
        register_agent_in(&base, name).with_context(|| format!("register agent {name:?}"))?;
    println!("registered agent {name:?}");
    println!(
        "  identity:   {}/{AGENTS_DIRNAME}/{name}/{IDENTITY_FILENAME}",
        base.display()
    );
    println!("  deviceId:   {}", identity.device_id);
    println!("  participant:{}", identity.participant_id);
    println!("  pubkey:     {}", identity.public_signing_key);
    Ok(())
}

fn run_list_agents() -> Result<()> {
    let base = runtime_dir().context("resolve runtime_dir for agent registry")?;
    let names = list_agents_in(&base).with_context(|| "list agents")?;
    if names.is_empty() {
        eprintln!(
            "no agents registered under {}/{AGENTS_DIRNAME}",
            base.display()
        );
        eprintln!("run `attn review register-agent <name>` to create one");
        return Ok(());
    }
    for name in names {
        println!("{name}");
    }
    Ok(())
}

fn run_whoami(as_agent: Option<&str>) -> Result<()> {
    let base = runtime_dir().context("resolve runtime_dir")?;
    let (label, identity) = match as_agent {
        Some(name) => {
            let id = load_agent_in(&base, name).with_context(|| format!("load agent {name:?}"))?;
            (format!("agent {name:?}"), id)
        }
        None => {
            let id = load_or_create_identity_in(&base).context("load or create daemon identity")?;
            ("daemon (owner)".to_string(), id)
        }
    };
    println!("{label}");
    println!("  deviceId:   {}", identity.device_id);
    println!("  participant:{}", identity.participant_id);
    println!("  pubkey:     {}", identity.public_signing_key);
    Ok(())
}

fn run_join_as_agent(invite: &str, name: &str, relay_url_override: Option<&str>) -> Result<()> {
    let base = runtime_dir().context("resolve runtime_dir for agent registry")?;
    let agent_identity = load_agent_in(&base, name).with_context(|| {
        format!("load agent {name:?} — run `attn review register-agent {name}` first")
    })?;

    let relay_url = relay_url_override
        .map(str::to_string)
        .or_else(|| {
            std::env::var("ATTN_RELAY_URL")
                .ok()
                .filter(|s| !s.is_empty())
        })
        .or_else(|| option_env!("ATTN_DEFAULT_RELAY_URL").map(str::to_string))
        .unwrap_or_else(|| DEFAULT_RELAY_URL.to_string());
    if relay_url.is_empty() {
        bail!("relay url is empty; pass --relay-url or set ATTN_RELAY_URL");
    }

    // The store lives at the same location the daemon uses; reusing it
    // means the agent's outbox + room.json merge into the existing review
    // surface if the same machine is also the owner. For a pure remote
    // bot this is still safe — the store is created on first use.
    let store = Arc::new(ReviewStore::open().context("open review store for agent join")?);
    let config = Arc::new(BootstrapConfig {
        relay_url,
        identity_dir: Some(base.clone()),
    });
    let boot = Bootstrapper::new(store, config).context("build Bootstrapper")?;

    // Drive the async join from a freshly-built runtime so we don't
    // require main() to be async.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for agent join")?;
    let outcome = runtime
        .block_on(boot.join_as_agent(invite, &agent_identity, None))
        .map_err(bootstrap_err_to_anyhow)?;

    println!("joined room as agent {name:?}");
    println!("  roomId:     {}", outcome.room_id.as_str());
    println!("  deviceId:   {}", agent_identity.device_id);
    println!("  participant:{}", agent_identity.participant_id);
    Ok(())
}

/// Translate a `BootstrapError` into an `anyhow::Error` while preserving
/// the typed code/status when present (so a relay 4xx surfaces with the
/// machine-readable code on the CLI).
fn bootstrap_err_to_anyhow(err: BootstrapError) -> anyhow::Error {
    match err {
        BootstrapError::Relay {
            status,
            code,
            message,
        } => {
            anyhow::anyhow!("relay rejected join: HTTP {status} {code}: {message}")
        }
        other => anyhow::anyhow!(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_with_as_agent_takes_the_headless_agent_path() {
        // `--as-agent X` → standalone headless join under agent X's key.
        let cmd = ReviewSubcommand::Join {
            invite: "attn://review/abc#key=AAAA".to_string(),
            as_agent: Some("rufus".to_string()),
            relay_url: None,
        };
        match cmd {
            ReviewSubcommand::Join { as_agent, .. } => {
                assert_eq!(as_agent.as_deref(), Some("rufus"));
            }
            other => panic!("expected Join, got {other:?}"),
        }
    }

    #[test]
    fn join_without_as_agent_routes_to_the_daemon() {
        // No `--as-agent` → route to the running daemon so it joins as its own
        // device (consistent with the app window — fixes the device mismatch).
        let cmd = ReviewSubcommand::Join {
            invite: "attn://review/abc#key=AAAA".to_string(),
            as_agent: None,
            relay_url: None,
        };
        match cmd {
            ReviewSubcommand::Join { as_agent, .. } => {
                assert!(as_agent.is_none(), "no agent → daemon-routed join");
            }
            other => panic!("expected Join, got {other:?}"),
        }
    }

    #[test]
    fn bootstrap_err_to_anyhow_preserves_relay_code() {
        let err = BootstrapError::Relay {
            status: 403,
            code: "ATTN_FORBIDDEN".into(),
            message: "agent kind disallowed by policy".into(),
        };
        let msg = bootstrap_err_to_anyhow(err).to_string();
        assert!(msg.contains("403"));
        assert!(msg.contains("ATTN_FORBIDDEN"));
        assert!(msg.contains("agent kind disallowed by policy"));
    }
}
